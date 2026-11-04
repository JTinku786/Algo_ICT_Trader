// Read-only reference reconciliation. Successful detection is a candidate match,
// never an exact verified match without the source's entry time / price / timezone.
const fs=require('node:fs');
const vm=require('node:vm'),ts=require('typescript');
const decoder={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/scalping-wire.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,decoder);
const decode=decoder.exports.decodeScalpingResponse;
const policy={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/scalping-labs.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,policy);
const {defaultScalpingSettings,defaultScalpingSelection}=policy.exports;
const sources=JSON.parse(fs.readFileSync('public/reports/scalping-labs/sources.json','utf8'));
const destination='public/reports/scalping-labs/coverage.json';
const previous=fs.existsSync(destination)?JSON.parse(fs.readFileSync(destination,'utf8')).references:[];
const references=sources.map(s=>previous.find(r=>r.id===s.id)??{id:s.id,canonicalId:s.canonicalId,status:s.duplicateOf?'DUPLICATE_ALIAS':!['TRADE','VIDEO_TRADE'].includes(s.kind)?'CONTEXT_OR_EXCLUDED':s.ticker==='Unknown'||!/^\d{4}-\d{2}-\d{2}$/.test(s.chartDate)?'METADATA_UNKNOWN':'PENDING_CANDLE_AUDIT'});
const save=()=>fs.writeFileSync(destination,JSON.stringify({version:'scalping-labs-v1',updatedAt:new Date().toISOString(),semantics:'Candidates on the stated date / direction / timeframe; exact entry clock, price and timezone unverified.',references},null,2));
save();
async function audit(s){
 const record=references.find(r=>r.id===s.id);if(record.status!=='PENDING_CANDLE_AUDIT')return;
 const tf2=['1m','2m','3m','5m','10m','15m','30m','1h'].includes(s.timeframe)?s.timeframe:'5m';
 record.timeframeAssumption=tf2!==s.timeframe?'Source timeframe unknown; 5m research assumption, exact reproduction unverified.':null;
 const body={...defaultScalpingSelection,symbol:`^${s.ticker}`,tf1:/\b4H\b/i.test(s.evidence)||tf2==='1h'?'4h':'1h',tf2,start:s.chartDate,end:s.chartDate,confirmation:'EITHER',candleOrderBlocks:false,scalping:{...defaultScalpingSettings,tickSize:/JPY/.test(s.ticker)?.001:/XAU/.test(s.ticker)?.01:.00001}};
 try{
  const response=await fetch('http://localhost:3000/api/scalping-labs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(150000)});const d=decode(await response.json());
  if(!response.ok){record.status=response.status===422?'DATA_MISSING':'ANALYSIS_ERROR';record.reason=d.error;}
  else{
   const candidates=d.investigations.flatMap(i=>i.arrays.filter(a=>a.entry&&i.mss.direction===s.direction).map(a=>({contextId:i.id,zoneId:a.zone.id,entryAt:a.entry.at,entryPrice:a.entry.price,plan:a.entry.plan,playbooks:a.entry.playbooks})));
   record.status=candidates.length?'CANDIDATES_FOUND':'RULE_REJECTED';record.candidateCount=new Set(candidates.map(c=>`${c.entryAt}:${c.entryPrice}`)).size;record.diagnostics=d.diagnostics;record.examples=candidates.slice(0,8);record.selection=d.selection;record.lowerCandles=d.lower.length;
  }
 }catch(e){record.status='ANALYSIS_ERROR';record.reason=e.message;}
 save();console.log(`S${s.id} ${s.ticker} ${s.chartDate}: ${record.status} (${record.candidateCount??0} candidates)`);
}
(async()=>{const eligible=sources.filter(s=>references.find(r=>r.id===s.id).status==='PENDING_CANDLE_AUDIT');let cursor=0;const worker=async()=>{while(cursor<eligible.length)await audit(eligible[cursor++]);};await Promise.all([worker(),worker()]);save();console.log(JSON.stringify(references.reduce((out,r)=>{out[r.status]=(out[r.status]??0)+1;return out;},{})));})().catch(e=>{console.error(e.message);process.exitCode=1;});
