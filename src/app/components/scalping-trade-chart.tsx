"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { SavedIctTimeframeChart, type EvLabel } from "./daily-forward-chart";
import type { BacktestTrade } from "@/lib/scalping-backtest-results";
import type { ReplayBar } from "@/lib/weekly-replay";
import type { ScalpingProof, EvidenceLine } from "@/lib/scalping-chart-evidence";
import { scalpingEvidence } from "@/lib/scalping-chart-evidence";
import { ipdaLookback } from "@/lib/ipda-lookback";

type Option={contextId:string;arrayId:string;confirmation:string;tf1Kind:string;tf2Kind:string};
type ChartData={evidence:ScalpingProof|null;evidenceOptions:Option[];trade:{ambiguous?:number;exitKnownAt?:number};lower:ReplayBar[];higher:ReplayBar[];daily:ReplayBar[];forwardDates?:{basis:string;markers:{count:number;day:string|null}[]};snapshotAt:number;warning?:string};
const control="rounded border border-white/15 bg-[#0b0f16] px-3 py-1.5 text-xs text-[#b9c4d6] hover:border-white/30 hover:text-white";
const clock=(at:number|null)=>at==null?"Open":new Date(at).toLocaleString("en-US",{timeZone:"America/New_York",month:"short",day:"2-digit",year:"2-digit",hour:"2-digit",minute:"2-digit"});

export default function ScalpingTradeChart({trade,onClose}:{trade:BacktestTrade;onClose:()=>void}){
 const [data,setData]=useState<ChartData|null>(null),[error,setError]=useState("");
 const [mode,setMode]=useState<"ENTRY"|"OUTCOME">("OUTCOME");
 const [macro,setMacro]=useState(false),[targets,setTargets]=useState(false);
 const [options,setOptions]=useState<Option[]>([]),[chosen,setChosen]=useState<Option|undefined>(()=>{
  const a=trade.chartSelection??trade.attributions?.[0];
  return a?.contextId&&a.arrayId?{...a,contextId:a.contextId,arrayId:a.arrayId}:undefined;
 });
 useEffect(()=>{
  const abort=new AbortController();
  const query=new URLSearchParams({id:trade.id,contextId:chosen?.contextId??"",arrayId:chosen?.arrayId??"",confirmation:chosen?.confirmation??""});
  fetch(`/api/scalping-labs/backtest/chart?${query}`,{signal:abort.signal}).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error);return d as ChartData;}).then(d=>{if(!abort.signal.aborted){setData(d);setOptions((d.evidenceOptions??[]).filter(o=>(!trade.chartFilters?.tf1||o.tf1Kind===trade.chartFilters.tf1)&&(!trade.chartFilters?.tf2||o.tf2Kind===trade.chartFilters.tf2)&&(!trade.chartFilters?.confirmation||trade.chartFilters.confirmation==="ALL"||o.confirmation===trade.chartFilters.confirmation)));}}).catch(e=>{if(!abort.signal.aborted)setError(e.message);});
  return()=>abort.abort();
 },[trade.id,trade.chartFilters,chosen?.contextId,chosen?.arrayId,chosen?.confirmation]);
 const cutoff=mode==="ENTRY"?trade.entryKnownAt??trade.entryAt:data?.trade.exitKnownAt??(trade.exitAt!=null?trade.exitAt+300000:data?.lower.at(-1)?.knownAt)??trade.entryAt;
 const proof=data?.evidence??null;
 const digits=trade.market==="forex"?(/JPY/.test(trade.symbol)?3:/XAU|XAG/.test(trade.symbol)?2:5):2;
 const price=(n:number|undefined)=>n==null?"—":n.toFixed(digits);
 const daily=(data?.daily??[]).filter(b=>b.knownAt<=cutoff).sort((a,b)=>a.t-b.t);
 const day=data?.lower.find(b=>b.t===trade.entryAt)?.day??new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York"}).format(new Date(trade.entryAt));
 const lookback=ipdaLookback(daily,day);
 const macroLevels:EvidenceLine[]=macro?(lookback?.windows??[]).flatMap(w=>w.complete?[
  {label:`${w.count}D HIGH`,price:w.high!,knownAt:daily.at(-1)!.knownAt,color:"#2563eb"},
  {label:`${w.count}D LOW`,price:w.low!,knownAt:daily.at(-1)!.knownAt,color:"#2563eb"},
 ]:[]):[];
 const intraday=(data?.lower??[]).filter(b=>b.day===day&&b.knownAt<=cutoff);
 const dayLevels:EvidenceLine[]=intraday.length?[
  {label:"INTRADAY HIGH",price:Math.max(...intraday.map(b=>b.h)),knownAt:intraday.at(-1)!.knownAt,color:"#2563eb"},
  {label:"INTRADAY LOW",price:Math.min(...intraday.map(b=>b.l)),knownAt:intraday.at(-1)!.knownAt,color:"#2563eb"},
 ]:[];
 const ownBars=(frame:"TF1"|"TF2")=>{
  const bars=(frame==="TF1"?data?.higher:data?.lower)??[];
  const visible=bars.filter(b=>b.knownAt<=cutoff);
  if(frame==="TF1"){
   // Display the unfinished H1 only from completed TF2 bars through the cutoff.
   const pending=bars.find(b=>b.t<=cutoff&&b.knownAt>cutoff);
   const parts=pending?(data?.lower??[]).filter(b=>b.t>=pending.t&&b.t<pending.knownAt&&b.knownAt<=cutoff):[];
   if(pending&&parts.length)visible.push({...pending,o:parts[0].o,h:Math.max(...parts.map(b=>b.h)),l:Math.min(...parts.map(b=>b.l)),c:parts.at(-1)!.c,knownAt:parts.at(-1)!.knownAt});
   return visible;
  }
  if(!proof)return visible;
  const start=Math.min(proof.array.origin,proof.confirmation.origin,proof.confirmation.formationStart??proof.confirmation.origin,proof.touch.t)-3600000;
  return visible.filter(b=>b.t>=start);
 };
 const frames=(["TF1","TF2"] as const).map(frame=>{
  const own=frame==="TF1"?proof?.context:proof?.array;
  const lines=[...(proof?scalpingEvidence(proof,frame,targets).lines:[]),...(frame==="TF1"?macroLevels:[...macroLevels,...dayLevels])].filter(l=>l.knownAt<=cutoff);
  const level=own&&Math.abs(own.high-own.low)<1e-8;
  const labels:EvLabel[]=lines.filter(l=>!level||l.label!==`${frame} ${own.kind} CE`).map(l=>({tf:"1h",kind:l.label.includes("target")?"target":"pool",price:l.price,timeMs:l.originAt??proof?.touch.t??trade.entryAt,label:l.label}));
  if(own&&level)labels.unshift({tf:"1h",kind:"pool",price:own.low,timeMs:own.origin,label:`SELECTED ${own.kind}`});
  return {frame,bars:ownBars(frame),labels,setup:{zone:own&&!level?{low:own.low,high:own.high,origin:own.origin,label:`SELECTED ${own.tf} ${own.kind}`} : null,
   confirmation:frame==="TF2"&&proof?{origin:proof.confirmation.origin,start:proof.confirmation.formationStart??proof.confirmation.origin,end:proof.confirmation.at,level:proof.confirmation.level,label:proof.confirmation.label}:undefined,
   exit:mode==="OUTCOME"&&trade.exitAt!=null&&["WIN","LOSS"].includes(trade.result)?{at:trade.exitAt,price:(trade.result==="LOSS"?trade.stop:trade.target)!,label:trade.result==="LOSS"?"SL HIT":"TARGET HIT"}:undefined}};
 });
 const outcome=mode==="ENTRY"?"Entry snapshot":trade.result==="LOSS"?`SL hit · ${price(trade.stop)} · ${clock(trade.exitAt)}`:trade.result==="WIN"?`Target hit · ${price(trade.target)} · ${clock(trade.exitAt)}`:"Open at the saved cutoff";
 return <section aria-label="Saved ICT trade chart" className="overflow-hidden rounded-md border border-white/10 bg-[#101620]">
  {trade.chartStats?<div className="grid gap-3 border-b border-white/10 p-4 sm:grid-cols-2 lg:grid-cols-6">{[
   ["Closed scenarios",trade.chartStats.closed.toLocaleString()],["Open scenarios",trade.chartStats.open.toLocaleString()],
   ["Gross R",`${trade.chartStats.grossR>=0?"+":""}${trade.chartStats.grossR.toFixed(2)}R`],
   ["Expectancy",trade.chartStats.expectancy==null?"—":`${trade.chartStats.expectancy>=0?"+":""}${trade.chartStats.expectancy.toFixed(2)}R`],
   ["Win rate",`${trade.chartStats.winRate?.toFixed(1)??"—"}%`],["Profit factor",trade.chartStats.profitFactor?.toFixed(2)??"—"]
  ].map(([name,value])=><div key={name} className="rounded border border-white/10 bg-[#0b0f16] p-3"><p className="text-xs text-[#93a1b6]">{name}</p><p className="mt-2 text-xl font-semibold text-[#d6deec]">{value}</p></div>)}</div>:null}
  {trade.chartFilters?<p aria-label="Applied chart filters" className="border-b border-white/10 px-4 py-2 text-xs text-[#93a1b6]">Filtered results · {trade.chartFilters.markets.join(", ")||"all markets"} · {trade.chartFilters.symbols.join(", ")||"all tickers"} · R:R {trade.chartFilters.buckets.join(", ")} · {trade.chartFilters.confirmation} confirmation · {trade.chartFilters.tf1||"all TF1"} → {trade.chartFilters.tf2||"all TF2"}</p>:null}
  <header className="flex flex-wrap items-center gap-3 border-b border-white/10 px-4 py-3 text-xs">
   <strong className="text-[#d6deec]">ICT Trade Chart</strong><span className="font-mono text-[#93a1b6]">{trade.symbol} · {trade.side} · TF1 1H → TF2 5M · {proof?.context.kind??chosen?.tf1Kind} → {proof?.array.kind??chosen?.tf2Kind}</span>
   <span className="rounded border border-white/10 bg-[#0b0f16] px-2 py-1 text-[#b9c4d6]">{outcome}</span>
   <button onClick={onClose} title="Close chart" aria-label="Back to trades" className="ml-auto rounded border border-white/15 p-1.5 text-[#93a1b6] hover:text-white"><X className="size-4"/></button>
  </header>
  <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2">
   <button className={control} aria-pressed={mode==="ENTRY"} onClick={()=>setMode("ENTRY")}>At entry</button>
   <button className={control} aria-pressed={mode==="OUTCOME"} onClick={()=>setMode("OUTCOME")}>Through outcome</button>
   <button className={control} aria-pressed={macro} onClick={()=>setMacro(v=>!v)}>20 / 40 / 60 day levels</button>
   <button className={control} aria-pressed={targets} onClick={()=>setTargets(v=>!v)}>All saved liquidity targets</button>
   <span className="ml-auto font-mono text-[11px] text-[#7f8ca3]">Entry {price(trade.entry)} · SL {price(trade.stop)} · Target {price(trade.target)} · 1:{trade.plannedRR.toFixed(2)}R</span>
  </div>
  {options.length>1?<label className="block px-4 py-2 text-xs text-[#93a1b6]">Matching setup <select value={Math.max(0,options.findIndex(o=>o.contextId===chosen?.contextId&&o.arrayId===chosen?.arrayId&&o.confirmation===chosen?.confirmation))} className={`${control} ml-2`} onChange={e=>{setData(null);setError("");setChosen(options[Number(e.target.value)]);}}>{options.map((o,i)=><option key={i} value={i}>{o.tf1Kind} → {o.tf2Kind} · {o.confirmation}</option>)}</select></label>:null}
  {error?<p role="alert" className="p-4 text-sm text-[#ff9da2]">{error}</p>:!data?<div role="status" className="grid h-[520px] place-items-center text-sm text-[#93a1b6]">Loading saved candles and strategy JSON…</div>:<>
   {data.warning?<p role="alert" className="border-b border-amber-400/20 p-3 text-xs text-amber-200">{data.warning}</p>:null}
   {frames.map(({frame,bars,labels,setup})=><section key={frame} className="border-b border-white/10">
    <div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-[#0b0f16] px-4 py-2 text-xs"><strong className="text-[#d6deec]">{frame} · {frame==="TF1"?"1H · ICT Context · −60 / −40 / −20 bars":"5M · ICT Execution"}</strong><span className="ml-auto font-mono text-[#7f8ca3]">{frame==="TF1"?proof?.context.kind:[proof?.confirmation.label,proof?.array.kind].filter(Boolean).join(" → ")}</span></div>
    <SavedIctTimeframeChart trade={{symbol:trade.symbol,direction:trade.side,entryTs:new Date(trade.entryAt).toISOString(),fill:trade.entry??null,stop:trade.stop??null,target:trade.target??null}} tf={frame==="TF1"?"1h":"5m"} bars={bars} anchorAt={proof?.touch.t??trade.entryAt} labels={labels} setup={setup} notes={[{tf:"1h",text:frame==="TF1"?`Selected ${proof?.context.kind??"context"} on H1. Last H1 candle may be partial, using only completed 5m bars through this cutoff.`:proof?`${proof.confirmation.label}: ${clock(proof.confirmation.formationStart??proof.confirmation.origin)} → ${clock(proof.confirmation.at)} · known ${clock(proof.confirmation.knownAt)}. ${proof.array.kind} origin ${clock(proof.array.origin)} → entry ${clock(trade.entryAt)}.`:"Selected evidence unavailable"}]}/>
   </section>)}
   <div className="grid gap-3 p-4 md:grid-cols-4">
    {[{title:"TF1 context",body:proof?`${proof.context.kind} · ${price(proof.context.low)}–${price(proof.context.high)}`:"Evidence unavailable",note:proof?`Known ${clock(proof.context.knownAt)}`:"Manual inspection required"},
    {title:"Touch / raid",body:proof?clock(proof.touch.t):"—",note:proof?.tf1TouchFreshness?.entry?.reason??"No freshness result recorded"},
    {title:"Confirmation",body:proof?`${proof.confirmation.label} · ${price(proof.confirmation.level)}`:"—",note:proof?`Known ${clock(proof.confirmation.knownAt)}`:""},
    {title:"TF2 entry array",body:proof?`${proof.array.kind} · ${price(proof.array.low)}–${price(proof.array.high)}`:"—",note:proof?`Known ${clock(proof.array.knownAt)}`:""}].map(f=><div key={f.title} className="rounded border border-white/10 bg-[#0b0f16] p-3 text-xs"><p className="text-[#7f8ca3]">{f.title}</p><p className="mt-1 font-mono text-[#d6deec]">{f.body}</p><p className="mt-1 text-[11px] text-[#93a1b6]">{f.note}</p></div>)}
   </div>
   {data.trade.ambiguous&&mode==="OUTCOME"?<p className="px-4 pb-3 text-xs text-amber-200">Stop and target touched in the same candle; the saved backtest policy determines this outcome.</p>:null}
   <details className="border-t border-white/10 p-4 text-xs text-[#93a1b6]"><summary className="cursor-pointer">20 / 40 / 60 forward trading-day dates and range coverage</summary>
    <svg role="img" aria-label="20, 40 and 60 trading-day forward date markers" viewBox="0 0 960 110" className="mt-3 w-full rounded-md bg-[#e5e7eb] font-mono">
     <line x1="90" x2="870" y1="45" y2="45" stroke="#94a3b8"/>
     <circle cx="90" cy="45" r="4" fill="#b7791f"/><text x="90" y="25" textAnchor="middle" fill="#713f12" fontSize="11">ENTRY DAY</text><text x="90" y="80" textAnchor="middle" fill="#475569" fontSize="11">{day}</text>
     {data.forwardDates?.markers.map((m,i)=><g key={m.count}><line x1={350+i*260} x2={350+i*260} y1="35" y2="55" stroke="#2563eb" strokeWidth="2"/><text x={350+i*260} y="25" textAnchor="middle" fill="#1e40af" fontSize="11">+{m.count} SESSIONS</text><text x={350+i*260} y="80" textAnchor="middle" fill="#475569" fontSize="11">{m.day??"Unavailable"}</text></g>)}
    </svg><p className="mt-2">{data.forwardDates?.basis}</p>{lookback?.windows.map(w=><p key={w.count} className="mt-2">{w.count}D: {w.complete?`${price(w.low!)}–${price(w.high!)}`:`Unavailable · ${w.available}/${w.count} sessions`}</p>)}</details>
   <details className="border-t border-white/10 p-4 text-xs text-[#93a1b6]"><summary className="cursor-pointer">Strategy JSON Evidence</summary><p className="mt-2">Source {trade.sourceFile} · {trade.id}</p><p className="mt-2">{proof?.plan.rule}</p><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap font-mono text-[11px]">{JSON.stringify({snapshotAt:data.snapshotAt,strategy_json:proof},null,2)}</pre></details>
  </>}
 </section>;
}
