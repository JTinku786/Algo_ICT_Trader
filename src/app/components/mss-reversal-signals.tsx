"use client";

import {useMemo,useState} from "react";
import type {MssResult,MssFocus} from "./market-structure-shift";

export default function MssReversalSignals({mssResult:data,onInspect,onOpenMss}:{mssResult:MssResult|null;onInspect:(focus:MssFocus)=>void;onOpenMss:()=>void}){
 const [direction,setDirection]=useState("ALL"),[ascending,setAscending]=useState(false);
 const rows=useMemo(()=>{
  const grouped=new Map<string,{story:NonNullable<typeof data>["investigations"][number];array:NonNullable<typeof data>["investigations"][number]["arrays"][number];contexts:Set<string>}>();
  for(const story of data?.investigations??[])for(const array of story.arrays){
   if(!array.entry||!story.mss)continue;
   const key=JSON.stringify([story.mss.id,story.mss.direction,array.zone.id,array.entry.at,array.entry.price,array.entry.plan?.stop,array.entry.plan?.target,array.entry.plan?.state]);
   const existing=grouped.get(key);
   if(existing)existing.contexts.add(story.id);else grouped.set(key,{story,array,contexts:new Set([story.id])});
  }
  return [...grouped.entries()].filter(([,r])=>direction==="ALL"||r.story.mss?.direction===direction).sort((a,b)=>(ascending?1:-1)*(a[1].array.entry!.at-b[1].array.entry!.at));
 },[data,direction,ascending]);
 const price=(value:number|null|undefined)=>value==null?"—":value.toFixed(data?.instrument.market==="forex"?5:2);
 return <section className="space-y-4"><h1 className="text-2xl font-semibold">Reversal · MSS signals</h1>
 <p className="text-sm text-slate-400">Entry candidates from your latest successful Market Structure Shift investigation. These are research signals, with the original confirmation and array rules.</p>
 {!data?<div className="rounded border border-white/15 p-6"><p>Run an MSS investigation to load its signals here.</p><button onClick={onOpenMss} className="mt-4 rounded bg-yellow-400 px-4 py-2 text-black">Open Market Structure Shift</button></div>:<>
 <div className="flex flex-wrap items-center gap-4 rounded border border-white/15 p-4"><span>{data.selection.symbol} · {data.selection.tf1} → {data.selection.tf2} · {data.selection.start} – {data.selection.end}</span><span>{rows.length} signals</span><label>Direction <select aria-label="Reversal signal direction" value={direction} onChange={e=>setDirection(e.target.value)} className="rounded bg-slate-900 p-2"><option>ALL</option><option>BUY</option><option>SELL</option></select></label><button onClick={onOpenMss} className="text-yellow-300">Open MSS investigation</button></div>
 <div className="overflow-x-auto rounded border border-white/15"><table className="w-full text-left text-sm"><thead><tr>{["Entry datetime (New York)","Direction","Array","Confirmation","Entry","Stop","Target","R:R","Plan","HTF contexts","Chart"].map((label,index)=><th key={label} className="p-3">{index===0?<button onClick={()=>setAscending(v=>!v)}>{label} {ascending?"↑":"↓"}</button>:label}</th>)}</tr></thead><tbody>{rows.map(([key,{story,array,contexts}])=>{const entry=array.entry!,plan=entry.plan;return <tr key={key} className="border-t border-white/10"><td className="p-3">{new Date(entry.at).toLocaleString("en-US",{timeZone:"America/New_York"})}</td><td className="p-3">{story.mss!.direction}</td><td className="p-3">{array.zone.kind}</td><td className="p-3">{story.mss!.label} · {story.mss!.breakMode??"close"}</td><td className="p-3">{price(entry.price)}</td><td className="p-3">{price(plan?.stop)}</td><td className="p-3">{price(plan?.target)}</td><td className="p-3">{plan?.rr==null?"—":`1:${plan.rr.toFixed(2)}`}</td><td className="p-3">{plan?.state??"Unavailable"}</td><td className="p-3" title={[...contexts].join("\n")}>{contexts.size} · {story.htf.kind}</td><td className="p-3"><button className="rounded border border-white/20 px-3 py-2" onClick={()=>onInspect({contextId:story.id,zoneId:array.zone.id,entryAt:entry.at,knownAt:entry.knownAt})}>Inspect MSS</button></td></tr>;})}</tbody></table>{rows.length===0?<p className="p-4">No retest entry candidates match this selection.</p>:null}</div>
 <p className="text-xs text-slate-400">Repeated HTF contexts for the same shift, array, entry and structural plan are grouped. Inspect opens the original evidence at entry confirmation; replay can continue from there. Results remain available while this dashboard is open.</p>
 </>}
 </section>;
}
