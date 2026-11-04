"use client";

import { useEffect, useMemo, useState } from "react";
import { bucketContains,planForBucket, riskBucketLabels, type RiskBucket } from "@/lib/mss-risk-buckets";
import {walkOutcome,type OutcomeMode,type OutcomePlan,type FutureOutcomeData} from '@/lib/mss-outcomes';
import type { MssResult } from "./market-structure-shift";

/* ---------------------------------------------------------------------------
   MSS analytics: every retest entry of the loaded investigation is walked forward
   on the TF2 candles with its structural plan (sweep stop, liquidity target in the
   selected R:R bucket). Stop is assumed first when stop and target share a candle.
   Entries without a READY plan are counted but not traded.
--------------------------------------------------------------------------- */

type Outcome = "WIN" | "LOSS" | "OPEN" | "END";
export type MssTrade = {
  key: string; contextId: string; zoneId: string; side: "BUY" | "SELL"; array: string; shift: string; htf: string;
  entryAt: number; knownAt: number; entry: number; stop: number; target: number; rr: number;
  outcome: Outcome; r: number; exitAt: number | null; holdMin: number | null; day: string; weekday: number; hour: number;
};
type SortKey = "entryAt" | "side" | "array" | "shift" | "htf" | "entry" | "stop" | "target" | "rr" | "outcome" | "r" | "exitAt" | "holdMin";

const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const shiftType = (label?: string, mode?: string) => label === "CISD" ? "CISD" : label === "LOCAL_SHIFT" ? `Local · ${mode ?? "close"}` : `CHOCH · ${mode ?? "close"}`;

function stats(trades: MssTrade[]) {
  const closed = trades.filter(t => t.outcome !== "OPEN");
  const wins = closed.filter(t => t.r > 0), losses = closed.filter(t => t.r < 0);
  const rs = closed.map(t => t.r);
  const net = rs.reduce((a, b) => a + b, 0);
  const gw = wins.reduce((a, t) => a + t.r, 0), gl = -losses.reduce((a, t) => a + t.r, 0);
  const mean = rs.length ? net / rs.length : null;
  const sd = rs.length > 1 ? Math.sqrt(rs.reduce((a, r) => a + (r - mean!) ** 2, 0) / (rs.length - 1)) : null;
  const down = rs.filter(r => r < 0);
  const dsd = down.length ? Math.sqrt(down.reduce((a, r) => a + r * r, 0) / rs.length) : null;
  let eq = 0, peak = 0, dd = 0, cw = 0, cl = 0, mw = 0, ml = 0;
  for (const t of [...closed].sort((a, b) => a.entryAt - b.entryAt)) {
    eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    if (t.r > 0) { cw++; cl = 0; } else if(t.r<0) { cl++; cw = 0; } else {cw=0;cl=0;}
    mw = Math.max(mw, cw); ml = Math.max(ml, cl);
  }
  const holds = closed.flatMap(t => t.holdMin == null ? [] : [t.holdMin]);
  return {
    n: trades.length, buys: trades.filter(t => t.side === "BUY").length, sells: trades.filter(t => t.side === "SELL").length,
    closed: closed.length, open: trades.length - closed.length, wins: wins.length, losses: losses.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : null, net, expectancy: mean,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : null,
    avgWin: wins.length ? gw / wins.length : null, avgLoss: losses.length ? -gl / losses.length : null,
    avgRR: trades.length ? trades.reduce((a, t) => a + t.rr, 0) / trades.length : null,
    sharpe: mean != null && sd ? mean / sd : null, sortino: mean != null && dsd ? mean / dsd : null,
    maxDD: dd, recovery: dd > 0 ? net / dd : null, maxWinStreak: mw, maxLossStreak: ml,
    avgHold: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
    breakevenWR: trades.length ? 100 / (1 + trades.reduce((a, t) => a + t.rr, 0) / trades.length) : null,
  };
}
type Stats = ReturnType<typeof stats>;

const f = (v: number | null | undefined, d = 2) => v == null || !Number.isFinite(v) ? (v === Infinity ? "∞" : "–") : v.toFixed(d);
const fr = (v: number | null | undefined, d = 2) => v == null || !Number.isFinite(v) ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(d)}R`;
const tone = (v: number | null | undefined) => v == null || !Number.isFinite(v) || v === 0 ? "text-slate-200" : v > 0 ? "text-emerald-300" : "text-rose-300";
const holdLabel = (m: number | null) => m == null ? "–" : m >= 1440 ? `${(m / 1440).toFixed(1)}d` : m >= 60 ? `${(m / 60).toFixed(1)}h` : `${Math.round(m)}m`;

/** green for +R, red for -R; alpha scaled by magnitude vs. the largest cell. */
function heat(v: number | null, max: number) {
  if (v == null) return "rgba(148,163,184,0.06)";
  if (v === 0) return "rgba(148,163,184,0.18)";
  const a = 0.18 + 0.72 * Math.min(1, Math.abs(v) / (max || 1));
  return v > 0 ? `rgba(16,185,129,${a.toFixed(2)})` : `rgba(244,63,94,${a.toFixed(2)})`;
}

export default function MssAnalytics({ data, rrBucket, onInspect,exitMode,onExitModeChange,onFutureData }: {
  data: MssResult; rrBucket: RiskBucket;
  onInspect?: (t: MssTrade) => void;
  exitMode:OutcomeMode;onExitModeChange:(mode:OutcomeMode)=>void;
  onFutureData:(source:MssResult,future:FutureOutcomeData)=>void;
}) {
  const zone = data.instrument.zone || "America/New_York";
  const digits = data.instrument.market === "forex" ? (/JPY/.test(data.instrument.symbol) ? 3 : 5) : 2;
  const [sort, setSort] = useState<{ k: SortKey; asc: boolean }>({ k: "entryAt", asc: false });
  const [heatMetric, setHeatMetric] = useState<"net" | "wr" | "n">("net");
  const [sideFilter, setSideFilter] = useState<"ALL" | "BUY" | "SELL">("ALL");
  const bands:RiskBucket[]=['0-1','1-2','2-3','3-4','4+'];
  const [rrFilters,setRrFilters]=useState<RiskBucket[]>(bands);
  const [extension,setExtension]=useState<{key:string;payload?:FutureOutcomeData;error?:string}|null>(null);

  const { trades:nativeTrades, skipped } = useMemo(() => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" });
    const local = (t: number) => {
      const p = Object.fromEntries(parts.formatToParts(new Date(t)).map(x => [x.type, x.value]));
      return { day: `${p.year}-${p.month}-${p.day}`, weekday: Math.max(0, WD.indexOf(String(p.weekday).slice(0, 3))), hour: Number(p.hour) % 24 };
    };
    const bars = [...data.lower].sort((a, b) => a.t - b.t);
    const seen = new Set<string>();
    const out: MssTrade[] = [];
    let skipped = 0;
    for (const inv of data.investigations) {
      if (!inv.mss) continue;
      for (const a of inv.arrays) {
        const e = a.entry;
        if (!e) continue;
        const key = `${a.zone.id}:${e.at}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const plan = e.plan ? planForBucket(e.plan, rrBucket) : undefined;
        if (!plan || plan.state !== "READY" || plan.target == null || plan.rr == null) { skipped++; continue; }
        const risk = (plan.direction === "BUY" ? 1 : -1) * (plan.entry - plan.stop);
        if (!(risk > 0)) { skipped++; continue; }
        const {outcome,r,exitAt}=walkOutcome({key,direction:plan.direction,entryAt:e.at,entry:plan.entry,stop:plan.stop,target:plan.target},bars,exitMode);
        const loc = local(e.at);
        out.push({
          key, contextId: inv.id, zoneId: a.zone.id, side: plan.direction, array: a.zone.kind,
          shift: shiftType(inv.mss.label, inv.mss.breakMode), htf: inv.htf.kind,
          entryAt: e.at, knownAt: e.knownAt, entry: plan.entry, stop: plan.stop, target: plan.target, rr: plan.rr,
          outcome, r, exitAt, holdMin: exitAt == null ? null : (exitAt - e.at) / 60000, ...loc,
        });
      }
    }
    return { trades: out, skipped };
  }, [data, rrBucket, zone,exitMode]);

  const pending=useMemo(()=>nativeTrades.filter(t=>t.outcome==='OPEN').map(t=>({key:t.key,direction:t.side,entryAt:t.entryAt,entry:t.entry,stop:t.stop,target:t.target} satisfies OutcomePlan)),[nativeTrades]);
  const historyKey=JSON.stringify({symbol:data.selection.symbol,tf1:data.selection.tf1,tf2:data.selection.tf2,end:data.selection.end,plans:pending});
  useEffect(()=>{
    if(exitMode!=='UNTIL_HIT'||!pending.length)return;
    const abort=new AbortController();
    async function extend(){try{
      const response=await fetch('/api/market-structure-shift/outcomes',{method:'POST',headers:{'Content-Type':'application/json'},body:historyKey,signal:abort.signal});
      const payload=await response.json();if(!response.ok)throw new Error(payload.error);
      if(!abort.signal.aborted){setExtension({key:historyKey,payload});onFutureData(data,payload);}
    }catch(e){if(!abort.signal.aborted)setExtension({key:historyKey,error:e instanceof Error?e.message:'Outcome extension unavailable.'});}}
    void extend();return()=>abort.abort();
  },[historyKey,exitMode,pending.length,data,onFutureData]);
  const history=extension?.key===historyKey?extension.payload:undefined;
  const futureLoading=exitMode==='UNTIL_HIT'&&pending.length>0&&extension?.key!==historyKey;
  const trades=useMemo(()=>nativeTrades.map(t=>{
    const future=exitMode==='UNTIL_HIT'&&t.outcome==='OPEN'?history?.outcomes[t.key]:undefined;
    return future?{...t,outcome:future.outcome,r:future.r,exitAt:future.exitAt,holdMin:future.exitAt===null?null:(future.exitAt-t.entryAt)/60000}:t;
  }),[nativeTrades,history,exitMode]);

  const view = useMemo(() => trades.filter(t => (sideFilter === "ALL" || t.side === sideFilter)&&rrFilters.some(b=>bucketContains(t.rr,b))), [trades, sideFilter,rrFilters]);
  const all = useMemo(() => stats(view), [view]);

  // previous 7 calendar days, ending on the selected end date
  const last7 = useMemo(() => {
    const end = Date.parse(data.selection.end + "T00:00:00Z");
    const days = Array.from({ length: 7 }, (_, i) => new Date(end - (6 - i) * 86400000).toISOString().slice(0, 10));
    const inWin = view.filter(t => t.day >= days[0] && t.day <= days[6]);
    return { days, s: stats(inWin), perDay: days.map(d => ({ day: d, ...stats(inWin.filter(t => t.day === d)) })) };
  }, [view, data.selection.end]);

  const equity = useMemo(() => {
    let eq = 0, peak = 0;
    const points: {t:number;eq:number;dd:number}[] = [];
    for (const t of [...view].filter(t => t.outcome !== "OPEN").sort((a, b) => a.entryAt - b.entryAt)) {
      eq += t.r; peak = Math.max(peak, eq); points.push({t:t.entryAt,eq,dd:eq-peak});
    }
    return points;
  }, [view]);

  // weekday x hour heatmap
  const hourGrid = useMemo(() => {
    const hours = view.length ? [...new Set(view.map(t => t.hour))].sort((a, b) => a - b) : Array.from({length:24}, (_, h) => h);
    const days = view.length ? [...new Set(view.map(t => t.weekday))].sort((a, b) => a - b) : WD.map((_, d) => d);
    const cell = (d: number, h: number) => { const ts = view.filter(t => t.weekday === d && t.hour === h); return ts.length ? stats(ts) : null; };
    const grid = days.map(d => ({ d, cells: hours.map(h => ({ h, s: cell(d, h) })) }));
    return { hours, grid };
  }, [view]);

  // calendar heatmap (net R per day)
  const calendar = useMemo(() => {
    const byDay = new Map<string, MssTrade[]>();
    for (const t of view) byDay.set(t.day, [...(byDay.get(t.day) ?? []), t]);
    const first = Date.parse(data.selection.start + "T00:00:00Z"), last = Date.parse(data.selection.end + "T00:00:00Z");
    const startMon = first - ((new Date(first).getUTCDay() + 6) % 7) * 86400000;
    const weeks: { day: string; inRange: boolean; s: Stats | null }[][] = [];
    for (let w = startMon; w <= last; w += 7 * 86400000) {
      weeks.push(Array.from({ length: 7 }, (_, i) => {
        const day = new Date(w + i * 86400000).toISOString().slice(0, 10);
        const ts = byDay.get(day);
        return { day, inRange: w + i * 86400000 >= first && w + i * 86400000 <= last, s: ts ? stats(ts) : null };
      }));
    }
    return weeks.length > 60 ? weeks.slice(-60) : weeks;
  }, [view, data.selection.start, data.selection.end]);

  const matrix = (rowKey: (t: MssTrade) => string, colKey: (t: MssTrade) => string) => {
    const rows = [...new Set(view.map(rowKey))].sort(), cols = [...new Set(view.map(colKey))].sort();
    return { rows, cols, cell: (r: string, c: string) => { const ts = view.filter(t => rowKey(t) === r && colKey(t) === c); return ts.length ? stats(ts) : null; } };
  };
  const rrBand = (t: MssTrade) => t.rr < 1 ? "0–1" : t.rr < 2 ? "1–2" : t.rr < 3 ? "2–3" : t.rr < 4 ? "3–4" : "4+";
  const arrayShift = useMemo(() => matrix(t => t.array, t => t.shift), [view]); // eslint-disable-line react-hooks/exhaustive-deps
  const rrSide = useMemo(() => matrix(rrBand, t => t.side), [view]); // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = useMemo(() => {
    const dir = sort.asc ? 1 : -1;
    return [...view].sort((a, b) => {
      const va = a[sort.k], vb = b[sort.k];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb))) * dir || (a.entryAt - b.entryAt) * dir;
    });
  }, [view, sort]);
  const [page, setPage] = useState(0);
  const time = (t: number | null) => t == null ? "–" : new Date(t).toLocaleString("en-US", { timeZone: zone, month: "short", day: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

  const metricValue = (s: Stats | null) => !s ? null : heatMetric === "net" ? s.net : heatMetric === "wr" ? (s.winRate == null ? null : s.winRate - (s.breakevenWR ?? 50)) : s.n;
  const metricText = (s: Stats | null) => !s ? "" : heatMetric === "net" ? fr(s.net, 1) : heatMetric === "wr" ? `${f(s.winRate, 0)}%` : String(s.n);
  const maxOf = (vals: (number | null)[]) => Math.max(1e-9, ...vals.map(v => Math.abs(v ?? 0)));
  const heatColor = (s: Stats | null, max: number) => heatMetric === "n" ? (s ? `rgba(56,189,248,${(0.15 + 0.75 * s.n / max).toFixed(2)})` : heat(null, 1)) : heat(metricValue(s), max);

  const Card = ({ label, value, cls = "text-slate-100", sub }: { label: string; value: string; cls?: string; sub?: string }) =>
    <div className="rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2"><p className="text-[10px] uppercase tracking-wider text-slate-400">{label}</p><p className={`mt-0.5 font-mono text-lg ${cls}`}>{value}</p>{sub ? <p className="text-[10px] text-slate-500">{sub}</p> : null}</div>;

  const cardsFor = (s: Stats) => [
    <Card key="n" label="Trades" value={String(s.n)} sub={`${s.buys} buy · ${s.sells} sell · ${s.open} open`} />,
    <Card key="wr" label="Win rate" value={`${f(s.winRate, 1)}%`} cls={s.winRate != null && s.breakevenWR != null ? (s.winRate >= s.breakevenWR ? "text-emerald-300" : "text-rose-300") : undefined} sub={`${s.wins}W / ${s.losses}L · BE ${f(s.breakevenWR, 0)}%`} />,
    <Card key="net" label="Net R" value={fr(s.net)} cls={tone(s.net)} />,
    <Card key="exp" label="Expectancy" value={fr(s.expectancy, 3)} cls={tone(s.expectancy)} sub="per closed trade" />,
    <Card key="pf" label="Profit factor" value={f(s.pf)} cls={s.pf == null ? undefined : s.pf >= 1 ? "text-emerald-300" : "text-rose-300"} />,
    <Card key="rr" label="Avg planned R:R" value={`1:${f(s.avgRR)}`} sub={`avg win ${fr(s.avgWin)} · loss ${fr(s.avgLoss)}`} />,
    <Card key="dd" label="Max drawdown" value={s.maxDD ? `-${s.maxDD.toFixed(2)}R` : "0R"} cls={s.maxDD ? "text-rose-300" : undefined} />,
    <Card key="sh" label="Trade Sharpe" value={f(s.sharpe)} sub={`Sortino ${f(s.sortino)}`} />,
    <Card key="rf" label="Recovery factor" value={f(s.recovery)} sub="net R ÷ max DD" />,
    <Card key="st" label="Streaks" value={`${s.maxWinStreak}W / ${s.maxLossStreak}L`} sub="max consecutive" />,
    <Card key="ho" label="Avg hold" value={holdLabel(s.avgHold)} sub="closed trades" />,
  ];

  // equity curve svg
  const W = 640, H = 150, P = 6;
  const eqMin = Math.min(0, ...equity.map(p => p.eq)), eqMax = Math.max(0, ...equity.map(p => p.eq));
  const x = (i: number) => P + (equity.length <= 1 ? 0 : (i / (equity.length - 1)) * (W - 2 * P));
  const y = (v: number) => H - P - ((v - eqMin) / ((eqMax - eqMin) || 1)) * (H - 2 * P);
  const line = equity.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.eq).toFixed(1)}`).join("");
  // drawdown band: between running peak (eq - dd) and equity
  const ddArea = equity.length ? equity.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.eq - p.dd).toFixed(1)}`).join("") + [...equity].reverse().map((p, j) => `L${x(equity.length - 1 - j).toFixed(1)},${y(p.eq).toFixed(1)}`).join("") + "Z" : "";

  const renderHeader = (k:SortKey, label:string, right=false) =>
    <th key={k} aria-sort={sort.k === k ? (sort.asc ? "ascending" : "descending") : "none"} className={`whitespace-nowrap px-2 py-2 ${right ? "text-right" : "text-left"}`}>
      <button className={`hover:text-amber-200 ${sort.k === k ? "text-amber-300" : ""}`} onClick={() => { setSort(c => c.k === k ? { k, asc: !c.asc } : { k, asc: k === "entryAt" ? false : true }); setPage(0); }}>
        {label}{sort.k === k ? (sort.asc ? " ↑" : " ↓") : ""}
      </button>
    </th>;

  const renderMatrix = (title:string, m:ReturnType<typeof matrix>) => {
    const max = maxOf(m.rows.flatMap(r => m.cols.map(c => heatMetric === "n" ? m.cell(r, c)?.n ?? 0 : metricValue(m.cell(r, c)))));
    return <div className="min-w-0"><p className="mb-2 text-xs font-semibold text-slate-300">{title}</p><div className="overflow-x-auto"><table className="text-[11px]"><thead><tr><th />{m.cols.map(c => <th key={c} className="px-1 pb-1 font-normal text-slate-400">{c}</th>)}</tr></thead><tbody>{m.rows.map(r => <tr key={r}><td className="pr-2 text-right text-slate-400">{r}</td>{m.cols.map(c => { const s = m.cell(r, c); return <td key={c} title={s ? `${r} · ${c}\n${s.n} trades · WR ${f(s.winRate, 1)}% · net ${fr(s.net)} · PF ${f(s.pf)}` : "no trades"} className="h-9 min-w-16 rounded border border-slate-950 text-center font-mono" style={{ background: heatColor(s, max) }}>{metricText(s)}{s ? <span className="block text-[9px] text-white/60">{s.n}t</span> : null}</td>; })}</tr>)}</tbody></table></div></div>;
  };

  const hourMax = maxOf(hourGrid.grid.flatMap(r => r.cells.map(c => heatMetric === "n" ? c.s?.n ?? 0 : metricValue(c.s))));
  const calMax = calendar ? maxOf(calendar.flat().map(c => heatMetric === "n" ? c.s?.n ?? 0 : metricValue(c.s))) : 1;
  const l7max = maxOf(last7.perDay.map(d => d.net));

  return <section id="mss-analytics" aria-label="MSS metrics and visuals" className="scroll-mt-4 space-y-4 rounded-xl border border-amber-300/20 bg-gradient-to-b from-amber-300/[0.04] to-transparent p-4">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><p className="text-xs tracking-widest text-amber-300">MSS ANALYTICS</p><h2 className="text-xl font-semibold">Retest entries · {riskBucketLabels[rrBucket]}</h2>
        <p className="text-xs text-slate-400">{trades.length} unique entries from {data.selection.start}–{data.selection.end}, evaluated on {data.selection.tf2} candles · stop at sweep extreme, target = liquidity in the selected bucket · same-candle stop+target counted as loss · {skipped} entries without a READY plan excluded.</p></div>
      <div className="flex gap-2 text-xs">
        {(["ALL", "BUY", "SELL"] as const).map(s => <button key={s} onClick={() => { setSideFilter(s); setPage(0); }} className={`rounded border px-3 py-1.5 ${sideFilter === s ? "border-amber-300 bg-amber-300/15 text-amber-200" : "border-white/15 text-slate-300"}`}>{s}</button>)}
      </div>
    </div>

    <div className="flex flex-wrap items-start gap-4 text-sm">
      <details className="rounded-lg border border-white/15 p-2"><summary className="cursor-pointer">R:R buckets · {rrFilters.length===bands.length?'ALL':rrFilters.length?rrFilters.join(', '):'None'}</summary><fieldset aria-label="MSS analytics R:R buckets" className="mt-2 flex flex-wrap gap-3">{bands.map(b=><label key={b} className="flex items-center gap-1"><input type="checkbox" aria-label={`Filter ${riskBucketLabels[b]}`} checked={rrFilters.includes(b)} onChange={e=>{setRrFilters(v=>e.target.checked?[...v,b]:v.filter(x=>x!==b));setPage(0);}}/>{riskBucketLabels[b]}</label>)}</fieldset><button className="mr-3 mt-2 text-amber-200" onClick={()=>{setRrFilters(bands);setPage(0);}}>Select all R:R buckets</button><button className="text-slate-300" onClick={()=>{setRrFilters([]);setPage(0);}}>Clear R:R buckets</button></details>
      <label>Close trades <select aria-label="MSS outcome close mode" value={exitMode} onChange={e=>onExitModeChange(e.target.value as OutcomeMode)} className="ml-2 rounded bg-slate-900 p-2"><option value="UNTIL_HIT">Until stop or target · default</option><option value="CLOSE_BY_END">Close by end date</option></select></label>
    </div>
    <p className="text-xs text-slate-400">R:R boxes filter the existing planned ratios and update every metric and visual. They do not move stops or targets. Use Target R:R bucket in the chart controls to choose another existing liquidity target.</p>
    <p role="status" className="text-xs text-slate-400">{exitMode==='CLOSE_BY_END'?`Unresolved trades close at the last completed TF2 candle on or before ${data.selection.end}; shown as END.`:futureLoading?'Loading later candles until unresolved trades reach their stop or target…':extension?.key===historyKey&&extension.error?`Later history could not be loaded: ${extension.error} Unresolved trades remain OPEN.`:history?`Outcome candles scanned through ${history.scannedThrough}; ${history.unresolved} trades remain OPEN at the available-history boundary. Setups are still restricted to the selected entry dates.`:'Trades resolved inside the selected dates. Until stop or target mode will extend history when needed.'}</p>

    {!view.length?<p role="status" className="rounded-lg border border-amber-300/20 p-3 text-sm text-slate-300">{trades.length?`No trades match the selected side and R:R buckets. Select ALL and all R:R buckets to see the available entries.`:`No eligible trades for ${riskBucketLabels[rrBucket]}. ${data.investigations.reduce((n,i)=>n+i.arrays.filter(a=>a.rejectedEntry).length,0)} retest contexts held by requirements; ${skipped} distinct entries lack a READY structural plan. Metrics show zero trades; blank heatmap cells mean no observations. Review the selected requirements or target bucket.`}</p>:null}

    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-6">{cardsFor(all)}</div>

    <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
      <div className="rounded-lg border border-white/10 p-3">
        <div className="mb-1 flex items-center justify-between text-xs"><span className="font-semibold text-slate-300">Equity curve (cumulative R, closed trades by entry time)</span><span className={`font-mono ${tone(all.net)}`}>{fr(all.net)}</span></div>
        <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" preserveAspectRatio="none" role="img" aria-label="Equity curve in R">
          <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} stroke="rgba(148,163,184,0.35)" strokeDasharray="3 3" />
          <path d={ddArea} fill="rgba(244,63,94,0.18)" />
          <path d={line} fill="none" stroke={all.net >= 0 ? "#34d399" : "#fb7185"} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
        <p className="text-[10px] text-slate-500">Red band = drawdown from running peak.</p>
      </div>
      <div className="rounded-lg border border-white/10 p-3">
        <div className="mb-2 flex items-center justify-between text-xs"><span className="font-semibold text-slate-300">Previous 7 days · {last7.days[0]} → {last7.days[6]}</span><span className={`font-mono ${tone(last7.s.net)}`}>{fr(last7.s.net)}</span></div>
        <div className="grid grid-cols-7 gap-1">{last7.perDay.map(d => <div key={d.day} title={`${d.day}: ${d.n} trades · ${d.wins}W/${d.losses}L · ${fr(d.net)}`} className="flex flex-col items-center">
          <div className="flex h-20 w-full items-end justify-center rounded bg-slate-900/60">{d.n ? <div className="w-3/5 rounded-t" style={{ height: `${Math.max(6, (Math.abs(d.net) / l7max) * 100)}%`, background: d.net >= 0 ? "#34d399" : "#fb7185" }} /> : null}</div>
          <span className="mt-1 text-[10px] text-slate-400">{WD[(new Date(d.day + "T00:00:00Z").getUTCDay() + 6) % 7]}</span><span className="font-mono text-[10px] text-slate-300">{d.n ? `${d.n}t` : "·"}</span></div>)}</div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
          <div><span className="text-slate-500">Trades</span><p className="font-mono">{last7.s.n} <span className="text-slate-500">({last7.s.buys}B/{last7.s.sells}S)</span></p></div>
          <div><span className="text-slate-500">Win rate</span><p className="font-mono">{f(last7.s.winRate, 1)}% <span className="text-slate-500">vs {f(all.winRate, 0)}%</span></p></div>
          <div><span className="text-slate-500">Expectancy</span><p className={`font-mono ${tone(last7.s.expectancy)}`}>{fr(last7.s.expectancy)}</p></div>
          <div><span className="text-slate-500">PF</span><p className="font-mono">{f(last7.s.pf)}</p></div>
          <div><span className="text-slate-500">Max DD</span><p className="font-mono text-rose-300">{last7.s.maxDD ? `-${last7.s.maxDD.toFixed(2)}R` : "0R"}</p></div>
          <div><span className="text-slate-500">Open</span><p className="font-mono">{last7.s.open}</p></div>
        </div>
      </div>
    </div>

    <div id="mss-heatmaps" className="scroll-mt-4 rounded-lg border border-white/10 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Heatmaps</h3>
        <div className="flex gap-1 text-xs">{([["net", "Net R"], ["wr", "Win rate (vs breakeven)"], ["n", "Trade count"]] as const).map(([k, l]) => <button key={k} onClick={() => setHeatMetric(k)} className={`rounded border px-2.5 py-1 ${heatMetric === k ? "border-amber-300 bg-amber-300/15 text-amber-200" : "border-white/15 text-slate-300"}`}>{l}</button>)}</div></div>
      <div className="grid gap-5 xl:grid-cols-2">
        <div className="min-w-0"><p className="mb-2 text-xs font-semibold text-slate-300">Entry weekday × hour ({zone})</p><div className="overflow-x-auto"><table className="text-[11px]"><thead><tr><th />{hourGrid.hours.map(h => <th key={h} className="px-0.5 pb-1 font-normal text-slate-400">{String(h).padStart(2, "0")}</th>)}</tr></thead><tbody>{hourGrid.grid.map(r => <tr key={r.d}><td className="pr-2 text-right text-slate-400">{WD[r.d]}</td>{r.cells.map(c => <td key={c.h} title={c.s ? `${WD[r.d]} ${String(c.h).padStart(2, "0")}:00\n${c.s.n} trades · WR ${f(c.s.winRate, 1)}% · net ${fr(c.s.net)}` : "no trades"} className="h-9 min-w-10 rounded border border-slate-950 text-center font-mono" style={{ background: heatColor(c.s, hourMax) }}>{metricText(c.s)}</td>)}</tr>)}</tbody></table></div></div>
        {calendar ? <div className="min-w-0"><p className="mb-2 text-xs font-semibold text-slate-300">Calendar · daily result</p><div className="flex gap-1 overflow-x-auto"><div className="flex flex-col gap-1 pr-1 text-[10px] text-slate-500">{WD.map(d => <span key={d} className="h-6 leading-6">{d}</span>)}</div>{calendar.map((w, i) => <div key={i} className="flex flex-col gap-1">{w.map(c => <div key={c.day} title={`${c.day}${c.s ? `\n${c.s.n} trades · ${c.s.wins}W/${c.s.losses}L · ${fr(c.s.net)}` : ""}`} className="h-6 w-6 rounded" style={{ background: c.inRange ? heatColor(c.s, calMax) : "transparent" }} />)}</div>)}</div><p className="mt-2 text-[10px] text-slate-500">Hover a square for the day&apos;s trades. Latest 60 weeks shown.</p></div> : null}
        {renderMatrix("Entry array × shift confirmation",arrayShift)}
        {renderMatrix("Planned R:R band × side",rrSide)}
      </div>
    </div>

    <div className="overflow-x-auto rounded-lg border border-white/10 p-3">
      <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold">Trades · one row per entry</h3><span className="text-[11px] text-slate-400">Click a header to sort · click a row to replay it</span></div>
      <table className="w-full text-xs"><thead className="text-slate-400"><tr>
        {renderHeader("entryAt","Entry datetime")}{renderHeader("side","Side")}{renderHeader("array","Array")}{renderHeader("shift","Shift")}{renderHeader("htf","HTF level")}
        {renderHeader("entry","Entry",true)}{renderHeader("stop","SL",true)}{renderHeader("target","TP",true)}{renderHeader("rr","R:R",true)}
        {renderHeader("outcome","Result")}{renderHeader("r","R",true)}{renderHeader("exitAt","Exit datetime")}{renderHeader("holdMin","Hold",true)}
      </tr></thead><tbody>{sorted.slice(page * 50, (page + 1) * 50).map(t => <tr key={t.key} onClick={() => onInspect?.(t)} className="cursor-pointer border-t border-white/5 hover:bg-white/5">
        <td className="whitespace-nowrap px-2 py-1.5">{time(t.entryAt)}</td>
        <td className={`px-2 ${t.side === "BUY" ? "text-emerald-300" : "text-rose-300"}`}>{t.side}</td>
        <td className="px-2">{t.array}</td><td className="whitespace-nowrap px-2 text-slate-300">{t.shift}</td><td className="px-2 text-slate-400">{t.htf}</td>
        <td className="px-2 text-right font-mono">{t.entry.toFixed(digits)}</td><td className="px-2 text-right font-mono">{t.stop.toFixed(digits)}</td><td className="px-2 text-right font-mono">{t.target.toFixed(digits)}</td>
        <td className="px-2 text-right font-mono">1:{t.rr.toFixed(2)}</td>
        <td className="px-2"><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${t.outcome === "WIN" ? "bg-emerald-400/15 text-emerald-300" : t.outcome === "LOSS" ? "bg-rose-400/15 text-rose-300" : t.outcome === "END" ? "bg-amber-400/15 text-amber-300" : "bg-sky-400/15 text-sky-300"}`}>{t.outcome}</span></td>
        <td className={`px-2 text-right font-mono ${tone(t.r)}`}>{fr(t.r)}</td>
        <td className="whitespace-nowrap px-2">{time(t.exitAt)}</td><td className="px-2 text-right">{holdLabel(t.holdMin)}</td>
      </tr>)}</tbody></table>
      <div className="mt-2 flex items-center gap-3 text-xs"><button disabled={page === 0} className="rounded border border-white/15 px-3 py-1 disabled:opacity-40" onClick={() => setPage(p => p - 1)}>Previous</button><span>{Math.min(page * 50 + 1, sorted.length)}–{Math.min((page + 1) * 50, sorted.length)} of {sorted.length}</span><button disabled={(page + 1) * 50 >= sorted.length} className="rounded border border-white/15 px-3 py-1 disabled:opacity-40" onClick={() => setPage(p => p + 1)}>Next</button></div>
    </div>
  </section>;
}
