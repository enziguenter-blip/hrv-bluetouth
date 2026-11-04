const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
class CustomEvent extends Event { constructor(type, options) { super(type); this.detail = options.detail; } }
const context = { EventTarget, CustomEvent, navigator: {}, isSecureContext: true, performance, setTimeout, clearTimeout };
vm.createContext(context);
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
vm.runInContext(source.replace('  init();', '  globalThis.test = { parseMeasurement, statistics, h10, RingBuffer, estimateBreathing, OrthostaticTest, SessionStore, csvForEvents, summarizeEvents, LiveRMSSD };'), context);
const { parseMeasurement: parse, statistics: stats, h10 } = context.test;
let count = 0;
function test(name, f) { f(); count++; console.log('PASS', name); }
const packet = (...bytes) => new DataView(Uint8Array.from(bytes).buffer);
test('uint8 HR without RR', () => assert.equal(parse(packet(0, 72)).hr, 72));
test('uint16 HR and energy and multiple RR', () => {
  const x = parse(packet(0x1f, 44, 1, 123, 0, 0, 4, 0, 2));
  assert.equal(x.hr, 300); assert.equal(x.contact, 'detected');
  assert.equal(JSON.stringify(x.rr), '[1000,500]');
});
test('contact missing and unsupported', () => {
  assert.equal(parse(packet(4, 70)).contact, 'missing');
  assert.equal(parse(packet(2, 70)).contact, 'unsupported');
});
test('DataView byteOffset and rounding', () => {
  const a = Uint8Array.from([99,16,80,1,4,99]);
  assert.equal(parse(new DataView(a.buffer,1,4)).rr[0], 1001);
});
for (const bytes of [[],[0],[1,70],[8,70,0],[16,70],[16,70,0],[0,70,0]]) {
 test(`reject malformed ${JSON.stringify(bytes)}`, () => assert.throws(() => parse(packet(...bytes))));
}
const rr = [800,1000,1200].map((ms,i) => ({ms,seq:i,segment:1}));
test('sample SDNN and RMSSD', () => {
 const s = stats([{hr:60},{hr:80}],rr,true);
 assert.equal(s.meanHR,70); assert.equal(s.meanRR,1000); assert.equal(s.sdnn,200); assert.equal(s.rmssd,200);
});
test('filter breaks adjacency and preserves original', () => {
 const input = [800,250,1200].map((ms,i)=>({ms,seq:i,segment:1}));
 assert.equal(stats([],input,true).pairs,0); assert.equal(stats([],input,false).count,3); assert.equal(input[1].ms,250);
});
test('reconnect segments break adjacency', () => assert.equal(stats([], [{ms:800,seq:0,segment:1},{ms:1000,seq:1,segment:2}],false).pairs,0));
test('empty and single sample undefined variability', () => {
 assert.equal(stats([],[],true).meanRR,null); assert.equal(stats([],[rr[0]],true).sdnn,null);
});
const { RingBuffer, estimateBreathing } = context.test;
test('ring wraps in order and expires entries at cutoff', () => {
 const ring = new RingBuffer(3);
 for (let t=0;t<10;t++) ring.push({t});
 assert.equal(ring.data.length,3); assert.equal(ring.size,3);
 assert.equal(JSON.stringify(ring.values()), JSON.stringify([{t:7},{t:8},{t:9}]));
 ring.prune(8); assert.equal(ring.size,1); assert.equal(ring.values()[0].t,9);
 ring.prune(99); assert.equal(ring.size,0);ring.push({t:100});assert.equal(ring.values()[0].t,100);
});
test('pNN50 uses strict >50 and valid adjacent pair denominator',()=>{
 const data=[800,850,950].map((ms,seq)=>({ms,seq,segment:1}));
 assert.equal(stats([],data,true).pnn50,50);
 assert.equal(stats([],[],true).pnn50,null);
});
test('optional HR trim removes 5 percent each tail only from mean HR',()=>{
 const rates=Array.from({length:20},(_,i)=>({hr:i===19?1000:60}));
 assert.equal(stats(rates,rr,true,true).meanHR,60);
 assert.equal(stats(rates,rr,true,false).meanHR,107);
 assert.equal(stats(rates,rr,true,true).rmssd,200);
});
const wave=[]; let beatTime=0;
for(let seq=0;seq<280;seq++){
 const ms=1000+70*Math.sin(2*Math.PI*.1*beatTime);
 wave.push({ms,seq,segment:1,t:beatTime*1000});beatTime+=ms/1000;
}
test('LF FFT recovers synthetic 0.1 Hz rhythm within one bin',()=>{
 const result=estimateBreathing(wave);
 assert.ok(result);assert.ok(Math.abs(result.rate-6)<=result.resolution);
});
test('LF FFT rejects flat, short, artifact or disconnected tail',()=>{
 assert.equal(estimateBreathing(wave.slice(0,20)),null);
 assert.equal(estimateBreathing(wave.map(x=>({...x,ms:1000}))),null);
 assert.equal(estimateBreathing([...wave,{ms:250,seq:280,segment:1}]),null);
 assert.equal(estimateBreathing([...wave,{ms:1000,seq:280,segment:2}]),null);
});
const { OrthostaticTest } = context.test;
test('ortho separates phases, waits for standing confirmation and computes delta',()=>{
 const o=new OrthostaticTest();
 o.start(0,'2026-11-03T00:00:00.000Z',15,15,{filter:true,trimHR:false});
 const add=(t,ms,seq)=>o.add({hr:60,rr:[ms]},{monotonic:t,iso:'2026-11-03T00:00:01.000Z'},[{t,ms,seq,segment:1}]);
 add(1000,800,1);add(2000,900,2);
 o.advance(15000);assert.equal(o.state,'awaitingStand');
 add(20000,2000,3);assert.equal(o.phases.standing.rr.size,0);
 o.stand(30000);add(31000,800,4);add(32000,1000,5);
 o.advance(45000);assert.equal(o.state,'complete');
 assert.equal(o.summary.lying.stats.count,2);assert.equal(o.summary.standing.stats.count,2);
 assert.equal(o.summary.deltaRMSSD,100);
 assert.equal(o.summary.lying.events[0].phase,'lying');
});
test('late ortho ticks do not silently start standing; boundary data excluded',()=>{
 const o=new OrthostaticTest();o.start(0,'2026-11-03T00:00:00.000Z',15,15,{filter:true});
 o.add({hr:60,rr:[800]},{monotonic:15000,iso:'2026-11-03T00:00:15.000Z'},[{t:15000,ms:800,seq:1,segment:1}]);
 assert.equal(o.state,'awaitingStand');assert.equal(o.phases.lying.rr.size,0);
 o.advance(100000);assert.equal(o.state,'awaitingStand');
 o.abort('signal lost');assert.equal(o.state,'aborted');assert.equal(o.summary,null);
});
test('ortho duration validation and null delta for insufficient pairs',()=>{
 const o=new OrthostaticTest();assert.throws(()=>o.start(0,'x',0,60,{}));
 o.start(0,'2026-11-03T00:00:00.000Z',15,15,{});o.advance(15000);o.stand(20000);o.advance(35000);
 assert.equal(o.summary.deltaRMSSD,null);
});
const { SessionStore, csvForEvents, summarizeEvents }=context.test;
const event=(rr,segment=1)=>({type:'measurement',iso:'2026-11-03T00:00:01.000Z',monotonic:1000,hr:60,rr,segment});
const session=id=>({id,name:'Morgenmessung',kind:'recording',startedAt:'2026-11-03T00:00:00.000Z',durationMs:2000,
 options:{filter:true,trimHR:false},events:[event([800,900,250,1200])]});
const memory=()=>({data:null,getItem(){return this.data},setItem(key,value){this.data=value}});
test('sessions save, reload, upsert, delete with raw artifact CSV',()=>{
 const storage=memory(),store=new SessionStore(storage);store.load();
 store.save(session('a'));store.save(session('b'));store.save({...session('a'),name:'Neu'});
 const restored=new SessionStore(storage);restored.load();assert.equal(restored.sessions.length,2);
 assert.equal(restored.sessions[0].name,'Neu');
 assert.ok(csvForEvents(restored.sessions[0].events).includes(',60,250'));
 assert.equal(summarizeEvents(restored.sessions[0].events,restored.sessions[0].options).count,3);
 restored.remove('a');const again=new SessionStore(storage);again.load();assert.equal(again.sessions[0].id,'b');
});
test('storage quota failure preserves old sessions and permits retry',()=>{
 const storage=memory(),store=new SessionStore(storage);store.load();store.save(session('a'));
 const old=storage.data,write=storage.setItem;
 storage.setItem=()=>{throw new Error('QuotaExceededError')};
 assert.throws(()=>store.save(session('b')));assert.equal(store.sessions.length,1);assert.equal(storage.data,old);
 assert.throws(()=>store.remove('a'));assert.equal(store.sessions.length,1);
 storage.setItem=write;store.save(session('b'));assert.equal(store.sessions.length,2);
});
test('corrupt storage is preserved and blocks overwrite',()=>{
 const storage=memory();storage.data='{broken';const store=new SessionStore(storage);
 assert.throws(()=>store.load());assert.throws(()=>store.save(session('a')));assert.equal(storage.data,'{broken');
});
test('session validation rejects invalid data and enforces count cap',()=>{
 const store=new SessionStore(memory());store.load();
 assert.throws(()=>store.save({...session('bad'),events:[event([NaN])]}));
 for(let i=0;i<20;i++)store.save(session(String(i)));
 assert.throws(()=>store.save(session('21')));assert.equal(store.sessions.length,20);
});
test('session summaries preserve gap and ortho phase boundaries',()=>{
 const rows=[event([800]),event([]),event([1000])];
 assert.equal(summarizeEvents(rows,{filter:true}).pairs,0);
 assert.equal(summarizeEvents([{...event([800]),phase:'lying'},{...event([1000]),phase:'standing'}],{filter:true}).pairs,0);
});
const { LiveRMSSD } = context.test;
const batchRMSSD = values => Math.sqrt(values.slice(1).reduce((sum,x,i)=>sum+(x-values[i])**2,0)/(values.length-1));
const batchRatio = values => batchRMSSD(values)/(values.reduce((a,b)=>a+b,0)/values.length);
test('live RMSSD needs five values and uses successive differences; constant RR yield zero',()=>{
 const live=new LiveRMSSD();
 for(let i=0;i<4;i++)live.add(i*1000,800+i*100);
 assert.equal(live.value(),null);assert.equal(live.value(true),null);
 live.add(4000,1200);assert.equal(live.value().rmssd,100);assert.equal(live.value().ratio,.1);
 live.reset();for(let i=0;i<5;i++)live.add(i*1000,1000);
 assert.equal(live.value().rmssd,0);assert.equal(live.value().ratio,0);
});
test('live artifacts break pairs and do not alter already estimated smoothing',()=>{
 const live=new LiveRMSSD();[800,900,250,1200,1300,1400].forEach(x=>live.add(0,x));
 assert.equal(live.count,5);assert.equal(live.pairs,3);assert.equal(live.value().rmssd,100);
 const before=JSON.stringify(live.value(true));
 for(const x of [299,2001,NaN,Infinity])live.add(0,x);
 assert.equal(JSON.stringify(live.value(true)),before);
 live.add(0,1600);assert.equal(live.pairs,3); // Kein Paar über das Artefakt hinweg.
});
test('live artifact boundaries include 300 and 2000 ms',()=>{
 const live=new LiveRMSSD();[300,300,2000,300,2000].forEach(x=>live.add(0,x));
 assert.equal(live.count,5);assert.equal(live.pairs,4);
 assert.equal(live.value().rmssd,batchRMSSD([300,300,2000,300,2000]));
});
test('live segment boundaries do not create pairs',()=>{
 const live=new LiveRMSSD();live.add(0,800,1);live.add(0,900,1);
 [1200,1300,1400].forEach(x=>live.add(0,x,2));
 assert.equal(live.pairs,3);assert.equal(live.value().rmssd,100);
});
test('live five isolated valid RR have no RMSSD or normalized value',()=>{
 const live=new LiveRMSSD();for(let i=0;i<5;i++){live.add(0,800+i*100);live.add(0,250)}
 assert.equal(live.count,5);assert.equal(live.pairs,0);assert.equal(live.value(),null);
});
test('live time expiry removes outgoing difference and exact 10 s boundary is retained',()=>{
 const live=new LiveRMSSD();for(let i=0;i<6;i++)live.add(i*1000,800+i*i*20);
 live.expire(10000);assert.equal(live.count,6);
 live.expire(10001);assert.equal(live.count,5);assert.equal(live.pairs,4);
 assert.ok(Math.abs(live.value().rmssd-batchRMSSD([820,880,980,1120,1300]))<1e-9);
 live.expire(11001);assert.equal(live.value(true),null);
 live.expire(15001);assert.equal(live.count,0);assert.equal(live.pairs,0);assert.equal(live.historyCount,0);
});
test('live multiple RR share packet timestamp and expire together',()=>{
 const live=new LiveRMSSD();[800,900,1000,1100,1200].forEach(x=>live.add(5000,x));
 live.expire(15000);assert.equal(live.count,5);live.expire(15001);assert.equal(live.count,0);
});
test('both live metrics average last three independent unrounded estimates',()=>{
 const live=new LiveRMSSD(),values=[],raw=[],ratios=[];
 [800,900,1000,1100,1200,1500,1600,1900].forEach((x,i)=>{
  values.push(x);live.add(i*1000,x);if(values.length>=5){raw.push(batchRMSSD(values));ratios.push(batchRatio(values))}
 });
 const average=values=>values.slice(-3).reduce((a,b)=>a+b,0)/3;
 assert.ok(Math.abs(live.value(true).rmssd-average(raw))<1e-9);
 assert.ok(Math.abs(live.value(true).ratio-average(ratios))<1e-12);
 live.expire(8000);assert.ok(Math.abs(live.value(true).ratio-average(ratios))<1e-12);
 live.expire(11001);raw.push(batchRMSSD(values.slice(2)));ratios.push(batchRatio(values.slice(2)));
 assert.ok(Math.abs(live.value(true).rmssd-average(raw))<1e-9);
 assert.ok(Math.abs(live.value(true).ratio-average(ratios))<1e-12);
});
test('pulse normalization is invariant to scaling all RR; RMSSD retains ms',()=>{
 const a=new LiveRMSSD(),b=new LiveRMSSD();
 [500,600,550,650,600].forEach(x=>{a.add(0,x);b.add(0,x*2)});
 assert.equal(a.value().ratio,b.value().ratio);assert.equal(a.value().rmssd*2,b.value().rmssd);
});
test('live histories reset after insufficient data and disconnect reset',()=>{
 const live=new LiveRMSSD();[300,500,800,1000,2000].forEach(x=>live.add(0,x));
 live.expire(10001);[1000,1000,1000,1000,1000].forEach(x=>live.add(11000,x));
 assert.equal(live.value(true).rmssd,0);assert.equal(live.value(true).ratio,0);
 live.reset();assert.equal(live.count,0);assert.equal(live.value(true),null);
});
test('rolling RMSSD matches batch metrics over long stream with artifacts and gaps',()=>{
 const live=new LiveRMSSD();let reference=[];
 for(let i=0;i<20000;i++){
  const t=i*137,ms=i%17===0?250:300+(i*73)%1701,segment=Math.floor(i/91);
  live.add(t,ms,segment);reference=reference.filter(x=>x.t>=t-10000);
  if(ms>=300&&ms<=2000)reference.push({t,ms,seq:i,segment});
  const expected=stats([],reference,true);
  assert.equal(live.count,reference.length);assert.equal(live.pairs,expected.pairs);
  if(reference.length>=5&&expected.pairs){
   assert.ok(Math.abs(live.value().rmssd-expected.rmssd)<1e-9);
   assert.ok(Math.abs(live.value().ratio-expected.rmssd/expected.meanRR)<1e-12);
  }else assert.equal(live.value(),null);
 }
});
test('live fixed buffer wraps, removes pair edge, and keeps metrics consistent',()=>{
 const live=new LiveRMSSD(8);for(let i=0;i<100;i++)live.add(0,300+i*i%1701);
 const values=Array.from({length:8},(_,i)=>300+(i+92)**2%1701);
 assert.equal(live.rr.length,8);assert.equal(live.count,8);assert.equal(live.pairs,7);
 assert.ok(Math.abs(live.value().rmssd-batchRMSSD(values))<1e-9);
 assert.ok(Math.abs(live.value().ratio-batchRatio(values))<1e-12);
});
class Characteristic extends EventTarget {
 async startNotifications() { return this; }
 send(bytes) { this.value = packet(...bytes); this.dispatchEvent(new Event('characteristicvaluechanged')); }
}
const measurement = new Characteristic();
const device = new EventTarget();
device.name = 'Test H10';
device.gatt = {
 connected: false,
 async connect() { this.connected = true; return this; },
 disconnect() { this.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); },
 async getPrimaryService(name) {
  if (name === 'battery_service') throw new Error('optional service missing');
  assert.equal(name,'heart_rate');
  return { async getCharacteristic(name) { assert.equal(name,'heart_rate_measurement'); return measurement; } };
 }
};
let received = 0, battery = 0;
h10.events.addEventListener('measurement',()=>received++);
h10.events.addEventListener('battery',e=>{assert.equal(e.detail,null); battery++;});
context.navigator.bluetooth = {async requestDevice(options) {
 assert.equal(JSON.stringify(options),JSON.stringify({filters:[{services:['heart_rate']}],optionalServices:['battery_service']}));
 return device;
}};
(async()=>{
 await h10.connect(); assert.equal(h10.state,'connected'); assert.equal(battery,1);
 measurement.send([0,70]); assert.equal(received,1);
 h10.disconnect(); assert.equal(h10.state,'disconnected');
 measurement.send([0,70]); assert.equal(received,1);
 await h10.connect(); measurement.send([0,80]); assert.equal(received,2);
 device.gatt.disconnect(); assert.equal(h10.state,'disconnected');
 measurement.send([0,80]); assert.equal(received,2);
 console.log('PASS BLE connect, optional battery failure, disconnect, reconnect listener cleanup'); count++;
 context.navigator.bluetooth.requestDevice = async()=>{ const e = new Error();e.name='NotFoundError';throw e; };
 await h10.connect(); assert.equal(h10.state,'disconnected');
 console.log('PASS cancelled device selection resets state');count++;
 console.log(`${count} tests passed`);
})().catch(e=>{ console.error(e);process.exitCode=1; });
