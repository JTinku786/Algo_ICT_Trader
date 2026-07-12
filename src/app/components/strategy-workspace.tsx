"use client";

import {
  BarChart3,
  BookOpenText,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Filter,
  LineChart,
  LoaderCircle,
  RefreshCw,
  Rows3,
  Target,
  TrendingUp,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TradePrefill } from "./trade-navigation";
import { StrategyLink } from "./blog-context";

type TradeSource = "backtest" | "realtime";

type Trade = {
  order_id: string;
  symbol: string;
  strategy_id: string | null;
  strategy_name?: string | null;
  direction: string | null;
  close_ts: string | null;
  filled_at: string | null;
  filled?: number | null;
  stop?: number | null;
  close_price?: number | null;
  pnl_usd?: number | null;
  r?: number | null;
  hold_min?: number | null;
  outcome?: string | null;
  source?: TradeSource;
};

type Source = "all" | "backtest" | "realtime";

type DayBucket = { pnl: number; rSum: number; hasUsd: boolean; wins: number; losses: number; trades: Trade[] };

type Summary = {
  net_pnl_usd?: number | null;
  win_rate_pct?: number | null;
  profit_factor?: number | null;
  expectancy_usd?: number | null;
  max_drawdown_usd?: number | null;
  avg_hold_min?: number | null;
  wins?: number;
  losses?: number;
};

type ApiResponse = {
  success: boolean;
  error?: string;
  total_trades?: number;
  returned?: number;
  summary?: Summary;
  trades?: Trade[];
  equity?: Array<{ ts?: string; equity?: number; cumulative_pnl?: number }>;
  filters?: { symbols?: string[]; strategies?: Array<{ strategy_id: string }> };
};

type RealtimeResponse = {
  success: boolean;
  error?: string;
  filters?: { markets?: string[]; tickers?: string[]; strategies?: string[] };
  outcomes_ledger?: Array<Record<string, unknown>>;
  open_orders?: Array<Record<string, unknown>>;
};

type StrategyRow = { id: string; trades: number; wins: number; pnl: number; rSum: number; hasUsd: boolean; winRate: number | null };

type JournalNote = { focus: string; review: string };

function money(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Unavailable";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function number(value: number | null | undefined, suffix = "") {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Unavailable";
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}${suffix}`;
}

function dayKey(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function decodeTicker(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function holdMinutes(filledAt: string | null | undefined, closeTs: string | null | undefined) {
  const a = filledAt ? Date.parse(filledAt) : NaN;
  const b = closeTs ? Date.parse(closeTs) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 60000) : null;
}

// Normalize a realtime-analytics ledger row into the shared Trade shape so the
// journal can present backtest and realtime executions side by side.
function realtimeRowToTrade(row: Record<string, unknown>): Trade {
  const numOrNull = (v: unknown) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const ticker = decodeTicker(row.ticker);
  const filledAt = (row.entry_datetime as string) ?? null;
  const closeTs = (row.close_ts as string) ?? null;
  return {
    order_id: String(row.order_id ?? row.signal_hash ?? `${ticker}-${filledAt ?? ""}`),
    symbol: ticker,
    strategy_id: (row.strategy_id as string) ?? null,
    strategy_name: (row.strategy as string) ?? null,
    direction: (row.direction as string) ?? null,
    close_ts: closeTs,
    filled_at: filledAt,
    filled: numOrNull(row.entry_price),
    stop: numOrNull(row.stoploss),
    close_price: numOrNull(row.close_price),
    pnl_usd: numOrNull(row.pnl_value),
    r: numOrNull(row.realized_r),
    hold_min: holdMinutes(filledAt, closeTs),
    outcome: (row.outcome as string) ?? null,
    source: "realtime",
  };
}

function computeSummary(trades: Trade[]): Summary {
  const closed = trades.filter((t) => t.outcome === "WIN" || t.outcome === "LOSS");
  const wins = closed.filter((t) => t.outcome === "WIN");
  const losses = closed.filter((t) => t.outcome === "LOSS");
  const withUsd = closed.filter((t) => t.pnl_usd !== null && t.pnl_usd !== undefined);
  const netUsd = withUsd.reduce((sum, t) => sum + (t.pnl_usd ?? 0), 0);
  const grossWinR = wins.reduce((sum, t) => sum + Math.max(0, t.r ?? 0), 0);
  const grossLossR = Math.abs(losses.reduce((sum, t) => sum + Math.min(0, t.r ?? 0), 0));
  const holds = closed.map((t) => t.hold_min).filter((v): v is number => v !== null && v !== undefined);
  // USD drawdown over the chronological closed sequence
  const chronological = [...closed].sort((a, b) => (a.close_ts ?? "").localeCompare(b.close_ts ?? ""));
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of chronological) {
    equity += t.pnl_usd ?? 0;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity - peak);
  }
  return {
    net_pnl_usd: withUsd.length ? Math.round(netUsd) : null,
    win_rate_pct: closed.length ? Math.round((wins.length / closed.length) * 1000) / 10 : null,
    profit_factor: grossLossR > 0 ? Math.round((grossWinR / grossLossR) * 100) / 100 : null,
    expectancy_usd: withUsd.length ? Math.round(netUsd / withUsd.length) : null,
    max_drawdown_usd: withUsd.length ? Math.round(maxDd) : null,
    avg_hold_min: holds.length ? Math.round(holds.reduce((a, b) => a + b, 0) / holds.length) : null,
    wins: wins.length,
    losses: losses.length,
  };
}

function dayValueLabel(bucket: DayBucket) {
  return bucket.hasUsd ? money(bucket.pnl) : `${number(bucket.rSum, "R")}`;
}

export default function StrategyWorkspace({ mode, initialSelection }: { mode: "tradezella" | "stonk"; initialSelection?: TradePrefill | null }) {
  const cameFromRealtime = Boolean(initialSelection?.signal_hash || initialSelection?.order_id);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [source, setSource] = useState<Source>(cameFromRealtime ? "all" : "all");
  const [market, setMarket] = useState(initialSelection?.market || "ALL");
  const [strategy, setStrategy] = useState(initialSelection?.strategy_id || "ALL");
  const [symbol, setSymbol] = useState(initialSelection?.ticker ? decodeTicker(initialSelection.ticker) : "ALL");
  const [direction, setDirection] = useState(initialSelection?.direction || "ALL");
  const [trades, setTrades] = useState<Trade[]>([]);
  const [symbolOptions, setSymbolOptions] = useState<string[]>([]);
  const [strategyOptions, setStrategyOptions] = useState<string[]>([]);
  const [month, setMonth] = useState(() => {
    const date = new Date();
    return new Date(date.getFullYear(), date.getMonth(), 1);
  });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, JournalNote>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const wantBacktest = source !== "realtime";
    const wantRealtime = source !== "backtest";
    try {
      const merged: Trade[] = [];
      const symbolSet = new Set<string>();
      const strategySet = new Set<string>();

      const jobs: Promise<void>[] = [];

      if (wantBacktest) {
        const query = new URLSearchParams({ market, symbol, strategy_id: strategy, direction, target_no: "1" });
        jobs.push(
          fetch(`/api/backtest?${query}`, { cache: "no-store" })
            .then((r) => r.json() as Promise<ApiResponse>)
            .then((payload) => {
              if (!payload.success) throw new Error(payload.error || "Backtest request failed");
              for (const t of payload.trades ?? []) merged.push({ ...t, source: "backtest" });
              for (const s of payload.filters?.symbols ?? []) symbolSet.add(s);
              for (const s of payload.filters?.strategies ?? []) if (s.strategy_id) strategySet.add(s.strategy_id);
            }),
        );
      }

      if (wantRealtime) {
        const query = new URLSearchParams({ market, ticker: symbol, strategy, direction, status: "ALL", page: "1", page_size: "100" });
        jobs.push(
          fetch(`/api/realtime-analytics?${query}`, { cache: "no-store" })
            .then((r) => r.json() as Promise<RealtimeResponse>)
            .then((payload) => {
              if (!payload.success) throw new Error(payload.error || "Realtime request failed");
              for (const row of payload.outcomes_ledger ?? []) merged.push(realtimeRowToTrade(row));
              for (const s of payload.filters?.tickers ?? []) symbolSet.add(decodeTicker(s));
              for (const s of payload.filters?.strategies ?? []) if (s) strategySet.add(s);
            }),
        );
      }

      await Promise.all(jobs);
      merged.sort((a, b) => (b.close_ts ?? "").localeCompare(a.close_ts ?? ""));
      setTrades(merged);
      setSymbolOptions([...symbolSet].sort());
      setStrategyOptions([...strategySet].sort());
    } catch (cause) {
      setTrades([]);
      setError(cause instanceof Error ? cause.message : "Unable to load strategy analytics");
    } finally {
      setLoading(false);
    }
  }, [direction, market, source, strategy, symbol]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const summary = useMemo(() => computeSummary(trades), [trades]);

  const byDay = useMemo(() => {
    const map = new Map<string, DayBucket>();
    for (const trade of trades) {
      const key = dayKey(trade.close_ts);
      if (!key) continue;
      const row = map.get(key) ?? { pnl: 0, rSum: 0, hasUsd: false, wins: 0, losses: 0, trades: [] };
      row.pnl += trade.pnl_usd ?? 0;
      row.rSum += trade.r ?? 0;
      if (trade.pnl_usd !== null && trade.pnl_usd !== undefined) row.hasUsd = true;
      row.wins += trade.outcome === "WIN" ? 1 : 0;
      row.losses += trade.outcome === "LOSS" ? 1 : 0;
      row.trades.push(trade);
      map.set(key, row);
    }
    return map;
  }, [trades]);

  const strategyIds = useMemo(() => [...new Set([...strategyOptions, ...trades.map((t) => t.strategy_id).filter((v): v is string => Boolean(v))])], [strategyOptions, trades]);
  const strategyRows = useMemo(() => strategyIds.map((id) => {
    const rows = trades.filter((trade) => trade.strategy_id === id);
    const wins = rows.filter((trade) => trade.outcome === "WIN").length;
    const closed = rows.filter((trade) => trade.outcome === "WIN" || trade.outcome === "LOSS").length;
    const hasUsd = rows.some((trade) => trade.pnl_usd !== null && trade.pnl_usd !== undefined);
    const pnl = rows.reduce((sum, trade) => sum + (trade.pnl_usd ?? 0), 0);
    const rSum = rows.reduce((sum, trade) => sum + (trade.r ?? 0), 0);
    return { id, trades: rows.length, wins, pnl, rSum, hasUsd, winRate: closed ? (wins / closed) * 100 : null };
  }).filter((row) => row.trades > 0), [strategyIds, trades]);

  const hasData = trades.length > 0;

  return (
    <section className="mx-auto max-w-[1600px] space-y-4">
      <header className="flex flex-col gap-4 rounded-xl border border-white/10 bg-[#101620] p-4 xl:flex-row xl:items-center">
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#d9a441]">
            {mode === "tradezella" ? <CalendarDays className="size-4" /> : <Rows3 className="size-4" />}
            {mode === "tradezella" ? "Journal workspace" : "Execution workspace"}
          </div>
          <h1 className="text-2xl font-semibold text-white">
            {mode === "tradezella" ? "Strategy journal & calendar" : "Stonk-style strategy ledger"}
          </h1>
          <p className="mt-1 text-sm text-[#93a1b6]">Backtested and realtime executions · All available markets, stocks and strategies</p>
        </div>
        <div className="flex flex-wrap gap-2 xl:ml-auto">
          <Select label="Source" value={source} onChange={(value) => setSource(value as Source)} options={["all", "backtest", "realtime"]} />
          <Select label="Market" value={market} onChange={setMarket} options={["ALL", "us", "india", "forex"]} />
          <Select label="Symbol" value={symbol} onChange={setSymbol} options={["ALL", ...symbolOptions.slice(0, 300)]} />
          <Select label="Strategy" value={strategy} onChange={setStrategy} options={["ALL", ...strategyIds]} />
          <Select label="Direction" value={direction} onChange={setDirection} options={["ALL", "BUY", "SELL"]} />
          <button onClick={() => void load()} className="grid size-10 place-items-center rounded-md border border-white/10 text-[#93a1b6] hover:border-[#d9a441]/50 hover:text-[#f2c873]" aria-label="Refresh data">
            <RefreshCw className={cx("size-4", loading && "animate-spin")} />
          </button>
        </div>
      </header>

      {error ? <ErrorState message={error} retry={load} /> : null}
      {loading && !hasData ? <LoadingState /> : null}
      {!loading && !hasData && !error ? <EmptyState source={source} fromRealtime={cameFromRealtime} /> : null}

      {hasData ? mode === "tradezella" ? (
        <TradeZellaView summary={summary} totalTrades={trades.length} trades={trades} byDay={byDay} month={month} setMonth={setMonth} selectedDay={selectedDay} setSelectedDay={setSelectedDay} notes={notes} setNotes={setNotes} strategyRows={strategyRows} />
      ) : (
        <StonkView summary={summary} trades={trades} strategyRows={strategyRows} />
      ) : null}
      {initialSelection ? <div className="rounded-xl border border-violet-400/20 bg-violet-400/[0.05] p-4 text-xs text-violet-100/70"><span className="font-semibold text-violet-200">Realtime selection:</span> {decodeTicker(initialSelection.ticker)} · {initialSelection.strategy_id} · {initialSelection.direction} · Entry {number(initialSelection.entry_price)} · SL {number(initialSelection.stoploss)} · TP1 {number(initialSelection.tp1)} · TP2 {number(initialSelection.tp2)} · TP3 {number(initialSelection.tp3)}</div> : null}
    </section>
  );
}

function TradeZellaView({ summary, totalTrades, trades, byDay, month, setMonth, selectedDay, setSelectedDay, notes, setNotes, strategyRows }: {
  summary: Summary;
  totalTrades: number;
  trades: Trade[];
  byDay: Map<string, DayBucket>;
  month: Date;
  setMonth: (date: Date) => void;
  selectedDay: string | null;
  setSelectedDay: (day: string | null) => void;
  notes: Record<string, JournalNote>;
  setNotes: (notes: Record<string, JournalNote>) => void;
  strategyRows: StrategyRow[];
}) {
  const selected = selectedDay ? byDay.get(selectedDay) : undefined;
  return <>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <Metric label="Net P&L" value={money(summary.net_pnl_usd)} icon={LineChart} tone={(summary.net_pnl_usd ?? 0) >= 0 ? "green" : "red"} />
      <Metric label="Win rate" value={number(summary.win_rate_pct, "%")} icon={Target} tone="blue" />
      <Metric label="Profit factor" value={number(summary.profit_factor)} icon={BarChart3} tone="gold" />
      <Metric label="Expectancy" value={money(summary.expectancy_usd)} icon={TrendingUp} tone="green" />
      <Metric label="Closed trades" value={String(totalTrades)} icon={Rows3} tone="blue" />
    </div>
    <div className="grid gap-4 xl:grid-cols-[1.6fr_0.8fr]">
      <CalendarPanel month={month} setMonth={setMonth} byDay={byDay} selectedDay={selectedDay} setSelectedDay={setSelectedDay} />
      <JournalPanel key={selectedDay ?? "empty"} selectedDay={selectedDay} day={selected} note={selectedDay ? notes[selectedDay] : undefined} save={(note) => selectedDay && setNotes({ ...notes, [selectedDay]: note })} />
    </div>
    <div className="grid gap-4 xl:grid-cols-[0.8fr_1.6fr]">
      <StrategyCards rows={strategyRows} />
      <TradeTable trades={selected?.trades ?? trades.slice(0, 12)} compact={false} />
    </div>
  </>;
}

function StonkView({ summary, trades, strategyRows }: { summary: Summary; trades: Trade[]; strategyRows: StrategyRow[] }) {
  const pnlValues = trades.slice().reverse().reduce<number[]>((values, trade) => {
    values.push((values.at(-1) ?? 0) + (trade.pnl_usd ?? 0));
    return values;
  }, []);
  const max = Math.max(...pnlValues.map(Math.abs), 1);
  return <>
    <div className="grid gap-4 xl:grid-cols-[1fr_2fr]">
      <div className="rounded-xl border border-cyan-400/20 bg-gradient-to-br from-[#071b2d] to-[#0b1221] p-5">
        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Account performance</div>
        <div className={cx("mt-3 font-mono text-4xl font-bold", (summary.net_pnl_usd ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300")}>{money(summary.net_pnl_usd)}</div>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <Mini label="Wins" value={String(summary.wins ?? "Unavailable")} />
          <Mini label="Losses" value={String(summary.losses ?? "Unavailable")} />
          <Mini label="Avg hold" value={number(summary.avg_hold_min, "m")} />
          <Mini label="Max DD" value={money(summary.max_drawdown_usd)} />
        </div>
      </div>
      <div className="rounded-xl border border-cyan-400/20 bg-[#0a1320] p-5">
        <div className="mb-5 flex items-center justify-between"><h2 className="font-semibold">Cumulative result</h2><span className="font-mono text-[10px] text-[#7f8ca3]">SOURCE · POSTGRES</span></div>
        <div className="flex h-44 items-end gap-1 border-b border-cyan-400/10">
          {pnlValues.slice(-80).map((value, index) => <div key={index} className={cx("min-w-1 flex-1 rounded-t-sm", value >= 0 ? "bg-cyan-400/70" : "bg-rose-400/70")} style={{ height: `${Math.max(3, Math.abs(value) / max * 100)}%` }} title={money(value)} />)}
        </div>
      </div>
    </div>
    <StrategyCards rows={strategyRows} stonk />
    <TradeTable trades={trades} compact />
  </>;
}

function CalendarPanel({ month, setMonth, byDay, selectedDay, setSelectedDay }: { month: Date; setMonth: (date: Date) => void; byDay: Map<string, DayBucket>; selectedDay: string | null; setSelectedDay: (day: string | null) => void }) {
  const startOffset = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: 42 }, (_, index) => index - startOffset + 1);
  return <div className="rounded-xl border border-white/10 bg-[#101620] p-4">
    <div className="mb-4 flex items-center"><div><h2 className="font-semibold">Trading calendar</h2><p className="text-xs text-[#7f8ca3]">Close-date view in browser timezone</p></div><div className="ml-auto flex items-center gap-2"><button aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="grid size-8 place-items-center rounded border border-white/10"><ChevronLeft className="size-4" /></button><span className="w-32 text-center text-sm font-semibold">{month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span><button aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="grid size-8 place-items-center rounded border border-white/10"><ChevronRight className="size-4" /></button></div></div>
    <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-semibold uppercase text-[#657187]">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <div key={day} className="py-2">{day}</div>)}</div>
    <div className="grid grid-cols-7 gap-1">{cells.map((day, index) => {
      if (day < 1 || day > days) return <div key={index} className="min-h-20 rounded-md bg-black/10" />;
      const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const row = byDay.get(key);
      const positive = (row?.hasUsd ? row.pnl : row?.rSum ?? 0) >= 0;
      return <button key={key} onClick={() => setSelectedDay(key)} className={cx("min-h-20 rounded-md border p-2 text-left transition", selectedDay === key ? "border-[#d9a441] bg-[#d9a441]/10" : row ? positive ? "border-emerald-400/20 bg-emerald-400/[0.06] hover:border-emerald-400/50" : "border-rose-400/20 bg-rose-400/[0.06] hover:border-rose-400/50" : "border-white/5 bg-black/10 hover:border-white/20")}><span className="text-xs text-[#93a1b6]">{day}</span>{row ? <><div className={cx("mt-2 font-mono text-sm font-semibold", positive ? "text-emerald-300" : "text-rose-300")}>{dayValueLabel(row)}</div><div className="mt-1 text-[10px] text-[#7f8ca3]">{row.trades.length} trades · {row.wins}W/{row.losses}L</div></> : null}</button>;
    })}</div>
  </div>;
}

function JournalPanel({ selectedDay, day, note, save }: { selectedDay: string | null; day?: DayBucket; note?: JournalNote; save: (note: JournalNote) => void }) {
  const [focus, setFocus] = useState(note?.focus ?? "");
  const [review, setReview] = useState(note?.review ?? "");
  const dayPositive = (day?.hasUsd ? day.pnl : day?.rSum ?? 0) >= 0;
  return <div className="rounded-xl border border-white/10 bg-[#101620] p-4"><div className="mb-4 flex items-center gap-2"><BookOpenText className="size-4 text-[#d9a441]" /><h2 className="font-semibold">Daily journal</h2></div>{!selectedDay ? <div className="grid min-h-72 place-items-center text-center text-sm text-[#7f8ca3]">Select a calendar day to review its trades.</div> : <div className="space-y-4"><div className="rounded-md border border-white/10 bg-[#0b0f16] p-3"><div className="text-xs text-[#7f8ca3]">{selectedDay}</div><div className={cx("mt-1 font-mono text-2xl font-bold", dayPositive ? "text-emerald-300" : "text-rose-300")}>{day ? dayValueLabel(day) : "No closed trades"}</div></div><Field label="Daily focus" value={focus} setValue={setFocus} placeholder="What was the technical or execution focus?" /><Field label="Post-trade review" value={review} setValue={setReview} placeholder="Record observations without changing execution truth." rows={5} /><button onClick={() => save({ focus, review })} className="w-full rounded-md bg-[#d9a441] px-4 py-2 text-sm font-semibold text-[#151109]">Save locally for this session</button><p className="text-[10px] leading-4 text-[#657187]">Manual notes are session-only until the journal write API is implemented. Execution records remain immutable.</p></div>}</div>;
}

function StrategyCards({ rows, stonk = false }: { rows: StrategyRow[]; stonk?: boolean }) {
  return <div className={cx("grid gap-3", stonk ? "sm:grid-cols-2 xl:grid-cols-4" : "grid-cols-2")} >{rows.map((row) => <div key={row.id} className={cx("rounded-xl border p-4", stonk ? "border-cyan-400/20 bg-[#0a1320]" : "border-white/10 bg-[#101620]")}><div className="flex items-center justify-between"><StrategyLink code={row.id} label={row.id} className="font-mono text-lg font-bold text-white" showIcon /><span className="rounded-full bg-white/5 px-2 py-1 font-mono text-[10px] text-[#93a1b6]">n={row.trades}</span></div><div className="mt-5 grid grid-cols-2 gap-2"><Mini label="Win rate" value={number(row.winRate, "%")} /><Mini label="Net" value={row.trades ? (row.hasUsd ? money(row.pnl) : number(row.rSum, "R")) : "Unavailable"} /></div></div>)}</div>;
}

function TradeTable({ trades, compact }: { trades: Trade[]; compact: boolean }) {
  return <div className={cx("overflow-hidden rounded-xl border", compact ? "border-cyan-400/20 bg-[#07111d]" : "border-white/10 bg-[#101620]")}><div className="flex items-center gap-2 border-b border-white/10 px-4 py-3"><Filter className="size-4 text-[#d9a441]" /><h2 className="font-semibold">{compact ? "Execution ledger" : "Trades for selection"}</h2><span className="ml-auto font-mono text-[10px] text-[#657187]">{trades.length} SHOWN</span></div><div className="max-h-[560px] overflow-auto"><table className="w-full min-w-[900px] text-left font-mono text-xs"><thead className="sticky top-0 bg-[#0b0f16] text-[#7f8ca3]"><tr>{["Closed", "Symbol", "Strategy", "Side", "Entry", "Stop", "Exit", "Hold", "R", "Net", "Result"].map((label) => <th key={label} className="px-3 py-2 font-medium">{label}</th>)}</tr></thead><tbody className="divide-y divide-white/5">{trades.map((trade) => <tr key={trade.order_id} className="hover:bg-white/[0.03]"><td className="px-3 py-2 text-[#93a1b6]">{trade.close_ts ? new Date(trade.close_ts).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "Unavailable"}</td><td className="px-3 py-2 font-bold text-white">{trade.symbol}</td><td className="px-3 py-2"><StrategyLink code={trade.strategy_id} label={trade.strategy_id ?? "-"} className="text-cyan-300" /></td><td className={cx("px-3 py-2", trade.direction === "BUY" ? "text-emerald-300" : "text-rose-300")}>{trade.direction || "-"}</td><td className="px-3 py-2">{number(trade.filled)}</td><td className="px-3 py-2">{number(trade.stop)}</td><td className="px-3 py-2">{number(trade.close_price)}</td><td className="px-3 py-2">{number(trade.hold_min, "m")}</td><td className={cx("px-3 py-2", (trade.r ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300")}>{number(trade.r, "R")}</td><td className={cx("px-3 py-2 font-bold", (trade.pnl_usd ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300")}>{money(trade.pnl_usd)}</td><td className="px-3 py-2"><span className={cx("rounded px-2 py-1 text-[10px] font-bold", trade.outcome === "WIN" ? "bg-emerald-400/10 text-emerald-300" : "bg-rose-400/10 text-rose-300")}>{trade.outcome || "UNKNOWN"}</span></td></tr>)}</tbody></table></div></div>;
}

function Metric({ label, value, icon: Icon, tone }: { label: string; value: string; icon: React.ComponentType<{ className?: string }>; tone: "green" | "red" | "blue" | "gold" }) { const colors = { green: "text-emerald-300", red: "text-rose-300", blue: "text-cyan-300", gold: "text-[#f2c873]" }; return <div className="rounded-xl border border-white/10 bg-[#101620] p-4"><div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-[#7f8ca3]"><Icon className={cx("size-4", colors[tone])} />{label}</div><div className={cx("mt-3 font-mono text-2xl font-bold", colors[tone])}>{value}</div></div>; }
function Mini({ label, value }: { label: string; value: string }) { return <div><div className="text-[10px] uppercase tracking-wider text-[#657187]">{label}</div><div className="mt-1 truncate font-mono text-sm font-semibold text-[#d6deec]">{value}</div></div>; }
function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: readonly string[] }) { return <label className="flex h-10 items-center gap-2 rounded-md border border-white/10 bg-[#0b0f16] px-3 text-xs text-[#7f8ca3]"><span className="hidden sm:inline">{label}</span><select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} className="bg-transparent font-mono text-xs text-white outline-none">{Array.from(new Set(options)).map((option) => <option key={option} value={option} className="bg-[#101620]">{option}</option>)}</select></label>; }
function Field({ label, value, setValue, placeholder, rows = 2 }: { label: string; value: string; setValue: (value: string) => void; placeholder: string; rows?: number }) { return <label className="block"><span className="mb-2 block text-xs font-semibold text-[#93a1b6]">{label}</span><textarea rows={rows} value={value} onChange={(event) => setValue(event.target.value)} placeholder={placeholder} className="w-full resize-none rounded-md border border-white/10 bg-[#0b0f16] p-3 text-sm text-white outline-none placeholder:text-[#566176] focus:border-[#d9a441]/60" /></label>; }
function LoadingState() { return <div className="grid min-h-80 place-items-center rounded-xl border border-white/10 bg-[#101620]"><div className="text-center text-sm text-[#93a1b6]"><LoaderCircle className="mx-auto mb-3 size-7 animate-spin text-[#d9a441]" />Loading verified strategy data...</div></div>; }
function EmptyState({ source, fromRealtime }: { source: Source; fromRealtime: boolean }) {
  const hint = source === "backtest"
    ? "No backtested trades match this filter. Switch Source to \"all\" or \"realtime\" to include live executions."
    : source === "realtime"
      ? "No realtime executions match this filter yet. Switch Source to \"all\" or \"backtest\" to include historical trades."
      : fromRealtime
        ? "This realtime signal has no closed executions for the current filter. Widen the Symbol/Strategy/Direction filters to see related trades."
        : "Try another symbol, strategy or direction. The dashboard will not substitute demonstration performance.";
  return <div className="grid min-h-80 place-items-center rounded-xl border border-white/10 bg-[#101620]"><div className="max-w-md text-center"><Rows3 className="mx-auto mb-3 size-8 text-[#657187]" /><h2 className="font-semibold">No matching trades for this selection</h2><p className="mt-2 text-sm text-[#7f8ca3]">{hint}</p></div></div>;
}
function ErrorState({ message, retry }: { message: string; retry: () => Promise<void> }) { return <div className="flex items-center gap-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] p-4 text-sm text-rose-200"><CircleAlert className="size-5 shrink-0" /><div><div className="font-semibold">Strategy data unavailable</div><div className="mt-1 text-xs text-rose-200/70">{message}</div></div><button onClick={() => void retry()} className="ml-auto rounded-md border border-rose-300/20 px-3 py-2 text-xs font-semibold">Retry</button></div>; }
