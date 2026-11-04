"use client";

import Image from "next/image";
import {useEffect,useMemo,useState} from "react";
import MarketStructureShift,{type MssResult} from "./market-structure-shift";
import {defaultScalpingSettings,defaultScalpingSelection} from "@/lib/scalping-labs";
import ScalpingTradeChart from "./scalping-trade-chart";
import ScalpingBacktestResults from "./scalping-backtest-results";
import type {BacktestTrade} from "@/lib/scalping-backtest-results";
import type {RiskBucket} from "@/lib/mss-risk-buckets";

type Source={id:number;duplicateOf:number|null;kind:string;direction:string;ticker:string;timeframe:string;chartDate:string;evidence:string;asset:string;preview:string;size?:[number,number]};
const control="rounded border border-white/15 bg-slate-900 px-3 py-2 text-sm";
const baseSelection={...defaultScalpingSelection,symbol:"EURUSD",tf1:"1h" as const,tf2:"5m" as const,start:"2026-01-29",end:"2026-01-29"};
const executionDefaults={scalping:defaultScalpingSettings};

export default function ScalpingLabs(){
 const [view,setView]=useState<"SCAN"|"BACKTEST">("SCAN");
 const [backtestTrade,setBacktestTrade]=useState<BacktestTrade|null>(null);
 const [sources,setSources]=useState<Source[]>([]),[sourceError,setSourceError]=useState("");
 const [verified,setVerified]=useState<{source:number;entryAt:number;entry:number;contextId:string;zoneId:string;knownAt:number}|null>(null);
 const [preview,setPreview]=useState<Source|null>(null),[reference,setReference]=useState<Source|null>(null);
 useEffect(()=>{
  const abort=new AbortController();
  fetch('/reports/scalping-labs/usdjpy-april14-validation.json',{signal:abort.signal}).then(r=>r.ok?r.json():null).then(r=>{if(r)setVerified({source:r.source,entryAt:r.checkpoints.entryAt,entry:r.entry,contextId:r.contextId,zoneId:r.zoneId,knownAt:r.entryKnownAt});}).catch(()=>{});
  fetch('/reports/scalping-labs/sources.json',{signal:abort.signal}).then(async r=>{if(!r.ok)throw new Error('Chart examples unavailable.');return r.json();}).then(setSources).catch(e=>{if(!abort.signal.aborted)setSourceError(e.message);});
  return()=>abort.abort();
 },[]);
 const selection=useMemo(()=>{
  if(backtestTrade){
   const local=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(backtestTrade.entryAt));
   const day=new Date(`${local}T00:00:00Z`),anchor=Date.parse('2017-01-01T00:00:00Z');
   const week=new Date(anchor+Math.floor((day.getTime()-anchor)/604800000)*604800000);
   return {...baseSelection,symbol:backtestTrade.symbol,start:week.toISOString().slice(0,10),end:new Date(week.getTime()+6*86400000).toISOString().slice(0,10),confirmation:'EITHER',pivotStrength:3,candleOrderBlocks:false,arrayScope:'CONTINUATION',retestMode:'ALL',carryIn:true,htfKinds:['OB','VALID_FVG','IFVG','BREAKER','BPR','BSL','SSL','SWINGS','PDH','PDL'],ltfKinds:['OB','FVG','VALID_FVG','IFVG','BREAKER','BPR']};
  }
  if(!reference)return baseSelection;
  const tf2=["1m","2m","3m","5m","10m","15m","30m","1h"].includes(reference.timeframe)?reference.timeframe as MssResult['selection']['tf2']:"5m";
  const tf1=/\b4H\b/i.test(reference.evidence)||tf2==="1h"?"4h" as const:"1h" as const;
  return {...baseSelection,symbol:`^${reference.ticker}`,tf1,tf2,start:reference.chartDate,end:reference.chartDate};
 },[reference,backtestTrade]);
 const backtestSetup=backtestTrade?.chartSelection??backtestTrade?.attributions?.[0];
 return <div className="space-y-5">
  <header><h1 className="text-3xl font-semibold">Scalping Labs</h1><p className="mt-2 text-sm text-slate-400">Choose your ticker and timeframes, then select the ICT levels to scan.</p></header>
  <nav aria-label="Scalping Labs view" className="flex gap-2"><button aria-pressed={view==="SCAN"} className={`${control} ${view==="SCAN"?"border-amber-300 text-amber-300":""}`} onClick={()=>setView("SCAN")}>Investigate setups</button><button aria-pressed={view==="BACKTEST"} className={`${control} ${view==="BACKTEST"?"border-amber-300 text-amber-300":""}`} onClick={()=>setView("BACKTEST")}>Backtest results</button></nav>
  <div className={view==="BACKTEST"&&!backtestTrade?"":"hidden"}><ScalpingBacktestResults onInspect={trade=>{setReference(null);setBacktestTrade(trade);}}/></div>
  {view==="BACKTEST"&&backtestTrade?<ScalpingTradeChart key={`${backtestTrade.id}:${backtestSetup?.contextId}:${backtestSetup?.arrayId}:${backtestSetup?.confirmation}`} trade={backtestTrade} onClose={()=>setBacktestTrade(null)}/>:null}
  {view==="SCAN"?<>
  {backtestTrade?<p className="rounded border border-sky-300/20 p-3 text-sm">Saved backtest scenario · {backtestTrade.symbol} · {new Date(backtestTrade.entryAt).toLocaleString('en-US',{timeZone:'America/New_York'})} New York · R:R {backtestTrade.rrBucket} · saved entry {backtestTrade.entry} / SL {backtestTrade.stop} / TP {backtestTrade.target}. Reloading the same weekly scan and saved entry focus from current stored candles. The recorded prices remain in Backtest results; new replay evidence may differ if the archive has changed. <button className="ml-2 text-sky-300 underline" onClick={()=>setBacktestTrade(null)}>Reset</button></p>:null}
  {reference?<p className="rounded border border-white/10 p-3 text-sm">Example S{reference.id}: {reference.ticker} · {reference.chartDate}. {reference.timeframe==='Unknown'?'Timeframe missing; 5m is assumed. ':''}{verified?.source===reference.id?`Candle-verified retrace: ${new Date(verified.entryAt).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'})} New York at ${verified.entry}. Default target uses nearest liquidity.`:'Exact source entry is unverified.'} <button className="ml-2 text-sky-300 underline" onClick={()=>setReference(null)}>Reset</button></p>:null}
  <MarketStructureShift key={backtestTrade?.id??reference?.id??'default'} variant="SCALPING_LABS" initialSelection={selection} autoRunOnLoad={!!backtestTrade} initialFocus={backtestTrade?{contextId:backtestSetup?.contextId??"",zoneId:backtestSetup?.arrayId??"",entryAt:backtestTrade.entryAt,knownAt:backtestTrade.entryKnownAt??backtestTrade.entryAt+300000,rrBucket:backtestTrade.rrBucket as RiskBucket,stop:backtestTrade.stop,target:backtestTrade.target}:verified&&reference&&verified.source===reference.id?{contextId:verified.contextId,zoneId:verified.zoneId,entryAt:verified.entryAt,knownAt:verified.knownAt}:undefined} extraRequest={executionDefaults}/>
  <details className="rounded-xl border border-white/10 p-4"><summary className="cursor-pointer text-sm text-slate-400">Chart examples (optional)</summary>
   {sourceError?<p role="alert" className="mt-3 text-red-300">{sourceError}</p>:null}
   <div className="mt-4 grid max-h-80 gap-2 overflow-auto sm:grid-cols-2 lg:grid-cols-3">{sources.filter(s=>!s.duplicateOf).map(s=><button className={`${control} text-left hover:border-amber-300/40`} key={s.id} onClick={()=>setPreview(s)}>S{s.id} · {s.ticker} · {s.timeframe}<span className="block text-xs text-slate-400">{s.chartDate} · {s.direction}</span></button>)}</div>
   {preview?<section aria-label="Selected chart example" className="mt-4 border-t border-white/10 pt-4"><div className="flex flex-wrap items-center justify-between gap-3"><p className="font-semibold">S{preview.id} · {preview.ticker}</p><div className="flex gap-2">{['TRADE','VIDEO_TRADE'].includes(preview.kind)&&preview.ticker!=="Unknown"&&/^\d{4}-\d{2}-\d{2}$/.test(preview.chartDate)?<button className={control} onClick={()=>{setBacktestTrade(null);setReference(preview);}}>Use ticker and dates</button>:null}<button className={control} onClick={()=>setPreview(null)}>Close example</button></div></div>{preview.asset.endsWith('.mp4')?<video controls preload="metadata" className="mx-auto mt-4 max-h-[650px] max-w-full" src={preview.asset}/>:<Image unoptimized width={preview.size?.[0]??1200} height={preview.size?.[1]??1200} alt={`Chart example S${preview.id}`} className="mx-auto mt-4 max-h-[650px] w-auto max-w-full object-contain" src={preview.preview}/>}<p className="mt-3 text-sm text-slate-400">{preview.evidence}</p></section>:null}
  </details>
  </>:null}
 </div>;
}
