"use client";
import { useEffect, useMemo, useState } from "react";
import WeeklyReplayChart, { type ComparisonSegment } from "./weekly-replay-chart";
import { completedWeeklyBars, deriveIctOverlays, type ReplayData } from "@/lib/weekly-replay";
import { ipdaLookback } from "@/lib/ipda-lookback";
import type { ReferencePoint } from "@/lib/daily-context";
import { alignSmtBars, smtDivergences } from "@/lib/smt-divergence";
import type { ReplayFrame } from "@/lib/replay-timeline";
import type { ReplayInstrument } from "@/lib/replay-instruments";
const noSelect = () => {};
/** Deep link from a trade: /?tab=smt-divergence&smt_a=AAPL&smt_b=SPY&tf=5m&at=<ISO entry>&inverse=1 */
type SmtLink = { a: string; b: string; tf: ReplayFrame; at: number | null; inverse: boolean; loadWindow: string };
function readSmtLink(): SmtLink | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search);
  const a = q.get("smt_a"), b = q.get("smt_b");
  if (!a || !b) return null;
  const tf = (["5m", "15m", "30m", "1h", "1d", "1w"].includes(q.get("tf") ?? "") ? q.get("tf") : "5m") as ReplayFrame;
  const at = q.get("at") ? Date.parse(q.get("at")!) : Number.NaN;
  // Load a window around the entry (any year) from the backtest archive (barchart + SPY/QQQ index feed).
  const loadWindow = Number.isFinite(at) ? `&backtest=1&from=${new Date(at - 30 * 86400000).toISOString().slice(0, 10)}&through=${new Date(Math.min(Date.now(), at + 10 * 86400000)).toISOString().slice(0, 10)}` : "";
  return { a, b, tf, at: Number.isFinite(at) ? at : null, inverse: q.get("inverse") === "1", loadWindow };
}
const norm = (s: string) => s.toUpperCase().replace(/^(%5E|\^)/, "").replace(/^FOREX:/, "");
function resolveInstrument(catalog: ReplayInstrument[], wanted: string): string | null {
  const exact = catalog.find((i) => i.symbol === wanted || i.name === wanted);
  if (exact) return exact.name;
  return catalog.find((i) => norm(i.symbol) === norm(wanted) || norm(i.name) === norm(wanted))?.name ?? null;
}
export default function SmtDivergence() {
  const [link]=useState<SmtLink|null>(readSmtLink);
  const [catalog,setCatalog]=useState<ReplayInstrument[]>([]);
  const [a,setA]=useState(link?.a ?? "EURUSD"),[b,setB]=useState(link?.b ?? "forex:^GBPUSD");
  const [zonesOn,setZonesOn]=useState(true);
  const [frame,setFrame]=useState<ReplayFrame>(link?.tf ?? "1d"),[inverse,setInverse]=useState(link?.inverse ?? false);
  const [loaded,setLoaded]=useState<{key:string;a:ReplayData;b:ReplayData}|null>(null);
  const [error,setError]=useState(""),[at,setAt]=useState<number|null>(link?.at ?? null),[playing,setPlaying]=useState(false),[speed,setSpeed]=useState(800),[selected,setSelected]=useState("");
  const key=`${a}|${b}|${frame}`;
  const linkWindow=link?.loadWindow ?? "";
  useEffect(()=>{const abort=new AbortController();fetch("/api/top-down/instruments",{signal:abort.signal}).then(async r=>{const p=await r.json();if(!r.ok)throw new Error(p.error);return p;}).then(p=>{
    // Forex + dollar index first (the tab's original universe), then indices and stocks for trade deep links.
    const all=(p.instruments as ReplayInstrument[]);
    const rank=(i:ReplayInstrument)=>i.market==="forex" || /DX|DXY|USDX/i.test(i.symbol) ? 0 : i.market==="us" ? 1 : 2;
    setCatalog([...all].sort((x,y)=>rank(x)-rank(y) || x.symbol.localeCompare(y.symbol)));
    if(link){const ra=resolveInstrument(all,link.a),rb=resolveInstrument(all,link.b);if(ra)setA(ra);if(rb)setB(rb);if(!ra||!rb)setError(`Not in the replay catalogue: ${[!ra?link.a:"",!rb?link.b:""].filter(Boolean).join(", ")}`);}
  }).catch(e=>{if(e.name!=="AbortError")setError(e.message);});return ()=>abort.abort();},[link]);
  useEffect(()=>{const abort=new AbortController();Promise.all([a,b].map(async symbol=>{const r=await fetch(`/api/daily-bias/replay?symbol=${encodeURIComponent(symbol)}&tf=${frame==="1w" ? "1d" : frame}${linkWindow}`,{signal:abort.signal,cache:"no-store"});const p=await r.json();if(!r.ok)throw new Error(p.error);return p as ReplayData;})).then(([left,right])=>{setLoaded({key,a:left,b:right});setError("");}).catch(e=>{if(e.name!=="AbortError")setError(e.message);});return ()=>abort.abort();},[a,b,frame,key,linkWindow]);
  const pairs=useMemo(()=>{
    if(!loaded || loaded.key!==key)return [];
    const source=(data:ReplayData)=>frame==="1w" ? completedWeeklyBars(data.daily,new Date(data.generatedAt).toLocaleDateString("en-CA",{timeZone:data.instrument.zone}),data.invalidDailyDays) : data.bars;
    return alignSmtBars(source(loaded.a),source(loaded.b),frame);
  },[loaded,key,frame]);
  // Replay year: the linked trade's year, else 2026.
  const year=link?.at ? new Date(link.at).getUTCFullYear() : 2026;
  const timeline=useMemo(()=>pairs.filter(p=>p.a.day>=`${year}-01-01` && p.a.day<`${year+1}-01-01`),[pairs,year]);
  const cutoff=at ?? timeline[0]?.knownAt ?? 0;
  const index=timeline.findLastIndex(p=>p.knownAt<=cutoff);
  const revealed=useMemo(()=>pairs.filter(p=>p.knownAt<=cutoff),[pairs,cutoff]);
  const events=useMemo(()=>smtDivergences(pairs,frame,inverse,cutoff).filter(e=>new Date(e.knownAt).getUTCFullYear()===year),[pairs,frame,inverse,cutoff,year]);
  const marketA=catalog.find(i=>i.name===a)?.market ?? "forex";
  const marketB=catalog.find(i=>i.name===b)?.market ?? "forex";
  const drawn=useMemo(()=>events.filter((e,i)=>i>=events.length-12 || e.id===selected),[events,selected]);
  const aSegments=useMemo<ComparisonSegment[]>(()=>drawn.map(e=>({id:e.id,from:e.previousA,to:e.currentA,fromPrice:e.previousAPrice,toPrice:e.aPrice,direction:e.direction})),[drawn]);
  const bSegments=useMemo<ComparisonSegment[]>(()=>drawn.map(e=>({id:e.id,from:e.previousB,to:e.currentB,fromPrice:e.previousBPrice,toPrice:e.bPrice,direction:e.direction})),[drawn]);
  const aBars=useMemo(()=>revealed.map(p=>p.a),[revealed]),bBars=useMemo(()=>revealed.map(p=>p.b),[revealed]);
  const dailyA=useMemo(()=>loaded?.a.daily.filter(b=>b.knownAt<=cutoff)??[],[loaded,cutoff]);
  const dailyB=useMemo(()=>loaded?.b.daily.filter(b=>b.knownAt<=cutoff)??[],[loaded,cutoff]);
  const rangeReferences=(daily:ReplayData["daily"]):ReferencePoint[]=>{const last=daily.at(-1);if(!last)return [];const window=ipdaLookback(daily,last.day)?.windows[0];if(!window?.complete || !window.first || window.high===null || window.low===null)return [];return [{kind:"20-session daily range high · buy-side liquidity",low:window.high,high:window.high},{kind:"20-session daily range low · sell-side liquidity",low:window.low,high:window.low},{kind:"20-session daily range equilibrium",low:(window.high+window.low)/2,high:(window.high+window.low)/2}].map(r=>({...r,originDay:window.first!.day,knownAt:last.knownAt,timing:"Confirmed at close",response:"Explicit completed-session lookback range, not a certified current dealing range"}));};
  const refsA=useMemo(()=>rangeReferences(dailyA),[dailyA]);
  const refsB=useMemo(()=>rangeReferences(dailyB),[dailyB]);
  const zonesA=useMemo(()=>deriveIctOverlays(aBars,frame,marketA,dailyA),[aBars,frame,marketA,dailyA]);
  const zonesB=useMemo(()=>deriveIctOverlays(bBars,frame,marketB,dailyB),[bBars,frame,marketB,dailyB]);
  useEffect(()=>{if(!playing || index>=timeline.length-1)return;const timer=setInterval(()=>setAt(previous=>timeline.find(p=>p.knownAt>(previous??cutoff))?.knownAt??previous),speed);return ()=>clearInterval(timer);},[playing,index,timeline,speed,cutoff]);
  const change=()=>{setPlaying(false);setAt(null);setSelected("");setError("");};
  const step=(offset:number)=>{setPlaying(false);const p=timeline[index+offset];if(p)setAt(p.knownAt);};
  const label=(name:string)=>catalog.find(i=>i.name===name)?.symbol??name;
  return <section className="space-y-5" data-smt-divergence>
    <header className="rounded-xl border border-white/10 p-5"><h1 className="text-3xl font-semibold">SMC Divergence · SMT comparison</h1><p className="mt-2 text-sm text-slate-400">Compare correlated swings on one shared replay clock. Green: low-side divergence; red: high-side divergence, interpreted for the first instrument.</p></header>
    <div className="flex flex-wrap gap-4 rounded-xl border border-white/10 p-4">{(["a","b"] as const).map(side=><label key={side}>{side==="a" ? "First instrument" : "Comparison instrument"} <select aria-label={side==="a"?"First currency":"Comparison currency"} className="rounded bg-slate-900 p-2" value={side==="a"?a:b} onChange={e=>{change();(side==="a"?setA:setB)(e.target.value);}}>{catalog.map(i=><option key={i.name} value={i.name}>{i.symbol}</option>)}</select></label>)}<label><input type="checkbox" checked={zonesOn} onChange={e=>setZonesOn(e.target.checked)} /> ICT reference zones</label><label>Shared timeframe <select aria-label="SMT timeframe" className="rounded bg-slate-900 p-2" value={frame} onChange={e=>{change();setFrame(e.target.value as ReplayFrame);}}>{["5m","15m","30m","1h","1d","1w"].map(f=><option key={f} value={f}>{f==="1w"?"Weekly":f}</option>)}</select></label><label>Relationship <select aria-label="SMT relationship" className="rounded bg-slate-900 p-2" value={inverse?"inverse":"direct"} onChange={e=>{setPlaying(false);setSelected("");setInverse(e.target.value==="inverse");}}><option value="direct">Direct · highs ↔ highs, lows ↔ lows</option><option value="inverse">Inverse · highs ↔ lows</option></select></label><label>Replay date <input aria-label="SMT replay date" className="rounded bg-slate-900 p-2" type="date" value={index>=0 ? timeline[index].a.day : ""} onChange={e=>{setPlaying(false);const p=timeline.find(p=>p.a.day>=e.target.value);if(p)setAt(p.knownAt);}} /></label><button aria-label="SMT step backward" disabled={index<=0} onClick={()=>step(-1)} className="rounded border border-white/20 px-3 disabled:opacity-30">← Step</button><button aria-label={playing && index<timeline.length-1?"Pause SMT replay":"Play SMT replay"} disabled={!timeline.length || index>=timeline.length-1} onClick={()=>setPlaying(p=>!p)} className="rounded bg-amber-300 px-4 text-slate-950 disabled:opacity-30">{playing && index<timeline.length-1?"Pause":"▶ Play"}</button><button aria-label="SMT step forward" disabled={!timeline.length || index>=timeline.length-1} onClick={()=>step(1)} className="rounded border border-white/20 px-3 disabled:opacity-30">Step →</button><label>Speed <select className="rounded bg-slate-900 p-2" value={speed} onChange={e=>setSpeed(Number(e.target.value))}><option value={1600}>0.5×</option><option value={800}>1×</option><option value={400}>2×</option></select></label></div>
    {a===b ? <p role="alert">Select two different instruments.</p> : error ? <p role="alert" className="text-red-300">{error}</p> : !loaded || loaded.key!==key ? <p>Loading both candle histories…</p> : !timeline.length ? <p role="status">No shared completed {frame} candles in 2026 for these instruments. Available first frames: {catalog.find(i=>i.name===a)?.availableFrames.join(", ")||"none"}; comparison frames: {catalog.find(i=>i.name===b)?.availableFrames.join(", ")||"none"}. Missing candles are never forward-filled.</p> : <>
      <div className="rounded-xl border border-white/10 p-4"><input aria-label="SMT replay timeline" type="range" className="w-full" min={0} max={timeline.length-1} value={Math.max(0,index)} onChange={e=>{setPlaying(false);setAt(timeline[Number(e.target.value)].knownAt);}}/><p className="text-xs text-slate-400">As of {new Date(cutoff).toLocaleString("en-US",{timeZone:"America/New_York"})} New York · {revealed.length} shared completed bars · {events.length} revealed divergence points · {drawn.length} drawn. Both instruments must have a completed counterpart candle.</p></div>
      <div className="grid gap-4 xl:grid-cols-2">{(["a","b"] as const).map(side=><article key={side} className="min-w-0 rounded-xl border border-white/10 p-4"><WeeklyReplayChart viewKey={`${a}:${b}:${side}`} bars={side==="a"?aBars:bBars} title={label(side==="a"?a:b)} frame={frame} market={side==="a"?marketA:marketB} invalidDays={side==="a"?loaded.a.invalidDailyDays:loaded.b.invalidDailyDays} range={null} target={null} completedDaily={side==="a"?dailyA:dailyB} zones={zonesOn ? side==="a"?zonesA:zonesB : []} showSwings={false} showEquilibrium={false} selected={selected} onSelect={setSelected} onDaySelect={noSelect} referencePoints={side==="a"?refsA:refsB} comparisonSegments={side==="a"?aSegments:bSegments}/></article>)}</div>
      <div className="overflow-x-auto rounded-xl border border-white/10 p-4"><h2 className="mb-3 font-semibold">Divergence evidence · first instrument perspective</h2><table className="w-full text-left text-xs"><thead><tr><th>Confirmed at (NY)</th><th>Context</th><th>{label(a)} swing</th><th>{label(b)} paired extreme</th><th>Symmetry failure</th><th>Replay</th></tr></thead><tbody>{[...events].reverse().map(e=><tr key={e.id} className="border-t border-white/10"><td className="py-3">{new Date(e.knownAt).toLocaleString("en-US",{timeZone:"America/New_York"})}</td><td>{e.direction==="BUY"?"Bullish candidate":"Bearish candidate"} · {e.side}</td><td>{e.previousA.day} {e.previousAPrice.toFixed(5)} → {e.currentA.day} {e.aPrice.toFixed(5)}</td><td>{e.previousB.day} {e.previousBPrice.toFixed(5)} → {e.currentB.day} {e.bPrice.toFixed(5)}</td><td>{label(a)} {e.aBroke?"broke":"did not break"}; {label(b)} {e.bBroke?"broke":"did not break"} its corresponding extreme</td><td><button className="rounded border border-white/20 px-2 py-1" onClick={()=>{setPlaying(false);setSelected(e.id);setAt(e.knownAt);}}>Inspect</button></td></tr>)}</tbody></table>{!events.length ? <p className="mt-3 text-sm text-slate-400">No confirmed divergence at this replay time. Advance the clock.</p> : null}</div>
    </>}
    <details className="rounded-xl border border-white/10 p-4 text-xs text-slate-400"><summary>Detection rules, source and coverage</summary><p className="mt-2">Month 03, pages 55–59: correlated/inversely correlated swing symmetry and USDX SMT. Local implementation: strict three-bar pivot in the first instrument; compare the second instrument&apos;s extreme inside the same three-bar window with that of the previous same-side pivot window. Direct relationships compare high/high and low/low; inverse relationships compare high/low and low/high. Exactly one instrument breaking its prior extreme gives a divergence candidate; both breaking is symmetry, and neither breaking is not a new divergence. Equality counts as failure to break. Confirmation waits for both right-hand candles to close. These window-matching rules are explicit local choices, not a validated trade-entry model.</p><p className="mt-2">Correlation is selected by you, not inferred from pair names or certified by this view. Intraday timestamps must match exactly; daily and weekly period keys must match. Missing counterparts are skipped; gaps interrupt pivot comparisons. Data warmup is retained, replay covers stored 2026 candles. Divergence suggests non-confirmation; OHLC alone cannot prove accumulation or distribution.</p>{!catalog.some(i=>/DX|DXY|USDX/i.test(i.symbol))?<p className="mt-2 text-amber-200">No USDX/DXY instrument exists in the stored catalog. Currency-pair comparisons are available; a synthetic USDX is not substituted.</p>:null}</details>
  </section>;
}
