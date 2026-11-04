const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
(async()=>{
 const body={symbol:'EURUSD',tf1:'1h',tf2:'1m',start:'2026-09-01',end:'2026-09-01',htfKinds:['OB','BREAKER','FVG','IFVG','BSL','SSL','PDH','PDL'],ltfKinds:['OB','BREAKER','FVG','IFVG']};
 const run=async confirmation=>{const r=await fetch('http://localhost:3000/api/market-structure-shift',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,...(confirmation?{confirmation}:{})})});const d=await r.json();assert.equal(r.status,200,d.error);return d;};
 const native=await run();assert.equal(native.confirmation,'CHOCH');assert(native.investigations.filter(i=>i.mss).every(i=>i.mss.label==='CHOCH'));
 const withoutDiagnostic=rows=>rows.map(i=>({...i,arrays:i.arrays.map(({firstRetestBeforeConfirmation,...a})=>a)}));
 // Snapshot of the 29 native investigations before adding CISD (2026-10-03 stored feed).
 assert.equal(crypto.createHash('sha256').update(JSON.stringify(withoutDiagnostic(native.investigations))).digest('hex'),'df69143755f3809918bec14ac8c5f0636e1f01625d8839f7712050c07d8bf075','Default CHOCH results must stay unchanged; changed source candles require review');
 const both=await run('EITHER');assert(both.investigations.some(i=>i.mss?.label==='CISD'));
 for(const i of both.investigations)for(const a of i.arrays)if(a.entry)assert(a.entry.at>=i.mss.knownAt&&a.entry.at>=a.zone.knownAt,'No entry before completed confirmation or array activation');
 const early=Date.parse('2026-09-01T07:09:00Z');
 assert(native.investigations.some(i=>i.arrays.some(a=>a.firstRetestBeforeConfirmation===early)),'Expose the actual excluded 03:09 touch');
 const summary={selection:both.selection,nativeInvestigations:native.investigations.length,combinedInvestigations:both.investigations.length,earlyRetestAt:early,earlyStories:both.investigations.filter(i=>i.arrays.some(a=>a.firstRetestBeforeConfirmation===early)).map(i=>({htf:i.htf.id,shift:i.mss,arrays:i.arrays.map(a=>({kind:a.zone.kind,origin:a.zone.origin,knownAt:a.zone.knownAt,earlyRetest:a.firstRetestBeforeConfirmation,entry:a.entry?.at}))}))};
 fs.writeFileSync('public/reports/mss-september-confirmation.json',JSON.stringify(summary,null,2));
 console.log('PASS: unchanged default CHOCH, optional CISD, causal entries, actual 03:09 rejection evidence',JSON.stringify({native:native.investigations.length,combined:both.investigations.length}));
})().catch(e=>{console.error(e);process.exitCode=1;});
