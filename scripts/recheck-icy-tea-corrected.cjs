const fs = require('node:fs');
const root = 'public/reports/icy-tea';
const original = JSON.parse(fs.readFileSync(`${root}/audit.json`, 'utf8'));
const refs = JSON.parse(fs.readFileSync(`${root}/corrected-references.json`, 'utf8'));
const path = `${root}/corrected-check.json`;
const output = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : { scope: '22 remaining files with corrected visual transcription; independent EITHER and WICK branches across 15m, 30m, 1h, 1d. Approximate window matches, not exact reproductions.', results: [] };
const jobs = refs.flatMap(ref => ['15m','30m','1h','1d'].filter(tf => ({'1m':1,'2m':2,'3m':3,'5m':5}[ref.tf2] < {'15m':15,'30m':30,'1h':60,'1d':1440}[tf])).flatMap(tf1 => ['EITHER','WICK'].map(confirmation => ({ref,tf1,confirmation}))));
let next = 0;
const minute = s => Number(s.slice(0,2))*60+Number(s.slice(3));
async function worker() {
  while (next < jobs.length) {
    const {ref,tf1,confirmation} = jobs[next++];
    const key = `${ref.index}:${ref.date}:${tf1}:${confirmation}`;
    if (output.results.some(r => r.key === key && !r.error)) continue;
    try {
      const response = await fetch('http://localhost:3000/api/market-structure-shift', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({symbol:ref.symbol==='GBPUSD'?'^GBPUSD':ref.symbol,tf1,tf2:ref.tf2,start:ref.date,end:ref.date,confirmation,arrayScope:'EXISTING',htfKinds:['OB','BREAKER','FVG','IFVG','BPR','BSL','SSL','SWINGS','PDH','PDL'],ltfKinds:['OB','BREAKER','FVG','IFVG','BPR']}) });
      const d = await response.json();
      if (!d.success) throw Error(d.error);
      const lo=minute(ref.entryWindow[0]), hi=minute(ref.entryWindow[1]);
      const inWindow = t => d.lower.some(b=>b.t===t && b.day===ref.date && b.minute>=lo && b.minute<=hi);
      const matches = d.investigations.flatMap(i=>i.mss?.direction===ref.direction ? i.arrays.filter(a=>a.entry && inWindow(a.entry.at) && (!ref.priceBand || (a.entry.price>=ref.priceBand[0] && a.entry.price<=ref.priceBand[1]))).map(a=>({htf:i.htf,touch:i.touch,shift:i.mss,zone:a.zone,entry:{at:a.entry.at,price:a.entry.price,knownAt:a.entry.knownAt}})) : []);
      const events = d.events.filter(e=>e.direction===ref.direction && e.knownAt<=Math.max(...d.lower.filter(b=>b.day===ref.date&&b.minute<=hi).map(b=>b.knownAt)));
      const nearby = d.lowerZones.filter(z=>z.direction===ref.direction && z.kind===ref.entryKind && d.lower.some(b=>b.t===z.origin&&b.day===ref.date&&b.minute>=lo-60&&b.minute<=hi));
      const contexts = d.investigations.filter(i=>i.mss?.direction===ref.direction && events.some(e=>e.id===i.mss.id));
      const result = {key,index:ref.index,date:ref.date,referenceKind:ref.entryKind,referenceNote:ref.note,entryWindow:ref.entryWindow,priceBand:ref.priceBand,tf1,tf2:ref.tf2,confirmation,matches,contextStates:contexts.reduce((o,i)=>(o[i.state]=(o[i.state]??0)+1,o),{}),nearbyArrays:nearby,precedingEvents:events.slice(-12),earlyRetests:contexts.flatMap(i=>i.arrays.filter(a=>a.firstRetestBeforeConfirmation&&inWindow(a.firstRetestBeforeConfirmation)).map(a=>({shift:i.mss,zone:a.zone,earlyAt:a.firstRetestBeforeConfirmation,entryAt:a.entry?.at}))),timings:d.timings};
      output.results=output.results.filter(r=>r.key!==key); output.results.push(result);
      console.log(key, matches.length?'MATCH '+matches.length:'NO MATCH');
    } catch(e) { output.results.push({key,index:ref.index,tf1,confirmation,error:String(e)});console.log(key,String(e)); }
    output.completed=output.results.length; output.total=jobs.length;
    fs.writeFileSync(path,JSON.stringify(output,null,2));
  }
}
Promise.all([worker(),worker(),worker(),worker()]).catch(e=>{console.error(e);process.exitCode=1;});
