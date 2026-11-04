const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const r=await fetch('http://localhost:3000/api/market-structure-shift',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:'EURUSD',tf1:'1h',tf2:'1m',start:'2026-09-01',end:'2026-09-01',confirmation:'WICK',htfKinds:['OB','BREAKER','FVG','IFVG','BSL','SSL','PDH','PDL'],ltfKinds:['OB','BREAKER','FVG','IFVG']})});
 const d=await r.json();assert.equal(r.status,200,d.error);
 const shiftAt=Date.parse('2026-09-01T07:11:00Z');
 const story=d.investigations.find(i=>i.mss?.at===shiftAt&&i.mss.direction==='SELL');assert(story,'Completed-prefix bearish wick CHOCH must exist at 03:11');
 assert.equal(story.mss.knownAt,Date.parse('2026-09-01T07:15:00Z'),'No backdating: fourth swing confirms at 03:15');
 const gap=story.arrays.find(a=>a.zone.kind==='FVG'&&a.zone.origin===Date.parse('2026-09-01T07:05:00Z'));
 assert(gap?.entry,'03:05 FVG must have a later retest');assert.equal(gap.entry.at,Date.parse('2026-09-01T07:15:00Z'));
 for(const i of d.investigations)for(const a of i.arrays)if(a.entry)assert(a.entry.at>=i.mss.knownAt&&a.entry.at>=a.zone.knownAt);
 fs.writeFileSync('public/reports/mss-wick-entry-evidence.json',JSON.stringify({selection:d.selection,story},null,2));
 console.log('PASS: bearish wick CHOCH 03:11 / known 03:15 → FVG retest entry 03:15, causal HTF context',story.htf.kind,gap.entry.price);
})().catch(e=>{console.error(e);process.exitCode=1;});
