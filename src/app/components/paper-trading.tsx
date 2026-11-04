"use client";
import { useEffect, useState } from "react";
import { paperResult, type PaperTrade } from "@/lib/paper-trading";
import type { ReplayBar } from "@/lib/weekly-replay";
export type PaperDraft={direction:"BUY"|"SELL";stop:string;target:string;entry?:number;entryAt?:number};
export default function PaperTrading({bars,symbol,frame,title,onTradesChange,draft,onDraftChange,initiallyOpen=false}:{bars:ReplayBar[];symbol:string;frame:string;title:string;onTradesChange?:(frame:string,trades:PaperTrade[])=>void;initiallyOpen?:boolean;draft?:PaperDraft;onDraftChange?:(draft:PaperDraft)=>void}) {
  const [trades,setTrades]=useState<PaperTrade[]>([]);
  const [localDraft,setLocalDraft]=useState<PaperDraft>({direction:"BUY",stop:"",target:""});
  const current=draft??localDraft;const {direction,stop,target}=current;
  const update=(next:PaperDraft)=>{setLocalDraft(next);onDraftChange?.(next);};
  const setDirection=(direction:PaperDraft["direction"])=>update({...current,direction});
  const setStop=(stop:string)=>update({...current,stop});const setTarget=(target:string)=>update({...current,target}); const [quantity,setQuantity]=useState("1");
  const [error,setError]=useState("");
  const last=bars.at(-1);
  useEffect(()=>{onTradesChange?.(frame,trades.filter(t=>t.symbol===symbol && t.frame===frame));},[trades,symbol,frame,onTradesChange]);
  function save(next:PaperTrade[]) { setTrades(next); try { const stored=JSON.parse(localStorage.getItem("ict-paper-trades-v1")??"[]"); const merged=new Map((Array.isArray(stored)?stored:[]).map((t:PaperTrade)=>[t.id,t])); next.forEach(t=>merged.set(t.id,t)); localStorage.setItem("ict-paper-trades-v1",JSON.stringify([...merged.values()])); } catch { setError("Browser storage unavailable; trades remain in this session."); } }
  function load() { try { const parsed=JSON.parse(localStorage.getItem("ict-paper-trades-v1")??"[]"); if(!Array.isArray(parsed))throw new Error(); setTrades(parsed.filter((t:PaperTrade)=>t && typeof t.id==="string" && [t.entry,t.stop,t.target,t.quantity,t.placedAt].every(Number.isFinite) && ["BUY","SELL"].includes(t.direction))); setError(""); } catch {setError("Saved paper trades could not be read.");} }
  function place() {
    if(!last)return;
    const sl=Number(stop),tp=Number(target),q=Number(quantity),sign=direction==="BUY"?1:-1;
    const entry=current.entry??last.c,placedAt=current.entryAt??last.knownAt;
    const observed=bars.find(b=>b.knownAt===placedAt);
    if(!Number.isFinite(entry)||!observed||entry<observed.l||entry>observed.h){setError("The selected entry anchor must be inside its revealed retest candle.");return;}
    if(!stop || !target || !Number.isFinite(sl) || !Number.isFinite(tp) || !Number.isFinite(q) || q<=0 || (entry-sl)*sign<=0 || (tp-entry)*sign<=0) {setError("Enter a valid stop, target and positive quantity for this direction.");return;}
    setError("");save([...trades,{id:crypto.randomUUID(),symbol,frame,direction,entry,stop:sl,target:tp,quantity:q,placedAt}]);
  }
  return <details open={initiallyOpen||undefined} className="mt-3 rounded border border-emerald-400/20 p-3"><summary className="cursor-pointer">Paper trading · {title}</summary><p className="mt-2 text-xs text-slate-400">{current.entry!==undefined?`Simulated selected retest entry at ${Number(current.entry.toFixed(6))}.`:"Simulated market entry at the latest revealed close."} Subsequent completed candles evaluate stop / target; an ambiguous candle uses stop first. P&amp;L is in price × quantity units, before fees. Saved locally in this browser; load saved trades on another chart to view its matching journal.</p><div className="mt-3 flex flex-wrap gap-3 text-xs"><label>Direction <select value={direction} onChange={e=>setDirection(e.target.value as "BUY"|"SELL")} className="bg-slate-900 p-2"><option>BUY</option><option>SELL</option></select></label>{[["Stop",stop,setStop],["Target",target,setTarget],["Quantity",quantity,setQuantity]] .map(([label,value,set])=><label key={label as string}>{label as string}<input aria-label={`${title} paper ${label}`} type="number" step="any" value={value as string} onChange={e=>(set as (v:string)=>void)(e.target.value)} className="ml-2 w-24 rounded bg-slate-900 p-2" /></label>)}<button disabled={!last} onClick={place} className="rounded border border-emerald-400/40 px-3">Open paper trade</button><button onClick={load} className="rounded border border-white/20 px-3">Load saved journal</button></div>{error ? <p role="alert" className="mt-2 text-amber-200">{error}</p>:null}<div className="mt-3 space-y-2 text-xs">{trades.filter(t=>t.symbol===symbol && t.frame===frame && t.placedAt<=(last?.knownAt??0)).map(t=>{const result=paperResult(t,bars);return <div key={t.id} className="rounded border border-white/10 p-2">{t.direction} · entry {t.entry} · SL {t.stop} · target {t.target} · qty {t.quantity} · {result.status} · P&amp;L {result.pnl.toFixed(2)} {result.status==="Open" && last ? <button className="ml-2 underline" onClick={()=>save(trades.map(row=>row.id===t.id?{...row,closedAt:last.knownAt,closePrice:last.c}:row))}>Close at revealed price</button>:null}</div>;})}</div></details>;
}
