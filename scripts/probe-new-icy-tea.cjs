const fs=require('node:fs');
const root='public/reports/icy-tea/intake';
const refs=JSON.parse(fs.readFileSync(`${root}/dated-reference-probes.json`,'utf8'));
const path=`${root}/dated-reference-results.json`;
const output=fs.existsSync(path)?JSON.parse(fs.readFileSync(path,'utf8')):{scope:'Approximate visual windows; printed day/month with inferred publication year where flagged. Default close CHOCH or explicitly drawn CISD only. Candidate matches are not exact trade certifications.',results:[]};
let next=0;
async function worker(){while(next<refs.length){const ref=refs[next++];if(output.results.some(r=>r.sourceId===ref.sourceId))continue;let row={...ref};
 if(['NQ','ES'].includes(ref.symbol))row.status='FUTURES_CONTRACT_NOT_MAPPED';
 else try{const r=await fetch('http://localhost:3000/api/market-structure-shift',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(ref.selection)});const d=await r.json();if(!r.ok){row.status='DATA_OR_ANALYSIS_UNAVAILABLE';row.error=d.error;}else{const [lo,hi]=ref.selection.entryWindowMinutes;row.matches=d.investigations.flatMap(i=>i.mss?.direction===ref.direction?i.arrays.filter(a=>a.entry&&a.entry.candle.day===ref.candidateDate&&a.entry.candle.minute>=lo&&a.entry.candle.minute<=hi).map(a=>({contextId:i.id,htf:i.htf,touch:i.touch,shift:i.mss,zone:a.zone,entry:a.entry})):[]);row.status=row.matches.length?'NATIVE_CANDIDATE_IN_APPROXIMATE_WINDOW':'NO_NATIVE_ENTRY_IN_WINDOW';row.candles=d.lower.length;row.sources=d.audit;row.selection=d.selection;}}
 catch(e){row.status='REQUEST_FAILED';row.error=String(e);}
 output.results.push(row);output.completed=output.results.length;output.total=refs.length;fs.writeFileSync(path,JSON.stringify(output,null,2));console.log(ref.newIndex,row.status,row.matches?.length??'');
}}
Promise.all([worker(),worker()]).catch(e=>{console.error(e);process.exitCode=1;});
