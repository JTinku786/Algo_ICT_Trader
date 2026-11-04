// Actual simple-form policy; no source-specific detector overrides.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function load(path){const m={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,m);return m.exports;}
const {defaultScalpingSettings,defaultScalpingSelection}=load('src/lib/scalping-labs.ts');
const {decodeScalpingResponse}=load('src/lib/scalping-wire.ts');
async function scan(overrides={}){const response=await fetch('http://localhost:3000/api/scalping-labs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...defaultScalpingSelection,symbol:'^USDJPY',tf1:'1h',tf2:'10m',start:'2026-04-14',end:'2026-04-14',confirmation:'CISD',scalping:{...defaultScalpingSettings,tickSize:.001},...overrides})});const result=decodeScalpingResponse(await response.json());assert.equal(response.status,200,result.error);return result;}
const shift=Date.parse('2026-04-14T07:00Z'),at=Date.parse('2026-04-14T08:20Z');
function matches(x){return x.investigations.flatMap(i=>i.arrays.filter(a=>i.mss?.direction==='SELL'&&i.mss.at===shift&&a.entry?.at===at&&a.zone.raw?.source==='consecutive_displacement_fvg_union').map(a=>({i,a})));}
(async()=>{
 assert(defaultScalpingSelection.confirmation.split(',').includes('CISD'));
 const x=await scan(),rows=matches(x);assert(rows.length>0,'Simple form must capture the pictured displacement retrace');
 for(const {i,a} of rows){const e=a.entry;assert(Math.abs(e.price-159.1645)<1e-8);assert(Math.abs(e.plan.stop-159.286)<1e-8);assert.equal(i.mss.formationStart,Date.parse('2026-04-14T06:20Z'));assert.equal(a.zone.knownAt,Date.parse('2026-04-14T07:20Z'));assert(e.candle.l<=e.price&&e.price<=e.candle.h);assert(e.strategy_json.knownAt<=at);assert(e.plan.targetSource.knownAt<=at);assert(e.plan.sweepSources.length>0);assert.equal(a.zone.raw.sourceIds.length,3);}
 assert.equal(matches(await scan({ltfKinds:['OB']})).length,0,'Unchecking FVG must remove the FVG setup');
 const first=x.investigations.flatMap(i=>i.arrays.filter(a=>a.entry?.at===at&&a.zone.raw?.source==='consecutive_displacement_fvg_union'&&Math.abs(a.entry.price-159.1645)<1e-8).map(a=>({i,a})))[0];assert.equal(first.i.mss.at,shift,'Table representative must use latest causal shift, not stale warmup story');
 const representative=rows.find(r=>r.i.htf.kind==='IFVG'&&r.i.touch.t===Date.parse('2026-04-14T06:10Z'))||rows[0];
 fs.writeFileSync('public/reports/scalping-labs/usdjpy-april14-validation.json',JSON.stringify({verifiedAt:new Date().toISOString(),source:41,selection:x.selection,sourceClockOffsetHours:-4,checkpoints:{sweepAt:representative.i.mss.formationStart,shiftAt:shift,shiftKnownAt:representative.i.mss.knownAt,arrayKnownAt:representative.a.zone.knownAt,entryAt:at},entry:representative.a.entry.price,entryKnownAt:representative.a.entry.knownAt,stop:representative.a.entry.plan.stop,target:representative.a.entry.plan.target,contextId:representative.i.id,zoneId:representative.a.zone.id,checks:['complete 10m rollup','three causal displacement gaps','local reversal stop','known target','checkbox exclusion'],limits:'Screenshot target is a farther HTF rejection block; default plan retains nearest confirmed liquidity, not an invented exact screenshot target.'},null,2));
 console.log('PASS USDJPY April 14: sweep -> CISD -> combined FVG -> 04:20 NY retrace; checkbox exclusion');
})().catch(e=>{console.error(e);process.exitCode=1;});
