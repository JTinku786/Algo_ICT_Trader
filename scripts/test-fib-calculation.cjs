const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const m={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/fib-calculation.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,m);const f=m.exports;
assert.equal(f.fibTickPrice((159.285+158.952)/2,3),159.119);assert.equal(f.fibTickPrice((1.18016+1.17789)/2,5),1.17903);
const pivot=(price,t,kind)=>({id:String(t),price,t,knownAt:t+5,index:t,kind});
const up=[pivot(87,1,'SL'),pivot(95,2,'SH')],down=[pivot(95,1,'SH'),pivot(87,2,'SL')];
let a=f.retracementAnchors(up);assert.equal(f.fibPrice(a,0),95);assert.equal(f.fibPrice(a,.5),91);assert.equal(f.fibPrice(a,1),87);
a=f.retracementAnchors(down);assert.equal(f.fibPrice(a,0),87);assert.equal(f.fibPrice(a,.5),91);assert.equal(f.fibPrice(a,1),95);
a=f.retracementAnchors(up,true);assert.equal(f.fibPrice(a,0),87);assert.equal(f.fibPrice(a,1),95);
a=f.manualAnchors([pivot(87,1,'SL'),pivot(95,2,'SH'),pivot(91,3,'SL')],'extension');assert.equal(f.fibPrice(a,0),91);assert.equal(f.fibPrice(a,1),99);assert(Math.abs(f.fibPrice(a,1.618)-103.944)<1e-10);assert.equal(f.fibPrice(a,1,true),83);
assert.equal(f.manualAnchors([up[1],up[0]],'retracement'),null);assert.equal(f.manualAnchors([pivot(90,1,'SH'),pivot(95,2,'SH')],'retracement'),null);
const bars=Array.from({length:16},(_,i)=>({t:i,knownAt:i+1,h:i===5?20:10,l:i===10?1:5,o:7,c:8}));
assert.equal(f.fibPivots(bars.slice(0,10),10).some(p=>p.t===5),false);assert.equal(f.fibPivots(bars.slice(0,11),10).find(p=>p.t===5&&p.kind==='SH').knownAt,11);
const earlier=f.fibPivots(bars.slice(0,11),10).filter(p=>p.knownAt<=11);const full=f.fibPivots(bars,10).filter(p=>p.knownAt<=11);assert.equal(JSON.stringify(earlier),JSON.stringify(full));
const atr=f.atr10(Array.from({length:12},(_,i)=>({t:i,knownAt:i+1,h:12,l:8,o:10,c:10})));assert.equal(atr[8],null);assert.equal(atr[9],4);assert.equal(atr[11],4);
// Outside bars: H and L must see the same pre-candle extension state.
const outside=[3,10,4,3,4,20,4].map((h,i)=>({t:i+1,knownAt:i+2,h,l:[2,2,1,0,1,-5,1][i],o:2,c:2}));
const ep=f.extensionPivots(outside,2);assert.equal(ep.highs.at(-1).price,20);assert.equal(ep.lows.at(-1).price,-5);
const sameBar=f.retracementAnchors([pivot(20,5,'SH'),pivot(-5,5,'SL')]);assert(sameBar);assert.equal(f.fibPrice(sameBar,.5),7.5);
// Audited Daily source snapshots: arithmetic and confirmation timing for every reported ticker.
for(const name of ['AAPL','CHFJPY','GBPJPY','ASIANPAINT_NS','BAJAJFINSV_NS','CIPLA_NS','ETERNAL_NS','INDUSINDBK_NS']){
 const data=JSON.parse(fs.readFileSync(`public/reports/fib-calculation/${name}-daily.json`,'utf8'));
 for(const plan of [f.retracementAnchors(f.zigzagPivots(data.bars,10,3)),f.extensionAnchors(data.bars,10)]){
  assert(plan,`${name}: automatic anchors`);assert(plan.points.every(p=>p.knownAt<=data.bars.at(-1).knownAt));
  assert(Number.isFinite(f.fibPrice(plan,.5)));assert(Math.abs(f.fibPrice(plan,.5)-(plan.base+plan.height*.5))<1e-8);
 }
}
const apple=JSON.parse(fs.readFileSync('public/reports/fib-calculation/AAPL-daily.json','utf8')).bars;
assert.equal(f.retracementAnchors(f.zigzagPivots(apple,10,3)).points.at(-1).kind,'SH');
assert.equal(f.retracementAnchors(f.zigzagPivots(apple,10,2.9)).points.at(-1).kind,'SL');
console.log('PASS Daily: all eight reported tickers, anchor clocks, levels, AAPL deviation boundary, dual-pivot candle handling');
console.log('PASS Fib: bullish/bearish/reverse retracement, ABC extension, manual ordering, right-bar availability, append-future pivots, ATR seed');
(async()=>{for(const tf of ['10m','1h','1m']){const r=await fetch(`http://localhost:3000/api/fib-calculation?symbol=EURUSD&tf=${tf}&from=2026-04-13&through=2026-04-14`);const x=await r.json();assert.equal(r.status,200,x.error);assert(x.bars.length>0);for(let i=1;i<x.bars.length;i++)assert(x.bars[i].t>x.bars[i-1].t);const zz=f.zigzagPivots(x.bars,10,3),retr=f.retracementAnchors(zz),ext=f.extensionAnchors(x.bars,10);assert(retr&&ext,'Actual candle fixture must exercise both auto studies');for(const plan of [retr,ext])for(const p of plan.points)assert(p.knownAt<=x.bars.at(-1).knownAt);const [pa,pb,pc]=ext.points;assert.equal(f.fibPrice(ext,0),pc.price);assert(Math.abs(f.fibPrice(ext,1)-(pc.price+pb.price-pa.price))<1e-10);console.log('PASS API',tf,x.bars.length,'candles, auto anchors and clocks');}})().catch(e=>{console.error(e);process.exitCode=1;});
