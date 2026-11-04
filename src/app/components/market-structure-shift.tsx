"use client";







import { useEffect, useMemo, useRef, useState, useCallback } from "react";







import {decodeScalpingResponse} from "@/lib/scalping-wire";
import {developingReplayBar} from "@/lib/replay-developing";
import MssStrategyControls from "./mss-strategy-controls";



import {defaultStrategyFilters,playbooks,type StrategyFilters} from "@/lib/mss-strategy-filters";







import {riskBuckets,riskBucketLabels,planForBucket,type RiskBucket,type LiquidityTarget} from "@/lib/mss-risk-buckets";







import {paperResult,type PaperTrade} from "@/lib/paper-trading";







import type {PaperDraft} from "./paper-trading";







import WeeklyReplayChart from "./weekly-replay-chart";







import MssAnalytics, {type MssTrade} from "./mss-analytics";

import {walkOutcome,type OutcomeMode,type FutureOutcomeData} from "@/lib/mss-outcomes";







import type { IctOverlay, ReplayBar } from "@/lib/weekly-replay";







import type { ReplayInstrument } from "@/lib/replay-instruments";







import type { ReferencePoint } from "@/lib/daily-context";







import type { StrategyReplayEvent } from "@/lib/strategy-replay";







type Frame="10m"|"1m"|"2m"|"3m"|"5m"|"15m"|"30m"|"1h"|"4h"|"1d"|"1w"|"1mo";







const frames:Frame[]=["1m","2m","3m","5m","10m","15m","30m","1h","4h","1d","1w","1mo"];







const names:Record<Frame,string>={"10m":"10 Minutes","1m":"1 Minute","2m":"2 Minutes","3m":"3 Minutes","5m":"5 Minutes","15m":"15 Minutes","30m":"30 Minutes","1h":"1 Hour","4h":"4 Hours","1d":"Daily","1w":"Weekly","1mo":"Monthly"};







const labels:Record<string,string>={VALID_FVG:"Valid FVG",MITIGATION:"Mitigation candidate",PROPULSION:"Propulsion candidate",WICK:"HTF wick CE",REJECTION:"Rejection wick",GAP:"Weekly opening gap",NYOPEN:"NY midnight open",EQH:"Buyside liquidity",EQL:"Sellside liquidity",OB:"Order block",BREAKER:"Breaker block",FVG:"FVG",IFVG:"IFVG",BPR:"BPR",BSL:"Buyside liquidity",SSL:"Sellside liquidity",SWINGS:"Swing highs / lows",PDH:"Previous day high",PDL:"Previous day low"};







type Zone=IctOverlay&{retiredAt?:number|null;raw?:unknown};







type Shift={breakMode?:"wick"|"close";id:string;label:string;direction:"BUY"|"SELL";origin:number;formationStart:number;at:number;knownAt:number;level:number;raw:unknown};







type StructuralPlan={state:string;direction:"BUY"|"SELL";entry:number;stop:number;target:number|null;rr:number|null;stopAt:number;targetSource:LiquidityTarget|null;targetCandidates?:LiquidityTarget[];rule:string};







type Checklist={version:number;playbook:string;eligible:boolean;blockers:string[];checks:{id:string;step:string;required:boolean;verdict:string;evidence:unknown;source:string}[]};



type Entry={playbooks?:string[];strategy_json?:unknown;checklist?:Checklist;plan?:StructuralPlan;at:number;knownAt:number;price:number;mfe:number;mae:number;lastClose:number;candle:ReplayBar};







type Investigation={id:string;htf:Zone;touch:ReplayBar;mss:Shift|null;arrays:{zone:Zone;entry:Entry|null;rejectedEntry?:Entry;firstRetestBeforeConfirmation?:number|null}[];state:string};







type ReferencePreset={preferredEntry?:{context:string;zoneId:string;at:number;price:number};index:number;reference:{date:string;direction:string;tf2:string;note?:string};selection:{symbol:string;tf1:Frame;tf2:Frame;start:string;end:string;confirmation:string;pivotStrength:number;carryIn:boolean;candleOrderBlocks:boolean;retestMode:string;arrayScope:string;htfKinds:string[];ltfKinds:string[];entryWindowMinutes:number[]}};







type FvgDealingRange={fibBase?:number;fibHeight?:number;method?:string;state:string;tf:string;direction:"BUY"|"SELL";low:number;high:number;equilibrium:number;lowOrigin:number;highOrigin:number;knownAt:number};
function fibReference(r:FvgDealingRange,tf:string,cutoff:number,bars:ReplayBar[],fallback:string):ReferencePoint[]{return r.state!=='ACTIVE'||r.knownAt>cutoff?[]:[['0',r.fibBase??(r.direction==='BUY'?r.high:r.low)],['50%',r.equilibrium],['100%',r.fibBase!==undefined&&r.fibHeight!==undefined?r.fibBase+r.fibHeight:r.direction==='BUY'?r.low:r.high]].map(([label,price])=>({kind:`${tf} Valid FVG · Fib ${label}`,low:Number(price),high:Number(price),knownAt:r.knownAt,originDay:bars.find(b=>b.t===Math.min(r.lowOrigin,r.highOrigin))?.day??fallback,timing:'Confirmed at close',response:`${r.direction} confirmed swing range ${r.low}–${r.high}; midpoint ${r.equilibrium}`}));}
type FvgProof={valid:boolean;at:number;midpoint:number;range:FvgDealingRange|null;reason:string};
function inFvgHalf(z:Zone,r:FvgDealingRange|null|undefined){const ce=(z.low+z.high)/2;return !!r&&r.state==="ACTIVE"&&ce>=r.low&&ce<=r.high&&(z.direction==="BUY"?ce<=r.equilibrium:ce>=r.equilibrium);}
export type MssResult={validFvgAudit?:Record<string,Record<string,number>>;fvgRanges?:{tf1:{at:number;buy:FvgDealingRange|null;sell:FvgDealingRange|null}[]};confirmationRule?:string;provider:string;version:string;rules:string;selection:{symbol:string;tf1:Frame;tf2:Frame;start:string;end:string;arrayScope?:string;confirmation?:string;pivotStrength?:number;carryIn?:boolean;candleOrderBlocks?:boolean;retestMode?:string;htfKinds?:string[];ltfKinds?:string[];strategyFilters?:StrategyFilters|null};instrument:ReplayInstrument;higher:ReplayBar[];lower:ReplayBar[];daily:ReplayBar[];higherZones:Zone[];investigations:Investigation[];audit:unknown;provenance:string};







type Result=MssResult;



export type MssFocus={contextId:string;zoneId:string;entryAt:number;knownAt:number;rrBucket?:RiskBucket;stop?:number;target?:number};







const control="rounded border border-white/15 bg-slate-900 px-3 py-2 text-sm";







const noop=()=>{};







function shiftName(s:Shift){if(s.label==="IFVG_FAILURE")return "FVG failure · close confirmed";return s.label==='LOCAL_SHIFT'?`Local swing break · ${s.breakMode??'close'}`:s.label==='CISD'?'CISD candidate':s.breakMode==='wick'?'CHOCH · wick break':'CHOCH · close break';}



function arrayKey(a:Investigation["arrays"][number]){return `${a.zone.id}:${a.entry?.at??a.rejectedEntry?.at??"none"}`;}



function firstEntry(item:Investigation|undefined){return item?.arrays.flatMap(a=>a.entry?[a.entry]:[]).sort((a,b)=>a.at-b.at)[0];}







function focusTime(d:Result,item:Investigation|undefined){if(!item)return null;const stamp=firstEntry(item)?.knownAt??item.arrays.find(a=>a.rejectedEntry)?.rejectedEntry?.knownAt??item.mss?.knownAt??item.touch.knownAt;return d.lower.find(b=>b.knownAt>=stamp)?.knownAt??d.lower.at(-1)?.knownAt??null;}







const confirmationOptions:[string,string][]=[["CHOCH","SMC CHOCH · close break"],["WICK","SMC CHOCH · wick break"],["CISD","CISD candidate"],["EITHER","CHOCH or CISD candidate"],["LOCAL","Local swing · close break"],["LOCAL_WICK","Local swing · wick break"]];



const defaultConfirmations="CHOCH,WICK,CISD,EITHER";







/** One API run per selected confirmation; candles are identical, investigations are merged.



    Wick-break CHOCH shares event ids with close-break CHOCH, so its contexts get a "|wick" suffix;



    exact duplicates (e.g. CHOCH inside "CHOCH or CISD") are kept once. */



function mergeConfirmations(parts:Result[],confs:string[]):Result{



 const seen=new Set<string>(),investigations:Investigation[]=[];



 for(const part of parts)for(const inv of part.investigations){const id=inv.mss?.breakMode==="wick"&&!inv.id.endsWith("|wick")?`${inv.id}|wick`:inv.id;if(seen.has(id))continue;seen.add(id);investigations.push(id===inv.id?inv:{...inv,id});}



 investigations.sort((a,b)=>parts[0].version?.startsWith('scalping-labs')
  ? (b.mss?.knownAt??0)-(a.mss?.knownAt??0)||b.touch.t-a.touch.t
  : a.touch.t-b.touch.t);



 const first=parts[0];



 const validFvgAudit:Record<string,Record<string,number>>={};
 for(const part of parts)for(const [tf,reasons] of Object.entries(part.validFvgAudit??{}))for(const [reason,count] of Object.entries(reasons)){validFvgAudit[tf]??={};validFvgAudit[tf][reason]=(validFvgAudit[tf][reason]??0)+count;}
 return {...first,...(first.validFvgAudit?{validFvgAudit}:{}),investigations,confirmationRule:[...new Set(parts.map(p=>p.confirmationRule).filter(Boolean))].join(" "),selection:{...first.selection,confirmation:confs.join(",")}};



}







export default function MarketStructureShift({initialData=null,initialFocus,onResult,initialSelection,autoRunOnLoad=false,variant="MSS",extraRequest={}}:{initialData?:Result|null;initialFocus?:MssFocus|null;onResult?:(result:Result)=>void;initialSelection?:Partial<Result["selection"]>;autoRunOnLoad?:boolean;variant?:"MSS"|"SCALPING_LABS";extraRequest?:Record<string,unknown>}){



 const q=initialData?.selection??initialSelection;



 const [strategyFilters,setStrategyFilters]=useState<StrategyFilters>(q?.strategyFilters??{...defaultStrategyFilters});



 function applyPlaybook(id:string){const book=playbooks.find(p=>p.id===id);if(!book)return;setStrategyFilters({...strategyFilters,playbook:book.id,required:[...book.required]});setLtfKinds([...book.arrays]);setArrayScope(book.scope);}



 const initialStory=initialData?.investigations.find(i=>i.id===initialFocus?.contextId)??initialData?.investigations[0];







 const [referencePresets,setReferencePresets]=useState<ReferencePreset[]>([]),[referenceCase,setReferenceCase]=useState("");



 const [catalog,setCatalog]=useState<ReplayInstrument[]>([]),[symbol,setSymbol]=useState(q?.symbol??"AAPL");







 const [confirmation,setConfirmation]=useState(q?.confirmation??defaultConfirmations);



 const [arrayScope,setArrayScope]=useState(q?.arrayScope??"EXISTING");



 const [candleOrderBlocks,setCandleOrderBlocks]=useState(q?.candleOrderBlocks??false);



 const [retestMode,setRetestMode]=useState(q?.retestMode??"FIRST");



 const [pivotStrength,setPivotStrength]=useState(q?.pivotStrength??3),[carryIn,setCarryIn]=useState(q?.carryIn??false);



 const [tf1,setTF1]=useState<Frame>(q?.tf1??"1d"),[tf2,setTF2]=useState<Frame>(q?.tf2??"5m");







 const [start,setStart]=useState(q?.start??"2026-01-16"),[end,setEnd]=useState(q?.end??"2026-01-23");







 const [htfKinds,setHtfKinds]=useState(q?.htfKinds??["OB","BREAKER","FVG","IFVG","BPR","BSL","SSL","PDH","PDL"]),[ltfKinds,setLtfKinds]=useState(q?.ltfKinds??["OB","BREAKER","FVG","IFVG","BPR"]);







 const [data,setData]=useState<Result|null>(initialData),[loading,setLoading]=useState(false),[error,setError]=useState("");







 const [selected,setSelected]=useState(initialStory?.id??""),[at,setAt]=useState<number|null>(initialFocus?.knownAt??(initialData?focusTime(initialData,initialStory):null)),[playing,setPlaying]=useState(false),[page,setPage]=useState(0),[state,setState]=useState("ALL");







 const [entrySort,setEntrySort]=useState<"asc"|"desc">("desc");







 const num=(n:number)=>n.toFixed(data?.instrument.market==="forex"? /JPY/.test(data.instrument.symbol)?2:5:2);







 const [expanded,setExpanded]=useState({htf:true,ltf:true});







 const [visibleHtfZones,setVisibleHtfZones]=useState<IctOverlay[]>([]);







 const [chosenArray,setChosenArray]=useState(initialFocus?`${initialFocus.zoneId}:${initialFocus.entryAt}`:"");







 const [rrBucket,setRrBucket]=useState<RiskBucket>(initialFocus?.rrBucket??"NEAREST");

 const [exitMode,setExitMode]=useState<OutcomeMode>("UNTIL_HIT");

 const [outcomeFuture,setOutcomeFuture]=useState<{source:Result;payload:FutureOutcomeData}|null>(null);

 const handleFutureData=useCallback((source:Result,payload:FutureOutcomeData)=>setOutcomeFuture({source,payload}),[]);







 const [paperDrafts,setPaperDrafts]=useState<Record<string,PaperDraft>>({});







 const [paperTrades,setPaperTrades]=useState<Record<string,PaperTrade[]>>({});







 const handlePaperTrades=useCallback((frame:string,trades:PaperTrade[])=>setPaperTrades(previous=>({...previous,[frame]:trades})),[]);







 const request=useRef<AbortController|null>(null);

 const candleSource=useRef(initialData?.provenance.includes("k1_reclaim3")?"REVERSAL_K1":undefined);







 useEffect(()=>{const abort=new AbortController();fetch('/api/top-down/instruments',{signal:abort.signal}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error);setCatalog(d.instruments);setSymbol(current=>{const parts=current.split(":");const raw=parts.at(-1)!;const found=(d.instruments as ReplayInstrument[]).find(i=>i.name===current||(!current.includes(":")||i.market===parts[0])&&(i.symbol===raw||i.symbol===`^${raw}`));return found?.name??current;});}).catch(e=>{if(!abort.signal.aborted)setError(e.message);});return()=>{abort.abort();request.current?.abort();};},[]);







 useEffect(()=>{const abort=new AbortController();fetch("/reports/icy-tea/final-reconstruction-filters.json",{signal:abort.signal}).then(r=>r.ok?r.json():[]).then(setReferencePresets).catch(()=>{});return()=>abort.abort();},[]);







 function matchesInitialEntry(a:Investigation['arrays'][number]){
  if(!initialFocus||a.zone.id!==initialFocus.zoneId||a.entry?.at!==initialFocus.entryAt)return false;
  const plan=a.entry.plan?planForBucket(a.entry.plan,initialFocus.rrBucket??'NEAREST'):undefined;
  return (initialFocus.stop===undefined||!!plan&&Math.abs(plan.stop-initialFocus.stop)<1e-7)&&(initialFocus.target===undefined||plan?.target!==null&&plan?.target!==undefined&&Math.abs(plan.target-initialFocus.target)<1e-7);
 }
 async function run(overrides?:Partial<ReferencePreset["selection"]>,reference?:ReferencePreset,focus?:{at:number;direction?:string}){







  request.current?.abort();const abort=new AbortController();request.current=abort;setLoading(true);setError("");setPlaying(false);setData(null);setSelected("");setChosenArray("");setAt(null);setPaperTrades({});







  try{const confs=[...new Set(String(overrides?.confirmation??confirmation).split(',').filter(Boolean))];if(!confs.length)throw new Error('Select at least one shift confirmation.');const parts=await Promise.all(confs.map(async c=>{const r=await fetch(variant==='SCALPING_LABS'?'/api/scalping-labs':'/api/market-structure-shift',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol,tf1,tf2,start,end,candleSource:candleSource.current,htfKinds,ltfKinds,arrayScope,pivotStrength,carryIn,retestMode,candleOrderBlocks,strategyFilters,...extraRequest,...(variant==='SCALPING_LABS'?{scalping:{...(extraRequest.scalping as Record<string,unknown>),tickSize:catalog.find(i=>i.name===symbol||i.symbol===symbol)?.market==='forex'?/JPY/.test(symbol)?0.001:/XAU|XAG/.test(symbol)?0.01:0.00001:0.01}}:{}),...overrides,confirmation:c}),signal:abort.signal});const j=decodeScalpingResponse(await r.json());if(!r.ok)throw new Error(j.error);return j;}));if(abort.signal.aborted)return;const d=mergeConfirmations(parts,confs);const near=focus?d.investigations.flatMap((x:Investigation)=>x.arrays.filter(a=>a.entry).map(a=>({x,a,score:Math.abs(a.entry!.at-focus.at)+(focus.direction&&x.mss?.direction!==focus.direction?1e13:0)}))).sort((p:{score:number},r:{score:number})=>p.score-r.score)[0]:undefined;const chosen=near?.x??d.investigations.find((x:Investigation)=>(x.id===initialFocus?.contextId||x.htf.id===initialFocus?.contextId)&&x.arrays.some(matchesInitialEntry))??d.investigations.find((x:Investigation)=>x.id===reference?.preferredEntry?.context)??d.investigations.find((x:Investigation)=>x.state==='RETEST_ENTRY'&&(!reference||x.mss?.direction===reference.reference.direction))??d.investigations[0];const chosenEntry=near?.a??chosen?.arrays.find(matchesInitialEntry)??chosen?.arrays.find((a:Investigation['arrays'][number])=>a.zone.id===reference?.preferredEntry?.zoneId&&a.entry?.at===reference?.preferredEntry?.at);setExpanded({htf:true,ltf:true});d.selection={...d.selection,htfKinds:overrides?.htfKinds??htfKinds,ltfKinds:overrides?.ltfKinds??ltfKinds};setData(d);onResult?.(d);if(autoRunOnLoad&&initialFocus&&!chosenEntry)setError("The saved entry and exact stop / target were not found in this fresh scan. The recorded backtest remains unchanged; select a current setup below to investigate the difference.");setSelected(chosen?.id??'');if(chosenEntry)setChosenArray(arrayKey(chosenEntry));const linkedCandle=focus?d.lower.find(b=>b.t<=focus.at&&b.knownAt>focus.at):undefined;setAt(linkedCandle?.knownAt??chosenEntry?.entry?.knownAt??focusTime(d,chosen));setPage(0);}catch(e){if(!abort.signal.aborted)setError(e instanceof Error?e.message:'Analysis unavailable');}finally{if(request.current===abort)setLoading(false);}







 }







 function inspectTrade(t:MssTrade){if(!data)return;const inv=data.investigations.find(x=>x.id===t.contextId);if(!inv)return;setPlaying(false);setExpanded({htf:true,ltf:true});setState("ALL");setSelected(inv.id);setChosenArray(`${t.zoneId}:${t.entryAt}`);setAt(t.knownAt);}







 // deep link from the Reversal tab: /?tab=market-structure-shift&symbol=..&tf1=..&tf2=..&start=..&end=..&entry=<ISO>&dir=BUY|SELL&htf=..&ltf=..&conf=..&scope=..&retest=..&pivot=..&carry=..&cob=..



 const urlApplied=useRef(false);



 const automaticRun=useRef(false);
 useEffect(()=>{
  if(!autoRunOnLoad||automaticRun.current||!catalog.length)return;
  automaticRun.current=true;
  void run(initialSelection as Partial<ReferencePreset["selection"]>);
 },[autoRunOnLoad,catalog.length]); // eslint-disable-line react-hooks/exhaustive-deps -- Run the immutable selected backtest window once after instrument discovery.

 useEffect(()=>{



  if(urlApplied.current)return;const p=new URLSearchParams(window.location.search);const sym=p.get('symbol');



  if(p.get('tab')!=='market-structure-shift')return;



  const book=playbooks.find(b=>b.id===p.get('playbook'));



  if(!sym&&book){urlApplied.current=true;



   // eslint-disable-next-line react-hooks/set-state-in-effect -- One-time hydration from an external source-library URL.
   setStrategyFilters({...defaultStrategyFilters,playbook:book.id,required:[...book.required]});setLtfKinds([...book.arrays]);setArrayScope(book.scope);return;}



  if(!sym)return;if(!catalog.length&&!error)return;urlApplied.current=true;



  const norm=(s:string)=>s.toUpperCase().replace(/=X$/,'').replace(/[^A-Z0-9]/g,'');



  const inst=catalog.find(i=>norm(i.symbol)===norm(sym))??catalog.find(i=>norm(i.name)===norm(sym));



  const frame=(v:string|null,d:Frame):Frame=>v&&(frames as string[]).includes(v)?v as Frame:d;



  const list=(k:string,d:string[])=>{const v=p.get(k);return v?v.split(',').filter(Boolean):d;};



  const bool=(k:string,d:boolean)=>p.get(k)===null?d:p.get(k)==='true';



  const q={symbol:inst?.name??sym,tf1:frame(p.get('tf1'),tf1),tf2:frame(p.get('tf2'),tf2),start:p.get('start')??start,end:p.get('end')??end,



   confirmation:p.get('conf')??confirmation,arrayScope:p.get('scope')??arrayScope,retestMode:p.get('retest')??retestMode,



   pivotStrength:Number(p.get('pivot')??pivotStrength),carryIn:bool('carry',carryIn),candleOrderBlocks:bool('cob',candleOrderBlocks),



   htfKinds:list('htf',htfKinds),ltfKinds:list('ltf',ltfKinds),...(p.get('candleSource')==='REVERSAL_K1'?{candleSource:'REVERSAL_K1'}:{})};



  setSymbol(q.symbol);setTF1(q.tf1);setTF2(q.tf2);setStart(q.start);setEnd(q.end);setConfirmation(q.confirmation);setArrayScope(q.arrayScope);setRetestMode(q.retestMode);setPivotStrength(q.pivotStrength);setCarryIn(q.carryIn);setCandleOrderBlocks(q.candleOrderBlocks);setHtfKinds(q.htfKinds);setLtfKinds(q.ltfKinds);



  if(p.get('candleSource')==='REVERSAL_K1')candleSource.current='REVERSAL_K1';

  const entryAt=Date.parse(p.get('entry')??'');



  window.history.replaceState(null,'','/?tab=market-structure-shift');



  void run(q,undefined,Number.isFinite(entryAt)?{at:entryAt,direction:p.get('dir')??undefined}:undefined);



 },[catalog,error]); // eslint-disable-line react-hooks/exhaustive-deps







 function selectStory(i:Investigation){if(!data)return;setPlaying(false);setExpanded({htf:true,ltf:true});setSelected(i.id);setChosenArray("");setAt(focusTime(data,i));}







 function loadReference(){const preset=referencePresets.find(r=>String(r.index)===referenceCase);if(!preset)return;const source=preset.selection;const instrument=catalog.find(i=>i.name===source.symbol||i.symbol===source.symbol||i.symbol.replace(/^\^/,"")===source.symbol.replace(/^\^/,""));const q={...source,symbol:instrument?.name??source.symbol};setSymbol(q.symbol);setTF1(q.tf1);setTF2(q.tf2);setStart(q.start);setEnd(q.end);setConfirmation(q.confirmation);setPivotStrength(q.pivotStrength);setCarryIn(q.carryIn);setCandleOrderBlocks(q.candleOrderBlocks);setRetestMode(q.retestMode);setArrayScope(q.arrayScope);setHtfKinds(q.htfKinds);setLtfKinds(q.ltfKinds);setStrategyFilters({...defaultStrategyFilters});void run({...q,strategyFilters:{...defaultStrategyFilters}} as ReferencePreset["selection"],preset);}







 const item=data?.investigations.find(x=>x.id===selected);







 const future=exitMode==="UNTIL_HIT"&&outcomeFuture?.source===data?outcomeFuture.payload:undefined;

 const replayLower=useMemo(()=>[...new Map([...(data?.lower??[]),...(future?.lower??[])].map(b=>[b.t,b])).values()].sort((a,b)=>a.t-b.t),[data,future]);

 const timeline=useMemo(()=>replayLower.filter(b=>b.day>=(data?.selection.start??"")),[replayLower,data]);







 const cutoff=at??timeline.at(-1)?.knownAt??0;







 const index=timeline.findLastIndex(b=>b.knownAt<=cutoff);







 







 const completedHighBars=useMemo(()=>[...new Map([...(data?.higher??[]),...(future?.higher??[])].map(b=>[b.t,b])).values()].sort((a,b)=>a.t-b.t).filter(b=>b.knownAt<=cutoff),[data,future,cutoff]);







 const lowBars=useMemo(()=>replayLower.filter(b=>b.knownAt<=cutoff),[replayLower,cutoff]);







 const daily=useMemo(()=>[...new Map([...(data?.daily??[]),...(future?.daily??[])].map(b=>[b.t,b])).values()].sort((a,b)=>a.t-b.t).filter(b=>b.knownAt<=cutoff),[data,future,cutoff]);







 const highBars=useMemo(()=>{
  if(!data||variant!=="SCALPING_LABS")return completedHighBars;
  const sourceStep=data.selection.tf2==="1h"?60:Number(data.selection.tf2.slice(0,-1));
  const sessionOpen=data.instrument.market==="us"?570:data.instrument.market==="india"?555:0;
  const partial=developingReplayBar(data.selection.tf1,lowBars,daily,completedHighBars,cutoff,sessionOpen,sourceStep);
  return partial?[...completedHighBars,partial]:completedHighBars;
 },[data,variant,completedHighBars,lowBars,daily,cutoff]);

 const fvgSnapshot=useMemo(()=>data?.fvgRanges?.tf1.filter(r=>r.at<=cutoff).at(-1),[data,cutoff]);
 const highZones=useMemo(()=>data?.higherZones.filter(z=>z.knownAt<=cutoff && (z.kind==='FVG'&&htfKinds.includes('VALID_FVG')?inFvgHalf(z,z.direction==='BUY'?fvgSnapshot?.buy:fvgSnapshot?.sell):["BSL","SSL"].includes(z.kind)?htfKinds.includes('SWINGS'):htfKinds.includes(({EQH:'BSL',EQL:'SSL'} as Record<string,string>)[z.kind]??z.kind))).map(z=>({...z,status:z.retiredAt&&z.retiredAt<=cutoff?'SWEPT' as const:'ACTIVE' as const,touches:0,lastTouch:null}))??[],[data,cutoff,htfKinds,fvgSnapshot]);







 const lowZones=useMemo(()=>[...new Map((item?.arrays??[]).map(a=>[a.zone.id,a])).values()].filter(a=>a.zone.knownAt<=cutoff&&(!ltfKinds.includes('VALID_FVG')||a.zone.kind!=='FVG'||a.entry?.checklist?.checks.some(c=>c.id==='VALID_FVG_TF2'&&c.verdict==='PASS'))).map(a=>({...a.zone,status:a.zone.retiredAt&&a.zone.retiredAt<=cutoff?'SWEPT' as const:'ACTIVE' as const,touches:0,lastTouch:null}))??[],[item,cutoff,ltfKinds]);







 const refs=useMemo<ReferencePoint[]>(()=>{







  if(!item||item.htf.knownAt>cutoff)return [];







  const out:ReferencePoint[]=visibleHtfZones.filter(z=>z.knownAt<=cutoff).map(z=>({kind:`TF1 ${z.kind}`,low:z.low,high:z.high,originDay:z.originDay,knownAt:z.knownAt,timing:'Confirmed at close',response:`Projected ${names[data!.selection.tf1]} ${z.direction} level`}));







  if(item.mss&&item.mss.knownAt<=cutoff)out.push({kind:`MSS · ${shiftName(item.mss)}`,low:item.mss.level,high:item.mss.level,originDay:data?.lower.find(b=>b.t===item.mss!.origin)?.day??item.touch.day,knownAt:item.mss.knownAt,timing:'Confirmed at close',response:item.mss.label==='CISD'?'Delivery-run opening price':item.mss.label==='LOCAL_SHIFT'?'Local confirmed opposing pivot':'Raw library broken swing level'});







  return out;







 },[item,cutoff,data,visibleHtfZones]);







 const markers=useMemo<StrategyReplayEvent[]>(()=>{







  if(!item)return [];const events:StrategyReplayEvent[]=[{id:`${item.id}:touch`,at:item.touch.t,direction:item.htf.direction,label:'HTF touch',price:item.touch.c}];







  if(item.mss&&item.mss.knownAt<=cutoff){events.push({id:`${item.id}:start`,at:item.mss.origin,direction:item.mss.direction,label:item.mss.label==='CISD'?'CISD delivery start':item.mss.label==='LOCAL_SHIFT'?'Local opposing pivot':'CHOCH swing origin',price:item.mss.level},{id:`${item.id}:mss`,at:item.mss.at,direction:item.mss.direction,label:`${shiftName(item.mss)} · known at candle end`,price:item.mss.level});for(const a of item.arrays){if(a.entry&&a.entry.knownAt<=cutoff)events.push({id:`${arrayKey(a)}:entry`,at:a.entry.at,direction:item.mss.direction,label:`${a.zone.kind} retest · entry`,price:a.entry.price});}}







  return events.filter(e=>e.at<=cutoff);







 },[item,cutoff]);







 const rows=useMemo(()=>(data?.investigations??[])



  .filter(i=>state==='ALL'||i.state===state)



  .map((item,order)=>{const at=Number(firstEntry(item)?.at);return {item,order,entryAt:Number.isFinite(at)?at:null};})



  .sort((a,b)=>{



   if(a.entryAt===null)return b.entryAt===null?a.order-b.order:1;



   if(b.entryAt===null)return -1;



   return (entrySort==='desc'?b.entryAt-a.entryAt:a.entryAt-b.entryAt)||a.order-b.order;



  }).map(row=>row.item),[data,state,entrySort]);







 const time=(t:number)=>new Date(t).toLocaleString('en-US',{timeZone:data?.instrument.zone??'America/New_York'});







 const plannedArray=item?.arrays.find(a=>arrayKey(a)===chosenArray)??item?.arrays.filter(a=>a.entry).sort((a,b)=>a.entry!.at-b.entry!.at)[0]??item?.arrays.find(a=>a.rejectedEntry);



 const strategyEvidence=plannedArray?.entry?.checklist??plannedArray?.rejectedEntry?.checklist;
 const validFvgProofs=(strategyEvidence?.checks??[]).filter(c=>c.id.startsWith('VALID_FVG_')).map(c=>({tf:c.id.endsWith('TF1')?'TF1':'TF2',proof:c.evidence as FvgProof})).filter(p=>p.proof.at<=cutoff);

 const tf1FvgRange=item?.htf.direction==='BUY'?fvgSnapshot?.buy:fvgSnapshot?.sell;
 const highFibRefs=useMemo(()=>htfKinds.includes('VALID_FVG')&&tf1FvgRange?fibReference(tf1FvgRange,'TF1',cutoff,data?.higher??[],item?.touch.day??''):[],[htfKinds,tf1FvgRange,cutoff,data,item]);
 const lowFibRefs=[...refs,...highFibRefs,...validFvgProofs.filter(p=>p.tf==='TF2'&&p.proof.range).flatMap(p=>fibReference(p.proof.range!,'TF2',cutoff,data?.lower??[],item?.touch.day??''))];




 const strategySummary=useMemo(()=>{const rejected=(data?.investigations??[]).flatMap(i=>i.arrays.flatMap(a=>a.rejectedEntry?[a.rejectedEntry]:[]));const accepted=(data?.investigations??[]).reduce((n,i)=>n+i.arrays.filter(a=>a.entry).length,0);const reasons:Record<string,number>={};for(const e of rejected)for(const reason of e.checklist?.blockers??[])reasons[reason]=(reasons[reason]??0)+1;return {accepted,rejected:rejected.length,reasons};},[data]);







 const autoPlan=plannedArray?.entry?.plan?planForBucket(plannedArray.entry.plan,rrBucket):undefined;

 const storyExit=autoPlan?.state==='READY'&&autoPlan.target!==null&&plannedArray?.entry?walkOutcome({key:arrayKey(plannedArray),direction:autoPlan.direction,entryAt:plannedArray.entry.at,entry:autoPlan.entry,stop:autoPlan.stop,target:autoPlan.target},timeline,exitMode).exitKnownAt:null;

 useEffect(()=>{if(!playing||!timeline.length)return;const timer=setTimeout(()=>{const next=timeline.find(b=>b.knownAt>cutoff);if(!next){setPlaying(false);return;}const active=Object.values(paperTrades).flat().filter(t=>t.placedAt<=cutoff&&paperResult(t,timeline.filter(b=>b.knownAt<=cutoff)).status==='Open');const hit=active.some(t=>paperResult(t,timeline.filter(b=>b.knownAt<=next.knownAt)).status!=='Open');const storyHit=!active.length&&storyExit!==null&&cutoff<storyExit&&next.knownAt>=storyExit;setAt(next.knownAt);if(hit||storyHit)setPlaying(false);},600);return()=>clearTimeout(timer);},[playing,timeline,cutoff,paperTrades,storyExit]);









 const hasOpenPaperTrade=Object.values(paperTrades).flat().some(t=>t.placedAt<=cutoff&&paperResult(t,lowBars).status==='Open');







 const initialPaperDraft=autoPlan?.state==="READY"&&autoPlan.target!==null&&!!plannedArray?.entry&&plannedArray.entry.knownAt<=cutoff?{direction:autoPlan.direction,stop:String(autoPlan.stop),target:String(autoPlan.target),...(variant==="SCALPING_LABS"?{entry:autoPlan.entry,entryAt:plannedArray.entry.knownAt}:{})}:undefined;







 const draftKey=`${data?.selection.symbol}:${data?.selection.start}:${data?.selection.end}:${selected}:${plannedArray?arrayKey(plannedArray):""}:${rrBucket}:${!!initialPaperDraft}`;







 const paperDraftControl={draft:paperDrafts[draftKey]??initialPaperDraft??{direction:autoPlan?.direction??"BUY",stop:"",target:""},onChange:(draft:PaperDraft)=>setPaperDrafts(v=>({...v,[draftKey]:draft}))};







 const chochWindow=useMemo(()=>{if(!item?.mss||!data)return undefined;const from=data.lower.find(b=>b.t===item.mss!.origin),to=data.lower.find(b=>b.t===item.mss!.at);if(!from||!to)return undefined;const format=(t:number)=>new Date(t).toLocaleString('en-US',{timeZone:data.instrument.zone});return {from,to,label:shiftName(item.mss),level:item.mss.label==='CISD'?item.mss.level:item.mss.direction==='BUY'?from.h:from.l,knownAt:item.mss.knownAt,startLabel:format(from.t),endLabel:format(to.t)};},[item,data]);







 function download(){if(!data)return;const u=URL.createObjectURL(new Blob([JSON.stringify({...data,riskBucket:rrBucket,outcomeMode:exitMode,outcomeHistory:future??null,investigations:data.investigations.map(i=>({...i,arrays:i.arrays.map(a=>({...a,entry:a.entry?{...a.entry,selectedPlan:a.entry.plan?planForBucket(a.entry.plan,rrBucket):null}:null}))}))},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download=`mss-${data.selection.symbol}-${data.selection.start}.json`;a.click();URL.revokeObjectURL(u);}







 const levels=(keys:string[],values:string[],setter:(value:string[])=>void)=><div className="flex flex-wrap gap-x-5 gap-y-3">{keys.map(k=><label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={values.includes(k)} onChange={e=>setter(e.target.checked?[...values,k]:values.filter(v=>v!==k))}/>{variant==="SCALPING_LABS"?({FVG:"Fair value gap (FVG)",IFVG:"Inverse FVG",BPR:"Balanced price range (BPR)",MITIGATION:"Mitigation block",PROPULSION:"Propulsion block",REJECTION:"Rejection block",WICK:"Wick midpoint",NYOPEN:"Midnight open"} as Record<string,string>)[k]??labels[k]:labels[k]}</label>)}</div>;







 return <section className="space-y-5">







  {variant==="MSS"?<header><p className="text-xs tracking-widest text-amber-300">ICT INVESTIGATION</p><h1 className="mt-2 text-3xl font-semibold">Market Structure Shift</h1><p className="mt-2 text-sm text-slate-400">HTF touch → selected shift confirmation → selected array timing → later retest entry.</p>{variant==="MSS"?<a className="text-sm text-sky-300 underline" href="/reports/icy-tea/index.html" target="_blank" rel="noopener noreferrer">some_icy_tea reference audit</a>:null}<nav aria-label="MSS result navigation" className="mt-3 flex flex-wrap gap-2 text-sm"><a className="rounded border border-amber-300/30 px-3 py-2 text-amber-200 hover:bg-amber-300/10" href="#mss-analytics">Metrics &amp; visuals</a>{data?<a className="rounded border border-amber-300/30 px-3 py-2 text-amber-200 hover:bg-amber-300/10" href="#mss-heatmaps">Heatmaps</a>:null}</nav></header>:null}



 {variant==="MSS"?<MssStrategyControls value={strategyFilters} onChange={setStrategyFilters} onPlaybook={applyPlaybook}/>:null}



  {variant==="MSS"&&referencePresets.length?<div className="rounded-xl border border-sky-400/20 p-3"><label className="text-sm">Reference reconstruction<select aria-label="MSS reference case" className={`${control} ml-2`} value={referenceCase} onChange={e=>setReferenceCase(e.target.value)}><option value="">Choose a chart</option>{referencePresets.map(r=><option key={r.index} value={r.index}>#{r.index} · {r.reference.date} · {r.reference.tf2} · {r.reference.direction}</option>)}</select></label><button className={`${control} ml-2`} disabled={!referenceCase||loading} onClick={loadReference}>Load reference setup</button><p className="mt-2 text-xs text-slate-400">Applies the tested date, timeframe, confirmation and reference entry window. Local pivots and candle-delivery OBs are separately identified interpretations; this does not certify every annotation or trade outcome.</p></div>:null}







  {variant==="SCALPING_LABS"?<section aria-label="Scalping setup" className="space-y-5 rounded-xl border border-white/10 p-5">
   <div className="grid gap-4 sm:grid-cols-3">
    <label className="text-sm font-medium">Ticker<select aria-label="MSS ticker" className={`${control} mt-2 w-full`} value={symbol} onChange={e=>setSymbol(e.target.value)}>{!catalog.length?<option value={symbol}>{symbol}</option>:catalog.map(i=><option key={i.name} value={i.name}>{i.symbol} · {i.market}</option>)}</select></label>
    <label className="text-sm font-medium">TF1 · Higher timeframe<select aria-label="MSS higher timeframe" className={`${control} mt-2 w-full`} value={tf1} onChange={e=>{const f=e.target.value as Frame;setTF1(f);if(frames.indexOf(tf2)>=frames.indexOf(f))setTF2(frames[frames.indexOf(f)-1]);}}>{frames.slice(1).map(f=><option key={f} value={f}>{names[f]}</option>)}</select></label>
    <label className="text-sm font-medium">TF2 · Entry timeframe<select aria-label="MSS lower timeframe" className={`${control} mt-2 w-full`} value={tf2} onChange={e=>setTF2(e.target.value as Frame)}>{frames.slice(0,frames.indexOf(tf1)).map(f=><option key={f} value={f}>{names[f]}</option>)}</select></label>
   </div>
   <fieldset className="border-t border-white/10 pt-4"><legend className="px-1 text-sm font-semibold">TF1 · Higher-timeframe levels</legend><div className="mt-2">{levels(['OB','FVG','VALID_FVG','IFVG','BREAKER','BPR','BSL','SSL','SWINGS','PDH','PDL','REJECTION','WICK','NYOPEN','GAP'],htfKinds,setHtfKinds)}</div><p className="mt-2 text-sm text-amber-200" aria-label="TF1 touch freshness rule">TF1 touch freshness · latest 5 TF1 candles. Every selected TF1 level must have a touch within the current candle and previous four TF1 candles at both shift confirmation and entry. A forming TF1 candle uses completed TF2 touch evidence only. Old touches expire; a post-shift touch requires a new shift. Applies to every TF1 level, including Valid FVG and previous-day / opening levels.</p><p className="mt-2 text-xs text-slate-400">Valid FVG: bullish midpoint in discount, bearish midpoint in premium of the confirmed swing leg. Uses the same Auto Fib retracement anchors as Fib Calculation: Depth 10, Deviation 3; five completed bars each side. Restricts FVGs only; it can also be selected on its own. Unknown or breached ranges are excluded.</p></fieldset>
   <fieldset className="border-t border-white/10 pt-4"><legend className="px-1 text-sm font-semibold">TF2 · Entry levels</legend><div className="mt-2">{levels(['OB','FVG','VALID_FVG','IFVG','BREAKER','BPR','MITIGATION','PROPULSION'],ltfKinds,setLtfKinds)}</div></fieldset>
   <fieldset><legend className="mb-2 text-sm font-semibold">TF2 · Confirmation</legend><div className="flex flex-wrap gap-x-5 gap-y-3">{[['CHOCH','Market structure shift (MSS)'],['CISD','Change in delivery (CISD)'],['IFVG_FAILURE','FVG failure / inversion']].map(([value,label])=><label className="flex items-center gap-2 text-sm" key={value}><input type="checkbox" checked={confirmation.split(',').includes(value)||(confirmation==='EITHER'&&['CHOCH','CISD'].includes(value))} onChange={e=>{const current=confirmation==='EITHER'?['CHOCH','CISD']:confirmation.split(',').filter(Boolean);setConfirmation((e.target.checked?[...current,value]:current.filter(v=>v!==value)).join(','));}}/>{label}</label>)}</div></fieldset>
   <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
    <details className="text-sm text-slate-400"><summary className="cursor-pointer">Period · {start} – {end}</summary><div className="mt-3 flex flex-wrap gap-3"><label>Start<input aria-label="MSS start date" type="date" className={`${control} ml-2`} value={start} onChange={e=>setStart(e.target.value)}/></label><label>End<input aria-label="MSS end date" type="date" className={`${control} ml-2`} value={end} onChange={e=>setEnd(e.target.value)}/></label></div></details>
    <div className="flex gap-3"><button disabled={loading||!confirmation||!htfKinds.length||!ltfKinds.length||!start||!end||start>end} className="rounded bg-amber-300 px-6 py-2 font-semibold text-slate-950 disabled:opacity-40" onClick={()=>run()}>{loading?'Scanning…':'Find setups'}</button>{loading?<button className={control} onClick={()=>{request.current?.abort();setLoading(false);}}>Cancel</button>:null}</div>
   </div>
  </section>:<>  <div className="space-y-5 rounded-xl border border-white/10 p-5"><div className="flex flex-wrap items-end gap-4">







   <label className="text-sm">Ticker<select aria-label="MSS ticker" className={`${control} ml-2`} value={symbol} onChange={e=>setSymbol(e.target.value)}>{!catalog.length?<option value={symbol}>{symbol}</option>:catalog.map(i=><option key={i.name} value={i.name}>{i.symbol} · {i.market}</option>)}</select></label>







   <label className="text-sm">TF1 · higher<select aria-label="MSS higher timeframe" className={`${control} ml-2`} value={tf1} onChange={e=>{const f=e.target.value as Frame;setTF1(f);if(frames.indexOf(tf2)>=frames.indexOf(f))setTF2(frames[frames.indexOf(f)-1]);}}>{frames.slice(1).map(f=><option key={f} value={f}>{names[f]}</option>)}</select></label><span className="text-amber-300">&gt;</span>







   <label className="text-sm">TF2 · execution<select aria-label="MSS lower timeframe" className={`${control} ml-2`} value={tf2} onChange={e=>setTF2(e.target.value as Frame)}>{frames.slice(0,frames.indexOf(tf1)).map(f=><option key={f} value={f}>{names[f]}</option>)}</select></label>







   <fieldset className="text-sm"><legend className="mb-1">Shift confirmation · select one or more</legend><div className="flex flex-wrap gap-x-4 gap-y-1">{confirmationOptions.map(([value,label])=>{const on=confirmation.split(",").includes(value);return <label key={value} className="flex items-center gap-2"><input type="checkbox" aria-label={`MSS shift confirmation ${label}`} checked={on} onChange={e=>{const cur=confirmation.split(",").filter(Boolean);setConfirmation((e.target.checked?[...cur,value]:cur.filter(v=>v!==value)).join(","));}}/>{label}</label>;})}</div></fieldset>{confirmation.includes("LOCAL")?<label className="text-sm">Local pivot<select aria-label="MSS local pivot strength" className={`${control} ml-2`} value={pivotStrength} onChange={e=>setPivotStrength(Number(e.target.value))}><option value={3}>3 bars each side · native pivots</option><option value={1}>1 bar each side · local pivots</option></select></label>:null}<label className="text-sm"><input type="checkbox" checked={carryIn} onChange={e=>setCarryIn(e.target.checked)}/> Include HTF touches in replay warmup</label><label className="text-sm"><input type="checkbox" checked={candleOrderBlocks} onChange={e=>setCandleOrderBlocks(e.target.checked)}/> Include TF1 candle-delivery OBs</label>



   <label className="text-sm">Start<input aria-label="MSS start date" type="date" className={`${control} ml-2`} value={start} onChange={e=>setStart(e.target.value)}/></label><label className="text-sm">End<input aria-label="MSS end date" type="date" className={`${control} ml-2`} value={end} onChange={e=>setEnd(e.target.value)}/></label>







  </div><div><h2 className="mb-3 font-semibold">TF1 · levels to touch</h2>{levels(Object.keys(labels).filter(k=>!["VALID_FVG","EQH","EQL","MITIGATION","PROPULSION",...(variant==="MSS"?["WICK","REJECTION","GAP","NYOPEN"]:[])].includes(k)),htfKinds,setHtfKinds)}<p className="mt-2 text-sm text-amber-200" aria-label="TF1 touch freshness rule">TF1 touch freshness · latest 5 TF1 candles. Every selected TF1 level must be touched within the current candle and previous four TF1 candles at both shift confirmation and entry. A forming TF1 candle uses completed TF2 touch evidence only. Applies to all TF1 levels. Old touches expire; a post-shift touch requires a new shift.</p></div><div><h2 className="mb-3 font-semibold">TF2 · entry arrays</h2><label className="mb-3 block text-sm">Array timing<select aria-label="MSS array timing" className={`${control} ml-2`} value={arrayScope} onChange={e=>setArrayScope(e.target.value)}><option value="EXISTING">Existing + shift displacement arrays</option><option value="FORMATION">Formation only</option><option value="CONTINUATION">Existing + arrays before retest</option></select></label><label className="mb-3 block text-sm">Retests<select aria-label="MSS retest visits" className={`${control} ml-2`} value={retestMode} onChange={e=>setRetestMode(e.target.value)}><option value="FIRST">First eligible visit</option><option value="ALL">All separate visits</option><option value="CANDLES">Every retest candle · research</option></select></label><p className="mb-3 text-xs text-slate-400">Retest must follow both array activation and shift confirmation. Existing arrays must remain valid. A displacement FVG may finish its third candle after the shift. Arrays before retest also includes continuation arrays; entries stop at the reversal-extreme breach or TF1 invalidation. Local swing break uses confirmed pivots, without requiring the four-swing CHOCH classification. Candle-delivery OBs are a separate interpretation: last opposite candle followed by two advancing directional closes beyond its open; known at the second close.</p>{levels(['OB','BREAKER','FVG','IFVG','BPR'],ltfKinds,setLtfKinds)}{['1m','2m','3m'].includes(tf2)?<p className="mt-3 text-xs text-slate-400">1-minute candles are used directly; 2- and 3-minute candles are automatically aggregated from complete, consecutive 1-minute candles. Choose dates with available data; up to 10,000 TF2 candles per investigation (enough for a full forex trading week).</p>:null}</div>







   <div className="flex gap-3"><button disabled={loading||!confirmation||!htfKinds.length||!ltfKinds.length||!start||!end||start>end} className="rounded bg-amber-300 px-5 py-2 font-semibold text-slate-950 disabled:opacity-40" onClick={()=>run()}>{loading?'Analysing completed prefixes…':'Investigate'}</button>{loading?<button className={control} onClick={()=>{request.current?.abort();setLoading(false);}}>Cancel</button>:null}<button disabled={!data} onClick={download} className={`${control} disabled:opacity-40`}>Export evidence JSON</button></div>







  </div></>}

  {error?<p role="alert" className="rounded border border-red-400/30 p-4 text-red-300">{error}</p>:null}







  {!data&&!loading?<p id="mss-analytics" className="scroll-mt-4 rounded-xl border border-white/10 p-4 text-sm text-slate-400">{variant==="SCALPING_LABS"?"Select your ICT levels and click Find setups. Open a trade to replay it.":"Select your levels and click Investigate to load candle evidence. Metrics, the equity curve and heatmaps will appear here."}</p>:null}







  {data?<><p className="text-sm text-slate-300">{variant==="SCALPING_LABS"?`${data.selection.symbol} | ${names[data.selection.tf1]} to ${names[data.selection.tf2]} | ${data.selection.start} - ${data.selection.end}`:<>Loaded {data.selection.symbol} · {names[data.selection.tf1]} → {names[data.selection.tf2]} · {data.selection.start}–{data.selection.end} · {data.investigations.length} investigations · {new Set(data.investigations.filter(i=>i.mss).map(i=>i.mss!.id)).size} distinct shifts · {data.investigations.filter(i=>i.state==='RETEST_ENTRY').length} HTF contexts with retest entries. Selections apply when you click Investigate.</>}</p>







   {variant==="SCALPING_LABS"&&(htfKinds.includes('VALID_FVG')||ltfKinds.includes('VALID_FVG'))?<details className="rounded border border-white/10 p-3 text-sm"><summary>Valid FVG filter results</summary><p className="mt-2 text-xs text-slate-400">TF1 is tested at touch and entry; TF2 at entry. Counts include separate context evaluations. NO_CONFIRMED_RANGE = no confirmed Auto Fib retracement leg; RANGE_BREACHED = price exceeded its endpoints; WRONG_HALF = FVG midpoint in the opposite half.</p>{Object.entries(data.validFvgAudit??{}).map(([tf,counts])=><p key={tf} className="mt-2">{tf}: {Object.entries(counts).map(([reason,count])=>`${reason}: ${count}`).join(' · ')||'No FVG evaluations'}</p>)}</details>:null}
   <MssAnalytics data={data} rrBucket={rrBucket} onInspect={inspectTrade} exitMode={exitMode} onExitModeChange={mode=>{setPlaying(false);setExitMode(mode);if(mode==="CLOSE_BY_END"){const last=data.lower.at(-1)?.knownAt;if(last)setAt(v=>Math.min(v??last,last));}}} onFutureData={handleFutureData}/>







   {variant==="MSS"?<div className="rounded-xl border border-white/10 p-3 text-sm">{strategySummary.accepted} accepted retest candidates · {strategySummary.rejected} held by selected requirements. Counts include separate HTF contexts.<p className="text-xs text-slate-400">{Object.entries(strategySummary.reasons).map(([reason,n])=>`${reason}: ${n}`).join(" · ")}</p></div>:null}



   <details open={variant==="MSS"||undefined} className={variant==="SCALPING_LABS"?"rounded-xl border border-white/10 p-4":""}><summary className={variant==="MSS"?"hidden":"cursor-pointer text-sm text-slate-400"}>HTF touches and shift details</summary>
   <div className="overflow-x-auto rounded-xl border border-white/10 p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">{variant==="SCALPING_LABS"?"Scalping Labs · entry investigations":"Touch & MSS investigations"}</h2><label>Status<select aria-label="MSS result status" className={`${control} ml-2`} value={state} onChange={e=>{setState(e.target.value);setPage(0);}}>{['ALL','FILTERED_OUT','RETEST_ENTRY','AWAITING_RETEST','NO_FORMATION_ARRAY','NO_MSS'].map(s=><option key={s}>{s}</option>)}</select></label></div><table className="w-full text-left text-xs"><thead><tr><th>TF1 level</th><th>Touch</th><th>Formation start</th><th>MSS close</th><th aria-sort={entrySort==="desc"?"descending":"ascending"}><button aria-label="Sort by entry datetime" title={entrySort==="desc"?"Newest first; click for oldest first":"Oldest first; click for newest first"} className="inline-flex items-center gap-1 py-1 text-amber-300 hover:text-amber-200" onClick={()=>{setEntrySort(s=>s==="desc"?"asc":"desc");setPage(0);}}>Entry datetime <span aria-hidden="true">{entrySort==="desc"?"↓":"↑"}</span></button></th><th>Status</th><th>Chart</th></tr></thead><tbody>{rows.slice(page*30,(page+1)*30).map(i=><tr key={i.id} tabIndex={0} aria-selected={i.id===selected} onClick={()=>selectStory(i)} onKeyDown={e=>{if(e.target===e.currentTarget&&(e.key==="Enter"||e.key===" ")){e.preventDefault();selectStory(i);}}} className={`cursor-pointer border-t border-white/10 hover:bg-white/5 focus-visible:outline focus-visible:outline-sky-400 ${i.id===selected?'bg-sky-400/10':''}`}><td className="py-3">{i.htf.direction} · {labels[i.htf.kind]}{i.htf.id.includes(":CANDLE_OB:")?<span className="ml-1 text-sky-300">· candle delivery</span>:null}<br/>{num(i.htf.low)}–{num(i.htf.high)}</td><td>{time(i.touch.t)}</td><td>{i.mss?time(i.mss.formationStart):'—'}</td><td>{i.mss?<>{time(i.mss.knownAt)}<br/><span className="text-slate-400">{shiftName(i.mss)}</span></>:'—'}</td><td>{firstEntry(i)?time(firstEntry(i)!.at):'—'}</td><td>{i.state.replaceAll('_',' ')}{variant==="SCALPING_LABS"?<p className="text-amber-200">{firstEntry(i)?.playbooks?.join(" · ")}</p>:null}</td><td><button className={control} onClick={e=>{e.stopPropagation();selectStory(i);}}>Inspect</button></td></tr>)}</tbody></table>{!rows.length?<p className="mt-3 text-sm text-slate-400">No matching investigation. Try another date range or HTF level.</p>:null}<div className="mt-3 flex items-center gap-3"><button disabled={page===0} className={control} onClick={()=>setPage(p=>p-1)}>Previous</button><span className="text-xs">{Math.min(page*30+1,rows.length)}–{Math.min((page+1)*30,rows.length)} of {rows.length}</span><button disabled={(page+1)*30>=rows.length} className={control} onClick={()=>setPage(p=>p+1)}>Next</button></div></div></details>







   <div className="rounded-xl border border-white/10 p-4"><div className="mb-3 flex flex-wrap items-center gap-3"><label className="text-sm">Target R:R bucket<select aria-label="MSS target R:R bucket" disabled={hasOpenPaperTrade} className={`${control} ml-2 disabled:opacity-40`} value={rrBucket} onChange={e=>{setPlaying(false);setRrBucket(e.target.value as RiskBucket);}}>{riskBuckets.map(b=><option key={b} value={b}>{riskBucketLabels[b]}</option>)}</select></label><span className="text-xs text-slate-400">Fixed sweep stop · closest existing liquidity in the bucket. 1R = entry-to-stop distance. Bounds include the lower value and exclude the upper value. Buckets use the setup entry; paper R:R uses the replay candle close.</span>{hasOpenPaperTrade?<span className="text-xs text-amber-300">Bucket locked while a paper trade is open.</span>:null}</div>{autoPlan?<p className="mb-3 text-sm text-slate-300">{riskBucketLabels[rrBucket]} · SL {num(autoPlan.stop)} · {autoPlan.target===null?'No eligible target in this bucket; automatic paper plan withheld.':`TP ${num(autoPlan.target)} · R:R 1:${autoPlan.rr?.toFixed(2)} · ${autoPlan.targetSource?.tf} ${autoPlan.targetSource?.kind}`}</p>:null}<div className="flex flex-wrap items-center gap-3"><button className={control} onClick={()=>{setPlaying(false);setAt(timeline[0]?.knownAt??null);}}>Replay from start</button><button className={control} onClick={()=>{if(index>=timeline.length-1)setAt(timeline[0]?.knownAt??null);setPlaying(p=>!p);}}>{playing&&index<timeline.length-1?'Pause':'Play'}</button><button className={control} disabled={index>=timeline.length-1} onClick={()=>{setPlaying(false);setAt(timeline[index+1]?.knownAt??cutoff);}}>Step →</button><span className="text-xs text-slate-400">{item?`Selected story · ${labels[item.htf.kind]} · ${plannedArray?.entry?`entry ${time(plannedArray.entry.at)}`:plannedArray?.rejectedEntry?`held retest ${time(plannedArray.rejectedEntry.at)}`:item.mss?'MSS confirmation':'HTF touch'} · `:''}Completed-candle clock · {time(cutoff)} · {data.instrument.zone}</span></div><input aria-label="MSS replay timeline" type="range" className="mt-3 w-full" min={0} max={Math.max(0,timeline.length-1)} value={Math.max(0,index)} onChange={e=>{setPlaying(false);setAt(timeline[Number(e.target.value)].knownAt);}}/></div>







   {variant==="SCALPING_LABS"&&validFvgProofs.length?<div className="rounded border border-sky-300/20 p-3 text-sm" aria-label="Valid FVG dealing ranges">{validFvgProofs.map(({tf,proof})=><p key={tf}>{tf} Valid FVG · {proof.reason} · {proof.range?`SL ${num(proof.range.low)} → SH ${num(proof.range.high)} · 50% ${num(proof.range.equilibrium)} · FVG midpoint ${num(proof.midpoint)}`:'No confirmed directional swing range'}.</p>)}</div>:null}
   {variant==="SCALPING_LABS"?<p className="text-xs text-slate-400">The developing TF1 candle uses only revealed completed TF2 candles for display. It is excluded from detection.</p>:null}<div className="grid gap-4 xl:grid-cols-2"><article className={`${expanded.htf?"xl:col-span-2 ":""}min-w-0 rounded-xl border border-white/10 p-3`}><WeeklyReplayChart paperDraftControl={paperDraftControl} initialPaperDraft={initialPaperDraft} onPaperTradesChange={handlePaperTrades} paperBars={lowBars} sidePanel key={`${data.selection.symbol}:${data.selection.tf1}:${data.selection.start}:${data.selection.end}:${selected}:${plannedArray?arrayKey(plannedArray):""}`} viewKey={`${data.selection.symbol}:${variant}:htf:${selected}`} onVisibleZonesChange={setVisibleHtfZones} title={`TF1 · ${names[data.selection.tf1]}`} onToggleExpand={()=>setExpanded(v=>({...v,htf:!v.htf}))} expanded={expanded.htf} referencePoints={highFibRefs} frame={data.selection.tf1} bars={highBars} zones={highZones} completedDaily={daily} invalidDays={[]} market={data.instrument.market} range={null} target={null} showSwings={false} showEquilibrium={false} selected={item?.htf.id??''} onSelect={noop} onDaySelect={noop} ictStyle chartHeight={expanded.htf?680:510} replayCutoff={cutoff} followReplay={playing}/></article><article className={`${expanded.ltf?"xl:col-span-2 ":""}min-w-0 rounded-xl border border-white/10 p-3`}><WeeklyReplayChart paperDraftControl={paperDraftControl} initialPaperDraft={initialPaperDraft} onPaperTradesChange={handlePaperTrades} paperBars={lowBars} sidePanel chochWindow={chochWindow} sourceOnlyZones key={`${data.selection.symbol}:${data.selection.tf2}:${data.selection.start}:${data.selection.end}:${selected}:${plannedArray?arrayKey(plannedArray):""}`} viewKey={`${data.selection.symbol}:${variant}:ltf:${selected}`} title={`TF2 · ${names[data.selection.tf2]} · MSS entry arrays`} fitReferenceLevels={false} onToggleExpand={()=>setExpanded(v=>({...v,ltf:!v.ltf}))} expanded={expanded.ltf} frame={data.selection.tf2} bars={lowBars} zones={lowZones} completedDaily={daily} invalidDays={[]} market={data.instrument.market} range={null} target={null} showSwings={false} showEquilibrium={false} referencePoints={lowFibRefs} strategyEvents={markers} selected={selected} onSelect={noop} onDaySelect={noop} ictStyle chartHeight={expanded.ltf?680:510} replayCutoff={cutoff} followReplay={playing}/><details className="mt-3 text-xs text-slate-400"><summary>Projected TF1 levels on TF2 · {visibleHtfZones.length}</summary><div className="mt-2 max-h-40 overflow-auto">{visibleHtfZones.map(z=><p key={z.id}>TF1 {z.kind} · {num(z.low)}–{num(z.high)}</p>)}</div></details></article></div>







   {strategyEvidence?<section className="rounded-xl border border-emerald-400/20 p-4"><h2 className="font-semibold">Selected entry · strategy evidence</h2><p className="text-sm text-slate-400">{strategyEvidence.playbook} · {strategyEvidence.eligible?"All selected requirements passed":"Requirements held"}. Unselected conditions are informational.</p><div className="mt-3 grid gap-2 md:grid-cols-2">{strategyEvidence.checks.map(c=><details key={c.id} className="rounded border border-white/10 p-2 text-sm"><summary>{c.verdict} · {c.step} {c.required?"· required":""}</summary><p className="text-xs text-slate-400">{c.source}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(c.evidence,null,2)}</pre></details>)}</div></section>:null}



   {item?<details open={variant==="MSS"||undefined} className={variant==="SCALPING_LABS"?"rounded-xl border border-white/10 p-4":""}><summary className={variant==="MSS"?"hidden":"cursor-pointer text-sm text-slate-400"}>Setup details &amp; evidence</summary><section className="rounded-xl border border-white/10 p-4"><h2 className="font-semibold">Selected MSS · retest and subsequent price movement</h2>{item.arrays.map(source=>{const a={...source,entry:source.entry?{...source.entry,plan:source.entry.plan?planForBucket(source.entry.plan,rrBucket):undefined}:null};return <div key={arrayKey(a)} className="mt-3 rounded border border-white/10 p-3 text-sm"><p>{a.zone.direction} {a.zone.kind} · {num(a.zone.low)}–{num(a.zone.high)} · origin {time(a.zone.origin)} · known {time(a.zone.knownAt)}</p><button className={`${control} mt-2`} disabled={!a.entry&&!a.rejectedEntry} onClick={()=>{setPlaying(false);setExpanded({htf:true,ltf:true});setChosenArray(arrayKey(a));setAt((a.entry??a.rejectedEntry)!.knownAt);}}>{a.rejectedEntry?`Inspect held ${a.zone.kind} retest`:`Replay from this ${a.zone.kind} entry`}</button>{a.entry?.plan?<div className="mt-2 rounded border border-emerald-400/20 p-2"><p>Structural plan · {a.entry.plan.state.replaceAll('_',' ')} · entry {num(a.entry.plan.entry)} · SL {num(a.entry.plan.stop)} · TP {a.entry.plan.target===null?'unavailable':num(a.entry.plan.target)} · {a.entry.plan.rr===null?'R:R unavailable':`R:R 1:${a.entry.plan.rr.toFixed(2)}`}</p><p className="mt-1 text-xs text-slate-400">Stop: {variant==="SCALPING_LABS"?"configured structural anchor":"sweep extreme"} {time(a.entry.plan.stopAt)}. Target: {a.entry.plan.targetSource?`${a.entry.plan.targetSource.tf} ${a.entry.plan.targetSource.kind}`:'no eligible liquidity'}. {a.entry.plan.state==='READY'?'Replay from this entry to load these levels into paper trading.':a.entry.plan.state==='NO_TARGET_IN_BUCKET'?'No existing liquidity target in this R:R bucket; automatic paper plan withheld.':'Automatic paper plan withheld; see raw evidence.'}</p></div>:null}<p className="mt-1 text-slate-400">{a.rejectedEntry?.checklist?<span className="text-amber-300">Retest held · {a.rejectedEntry.checklist.blockers.join(", ")}. </span>:null}{a.firstRetestBeforeConfirmation?`Earlier touch ${time(a.firstRetestBeforeConfirmation)} excluded: before ${item.mss?.label} confirmation. `:null}{a.entry?`Retest entry ${time(a.entry.at)} at ${num(a.entry.price)} · favourable excursion ${num(a.entry.mfe)} points · adverse excursion ${num(a.entry.mae)} points · final close ${num(a.entry.lastClose)}`:a.rejectedEntry?`Observed retest ${time(a.rejectedEntry.at)} at ${num(a.rejectedEntry.price)}; excluded by the selected evidence requirements.`:'No later retest before the selected end date.'}</p></div>;})}{!item.arrays.length?<p className="mt-2 text-sm text-slate-400">{item.mss?'No valid selected array meets the selected timing rule.':'No matching selected shift confirmation after this HTF touch and before zone invalidation.'}</p>:null}<details className="mt-3"><summary className="cursor-pointer text-sm">Raw library and candle evidence</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(item,null,2)}</pre></details></section></details>:null}







   <details className="rounded-xl border border-white/10 p-4 text-sm text-slate-400"><summary>Detection, source & coverage</summary><p className="mt-3">{data.provider} {data.version}. {data.rules}</p><p className="mt-2 text-xs text-slate-400">{data.confirmationRule}</p><p className="mt-2">Retest entries are OHLC research estimates. Structural stops and liquidity targets are estimated from levels available at entry. Plans without a confirmed sweep or eligible target are withheld. Manual paper trading uses the latest revealed close, so its R:R may differ from the historical setup entry. The table and excursions describe the entire selected period; charts reveal only candles and markers through the replay clock.</p><p className="mt-2">{data.provenance}</p><pre className="mt-2 overflow-auto text-xs">{JSON.stringify(data.audit,null,2)}</pre></details>



  </>:null}



 </section>;



}



