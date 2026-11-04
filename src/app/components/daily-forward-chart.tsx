"use client";

import { useEffect, useMemo, useState } from "react";
import { cachedFetch } from "@/lib/fetch-cache";
import type { ReplayBar } from "@/lib/weekly-replay";
import { computeChartFib, visibleFibStudies, FIB_VISIBILITY_DEFAULT, type FibVisibility } from "@/lib/chart-fib";
import { FibLevelsLegend, FibToggleButtons, SvgFibOverlay } from "./fib-overlay";

type Bar = { d: string; day?: string; t?: number; o: number; h: number; l: number; c: number; bars: number };
type Resp = {
  success: boolean; error?: string; entry_day?: string; entry_index?: number;
  sessions_after_available?: number; bars?: Bar[];
};

export type DailyForwardTrade = {
  symbol: string;
  direction: string | null;
  entryTs: string | null;      // fill time (falls back to the signal time)
  fill: number | null;
  stop: number | null;
  target: number | null;
  exitTs?: string | null;
  exitPrice?: number | null;
  exitLabel?: string | null;
  orderId?: string | null;     // lets the chart pull the persisted strategy_json
  strategyId?: string | null;
};

// ---- strategy_json data points, drawn on the timeframe they were taken from (S01-V2) ----
export type EvKind = "pool" | "sweep" | "also" | "target";
export type EvLabel = { tf: TfKeyAll; kind: EvKind; price: number; timeMs: number; label: string };
export type EvNote = { tf: TfKeyAll; text: string };
export type TfKeyAll = "1d" | "1h" | "30m" | "15m";
const EV_COLOR: Record<EvKind, string> = { pool: "#1d4ed8", sweep: "#0e7490", also: "#6366f1", target: "#15803d" };

function evTf(v: unknown): TfKeyAll | null {
  const s = String(v ?? "").toLowerCase();
  return s === "15m" ? "15m" : s === "30m" ? "30m" : s === "1h" ? "1h" : s === "d" || s === "w" || s === "m" ? "1d" : null;
}
function evNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function evMs(v: unknown): number | null {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
}
type J = Record<string, unknown>;
const jo = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});

/** S01-V2 strategy_json -> per-timeframe labels (pool, sweep candle, other swept pools, targets) + filter readings. */
function s01v2Evidence(json: unknown): { labels: EvLabel[]; notes: EvNote[] } {
  const root = jo(json);
  const labels: EvLabel[] = [];
  const notes: EvNote[] = [];
  const buy = String(root.direction ?? "").toUpperCase() !== "SELL";
  const push = (tf: TfKeyAll | null, kind: EvKind, price: unknown, time: unknown, label: string) => {
    const p = evNum(price), t = evMs(time);
    if (tf && p !== null && t !== null) labels.push({ tf, kind, price: p, timeMs: t, label });
  };
  const name = (p: J) => `${String(p.tf ?? "").toUpperCase()} ${String(p.ref ?? p.kind ?? "")}${evNum(p.touches) ? ` ×${evNum(p.touches)}` : ""}`.trim();
  const pool = jo(root.selected_pool);
  push(evTf(pool.tf), "pool", pool.price, pool.formed ?? pool.known_at, `SELECTED POOL · ${name(pool)} · ${String(pool.family ?? "")}`);
  const sweep = jo(root.sweep);
  const stf = String(sweep.tf ?? "").toUpperCase();
  push(evTf(sweep.tf), "sweep", sweep.low, sweep.candle_open,
       `SWEEP ${stf} · WICK ${evNum(sweep.low) ?? ""} · CLOSE ${evNum(sweep.close) ?? ""} BACK INSIDE${sweep.killzone ? ` · ${String(sweep.killzone)}` : ""}`);
  const seen = new Set<string>();
  const others = (Array.isArray(root.swept_pools) ? root.swept_pools : []).map(jo)
    .filter((p) => p.id !== pool.id)
    .sort((a, b) => (evMs(b.formed) ?? 0) - (evMs(a.formed) ?? 0));
  for (const p of others) {
    const tf = evTf(p.tf);
    if (!tf || seen.has(tf)) continue;
    seen.add(tf);
    push(tf, "also", p.price, p.formed ?? p.known_at, `ALSO SWEPT · ${name(p)}`);
  }
  for (const raw of Array.isArray(root.targets) ? root.targets : []) {
    const tg = jo(raw);
    push(evTf(tg.tf), "target", tg.price, tg.formed ?? tg.known_at,
         `TP${evNum(tg.bucket) ?? ""} · ${String(tg.tf ?? "").toUpperCase()} ${String(tg.ref ?? tg.gap ?? tg.family ?? "")} · ${evNum(tg.rr_plan)?.toFixed(2) ?? ""}R`);
  }
  const trend = jo(root.trend);
  const up = (v: unknown) => String(v ?? "n/a").toUpperCase();
  notes.push({ tf: "1d", text: `Daily bias ${buy ? "BULLISH" : "BEARISH"} (last 250 daily bars) → permits ${buy ? "BUY" : "SELL"}` });
  notes.push({ tf: "1h", text: `1H trend ${up(trend["1h"])} (last 150 bars) · gate: must not oppose` });
  notes.push({ tf: "30m", text: `30m trend ${up(trend["30m"])} (last 150 bars) · gate: must not oppose` });
  notes.push({ tf: "15m", text: `15m trend ${up(trend["15m"])} (last 150 bars) · info only` });
  for (const [tf, lb] of [["15m", 60], ["30m", 50], ["1h", 40]] as const) {
    notes.push({ tf, text: `Pools: swings/equal levels in the last ${lb} ${tf} bars${stf === tf.toUpperCase() ? " · sweep taken on this timeframe" : ""}` });
  }
  return { labels, notes };
}

const LOOK = [20, 40, 60] as const;
const W = 900, H = 470, PAD_L = 10, PAD_R = 92, PAD_T = 26, PAD_B = 30;
const C = {
  bg: "#eceef2", grid: "#d7dbe2", axis: "#64748b", ink: "#334155",
  up: "#ffffff", down: "#5b6472", wick: "#3f4754",
  fill: "#c2410c", sl: "#dc2626", tp: "#15803d",
  ipda: { 20: "#2563eb", 40: "#7c3aed", 60: "#b45309" } as Record<number, string>,
  bull: "#16a34a", bear: "#dc2626",
};

function fmt(v: number | null | undefined, d = 2) {
  return v === null || v === undefined || !Number.isFinite(v) ? "-" : v.toFixed(d);
}
function signed(v: number | null | undefined, d = 2, suffix = "") {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  return `${v >= 0 ? "+" : ""}${v.toFixed(d)}${suffix}`;
}

type Fvg = { i: number; lo: number; hi: number; bull: boolean; filledAt: number | null };

/**
 * ICT-style daily view of a trade: the 20/40/60-session IPDA look-back ranges that were
 * known before the entry (highest high / lowest low of the prior N completed sessions),
 * the 20-day premium/discount split, unfilled daily FVGs, PDH/PDL, and the +20/+40/+60
 * session look-forward.  Everything left of the entry uses completed sessions only.
 * The look-forward is a buy-and-hold view from the fill and ignores the strategy's exits.
 */
const TFS = [
  { key: "1d", label: "Daily", unit: "D", noun: "sessions" },
  { key: "1h", label: "1H", unit: "", noun: "1h bars" },
  { key: "30m", label: "30m", unit: "", noun: "30m bars" },
  { key: "15m", label: "15m", unit: "", noun: "15m bars" },
] as const;
type TfKey = (typeof TFS)[number]["key"];
type SavedSetup = {
  zone: { low: number; high: number; origin: number; label: string } | null;
  confirmation?: { origin: number; start: number; end: number; level: number; label: string };
  exit?: { at: number; price: number; label: string };
};

/** The Reversal renderer, supplied with frozen strategy candles and selected evidence. */
export function SavedIctTimeframeChart({ trade, tf, bars, anchorAt, setup, labels = [], notes = [] }: {
  trade: DailyForwardTrade; tf: "1h" | "5m"; bars: ReplayBar[]; anchorAt: number;
  setup: SavedSetup; labels?: EvLabel[]; notes?: EvNote[];
}) {
  const snapshot = useMemo<Resp>(() => {
    const entryAt = Date.parse(trade.entryTs ?? "");
    let entry_index = 0;
    for (let i = 0; i < bars.length; i++) if (bars[i].t <= entryAt) entry_index = i;
    return { success: true, entry_index, sessions_after_available: Math.max(0, bars.length - entry_index - 1),
      entry_day: bars[entry_index]?.day, bars: bars.map(b => ({ ...b, d: new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(b.t).replace(",", ""), bars: 1 })) };
  }, [bars, trade.entryTs]);
  return <TfChart trade={trade} tf={tf} snapshot={snapshot} savedSetup={setup}
    anchorTs={new Date(anchorAt).toISOString()} evLabels={labels} evNotes={notes} />;
}

export function DailyForwardChart({
  trade,
  endpoint = "/api/backtest/daily-forward",
  evidence: staticEvidence = null,
  initialTf = "1d",
  anchorTs = null,
  plotEvidence = true,
}: {
  trade: DailyForwardTrade;
  /** false = list the evidence as text above the chart but draw nothing for it on the chart */
  plotEvidence?: boolean;
  /** end the 20/40/60 look-back windows at the bar BEFORE this time (Reversal tab: the liquidity-sweep candle)
   *  instead of the bar before the entry, and shade the anchor -> entry stretch */
  anchorTs?: string | null;
  /** candle feed; the Reversal tab passes its own (it also needs candles after the barchart 5m history ends) */
  endpoint?: string;
  /** setup evidence supplied by the caller instead of the S01-V2 strategy_json lookup */
  evidence?: { labels: EvLabel[]; notes: EvNote[] } | null;
  initialTf?: TfKey;
}) {
  const [tf, setTf] = useState<TfKey>(initialTf);
  const evidenceKey = `${trade.orderId}:${trade.strategyId}`;
  const [fetchedEvidence, setEvidence] = useState<{ key: string; data: { labels: EvLabel[]; notes: EvNote[] } } | null>(null);
  const evidence = staticEvidence ?? (fetchedEvidence?.key === evidenceKey ? fetchedEvidence.data : null);
  useEffect(() => {
    if (staticEvidence || !trade.orderId || !["S01-V2","S01-V3"].includes((trade.strategyId || "").toUpperCase())) return;
    const ctrl = new AbortController();
    fetch(`/api/backtest/trade-context?order_id=${encodeURIComponent(trade.orderId)}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((j) => { if (j?.success && !ctrl.signal.aborted) setEvidence({ key: evidenceKey, data: s01v2Evidence(j.trade?.strategy_json) }); })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [trade.orderId, trade.strategyId, staticEvidence, evidenceKey]);
  return (
    <div>
      <div className="flex flex-wrap gap-1 px-3 pt-3">
        {TFS.map((t) => (
          <button key={t.key} type="button" onClick={() => setTf(t.key)}
            className={`rounded-md border px-3 py-1 text-xs font-semibold ${tf === t.key ? "border-[#d9a441] bg-[#d9a441]/15 text-[#d9a441]" : "border-white/10 text-[#93a1b6] hover:text-white"}`}>
            {t.label}
          </button>
        ))}
      </div>
      <TfChart key={`${trade.symbol}-${trade.entryTs}-${tf}-${anchorTs ?? ""}`} trade={trade} tf={tf} endpoint={endpoint} anchorTs={anchorTs} plotEvidence={plotEvidence}
        evLabels={evidence?.labels.filter((l) => l.tf === tf) ?? []}
        evNotes={evidence?.notes.filter((n) => n.tf === tf) ?? []} />
    </div>
  );
}

function TfChart({ trade, tf, endpoint = "/api/backtest/daily-forward", anchorTs = null, plotEvidence = true, evLabels = [], evNotes = [], snapshot, savedSetup }: { trade: DailyForwardTrade; tf: TfKey | "5m"; endpoint?: string; anchorTs?: string | null; plotEvidence?: boolean; evLabels?: EvLabel[]; evNotes?: EvNote[]; snapshot?: Resp; savedSetup?: SavedSetup }) {
  const meta = tf === "5m" ? { key: "5m", label: "5m", unit: "", noun: "5m bars" } : TFS.find((t) => t.key === tf)!;
  const daily = tf === "1d";
  const showRanges = !savedSetup || tf !== "5m";
  const requestKey = `${trade.symbol}:${trade.entryTs}:${tf}:${endpoint}:${anchorTs}`;
  const [fetchedData, setData] = useState<{ key: string; data: Resp } | null>(null);
  const data = snapshot ?? (fetchedData?.key === requestKey ? fetchedData.data : null);
  const loading = !snapshot && !data;

  useEffect(() => {
    if (snapshot || !trade.entryTs) return;
    const ctrl = new AbortController();
    // anchored charts need 60 bars before the anchor, which sits some bars before the entry:
    // estimate the bars between anchor and entry (trading days x bars per session) and add them
    let before = 60;
    if (anchorTs) {
      const days = Math.max(0, (Date.parse(trade.entryTs) - Date.parse(anchorTs)) / 86_400_000);
      const perDay = tf === "1d" ? 1 : tf === "1h" ? 7 : tf === "30m" ? 13 : 26;
      before = Math.min(600, 70 + Math.ceil((days * 5) / 7 + 1) * perDay);
    }
    const q = new URLSearchParams({ symbol: trade.symbol, entry_ts: trade.entryTs, before: String(before), after: "60", tf });
    cachedFetch(`${endpoint}?${q}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((j: Resp) => { if (!ctrl.signal.aborted) setData({ key: requestKey, data: j }); })
      .catch((e) => { if (e?.name !== "AbortError") setData({ key: requestKey, data: { success: false, error: String(e) } }); });
    return () => ctrl.abort();
  }, [trade.symbol, trade.entryTs, tf, endpoint, anchorTs, snapshot, requestKey]);

  const sgn = (trade.direction || "").toUpperCase() === "SELL" ? -1 : 1;
  const bars = useMemo(() => data?.bars ?? [], [data]);
  const ei = data?.entry_index ?? 0;
  const fill = trade.fill;
  const risk = fill !== null && trade.stop !== null ? Math.abs(fill - trade.stop) : null;

  // anchor bar (Reversal tab): the bar containing the liquidity-sweep candle; the look-back ends just before it
  const anchorMs = anchorTs ? Date.parse(anchorTs) : NaN;
  const ai = useMemo(() => {
    if (!Number.isFinite(anchorMs) || !bars.length) return ei;
    let k = -1;
    for (let i = 0; i < bars.length; i++) if ((bars[i].t ?? Infinity) <= anchorMs) k = i;
    return k >= 0 && k <= ei ? k : ei;
  }, [bars, anchorMs, ei]);
  const anchored = Number.isFinite(anchorMs) && ai < ei;
  const endWord = anchored ? "sweep" : "entry";

  // IPDA look-back ranges: completed bars strictly before the anchor (sweep) bar, or the entry bar
  const back = useMemo(() => LOOK.map((n) => {
    const a = ai - n;
    if (a < 0 || !bars.length) return { n, ok: false as const };
    const win = bars.slice(a, ai);
    const hi = Math.max(...win.map((b) => b.h)), lo = Math.min(...win.map((b) => b.l));
    const loc = fill !== null && hi > lo ? (fill - lo) / (hi - lo) : null;
    const runup = fill !== null ? ((fill - bars[a].c) / bars[a].c) * 100 : null;
    return { n, ok: true as const, a, hi, lo, eq: (hi + lo) / 2, loc, runup, day: bars[a].d };
  }), [bars, ai, fill]);

  const fwd = useMemo(() => LOOK.map((n) => {
    const k = ei + n;
    if (!bars.length || fill === null || k >= bars.length) return { n, ok: false as const };
    const win = bars.slice(ei, k + 1);
    const bar = bars[k];
    const fav = sgn > 0 ? Math.max(...win.map((b) => b.h)) : Math.min(...win.map((b) => b.l));
    const adv = sgn > 0 ? Math.min(...win.map((b) => b.l)) : Math.max(...win.map((b) => b.h));
    // first session AFTER the entry session whose range reaches the level (the entry day's
    // range includes prices from before the fill, so it cannot tell us anything)
    const hitDay = (lvl: number | null, above: boolean) => {
      if (lvl === null) return null;
      const j = win.findIndex((b, q) => q > 0 && (above ? b.h >= lvl : b.l <= lvl));
      return j < 0 ? null : j;
    };
    return {
      n, ok: true as const, bar,
      move: ((bar.c - fill) / fill) * 100 * sgn,
      r: risk ? ((bar.c - fill) * sgn) / risk : null,
      mfe: ((fav - fill) / fill) * 100 * sgn,
      mae: ((adv - fill) / fill) * 100 * sgn,
      tgtDay: hitDay(trade.target, sgn > 0),
      stopDay: hitDay(trade.stop, sgn < 0),
    };
  }), [bars, ei, fill, sgn, risk, trade.target, trade.stop]);

  // daily FVGs formed before the entry session, still open at the entry
  const fvgs = useMemo<Fvg[]>(() => {
    const out: Fvg[] = [];
    if (savedSetup) return out;
    const start = Math.max(2, anchored ? Math.min(ei - 60, ai - 5) : ei - 60);
    for (let k = start; k < ei; k++) {
      const a = bars[k - 2], c = bars[k];
      let g: Fvg | null = null;
      if (a.h < c.l) g = { i: k, lo: a.h, hi: c.l, bull: true, filledAt: null };
      else if (a.l > c.h) g = { i: k, lo: c.h, hi: a.l, bull: false, filledAt: null };
      if (!g) continue;
      for (let j = k + 1; j < bars.length; j++) {
        if (g.bull ? bars[j].l <= g.lo : bars[j].h >= g.hi) { g.filledAt = j; break; }
      }
      if (g.filledAt === null || g.filledAt >= ei) out.push(g);
    }
    return out.slice(anchored ? -12 : -6);
  }, [bars, ei, ai, anchored, savedSetup]);

  // Reversal tab: market structure on THIS timeframe between the sweep and the entry.
  // 2-bar fractal swings; a close through the last swing = break. CHoCH = first break against the prior break
  // direction, BOS = break in the same direction. The order block is the last opposite-colour candle before the break.
  const structure = useMemo(() => {
    const none = { breaks: [] as { p: number; a: number; b: number; up: boolean; label: string }[], obs: [] as { i: number; lo: number; hi: number; up: boolean; end: number }[] };
    if (savedSetup || !anchored || bars.length < 6) return none;
    const K = 2, from = Math.max(0, ai - 40);
    const isPH = (i: number) => i >= K && i + K < bars.length && bars.slice(i - K, i + K + 1).every((b) => b.h <= bars[i].h) && bars.slice(i - K, i).every((b) => b.h < bars[i].h);
    const isPL = (i: number) => i >= K && i + K < bars.length && bars.slice(i - K, i + K + 1).every((b) => b.l >= bars[i].l) && bars.slice(i - K, i).every((b) => b.l > bars[i].l);
    let hi: { p: number; i: number } | null = null, lo: { p: number; i: number } | null = null, dir = 0;
    for (let j = from; j < ei; j++) {
      const q = j - K;                                   // swing at q is confirmed once bar q + K has closed
      if (q >= from && isPH(q)) hi = { p: bars[q].h, i: q };
      if (q >= from && isPL(q)) lo = { p: bars[q].l, i: q };
      const c = bars[j].c;
      const brk = hi && c > hi.p ? { sw: hi, up: true } : lo && c < lo.p ? { sw: lo, up: false } : null;
      if (!brk) continue;
      const d = brk.up ? 1 : -1;
      if (j >= ai) {
        none.breaks.push({ p: brk.sw.p, a: brk.sw.i, b: j, up: brk.up, label: dir === -d ? "CHoCH" : "BOS" });
        for (let k = j - 1; k >= Math.max(brk.sw.i - 3, from); k--) {
          const bk = bars[k];
          if (brk.up ? bk.c < bk.o : bk.c > bk.o) {
            let end = ei;
            for (let m = j + 1; m < ei; m++) if (brk.up ? bars[m].c < bk.l : bars[m].c > bk.h) { end = m; break; }
            none.obs.push({ i: k, lo: bk.l, hi: bk.h, up: brk.up, end });
            break;
          }
        }
      }
      dir = d;
      if (brk.up) hi = null; else lo = null;
    }
    return { breaks: none.breaks.slice(-10), obs: none.obs.slice(-6) };
  }, [anchored, bars, ai, ei, savedSetup]);

  // Fibonacci retracement / extension anchored on confirmed swings known at the entry bar.
  const [fibShow, setFibShow] = useState<FibVisibility>(FIB_VISIBILITY_DEFAULT);
  const fib = useMemo(() => computeChartFib(bars.slice(0, ei + 1).flatMap((b) => b.t === undefined ? [] : [{ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }])), [bars, ei]);
  const fibStudies = visibleFibStudies(fib, fibShow);
  const fibDigits = (bars.at(-1)?.c ?? 100) < 20 ? 5 : 2;

  if (!trade.entryTs) return <Empty text="This trade has no entry timestamp." />;
  if (loading && !data) return <Empty text="Loading daily candles…" />;
  if (!data?.success) return <Empty text={data?.error || "No daily data."} />;
  if (!bars.length) return <Empty text="No daily candles around this entry." />;

  // previous trading day's high / low (daily: the prior bar; intraday: all bars of the prior session)
  let pdh: number | null = null, pdl: number | null = null;
  if (daily) { if (ei >= 1) { pdh = bars[ei - 1].h; pdl = bars[ei - 1].l; } }
  else {
    const entryDay = bars[Math.min(ei, bars.length - 1)]?.day;
    const prevDay = [...bars.slice(0, ei)].reverse().find((b) => b.day !== entryDay)?.day;
    const prev = bars.filter((b) => b.day === prevDay);
    if (prevDay && prev.length) { pdh = Math.max(...prev.map((b) => b.h)); pdl = Math.min(...prev.map((b) => b.l)); }
  }
  const pdStart = daily ? ei - 1 : Math.max(0, bars.findIndex((b) => b.day === bars[Math.min(ei, bars.length - 1)]?.day));
  if (savedSetup) { pdh = null; pdl = null; }
  const levels = [
    { p: fill, label: "ENTRY", color: C.fill, dash: "0" },
    { p: trade.stop, label: "SL", color: C.sl, dash: "5 3" },
    { p: trade.target, label: "TP", color: C.tp, dash: "5 3" },
  ].filter((x): x is { p: number; label: string; color: string; dash: string } => x.p !== null && Number.isFinite(x.p));
  const r20 = showRanges && back[0].ok ? back[0] : null;
  // one line per distinct IPDA level; windows sharing a level share one label ("20/40/60D HIGH")
  const ipdaLines: { key: string; p: number; hi: boolean; a: number; ns: number[] }[] = [];
  for (const b of showRanges ? back : []) {
    if (!b.ok) continue;
    for (const [p, isHi] of [[b.hi, true], [b.lo, false]] as [number, boolean][]) {
      const same = ipdaLines.find((z) => z.hi === isHi && Math.abs(z.p - p) < 1e-9);
      if (same) { same.ns.push(b.n); same.a = Math.min(same.a, b.a); }
      else ipdaLines.push({ key: `${isHi ? "H" : "L"}${b.n}`, p, hi: isHi, a: b.a, ns: [b.n] });
    }
  }
  // strategy_json data points for this timeframe: anchor at the bar that contains the level's time
  const barLo = Math.min(...bars.map((b) => b.l)), barHi = Math.max(...bars.map((b) => b.h));
  const reach = (barHi - barLo) * 0.5;
  const evPlaced = evLabels.map((l) => {
    let idx = 0;
    for (let k = 0; k < bars.length; k++) { if ((bars[k].t ?? Infinity) <= l.timeMs) idx = k; else break; }
    const early = bars.length > 0 && (bars[0].t ?? 0) > l.timeMs;
    const onChart = !!savedSetup || (l.price >= barLo - reach && l.price <= barHi + reach);
    return { ...l, idx: Math.min(idx, ei), early, onChart };
  });
  const evOn = plotEvidence ? evPlaced.filter((l) => l.onChart) : [];
  const exTz = (data as Resp & { timezone?: string }).timezone || "America/New_York";
  const exTime = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: exTz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms).replace(",", "");
  const prices = bars.flatMap((b) => [b.h, b.l]).concat(levels.map((x) => x.p)).concat(evOn.map((l) => l.price)).concat(savedSetup?.zone ? [savedSetup.zone.low, savedSetup.zone.high] : []).concat(savedSetup?.confirmation ? [savedSetup.confirmation.level] : []);
  let lo = Math.min(...prices), hi = Math.max(...prices);
  const padP = (hi - lo) * 0.05 || 1; lo -= padP; hi += padP;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const step = plotW / Math.max(bars.length, 1);
  const x = (i: number) => PAD_L + step * (i + 0.5);
  const y = (p: number) => PAD_T + ((hi - p) / (hi - lo)) * plotH;
  const bw = Math.max(1.5, Math.min(8, step * 0.64));
  const ticks = Array.from({ length: 6 }, (_, i) => lo + ((hi - lo) * i) / 5);
  const exRight = x(bars.length - 1) + step / 2;
  const exitMs = trade.exitTs ? Date.parse(trade.exitTs) : NaN;
  const exitIndex = Number.isFinite(exitMs) ? bars.findLastIndex(b => (b.t ?? Infinity) < exitMs) : -1;
  const exitOnChart = exitIndex >= 0 && exitMs >= (bars[0]?.t ?? Infinity) && exitMs <= (bars.at(-1)?.t ?? 0) + (daily ? 86400000 : (tf === "5m" ? 5 : tf === "15m" ? 15 : tf === "30m" ? 30 : 60) * 60000);
  const exitBarDuration = (daily ? 390 : tf === "5m" ? 5 : tf === "15m" ? 15 : tf === "30m" ? 30 : 60) * 60000;
  const exitFraction = Math.max(0, Math.min(1, (exitMs - (bars[exitIndex]?.t ?? exitMs)) / exitBarDuration));
  const tradeRight = exitOnChart ? x(exitIndex) - step / 2 + exitFraction * step : W - PAD_R;
  const marks = (savedSetup ? showRanges ? [-60, -40, -20, 0] : [0] : [-60, -40, -20, 0, 20, 40, 60]).map((n) => ({ n, k: (n < 0 ? ai : ei) + n })).filter((m) => m.k >= 0 && m.k < bars.length);
  const atIndex = (at: number) => { let idx = 0; for (let i = 0; i < bars.length; i++) if ((bars[i].t ?? Infinity) <= at) idx = i; return idx; };

  // right-axis price tags, nudged apart so they never overlap
  const tags = [
    ...levels.map((l) => ({ p: l.p, text: `${l.label} ${fmt(l.p)}`, color: l.color })),
    ...(pdh !== null ? [{ p: pdh, text: `PDH ${fmt(pdh)}`, color: C.ink }] : []),
    ...(pdl !== null ? [{ p: pdl, text: `PDL ${fmt(pdl)}`, color: C.ink }] : []),
  ].map((t) => ({ ...t, ty: y(t.p) })).sort((a, b) => a.ty - b.ty);
  for (let i = 1; i < tags.length; i++) if (tags[i].ty - tags[i - 1].ty < 13) tags[i].ty = tags[i - 1].ty + 13;

  return (
    <div className="p-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#93a1b6]">
        <span>{meta.label} · entry {daily ? `session ${data.entry_day}` : `bar ${(data as Resp & { entry_bar?: string }).entry_bar ?? ""}`} · {ei} {meta.noun} before · {data.sessions_after_available} after</span>
        <FibToggleButtons fib={fib} value={fibShow} onChange={setFibShow} />
        {showRanges && LOOK.map((n) => <span key={n} className="flex items-center gap-1"><span className="inline-block h-0.5 w-3" style={{ background: C.ipda[n] }} />{daily ? `${n}D IPDA range` : `${n}-bar range`}{anchored ? " (before sweep)" : ""}</span>)}
        {anchored ? <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-3 rounded-sm bg-[#64748b]/40" /> sweep → entry</span> : null}
        {!savedSetup ? <span className="flex items-center gap-1"><span className="inline-block size-2.5 rounded-sm bg-[#16a34a]/40" />/<span className="inline-block size-2.5 rounded-sm bg-[#dc2626]/40" /> {daily ? "daily" : meta.label} FVG (open at entry)</span> : <span>Selected strategy JSON · {savedSetup.exit?.label ?? "at entry / open"}</span>}
        {anchored && !savedSetup ? <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-3 bg-[#15803d]" />/<span className="inline-block h-0.5 w-3 bg-[#b91c1c]" /> BOS / CHoCH (swing → break) · <span className="inline-block size-2.5 rounded-sm border border-[#0284c7] bg-[#0ea5e9]/30" />/<span className="inline-block size-2.5 rounded-sm border border-[#ea580c] bg-[#f97316]/30" /> OB</span> : null}
      </div>
      {evNotes.length || evPlaced.length ? (
        <div className="mb-2 rounded-md border border-[#d9a441]/25 bg-[#d9a441]/5 px-3 py-2 text-[11px] leading-5 text-[#d6deec]">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#d9a441]">Strategy JSON · {meta.label}</div>
          {evNotes.map((n) => <div key={n.text}>{n.text}</div>)}
          {evPlaced.map((l) => (
            <div key={`${l.label}${l.price}`} style={{ color: EV_COLOR[l.kind] === "#1d4ed8" ? "#7aa2ff" : EV_COLOR[l.kind] === "#0e7490" ? "#5ed3e6" : EV_COLOR[l.kind] === "#6366f1" ? "#a5b4fc" : "#6ee7a0" }}>
              {l.label} {fmt(l.price)} · {exTime(l.timeMs)}{l.onChart ? (l.early ? " · formed before the first bar shown" : "") : " · off chart"}
            </div>
          ))}
          {!evPlaced.length ? <div className="text-[#93a1b6]">No pool, sweep or target was taken from this timeframe.</div> : null}
        </div>
      ) : null}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg" style={{ background: C.bg }} role="img" aria-label={`${trade.symbol} ${meta.label} ICT chart, ${savedSetup ? "selected setup through saved outcome" : `60 ${meta.noun} either side of the entry`}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke={C.grid} strokeWidth="1" />
            <text x={W - PAD_R + 6} y={y(t) + 3} fill={C.axis} fontSize="9.5">{t.toFixed(2)}</text>
          </g>
        ))}

        {/* Reversal tab: gray band from the liquidity-sweep candle to the entry */}
        {anchored ? (
          <g>
            <rect x={x(ai) - step / 2} y={PAD_T} width={x(ei) - x(ai) + step} height={H - PAD_T - PAD_B} fill="#64748b" opacity="0.18" />
            <text x={x(ai) - step / 2 + 3} y={H - PAD_B - 4} fill="#475569" fontSize="9" fontWeight="700">SWEEP → ENTRY</text>
          </g>
        ) : null}

        {exitOnChart ? <g data-testid="post-exit-context"><rect x={tradeRight} y={PAD_T} width={Math.max(0, W-PAD_R-tradeRight)} height={H-PAD_T-PAD_B} fill="#64748b" opacity="0.12" /><text x={tradeRight+4} y={H-PAD_B-4} fill="#475569" fontSize="9">AFTER EXIT · CONTEXT ONLY</text></g> : null}
        {/* 20D dealing range known at entry: premium (upper half) / discount (lower half) */}
        {r20 ? (
          <g>
            <rect x={x(r20.a) - step / 2} y={y(r20.hi)} width={x(ai) - x(r20.a)} height={y(r20.eq) - y(r20.hi)} fill="#dc2626" opacity="0.07" />
            <rect x={x(r20.a) - step / 2} y={y(r20.eq)} width={x(ai) - x(r20.a)} height={y(r20.lo) - y(r20.eq)} fill="#16a34a" opacity="0.07" />
            <line x1={x(r20.a) - step / 2} x2={anchored ? x(ai) - step / 2 : x(ei)} y1={y(r20.eq)} y2={y(r20.eq)} stroke="#7c2d12" strokeWidth="1" strokeDasharray="4 3" opacity="0.8" />
            <text x={x(r20.a)} y={y(r20.hi) + 11} fill="#9a3412" fontSize="9" fontWeight="700">PREMIUM</text>
            <text x={x(r20.a)} y={y(r20.lo) - 4} fill="#166534" fontSize="9" fontWeight="700">DISCOUNT</text>
            <text x={x(r20.a)} y={y(r20.eq) - 3} fill="#7c2d12" fontSize="9" fontWeight="700">EQ {fmt(r20.eq)}</text>
          </g>
        ) : null}

        {/* open daily FVGs, extended to the right edge */}
        {fvgs.map((g) => (
          <g key={`f${g.i}`}>
            <rect x={x(g.i - 1) - step / 2} y={y(g.hi)} width={Math.max(2, (g.filledAt !== null ? x(g.filledAt) : exRight) - (x(g.i - 1) - step / 2))} height={Math.max(1, y(g.lo) - y(g.hi))} fill={g.bull ? C.bull : C.bear} opacity="0.16" />
            <text x={x(g.i - 1)} y={y(g.hi) - 2} fill={g.bull ? "#166534" : "#991b1b"} fontSize="8.5" fontWeight="700">{g.bull ? "+FVG" : "−FVG"}</text>
          </g>
        ))}

        {/* Reversal tab: order blocks + BOS / CHoCH between the sweep and the entry */}
        {structure.obs.map((ob) => (
          <g key={`ob${ob.i}`}>
            <rect x={x(ob.i) - step / 2} y={y(ob.hi)} width={Math.max(2, x(ob.end) - x(ob.i) + step / 2)} height={Math.max(1, y(ob.lo) - y(ob.hi))}
              fill={ob.up ? "#0ea5e9" : "#f97316"} opacity="0.16" stroke={ob.up ? "#0284c7" : "#ea580c"} strokeWidth="0.8" strokeDasharray="3 2" />
            <text x={x(ob.i) - step / 2 + 2} y={y(ob.lo) - 2} fill={ob.up ? "#0369a1" : "#c2410c"} fontSize="8.5" fontWeight="800">{ob.up ? "+OB" : "−OB"}</text>
          </g>
        ))}
        {structure.breaks.map((br) => (
          <g key={`br${br.a}-${br.b}`}>
            <line x1={x(br.a)} x2={x(br.b)} y1={y(br.p)} y2={y(br.p)} stroke={br.up ? "#15803d" : "#b91c1c"} strokeWidth="1.3" />
            <circle cx={x(br.b)} cy={y(br.p)} r={2.2} fill={br.up ? "#15803d" : "#b91c1c"} />
            <text x={(x(br.a) + x(br.b)) / 2} y={y(br.p) + (br.up ? -3 : 10)} textAnchor="middle" fill={br.up ? "#15803d" : "#b91c1c"} fontSize="8.5" fontWeight="800">
              {br.label}{br.up ? "↑" : "↓"}
            </text>
          </g>
        ))}

        {/* IPDA 20/40/60 look-back highs & lows, drawn from their window start to the entry */}
        {ipdaLines.map((z) => (
          <g key={`ip${z.key}`}>
            <line x1={x(z.a) - step / 2} x2={anchored ? x(ai) + step / 2 : x(ei)} y1={y(z.p)} y2={y(z.p)} stroke={C.ipda[z.ns[0]]} strokeWidth="1.1" strokeDasharray="6 3" />
            <text x={x(z.a)} y={y(z.p) + (z.hi ? -3 : 10)} fill={C.ipda[z.ns[0]]} fontSize="9" fontWeight="700">{z.ns.join("/")}{daily ? "D" : "-bar"} {z.hi ? "HIGH" : "LOW"} {fmt(z.p)}</text>
          </g>
        ))}

        {/* strategy_json: selected data points taken from this timeframe, drawn from where they formed to the entry */}
        {evOn.map((l, k) => (
          <g key={`ev${k}`}>
            <line x1={x(l.idx) - step / 2} x2={x(ei)} y1={y(l.price)} y2={y(l.price)} stroke={EV_COLOR[l.kind]} strokeWidth="1.6" strokeDasharray={l.kind === "target" ? "2 2" : "7 3"} />
            <circle cx={x(l.idx)} cy={y(l.price)} r={2.6} fill={EV_COLOR[l.kind]} />
            <text x={x(l.idx) + 4} y={y(l.price) + (l.kind === "target" ? 11 : -4)} fill={EV_COLOR[l.kind]} fontSize="9" fontWeight="800">
              {l.early ? "◂ " : ""}{l.label} {fmt(l.price)}
            </text>
          </g>
        ))}

        {savedSetup?.zone ? <g data-testid="selected-array">
          <title>{savedSetup.zone.label} · origin {exTime(savedSetup.zone.origin)} · {fmt(savedSetup.zone.low)}–{fmt(savedSetup.zone.high)}</title>
          <rect x={x(atIndex(savedSetup.zone.origin)) - step / 2} y={y(savedSetup.zone.high)} width={Math.max(2, x(ei) - x(atIndex(savedSetup.zone.origin)) + step)} height={Math.max(2, y(savedSetup.zone.low) - y(savedSetup.zone.high))} fill="#0ea5e9" fillOpacity="0.18" stroke="#0284c7" strokeWidth="1.4" />
          <line x1={x(atIndex(savedSetup.zone.origin))} x2={x(ei)} y1={y((savedSetup.zone.low + savedSetup.zone.high) / 2)} y2={y((savedSetup.zone.low + savedSetup.zone.high) / 2)} stroke="#0284c7" strokeDasharray="3 2" />
        </g> : null}
        {savedSetup?.confirmation ? <g data-testid="selected-confirmation">
          <title>{savedSetup.confirmation.label} formation {exTime(savedSetup.confirmation.start)} → {exTime(savedSetup.confirmation.end)}; delivery / swing origin {exTime(savedSetup.confirmation.origin)}</title>
          <rect x={x(atIndex(savedSetup.confirmation.start)) - step / 2} y={PAD_T} width={Math.max(step, x(atIndex(savedSetup.confirmation.end)) - x(atIndex(savedSetup.confirmation.start)) + step)} height={plotH} fill="#7c3aed" opacity="0.10" />
          <line x1={x(atIndex(savedSetup.confirmation.origin))} x2={x(atIndex(savedSetup.confirmation.end))} y1={y(savedSetup.confirmation.level)} y2={y(savedSetup.confirmation.level)} stroke="#7c3aed" strokeWidth="2" />
          {[savedSetup.confirmation.start, savedSetup.confirmation.end].map((at, i) => <line key={i} x1={x(atIndex(at))} x2={x(atIndex(at))} y1={PAD_T + 20} y2={H - PAD_B} stroke="#7c3aed" strokeDasharray="3 3" />)}
          <circle cx={x(atIndex(savedSetup.confirmation.end))} cy={y(savedSetup.confirmation.level)} r="3" fill="#7c3aed" />
        </g> : null}
        {/* session checkpoints */}
        {marks.map((m) => (
          <g key={`m${m.n}`}>
            <line x1={x(m.k)} x2={x(m.k)} y1={PAD_T - 6} y2={H - PAD_B} stroke={m.n === 0 ? C.fill : m.n < 0 ? "#64748b" : "#0369a1"} strokeDasharray={m.n === 0 ? "0" : "3 4"} strokeWidth={m.n === 0 ? 1.2 : 1} opacity="0.75" />
            <rect x={x(m.k) - 19} y={4} width={38} height={14} rx={3} fill="#ffffff" stroke={m.n === 0 ? C.fill : m.n < 0 ? "#64748b" : "#0369a1"} strokeWidth="0.8" />
            <text x={x(m.k)} y={14} textAnchor="middle" fill={m.n === 0 ? C.fill : m.n < 0 ? "#475569" : "#0369a1"} fontSize="9" fontWeight="700">{m.n === 0 ? "ENTRY" : `${m.n > 0 ? "+" : ""}${m.n}${meta.unit}`}</text>
          </g>
        ))}
        {anchored ? (
          <g>
            <line x1={x(ai) - step / 2} x2={x(ai) - step / 2} y1={PAD_T - 6} y2={H - PAD_B} stroke="#475569" strokeWidth="1.2" />
            <rect x={x(ai) - step / 2 - 21} y={20} width={42} height={14} rx={3} fill="#ffffff" stroke="#475569" strokeWidth="0.8" />
            <text x={x(ai) - step / 2} y={30} textAnchor="middle" fill="#475569" fontSize="9" fontWeight="700">SWEEP</text>
          </g>
        ) : null}

        {/* trade levels from the entry to the right edge */}
        {levels.map((l) => (
          <line key={`lv${l.label}`} x1={x(ei) - step / 2} x2={tradeRight} y1={y(l.p)} y2={y(l.p)} stroke={l.color} strokeWidth="1.2" strokeDasharray={l.dash} />
        ))}
        {pdh !== null && pdl !== null ? [pdh, pdl].map((p, i) => (
          <line key={`pd${i}`} x1={x(pdStart) - step / 2} x2={W - PAD_R} y1={y(p)} y2={y(p)} stroke={C.ink} strokeWidth="0.8" strokeDasharray="1 3" />
        )) : null}

        {/* Fibonacci retracement / extension (anchors known at the entry bar) */}
        <SvgFibOverlay studies={fibStudies} xAt={(t) => x(atIndex(t))} xRight={W - PAD_R} y={y} top={PAD_T} bottom={H - PAD_B} digits={fibDigits} />

        {/* candles: hollow up, filled down (classic ICT / TradingView bar style) */}
        {bars.map((b, i) => {
          const up = b.c >= b.o;
          const top = y(Math.max(b.o, b.c)), bot = y(Math.min(b.o, b.c));
          return (
            <g key={b.d}>
              <title>{`${b.d}  O ${fmt(b.o)}  H ${fmt(b.h)}  L ${fmt(b.l)}  C ${fmt(b.c)}  (${i - ei >= 0 ? "+" : ""}${i - ei}${daily ? "D" : " bars"})`}</title>
              <line x1={x(i)} x2={x(i)} y1={y(b.h)} y2={y(b.l)} stroke={C.wick} strokeWidth="0.9" />
              <rect x={x(i) - bw / 2} y={top} width={bw} height={Math.max(1, bot - top)} fill={up ? C.up : C.down} stroke={C.wick} strokeWidth="0.7" />
            </g>
          );
        })}
        {exitOnChart && trade.exitPrice != null ? <g data-testid="actual-reversal-exit"><line x1={tradeRight} x2={tradeRight} y1={PAD_T} y2={H-PAD_B} stroke="#b91c1c" strokeDasharray="4 3" /><circle cx={tradeRight} cy={y(trade.exitPrice)} r="4" fill="#b91c1c" stroke="#fff" /><text x={tradeRight-4} y={PAD_T+22} textAnchor="end" fill="#b91c1c" fontSize="10" fontWeight="800">{trade.exitLabel ?? "EXIT"} · {fmt(trade.exitPrice)}</text><title>Actual 5m exit observed {trade.exitTs}; later candles are context only</title></g> : null}
        {fill !== null ? <circle cx={x(ei)} cy={y(fill)} r={3.2} fill={C.fill} stroke="#fff" strokeWidth="1.2" /> : null}
        {[
          ...(savedSetup?.zone ? [{ at: savedSetup.zone.origin, top: y(savedSetup.zone.high) - 18, text: savedSetup.zone.label, color: "#0369a1" }] : []),
          ...(savedSetup?.confirmation ? [{ at: savedSetup.confirmation.start, top: PAD_T + 55, text: `${savedSetup.confirmation.label} START → CONFIRMED`, color: "#6d28d9" }] : []),
        ].map(label => {
          const width = label.text.length * 6.2 + 10;
          const left = Math.max(PAD_L + 3, Math.min(W - PAD_R - width, x(atIndex(label.at)) + 3));
          return <g key={label.text}>
            <rect x={left} y={label.top} width={width} height="16" rx="2" fill="#ffffff" fillOpacity="0.94" stroke={label.color} strokeWidth="0.7" />
            <text x={left + 5} y={label.top + 11} fill={label.color} fontSize="10" fontWeight="800">{label.text}</text>
          </g>;
        })}
        {savedSetup?.exit ? <g data-testid="strategy-exit">
          <line x1={x(atIndex(savedSetup.exit.at))} x2={x(atIndex(savedSetup.exit.at))} y1={PAD_T} y2={H - PAD_B} stroke={savedSetup.exit.label.startsWith("SL") ? C.sl : C.tp} strokeWidth="1.8" strokeDasharray="4 2" />
          <circle cx={x(atIndex(savedSetup.exit.at))} cy={y(savedSetup.exit.price)} r="4" fill={savedSetup.exit.label.startsWith("SL") ? C.sl : C.tp} stroke="#fff" />
          <text x={x(atIndex(savedSetup.exit.at)) - 4} y={PAD_T + 12} textAnchor="end" fill={savedSetup.exit.label.startsWith("SL") ? C.sl : C.tp} fontSize="10" fontWeight="800">{savedSetup.exit.label}</text>
        </g> : null}

        {tags.map((t) => (
          <g key={t.text}>
            <rect x={W - PAD_R + 2} y={t.ty - 7} width={PAD_R - 6} height={13} rx={2.5} fill="#ffffff" stroke={t.color} strokeWidth="0.9" />
            <text x={W - PAD_R + 6} y={t.ty + 3} fill={t.color} fontSize="8.8" fontWeight="700">{t.text}</text>
          </g>
        ))}
        {[0, Math.floor(bars.length * 0.25), Math.floor(bars.length * 0.5), Math.floor(bars.length * 0.75), bars.length - 1].map((i) => (
          <text key={`d${i}`} x={x(i)} y={H - 10} fill={C.axis} fontSize="9.5" textAnchor="middle">{daily ? bars[i]?.d : bars[i]?.d.slice(5)}</text>
        ))}
        {!savedSetup ? <text x={PAD_L + 4} y={PAD_T + 10} fill={C.axis} fontSize="9">{daily ? "RTH daily built from 5m" : `${meta.label} bars anchored at the session open, built from 5m · exchange time`}</text> : null}
      </svg>
      <FibLevelsLegend studies={fibStudies} digits={fibDigits} />

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {showRanges && back.slice().reverse().map((b) => (
          <div key={`b${b.n}`} className="rounded-md border border-white/10 bg-[#0b0f16] px-3 py-2">
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.ipda[b.n] === "#2563eb" ? "#60a5fa" : C.ipda[b.n] === "#7c3aed" ? "#a78bfa" : "#f59e0b" }}>−{b.n} {meta.noun} · {daily ? "IPDA" : "range"}</span>
              <span className="font-mono text-[10px] text-[#7f8ca3]">{b.ok ? b.day : "no data"}</span>
            </div>
            {b.ok ? (
              <>
                <div className="mt-1 font-mono text-[15px] text-[#d6deec]">
                  {b.loc === null ? "-" : `${Math.round(b.loc * 100)}%`}{" "}
                  <span className={b.loc === null ? "" : (b.loc >= 0.5) === (sgn < 0) ? "text-[#30a46c]" : "text-[#e5484d]"}>
                    {b.loc === null ? "" : b.loc >= 0.5 ? "premium" : "discount"}
                  </span>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-x-2 font-mono text-[10.5px] text-[#93a1b6]">
                  <span>high {fmt(b.hi)}</span>
                  <span>low {fmt(b.lo)}</span>
                  <span>EQ {fmt(b.eq)}</span>
                  <span>run-up {signed(b.runup, 2, "%")}</span>
                </div>
              </>
            ) : <div className="mt-2 text-xs text-[#7f8ca3]">Not enough {meta.noun} before {endWord}.</div>}
          </div>
        ))}
        {!savedSetup && fwd.map((h) => (
          <div key={`f${h.n}`} className="rounded-md border border-white/10 bg-[#0b0f16] px-3 py-2">
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[#64d2ff]">+{h.n} {meta.noun}</span>
              <span className="font-mono text-[10px] text-[#7f8ca3]">{h.ok ? h.bar.d : "data ends"}</span>
            </div>
            {h.ok ? (
              <>
                <div className={`mt-1 font-mono text-[15px] ${h.move >= 0 ? "text-[#30a46c]" : "text-[#e5484d]"}`}>
                  {signed(h.move, 2, "%")} <span className="text-xs text-[#93a1b6]">{signed(h.r, 2, "R")}</span>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-x-2 font-mono text-[10.5px] text-[#93a1b6]">
                  <span>close {fmt(h.bar.c)}</span>
                  <span>MFE {signed(h.mfe, 2, "%")}</span>
                  <span>TP hit {h.tgtDay !== null ? (daily ? `D+${h.tgtDay}` : `bar +${h.tgtDay}`) : "no"}</span>
                  <span>MAE {signed(h.mae, 2, "%")}</span>
                  <span>SL hit {h.stopDay !== null ? (daily ? `D+${h.stopDay}` : `bar +${h.stopDay}`) : "no"}</span>
                </div>
              </>
            ) : <div className="mt-2 text-xs text-[#7f8ca3]">Not enough {meta.noun} after entry.</div>}
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10.5px] leading-4 text-[#6b778c]">
        {savedSetup ? `${showRanges ? `20/40/60 ranges use completed ${meta.noun} before the context touch. ` : "The shaded confirmation spans its formation start to the confirming candle; its price line starts at the saved delivery / swing origin. "}Selected levels, formation and entry come from the matching strategy JSON. Candles end at the saved stop / target event or the available open-trade cutoff. Times are New York.` : <>Left of ENTRY: 20/40/60-{daily ? "session IPDA" : "bar"} ranges from completed {meta.noun} before the entry {daily ? "session" : "bar"}; % = where the fill sat in that range (premium favours SELL, discount favours BUY); run-up = close at −N to the fill. Right of ENTRY: buy-and-hold from the fill in the trade&apos;s direction, ignoring the strategy&apos;s exits; MFE/MAE use bar extremes; TP/SL hit = first bar after the entry bar whose range touched the level.</>}
      </p>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="grid h-[420px] place-items-center px-6 text-center text-sm text-[#93a1b6]">{text}</div>;
}
