const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function load(path){const m={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,m);return m.exports;}
const {defaultScalpingSettings,defaultScalpingSelection}=load('src/lib/scalping-labs.ts'),{decodeScalpingResponse}=load('src/lib/scalping-wire.ts');
async function scan(htfKinds,ltfKinds){const response=await fetch('http://localhost:3000/api/scalping-labs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...defaultScalpingSelection,symbol:'EURUSD',tf1:'1h',tf2:'5m',start:'2026-01-29',end:'2026-01-29',confirmation:'CISD',htfKinds,ltfKinds,scalping:defaultScalpingSettings})});const x=decodeScalpingResponse(await response.json());assert.equal(response.status,200,x.error);return x;}
(async()=>{
 const base=await scan(['FVG','OB'],['FVG','OB']),filtered=await scan(['FVG','OB','VALID_FVG'],['FVG','OB','VALID_FVG']);
 const entries=x=>x.investigations.flatMap(i=>i.arrays.filter(a=>a.entry).map(a=>({i,a,e:a.entry})));
 const original=new Set(entries(base).map(({i,a,e})=>`${i.id}:${a.zone.id}:${e.at}`));
 let checked=0,held=0;for(const {i,a,e} of entries(filtered)){
  assert(original.has(`${i.id}:${a.zone.id}:${e.at}`),'Qualification must filter existing signals, not invent entries');
  for(const tf of ['TF1','TF2']){const level=tf==='TF1'?i.htf:a.zone;if(level.kind!=='FVG')continue;checked++;const c=e.checklist.checks.find(c=>c.id==='VALID_FVG_'+tf);assert.equal(c.verdict,'PASS');const p=c.evidence,r=p.range;assert.equal(r.state,'ACTIVE');assert(r.knownAt<=e.at&&p.at<=e.at);assert(p.midpoint>=r.low&&p.midpoint<=r.high);assert(level.direction==='BUY'?p.midpoint<=r.equilibrium:p.midpoint>=r.equilibrium);assert(e.strategy_json.knownAt>=r.knownAt);assert(e.strategy_json.validFvg[c.id]);}
 }
 for(const i of filtered.investigations)for(const a of i.arrays)if(a.rejectedEntry?.checklist.blockers.some(b=>b.startsWith('VALID_FVG')))held++;
 assert(checked>0,'Real fixture must exercise qualifying FVGs');assert(held>0,'Fixture must reject wrong-half or unavailable ranges');
 const alone=await scan(['VALID_FVG'],['VALID_FVG']);assert(alone.investigations.every(i=>i.htf.kind==='FVG'));assert(entries(alone).every(({a})=>a.zone.kind==='FVG'));
 fs.writeFileSync('public/reports/scalping-labs/valid-fvg-validation.json',JSON.stringify({at:new Date().toISOString(),baseline:entries(base).length,qualified:entries(filtered).length,checked,held,validFvgAlone:entries(alone).length},null,2));console.log('PASS Valid FVG: both timeframe checks, causal range evidence, rejected candidates, standalone selection, baseline subset', {checked,held});
})().catch(e=>{console.error(e);process.exitCode=1;});
