const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const body={symbol:'EURUSD',tf1:'1h',tf2:'1m',start:'2026-08-05',end:'2026-08-05',confirmation:'EITHER',htfKinds:['OB','BREAKER','FVG','IFVG','BSL','SSL','PDH','PDL'],ltfKinds:['OB','BREAKER','FVG','IFVG']};
 const run=async arrayScope=>{const r=await fetch('http://localhost:3000/api/market-structure-shift',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,arrayScope})});const d=await r.json();assert.equal(r.status,200,d.error);return d;};
 const expanded=await run('EXISTING'),strict=await run('FORMATION');
 const t=s=>Date.parse('2026-08-05T'+s+'Z');
 const match=d=>d.investigations.filter(i=>i.mss?.label==='CISD'&&i.mss.at===t('17:15:00')).flatMap(i=>i.arrays.map(a=>({i,a}))).find(({a})=>a.zone.kind==='FVG'&&a.zone.origin===t('17:14:00'));
 const found=match(expanded);assert(found?.a.entry);assert.equal(found.a.zone.knownAt,t('17:17:00'));assert.equal(found.a.entry.at,t('17:17:00'));assert(!match(strict),'Strict formation mode retains its previous exclusion');
 assert(expanded.investigations.some(i=>i.arrays.some(a=>a.zone.origin<i.mss.formationStart&&a.entry)),'Existing pre-shift arrays included');
 for(const i of expanded.investigations)for(const a of i.arrays)if(a.entry){assert(a.entry.at>=a.zone.knownAt&&a.entry.at>=i.mss.knownAt);assert(!a.zone.retiredAt||a.entry.at<a.zone.retiredAt);assert(a.zone.origin<=i.mss.at);}
 fs.writeFileSync('public/reports/mss-existing-arrays-evidence.json',JSON.stringify({selection:expanded.selection,shift:found.i.mss,htf:found.i.htf,array:found.a},null,2));
 console.log('PASS: August 5 CISD → bullish FVG entry 13:17, existing arrays, causal activation, invalidation, strict option');
})().catch(e=>{console.error(e);process.exitCode=1;});
