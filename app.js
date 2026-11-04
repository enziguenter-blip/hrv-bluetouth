(() => {
  'use strict';

  const BUFFER_MS = 300_000;
  const BUFFER_CAPACITY = 2048;

  // Fester Speicher; Zeitlimit und Kapazitätslimit gelten unabhängig voneinander.
  class RingBuffer {
    constructor(capacity = BUFFER_CAPACITY) {
      this.capacity = capacity;
      this.data = new Array(capacity);
      this.start = 0;
      this.size = 0;
    }
    push(value) {
      this.data[(this.start + this.size) % this.capacity] = value;
      if (this.size < this.capacity) this.size++;
      else this.start = (this.start + 1) % this.capacity;
    }
    prune(cutoff) {
      while (this.size && this.data[this.start].t <= cutoff) {
        this.data[this.start] = undefined;
        this.start = (this.start + 1) % this.capacity;
        this.size--;
      }
    }
    values(cutoff = -Infinity) {
      const result = [];
      for (let i = 0; i < this.size; i++) {
        const value = this.data[(this.start + i) % this.capacity];
        if (value.t > cutoff) result.push(value);
      }
      return result;
    }
  }
  const isArtifact = ms => ms < 300 || ms > 2000;

  // Separater 10-s-Puffer: RR-Summe und Summe gültiger Differenzenquadrate.
  // Artefakte und Segmentwechsel erzeugen keine künstlichen Nachbarpaare.
  class LiveRMSSD {
    constructor(capacity = BUFFER_CAPACITY) {
      this.times = new Float64Array(capacity);
      this.rr = new Float64Array(capacity);
      this.links = new Uint8Array(capacity);
      this.history = new Float64Array(3);
      this.ratioHistory = new Float64Array(3);
      this.reset();
    }
    reset() {
      this.start = this.count = this.rrSum = this.squares = this.pairs = 0;
      this.sequence = 0; this.lastSequence = -1; this.lastSegment = null;
      this.historyStart = this.historyCount = this.historySum = this.ratioSum = 0;
    }
    removeOldest() {
      const value = this.rr[this.start];
      if (this.count > 1) {
        const next = (this.start + 1) % this.rr.length;
        if (this.links[next]) {
          this.squares = Math.max(0, this.squares - (this.rr[next] - value) ** 2);
          this.pairs--;
          this.links[next] = 0;
        }
      }
      this.rrSum -= value;
      this.start = (this.start + 1) % this.rr.length;
      this.count--;
      if (!this.count) this.rrSum = this.squares = this.pairs = 0;
      if (!this.pairs) this.squares = 0;
    }
    remember() {
      if (this.count < 5 || !this.pairs) {
        this.historyStart = this.historyCount = this.historySum = this.ratioSum = 0;
        return;
      }
      const value = Math.sqrt(this.squares / this.pairs);
      const ratio = value / (this.rrSum / this.count);
      const index = (this.historyStart + this.historyCount) % 3;
      if (this.historyCount === 3) {
        this.historySum -= this.history[index];
        this.ratioSum -= this.ratioHistory[index];
        this.historyStart = (this.historyStart + 1) % 3;
      } else this.historyCount++;
      this.history[index] = value; this.ratioHistory[index] = ratio;
      this.historySum += value; this.ratioSum += ratio;
    }
    expire(now, remember = true) {
      const previousCount = this.count;
      // Genau 10 s alte Werte bleiben enthalten; nur ältere Werte entfernen.
      while (this.count && this.times[this.start] < now - 10_000) this.removeOldest();
      if (this.count < 5 || !this.pairs || (remember && this.count !== previousCount)) this.remember();
      return this.count !== previousCount;
    }
    add(t, ms, segment = 0) {
      const expired = this.expire(t, false);
      this.sequence++;
      if (!Number.isFinite(ms) || isArtifact(ms)) {
        if (expired) this.remember();
        return;
      }
      if (this.count === this.rr.length) this.removeOldest();
      const index = (this.start + this.count) % this.rr.length;
      const linked = this.count > 0 && this.lastSequence === this.sequence - 1 && this.lastSegment === segment;
      if (linked) {
        const previous = (index + this.rr.length - 1) % this.rr.length;
        this.squares += (ms - this.rr[previous]) ** 2;
        this.pairs++;
      }
      this.times[index] = t; this.rr[index] = ms; this.links[index] = Number(linked);
      this.count++; this.rrSum += ms;
      this.lastSequence = this.sequence; this.lastSegment = segment;
      this.remember();
    }
    value(smoothed = false) {
      if (this.count < 5 || !this.pairs) return null;
      const rmssd = smoothed && this.historyCount
        ? Math.max(0, this.historySum / this.historyCount) : Math.sqrt(this.squares / this.pairs);
      const ratio = smoothed && this.historyCount
        ? Math.max(0, this.ratioSum / this.historyCount) : rmssd / (this.rrSum / this.count);
      return { rmssd, ratio };
    }
  }

  // Bluetooth-SIG 0x2A37: jeder Lesezugriff wird auf Paketgrenzen geprüft.
  function parseMeasurement(view) {
    let offset = 0;
    const read = bytes => {
      if (offset + bytes > view.byteLength) throw new Error('Unvollständiges Herzfrequenz-Paket');
      const value = bytes === 1 ? view.getUint8(offset) : view.getUint16(offset, true);
      offset += bytes;
      return value;
    };
    const flags = read(1);
    const hr = read(flags & 1 ? 2 : 1);
    const contact = flags & 4 ? (flags & 2 ? 'detected' : 'missing') : 'unsupported';
    if (flags & 8) read(2); // Energy Expended überspringen, falls vorhanden.
    const rr = [];
    if (flags & 16) {
      if (offset === view.byteLength || (view.byteLength - offset) % 2) {
        throw new Error('Ungültige RR-Nutzdaten');
      }
      while (offset < view.byteLength) rr.push(Math.round(read(2) * 1000 / 1024));
    }
    if (offset !== view.byteLength) throw new Error('Unerwartete Bytes im Herzfrequenz-Paket');
    return { hr, contact, rr };
  }

  function statistics(heartRates, intervals, filter, trimHR = false) {
    const selected = intervals.filter(x => !filter || !isArtifact(x.ms));
    const mean = items => items.length ? items.reduce((a, b) => a + b, 0) / items.length : null;
    const meanRR = mean(selected.map(x => x.ms));
    let squares = 0;
    let pairs = 0;
    let nn50 = 0;
    for (let i = 1; i < selected.length; i++) {
      const a = selected[i - 1], b = selected[i];
      // Keine künstlichen Nachbarschaften durch Filter oder Reconnect erzeugen.
      if (b.seq === a.seq + 1 && b.segment === a.segment) {
        squares += (b.ms - a.ms) ** 2;
        pairs++;
        if (Math.abs(b.ms - a.ms) > 50) nn50++;
      }
    }
    const rates = heartRates.map(x => x.hr).sort((a, b) => a - b);
    const trim = trimHR ? Math.floor(rates.length * 0.05) : 0;
    return {
      meanHR: mean(trim ? rates.slice(trim, -trim) : rates), meanRR,
      pnn50: pairs ? nn50 / pairs * 100 : null,
      sdnn: selected.length > 1
        ? Math.sqrt(selected.reduce((s, x) => s + (x.ms - meanRR) ** 2, 0) / (selected.length - 1)) : null,
      rmssd: pairs ? Math.sqrt(squares / pairs) : null,
      count: selected.length, pairs
    };
  }

  // Radix-2-FFT, ohne Bibliothek. Eingabelänge muss eine Zweierpotenz sein.
  function fftPower(input) {
    const n = input.length, re = Float64Array.from(input), im = new Float64Array(n);
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) [re[i], re[j]] = [re[j], re[i]];
    }
    for (let length = 2; length <= n; length *= 2) {
      const angle = -2 * Math.PI / length;
      for (let start = 0; start < n; start += length) {
        for (let j = 0; j < length / 2; j++) {
          const c = Math.cos(angle * j), s = Math.sin(angle * j);
          const a = start + j, b = a + length / 2;
          const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    return Array.from({ length: n / 2 }, (_, i) => re[i] ** 2 + im[i] ** 2);
  }

  function estimateBreathing(intervals) {
    // Nur der letzte zusammenhängende plausible Abschnitt; keine Artefakt-Interpolation.
    let start = intervals.length;
    for (let i = intervals.length - 1; i >= 0; i--) {
      const x = intervals[i], next = intervals[i + 1];
      if (isArtifact(x.ms) || x.contact === 'missing' || (next &&
          (next.seq !== x.seq + 1 || next.segment !== x.segment))) break;
      start = i;
    }
    const run = intervals.slice(start);
    if (run.length < 2) return null;
    const times = [0];
    for (let i = 1; i < run.length; i++) times.push(times[i - 1] + run[i].ms / 1000);
    const duration = times[times.length - 1];
    // 4 Hz, mindestens 256 Samples (64 s), höchstens 1024 (256 s).
    let n = 1024;
    while (n > duration * 4) n /= 2;
    if (n < 256) return null;
    const samples = [], origin = duration - (n - 1) / 4;
    let index = 0;
    for (let i = 0; i < n; i++) {
      const t = origin + i / 4;
      while (index < times.length - 2 && times[index + 1] < t) index++;
      const fraction = (t - times[index]) / (times[index + 1] - times[index]);
      samples.push(run[index].ms + fraction * (run[index + 1].ms - run[index].ms));
    }
    // Linearen Trend entfernen, anschließend Hann-Fenster gegen Spektralleckage.
    const mean = samples.reduce((a, b) => a + b, 0) / n, center = (n - 1) / 2;
    let numerator = 0, denominator = 0;
    samples.forEach((x, i) => { numerator += (i - center) * (x - mean); denominator += (i - center) ** 2; });
    const slope = numerator / denominator;
    const power = fftPower(samples.map((x, i) =>
      (x - mean - slope * (i - center)) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)))));
    const bins = [];
    for (let k = 1; k < power.length; k++) {
      const hz = k * 4 / n;
      if (hz >= 0.04 && hz <= 0.15) bins.push({ hz, power: power[k] });
    }
    bins.sort((a, b) => b.power - a.power);
    const median = [...bins].sort((a, b) => a.power - b.power)[Math.floor(bins.length / 2)].power;
    if (bins[0].power < 1e-6 || bins[0].power < median * 3) return null;
    return { rate: bins[0].hz * 60, seconds: n / 4, resolution: 240 / n };
  }

  class OrthostaticTest {
    constructor() { this.state = 'idle'; this.summary = null; }
    start(now, iso, lyingSeconds, standingSeconds, options) {
      if (![lyingSeconds, standingSeconds].every(x => Number.isInteger(x) && x >= 15 && x <= 300)) {
        throw new Error('Phasendauer muss eine ganze Zahl zwischen 15 und 300 Sekunden sein.');
      }
      this.options = { ...options };
      this.durations = { lying: lyingSeconds * 1000, standing: standingSeconds * 1000 };
      this.phases = Object.fromEntries(['lying', 'standing'].map(key => [key, {
        hr: new RingBuffer(), rr: new RingBuffer(), events: new RingBuffer()
      }]));
      this.startedAt = iso; this.state = 'lying'; this.summary = null;
      this.deadline = now + this.durations.lying;
    }
    stand(now) {
      if (this.state !== 'awaitingStand') return;
      this.state = 'standing'; this.deadline = now + this.durations.standing;
    }
    get active() { return ['lying', 'awaitingStand', 'standing'].includes(this.state); }
    advance(now) {
      if (!['lying', 'standing'].includes(this.state) || now < this.deadline) return;
      if (this.state === 'lying') this.state = 'awaitingStand';
      else {
        this.state = 'complete';
        const phase = key => ({
          durationMs: this.durations[key],
          stats: statistics(this.phases[key].hr.values(), this.phases[key].rr.values(),
            this.options.filter, this.options.trimHR),
          events: this.phases[key].events.values().map(({ t, ...event }) => event)
        });
        const lying = phase('lying'), standing = phase('standing');
        this.summary = {
          startedAt: this.startedAt, options: this.options, lying, standing,
          deltaRMSSD: lying.stats.rmssd !== null && standing.stats.rmssd !== null
            ? standing.stats.rmssd - lying.stats.rmssd : null
        };
      }
    }
    add(data, stamp, samples) {
      this.advance(stamp.monotonic);
      if (!['lying', 'standing'].includes(this.state)) return;
      const phase = this.phases[this.state], t = stamp.monotonic;
      phase.hr.push({ t, hr: data.hr });
      samples.forEach(x => phase.rr.push(x));
      phase.events.push({ t, type: 'measurement', ...stamp, hr: data.hr,
        rr: [...data.rr], segment: samples[0]?.segment ?? 0, phase: this.state });
    }
    abort(reason) {
      if (!this.active) return;
      this.state = 'aborted'; this.reason = reason; this.summary = null;
    }
  }

  const SESSION_KEY = 'polar-h10.sessions.v1';
  const MAX_ROWS = 20_000;

  function summarizeEvents(events, options) {
    const rates = [], rr = [];
    let seq = 0, gap = 0;
    for (const event of events) {
      if (event.type !== 'measurement') continue;
      rates.push({ hr: event.hr });
      if (!event.rr.length) gap++;
      for (const ms of event.rr) rr.push({ ms, seq: ++seq, segment: `${event.phase || "recording"}:${event.segment}:${gap}` });
    }
    return statistics(rates, rr, options.filter, options.trimHR);
  }

  function csvForEvents(events) {
    const lines = ['zeitstempel_iso,hf_bpm,rr_ms'];
    for (const event of events) {
      if (event.type !== 'measurement') continue;
      for (const rr of event.rr.length ? event.rr : ['']) lines.push(`${event.iso},${event.hr},${rr}`);
    }
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  function validateSession(session) {
    const dateOK = value => typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value));
    if (!session || typeof session.id !== 'string' || !session.id || session.id.length > 100 ||
        typeof session.name !== 'string' || session.name.length > 80 || !dateOK(session.startedAt) ||
        !Number.isFinite(session.durationMs) || session.durationMs < 0 ||
        !['recording', 'ortho'].includes(session.kind) ||
        typeof session.options?.filter !== 'boolean' || typeof session.options?.trimHR !== 'boolean' ||
        !Array.isArray(session.events) || session.events.length > MAX_ROWS + 2) {
      throw new Error('Ungültige Session-Daten. Vorhandenen Speicher unverändert gelassen.');
    }
    let rows = 0;
    for (const event of session.events) {
      if (!event || !['start', 'stop', 'measurement'].includes(event.type) || !dateOK(event.iso) ||
          !Number.isFinite(event.monotonic) || event.monotonic < 0) throw new Error('Ungültiges Session-Ereignis.');
      if (event.type === 'measurement') {
        if (!Number.isInteger(event.hr) || event.hr < 0 || event.hr > 65535 ||
            !Number.isInteger(event.segment) || event.segment < 0 ||
            !Array.isArray(event.rr) || event.rr.length > 512 ||
            event.rr.some(x => !Number.isInteger(x) || x < 0 || x > 64000)) {
          throw new Error('Ungültige Session-Messwerte.');
        }
        rows += Math.max(1, event.rr.length);
      }
    }
    if (rows > MAX_ROWS) throw new Error('Session überschreitet das Limit von 20.000 Messzeilen.');
    if (session.kind === 'ortho') {
      if (!session.events.every(e => ['lying', 'standing'].includes(e.phase))) throw new Error('Ungültige Testphasen.');
      if (!['lying', 'standing'].every(key => Number.isFinite(session.phaseDurations?.[key]) &&
          session.phaseDurations[key] >= 15_000 && session.phaseDurations[key] <= 300_000)) {
        throw new Error('Ungültige Testdauer.');
      }
    }
    return session;
  }

  class SessionStore {
    constructor(storage) { this.storage = storage; this.sessions = []; this.blocked = false; }
    load() {
      try {
        const text = this.storage.getItem(SESSION_KEY);
        if (text === null) { this.sessions = []; return; }
        if (text.length > 2_000_000) throw new Error('Session-Speicher ist zu groß.');
        const saved = JSON.parse(text);
        if (saved.version !== 1 || !Array.isArray(saved.sessions) || saved.sessions.length > 20) {
          throw new Error('Unbekanntes Session-Format.');
        }
        saved.sessions.forEach(validateSession);
        if (new Set(saved.sessions.map(x => x.id)).size !== saved.sessions.length) throw new Error('Doppelte Session-IDs.');
        this.sessions = saved.sessions;
      } catch (error) {
        this.blocked = true;
        throw new Error(`Lokale Sessions nicht lesbar: ${error.message} Kein automatisches Überschreiben.`);
      }
    }
    commit(sessions) {
      if (this.blocked) throw new Error('Session-Speicher gesperrt: bitte Website-Speicher im Browser prüfen.');
      if (sessions.length > 20) throw new Error('Maximal 20 Sessions. Bitte zuerst eine alte Session exportieren und löschen.');
      const json = JSON.stringify({ version: 1, sessions });
      if (json.length > 2_000_000) throw new Error('Lokales Speicherlimit erreicht. Bitte ältere Sessions exportieren und löschen.');
      try { this.storage.setItem(SESSION_KEY, json); }
      catch { throw new Error('Speichern fehlgeschlagen: Browser-Speicher voll oder nicht verfügbar. CSV sichern.'); }
      // Erst nach erfolgreichem Schreiben auch den sichtbaren Zustand ändern.
      this.sessions = sessions;
    }
    save(session) {
      validateSession(session);
      this.commit([session, ...this.sessions.filter(x => x.id !== session.id)]);
    }
    remove(id) { this.commit(this.sessions.filter(x => x.id !== id)); }
  }

  // Alle BLE-Aufrufe und Listener gehören ausschließlich diesem Modul.
  const h10 = (() => {
    const events = new EventTarget();
    let device = null, characteristic = null, valueListener = null, disconnectListener = null;
    let state = 'disconnected', generation = 0;
    const emit = (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail }));
    const setState = value => { state = value; emit('state', value); };
    const timeout = (promise, label, ms = 12_000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}: Zeitüberschreitung. Bitte erneut verbinden.`)), ms);
      Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => {
        clearTimeout(timer); reject(error);
      });
    });
    function cleanup() {
      if (characteristic && valueListener) characteristic.removeEventListener('characteristicvaluechanged', valueListener);
      if (device && disconnectListener) device.removeEventListener('gattserverdisconnected', disconnectListener);
      characteristic = valueListener = disconnectListener = null;
      const oldDevice = device;
      device = null;
      try { if (oldDevice?.gatt?.connected) oldDevice.gatt.disconnect(); } catch { /* Bereits getrennt. */ }
    }
    function disconnect() {
      generation++;
      cleanup();
      setState('disconnected');
    }
    async function connect() {
      if (state !== 'disconnected') return;
      if (!globalThis.isSecureContext || !navigator.bluetooth) {
        emit('error', 'Bitte Chrome verwenden, HTTPS erforderlich. Web Bluetooth ist hier nicht verfügbar.');
        return;
      }
      const token = ++generation;
      let chosen = null;
      let stage = 'Auswahl';
      const current = () => token === generation;
      const check = () => { if (!current()) throw new Error('Verbindungsversuch beendet'); };
      setState('connecting');
      try {
        // Direkt im Button-Aufruf, vor dem ersten await: User-Gesture bleibt erhalten.
        chosen = await navigator.bluetooth.requestDevice({
          filters: [{ services: ['heart_rate'] }],
          optionalServices: ['battery_service']
        });
        check();
        device = chosen;
        disconnectListener = () => {
          if (!current()) return;
          disconnect();
          emit('error', 'Verbindung unterbrochen. Gurt prüfen und erneut verbinden.');
        };
        chosen.addEventListener('gattserverdisconnected', disconnectListener);
        stage = 'GATT-Verbindung';
        const pending = chosen.gatt.connect();
        // Auch ein erst nach dem Timeout erfolgreiches connect sauber aufräumen.
        pending.then(() => {
          if (!current() && device !== chosen && chosen.gatt.connected) chosen.gatt.disconnect();
        }).catch(() => {});
        const server = await timeout(pending, stage);
        check();
        stage = 'Herzfrequenz-Service';
        const service = await timeout(server.getPrimaryService('heart_rate'), stage);
        check();
        const measurement = await timeout(service.getCharacteristic('heart_rate_measurement'), 'Messwert-Characteristic');
        check();
        characteristic = measurement;
        valueListener = event => {
          if (!current()) return;
          try { emit('measurement', parseMeasurement(event.target.value)); }
          catch (error) { emit('error', `Messpaket verworfen: ${error.message}`); }
        };
        measurement.addEventListener('characteristicvaluechanged', valueListener);
        stage = 'Benachrichtigungen';
        await timeout(measurement.startNotifications(), stage);
        check();
        setState('connected');
        emit('device', chosen.name || 'Polar H10');
        // Batterie ist optional: ein Fehler darf den HF-Stream nicht beenden.
        try {
          const battery = await timeout(server.getPrimaryService('battery_service'), 'Batterie-Service', 5000);
          check();
          const level = await timeout(battery.getCharacteristic('battery_level'), 'Batterie-Characteristic', 5000);
          check();
          const value = await timeout(level.readValue(), 'Batterie lesen', 5000);
          check();
          if (!value.byteLength || value.getUint8(0) > 100) throw new Error('Ungültiger Batteriewert');
          emit('battery', value.getUint8(0));
        } catch {
          if (current()) emit('battery', null);
        }
      } catch (error) {
        if (!current()) return;
        disconnect();
        let message;
        if (stage === 'Auswahl' && error.name === 'NotFoundError') message = 'Nutzer hat Gerätauswahl abgebrochen oder kein passendes Gerät gefunden.';
        else if (error.name === 'SecurityError' || error.name === 'NotAllowedError') message = 'Bluetooth-Zugriff verweigert. Browser- und Website-Berechtigungen prüfen.';
        else message = `${stage} fehlgeschlagen: ${error.message || 'Bluetooth und Brustgurt prüfen.'}`;
        emit('error', message);
      }
    }
    return { events, connect, disconnect, get state() { return state; } };
  })();

  function init() {
    const $ = id => document.getElementById(id);
    const ui = Object.fromEntries(['status', 'device', 'connect', 'message', 'contact', 'battery', 'hr', 'freshness', 'live-rmssd', 'live-rmssd-normalized', 'live-rmssd-count', 'live-rmssd-mode',
      'chart', 'rr-list', 'rr-empty', 'filter', 'mean-hr', 'mean-rr', 'sdnn', 'rmssd', 'sample-count',
      'record', 'export', 'record-status', 'pnn50', 'trim-hr', 'stats-window', 'breathing', 'breathing-info', 'ortho-start', 'ortho-stand', 'ortho-cancel', 'lying-seconds', 'standing-seconds', 'ortho-status', 'ortho-result', 'session-name', 'save-session', 'sessions-list', 'sessions-status', 'ortho-save', 'ortho-export'].map(id => [id, $(id)]));
    const heartRates = new RingBuffer(), intervals = new RingBuffer();
    const liveRMSSD = new LiveRMSSD();
    let recent = [], lastFFT = -Infinity, breathing = null;
    let sequence = 0, segment = 0, lastReceived = null, lastContact = 'unsupported';
    let recording = false, rowCount = 0;
    let recordingEvents = [], currentSession = null, recordingSaved = true, recordingExported = false, orthoSessionId = null;
    let savedOrthoSummary = null;
    const store = new SessionStore({
      getItem: key => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value)
    });
    const ortho = new OrthostaticTest();
    let lastRRReceived = null;
    const time = () => {
      const monotonic = performance.now();
      return { monotonic, iso: new Date(performance.timeOrigin + monotonic).toISOString() };
    };
    const message = (text, error = false) => {
      ui.message.textContent = text;
      ui.message.classList.toggle('error', error);
    };
    const number = n => n === null ? '–' : n.toLocaleString('de-DE', { maximumFractionDigits: 1 });

    function download(events, name) {
      let url;
      try {
        url = URL.createObjectURL(new Blob([csvForEvents(events)], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `${name.replace(/[^a-zA-Z0-9äöüÄÖÜß_-]/g, '-').slice(0, 80) || 'polar-h10'}.csv`;
        document.body.append(link); link.click(); link.remove();
        message('CSV-Download angefordert.');
        return true;
      } catch (error) { message(`CSV-Export fehlgeschlagen: ${error.message}`, true); return false; }
      finally { if (url) setTimeout(() => URL.revokeObjectURL(url), 60_000); }
    }
    function renderSessions() {
      const items = store.sessions.map(session => {
        const item = document.createElement('li'), title = document.createElement('h3');
        title.textContent = session.name;
        const info = document.createElement('p'), summary = summarizeEvents(session.events, session.options);
        info.textContent = `${new Date(session.startedAt).toLocaleString('de-DE')} · ${number(session.durationMs / 1000)} s · ` +
          `RMSSD ${number(summary.rmssd)} ms · SDNN ${number(summary.sdnn)} ms`;
        item.append(title, info);
        if (session.kind === 'ortho') {
          const lying = summarizeEvents(session.events.filter(x => x.phase === 'lying'), session.options);
          const standing = summarizeEvents(session.events.filter(x => x.phase === 'standing'), session.options);
          const phase = document.createElement('p');
          const delta = lying.rmssd !== null && standing.rmssd !== null ? standing.rmssd - lying.rmssd : null;
          phase.textContent = `Ortho · Liegen RMSSD ${number(lying.rmssd)} ms / SDNN ${number(lying.sdnn)} ms · ` +
            `Stehen RMSSD ${number(standing.rmssd)} ms / SDNN ${number(standing.sdnn)} ms · Δ RMSSD ${number(delta)} ms`;
          item.append(phase);
        }
        const actions = document.createElement('div'); actions.className = 'actions';
        const csv = document.createElement('button'), remove = document.createElement('button');
        csv.type = remove.type = 'button'; csv.className = remove.className = 'secondary';
        csv.textContent = 'CSV exportieren'; remove.textContent = 'Löschen';
        csv.addEventListener('click', () => download(session.events, session.name));
        remove.addEventListener('click', () => {
          if (!confirm(`Session „${session.name}“ dauerhaft löschen?`)) return;
          try {
            store.remove(session.id); renderSessions();
            if (currentSession?.id === session.id) { recordingSaved = false; renderRecording(); }
            if (orthoSessionId === session.id) { savedOrthoSummary = null; renderOrtho(); }
            ui['sessions-status'].textContent = 'Session gelöscht.';
          } catch (error) { ui['sessions-status'].textContent = error.message; }
        });
        actions.append(csv, remove); item.append(actions); return item;
      });
      ui['sessions-list'].replaceChildren(...items);
      if (!items.length && !store.blocked) ui['sessions-status'].textContent = 'Noch keine gespeicherten Sessions.';
    }
    function saveCurrentSession() {
      if (!currentSession || !rowCount || recording) return;
      currentSession.name = ui['session-name'].value.trim().slice(0, 80) || currentSession.name;
      currentSession.events = recordingEvents;
      currentSession.summary = summarizeEvents(recordingEvents, currentSession.options);
      try {
        store.save(currentSession); recordingSaved = true;
        renderSessions(); ui['sessions-status'].textContent = 'Session lokal gespeichert.';
      } catch (error) {
        recordingSaved = false;
        ui['sessions-status'].textContent = error.message;
        message('Aufnahme noch nicht gespeichert. Bitte CSV exportieren oder Speichern erneut versuchen.', true);
      }
      renderRecording();
    }

    function renderLiveRMSSD() {
      liveRMSSD.expire(performance.now());
      const value = liveRMSSD.value(ui['live-rmssd-mode'].value === 'smoothed');
      const format = n => n === null ? '—' : n.toLocaleString('de-DE', {
        minimumFractionDigits: 1, maximumFractionDigits: 1
      });
      ui['live-rmssd'].textContent = format(value?.rmssd ?? null);
      // 60-bpm-Bezug: RMSSD / 60 × (60000 / mittleres RR), Ergebnis in ms.
      ui['live-rmssd-normalized'].textContent = format(value ? value.ratio * 1000 : null);
      ui['live-rmssd-count'].textContent = `${liveRMSSD.count} RR · ${liveRMSSD.pairs} Paare · 10 s-Fenster`;
    }

    function draw() {
      const canvas = ui.chart, rect = canvas.getBoundingClientRect();
      const ratio = globalThis.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      const ctx = canvas.getContext('2d');
      if (!ctx || !rect.width) return;
      ctx.scale(ratio, ratio);
      const w = rect.width, h = rect.height, pad = 20;
      ctx.strokeStyle = '#334a5b'; ctx.lineWidth = 1;
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath(); ctx.moveTo(pad, h * i / 4); ctx.lineTo(w - pad, h * i / 4); ctx.stroke();
      }
      if (!recent.length) return;
      const low = Math.min(300, ...recent.map(x => x.ms)) - 50;
      const high = Math.max(1200, ...recent.map(x => x.ms)) + 50;
      const point = (x, i) => [pad + i * (w - pad * 2) / Math.max(1, recent.length - 1),
        h - pad - (x.ms - low) / (high - low) * (h - pad * 2)];
      ctx.strokeStyle = '#86f6c1'; ctx.lineWidth = 2; ctx.beginPath();
      recent.forEach((x, i) => {
        const [px, py] = point(x, i);
        if (!i || x.segment !== recent[i - 1].segment) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
      recent.forEach((x, i) => {
        const [px, py] = point(x, i), artifact = isArtifact(x.ms);
        ctx.fillStyle = artifact ? '#ffd28a' : '#86f6c1'; ctx.beginPath();
        if (artifact) { ctx.moveTo(px, py - 5); ctx.lineTo(px + 5, py); ctx.lineTo(px, py + 5); ctx.lineTo(px - 5, py); ctx.closePath(); }
        else ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    function renderOrtho() {
      const now = performance.now();
      if (ortho.active && (h10.state !== 'connected' || lastRRReceived === null || now - lastRRReceived > 5000)) {
        ortho.abort('Keine aktuellen RR-Daten. Bitte Gurt prüfen und Test neu starten.');
      }
      ortho.advance(now);
      ui['ortho-start'].disabled = ortho.active || h10.state !== 'connected';
      ui['ortho-stand'].hidden = ortho.state !== 'awaitingStand';
      ui['ortho-cancel'].hidden = !ortho.active;
      ui['lying-seconds'].disabled = ui['standing-seconds'].disabled = ortho.active;
      const seconds = Math.max(0, Math.ceil((ortho.deadline - now) / 1000));
      ui['ortho-status'].textContent = {
        idle: 'Bereit: Gurt verbinden, ruhig hinlegen und Test starten.',
        lying: `Liegen · noch ${seconds} s. Ruhig liegen bleiben.`,
        awaitingStand: 'Liegephase beendet. Vorsichtig aufstehen und Stehphase bestätigen.',
        standing: `Stehen · noch ${seconds} s. Ruhig stehen bleiben.`,
        complete: 'Test abgeschlossen. Delta = Stehen minus Liegen.',
        aborted: `Test abgebrochen: ${ortho.reason}`
      }[ortho.state];
      const result = ortho.summary;
      ui['ortho-save'].hidden = ui['ortho-export'].hidden = !result;
      ui['ortho-save'].disabled = !result || savedOrthoSummary === result;
      ui['ortho-result'].textContent = result
        ? `Liegen: RMSSD ${number(result.lying.stats.rmssd)} ms / SDNN ${number(result.lying.stats.sdnn)} ms (${result.lying.stats.count} RR) · ` +
          `Stehen: RMSSD ${number(result.standing.stats.rmssd)} ms / SDNN ${number(result.standing.stats.sdnn)} ms (${result.standing.stats.count} RR) · ` +
          `Delta-RMSSD: ${number(result.deltaRMSSD)} ms`
        : '';
    }
    function renderStats() {
      const now = performance.now(), cutoff = now - Number(ui['stats-window'].value);
      heartRates.prune(now - BUFFER_MS);
      intervals.prune(now - BUFFER_MS);
      const s = statistics(heartRates.values(cutoff), intervals.values(cutoff), ui.filter.checked, ui['trim-hr'].checked);
      ui.pnn50.textContent = number(s.pnn50);
      if (now - lastFFT >= 5000) {
        breathing = estimateBreathing(intervals.values());
        lastFFT = now;
      }
      const rrFresh = lastRRReceived !== null && now - lastRRReceived <= 5000;
      ui.breathing.textContent = number(rrFresh ? breathing?.rate ?? null : null);
      ui['breathing-info'].textContent = !rrFresh ? 'Keine aktuellen RR-Daten für die Atemraten-Näherung.' : breathing
        ? `LF-Peak · ${breathing.seconds} s · Auflösung ca. ${number(breathing.resolution)}/min`
        : 'Mindestens 64 s zusammenhängende plausible RR-Daten und deutlicher LF-Peak nötig.';
      ui['mean-hr'].textContent = number(s.meanHR); ui['mean-rr'].textContent = number(s.meanRR);
      ui.sdnn.textContent = number(s.sdnn); ui.rmssd.textContent = number(s.rmssd);
      ui['sample-count'].textContent = `${s.count} RR-Werte · ${s.pairs} aufeinanderfolgende Paare`;
      const stale = lastReceived === null || performance.now() - lastReceived > 5000;
      if (stale) ui.hr.textContent = '–';
      ui.freshness.textContent = lastReceived === null ? 'Warte auf Messdaten'
        : stale ? 'Seit über 5 Sekunden keine Messdaten' : 'Live · Messdaten aktuell';
      ui.contact.textContent = stale ? 'Kontakt: unbekannt' : {
        detected: 'Kontakt: erkannt', missing: 'Kontakt: fehlt', unsupported: 'Kontakt: nicht unterstützt'
      }[lastContact];
      ui.contact.classList.toggle('bad-contact', !stale && lastContact === 'missing');
      renderOrtho();
    }
    function renderRecording() {
      ui.record.textContent = recording ? 'Aufnahme stoppen' : 'Aufnahme starten';
      ui.record.disabled = !recording && h10.state !== 'connected';
      ui.export.disabled = rowCount === 0;
      ui['save-session'].disabled = recording || !rowCount || recordingSaved;
      ui['session-name'].disabled = recording;
      ui['record-status'].textContent = `${recording ? '● Aufnahme läuft' : 'Nicht aktiv'} · ${rowCount} Messzeilen${!recording && rowCount ? (recordingSaved ? ' · lokal gespeichert' : ' · noch nicht gespeichert') : ''}`;
    }
    function stopRecording() {
      if (recording) recordingEvents.push({ type: 'stop', ...time() });
      if (recording && currentSession) currentSession.durationMs = performance.now() - currentSession.monotonicStart;
      recording = false;
      if (currentSession && rowCount && !recordingSaved) saveCurrentSession();
      renderRecording();
    }
    h10.events.addEventListener('state', ({ detail: state }) => {
      if (state !== 'connected') { liveRMSSD.reset(); renderLiveRMSSD(); }
      ui.status.dataset.state = state;
      ui.status.textContent = { disconnected: 'Getrennt', connecting: 'Verbinde', connected: 'Verbunden' }[state];
      ui.connect.disabled = state === 'connecting';
      ui.connect.textContent = state === 'connected' ? 'Trennen' : state === 'connecting' ? 'Verbinde …' : 'Verbinden';
      if (state === 'connecting') {
        segment++;
        message('Sensor auswählen. Andere Apps gegebenenfalls vom H10 trennen.');
      }
      if (state === 'connected') message('Verbunden. Warte auf Messwerte vom Brustgurt.');
      if (state === 'disconnected') {
        stopRecording(); lastReceived = lastRRReceived = null;
        ui.device.textContent = 'Kein Sensor verbunden'; ui.battery.textContent = 'Batterie: –';
        message('Getrennt. Du kannst erneut verbinden.');
      }
      renderStats(); renderRecording();
    });
    h10.events.addEventListener('device', ({ detail }) => { ui.device.textContent = detail; });
    h10.events.addEventListener('battery', ({ detail }) => {
      ui.battery.textContent = detail === null ? 'Batterie: nicht verfügbar' : `Batterie: ${detail} %`;
    });
    h10.events.addEventListener('error', ({ detail }) => message(detail, true));
    h10.events.addEventListener('measurement', ({ detail: data }) => {
      const stamp = time(), t = stamp.monotonic;
      // Datenlücken, Pakete ohne RR und Kontaktverlust trennen RMSSD-Paare.
      if ((lastReceived !== null && t - lastReceived > 5000) || !data.rr.length || data.contact === 'missing') segment++;
      lastReceived = t; lastContact = data.contact;
      heartRates.push({ t, hr: data.hr });
      ui.hr.textContent = String(data.hr);
      const packetSamples = [];
      for (const ms of data.rr) {
        liveRMSSD.add(t, ms, segment); // Nur die Live-Anzeigen filtern hier; Rohwerte bleiben erhalten.
        const sample = { t, ms, seq: ++sequence, segment, contact: data.contact };
        intervals.push(sample); recent.push(sample); packetSamples.push(sample);
      }
      if (ortho.active && lastRRReceived !== null && t - lastRRReceived > 5000) {
        ortho.abort('RR-Datenlücke über 5 Sekunden.');
      }
      if (data.rr.length) lastRRReceived = t;
      if (data.contact === 'missing') ortho.abort('Sensorkontakt verloren.');
      ortho.add(data, stamp, packetSamples);
      recent = recent.slice(-40);
      if (recording && rowCount + Math.max(1, data.rr.length) > MAX_ROWS) {
        stopRecording();
        message('Aufnahme bei 20.000 Messzeilen beendet. CSV sichern und neue Session starten.', true);
      }
      if (recording) {
        recordingEvents.push({ type: 'measurement', ...stamp, hr: data.hr, rr: [...data.rr], segment });
        rowCount += Math.max(1, data.rr.length);
      }
      const items = [...recent].reverse().map(x => {
        const li = document.createElement('li');
        const artifact = isArtifact(x.ms);
        li.textContent = `${artifact ? '◆ ' : ''}${x.ms}`;
        li.classList.toggle('artifact', artifact);
        li.setAttribute('aria-label', `${x.ms} Millisekunden${artifact ? ', außerhalb Plausibilitätsbereich' : ''}`);
        return li;
      });
      ui['rr-list'].replaceChildren(...items);
      ui['rr-empty'].hidden = recent.length > 0;
      renderStats(); renderRecording(); draw(); renderLiveRMSSD();
    });
    ui['ortho-start'].addEventListener('click', () => {
      if (h10.state !== 'connected' || lastRRReceived === null || performance.now() - lastRRReceived > 5000) {
        message('Für den Test sind aktuelle RR-Daten erforderlich.', true); return;
      }
      if (ortho.summary && savedOrthoSummary !== ortho.summary &&
          !confirm('Der bisherige Test ist noch nicht gespeichert. Trotzdem einen neuen Test starten?')) return;
      try {
        const stamp = time();
        ortho.start(stamp.monotonic, stamp.iso, Number(ui['lying-seconds'].value), Number(ui['standing-seconds'].value),
          { filter: ui.filter.checked, trimHR: ui['trim-hr'].checked });
        orthoSessionId = crypto.randomUUID();
        renderOrtho();
      } catch (error) { message(error.message, true); }
    });
    ui['ortho-export'].addEventListener('click', () => {
      if (ortho.summary) download([...ortho.summary.lying.events, ...ortho.summary.standing.events], 'H10-Orthostatischer-Test');
    });
    ui['ortho-save'].addEventListener('click', () => {
      const result = ortho.summary;
      if (!result) return;
      const events = [...result.lying.events, ...result.standing.events];
      const options = result.options;
      const session = {
        id: orthoSessionId, name: ui['session-name'].value.trim().slice(0, 80) || 'Orthostatischer Test',
        kind: 'ortho', startedAt: result.startedAt,
        durationMs: result.lying.durationMs + result.standing.durationMs,
        phaseDurations: { lying: result.lying.durationMs, standing: result.standing.durationMs },
        events, options, summary: summarizeEvents(events, options)
      };
      try {
        store.save(session); savedOrthoSummary = result; renderSessions(); renderOrtho();
        ui['sessions-status'].textContent = 'Orthostatischer Test lokal gespeichert.';
      } catch (error) { ui['sessions-status'].textContent = error.message; }
    });
    ui['ortho-stand'].addEventListener('click', () => { ortho.stand(performance.now()); renderOrtho(); });
    ui['ortho-cancel'].addEventListener('click', () => { ortho.abort('Manuell beendet.'); renderOrtho(); });
    ui.connect.addEventListener('click', () => {
      if (h10.state === 'connected') h10.disconnect();
      else void h10.connect();
    });
    ui['live-rmssd-mode'].addEventListener('change', renderLiveRMSSD);
    ui.filter.addEventListener('change', renderStats);
    ui['trim-hr'].addEventListener('change', renderStats);
    ui['stats-window'].addEventListener('change', renderStats);
    ui.record.addEventListener('click', () => {
      if (recording) stopRecording();
      else if (h10.state === 'connected') {
        if (rowCount && !recordingSaved && !recordingExported) {
          message('Vor einer neuen Aufnahme bitte die bisherige Session speichern oder CSV exportieren.', true);
          return;
        }
        const stamp = time();
        recording = true; recordingSaved = recordingExported = false; rowCount = 0;
        currentSession = {
          id: crypto.randomUUID(), kind: 'recording',
          name: ui['session-name'].value.trim().slice(0, 80) || `H10 ${new Date().toLocaleString('de-DE')}`,
          startedAt: stamp.iso, monotonicStart: stamp.monotonic, durationMs: 0,
          options: { filter: ui.filter.checked, trimHR: ui['trim-hr'].checked }, events: []
        };
        recordingEvents = [{ type: 'start', ...stamp }];
        renderRecording();
      }
    });
    ui.export.addEventListener('click', () => {
      recordingExported = download(recordingEvents, currentSession?.name || 'polar-h10') || recordingExported;
    });
    ui['save-session'].addEventListener('click', saveCurrentSession);
    window.addEventListener('beforeunload', event => {
      if (recording || (rowCount && !recordingSaved && !recordingExported)) { event.preventDefault(); event.returnValue = ''; }
    });
    window.addEventListener('pagehide', () => h10.disconnect());
    window.addEventListener('resize', draw);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) ortho.abort('Seite im Hintergrund. Test bitte im Vordergrund durchführen.');
      renderStats();
    });
    setInterval(renderStats, 1000);
    setInterval(renderLiveRMSSD, 250); // Fenster läuft auch ohne neue Notifications ab.
    if (!globalThis.isSecureContext || !navigator.bluetooth) {
      ui.connect.disabled = true;
      message('Bitte Chrome verwenden, HTTPS erforderlich. Web Bluetooth ist hier nicht verfügbar.', true);
    }
    try { store.load(); }
    catch (error) { ui['sessions-status'].textContent = error.message; }
    renderSessions(); renderRecording(); renderStats(); draw(); renderLiveRMSSD();
  }
  init();
})();
