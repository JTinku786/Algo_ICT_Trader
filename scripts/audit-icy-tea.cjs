const fs = require('node:fs');
const root = 'public/reports/icy-tea';
const refs = JSON.parse(fs.readFileSync(`${root}/references.json`, 'utf8'));
const prior = fs.existsSync(`${root}/audit.json`) ? JSON.parse(fs.readFileSync(`${root}/audit.json`, 'utf8')).results : [];
const results = [], cache = new Map();
const minute = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
async function auditRef(ref) {
    const previous = prior.find(r => r.index === ref.index);
    if (!process.env.AUDIT_RECHECK && previous && previous.status !== 'DATA_OR_ANALYSIS_ERROR') { results.push(previous); return; }
    let result = { ...ref };
    if (!ref.date) result.status = 'DATE_NOT_SHOWN';
    else if (ref.symbol === 'NQ') result.status = 'NQ_SOURCE_NOT_MAPPED';
    else {
      const tf1 = ref.tf1 ?? '1h';
      const key = [ref.symbol, ref.date, tf1, ref.tf2, ref.entryKind].join(':');
      let d = cache.get(key);
      if (!d) {
        const body = { symbol: ref.symbol === 'GBPUSD' ? '^GBPUSD' : ref.symbol, tf1, tf2: ref.tf2, start: ref.date, end: ref.date,
          confirmation: 'EITHER', arrayScope: 'EXISTING',
          htfKinds: ['OB','BREAKER','FVG','IFVG','BPR','BSL','SSL','SWINGS','PDH','PDL'],
          ltfKinds: [ref.entryKind] };
        const response = await fetch('http://localhost:3000/api/market-structure-shift', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        d = await response.json();
        cache.set(key, d);
        fs.writeFileSync(`${root}/evidence-${key.replaceAll(':','-')}.json`, JSON.stringify(Object.fromEntries(['success','error','selection','instrument','aggregation','audit','provenance','timings','rules','higher','lower','daily','events'].filter(k=>k in d).map(k=>[k,d[k]]))));
      }
      result.testedTF1 = tf1;
      result.htfAssumed = !ref.tf1;
      if (!d.success) { result.status = 'DATA_OR_ANALYSIS_ERROR'; result.error = d.error; }
      else {
        const start = minute(ref.entryWindow[0]), end = minute(ref.entryWindow[1]);
        const bars = d.lower.filter(b => b.day === ref.date && b.minute >= start && b.minute <= end);
        const matches = d.investigations.flatMap(i => i.arrays.filter(a =>
          a.entry && i.mss.direction === ref.direction && a.zone.kind === ref.entryKind &&
          a.entry.candle.day === ref.date && a.entry.candle.minute >= start && a.entry.candle.minute <= end
        ).map(a => ({ context: i.id, htf: i.htf, touch:i.touch, shift: i.mss, zone: a.zone, entry: {...a.entry, plan:a.entry.plan ? Object.fromEntries(['state','entry','stop','stopAt','target','targetSource','rr','knownAt'].map(k=>[k,a.entry.plan[k]])) : undefined} })));
        result.status = matches.length ? 'CANDIDATE_IN_VISUAL_WINDOW' : 'NO_ENTRY_IN_VISUAL_WINDOW';
        result.matches = matches;
        result.candleCount = d.lower.length;
        result.windowCandles = bars;
        result.shiftsInWindow = d.events.filter(e => e.direction === ref.direction &&
          d.lower.some(b => b.t === e.at && b.minute >= start && b.minute <= end));
        result.arraysInWindow = d.lowerZones.filter(z => z.direction === ref.direction && z.kind === ref.entryKind &&
          d.lower.some(b => b.t === z.origin && b.minute >= start - 30 && b.minute <= end));
        result.aggregation = d.aggregation;
        result.exactMatchVerified = false;
      }
    }
    results.push(result);
    fs.writeFileSync(`${root}/audit.json`, JSON.stringify({
      caveat: 'Candidates are time/direction/array matches only. Image omits year; unspecified HTF tested as 1h. Approximate visually transcribed entry windows require candle/price confirmation. No candidate is certified an exact reproduced trade.',
      completed: results.length, total: refs.length, results: [...results].sort((a,b)=>a.index-b.index) }, null, 2));
    console.log(`${ref.index}: ${result.status}${result.matches ? ` (${result.matches.length} contexts)` : ''}`);
}
async function main() {
  let next = 0;
  const worker = async () => { while(next < refs.length) await auditRef(refs[next++]); };
  await Promise.all([worker(), worker(), worker(), worker()]);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
