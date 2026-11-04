"use client";

import { AlertTriangle, Clock3, Database, Gauge, LineChart, Percent, RefreshCw, RotateCcw, ShieldCheck, Target, Timer, TrendingDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shortStrategyLabel } from "@/lib/strategy-status";
import { OrderChart } from "./order-chart";

type TargetSummary = {
  target_no: number;
  original_rr_avg: number | null;
  valid: number;
  resolved: number;
  wins: number;
  losses: number;
  ambiguous: number;
  open: number;
  win_rate_pct: number | null;
  gross_r: number;
  cost_r: number;
  net_r: number;
  expectancy_r: number | null;
  cycle_net_r: number;
};

type Outcome = {
  target_no: number;
  original_rr: number;
  target_price: number;
  outcome: "WIN" | "LOSS" | "AMBIGUOUS" | "OPEN";
  exit_price: number | null;
  exit_at: string | null;
  net_r: number | null;
};

type Trade = {
  parent_order_id: string;
  market: string;
  ticker: string;
  strategy_id: string;
  parent_direction: "BUY" | "SELL";
  parent_filled_at: string;
  parent_entry: number;
  parent_stop: number;
  parent_close_reason: string | null;
  rejection_direction: "BUY" | "SELL" | null;
  rejection_entry_at: string | null;
  rejection_entry: number | null;
  rejection_stop: number | null;
  stop_candle_atr_pct: number | null;
  stop_candle_range_atr: number | null;
  stop_close_penetration_r: number | null;
  parent_favorable_extreme_at: string | null;
  parent_favorable_extreme_price: number | null;
  parent_max_favorable_points: number | null;
  parent_max_favorable_pct: number | null;
  parent_max_favorable_r: number | null;
  parent_tp1_progress_pct: number | null;
  parent_pre_rejection_lesson: "TP1_TOUCHED_BEFORE_REJECTION" | "SETUP_FAILED_BEFORE_TP1" | null;
  analysis_status: string;
  status_reason: string | null;
  outcomes: Outcome[];
};

type RejectionResponse = {
  success: boolean;
  error?: string;
  storage?: string;
  run?: {
    run_id: string;
    strategy_id: string;
    strategy_ids: string[];
    markets: string[];
    date_from: string;
    date_to: string;
    completed_at: string;
    candle_timeframe: string;
    cost_bps_per_side: number;
  };
  counts?: {
    stored_trades: number;
    valid_reversals: number;
    recorded_stoplosses: number;
    candle_confirmed_reconciliations: number;
    excluded_non_price_stops: number;
    invalid_input: number;
    invalid_geometry: number;
    missing_stop_candle: number;
  };
  target_summary?: TargetSummary[];
  market_summary?: Array<{ market: string; trades: number; targets: TargetSummary[] }>;
  strategy_summary?: Array<{ strategy_id: string; trades: number; targets: TargetSummary[] }>;
  trades?: Trade[];
  warnings?: string[];
};

type Props = {
  market: string;
  tickers: string[];
  strategies: string[];
  direction: string;
  dateFrom: string;
  dateTo: string;
  /** Bumped by the parent's Run button; nothing loads until it is > 0. */
  runToken: number;
};

function numberText(value: number | null | undefined, suffix = "") {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}

function signedR(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`;
}

function dateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString([], {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function marketDateTime(value: string | null | undefined, market: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const isIndia = market.toLowerCase() === "india";
  return `${date.toLocaleString([], {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
    timeZone: isIndia ? "Asia/Kolkata" : "America/New_York",
  })} ${isIndia ? "IST" : "ET"}`;
}

function dateOnly(value: string | null | undefined) {
  if (!value) return "-";
  return value.slice(0, 10);
}

function displayTicker(value: string) {
  try {
    return decodeURIComponent(value).replace(/\.NS$/, "");
  } catch {
    return value.replace(/\.NS$/, "");
  }
}

function tone(value: number | null | undefined) {
  return (value ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300";
}

function parentLessonLabel(trade: Trade) {
  if (trade.parent_pre_rejection_lesson === "TP1_TOUCHED_BEFORE_REJECTION") return "TARGET TOUCHED";
  if (trade.parent_pre_rejection_lesson === "SETUP_FAILED_BEFORE_TP1") return "FAILED BEFORE TP1";
  return "-";
}

function stopEvidenceLabel(trade: Trade) {
  return trade.parent_close_reason === "broker_position_already_closed"
    ? "CANDLE CONFIRMED"
    : "RECORDED STOP";
}

function durationMinutes(from: string | null | undefined, to: string | null | undefined) {
  if (!from || !to) return null;
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 60_000);
}

function signedMetric(value: number | null | undefined, suffix: string) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `+${value.toFixed(2)}${suffix}`;
}

export function RejectionTradeAnalysis({ market, tickers, strategies, direction, dateFrom, dateTo, runToken }: Props) {
  const [data, setData] = useState<RejectionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [chartTrade, setChartTrade] = useState<Trade | null>(null);
  const [reentryCutoff, setReentryCutoff] = useState("ALL");
  const [minParentMinutes, setMinParentMinutes] = useState("ALL");
  const [progressOperator, setProgressOperator] = useState("ALL");
  const [progressPct, setProgressPct] = useState("80");
  const [volatilityMetric, setVolatilityMetric] = useState("ALL");
  const [volatilityOperator, setVolatilityOperator] = useState("gte");
  const [volatilityValue, setVolatilityValue] = useState("1");
  const chartScrollRef = useRef<HTMLDivElement | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      market,
      ticker: tickers.length ? tickers.join(",") : "ALL",
      strategy: strategies.length ? strategies.join(",") : "ALL",
      direction,
    });
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    if (reentryCutoff !== "ALL") params.set("reentry_cutoff", reentryCutoff);
    if (minParentMinutes !== "ALL") params.set("min_parent_minutes", minParentMinutes);
    if (progressOperator !== "ALL" && progressPct.trim()) {
      params.set("progress_op", progressOperator);
      params.set("progress_pct", progressPct.trim());
    }
    if (volatilityMetric !== "ALL" && volatilityValue.trim()) {
      params.set("volatility_metric", volatilityMetric);
      params.set("volatility_op", volatilityOperator);
      params.set("volatility_value", volatilityValue.trim());
    }
    return params;
  }, [dateFrom, dateTo, direction, market, minParentMinutes, progressOperator, progressPct, reentryCutoff, strategies, tickers, volatilityMetric, volatilityOperator, volatilityValue]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/rejection-analysis?${query}`, { cache: "no-store" });
      const payload = await response.json() as RejectionResponse;
      if (!response.ok || !payload.success) throw new Error(payload.error || `Request failed (${response.status})`);
      setData(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load stored rejection analysis");
    } finally {
      setLoading(false);
    }
  }, [query]);

  // Loads only on the parent's Run (runToken bump), never on mount or on a
  // filter change.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    if (runToken > 0) void loadRef.current();
  }, [runToken]);

  useEffect(() => {
    if (!chartTrade) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChartTrade(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [chartTrade]);

  useEffect(() => {
    if (!chartTrade) return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = chartScrollRef.current;
      if (viewport && viewport.scrollWidth > viewport.clientWidth) {
        viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) / 2;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [chartTrade]);

  if (loading && !data) {
    return <div className="flex min-h-48 items-center justify-center rounded-lg border border-white/10 bg-[#101620] text-sm text-[#93a1b6]"><RefreshCw className="mr-2 size-4 animate-spin" />Loading stored rejection run</div>;
  }
  if (error) {
    return <div className="rounded-lg border border-rose-400/25 bg-rose-400/[0.06] p-5 text-sm text-rose-100"><div className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" />Stored analysis unavailable</div><p className="mt-2 text-rose-100/70">{error}</p><button type="button" onClick={() => void load()} className="mt-4 inline-flex h-9 items-center gap-2 rounded-md border border-rose-300/25 px-3 text-xs font-semibold hover:bg-rose-300/10"><RefreshCw className="size-4" />Retry</button></div>;
  }
  if (!data) return <div className="grid h-48 place-items-center rounded-lg border border-white/10 bg-[#101620] px-6 text-center text-sm text-[#93a1b6]">Click Run to load the stored rejection analysis.</div>;

  const tp1 = data.target_summary?.[0];
  const counts = data.counts;
  const unresolved = (tp1?.open ?? 0) + (tp1?.ambiguous ?? 0);
  const notModeled = (counts?.stored_trades ?? 0) - (counts?.valid_reversals ?? 0);
  return (
    <div className="space-y-4">
      <section className="border-y border-cyan-300/15 bg-cyan-300/[0.035] px-4 py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div>
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-cyan-300"><Database className="size-4" />Stored rejection research</div>
            <h2 className="mt-1 text-lg font-semibold text-white">Live strategy rejection portfolio</h2>
            <p className="mt-1 text-xs text-cyan-100/70">{(data.run?.strategy_ids ?? []).map(shortStrategyLabel).join(" · ")}</p>
            <p className="mt-1 text-xs text-[#93a1b6]">Run {data.run?.run_id.slice(0, 8)} · {dateOnly(data.run?.date_from)} to {dateOnly(data.run?.date_to)} · completed {dateTime(data.run?.completed_at)}</p>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading} title="Reload stored results" className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-white/10 px-3 text-xs font-semibold text-[#c5cedc] hover:bg-white/[0.05] disabled:opacity-50 lg:ml-auto"><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />Reload stored run</button>
        </div>
      </section>

      <section className="border-y border-white/10 bg-[#0d131d] px-4 py-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <label className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#7f8ca3]">
            <span className="mb-1.5 flex items-center gap-2"><Clock3 className="size-4 text-cyan-300" />Reentry cutoff</span>
            <select aria-label="Reentry cutoff time" value={reentryCutoff} onChange={(event) => setReentryCutoff(event.target.value)} className="h-9 w-full rounded-md border border-white/10 bg-[#151c28] px-3 text-xs font-semibold normal-case text-white outline-none focus:border-cyan-300/50">
              <option value="ALL">No cutoff</option>
              <option value="13:00">1:00 PM local (ET / IST)</option>
              <option value="15:00">3:00 PM local (ET / IST)</option>
              <option value="15:15">3:15 PM local (ET / IST)</option>
              <option value="15:30">3:30 PM local (ET / IST)</option>
              <option value="15:45">3:45 PM local (ET / IST)</option>
            </select>
          </label>
          <label className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#7f8ca3]">
            <span className="mb-1.5 flex items-center gap-2"><Timer className="size-4 text-cyan-300" />Minimum parent age</span>
            <select aria-label="Minimum parent age before reentry" value={minParentMinutes} onChange={(event) => setMinParentMinutes(event.target.value)} className="h-9 w-full rounded-md border border-white/10 bg-[#151c28] px-3 text-xs font-semibold normal-case text-white outline-none focus:border-cyan-300/50">
              <option value="ALL">No minimum</option>
              {[15, 30, 45, 60, 90, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
            </select>
          </label>
          <label className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#7f8ca3]">
            <span className="mb-1.5 flex items-center gap-2"><Percent className="size-4 text-cyan-300" />Parent fill to reentry TP1 progress</span>
            <select aria-label="TP1 progress comparison" value={progressOperator} onChange={(event) => setProgressOperator(event.target.value)} className="h-9 w-full rounded-md border border-white/10 bg-[#151c28] px-3 text-xs font-semibold normal-case text-white outline-none focus:border-cyan-300/50">
              <option value="ALL">No progress filter</option>
              <option value="gte">At least (≥)</option>
              <option value="lte">At most (≤)</option>
            </select>
          </label>
          <label className="w-36 text-[10px] font-bold uppercase tracking-[0.12em] text-[#7f8ca3]">
            <span className="mb-1.5 block">Target achieved</span>
            <span className="flex h-9 items-center rounded-md border border-white/10 bg-[#151c28] px-3 focus-within:border-cyan-300/50">
              <input aria-label="TP1 progress percentage" type="number" min="0" step="1" disabled={progressOperator === "ALL"} value={progressPct} onChange={(event) => setProgressPct(event.target.value)} className="min-w-0 flex-1 bg-transparent text-right text-xs font-semibold text-white outline-none disabled:text-[#657187]" />
              <span className="ml-1 text-xs text-[#7f8ca3]">%</span>
            </span>
          </label>
          <label className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#7f8ca3]">
            <span className="mb-1.5 flex items-center gap-2"><Gauge className="size-4 text-cyan-300" />Volatility metric</span>
            <select aria-label="Volatility metric" value={volatilityMetric} onChange={(event) => setVolatilityMetric(event.target.value)} className="h-9 w-full rounded-md border border-white/10 bg-[#151c28] px-3 text-xs font-semibold normal-case text-white outline-none focus:border-cyan-300/50">
              <option value="ALL">No volatility filter</option>
              <option value="atr_pct">ATR(14) as % of price</option>
              <option value="range_atr">Stop candle range / ATR</option>
              <option value="penetration_r">Stop close penetration (R)</option>
            </select>
          </label>
          <label className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#7f8ca3]">
            <span className="mb-1.5 block">Volatility comparison</span>
            <select aria-label="Volatility comparison" disabled={volatilityMetric === "ALL"} value={volatilityOperator} onChange={(event) => setVolatilityOperator(event.target.value)} className="h-9 w-full rounded-md border border-white/10 bg-[#151c28] px-3 text-xs font-semibold normal-case text-white outline-none focus:border-cyan-300/50 disabled:text-[#657187]">
              <option value="gte">At least (≥)</option>
              <option value="lte">At most (≤)</option>
            </select>
          </label>
          <label className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#7f8ca3]">
            <span className="mb-1.5 block">Volatility threshold</span>
            <span className="flex h-9 items-center rounded-md border border-white/10 bg-[#151c28] px-3 focus-within:border-cyan-300/50">
              <input aria-label="Volatility threshold" type="number" step="0.05" disabled={volatilityMetric === "ALL"} value={volatilityValue} onChange={(event) => setVolatilityValue(event.target.value)} className="min-w-0 flex-1 bg-transparent text-right text-xs font-semibold text-white outline-none disabled:text-[#657187]" />
              <span className="ml-1 text-xs text-[#7f8ca3]">{volatilityMetric === "atr_pct" ? "%" : volatilityMetric === "range_atr" ? "x" : "R"}</span>
            </span>
          </label>
          <div className="flex items-end gap-3">
            <button type="button" title="Reset rejection filters" onClick={() => { setReentryCutoff("ALL"); setMinParentMinutes("ALL"); setProgressOperator("ALL"); setProgressPct("80"); setVolatilityMetric("ALL"); setVolatilityOperator("gte"); setVolatilityValue("1"); }} className="grid size-9 place-items-center rounded-md border border-white/10 text-[#93a1b6] hover:bg-white/[0.05] hover:text-white"><RotateCcw className="size-4" /></button>
            <div className="pb-2 text-[11px] text-[#657187]">ET: US / forex · IST: India</div>
          </div>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryMetric label="Parent losses" value={numberText(counts?.valid_reversals)} note={`${counts?.recorded_stoplosses ?? 0} recorded · ${counts?.candle_confirmed_reconciliations ?? 0} candle-confirmed`} icon={Database} />
        <SummaryMetric label="TP1 win rate" value={numberText(tp1?.win_rate_pct, "%")} note={`${tp1?.wins ?? 0} wins · ${tp1?.losses ?? 0} losses · ${tp1?.open ?? 0} open`} icon={Target} />
        <SummaryMetric label="TP1 rejection net" value={signedR(tp1?.net_r)} note={`${signedR(tp1?.cost_r === undefined ? undefined : -Math.abs(tp1.cost_r))} modeled cost`} icon={ShieldCheck} valueClass={tone(tp1?.net_r)} />
        <SummaryMetric label="TP1 full cycle" value={signedR(tp1?.cycle_net_r)} note="Parent -1R plus rejection leg" icon={TrendingDown} valueClass={tone(tp1?.cycle_net_r)} />
        <SummaryMetric label="Unresolved / not modeled" value={numberText(unresolved + notModeled)} note={`${unresolved} unresolved · ${notModeled} excluded or invalid`} icon={AlertTriangle} />
      </div>

      <section className="overflow-hidden rounded-lg border border-white/10 bg-[#101620]">
        <div className="border-b border-white/10 px-4 py-3"><h3 className="text-sm font-semibold text-white">Target Ladder</h3><p className="mt-1 text-xs text-[#7f8ca3]">Independent exits · {numberText(data.run?.cost_bps_per_side)} bps per side · completed 5-minute candles</p></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[940px] text-left text-xs">
            <thead className="bg-white/[0.025] text-[#7f8ca3]"><tr>{["Target", "Avg original R:R", "Resolved", "W / L", "Win rate", "Open", "Ambiguous", "Gross R", "Costs", "Rejection net", "Full cycle"].map((label) => <th key={label} className="px-3 py-2 font-medium">{label}</th>)}</tr></thead>
            <tbody className="divide-y divide-white/5">{(data.target_summary ?? []).map((row) => <tr key={row.target_no}><td className="px-3 py-3 font-semibold text-cyan-300">TP{row.target_no}</td><td className="px-3 py-3 font-mono">{numberText(row.original_rr_avg, "R")}</td><td className="px-3 py-3 font-mono">{row.resolved}</td><td className="px-3 py-3 font-mono">{row.wins} / {row.losses}</td><td className="px-3 py-3 font-mono">{numberText(row.win_rate_pct, "%")}</td><td className="px-3 py-3 font-mono">{row.open}</td><td className="px-3 py-3 font-mono">{row.ambiguous}</td><td className={`px-3 py-3 font-mono ${tone(row.gross_r)}`}>{signedR(row.gross_r)}</td><td className="px-3 py-3 font-mono text-amber-300">{signedR(-Math.abs(row.cost_r))}</td><td className={`px-3 py-3 font-mono font-semibold ${tone(row.net_r)}`}>{signedR(row.net_r)}</td><td className={`px-3 py-3 font-mono font-semibold ${tone(row.cycle_net_r)}`}>{signedR(row.cycle_net_r)}</td></tr>)}</tbody>
          </table>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-white/10 bg-[#101620]">
        <div className="border-b border-white/10 px-4 py-3"><h3 className="text-sm font-semibold text-white">Strategy Attribution</h3><p className="mt-1 text-xs text-[#7f8ca3]">Independent TP1 rejection outcome by stopped parent strategy</p></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="bg-white/[0.025] text-[#7f8ca3]"><tr>{["Strategy", "Parent losses", "Resolved", "W / L", "TP1 win rate", "Rejection net", "Full cycle"].map((label) => <th key={label} className="px-3 py-2 font-medium">{label}</th>)}</tr></thead>
            <tbody className="divide-y divide-white/5">{(data.strategy_summary ?? []).map((item) => {
              const row = item.targets[0];
              return <tr key={item.strategy_id}><td className="px-3 py-3 font-semibold text-cyan-300">{shortStrategyLabel(item.strategy_id)}</td><td className="px-3 py-3 font-mono">{item.trades}</td><td className="px-3 py-3 font-mono">{row?.resolved ?? 0}</td><td className="px-3 py-3 font-mono">{row?.wins ?? 0} / {row?.losses ?? 0}</td><td className="px-3 py-3 font-mono">{numberText(row?.win_rate_pct, "%")}</td><td className={`px-3 py-3 font-mono font-semibold ${tone(row?.net_r)}`}>{signedR(row?.net_r)}</td><td className={`px-3 py-3 font-mono font-semibold ${tone(row?.cycle_net_r)}`}>{signedR(row?.cycle_net_r)}</td></tr>;
            })}</tbody>
          </table>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-white/10 bg-[#101620]">
        <div className="border-b border-white/10 px-4 py-3"><h3 className="text-sm font-semibold text-white">Market Attribution</h3><p className="mt-1 text-xs text-[#7f8ca3]">Stored outcomes separated by parent market</p></div>
        <div className="grid gap-px bg-white/10 md:grid-cols-3">{(data.market_summary ?? []).map((item) => {
          const row = item.targets[0];
          return <div key={item.market} className="bg-[#101620] p-4"><div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#93a1b6]">{item.market}</div><div className="mt-3 grid grid-cols-3 gap-3"><Mini label="Stops" value={numberText(item.trades)} /><Mini label="TP1 WR" value={numberText(row?.win_rate_pct, "%")} /><Mini label="TP1 net" value={signedR(row?.net_r)} valueClass={tone(row?.net_r)} /></div></div>;
        })}</div>
      </section>

      <section className="overflow-hidden rounded-lg border border-white/10 bg-[#101620]">
        <div className="border-b border-white/10 px-4 py-3"><h3 className="text-sm font-semibold text-white">Rejected Trade Ledger</h3><p className="mt-1 text-xs text-[#7f8ca3]">{data.trades?.length ?? 0} stored parent losses across the selected strategies</p></div>
        <div className="max-h-[620px] overflow-auto">
          <table className="w-full min-w-[1700px] text-left text-xs">
            <thead className="sticky top-0 z-10 bg-[#151c28] text-[#7f8ca3]"><tr>{["Market", "Strategy", "Ticker", "Parent", "Parent fill", "Entry / stop", "Stop evidence", "Volatility", "Parent lesson", "Rejection", "Rejection entry", "Stop", "TP1", "TP2", "TP3", "Status", "Chart"].map((label) => <th key={label} className="px-3 py-2 font-medium">{label}</th>)}</tr></thead>
            <tbody className="divide-y divide-white/5">{(data.trades ?? []).map((trade) => (
              <tr key={trade.parent_order_id} onClick={() => trade.analysis_status === "VALID" && setChartTrade(trade)} className={trade.analysis_status === "VALID" ? "cursor-pointer hover:bg-cyan-300/[0.035]" : "hover:bg-white/[0.025]"}>
                <td className="px-3 py-2 uppercase text-[#93a1b6]">{trade.market}</td>
                <td className="px-3 py-2 font-mono text-cyan-100">{shortStrategyLabel(trade.strategy_id)}</td>
                <td className="px-3 py-2 font-mono font-semibold text-cyan-300">{displayTicker(trade.ticker)}</td>
                <td className={`px-3 py-2 font-semibold ${trade.parent_direction === "BUY" ? "text-emerald-300" : "text-rose-300"}`}>{trade.parent_direction}</td>
                <td className="px-3 py-2 text-[#93a1b6]">{marketDateTime(trade.parent_filled_at, trade.market)}</td>
                <td className="px-3 py-2 font-mono">{numberText(trade.parent_entry)} / {numberText(trade.parent_stop)}</td>
                <td className="px-3 py-2"><span title={trade.status_reason ?? undefined} className={`whitespace-nowrap font-mono text-[10px] font-semibold ${trade.parent_close_reason === "broker_position_already_closed" ? "text-amber-300" : "text-cyan-300"}`}>{stopEvidenceLabel(trade)}</span></td>
                <td className="px-3 py-2 font-mono text-[10px] text-[#93a1b6]">
                  <div>{numberText(trade.stop_candle_atr_pct, "%")} ATR · {numberText(trade.stop_candle_range_atr, "x")} range</div>
                  <div className="mt-0.5">{signedR(trade.stop_close_penetration_r)} penetration</div>
                </td>
                <td className="px-3 py-2" title={`${trade.parent_direction === "BUY" ? "Maximum high" : "Minimum low"} ${numberText(trade.parent_favorable_extreme_price)} at ${marketDateTime(trade.parent_favorable_extreme_at, trade.market)}`}>
                  <div className={`font-semibold ${trade.parent_pre_rejection_lesson === "TP1_TOUCHED_BEFORE_REJECTION" ? "text-emerald-300" : trade.parent_pre_rejection_lesson ? "text-amber-300" : "text-[#657187]"}`}>{parentLessonLabel(trade)}</div>
                  <div className="mt-0.5 whitespace-nowrap font-mono text-[10px] text-[#93a1b6]">{signedMetric(trade.parent_max_favorable_pct, "%")} · {signedMetric(trade.parent_max_favorable_r, "R")} · {numberText(trade.parent_tp1_progress_pct, "%")} TP1</div>
                </td>
                <td className={`px-3 py-2 font-semibold ${trade.rejection_direction === "BUY" ? "text-emerald-300" : "text-rose-300"}`}>{trade.rejection_direction ?? "-"}</td>
                <td className="px-3 py-2">
                  <div className="font-mono">{numberText(trade.rejection_entry)}</div>
                  <div className="mt-0.5 text-[10px] text-[#657187]">{marketDateTime(trade.rejection_entry_at, trade.market)} · {numberText(durationMinutes(trade.parent_filled_at, trade.rejection_entry_at), " min")}</div>
                </td>
                <td className="px-3 py-2 font-mono">{numberText(trade.rejection_stop)}</td>
                {[1, 2, 3].map((targetNo) => <td key={targetNo} className="px-3 py-2"><OutcomeBadge outcome={trade.outcomes.find((item) => item.target_no === targetNo)} /></td>)}
                <td className="px-3 py-2"><span title={trade.status_reason ?? undefined} className="font-mono text-[10px] text-[#93a1b6]">{trade.analysis_status}</span></td>
                <td className="px-3 py-2"><button type="button" disabled={trade.analysis_status !== "VALID"} onClick={(event) => { event.stopPropagation(); setChartTrade(trade); }} title="Open complete rejection candle chart" className="grid size-8 place-items-center rounded-md border border-cyan-300/20 text-cyan-300 hover:bg-cyan-300/10 disabled:cursor-not-allowed disabled:opacity-30"><LineChart className="size-4" /></button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      <div className="border-y border-amber-300/15 bg-amber-300/[0.035] px-4 py-3 text-xs leading-5 text-amber-100/70">{(data.warnings ?? []).map((warning) => <div key={warning}>• {warning}</div>)}</div>

      {chartTrade && data.run ? (
        <div role="dialog" aria-modal="true" aria-label={`${chartTrade.strategy_id} rejection chart for ${displayTicker(chartTrade.ticker)}`} onClick={() => setChartTrade(null)} className="fixed inset-0 z-[70] overflow-y-auto bg-black/80 p-2 backdrop-blur-sm md:p-6">
          <div onClick={(event) => event.stopPropagation()} className="mx-auto max-w-[1500px] overflow-hidden rounded-lg border border-cyan-300/20 bg-[#0b0f16] shadow-2xl shadow-black">
            <div className="border-b border-white/10 px-4 py-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-cyan-300">Complete rejection candle chart</div>
              <h3 className="mt-1 text-base font-semibold text-white">{displayTicker(chartTrade.ticker)} · {shortStrategyLabel(chartTrade.strategy_id)} · {chartTrade.parent_direction} parent → {chartTrade.rejection_direction} rejection</h3>
              {chartTrade.parent_pre_rejection_lesson ? <p className={`mt-2 text-xs font-semibold ${chartTrade.parent_pre_rejection_lesson === "TP1_TOUCHED_BEFORE_REJECTION" ? "text-emerald-300" : "text-amber-300"}`}>Pre-rejection lesson · {parentLessonLabel(chartTrade)} · {chartTrade.parent_direction === "BUY" ? "MAX HIGH" : "MIN LOW"} {numberText(chartTrade.parent_favorable_extreme_price)} · {signedMetric(chartTrade.parent_max_favorable_pct, "%")} · {signedMetric(chartTrade.parent_max_favorable_r, "R")} · {numberText(chartTrade.parent_tp1_progress_pct, "%")} of TP1</p> : null}
            </div>
            <div ref={chartScrollRef} className="overflow-x-auto">
              <div className="min-w-[980px]">
                <OrderChart
                  order={{
                    order_id: chartTrade.parent_order_id,
                    symbol: chartTrade.ticker,
                    strategy_id: `${chartTrade.strategy_id}-Rejection`,
                    direction: chartTrade.rejection_direction,
                    r: chartTrade.outcomes.find((item) => item.target_no === 1)?.net_r ?? null,
                  }}
                  targetNo="1"
                  endpoint={`/api/realtime-analytics/order-chart?rejection_run_id=${encodeURIComponent(data.run.run_id)}`}
                  onClose={() => setChartTrade(null)}
                  height={560}
                  showSimilarTrades={false}
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SummaryMetric({ label, value, note, icon: Icon, valueClass = "text-white" }: { label: string; value: string; note: string; icon: typeof Database; valueClass?: string }) {
  return <div className="rounded-lg border border-white/10 bg-[#101620] p-4"><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[#7f8ca3]"><Icon className="size-4 text-cyan-300" />{label}</div><div className={`mt-3 text-2xl font-semibold ${valueClass}`}>{value}</div><div className="mt-1 text-xs text-[#657187]">{note}</div></div>;
}

function Mini({ label, value, valueClass = "text-white" }: { label: string; value: string; valueClass?: string }) {
  return <div><div className="text-[10px] uppercase text-[#657187]">{label}</div><div className={`mt-1 font-mono text-sm font-semibold ${valueClass}`}>{value}</div></div>;
}

function OutcomeBadge({ outcome }: { outcome?: Outcome }) {
  if (!outcome) return <span className="text-[#657187]">-</span>;
  const style = outcome.outcome === "WIN"
    ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
    : outcome.outcome === "LOSS"
      ? "border-rose-400/20 bg-rose-400/10 text-rose-300"
      : "border-amber-400/20 bg-amber-400/10 text-amber-300";
  return <span title={`${numberText(outcome.target_price)} · ${signedR(outcome.net_r)}`} className={`inline-flex rounded border px-1.5 py-0.5 font-mono text-[10px] ${style}`}>{outcome.outcome}</span>;
}
