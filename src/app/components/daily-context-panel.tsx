"use client";
import { useEffect, useMemo, useState, useCallback } from "react";
import { dailyContext, defaultContextReferences, type ReferencePoint } from "@/lib/daily-context";
import { instruments } from "@/lib/daily-bias";
import { weeklyReference, deriveIctOverlays, type ReplayData } from "@/lib/weekly-replay";
import WeeklyReplayChart from "./weekly-replay-chart";

const groups = ["Orderblocks", "FVG / IFVG", "Liquidity void candidates", "Liquidity pools / stop runs", "Equilibrium", "Breaker blocks"];
const emptyDays: string[] = [];
export default function DailyContextPanel({ symbol, onSymbolChange }: { symbol: string; onSymbolChange: (s: string) => void }) {
  const [selected,setSelected] = useState("");
  const [data, setData] = useState<ReplayData>();
  const [error, setError] = useState("");
  const [day, setDay] = useState("2026-01-06");
  const [from, setFrom] = useState("2026-01-01"), [to, setTo] = useState("2026-12-31");
  const [page, setPage] = useState(0), [enabled, setEnabled] = useState(groups);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/daily-bias/replay?symbol=${encodeURIComponent(symbol)}&tf=1d`, { signal: controller.signal, cache: "no-store" }).then(async r => { const d = await r.json(); if (!r.ok) throw Error(d.error); setData(d); setError(""); }).catch(e => { if (e.name !== "AbortError") setError(e.message); });
    return () => controller.abort();
  }, [symbol]);
  const loaded = data?.instrument.name === symbol ? data : undefined;
  const precision=loaded?.instrument.market==="forex" ? 5 : 2;
  const price=useCallback((n:number)=>n.toFixed(precision),[precision]);
  const days = useMemo(() => loaded?.daily.filter(b => b.day >= from && b.day <= to) ?? [], [loaded, from, to]);
  const chosenDay = days.some(b => b.day === day) ? day : days[0]?.day;
  const context = useMemo(() => loaded && chosenDay ? dailyContext(loaded, chosenDay) : null, [loaded, chosenDay]);
  const displayedPage = Math.min(page, Math.max(0, Math.ceil(days.length / 15) - 1));
  const rows = useMemo(() => loaded ? days.slice(displayedPage * 15, displayedPage * 15 + 15).map(b => dailyContext(loaded, b.day)!) : [], [loaded, days, displayedPage]);
  const referenceGroups = useMemo(() => context ? [context.orderblocks, context.gaps, context.voids, context.pools, context.equilibrium] : [], [context]);
  const plotted = useMemo(() => context ? defaultContextReferences(context).filter(p => enabled.includes(p.kind.includes("OB") ? groups[0] : p.kind.includes("FVG") ? groups[1] : p.kind.includes("void") ? groups[2] : p.kind.includes("equilibrium") ? groups[4] : groups[3])) : [], [context, enabled]);
  const bars = useMemo(() => loaded && context ? loaded.daily.filter(b => b.knownAt <= context.knownAt) : [], [loaded, context]);
  const chartZones=useMemo(()=>deriveIctOverlays(bars,"1d",loaded?.instrument.market??"us",bars).filter(z=>enabled.includes(z.kind==="BREAKER" ? groups[5] : z.kind==="OB" ? groups[0] : ["FVG","IFVG"].includes(z.kind) ? groups[1] : groups[3])),[bars,loaded,enabled]);
  const range = useMemo(() => loaded && chosenDay ? weeklyReference(loaded.daily.filter(b => b.day < chosenDay), chosenDay, loaded.invalidDailyDays) : null, [loaded, chosenDay]);
  return <section className="space-y-4 rounded-xl border border-amber-300/20 p-4" data-daily-context>
    <h2 className="text-xl font-semibold">Daily framework & institutional reference points</h2>
    <p className="text-sm text-slate-400">Every available completed daily candle is retained. Select a day to inspect Expansion, Retracement, Reversal and Consolidation, plus the price references behind the observation.</p>
    <div className="flex flex-wrap gap-3 text-sm">
      <label>Ticker <select aria-label="Daily context ticker" className="rounded bg-[#182130] p-2" value={symbol} onChange={e => { onSymbolChange(e.target.value); setPage(0); }}>{instruments.map(i => <option key={i.name}>{i.name}</option>)}</select></label>
      <label>From <input aria-label="Daily context from" className="rounded bg-[#182130] p-2" type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(0); }} /></label>
      <label>To <input aria-label="Daily context to" className="rounded bg-[#182130] p-2" type="date" value={to} onChange={e => { setTo(e.target.value); setPage(0); }} /></label>
      <label>Day <select aria-label="Daily context day" className="rounded bg-[#182130] p-2" value={chosenDay ?? ""} onChange={e => setDay(e.target.value)}>{days.map(b => <option key={b.day}>{b.day}</option>)}</select></label>
    </div>
    {error ? <p role="alert" className="text-red-300">{error}</p> : !loaded ? <p>Loading native daily candles…</p> : null}
    {loaded ? <p className="text-xs text-slate-400">{days.length} available sessions in this window · {loaded.instrument.zone}. Source audit: {loaded.audit.invalid} invalid rows, {loaded.audit.conflicts} conflicts. {loaded.invalidDailyDays.length ? `Excluded daily dates: ${loaded.invalidDailyDays.join(", ")}.` : "No invalid daily dates reported."} Missing exchange sessions cannot be proven without a calendar; holidays and missing rows are not fabricated.</p> : null}
    {loaded && !days.length ? <p className="text-amber-300">No completed native daily data for this ticker/date window.</p> : null}
    {context ? <>
      <div className="rounded border border-white/10 p-3"><strong>{context.day} · {context.primary}</strong><p className="mt-1 text-xs text-slate-400">O {price(context.candle.o)} · H {price(context.candle.h)} · L {price(context.candle.l)} · C {price(context.candle.c)}. This observation becomes known at {new Date(context.knownAt).toISOString()}, after the daily close. It is not a next-day entry signal.</p></div>
      <div className="grid gap-3 md:grid-cols-2">{context.states.map(s => <div key={s.label} className={`rounded border p-3 ${s.status === "MATCH" ? "border-amber-300/40 bg-amber-300/5" : "border-white/10"}`}><strong>{s.label} · {s.status}</strong><p className="mt-1 text-xs leading-5 text-slate-400">{s.evidence}</p></div>)}</div>
      <div className="flex flex-wrap gap-3 text-xs">{groups.map(g => <label key={g}><input type="checkbox" checked={enabled.includes(g)} onChange={e => setEnabled(current => e.target.checked ? [...current, g] : current.filter(x => x !== g))} /> {g}</label>)}</div>
      <p className="text-xs text-slate-400">By default the chart plots touched references, new structures, prior-day/week levels, latest clean pools and equilibrium. Other untouched references remain in the tables below. A new structure starts at its confirmation, not its origin candle.</p>
      <WeeklyReplayChart viewKey={symbol} completedDaily={bars} market={loaded?.instrument.market} bars={bars} title={`${symbol} · daily context ${context.day}`} frame="1d" invalidDays={loaded?.invalidDailyDays ?? emptyDays} range={range} target={null} zones={chartZones} referencePoints={plotted} framework={context.primary} showSwings showEquilibrium={false} selected={selected} onSelect={setSelected} onDaySelect={setDay} />
      <div className="grid gap-3 lg:grid-cols-2">{referenceGroups.map((points, i) => <details key={groups[i]} open className="rounded border border-white/10 p-3"><summary className="text-sm font-semibold">{groups[i]} · {points.length}</summary>{points.length ? <div className="mt-2 max-h-64 overflow-auto text-xs">{points.map((p: ReferencePoint, n) => <div key={`${p.kind}:${p.knownAt}:${n}`} className="border-t border-white/10 py-2"><strong>{p.kind} · {price(p.low)}{p.high !== p.low ? `–${price(p.high)}` : ""}</strong><p>{p.response}</p><p className="text-slate-500">Origin {p.originDay} · {p.timing} · known {new Date(p.knownAt).toISOString()}</p></div>)}</div> : <p className="mt-2 text-xs text-slate-400">No qualifying reference under the current local detector. This does not establish absence of a discretionary ICT structure.</p>}</details>)}</div>
    </> : null}
    {rows.length ? <div className="overflow-x-auto"><h3 className="mb-2 font-semibold">All days · includes neutral and unclassified candles</h3><table className="w-full text-left text-xs"><thead><tr>{["Day", "Framework", "OB", "FVG", "Voids", "Pools", "Equilibrium"].map(x => <th className="p-2" key={x}>{x}</th>)}</tr></thead><tbody>{rows.map(r => <tr key={r.day} className="border-t border-white/10"><td className="p-2"><button className="text-blue-300 underline" onClick={() => setDay(r.day)}>{r.day}</button></td><td className="p-2">{r.primary}</td>{[r.orderblocks.length, r.gaps.length, r.voids.length, r.pools.length, r.equilibrium.length].map((n,i) => <td className="p-2" key={i}>{n}</td>)}</tr>)}</tbody></table><div className="mt-3 flex gap-3"><button disabled={!displayedPage} onClick={() => setPage(displayedPage - 1)}>Previous days</button><span>Page {displayedPage + 1} / {Math.ceil(days.length / 15)}</span><button disabled={(displayedPage + 1) * 15 >= days.length} onClick={() => setPage(displayedPage + 1)}>Next days</button></div></div> : null}
    <details className="text-xs text-slate-400"><summary>Definitions, thresholds and limits</summary><p className="mt-2">Source: Month 1 PDF pages 4, 9, 11, 13, 15 and 17. Numeric thresholds and classification are local adaptations, not verbatim source rules. Several conditions can match. Primary-label order: Reversal, Expansion, Retracement, Consolidation; otherwise unclassified. Prior ATR14 uses completed preceding bars. Trend compares the preceding three-session close move. OB/FVG remain the existing replay candidate detectors.</p><p className="mt-2">Liquidity void candidate: one to three same-direction bodies, net move ≥ 2 × ATR14 known before the sequence, net move / impulse range ≥ 0.8. Bounds span first open to last close. OHLC cannot verify actual thin trading. Accumulated subsequent candle-range coverage retires the candidate; partial overlap is not full rebalance. Prior-day/week equilibrium is explicitly named. A pierced liquidity reference with a strict close back inside is a stop-run candidate, not proof of actual stops or institutional orders. Events use at most the replay detector’s 240-bar history; void search uses 60 sessions.</p></details>
  </section>;
}
