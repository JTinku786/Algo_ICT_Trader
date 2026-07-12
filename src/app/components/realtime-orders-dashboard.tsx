"use client";

import {
  Activity,
  ArrowDown,
  ArrowUp,
  BarChart3,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  Filter,
  Layers3,
  LineChart,
  LoaderCircle,
  RefreshCw,
  Rows3,
  Target,
  TrendingDown,
  TrendingUp,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { TradePrefill } from "./trade-navigation";
import { OrderChart } from "./order-chart";
import { StrategyLink } from "./blog-context";

type FeedRow = TradePrefill & {
  base_symbol?: string | null;
  company_name?: string | null;
  exchange_timezone?: string | null;
  strategy?: string | null;
  strategy_key?: string | null;
  risk_points?: number | null;
  planned_rr?: number | null;
  realized_r?: number | null;
  pnl_points?: number | null;
  pnl_value?: number | null;
  close_price?: number | null;
  close_ts?: string | null;
  close_reason?: string | null;
  local_date?: string | null;
  timezone?: string | null;
};

type SeriesRow = { date: string; signals: number; buy: number; sell: number; net_r: number; wins: number; losses: number; win_rate_pct: number | null };
type MonthlyRow = { month: string; signals: number; wins: number; losses: number; net_r: number; win_rate_pct: number | null };
type StrategyPerformance = { strategy_id: string; strategy_name: string; orders: number; outcomes: number; win_rate_pct: number | null; avg_win_r: number | null; net_r: number; max_drawdown_r: number; profit_factor: number | null; expectancy_r: number | null };
type StrategyCoverage = { strategy_id: string; strategy_name: string; signals: number; buy: number; sell: number; tickers: number; avg_risk_points: number | null; share_pct: number };

type AnalyticsResponse = {
  success: boolean;
  error?: string;
  generated_at?: string;
  data_as_of?: string | null;
  warnings?: string[];
  filters?: { markets: string[]; tickers: string[]; strategies: string[] };
  counts?: {
    signals: number;
    orders: number;
    open: number;
    completed: number;
    latest_by_market: Array<{ market: string; timezone: string; date: string; orders: number; last_7_days: number; last_30_days: number }>;
  };
  summary?: {
    strategies: number;
    tickers: number;
    buy_setups: number;
    sell_setups: number;
    avg_risk_points: number | null;
    avg_planned_rr: number | null;
    outcomes: number;
    win_rate_pct: number | null;
    profit_factor: number | null;
    net_r: number;
    max_drawdown_r: number;
    sharpe_daily_r: number | null;
    buy_win_rate_pct: number | null;
    sell_win_rate_pct: number | null;
    expectancy_r: number | null;
  };
  series?: {
    daily: SeriesRow[];
    monthly: MonthlyRow[];
    equity: Array<{ date: string; daily_r: number; equity_r: number }>;
    weekdays: Array<{ day: string; net_r: number }>;
    rr_distribution: Array<{ label: string; count: number }>;
  };
  strategy_performance?: StrategyPerformance[];
  strategy_coverage?: StrategyCoverage[];
  open_orders?: FeedRow[];
  outcomes_ledger?: FeedRow[];
  pagination?: { page: number; page_size: number; total: number; pages: number };
  rows?: FeedRow[];
};

type Props = { onOpenTrade: (trade: TradePrefill, destination: "tradezella" | "stonk") => void };

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function fmt(value: number | null | undefined, suffix = "") {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Unavailable";
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}${suffix}`;
}

function dateTime(value: string | null | undefined, timezone?: string | null) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return date.toLocaleString("en-US", {
    timeZone: timezone || undefined,
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function displayTicker(value: string | null | undefined) {
  if (!value) return "Unavailable";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default function RealtimeOrdersDashboard({ onOpenTrade }: Props) {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [market, setMarket] = useState("ALL");
  const [ticker, setTicker] = useState("ALL");
  const [strategy, setStrategy] = useState("ALL");
  const [direction, setDirection] = useState("ALL");
  const [status, setStatus] = useState("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState("entry_datetime");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [periodMode, setPeriodMode] = useState<"daily" | "monthly">("daily");
  const [heatmapMode, setHeatmapMode] = useState<"daily" | "monthly">("daily");
  const [chartRow, setChartRow] = useState<FeedRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ market, ticker, strategy, direction, status, page: String(page), page_size: String(pageSize), sort, order });
    if (dateFrom) query.set("date_from", dateFrom);
    if (dateTo) query.set("date_to", dateTo);
    try {
      const response = await fetch(`/api/realtime-analytics?${query}`, { cache: "no-store" });
      const payload = (await response.json()) as AnalyticsResponse;
      if (!response.ok || !payload.success) throw new Error(payload.error || `Request failed (${response.status})`);
      setData(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load realtime analytics");
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, direction, market, order, page, pageSize, sort, status, strategy, ticker]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const resetPage = <T,>(setter: (value: T) => void, value: T) => {
    setter(value);
    setPage(1);
  };

  const setSortColumn = (column: string) => {
    if (sort === column) setOrder((value) => value === "asc" ? "desc" : "asc");
    else { setSort(column); setOrder("desc"); }
    setPage(1);
  };

  const dailyOrMonthly = periodMode === "daily" ? data?.series?.daily ?? [] : data?.series?.monthly ?? [];
  const heatmapRows = heatmapMode === "daily" ? data?.series?.daily ?? [] : data?.series?.monthly ?? [];

  return (
    <section className="mx-auto max-w-[1680px] space-y-4">
      <header className="rounded-xl border border-violet-400/20 bg-gradient-to-r from-[#161125] via-[#20123a] to-[#29154b] p-5 shadow-xl shadow-black/20">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center">
          <div>
            <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-violet-300"><Activity className="size-4" />Realtime execution intelligence</div>
            <h1 className="text-2xl font-semibold text-white md:text-3xl">Realtime ICT Orders</h1>
            <p className="mt-1 text-sm text-violet-100/60">Signals remain visible; performance is calculated only from persisted internal orders.</p>
          </div>
          <div className="xl:ml-auto">
            <div className="flex items-center gap-2 rounded-md border border-white/10 bg-black/20 px-3 py-2 text-xs text-violet-100/70">
              <Clock3 className="size-4 text-violet-300" />
              {market === "ALL"
                ? `Data as of ${dateTime(data?.data_as_of, "America/New_York")} / ${dateTime(data?.data_as_of, "Asia/Kolkata")}`
                : `Data as of ${dateTime(data?.data_as_of, market.toLowerCase() === "india" ? "Asia/Kolkata" : "America/New_York")}`}
            </div>
          </div>
        </div>
      </header>

      <div className="grid gap-2 rounded-xl border border-white/10 bg-[#101620] p-3 sm:grid-cols-2 xl:grid-cols-8">
        <Select label="Market" value={market} options={["ALL", ...(data?.filters?.markets ?? [])]} onChange={(value) => resetPage(setMarket, value)} />
        <Select label="Stock" value={ticker} options={["ALL", ...(data?.filters?.tickers ?? [])]} formatOption={displayTicker} onChange={(value) => resetPage(setTicker, value)} />
        <Select label="Strategy" value={strategy} options={["ALL", ...(data?.filters?.strategies ?? [])]} onChange={(value) => resetPage(setStrategy, value)} />
        <Select label="Direction" value={direction} options={["ALL", "BUY", "SELL"]} onChange={(value) => resetPage(setDirection, value)} />
        <Select label="Trade state" value={status} options={["ALL", "OPEN", "COMPLETED"]} onChange={(value) => resetPage(setStatus, value)} />
        <DateField label="From" value={dateFrom} onChange={(value) => resetPage(setDateFrom, value)} />
        <DateField label="To" value={dateTo} onChange={(value) => resetPage(setDateTo, value)} />
        <button onClick={() => void load()} className="flex h-11 items-center justify-center gap-2 rounded-md border border-violet-400/30 bg-violet-400/10 text-xs font-semibold text-violet-200 hover:bg-violet-400/20"><RefreshCw className={cx("size-4", loading && "animate-spin")} />Refresh</button>
      </div>

      {error ? <ErrorState message={error} retry={load} /> : null}
      {loading && !data ? <LoadingState /> : null}

      {data ? <>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {(data.counts?.latest_by_market ?? []).map((item) => <LatestDateCard key={item.market} item={item} />)}
          <CountCard label="All filtered signals" value={data.counts?.signals ?? 0} note={`${data.counts?.orders ?? 0} linked orders`} icon={Workflow} />
          <CountCard label="Open / Completed" value={data.counts?.open ?? 0} note={`${data.counts?.completed ?? 0} completed`} icon={Layers3} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-6">
          <Metric label="Signals" value={fmt(data.counts?.signals)} icon={Activity} tone="violet" />
          <Metric label="Strategies" value={fmt(data.summary?.strategies)} icon={Layers3} tone="blue" />
          <Metric label="Tickers" value={fmt(data.summary?.tickers)} icon={Rows3} tone="blue" />
          <Metric label="BUY setups" value={fmt(data.summary?.buy_setups)} icon={ArrowUp} tone="green" />
          <Metric label="SELL setups" value={fmt(data.summary?.sell_setups)} icon={ArrowDown} tone="red" />
          <Metric label="Avg risk points" value={fmt(data.summary?.avg_risk_points)} icon={Target} tone="gold" />
          <Metric label="Planned R:R" value={fmt(data.summary?.avg_planned_rr)} icon={Target} tone="gold" />
          <Metric label="Win rate" value={fmt(data.summary?.win_rate_pct, "%")} icon={TrendingUp} tone="green" note={`n=${data.summary?.outcomes ?? 0}`} />
          <Metric label="Profit factor" value={fmt(data.summary?.profit_factor)} icon={BarChart3} tone="green" />
          <Metric label="Net result" value={fmt(data.summary?.net_r, "R")} icon={LineChart} tone={(data.summary?.net_r ?? 0) >= 0 ? "green" : "red"} />
          <Metric label="Max drawdown" value={fmt(data.summary?.max_drawdown_r, "R")} icon={TrendingDown} tone="red" />
          <Metric label="Sharpe" value={fmt(data.summary?.sharpe_daily_r)} icon={Activity} tone="blue" note="Daily realized R" />
          <Metric label="BUY win rate" value={fmt(data.summary?.buy_win_rate_pct, "%")} icon={ArrowUp} tone="green" />
          <Metric label="SELL win rate" value={fmt(data.summary?.sell_win_rate_pct, "%")} icon={ArrowDown} tone="red" />
          <Metric label="Expectancy" value={fmt(data.summary?.expectancy_r, "R")} icon={Target} tone="violet" />
        </div>

        <FeedTable data={data} loading={loading} sort={sort} order={order} setSort={setSortColumn} pageSize={pageSize} setPageSize={(value) => { setPageSize(value); setPage(1); }} page={page} setPage={setPage} onOpenTrade={onOpenTrade} onOpenChart={setChartRow} activeChartKey={chartRow ? `${chartRow.signal_hash}-${chartRow.order_id ?? "signal"}` : null} />

        {chartRow ? <OrderChartPanel row={chartRow} onClose={() => setChartRow(null)} /> : null}

        <div className="grid gap-4 xl:grid-cols-2">
          <ChartCard title="Equity Curve" subtitle="Cumulative realized R · internal orders"><LineSeries rows={(data.series?.equity ?? []).map((row) => ({ label: row.date, value: row.equity_r }))} /></ChartCard>
          <ChartCard title="Daily P&L" subtitle="Realized R · daily or monthly" action={<Toggle value={periodMode} onChange={setPeriodMode} options={["daily", "monthly"]} />}><BarSeries rows={dailyOrMonthly.map((row) => ({ label: "date" in row ? row.date : row.month, value: row.net_r }))} /></ChartCard>
          <ChartCard title="Day-of-Week P&L" subtitle="Realized R by closing weekday"><BarSeries rows={(data.series?.weekdays ?? []).map((row) => ({ label: row.day, value: row.net_r }))} /></ChartCard>
          <ChartCard title="Win RR Distribution" subtitle="Closed internal outcomes"><BarSeries rows={(data.series?.rr_distribution ?? []).map((row) => ({ label: row.label, value: row.count }))} neutral /></ChartCard>
          <ChartCard title="Signal Volume by Day" subtitle="Only dates where signals were generated"><SignalVolume rows={data.series?.daily ?? []} /></ChartCard>
          <ChartCard title="Win-Rate Heatmap" subtitle="Closed outcomes only" action={<Toggle value={heatmapMode} onChange={setHeatmapMode} options={["daily", "monthly"]} />}><Heatmap rows={heatmapRows.map((row) => ({ label: "date" in row ? row.date : row.month, value: row.win_rate_pct, n: row.wins + row.losses }))} /></ChartCard>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <StrategyPerformanceTable rows={data.strategy_performance ?? []} />
          <StrategyCoverageTable rows={data.strategy_coverage ?? []} />
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <CompactLedger title="Open Trades" rows={data.open_orders ?? []} onOpenTrade={onOpenTrade} onOpenChart={setChartRow} />
          <CompactLedger title="Outcomes Ledger" rows={data.outcomes_ledger ?? []} onOpenTrade={onOpenTrade} onOpenChart={setChartRow} />
        </div>

        <div className="rounded-xl border border-amber-300/15 bg-amber-300/[0.04] p-4 text-xs leading-5 text-amber-100/70">
          {(data.warnings ?? []).map((warning) => <div key={warning}>• {warning}</div>)}
        </div>
      </> : null}
    </section>
  );
}

function FeedTable({ data, loading, sort, order, setSort, pageSize, setPageSize, page, setPage, onOpenTrade, onOpenChart, activeChartKey }: { data: AnalyticsResponse; loading: boolean; sort: string; order: "asc" | "desc"; setSort: (column: string) => void; pageSize: number; setPageSize: (value: number) => void; page: number; setPage: (value: number) => void; onOpenTrade: Props["onOpenTrade"]; onOpenChart: (row: FeedRow) => void; activeChartKey: string | null }) {
  const columns = [
    ["entry_datetime", "Entry time"], ["market", "Market"], ["ticker", "Ticker"], ["strategy_id", "Strategy"], ["direction", "Side"], ["entry", "Entry"], ["stop", "Stop"], ["tp1", "TP1"], ["tp2", "TP2"], ["tp3", "TP3"], ["state", "State"], ["realized_r", "R"],
  ];
  return <div className="overflow-hidden rounded-xl border border-violet-400/20 bg-[#0d1020]">
    <div className="flex flex-wrap items-center gap-3 border-b border-white/10 px-4 py-3"><Filter className="size-4 text-violet-300" /><div><h2 className="font-semibold">Realtime ICT Signal & Order Feed</h2><p className="text-xs text-[#7f8ca3]">Click any row to plot its ICT execution chart. Linked execution state appears when an order exists.</p></div><label className="ml-auto flex items-center gap-2 text-xs text-[#7f8ca3]">Rows<select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))} className="rounded border border-white/10 bg-[#101620] px-2 py-1 text-white"><option>10</option><option>25</option><option>50</option><option>100</option></select></label></div>
    <div className="overflow-x-auto"><table className="w-full min-w-[1560px] text-left text-xs"><thead className="bg-[#17122b] text-violet-300"><tr>{columns.map(([key, label]) => <th key={key} className="px-3 py-3"><button onClick={() => setSort(key === "entry" || key === "stop" || key.startsWith("tp") ? "entry_datetime" : key)} className="flex items-center gap-1 font-semibold uppercase tracking-wide">{label}{sort === key ? order === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : null}</button></th>)}<th className="px-3 py-3">Chart</th><th className="px-3 py-3">Open in</th></tr></thead><tbody className="divide-y divide-white/5">{(data.rows ?? []).map((row) => { const key = `${row.signal_hash}-${row.order_id ?? "signal"}`; return <tr key={key} onClick={() => onOpenChart(row)} className={cx("cursor-pointer hover:bg-violet-400/[0.06]", activeChartKey === key && "bg-violet-400/[0.12]")}><td className="px-3 py-2 font-mono text-[#b9c4d6]">{dateTime(row.entry_datetime, row.timezone)}</td><td className="px-3 py-2 uppercase text-[#93a1b6]">{row.market}</td><td className="px-3 py-2 font-mono font-bold text-violet-300">{displayTicker(row.ticker)}</td><td className="px-3 py-2"><StrategyLink code={row.strategy_id} label={row.strategy_id ?? "-"} className="font-mono text-cyan-300" /><div className="max-w-56 truncate text-[10px] text-[#657187]">{row.strategy}</div></td><td className={cx("px-3 py-2 font-semibold", row.direction === "BUY" ? "text-emerald-300" : "text-rose-300")}>{row.direction}</td><td className="px-3 py-2 font-mono">{fmt(row.entry_price)}</td><td className="px-3 py-2 font-mono text-rose-300">{fmt(row.stoploss)}</td><td className="px-3 py-2 font-mono text-emerald-300">{fmt(row.tp1)}</td><td className="px-3 py-2 font-mono text-emerald-300">{fmt(row.tp2)}</td><td className="px-3 py-2 font-mono text-emerald-300">{fmt(row.tp3)}</td><td className="px-3 py-2"><OutcomeBadge value={row.outcome ?? row.state ?? "SIGNAL_ONLY"} /></td><td className={cx("px-3 py-2 font-mono font-bold", (row.realized_r ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300")}>{fmt(row.realized_r, "R")}</td><td className="px-3 py-2"><OpenButton label="Chart" icon={LineChart} onClick={(event) => { event?.stopPropagation(); onOpenChart(row); }} /></td><td className="px-3 py-2"><div className="flex gap-1"><OpenButton label="Journal" onClick={(event) => { event?.stopPropagation(); onOpenTrade({ ...row, ticker: displayTicker(row.ticker) }, "tradezella"); }} /><OpenButton label="Stonk" onClick={(event) => { event?.stopPropagation(); onOpenTrade({ ...row, ticker: displayTicker(row.ticker) }, "stonk"); }} /></div></td></tr>; })}</tbody></table></div>
    {loading ? <div className="border-t border-white/5 px-4 py-2 text-xs text-violet-300">Refreshing rows…</div> : null}
    <div className="flex flex-wrap items-center gap-3 border-t border-white/10 px-4 py-3 text-xs text-[#7f8ca3]"><span>Showing {data.rows?.length ?? 0} of {data.pagination?.total ?? 0}</span><div className="ml-auto flex items-center gap-2"><button disabled={page <= 1} onClick={() => setPage(page - 1)} className="grid size-8 place-items-center rounded border border-white/10 disabled:opacity-30"><ChevronLeft className="size-4" /></button><span>Page {page} / {data.pagination?.pages ?? 1}</span><button disabled={page >= (data.pagination?.pages ?? 1)} onClick={() => setPage(page + 1)} className="grid size-8 place-items-center rounded border border-white/10 disabled:opacity-30"><ChevronRight className="size-4" /></button></div></div>
  </div>;
}

function OrderChartPanel({ row, onClose }: { row: FeedRow; onClose: () => void }) {
  const hasOrder = Boolean(row.order_id);
  const identifier = (row.order_id ?? row.signal_hash ?? "") as string;
  return (
    <div className="overflow-hidden rounded-xl border border-violet-400/25 bg-[#0d1020]">
      <div className="flex flex-wrap items-center gap-3 border-b border-white/10 px-4 py-3">
        <BarChart3 className="size-4 text-violet-300" />
        <div>
          <h2 className="font-semibold">ICT Execution Chart · {displayTicker(row.ticker)}</h2>
          <p className="text-xs text-[#7f8ca3]">{row.strategy_id} · {row.direction} · {hasOrder ? "linked order" : "signal only (no order placed)"}</p>
        </div>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-[#657187]">{row.market}</span>
      </div>
      <OrderChart
        order={{ order_id: identifier, symbol: displayTicker(row.ticker), strategy_id: row.strategy_id, direction: row.direction, r: row.realized_r }}
        endpoint="/api/realtime-analytics/order-chart"
        identifierParam={hasOrder ? "order_id" : "signal_hash"}
        identifier={identifier}
        targetNo="1"
        onClose={onClose}
      />
    </div>
  );
}

function LatestDateCard({ item }: { item: { market: string; timezone: string; date: string; orders: number; last_7_days: number; last_30_days: number } }) {
  const isIndia = item.market.toLowerCase() === "india";
  return <div className="rounded-xl border border-violet-400/20 bg-[#121426] p-4"><div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-violet-300"><CalendarClock className="size-4" />Latest traded date · {item.market.toUpperCase()}</div><div className="mt-3 text-xl font-semibold text-white">{item.date}</div><div className="mt-1 text-xs text-[#7f8ca3]">{isIndia ? "IST · Asia/Kolkata" : "ET · America/New_York"}</div><div className="mt-4 grid grid-cols-3 gap-2"><Mini label="Orders" value={fmt(item.orders)} /><Mini label="Last 7D" value={fmt(item.last_7_days)} /><Mini label="Last 30D" value={fmt(item.last_30_days)} /></div></div>;
}

function CountCard({ label, value, note, icon: Icon }: { label: string; value: number; note: string; icon: React.ComponentType<{ className?: string }> }) { return <div className="rounded-xl border border-white/10 bg-[#101620] p-4"><div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7f8ca3]"><Icon className="size-4 text-cyan-300" />{label}</div><div className="mt-3 font-mono text-3xl font-bold text-white">{value.toLocaleString()}</div><div className="mt-1 text-xs text-[#657187]">{note}</div></div>; }
function Metric({ label, value, note, icon: Icon, tone }: { label: string; value: string; note?: string; icon: React.ComponentType<{ className?: string }>; tone: "green" | "red" | "blue" | "gold" | "violet" }) { const colors = { green: "text-emerald-300", red: "text-rose-300", blue: "text-cyan-300", gold: "text-amber-300", violet: "text-violet-300" }; return <div className="rounded-xl border border-white/10 bg-[#101620] p-4"><div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#7f8ca3]"><Icon className={cx("size-4", colors[tone])} />{label}</div><div className={cx("mt-3 font-mono text-2xl font-bold", colors[tone])}>{value}</div>{note ? <div className="mt-1 text-[10px] text-[#657187]">{note}</div> : null}</div>; }
function Mini({ label, value }: { label: string; value: string }) { return <div><div className="text-[9px] uppercase text-[#657187]">{label}</div><div className="mt-1 font-mono text-sm font-semibold text-white">{value}</div></div>; }

function ChartCard({ title, subtitle, action, children }: { title: string; subtitle: string; action?: React.ReactNode; children: React.ReactNode }) { return <div className="rounded-xl border border-white/10 bg-[#101620] p-4"><div className="mb-4 flex items-start gap-3"><div><h2 className="font-semibold">{title}</h2><p className="text-xs text-[#657187]">{subtitle}</p></div>{action ? <div className="ml-auto">{action}</div> : null}</div>{children}</div>; }
function Toggle<T extends string>({ value, onChange, options }: { value: T; onChange: (value: T) => void; options: readonly T[] }) { return <div className="flex rounded-md border border-white/10 bg-black/20 p-0.5">{options.map((option) => <button key={option} onClick={() => onChange(option)} className={cx("rounded px-2 py-1 text-[10px] font-semibold uppercase", value === option ? "bg-violet-400/20 text-violet-200" : "text-[#657187]")}>{option}</button>)}</div>; }

function LineSeries({ rows }: { rows: Array<{ label: string; value: number }> }) {
  if (!rows.length) return <ChartEmpty />;
  const width = 800, height = 220, pad = 24;
  const values = rows.map((row) => row.value); const min = Math.min(...values, 0), max = Math.max(...values, 0); const range = Math.max(max - min, 1);
  const points = rows.map((row, index) => `${pad + index / Math.max(rows.length - 1, 1) * (width - pad * 2)},${pad + (max - row.value) / range * (height - pad * 2)}`).join(" ");
  return <svg viewBox={`0 0 ${width} ${height}`} className="h-56 w-full"><defs><linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8b5cf6" stopOpacity=".35" /><stop offset="1" stopColor="#8b5cf6" stopOpacity="0" /></linearGradient></defs>{[0,1,2,3,4].map((i)=><line key={i} x1={pad} x2={width-pad} y1={pad+i*(height-pad*2)/4} y2={pad+i*(height-pad*2)/4} stroke="rgba(255,255,255,.06)" />)}<polygon points={`${pad},${height-pad} ${points} ${width-pad},${height-pad}`} fill="url(#eq-fill)" /><polyline points={points} fill="none" stroke="#a78bfa" strokeWidth="3" strokeLinejoin="round" /></svg>;
}

function BarSeries({ rows, neutral = false }: { rows: Array<{ label: string; value: number }>; neutral?: boolean }) {
  if (!rows.length) return <ChartEmpty />;
  const max = Math.max(...rows.map((row) => Math.abs(row.value)), 1);
  return <div className="flex h-56 items-end gap-1 overflow-x-auto border-b border-white/10 px-1">{rows.slice(-60).map((row) => <div key={row.label} className="group flex min-w-5 flex-1 flex-col items-center justify-end"><div title={`${row.label}: ${fmt(row.value)}`} className={cx("w-full min-w-3 rounded-t-sm", neutral ? "bg-violet-400/70" : row.value >= 0 ? "bg-emerald-400/70" : "bg-rose-400/70")} style={{ height: `${Math.max(4, Math.abs(row.value) / max * 175)}px` }} /><span className="mt-2 max-w-16 truncate text-[8px] text-[#657187]">{row.label}</span></div>)}</div>;
}

function SignalVolume({ rows }: { rows: SeriesRow[] }) {
  if (!rows.length) return <ChartEmpty />;
  const width = 800, height = 220, pad = 24; const max = Math.max(...rows.map((row) => Math.max(row.buy, row.sell)), 1);
  const points = (key: "buy" | "sell") => rows.map((row, index) => `${pad + index / Math.max(rows.length - 1, 1) * (width - pad * 2)},${height-pad-row[key]/max*(height-pad*2)}`).join(" ");
  return <div><div className="mb-2 flex gap-4 text-[10px]"><span className="text-emerald-300">● BUY</span><span className="text-rose-300">● SELL</span></div><svg viewBox={`0 0 ${width} ${height}`} className="h-52 w-full"><polyline points={points("buy")} fill="none" stroke="#34d399" strokeWidth="2.5" /><polyline points={points("sell")} fill="none" stroke="#fb7185" strokeWidth="2.5" />{rows.map((row,index)=><g key={row.date}><circle cx={pad+index/Math.max(rows.length-1,1)*(width-pad*2)} cy={height-pad-row.buy/max*(height-pad*2)} r="3" fill="#34d399" /><circle cx={pad+index/Math.max(rows.length-1,1)*(width-pad*2)} cy={height-pad-row.sell/max*(height-pad*2)} r="3" fill="#fb7185" /></g>)}</svg></div>;
}

function Heatmap({ rows }: { rows: Array<{ label: string; value: number | null; n: number }> }) { if (!rows.length) return <ChartEmpty />; return <div className="grid max-h-56 grid-cols-4 gap-2 overflow-auto sm:grid-cols-6 lg:grid-cols-8">{rows.slice(-96).map((row) => <div key={row.label} title={`${row.label}: ${fmt(row.value, "%")} · n=${row.n}`} className={cx("rounded-md border p-2", row.value === null ? "border-white/5 bg-white/[0.02]" : row.value >= 67 ? "border-emerald-400/20 bg-emerald-400/15" : row.value >= 50 ? "border-cyan-400/20 bg-cyan-400/15" : "border-rose-400/20 bg-rose-400/15")}><div className="text-[9px] text-[#7f8ca3]">{row.label}</div><div className="mt-1 font-mono text-sm font-bold">{fmt(row.value, "%")}</div><div className="text-[9px] text-[#657187]">n={row.n}</div></div>)}</div>; }
function ChartEmpty() { return <div className="grid h-56 place-items-center text-sm text-[#657187]">No realized outcomes for this selection.</div>; }

function StrategyPerformanceTable({ rows }: { rows: StrategyPerformance[] }) { return <DataCard title="Strategy Performance" subtitle="Internal orders · realized R"><table className="w-full min-w-[760px] text-left text-xs"><thead><tr>{["Strategy","Orders","Outcomes","WR%","Avg Win R","Net R","Max DD R","PF","Exp. R"].map((label)=><th key={label} className="px-3 py-2 text-[#7f8ca3]">{label}</th>)}</tr></thead><tbody className="divide-y divide-white/5">{rows.map((row)=><tr key={row.strategy_id}><td className="px-3 py-2"><StrategyLink code={row.strategy_id} label={row.strategy_id} className="font-mono font-bold text-violet-300" /><div className="max-w-40 truncate text-[9px] text-[#657187]">{row.strategy_name}</div></td><td className="px-3 py-2">{row.orders}</td><td className="px-3 py-2">{row.outcomes}</td><td className="px-3 py-2">{fmt(row.win_rate_pct,"%")}</td><td className="px-3 py-2">{fmt(row.avg_win_r,"R")}</td><td className="px-3 py-2">{fmt(row.net_r,"R")}</td><td className="px-3 py-2 text-rose-300">{fmt(row.max_drawdown_r,"R")}</td><td className="px-3 py-2">{fmt(row.profit_factor)}</td><td className="px-3 py-2">{fmt(row.expectancy_r,"R")}</td></tr>)}</tbody></table></DataCard>; }
function StrategyCoverageTable({ rows }: { rows: StrategyCoverage[] }) { return <DataCard title="Strategy Coverage" subtitle="Signal generation footprint"><table className="w-full min-w-[720px] text-left text-xs"><thead><tr>{["Code","Strategy Name","Signals","BUY","SELL","Tickers","Avg Risk Pts","Share %"].map((label)=><th key={label} className="px-3 py-2 text-[#7f8ca3]">{label}</th>)}</tr></thead><tbody className="divide-y divide-white/5">{rows.map((row)=><tr key={row.strategy_id}><td className="px-3 py-2"><StrategyLink code={row.strategy_id} label={row.strategy_id} className="font-mono font-bold text-cyan-300" /></td><td className="max-w-48 truncate px-3 py-2">{row.strategy_name}</td><td className="px-3 py-2">{row.signals}</td><td className="px-3 py-2 text-emerald-300">{row.buy}</td><td className="px-3 py-2 text-rose-300">{row.sell}</td><td className="px-3 py-2">{row.tickers}</td><td className="px-3 py-2">{fmt(row.avg_risk_points)}</td><td className="px-3 py-2">{fmt(row.share_pct,"%")}</td></tr>)}</tbody></table></DataCard>; }
function DataCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) { return <div className="overflow-hidden rounded-xl border border-white/10 bg-[#101620]"><div className="border-b border-white/10 px-4 py-3"><h2 className="font-semibold">{title}</h2><p className="text-xs text-[#657187]">{subtitle}</p></div><div className="max-h-[430px] overflow-auto">{children}</div></div>; }

function CompactLedger({ title, rows, onOpenTrade, onOpenChart }: { title: string; rows: FeedRow[]; onOpenTrade: Props["onOpenTrade"]; onOpenChart: (row: FeedRow) => void }) { return <DataCard title={title} subtitle={`${rows.length} rows returned · click a row to chart`}><table className="w-full min-w-[760px] text-left text-xs"><thead><tr>{["Ticker","Strategy","Side","Entry time","State","R","Open in"].map((label)=><th key={label} className="px-3 py-2 text-[#7f8ca3]">{label}</th>)}</tr></thead><tbody className="divide-y divide-white/5">{rows.map((row)=><tr key={`${title}-${row.order_id}`} onClick={()=>onOpenChart(row)} className="cursor-pointer hover:bg-violet-400/[0.06]"><td className="px-3 py-2 font-mono font-bold text-violet-300">{displayTicker(row.ticker)}</td><td className="px-3 py-2"><StrategyLink code={row.strategy_id} label={row.strategy_id ?? "-"} className="text-cyan-300" /></td><td className={cx("px-3 py-2",row.direction==="BUY"?"text-emerald-300":"text-rose-300")}>{row.direction}</td><td className="px-3 py-2 text-[#93a1b6]">{dateTime(row.entry_datetime,row.timezone)}</td><td className="px-3 py-2"><OutcomeBadge value={row.outcome ?? row.state ?? "UNKNOWN"} /></td><td className="px-3 py-2 font-mono">{fmt(row.realized_r,"R")}</td><td className="px-3 py-2"><div className="flex gap-1"><OpenButton label="Chart" icon={LineChart} onClick={(event)=>{ event?.stopPropagation(); onOpenChart(row); }} /><OpenButton label="Journal" onClick={(event)=>{ event?.stopPropagation(); onOpenTrade({ ...row, ticker: displayTicker(row.ticker) },"tradezella"); }} /><OpenButton label="Stonk" onClick={(event)=>{ event?.stopPropagation(); onOpenTrade({ ...row, ticker: displayTicker(row.ticker) },"stonk"); }} /></div></td></tr>)}</tbody></table></DataCard>; }

function OutcomeBadge({ value }: { value: string }) { const v=value.toUpperCase(); const tone=v==="WIN"?"bg-emerald-400/10 text-emerald-300":v==="LOSS"?"bg-rose-400/10 text-rose-300":v==="OPEN"?"bg-cyan-400/10 text-cyan-300":"bg-white/5 text-[#93a1b6]"; return <span className={cx("rounded px-2 py-1 font-mono text-[9px] font-bold",tone)}>{value}</span>; }
function OpenButton({ label, onClick, icon: Icon = ExternalLink }: { label: string; onClick: (event?: React.MouseEvent) => void; icon?: React.ComponentType<{ className?: string }> }) { return <button onClick={(event) => onClick(event)} className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[9px] text-[#b9c4d6] hover:border-violet-400/40 hover:text-violet-200">{label}<Icon className="size-2.5" /></button>; }
function Select({ label, value, options, onChange, formatOption = (option) => option }: { label: string; value: string; options: string[]; onChange: (value: string) => void; formatOption?: (option: string) => string }) { return <label className="block"><span className="mb-1 block text-[9px] font-semibold uppercase tracking-wider text-[#657187]">{label}</span><select value={value} onChange={(event)=>onChange(event.target.value)} className="h-8 w-full rounded-md border border-white/10 bg-[#0b0f16] px-2 text-xs text-white outline-none focus:border-violet-400/50">{[...new Set(options)].map((option)=><option key={option} value={option}>{formatOption(option)}</option>)}</select></label>; }
function DateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label className="block"><span className="mb-1 block text-[9px] font-semibold uppercase tracking-wider text-[#657187]">{label}</span><input type="date" value={value} onChange={(event)=>onChange(event.target.value)} className="h-8 w-full rounded-md border border-white/10 bg-[#0b0f16] px-2 text-xs text-white outline-none focus:border-violet-400/50" /></label>; }
function LoadingState() { return <div className="grid min-h-80 place-items-center rounded-xl border border-white/10 bg-[#101620]"><div className="text-center text-sm text-[#93a1b6]"><LoaderCircle className="mx-auto mb-3 size-8 animate-spin text-violet-300" />Loading realtime signals and orders…</div></div>; }
function ErrorState({ message, retry }: { message: string; retry: () => Promise<void> }) { return <div className="flex items-center gap-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] p-4 text-sm text-rose-200"><CircleAlert className="size-5 shrink-0" /><div><div className="font-semibold">Realtime analytics unavailable</div><div className="mt-1 text-xs text-rose-200/70">{message}</div></div><button onClick={()=>void retry()} className="ml-auto rounded-md border border-rose-300/20 px-3 py-2 text-xs">Retry</button></div>; }
