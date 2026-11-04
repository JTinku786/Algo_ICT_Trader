"use client";

import {
  Activity,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Braces,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Download,
  ExternalLink,
  Filter,
  Layers3,
  LineChart,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Rows3,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  TrendingDown,
  Workflow,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import OptionLegChart from "./option-leg-chart";
import TradeExplanation from "./trade-explanation";
import { prefetchJson } from "@/lib/fetch-cache";
import { ICT_SESSION_IDS, ictSessionDisplayLabel } from "@/lib/ict-sessions";
import { PLANNED_RR_BUCKET_IDS, plannedRrBucketLabel } from "@/lib/planned-rr";
import { downloadCsv } from "@/lib/download-csv";
import {
  ARCHIVED_STRATEGIES,
  STRATEGY_MARKETS,
  STRATEGY_STATUS_OPTIONS,
  REVERSAL_K1_STRATEGIES,
  liveStrategyIds,
  paperStrategyIds,
  shortStrategyLabel,
  strategyStatusLabel,
  type StrategyStatus,
} from "@/lib/strategy-status";
import type { TradePrefill } from "./trade-navigation";
import { SMT_FILTERS, type SmtResult } from "@/lib/smt-signal";
import { PROFILE_LABELS, WEEKLY_FILTERS, type WeeklyProfileResult } from "@/lib/weekly-profile";
import { OrderChart } from "./order-chart";
import { DailyForwardChart } from "./daily-forward-chart";
import BacktestPlayground from "./backtest-playground";
import { MssLinkBar } from "./mss-link-bar";
import { SmtLinkBar } from "./smt-link-bar";
import { tradeMarket } from "@/lib/mss-deep-link";
import ReversalK1TradeChart from "./reversal-k1-trade-chart";
import { StrategyLink } from "./blog-context";
import { RejectionTradeAnalysis } from "./rejection-trade-analysis";

type FeedRow = TradePrefill & {
  base_symbol?: string | null;
  company_name?: string | null;
  exchange_timezone?: string | null;
  strategy?: string | null;
  strategy_key?: string | null;
  signal_timeframe?: string | null;
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
  risk_probability?: number | null;
  risk_bin?: number | null;
  ml_model_version?: string | null;
  ml_score_status?: {
    status?: "scored" | "unavailable" | "failed" | "not_applicable" | string;
    reason?: string;
    model_version?: string;
  } | null;
  ict_session_ids?: string[];
  strategy_json?: Record<string, unknown> | unknown[] | string | null;
  /** Set on broker=OANDA rows: the trade was filled on the OANDA account. */
  oanda_status?: string | null;
  /** SMT divergence vs the index / correlated peer at signal time. */
  smt?: SmtResult | null;
  smt_group?: string;
  /** ICT weekly profile at the signal (live) and what the week printed (hindsight label). */
  weekly_profile?: WeeklyProfileResult | null;
  wp_group?: string;
  wp_hindsight_group?: string;
};

type FeedColumnKey = "entry_datetime" | "close_ts" | "market" | "ticker" | "strategy_id" | "signal_timeframe" | "direction" | "smt" | "wp_group" | "entry_price" | "stoploss" | "tp1" | "tp2" | "tp3" | "state" | "realized_r" | "risk_probability" | "risk_bin" | "strategy_json";
type FeedColumn = { key: FeedColumnKey; label: string; sortKey: string | null };

const REALTIME_FEED_COLUMNS: FeedColumn[] = [
  { key: "entry_datetime", label: "Entry time", sortKey: "entry_datetime" },
  { key: "close_ts", label: "Exit time", sortKey: "close_ts" },
  { key: "market", label: "Market", sortKey: "market" },
  { key: "ticker", label: "Ticker", sortKey: "ticker" },
  { key: "strategy_id", label: "Strategy", sortKey: "strategy_id" },
  { key: "signal_timeframe", label: "Signal timeframe", sortKey: null },
  { key: "direction", label: "Side", sortKey: "direction" },
  { key: "state", label: "State", sortKey: "state" },
  { key: "realized_r", label: "R", sortKey: "realized_r" },
  { key: "risk_bin", label: "Risk Bin", sortKey: "risk_bin" },
  { key: "risk_probability", label: "Risk Prob", sortKey: "risk_probability" },
  { key: "entry_price", label: "Entry", sortKey: null },
  { key: "stoploss", label: "Stop", sortKey: null },
  { key: "tp1", label: "TP1", sortKey: null },
  { key: "tp2", label: "TP2", sortKey: null },
  { key: "tp3", label: "TP3", sortKey: null },
  { key: "smt", label: "SMT", sortKey: null },
  { key: "wp_group", label: "Weekly profile", sortKey: null },
  { key: "strategy_json", label: "Strategy JSON", sortKey: null },
];

// Edge / survival metrics returned by the analytics stats() helper for every
// grouped population (overall, per strategy, per session, per risk bin).
type EdgeMetricFields = {
  payoff_ratio?: number | null;
  breakeven_win_rate_pct?: number | null;
  win_rate_edge_pct?: number | null;
  kelly_fraction_pct?: number | null;
  half_kelly_fraction_pct?: number | null;
  risk_of_ruin_pct?: number | null;
  risk_of_ruin_simple_pct?: number | null;
  risk_units?: number | null;
};

type RealtimeStats = EdgeMetricFields & {
  outcomes: number;
  wins: number;
  losses: number;
  breakeven: number;
  win_rate_pct: number | null;
  buy_win_rate_pct: number | null;
  sell_win_rate_pct: number | null;
  profit_factor: number | null;
  gross_win_r: number;
  gross_loss_r: number;
  net_r: number;
  expectancy_r: number | null;
  avg_win_r: number | null;
  avg_loss_r: number | null;
  largest_win_r: number | null;
  largest_loss_r: number | null;
  avg_hold_min: number | null;
  median_hold_min: number | null;
  exposure_pct: number | null;
  avg_quantity: number | null;
  min_quantity: number | null;
  max_quantity: number | null;
  quantity_coverage_pct: number | null;
  max_consecutive_wins: number;
  max_consecutive_losses: number;
  value_at_risk_r: number | null;
  max_drawdown_r: number;
  recovery_factor: number | null;
  sharpe_daily_r: number | null;
  trade_sharpe: number | null;
  sortino: number | null;
  annualized_return_r: number | null;
  annualized_r_maxdd: number | null;
  rar_maxdd: number | null;
  ulcer_index_r: number | null;
  k_ratio: number | null;
};

type SeriesRow = { date: string; signals: number; buy: number; sell: number; net_r: number; wins: number; losses: number; win_rate_pct: number | null };
type MonthlyRow = { month: string; signals: number; wins: number; losses: number; net_r: number; win_rate_pct: number | null };
type StrategyPerformance = { strategy_id: string; strategy_name: string; orders: number; outcomes: number; win_rate_pct: number | null; avg_win_r: number | null; net_r: number; max_drawdown_r: number; profit_factor: number | null; expectancy_r: number | null } & EdgeMetricFields;
type StrategyCoverage = { strategy_id: string; strategy_name: string; signals: number; buy: number; sell: number; tickers: number; avg_risk_points: number | null; share_pct: number };
type TickerDistributionRow = { ticker: string; signals: number; orders: number; share_pct: number; win_rate_pct: number | null; win_r: number; net_r: number };
type SessionPerformanceRow = {
  session_id: string;
  label: string;
  signals: number;
  orders: number;
  outcomes: number;
  win_rate_pct: number | null;
  avg_win_r: number | null;
  net_r: number;
  max_drawdown_r: number;
  profit_factor: number | null;
  expectancy_r: number | null;
} & EdgeMetricFields;
type RiskBinPerformanceRow = {
  risk_bin: number | null;
  label: string;
  signals: number;
  orders: number;
  open: number;
  outcomes: number;
  wins: number;
  losses: number;
  breakeven: number;
  win_rate_pct: number | null;
  loss_rate_pct: number | null;
  avg_risk_probability_pct: number | null;
  avg_win_r: number | null;
  avg_loss_r: number | null;
  net_r: number;
  max_drawdown_r: number;
  profit_factor: number | null;
  expectancy_r: number | null;
} & EdgeMetricFields;
type DirectionPerformanceRow = RealtimeStats & { label: string; direction: "ALL" | "BUY" | "SELL" };
type HoldTimePerformanceRow = RealtimeStats & {
  bucket_id: string;
  label: string;
  early: boolean;
  trade_share_pct: number;
  loss_rate_pct: number | null;
  loss_concentration_pct: number | null;
};
type ValidationPayload = {
  method: string;
  oos_pct: number;
  split_trade_index: number;
  split_timestamp: string | null;
  in_sample: RealtimeStats;
  out_of_sample: RealtimeStats;
  expectancy_degradation_pct: number | null;
};
type MonteCarloPayload = {
  method: string;
  simulations: number;
  seed: number;
  ending_r_p05: number;
  ending_r_p50: number;
  ending_r_p95: number;
  max_drawdown_p50_r: number;
  max_drawdown_p95_r: number;
  probability_of_loss_pct: number;
  probability_of_20r_drawdown_pct: number;
};
type DeploymentGatePayload = {
  status: "RESEARCH_PASSED_REVIEW_REQUIRED" | "NOT_READY";
  passed_checks: number;
  total_checks: number;
  checks: Array<{ id: string; label: string; passed: boolean }>;
  note: string;
};
type WorkspaceMode = "execution" | "research" | "rejection";
type DeployabilityStatus = "PROVISIONAL" | "WATCH" | "RESEARCH";
type DeployabilityRow = StrategyPerformance & { score: number; status: DeployabilityStatus; gaps: string[] };

type AnalyticsResponse = {
  success: boolean;
  error?: string;
  generated_at?: string;
  data_as_of?: string | null;
  calculation_version?: string;
  warnings?: string[];
  filters?: { markets: string[]; tickers: string[]; strategies: string[] };
  counts?: {
    signals: number;
    orders: number;
    open: number;
    completed: number;
    unverified?: number;
    invalid_execution?: number;
    latest_by_market: Array<{ market: string; timezone: string; date: string; orders: number; last_7_days: number; last_30_days: number }>;
  };
  summary?: RealtimeStats & {
    strategies: number;
    tickers: number;
    buy_setups: number;
    sell_setups: number;
    avg_risk_points: number | null;
    avg_planned_rr: number | null;
  };
  series?: {
    daily: SeriesRow[];
    monthly: MonthlyRow[];
    equity: Array<{ date: string; daily_r: number; equity_r: number; drawdown_r: number }>;
    weekdays: WeekdayRow[];
    weekday_time?: WeekdayTimeCell[];
    rr_distribution: Array<{ label: string; count: number }>;
  };
  strategy_performance?: StrategyPerformance[];
  strategy_coverage?: StrategyCoverage[];
  ticker_distribution?: TickerDistributionRow[];
  session_performance?: SessionPerformanceRow[];
  risk_bin_performance?: RiskBinPerformanceRow[];
  direction_performance?: DirectionPerformanceRow[];
  year_performance?: Array<RealtimeStats & { year: string }>;
  hold_time_performance?: HoldTimePerformanceRow[];
  smt_performance?: Array<RealtimeStats & { group: string }>;
  weekly_profile_performance?: Array<RealtimeStats & { group: string }>;
  weekly_profile_hindsight_performance?: Array<RealtimeStats & { group: string }>;
  validation?: ValidationPayload;
  monte_carlo?: MonteCarloPayload;
  deployment_gate?: DeploymentGatePayload;
  data_quality?: {
    status: "PASS" | "REVIEW";
    closed_orders: number;
    first_close_ts: string | null;
    last_close_ts: string | null;
    missing: Record<string, number>;
    warnings: string[];
  };
  open_orders?: FeedRow[];
  outcomes_ledger?: FeedRow[];
  pagination?: { page: number; page_size: number; total: number; pages: number };
  rows?: FeedRow[];
};

type Props = { onOpenTrade: (trade: TradePrefill, destination: "tradezella" | "stonk") => void; reversalMode?: boolean; /** Account Management > OANDA: only trades executed on the OANDA account, with broker fills. */ brokerScope?: "OANDA" };

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function fmt(value: number | null | undefined, suffix = "") {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Unavailable";
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}${suffix}`;
}

function fmtDuration(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Unavailable";
  if (value < 60) return `${Math.round(value)}m`;
  if (value < 1_440) return `${(value / 60).toFixed(value < 600 ? 1 : 0)}h`;
  return `${(value / 1_440).toFixed(1)}d`;
}

function dateTime(value: string | null | undefined, timezone?: string | null) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.day}-${values.month}-${values.year} ${values.hour}:${values.minute}`;
}

function displayTicker(value: string | null | undefined) {
  if (!value) return "Unavailable";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const SCALPING_PAPER_STRATEGIES = ["Scalping_OB_OB_V4", "BPR_OB_V3"];
const OANDA_STRATEGIES = ["IGS01V2_LondonLiqGrab_SweepReversal", ...REVERSAL_K1_STRATEGIES];
function recentReversalDate(offset: number) {
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
  const date=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  const value=new Date(`${date.year}-${date.month}-${date.day}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate()+offset);
  return value.toISOString().slice(0,10);
}
const SCORE_MODELS = ["incumbent", "s03_catboost_v2_stable_tp1", "s03_catboost_v2_stable_tp2"];
const SCORE_MODEL_LABELS: Record<string, string> = {
  incumbent: "Incumbent",
  s03_catboost_v2_stable_tp1: "S03 V2 Stable · TP1",
  s03_catboost_v2_stable_tp2: "S03 V2 Stable · TP2",
};

// Realtime rows are live signals, so "Backtesting" here means strategies that
// emitted realtime signals but are not assigned to Live or Paper trading.
function strategyIdsForStatus(status: StrategyStatus, market: string, available: string[]) {
  const live = liveStrategyIds(market);
  const paper = paperStrategyIds(market);
  const scoped = (ids: string[]) => available.length === 0 ? ids : ids.filter((id) => available.includes(id));
  if (status === "LIVE") return scoped(live);
  if (status === "PAPER_TRADING") return scoped(paper);
  if (status === "ARCHIVED") return scoped([...ARCHIVED_STRATEGIES]);
  return available.filter((id) => !live.includes(id) && !paper.includes(id) && !ARCHIVED_STRATEGIES.has(id));
}

export default function RealtimeOrdersDashboard({ onOpenTrade, reversalMode = false, brokerScope }: Props) {
  const oandaMode = brokerScope === "OANDA";
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [market, setMarket] = useState("ALL");
  const [tickers, setTickers] = useState<string[]>([]);
  const [strategyStatus, setStrategyStatus] = useState<StrategyStatus>(oandaMode ? "LIVE" : "PAPER_TRADING");
  const [strategies, setStrategies] = useState<string[]>(oandaMode ? OANDA_STRATEGIES : reversalMode ? REVERSAL_K1_STRATEGIES : SCALPING_PAPER_STRATEGIES);
  const [minOptionDte, setMinOptionDte] = useState(reversalMode || oandaMode ? "0" : "7");
  const [sourceMode, setSourceMode] = useState("ALL");
  const [duplicates, setDuplicates] = useState("EXCLUDE");
  const [ictSessions, setIctSessions] = useState<string[]>(() => [...ICT_SESSION_IDS]);
  const [plannedRr, setPlannedRr] = useState<string[]>(() => [...PLANNED_RR_BUCKET_IDS]);
  const [direction, setDirection] = useState("ALL");
  const [status, setStatus] = useState("ALL");
  const [smtFilter, setSmtFilter] = useState("ALL");
  const [weeklyFilter, setWeeklyFilter] = useState("ALL");
  const [scoreModel, setScoreModel] = useState("incumbent");
  const [dateFrom, setDateFrom] = useState(()=>reversalMode ? "2026-07-01" : oandaMode ? "" : recentReversalDate(-6));
  const [dateTo, setDateTo] = useState(()=>oandaMode ? "" : recentReversalDate(0));
  const rollingRange=useRef(reversalMode);
  const rollingScalpingRange=useRef(!reversalMode && !oandaMode);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState("entry_datetime");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [periodMode, setPeriodMode] = useState<"daily" | "monthly">("daily");
  const [heatmapMode, setHeatmapMode] = useState<HeatmapMode>("day × time");
  const [chartRow, setChartRow] = useState<FeedRow | null>(null);
  const chartPanelRef = useRef<HTMLDivElement | null>(null);
  // Bring the clicked row's charts into view (rows can be clicked from ledgers further down).
  useEffect(() => {
    if (!chartRow) return;
    const id = window.setTimeout(() => chartPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    return () => window.clearTimeout(id);
  }, [chartRow]);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("execution");
  const [visibleFeedColumns, setVisibleFeedColumns] = useState<FeedColumnKey[]>(() => REALTIME_FEED_COLUMNS.map((column) => column.key));
  const [csvExporting, setCsvExporting] = useState(false);
  const [csvExportStatus, setCsvExportStatus] = useState("");

  const availableStrategies = useMemo(() => data?.filters?.strategies ?? [], [data?.filters?.strategies]);
  const statusStrategyIds = useMemo(
    () => oandaMode ? OANDA_STRATEGIES : reversalMode ? REVERSAL_K1_STRATEGIES : strategyIdsForStatus(strategyStatus, market, availableStrategies),
    [availableStrategies, market, strategyStatus, reversalMode, oandaMode],
  );
  const effectiveStrategies = strategies.length ? strategies : statusStrategyIds;
  const scalpingMode = !reversalMode && !oandaMode && effectiveStrategies.length > 0
    && effectiveStrategies.every((value) => SCALPING_PAPER_STRATEGIES.some((id) => id.toUpperCase() === value.toUpperCase()));
  // The API narrows `filters.markets` to the selected market, so keep the known
  // markets (including forex for IGS01V2) available to switch back and forth.
  const marketOptions = useMemo(
    () => oandaMode ? ["ALL","forex"] : reversalMode ? ["ALL","us","forex"] : ["ALL", ...new Set([...STRATEGY_MARKETS, ...(data?.filters?.markets ?? []).map((value) => value.toLowerCase())])],
    [data?.filters?.markets,reversalMode,oandaMode],
  );

  const buildQuery = useCallback(() => {
    const query = new URLSearchParams({
      market,
      ticker: tickers.length ? tickers.join(",") : "ALL",
      strategy: effectiveStrategies.length ? effectiveStrategies.join(",") : "NONE",
      ict_session: ictSessions.length === ICT_SESSION_IDS.length ? "ALL" : ictSessions.length ? ictSessions.join(",") : "NONE",
      planned_rr: plannedRrParam(plannedRr),
      direction,
      status,
      source_mode: sourceMode,
      duplicates,
      score_model: scoreModel,
      min_option_dte: minOptionDte,
      page: String(page),
      page_size: String(pageSize),
      sort,
      order,
    });
    if (dateFrom) query.set("date_from", dateFrom);
    if (dateTo) query.set("date_to", dateTo);
    if (oandaMode) query.set("broker", "OANDA");
    if (smtFilter !== "ALL") query.set("smt", smtFilter);
    if (weeklyFilter !== "ALL") query.set("wp", weeklyFilter);
    return query;
  }, [dateFrom, dateTo, direction, effectiveStrategies, ictSessions, plannedRr, market, order, page, pageSize, scoreModel, sort, status, sourceMode, duplicates, tickers, oandaMode, smtFilter, weeklyFilter, minOptionDte]);

  const latestRequest = useRef(0);
  const fetchQuery = useCallback(async (query: URLSearchParams, silent = false) => {
    const request = ++latestRequest.current;
    if (!silent) setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/realtime-analytics?${query}`, { cache: "no-store" });
      const payload = (await response.json()) as AnalyticsResponse;
      if (!response.ok || !payload.success) throw new Error(payload.error || `Request failed (${response.status})`);
      if (request === latestRequest.current) setData(payload);
    } catch (cause) {
      if (request === latestRequest.current) setError(cause instanceof Error ? cause.message : "Unable to load realtime analytics");
    } finally {
      if (request === latestRequest.current) setLoading(false);
    }
  }, []);

  // Run snapshots the filters for refresh and paging. Reversal loads on mount
  // and applies session edits immediately; other filter edits wait for Run.
  const appliedQuery = useRef<URLSearchParams | null>(null);
  const [hasRun, setHasRun] = useState(false);
  const [runToken, setRunToken] = useState(0);

  const load = useCallback(async (silent = false) => {
    const base = appliedQuery.current;
    if (!base) return;
    const query = new URLSearchParams(base);
    if(rollingRange.current) {
      const from="2026-07-01",to=recentReversalDate(0);
      query.set("date_from",from);query.set("date_to",to);
      if(base.get("date_from")!==from||base.get("date_to")!==to) {
        base.set("date_from",from);base.set("date_to",to);setDateFrom(from);setDateTo(to);
      }
    }
    if (rollingScalpingRange.current) {
      const from=recentReversalDate(-6), to=recentReversalDate(0);
      query.set("date_from",from); query.set("date_to",to);
      if (base.get("date_from")!==from || base.get("date_to")!==to) {
        base.set("date_from",from); base.set("date_to",to); setDateFrom(from); setDateTo(to);
      }
    }
    query.set("page", String(page));
    query.set("page_size", String(pageSize));
    query.set("sort", sort);
    query.set("order", order);
    await fetchQuery(query, silent);
  }, [fetchQuery, order, page, pageSize, sort]);

  const run = useCallback(() => {
    const query = buildQuery();
    appliedQuery.current = query;
    setHasRun(true);
    setRunToken((value) => value + 1);
    void fetchQuery(query);
  }, [buildQuery, fetchQuery]);

  const initialReversalRun = useRef(false);
  useEffect(() => {
    if ((reversalMode || oandaMode) && !initialReversalRun.current) {
      initialReversalRun.current = true;
      run();
    }
  }, [reversalMode, oandaMode, run]);

  useEffect(() => {
    if (!hasRun) return;
    const refreshTimer = window.setInterval(() => {
      if (workspaceMode !== "rejection" && document.visibilityState === "visible") void load(true);
    }, 30_000);
    return () => window.clearInterval(refreshTimer);
  }, [hasRun, load, workspaceMode]);

  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    if (hasRun) void loadRef.current();
    // Paging/sorting of an already-run result only; filters wait for Run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, sort, order]);

  const resetPage = <T,>(setter: (value: T) => void, value: T) => {
    setter(value);
    setPage(1);
  };

  const changePlannedRr = (values: string[]) => {
    resetPage(setPlannedRr, values);
    if (!reversalMode) return;
    const query = new URLSearchParams(appliedQuery.current ?? buildQuery());
    query.set("planned_rr", plannedRrParam(values));
    query.set("page", "1");
    appliedQuery.current = query;
    setHasRun(true);
    setRunToken((value) => value + 1);
    setChartRow(null);
    void fetchQuery(query);
  };

  const changeIctSessions = (values: string[]) => {
    resetPage(setIctSessions, values);
    if (!reversalMode) return;
    // Reversal is continuously refreshed. Update its applied snapshot as well
    // as the checkboxes so refresh, pagination and CSV share the selection.
    const query = new URLSearchParams(appliedQuery.current ?? buildQuery());
    query.set("ict_session", values.length === ICT_SESSION_IDS.length ? "ALL" : values.length ? values.join(",") : "NONE");
    query.set("page", "1");
    appliedQuery.current = query;
    setHasRun(true);
    setRunToken((value) => value + 1);
    setChartRow(null);
    void fetchQuery(query);
  };

  const applySort = (column: string, nextOrder: "asc" | "desc") => {
    // Session changes reuse this snapshot. Keep it aligned with the header so
    // they cannot silently restore the original Entry Time order.
    appliedQuery.current?.set("sort", column);
    appliedQuery.current?.set("order", nextOrder);
    appliedQuery.current?.set("page", "1");
    setSort(column);
    setOrder(nextOrder);
    setPage(1);
  };

  const setSortColumn = (column: string) => {
    applySort(column, sort === column && order === "desc" ? "asc" : "desc");
  };

  const setEntryOrder = (value: "asc" | "desc") => {
    applySort("entry_datetime", value);
  };

  const dailyOrMonthly = periodMode === "daily" ? data?.series?.daily ?? [] : data?.series?.monthly ?? [];
  const heatmapRows = heatmapMode === "monthly" ? data?.series?.monthly ?? [] : data?.series?.daily ?? [];
  const deployabilityRows = scoreDeployability(data?.strategy_performance ?? []);
  const filterScope = describeFilterScope({ market, tickers, strategies: effectiveStrategies, direction, status, dateFrom, dateTo });

  const changeWorkspaceMode = (value: WorkspaceMode) => {
    setWorkspaceMode(value);
    if (value === "rejection") {
      setStrategyStatus("LIVE");
      setStrategies((current) => {
        if (!current.length) return current;
        const liveForMarket = liveStrategyIds(market);
        const retained = current.filter((strategyId) => liveForMarket.includes(strategyId));
        return retained.length ? retained : liveForMarket;
      });
      setStatus("COMPLETED");
      setPage(1);
    }
  };

  const changeMarket = (value: string) => {
    setMarket(value);
    setTickers([]);
    // Loaded strategies belong to the previous market; resolve the new market's
    // assignment from the status table instead of intersecting with stale data.
    setStrategies(oandaMode ? OANDA_STRATEGIES : reversalMode ? REVERSAL_K1_STRATEGIES : strategyIdsForStatus(strategyStatus, value, []));
    setPage(1);
  };

  const changeStrategyStatus = (value: string) => {
    const nextStatus = value as StrategyStatus;
    setStrategyStatus(nextStatus);
    setStrategies(strategyIdsForStatus(nextStatus, market, availableStrategies));
    setMinOptionDte("0");
    setPage(1);
  };

  const changeScoreModel = (value: string) => {
    setScoreModel(value);
    if (value !== "incumbent") {
      setMarket("us");
      setTickers([]);
      setStrategyStatus("LIVE");
      setStrategies(["S03"]);
    }
    setPage(1);
  };

  const resetFilters = () => {
    rollingRange.current=reversalMode;
    rollingScalpingRange.current=!reversalMode && !oandaMode;
    setMarket("ALL");
    setTickers([]);
    setStrategyStatus(oandaMode ? "LIVE" : "PAPER_TRADING");
    setStrategies(oandaMode ? OANDA_STRATEGIES : reversalMode ? REVERSAL_K1_STRATEGIES : SCALPING_PAPER_STRATEGIES);
    setMinOptionDte(reversalMode || oandaMode ? "0" : "7");
    setSourceMode("ALL");
    setDuplicates("EXCLUDE");
    setIctSessions([...ICT_SESSION_IDS]);
    setPlannedRr([...PLANNED_RR_BUCKET_IDS]);
    setDirection("ALL");
    setStatus("ALL");
    setSmtFilter("ALL");
    setWeeklyFilter("ALL");
    setScoreModel("incumbent");
    setDateFrom(reversalMode ? "2026-07-01" : oandaMode ? "" : recentReversalDate(-6));
    setDateTo(oandaMode ? "" : recentReversalDate(0));
    setPage(1);
  };

  const exportTradeList = async () => {
    setCsvExporting(true);
    setCsvExportStatus("");
    const query = buildQuery();
    query.set("format", "csv");
    query.set("columns", REALTIME_FEED_COLUMNS.filter((column) => visibleFeedColumns.includes(column.key)).map((column) => column.key).join(","));
    try {
      const count = await downloadCsv(`/api/realtime-analytics?${query}`, "realtime-trades.csv");
      setCsvExportStatus(`${count || data?.pagination?.total || 0} rows exported with full strategy_json`);
    } catch (cause) {
      setCsvExportStatus(cause instanceof Error ? cause.message : "CSV export failed");
    } finally {
      setCsvExporting(false);
    }
  };

  return (
    <section className="mx-auto max-w-[1680px] space-y-4">
      <header className="rounded-xl border border-[#d9a441]/25 bg-gradient-to-r from-[#101620] via-[#151923] to-[#201a12] p-5 shadow-xl shadow-black/20">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center">
          <div>
            <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#f2c873]"><Activity className="size-4" />Realtime execution intelligence</div>
            <h1 className="text-2xl font-semibold text-white md:text-3xl">{oandaMode ? "OANDA Executed Trades" : reversalMode ? "Realtime Reversals" : "Realtime ICT Orders"}</h1>
            <p className="mt-1 text-sm text-[#aeb9ca]">{oandaMode ? "Every trade filled on the OANDA account, scored with the Realtime metrics, with its ICT chart. R is the broker\u2019s realized R." : "Live signal oversight, internal-order outcomes, ICT timing attribution, and broker-safe research views."}</p>
          </div>
          <div className="flex flex-col gap-2 xl:ml-auto xl:items-end">
            <WorkspaceModeToggle value={workspaceMode} onChange={changeWorkspaceMode} includeRejection={!reversalMode && !oandaMode} />
            <div className="flex items-center gap-2 rounded-md border border-white/10 bg-black/20 px-3 py-2 text-xs text-violet-100/70">
              <Clock3 className="size-4 text-violet-300" />
              {market === "ALL" && !reversalMode
                ? `Data as of ${dateTime(data?.data_as_of, "America/New_York")} / ${dateTime(data?.data_as_of, "Asia/Kolkata")}`
                : `Data as of ${dateTime(data?.data_as_of, market.toLowerCase() === "india" ? "Asia/Kolkata" : "America/New_York")}`}
            </div>
          </div>
        </div>
      </header>

      {scalpingMode ? <div className="rounded-xl border border-sky-300/20 p-3 text-sm"><strong>OB_OB_V4 + BPR_OB_V3 · paper tracking</strong><p className="mt-1 text-xs text-slate-400">Completed 5m setups · 1m entry checks · fixed ATM contract with at least 7 days to expiry at entry. Historical rows show reference outcomes; each option chart reports its timing replay and fresh quote-based paper executions separately.</p></div> : oandaMode ? null : reversalMode ? <div className="rounded-xl border border-amber-300/20 p-3 text-sm"><strong>k1_reclaim3 · OTE 62% limit · 2R · 5m close SL</strong><p className="mt-1 text-xs text-slate-400">US + Forex · Daily, 1 hour and 30 minutes · default history starts July 1, 2026, including initial catch-up entries. Paper tracking. Stop exits on a completed 5m close beyond SL at the actual close price. Target wick touches take profit first, including when the same candle closes beyond SL. Signals refresh every 30 seconds.</p></div> : <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-300/20 p-3 text-sm"><span>MSS reversals · Daily/5m close CHOCH · paper tracking. Each array/risk plan is a separate setup; overlapping entries are not a portfolio allocation.</span><button className="text-amber-200 underline" onClick={()=>{rollingScalpingRange.current=false;setMinOptionDte("0");setMarket("ALL");setStrategyStatus("PAPER_TRADING");setStrategies(["MSS-REVERSAL-D1-M5-CLOSE"]);setTickers([]);setDirection("ALL");setStatus("ALL");setSourceMode("BACKFILL");setDateFrom("2026-09-06");setDateTo("2026-10-05");setPage(1);}}>View last-month MSS reversals</button></div>}
      <div className="rounded-xl border border-white/10 bg-[#101620] p-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        <Select label="Market" value={market} options={marketOptions} onChange={changeMarket} />
        <MultiSelect label="Ticker" values={tickers} options={data?.filters?.tickers ?? []} onChange={(values) => resetPage(setTickers, values)} allLabel="ALL - all tickers" formatOption={displayTicker} />
        {oandaMode ? null : <Select label="Strategy Status" value={strategyStatus} options={reversalMode ? ["PAPER_TRADING"] : STRATEGY_STATUS_OPTIONS.map((option) => option.value)} formatOption={(value) => strategyStatusLabel(value as StrategyStatus)} onChange={changeStrategyStatus} />}
        <MultiSelect label={reversalMode ? "Entry timeframe" : "Strategy"} values={strategies} options={statusStrategyIds} onChange={(values) => resetPage(setStrategies, values)} allLabel={reversalMode ? "Daily / 1H / 30m" : oandaMode ? "ALL - OANDA strategies" : `ALL - ${strategyStatusLabel(strategyStatus)} strategies`} formatOption={(value)=>reversalMode ? value.endsWith("1d") ? "Daily" : value.endsWith("1h") ? "1 Hour" : "30 Minutes" : shortStrategyLabel(value)} closeOnSelect />
        <Select label="Direction" value={direction} options={["ALL", "BUY", "SELL"]} onChange={(value) => resetPage(setDirection, value)} />
        <Select label="Trade state" value={status} options={["ALL", "OPEN", "COMPLETED", "UNVERIFIED", "INVALID_EXECUTION"]} onChange={(value) => resetPage(setStatus, value)} />
        {!reversalMode && !oandaMode ? <Select label="Minimum option DTE at entry" value={minOptionDte} options={["0", "7", "14", "30"]} formatOption={(value) => value === "0" ? "All trades" : `At least ${value} days`} onChange={(value) => resetPage(setMinOptionDte, value)} /> : null}
        <Select label="SMT divergence" value={smtFilter} options={[...SMT_FILTERS]} formatOption={(value) => SMT_FILTER_LABELS[value] ?? value} onChange={(value) => resetPage(setSmtFilter, value)} />
        <Select label="Weekly profile" value={weeklyFilter} options={[...WEEKLY_FILTERS]} formatOption={(value) => WEEKLY_FILTER_LABELS[value] ?? value} onChange={(value) => resetPage(setWeeklyFilter, value)} />
        <Select label="Signal source" value={sourceMode} options={["ALL", "REALTIME", "BACKFILL"]} formatOption={(value) => value === "REALTIME" ? "Realtime signals" : value === "BACKFILL" ? "Historical backfill" : "All sources"} onChange={(value) => resetPage(setSourceMode, value)} />
        <Select label="Duplicate setups" value={duplicates} options={["EXCLUDE", "INCLUDE", "ONLY"]} formatOption={(value) => value === "EXCLUDE" ? "Exclude (1 trade per setup)" : value === "INCLUDE" ? "Include duplicates" : "Only duplicates"} onChange={(value) => resetPage(setDuplicates, value)} />
        {!reversalMode && !oandaMode ? <Select label="Score model" value={scoreModel} options={SCORE_MODELS} formatOption={(value) => SCORE_MODEL_LABELS[value] ?? value} onChange={changeScoreModel} /> : null}
        <MultiSelect label="ICT Entry Sessions" values={ictSessions} options={[...ICT_SESSION_IDS]} onChange={changeIctSessions} allLabel="ALL - all ICT sessions" formatOption={ictSessionDisplayLabel} emptyMeansAll={false} />
        <MultiSelect label="Planned R:R (TP1)" values={plannedRr} options={PLANNED_RR_BUCKET_IDS} onChange={changePlannedRr} allLabel="ALL - any planned R:R" formatOption={plannedRrBucketLabel} emptyMeansAll={false} />
        <DateField label="From" value={dateFrom} onChange={(value) => {rollingRange.current=false;rollingScalpingRange.current=false;resetPage(setDateFrom,value);}} />
        <DateField label="To" value={dateTo} onChange={(value) => {rollingRange.current=false;rollingScalpingRange.current=false;resetPage(setDateTo,value);}} />
        <button onClick={resetFilters} className="flex h-10 items-center justify-center gap-2 self-end rounded-md border border-white/10 bg-white/[0.03] text-xs font-semibold text-[#aeb9ca] hover:bg-white/[0.07]"><RotateCcw className="size-4" />Reset</button>
        <button onClick={run} disabled={loading} title={hasRun ? "Runs with the current filters. Results auto-refresh every 30s after a Run." : "Nothing loads until you click Run"} className="flex h-10 items-center justify-center gap-2 self-end rounded-md bg-[#d9a441] text-xs font-semibold text-[#151109] hover:bg-[#edbf5e] disabled:opacity-60 xl:col-span-3"><RefreshCw className={cx("size-4", loading && "animate-spin")} />{hasRun ? "Run · auto 30s" : "Run"}</button>
        </div>
        <div className="mt-2 font-mono text-[10px] text-[#7f8ca3]">{tickers.length ? `${tickers.length} tickers` : "All tickers"} · {oandaMode ? "OANDA executed" : strategyStatusLabel(strategyStatus)} · {effectiveStrategies.length ? `${effectiveStrategies.length} strategies` : "No strategies assigned"} · {ictSessions.length}/{ICT_SESSION_IDS.length} ICT sessions · {plannedRr.length}/{PLANNED_RR_BUCKET_IDS.length} R:R buckets · {SCORE_MODEL_LABELS[scoreModel]}</div>
      </div>

      {error ? <ErrorState message={error} retry={load} /> : null}
      {loading && !data ? <LoadingState /> : null}
      {!hasRun && !loading && !data ? <div className="grid h-48 place-items-center rounded-lg border border-white/10 bg-[#101620] px-6 text-center text-sm text-[#93a1b6]">Set filters and click Run to load orders.</div> : null}

      {data ? <>
        {workspaceMode === "rejection" ? (
          <RejectionTradeAnalysis
            market={market}
            tickers={tickers}
            strategies={effectiveStrategies}
            direction={direction}
            dateFrom={dateFrom}
            dateTo={dateTo}
            runToken={runToken}
          />
        ) : <>
        <DecisionSnapshot data={data} scope={filterScope} />

        {/* Signal & order feed + the clicked row's charts sit right under the filtered decisions. */}
        <FeedTable data={data} loading={loading} sort={sort} order={order} setSort={setSortColumn} setEntryOrder={setEntryOrder} pageSize={pageSize} setPageSize={(value) => { setPageSize(value); setPage(1); }} page={page} setPage={setPage} onOpenTrade={onOpenTrade} onOpenChart={setChartRow} activeChartKey={chartRow ? `${chartRow.signal_hash}-${chartRow.order_id ?? "signal"}` : null} visibleColumns={visibleFeedColumns} setVisibleColumns={setVisibleFeedColumns} onExport={() => void exportTradeList()} exporting={csvExporting} exportStatus={csvExportStatus} />

        {chartRow ? <div ref={chartPanelRef} className="scroll-mt-4"><OrderChartPanel row={chartRow} onClose={() => setChartRow(null)} /></div> : null}

        <TickerDistribution rows={data.ticker_distribution ?? []} selected={tickers} onPick={(ticker) => { setTickers([ticker]); setPage(1); }} />

        {workspaceMode === "execution" ? <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {(data.counts?.latest_by_market ?? []).map((item) => <LatestDateCard key={item.market} item={item} />)}
            <CountCard label="All filtered signals" value={data.counts?.signals ?? 0} note={`${data.counts?.orders ?? 0} linked orders`} icon={Workflow} />
            <CountCard label="Open / Completed" value={data.counts?.open ?? 0} note={`${data.counts?.completed ?? 0} completed · ${data.counts?.unverified ?? 0} unverified · ${data.counts?.invalid_execution ?? 0} invalid execution`} icon={Layers3} />
          </div>

          <RiskGovernance data={data} />

          <RealtimeAnalyticsStack
            data={data}
            periodMode={periodMode}
            setPeriodMode={setPeriodMode}
            heatmapMode={heatmapMode}
            setHeatmapMode={setHeatmapMode}
            deployabilityRows={deployabilityRows}
            dailyOrMonthly={dailyOrMonthly}
            heatmapRows={heatmapRows}
            onOpenTrade={onOpenTrade}
            onOpenChart={setChartRow}
            chartRow={chartRow}
            setChartRow={setChartRow}
            showOutcomeLedger={false}
          />

          <CompactLedger title="Open Trades" rows={data.open_orders ?? []} onOpenTrade={onOpenTrade} onOpenChart={setChartRow} />
        </> : <RealtimeAnalyticsStack
          data={data}
          periodMode={periodMode}
          setPeriodMode={setPeriodMode}
          heatmapMode={heatmapMode}
          setHeatmapMode={setHeatmapMode}
          deployabilityRows={deployabilityRows}
          dailyOrMonthly={dailyOrMonthly}
          heatmapRows={heatmapRows}
          onOpenTrade={onOpenTrade}
          onOpenChart={setChartRow}
          chartRow={chartRow}
          setChartRow={setChartRow}
          showOutcomeLedger
        />}

        </>}

        {workspaceMode !== "rejection" ? <div className="rounded-xl border border-amber-300/15 bg-amber-300/[0.04] p-4 text-xs leading-5 text-amber-100/70">
          {(data.warnings ?? []).map((warning) => <div key={warning}>• {warning}</div>)}
        </div> : null}
      </> : null}
    </section>
  );
}

function RealtimeAnalyticsStack({
  data,
  periodMode,
  setPeriodMode,
  heatmapMode,
  setHeatmapMode,
  deployabilityRows,
  dailyOrMonthly,
  heatmapRows,
  onOpenTrade,
  onOpenChart,
  chartRow,
  setChartRow,
  showOutcomeLedger,
}: {
  data: AnalyticsResponse;
  periodMode: "daily" | "monthly";
  setPeriodMode: (value: "daily" | "monthly") => void;
  heatmapMode: HeatmapMode;
  setHeatmapMode: (value: HeatmapMode) => void;
  deployabilityRows: DeployabilityRow[];
  dailyOrMonthly: Array<SeriesRow | MonthlyRow>;
  heatmapRows: Array<SeriesRow | MonthlyRow>;
  onOpenTrade: Props["onOpenTrade"];
  onOpenChart: (row: FeedRow) => void;
  chartRow: FeedRow | null;
  setChartRow: React.Dispatch<React.SetStateAction<FeedRow | null>>;
  showOutcomeLedger: boolean;
}) {
  return <>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-6">
      <Metric label="Signals" value={fmt(data.counts?.signals)} icon={Activity} tone="violet" />
      <Metric label="Strategies" value={fmt(data.summary?.strategies)} icon={Layers3} tone="blue" />
      <Metric label="Tickers" value={fmt(data.summary?.tickers)} icon={Rows3} tone="blue" />
      <Metric label="BUY setups" value={fmt(data.summary?.buy_setups)} icon={ArrowUp} tone="green" />
      <Metric label="SELL setups" value={fmt(data.summary?.sell_setups)} icon={ArrowDown} tone="red" />
      <Metric label="Avg risk points" value={fmt(data.summary?.avg_risk_points)} icon={Target} tone="gold" />
      <Metric label="Planned R:R" value={fmt(data.summary?.avg_planned_rr)} icon={Target} tone="gold" />
      <Metric label="Max drawdown" value={fmt(data.summary?.max_drawdown_r, "R")} icon={TrendingDown} tone="red" />
      <Metric label="Sharpe" value={fmt(data.summary?.sharpe_daily_r)} icon={Activity} tone="blue" note="Annualized daily realized R" />
      <Metric label="BUY win rate" value={fmt(data.summary?.buy_win_rate_pct, "%")} icon={ArrowUp} tone="green" />
      <Metric label="SELL win rate" value={fmt(data.summary?.sell_win_rate_pct, "%")} icon={ArrowDown} tone="red" />
      <Metric label="Completed outcomes" value={fmt(data.summary?.outcomes)} icon={Rows3} tone="violet" />
      <Metric label="Reward:Risk" value={fmt(data.summary?.payoff_ratio)} icon={Target} tone="gold" note="Avg win / avg loss" />
      <Metric label="Break-even win rate" value={fmt(data.summary?.breakeven_win_rate_pct, "%")} icon={Target} tone="blue" note="1 / (1 + R:R)" />
      <Metric label="Win rate edge" value={fmt(data.summary?.win_rate_edge_pct, "%")} icon={Activity} tone={(data.summary?.win_rate_edge_pct ?? 0) > 0 ? "green" : "red"} note="Actual minus break-even" />
      <Metric label="Kelly fraction" value={fmt(data.summary?.kelly_fraction_pct, "%")} icon={Target} tone={(data.summary?.kelly_fraction_pct ?? 0) > 0 ? "green" : "red"} note={`Half Kelly ${fmt(data.summary?.half_kelly_fraction_pct, "%")}`} />
      <Metric label="Risk of ruin" value={fmt(data.summary?.risk_of_ruin_pct, "%")} icon={TrendingDown} tone={(data.summary?.risk_of_ruin_pct ?? 0) < 10 ? "green" : "red"} note={`At ${fmt(data.summary?.risk_units)} risk units (1% per trade)`} />
    </div>

    <PerformanceMatrix summary={data.summary} />

    <RealtimeValidationLab data={data} />

    <DeployabilityScorecard rows={deployabilityRows} />

    <div className="grid gap-4 xl:grid-cols-2">
      <ChartCard title="Equity & Drawdown" subtitle="Chronological cumulative R with underwater periods · internal orders"><EquityDrawdownSeries rows={data.series?.equity ?? []} /></ChartCard>
      <ChartCard title="Daily P&L" subtitle="Realized R · daily or monthly" action={<Toggle value={periodMode} onChange={setPeriodMode} options={["daily", "monthly"]} />}><BarSeries rows={dailyOrMonthly.map((row) => ({ label: "date" in row ? row.date : row.month, value: row.net_r }))} /></ChartCard>
      <ChartCard title="Day-of-Week P&L" subtitle="Closed trades · net R, win rate, W/L by entry weekday (matches heatmap Day total row)"><DayOfWeekPanel rows={data.series?.weekdays ?? []} /></ChartCard>
      <ChartCard title="Win RR Distribution" subtitle="Closed internal outcomes"><BarSeries rows={(data.series?.rr_distribution ?? []).map((row) => ({ label: row.label, value: row.count }))} neutral /></ChartCard>
      <ChartCard title="Signal Volume by Day" subtitle="Only dates where signals were generated"><SignalVolume rows={data.series?.daily ?? []} /></ChartCard>
      <ChartCard title="Win-Rate Heatmap" subtitle={heatmapMode === "day × time" ? "Closed outcomes only · entry weekday × 30-min slot (ET; IST for NSE)" : "Closed outcomes only"} action={<Toggle value={heatmapMode} onChange={setHeatmapMode} options={HEATMAP_MODES} />}>{heatmapMode === "day × time" ? <WeekdayTimeHeatmap cells={data.series?.weekday_time ?? []} totals={data.series?.weekdays ?? []} /> : <Heatmap rows={heatmapRows.map((row) => ({ label: "date" in row ? row.date : row.month, value: row.win_rate_pct, n: row.wins + row.losses }))} />}</ChartCard>
      <div className="xl:col-span-2"><ChartCard title="Monthly Net R Seasonality" subtitle="Backtest-style calendar view · green profitable, red losing"><MonthlyRHeatmap rows={data.series?.monthly ?? []} /></ChartCard></div>
    </div>

    <DirectionPerformanceTable rows={data.direction_performance ?? []} />
    <SmtPerformanceTable rows={data.smt_performance ?? []} />
    <SmtPerformanceTable rows={data.weekly_profile_performance ?? []} title="ICT Weekly Profile at Signal" subtitle="Completed outcomes grouped by the weekly profile known at the signal (prior-week dealing range · Classic Tuesday, Wednesday, Consolidation Thursday, Midweek, Seek & Destroy)" groupLabel="Weekly profile at signal" />
    <SmtPerformanceTable rows={data.weekly_profile_hindsight_performance ?? []} title="Weekly Profile the Week Printed (hindsight)" subtitle="Label only - uses the finished week's high/low, so it is never a filter. Shows which profiles your trades did well in." groupLabel="Week printed" />
    <HoldTimePerformanceTable rows={data.hold_time_performance ?? []} />

    <div className="grid gap-4 xl:grid-cols-2">
      <StrategyPerformanceTable rows={data.strategy_performance ?? []} />
      <StrategyCoverageTable rows={data.strategy_coverage ?? []} />
    </div>

    <SessionPerformanceTable rows={data.session_performance ?? []} />
    <RiskBinPerformanceTable rows={data.risk_bin_performance ?? []} />

    {showOutcomeLedger ? <CompactLedger title="Outcomes Ledger" rows={data.outcomes_ledger ?? []} onOpenTrade={onOpenTrade} onOpenChart={onOpenChart} /> : null}
    {/* A clicked ledger row's charts render in the panel under the feed (top of the page). */}
  </>;
}

function WorkspaceModeToggle({ value, onChange, includeRejection=true }: { value: WorkspaceMode; onChange: (value: WorkspaceMode) => void; includeRejection?: boolean }) {
  return (
    <div className="grid w-full grid-cols-3 gap-1 rounded-lg border border-white/10 bg-black/25 p-1 sm:inline-grid sm:w-auto" aria-label="Realtime workspace mode">
      {(["execution", "research", "rejection"] as const).filter(mode=>includeRejection||mode!=="rejection").map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
          className={cx(
            "rounded-md px-1 py-1.5 text-[9px] font-bold uppercase tracking-[0] transition sm:px-3 sm:text-[10px] sm:tracking-[0.12em]",
            value === mode ? "bg-violet-400/20 text-violet-100 shadow-sm" : "text-violet-100/45 hover:text-violet-100/80",
          )}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

function describeFilterScope(filters: { market: string; tickers: string[]; strategies: string[]; direction: string; status: string; dateFrom: string; dateTo: string }) {
  const parts = [
    filters.market !== "ALL" ? filters.market : null,
    filters.tickers.length === 1 ? displayTicker(filters.tickers[0]) : filters.tickers.length > 1 ? `${filters.tickers.length} tickers` : null,
    filters.strategies.length ? filters.strategies.join(", ") : null,
    filters.direction !== "ALL" ? filters.direction : null,
    filters.status !== "ALL" ? filters.status : null,
    filters.dateFrom || filters.dateTo ? `${filters.dateFrom || "start"} to ${filters.dateTo || "latest"}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "All markets · all strategies · full available history";
}

function DecisionSnapshot({ data, scope }: { data: AnalyticsResponse; scope: string }) {
  const summary = data.summary;
  const items = [
    { label: "Signals", value: fmt(data.counts?.signals), tone: "text-violet-200" },
    { label: "Closed sample", value: `n=${summary?.outcomes ?? 0}`, tone: "text-white" },
    { label: "Win rate", value: fmt(summary?.win_rate_pct, "%"), tone: "text-emerald-300" },
    { label: "Profit factor", value: fmt(summary?.profit_factor), tone: "text-cyan-300" },
    { label: "Net result", value: fmt(summary?.net_r, "R"), tone: (summary?.net_r ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300" },
    { label: "Expectancy", value: fmt(summary?.expectancy_r, "R"), tone: (summary?.expectancy_r ?? 0) >= 0 ? "text-violet-200" : "text-rose-300" },
    { label: "Max drawdown", value: fmt(summary?.max_drawdown_r, "R"), tone: "text-rose-300" },
    { label: "Trade Sharpe", value: fmt(summary?.trade_sharpe), tone: "text-white" },
    { label: "Break-even WR", value: fmt(summary?.breakeven_win_rate_pct, "%"), tone: "text-cyan-300" },
    { label: "Win rate edge", value: fmt(summary?.win_rate_edge_pct, "%"), tone: (summary?.win_rate_edge_pct ?? 0) > 0 ? "text-emerald-300" : "text-rose-300" },
    { label: "Kelly", value: fmt(summary?.kelly_fraction_pct, "%"), tone: (summary?.kelly_fraction_pct ?? 0) > 0 ? "text-emerald-300" : "text-rose-300" },
    { label: "Risk of ruin", value: fmt(summary?.risk_of_ruin_pct, "%"), tone: (summary?.risk_of_ruin_pct ?? 0) < 10 ? "text-white" : "text-rose-300" },
  ];

  return (
    <section className="overflow-hidden rounded-xl border border-violet-400/20 bg-[#101620]">
      <div className="flex flex-col gap-1 border-b border-white/10 px-4 py-3 md:flex-row md:items-center">
        <div>
          <h2 className="text-sm font-semibold text-white">Filtered decision snapshot</h2>
          <p className="mt-0.5 text-[10px] text-[#7f8ca3]">Every value below uses the same active filter population.</p>
        </div>
        <div className="font-mono text-[10px] text-violet-200/70 md:ml-auto">{scope}</div>
      </div>
      <div className="grid grid-cols-2 divide-x divide-y divide-white/5 sm:grid-cols-3 xl:grid-cols-6 xl:divide-y-0">
        {items.map((item) => (
          <div key={item.label} className="px-4 py-3">
            <div className="text-[9px] font-semibold uppercase tracking-[0.13em] text-[#657187]">{item.label}</div>
            <div className={cx("mt-1.5 font-mono text-lg font-bold", item.tone)}>{item.value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function scoreDeployability(rows: StrategyPerformance[]): DeployabilityRow[] {
  return rows.map((row) => {
    const pf = row.profit_factor ?? 0;
    const expectancy = row.expectancy_r ?? 0;
    const drawdown = Math.abs(row.max_drawdown_r ?? 0);
    const sampleScore = Math.min(row.outcomes / 30, 1) * 25;
    const pfScore = Math.min(pf / 2, 1) * 25;
    const expectancyScore = Math.min(Math.max(expectancy, 0) / 0.5, 1) * 25;
    const drawdownScore = Math.max(0, 1 - drawdown / 15) * 25;
    const score = Math.round(sampleScore + pfScore + expectancyScore + drawdownScore);
    const gaps = [
      row.outcomes < 20 ? `sample ${row.outcomes}/20` : null,
      row.profit_factor === null ? "PF unavailable" : pf < 1.5 ? `PF ${fmt(pf)} < 1.5` : null,
      row.expectancy_r === null ? "expectancy unavailable" : expectancy <= 0 ? `expectancy ${fmt(expectancy, "R")}` : null,
      row.max_drawdown_r < -12 ? `DD ${fmt(row.max_drawdown_r, "R")}` : null,
    ].filter((value): value is string => Boolean(value));
    const status: DeployabilityStatus = row.outcomes >= 20 && pf >= 1.5 && expectancy > 0 && row.max_drawdown_r >= -12
      ? "PROVISIONAL"
      : row.outcomes >= 10 && pf >= 1 && expectancy >= 0 && row.max_drawdown_r >= -18
        ? "WATCH"
        : "RESEARCH";
    return { ...row, score, status, gaps };
  }).sort((a, b) => b.score - a.score);
}

function DeployabilityScorecard({ rows }: { rows: DeployabilityRow[] }) {
  return (
    <DataCard title="Strategy Deployability Scorecard" subtitle="Read-only triage from filtered internal orders · never an automated deployment authorization">
      <table className="w-full min-w-[1180px] text-left text-xs">
        <thead>
          <tr>{["Status", "Score", "Strategy", "Closed n", "PF", "Expectancy", "Max DD", "R:R", "BE WR", "Kelly", "RoR", "Evidence gaps"].map((label) => <th key={label} className="px-3 py-2 text-[#7f8ca3]">{label}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {rows.map((row) => <tr key={row.strategy_id}>
            <td className="px-3 py-2"><DeployabilityBadge status={row.status} /></td>
            <td className="px-3 py-2"><div className="flex items-center gap-2"><span className="w-7 font-mono font-bold text-white">{row.score}</span><div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full bg-violet-400" style={{ width: `${row.score}%` }} /></div></div></td>
            <td className="px-3 py-2"><StrategyLink code={row.strategy_id} label={row.strategy_id} className="font-mono font-bold text-violet-300" /><div className="max-w-48 truncate text-[9px] text-[#657187]">{row.strategy_name}</div></td>
            <td className="px-3 py-2 font-mono">{row.outcomes}</td>
            <td className="px-3 py-2 font-mono">{fmt(row.profit_factor)}</td>
            <td className={cx("px-3 py-2 font-mono", (row.expectancy_r ?? 0) > 0 ? "text-emerald-300" : "text-rose-300")}>{fmt(row.expectancy_r, "R")}</td>
            <td className="px-3 py-2 font-mono text-rose-300">{fmt(row.max_drawdown_r, "R")}</td>
            <td className="px-3 py-2 font-mono">{fmt(row.payoff_ratio)}</td>
            <td className="px-3 py-2 font-mono">{fmt(row.breakeven_win_rate_pct, "%")}</td>
            <td className={cx("px-3 py-2 font-mono", (row.kelly_fraction_pct ?? 0) > 0 ? "text-emerald-300" : "text-rose-300")}>{fmt(row.kelly_fraction_pct, "%")}</td>
            <td className={cx("px-3 py-2 font-mono", (row.risk_of_ruin_pct ?? 0) < 10 ? "text-[#d6deec]" : "text-rose-300")}>{fmt(row.risk_of_ruin_pct, "%")}</td>
            <td className="max-w-72 px-3 py-2 text-[10px] text-[#93a1b6]">{row.gaps.length ? row.gaps.join(" · ") : "Threshold evidence present"}</td>
          </tr>)}
        </tbody>
      </table>
    </DataCard>
  );
}

function DeployabilityBadge({ status }: { status: DeployabilityStatus }) {
  const tone = status === "PROVISIONAL"
    ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
    : status === "WATCH"
      ? "border-amber-300/25 bg-amber-300/10 text-amber-200"
      : "border-rose-400/25 bg-rose-400/10 text-rose-300";
  return <span className={cx("inline-flex rounded border px-2 py-1 font-mono text-[9px] font-bold", tone)}>{status}</span>;
}

function RiskGovernance({ data }: { data: AnalyticsResponse }) {
  const maxOpenRiskR = 5;
  const maxStrategyOpenRiskR = 3;
  const drawdownReviewR = -12;
  const minProfitFactor = 1;
  const minSample = 20;
  const openOrders = data.open_orders ?? [];
  const definedOpenRisk = openOrders.filter((row) => typeof row.risk_points === "number" && row.risk_points > 0).length;
  const openRiskByStrategy = [...openOrders.reduce((groups, row) => {
    if (typeof row.risk_points !== "number" || row.risk_points <= 0) return groups;
    const strategyId = row.strategy_id || "UNKNOWN";
    groups.set(strategyId, (groups.get(strategyId) ?? 0) + 1);
    return groups;
  }, new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);
  const strategyRiskBreach = openRiskByStrategy.some(([, risk]) => risk > maxStrategyOpenRiskR);
  const outcomes = data.summary?.outcomes ?? 0;
  const drawdown = data.summary?.max_drawdown_r ?? 0;
  const profitFactor = data.summary?.profit_factor;
  const enoughEvidence = outcomes >= minSample;
  const reviewRequired = definedOpenRisk > maxOpenRiskR
    || strategyRiskBreach
    || drawdown < drawdownReviewR
    || (enoughEvidence && profitFactor !== null && profitFactor !== undefined && profitFactor < minProfitFactor);
  const guardrail = !enoughEvidence ? "SAMPLE REVIEW" : reviewRequired ? "RISK REVIEW" : "WITHIN REVIEW LIMITS";

  return (
    <section className="rounded-xl border border-amber-300/20 bg-gradient-to-r from-amber-300/[0.04] to-transparent p-4">
      <div className="mb-3 flex flex-col gap-1 md:flex-row md:items-center">
        <div className="flex items-center gap-2">
          {reviewRequired || !enoughEvidence ? <ShieldAlert className="size-4 text-amber-300" /> : <ShieldCheck className="size-4 text-emerald-300" />}
          <h2 className="text-sm font-semibold text-white">Read-only risk governance</h2>
        </div>
        <div className="text-[10px] text-[#7f8ca3] md:ml-auto">Provisional review policy · no execution controls are changed</div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <PolicyCard label="Open planned risk" value={`${definedOpenRisk}R / ${maxOpenRiskR}R`} note={`${openOrders.length - definedOpenRisk} open orders lack a complete entry/stop risk plan`} alert={definedOpenRisk > maxOpenRiskR} />
        <PolicyCard label="Observed max DD" value={`${fmt(drawdown, "R")} / ${drawdownReviewR}R`} note="Filtered historical maximum, not current live drawdown" alert={drawdown < drawdownReviewR} />
        <PolicyCard label="Profit-factor floor" value={`${fmt(profitFactor)} / ${minProfitFactor.toFixed(2)}`} note={enoughEvidence ? `Evaluated on n=${outcomes}` : `Needs n=${minSample}; current n=${outcomes}`} alert={!enoughEvidence || (profitFactor !== null && profitFactor !== undefined && profitFactor < minProfitFactor)} />
        <PolicyCard label="Guardrail status" value={guardrail} note="Review signal only; broker fills and currency exposure remain required" alert={!enoughEvidence || reviewRequired} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
        <span className="mr-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#657187]">Open risk by strategy</span>
        {openRiskByStrategy.length ? openRiskByStrategy.map(([strategyId, risk]) => (
          <span key={strategyId} className={cx("rounded border px-2 py-1 font-mono text-[9px]", risk > maxStrategyOpenRiskR ? "border-amber-300/25 bg-amber-300/10 text-amber-200" : "border-white/10 bg-black/15 text-[#b9c4d6]")}>
            {strategyId} {risk}R
          </span>
        )) : <span className="text-[10px] text-[#7f8ca3]">No open orders with a complete risk plan.</span>}
        <span className="ml-auto text-[9px] text-[#657187]">Review threshold: {maxStrategyOpenRiskR}R per strategy</span>
      </div>
    </section>
  );
}

function PolicyCard({ label, value, note, alert }: { label: string; value: string; note: string; alert: boolean }) {
  return <div className={cx("rounded-lg border p-3", alert ? "border-amber-300/25 bg-amber-300/[0.06]" : "border-white/10 bg-black/15")}><div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-[#657187]">{label}</div><div className={cx("mt-2 font-mono text-base font-bold", alert ? "text-amber-200" : "text-emerald-300")}>{value}</div><div className="mt-1 text-[9px] leading-4 text-[#7f8ca3]">{note}</div></div>;
}

function scoreUnavailableLabel(row: FeedRow) {
  const reason = row.ml_score_status?.reason ?? "";
  if (reason === "approved_bundle_not_installed") return "No approved model";
  if (row.ml_score_status?.status === "failed") return "Scoring failed";
  if (row.ml_score_status?.status === "unavailable") return "Unavailable";
  return "Not scored";
}

function prettyStrategyJson(value: FeedRow["strategy_json"]) {
  if (value === null || value === undefined || value === "") return "No strategy_json is stored for this signal.";
  if (typeof value !== "string") return JSON.stringify(value, null, 2);
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function FeedTable({ data, loading, sort, order, setSort, setEntryOrder, pageSize, setPageSize, page, setPage, onOpenTrade, onOpenChart, activeChartKey, visibleColumns, setVisibleColumns, onExport, exporting, exportStatus }: { data: AnalyticsResponse; loading: boolean; sort: string; order: "asc" | "desc"; setSort: (column: string) => void; setEntryOrder: (order: "asc" | "desc") => void; pageSize: number; setPageSize: (value: number) => void; page: number; setPage: (value: number) => void; onOpenTrade: Props["onOpenTrade"]; onOpenChart: (row: FeedRow) => void; activeChartKey: string | null; visibleColumns: FeedColumnKey[]; setVisibleColumns: (columns: FeedColumnKey[]) => void; onExport: () => void; exporting: boolean; exportStatus: string }) {
  const columns = REALTIME_FEED_COLUMNS.filter((column) => visibleColumns.includes(column.key));
  const [strategyJsonRow, setStrategyJsonRow] = useState<FeedRow | null>(null);
  return <><div className="overflow-hidden rounded-xl border border-violet-400/20 bg-[#0d1020]">
    <div className="flex flex-wrap items-center gap-3 border-b border-white/10 px-4 py-3"><Filter className="size-4 text-violet-300" /><div><h2 className="font-semibold">Realtime ICT Signal & Order Feed</h2><p className="text-xs text-[#7f8ca3]">Click any row to plot its ICT execution chart. Linked execution state appears when an order exists.</p></div><label className="ml-auto flex items-center gap-2 text-xs text-[#7f8ca3]">Entry time order<select aria-label="Entry time order" value={sort === "entry_datetime" ? order : "custom"} onChange={(event) => setEntryOrder(event.target.value as "asc" | "desc")} className="rounded border border-white/10 bg-[#101620] px-2 py-1 text-white">{sort !== "entry_datetime" ? <option value="custom" disabled>Other column</option> : null}<option value="desc">Newest first</option><option value="asc">Oldest first</option></select></label><label className="flex items-center gap-2 text-xs text-[#7f8ca3]">Rows<select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))} className="rounded border border-white/10 bg-[#101620] px-2 py-1 text-white"><option>10</option><option>25</option><option>50</option><option>100</option></select></label></div>
    <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2">
      <SlidersHorizontal className="size-4 text-[#d9a441]" />
      <span className="mr-1 text-[10px] font-semibold uppercase text-[#7f8ca3]">Columns</span>
      {REALTIME_FEED_COLUMNS.map((column) => {
        const active = visibleColumns.includes(column.key);
        return <button key={column.key} type="button" aria-label={`Show column ${column.label}`} aria-pressed={active} title={`Show or hide ${column.label}; use the table header to sort`} onClick={() => { const next = active ? visibleColumns.filter((key) => key !== column.key) : [...visibleColumns, column.key]; setVisibleColumns(next.length ? next : [column.key]); }} className={cx("rounded border px-2 py-1 text-[10px]", active ? "border-[#d9a441]/50 bg-[#d9a441]/15 text-[#f2c873]" : "border-white/10 text-[#93a1b6]")}>{column.label}</button>;
      })}
      <div className="ml-auto flex items-center gap-2">
        {exportStatus ? <span className="max-w-72 text-right text-[10px] text-[#93a1b6]">{exportStatus}</span> : null}
        <button type="button" disabled={exporting} onClick={onExport} className="inline-flex items-center gap-1.5 rounded border border-emerald-400/35 bg-emerald-400/10 px-3 py-1.5 text-[11px] font-semibold text-emerald-200 hover:border-emerald-300/60 disabled:cursor-wait disabled:opacity-50"><Download className="size-3.5" />{exporting ? "Exporting…" : "Export CSV"}</button>
      </div>
      <span className="w-full text-[10px] text-[#657187]">CSV exports the full filtered list with the selected columns plus the complete strategy_json.</span>
    </div>
    <div className="overflow-x-auto"><table className="w-full min-w-[1240px] text-left text-xs"><thead className="bg-[#201a12] text-[#f2c873]"><tr>{columns.map(({ key, label, sortKey }) => <th key={key} aria-sort={sort === sortKey ? order === "asc" ? "ascending" : "descending" : "none"} className="px-3 py-3">{sortKey ? <button aria-label={`Sort by ${label}`} title={`Sort ${label} ${sort === sortKey && order === "desc" ? "ascending" : "descending"}`} onClick={() => setSort(sortKey)} className="flex items-center gap-1 font-semibold uppercase tracking-wide">{label}{sort === sortKey ? order === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : null}</button> : <span className="font-semibold uppercase tracking-wide">{label}</span>}</th>)}<th className="px-3 py-3">Chart</th><th className="px-3 py-3">Open in</th></tr></thead><tbody className="divide-y divide-white/5">{(data.rows ?? []).map((row) => { const key = `${row.signal_hash}-${row.order_id ?? "signal"}`; return <tr key={key} onMouseEnter={() => prefetchRowCharts(row)} onClick={() => onOpenChart(row)} className={cx("cursor-pointer hover:bg-[#d9a441]/[0.06]", activeChartKey === key && "bg-[#d9a441]/[0.12]")}>{columns.map((column) => <RealtimeFeedCell key={column.key} column={column.key} row={row} onViewStrategyJson={setStrategyJsonRow} />)}<td className="px-3 py-2"><OpenButton label="Chart" icon={LineChart} onClick={(event) => { event?.stopPropagation(); onOpenChart(row); }} /></td><td className="px-3 py-2"><div className="flex gap-1"><OpenButton label="Journal" onClick={(event) => { event?.stopPropagation(); onOpenTrade({ ...row, ticker: displayTicker(row.ticker) }, "tradezella"); }} /><OpenButton label="Stonk" onClick={(event) => { event?.stopPropagation(); onOpenTrade({ ...row, ticker: displayTicker(row.ticker) }, "stonk"); }} /></div></td></tr>; })}</tbody></table></div>
    {loading ? <div className="border-t border-white/5 px-4 py-2 text-xs text-violet-300">Refreshing rows…</div> : null}
    <div className="flex flex-wrap items-center gap-3 border-t border-white/10 px-4 py-3 text-xs text-[#7f8ca3]"><span>Showing {data.rows?.length ?? 0} of {data.pagination?.total ?? 0}</span><div className="ml-auto flex items-center gap-2"><button disabled={page <= 1} onClick={() => setPage(page - 1)} className="grid size-8 place-items-center rounded border border-white/10 disabled:opacity-30"><ChevronLeft className="size-4" /></button><span>Page {page} / {data.pagination?.pages ?? 1}</span><button disabled={page >= (data.pagination?.pages ?? 1)} onClick={() => setPage(page + 1)} className="grid size-8 place-items-center rounded border border-white/10 disabled:opacity-30"><ChevronRight className="size-4" /></button></div></div>
  </div>{strategyJsonRow ? <div role="dialog" aria-modal="true" aria-label="Strategy JSON" className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={() => setStrategyJsonRow(null)}><div className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-cyan-300/25 bg-[#0b1018] shadow-2xl" onClick={(event) => event.stopPropagation()}><div className="flex items-center gap-3 border-b border-white/10 px-4 py-3"><Braces className="size-4 text-cyan-300" /><div><h3 className="text-sm font-semibold text-white">Complete strategy_json</h3><p className="text-[10px] text-[#7f8ca3]">{displayTicker(strategyJsonRow.ticker)} · {strategyJsonRow.strategy_id ?? "Unknown strategy"} · {dateTime(strategyJsonRow.entry_datetime, strategyJsonRow.timezone)}</p></div><button type="button" aria-label="Close strategy JSON" title="Close" onClick={() => setStrategyJsonRow(null)} className="ml-auto grid size-8 place-items-center rounded border border-white/10 text-[#93a1b6] hover:border-white/25 hover:text-white"><X className="size-4" /></button></div><pre className="overflow-auto p-4 font-mono text-[11px] leading-5 text-[#c9d5e7]">{prettyStrategyJson(strategyJsonRow.strategy_json)}</pre></div></div> : null}</>;
}

function RealtimeFeedCell({ column, row, onViewStrategyJson }: { column: FeedColumnKey; row: FeedRow; onViewStrategyJson: (row: FeedRow) => void }) {
  if (column === "smt") return <td className="whitespace-nowrap px-3 py-2"><SmtCell smt={row.smt} /></td>;
  if (column === "wp_group") return <td className="whitespace-nowrap px-3 py-2"><WeeklyProfileCell wp={row.weekly_profile} /></td>;
  if (column === "signal_timeframe") {
    const labels: Record<string, string> = { "1d": "Daily", "1h": "1 Hour", "30m": "30 Minutes" };
    return <td className="whitespace-nowrap px-3 py-2 font-mono text-[#b9c4d6]">{labels[row.signal_timeframe ?? ""] ?? row.signal_timeframe ?? "—"}</td>;
  }
  const scoreMissing = row.risk_probability === null || row.risk_probability === undefined;
  if (column === "entry_datetime") return <td className="px-3 py-2 font-mono text-[#b9c4d6]">{dateTime(row.entry_datetime, row.timezone)}</td>;
  if (column === "close_ts") return <td className="px-3 py-2 font-mono text-[#93a1b6]">{dateTime(row.close_ts, row.timezone)}</td>;
  if (column === "market") return <td className="px-3 py-2 uppercase text-[#93a1b6]">{row.market}</td>;
  if (column === "ticker") return <td className="px-3 py-2 font-mono font-bold text-[#f2c873]">{displayTicker(row.ticker)}</td>;
  if (column === "strategy_id") return <td className="px-3 py-2"><StrategyLink code={row.strategy_id} label={row.strategy_id ?? "-"} className="font-mono text-cyan-300" /><div className="max-w-56 truncate text-[10px] text-[#657187]">{row.strategy}</div>{(row.strategy_key==="MSS_REVERSAL" || row.strategy_key==="REVERSAL_K1")?(row.oanda_status ? <span className="mt-1 block text-[10px] text-cyan-200">OANDA · live fill</span> : <span className="mt-1 block text-[10px] text-amber-200">Paper · {row.company_name?.includes("BACKFILL")?"Historical backfill":"Realtime signal"}</span>):null}</td>;
  if (column === "direction") return <td className={cx("px-3 py-2 font-semibold", row.direction === "BUY" ? "text-emerald-300" : "text-rose-300")}>{row.direction}</td>;
  if (column === "entry_price") return <td className="px-3 py-2 font-mono">{row.market==="forex" ? row.entry_price?.toFixed(5)??"—" : fmt(row.entry_price)}</td>;
  if (column === "stoploss") return <td className="px-3 py-2 font-mono text-rose-300">{row.market==="forex" ? row.stoploss?.toFixed(5)??"—" : fmt(row.stoploss)}</td>;
  if (column === "tp1" || column === "tp2" || column === "tp3") return <td className="px-3 py-2 font-mono text-emerald-300">{row.market==="forex" ? row[column]?.toFixed(5)??"—" : fmt(row[column])}</td>;
  if (column === "state") return <td className="px-3 py-2"><OutcomeBadge value={row.outcome ?? row.state ?? "SIGNAL_ONLY"} /></td>;
  if (column === "realized_r") return <td className={cx("px-3 py-2 font-mono font-bold", (row.realized_r ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300")}>{fmt(row.realized_r, "R")}</td>;
  if (column === "risk_probability") return <td title={scoreMissing ? row.ml_score_status?.reason : row.ml_model_version ?? undefined} className={cx("px-3 py-2 font-mono", (row.risk_probability ?? 0) >= 0.55 ? "text-emerald-300" : (!scoreMissing && Number(row.risk_probability) < 0.35) ? "text-rose-300" : "text-cyan-200")}>{scoreMissing ? <span className="text-[9px] text-amber-200">{scoreUnavailableLabel(row)}</span> : `${(Number(row.risk_probability) * 100).toFixed(1)}%`}</td>;
  if (column === "strategy_json") return <td className="px-3 py-2"><button type="button" disabled={row.strategy_json === null || row.strategy_json === undefined} onClick={(event) => { event.stopPropagation(); onViewStrategyJson(row); }} className="inline-flex items-center gap-1.5 rounded border border-cyan-300/25 bg-cyan-300/[0.06] px-2 py-1 font-semibold text-cyan-200 hover:border-cyan-300/50 disabled:cursor-not-allowed disabled:opacity-40"><Braces className="size-3.5" />View JSON</button></td>;
  return <td title={scoreMissing ? row.ml_score_status?.reason : row.ml_model_version ?? undefined} className="px-3 py-2 font-mono text-[#93a1b6]">{scoreMissing ? "—" : `${row.risk_bin ?? "—"}/10`}</td>;
}

// Warm the execution-chart data when a row is hovered, so the click renders immediately.
const prefetchTimers = new Map<string, number>();
function prefetchRowCharts(row: FeedRow) {
  if (row.strategy_key === "REVERSAL_K1") return;
  const hasOrder = Boolean(row.order_id);
  const identifier = String(row.order_id ?? row.signal_hash ?? "");
  if (!identifier || prefetchTimers.has(identifier)) return;
  // Small delay so sweeping the mouse across the table does not fire every row.
  const timer = window.setTimeout(() => {
    prefetchTimers.delete(identifier);
    const q = new URLSearchParams({ [hasOrder ? "order_id" : "signal_hash"]: identifier, target_no: "1" });
    prefetchJson(`/api/realtime-analytics/order-chart?${q}`);
  }, 150);
  prefetchTimers.set(identifier, timer);
}

function OrderChartPanel({ row, onClose }: { row: FeedRow; onClose: () => void }) {
  // Same layout as the Backtest tab: 5m ICT execution chart + HTF ICT context,
  // an "Open in MSS tab" link, and the bar-by-bar replay from the entry time.
  const isK1 = row.strategy_key === "REVERSAL_K1";
  const isPaper = row.strategy_key === "MSS_REVERSAL" || isK1;
  const hasOrder = Boolean(row.order_id);
  const identifier = (row.order_id ?? row.signal_hash ?? "") as string;
  const ticker = displayTicker(row.ticker);
  const market = tradeMarket(ticker, row.market);
  const entryTs = row.entry_datetime ?? null;
  const target = row.tp1 ?? null;
  // HTF feed: India sessions come from candles_5m (backtest feed); US and forex
  // from the validated reversal feed, which also covers the live sessions.
  const htfEndpoint = market === "india" ? "/api/backtest/daily-forward" : "/api/reversal/daily-forward";
  // Candle tables key India indices URL-encoded (%5ENSEI), so every data feed
  // gets the stored ticker; the decoded form is for display only.
  const dataSymbol = row.ticker || ticker;
  const htfSymbol = market === "forex" ? dataSymbol.replace(/^(\^|%5E)/i, "").replace(/=X$/i, "") : dataSymbol;
  return (
    <div className="space-y-4">
      <TradeExplanation key={`explain-${identifier}`} row={row} />
      {isK1 ? <ReversalK1TradeChart row={row} onClose={onClose} /> : (
        <div className="overflow-hidden rounded-xl border border-violet-400/25 bg-[#0d1020]">
          <div className="flex flex-wrap items-center gap-3 border-b border-white/10 px-4 py-3">
            <BarChart3 className="size-4 text-violet-300" />
            <div>
              <h2 className="font-semibold">ICT Execution Chart · {ticker}</h2>
              <p className="text-xs text-[#7f8ca3]">{row.strategy_id} · {row.direction} · {isPaper ? "paper tracking · no broker execution" : hasOrder ? "linked order" : "signal only (no order placed)"}</p>
            </div>
            <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-[#657187]">{row.market}</span>
          </div>
          <div className="border-b border-white/10 px-4 py-3">
            <MssLinkBar label={ticker} trade={{ symbol: dataSymbol, direction: row.direction, entryTs, market }} />
            <div className="mt-2"><SmtLinkBar label={ticker} trade={{ symbol: dataSymbol, direction: row.direction, entryTs, market }} smtText={smtSummary(row.smt)} weeklyText={weeklySummary(row.weekly_profile)} /></div>
          </div>
          <div className="grid items-start gap-4 p-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
            <div className="min-w-0">
              <OrderChart
                order={{ order_id: identifier, symbol: ticker, strategy_id: row.strategy_id, direction: row.direction, r: row.realized_r }}
                endpoint="/api/realtime-analytics/order-chart"
                identifierParam={hasOrder ? "order_id" : "signal_hash"}
                identifier={identifier}
                targetNo="1"
                // Similarity reads the equity/NSE signal tables; OANDA (IGS01V2) rows are not in them.
                showSimilarTrades={row.strategy_key !== "IGS01V2"}
                onClose={onClose}
              />
            </div>
            <div className="min-w-0 overflow-hidden rounded-md border border-white/10 bg-[#101620]">
              <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
                <LineChart className="size-4 text-cyan-300" />
                <h3 className="text-sm font-semibold">HTF ICT · Daily / 1H / 30m / 15m · ±20 / 40 / 60 bars</h3>
                <span className="ml-auto text-[10px] text-[#7f8ca3]">{ticker} · {row.direction ?? ""} · fill {row.entry_price ?? "-"}</span>
              </div>
              {entryTs ? (
                <DailyForwardChart
                  key={identifier}
                  endpoint={htfEndpoint}
                  trade={{ symbol: htfSymbol, direction: row.direction ?? null, entryTs, fill: row.entry_price ?? null, stop: row.stoploss ?? null, target, exitTs: row.close_ts ?? null, exitPrice: row.close_price ?? null, exitLabel: row.close_ts ? row.state ?? null : null }}
                />
              ) : <div className="grid h-[520px] place-items-center px-6 text-center text-sm text-[#93a1b6]">No entry time recorded for this row.</div>}
            </div>
          </div>
        </div>
      )}
      {hasOrder && ["Scalping_OB_OB_V4", "BPR_OB_V3", "IFVG_OB_V1"].includes(String(row.strategy_id)) ? (
        <div className="px-4 pb-4"><OptionLegChart key={`opt-${identifier}`} orderId={String(identifier)} /></div>
      ) : null}
      {entryTs ? (
        <BacktestPlayground
          key={`replay-${identifier}`}
          trade={{ orderId: identifier, symbol: dataSymbol, strategyId: row.strategy_id ?? null, direction: row.direction ?? null, entryTs, entry: row.entry_price ?? null, stop: row.stoploss ?? null, targetNo: "1", target }}
          levelsEndpoint="/api/realtime-analytics/order-chart"
          levelsParam={hasOrder ? "order_id" : "signal_hash"}
          live
        />
      ) : null}
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

function PerformanceMatrix({ summary }: { summary?: AnalyticsResponse["summary"] }) {
  if (!summary) return null;
  const groups = [
    {
      title: "Performance Metrics",
      items: [
        ["Initial capital", "Unavailable", "text-[#657187]"],
        ["Ending equity", "Unavailable", "text-[#657187]"],
        ["Return on capital", "Unavailable", "text-[#657187]"],
        ["Return on risk", fmt(summary.net_r, "R"), summary.net_r >= 0 ? "text-emerald-300" : "text-rose-300"],
        ["Gross / net P&L", "Unavailable", "text-[#657187]"],
        ["Execution costs", "Unavailable", "text-[#657187]"],
        ["Value at risk", fmt(summary.value_at_risk_r, "R"), "text-rose-300"],
        ["CAGR", "Unavailable", "text-[#657187]"],
      ],
    },
    {
      title: "Performance Ratios",
      items: [
        ["Profit factor", fmt(summary.profit_factor), "text-white"],
        ["Max drawdown", fmt(summary.max_drawdown_r, "R"), "text-rose-300"],
        ["Daily Sharpe", fmt(summary.sharpe_daily_r), "text-cyan-300"],
        ["Trade Sharpe", fmt(summary.trade_sharpe), "text-white"],
        ["Sortino", fmt(summary.sortino), "text-white"],
        ["Calmar", "Unavailable", "text-[#657187]"],
        ["Recovery factor", fmt(summary.recovery_factor), "text-cyan-300"],
        ["Annual R / MaxDD", fmt(summary.annualized_r_maxdd), "text-white"],
        ["RAR / MaxDD", fmt(summary.rar_maxdd), "text-white"],
        ["Ulcer index", fmt(summary.ulcer_index_r), "text-white"],
        ["K-ratio", fmt(summary.k_ratio), "text-white"],
      ],
    },
    {
      title: "Win / Loss Metrics",
      items: [
        ["Positions", summary.outcomes.toLocaleString(), "text-white"],
        ["Win rate", fmt(summary.win_rate_pct, "%"), "text-white"],
        ["Wins / losses", `${summary.wins} / ${summary.losses}`, "text-white"],
        ["Gross winning R", fmt(summary.gross_win_r, "R"), "text-emerald-300"],
        ["Gross losing R", fmt(summary.gross_loss_r, "R"), "text-rose-300"],
        ["Largest win", fmt(summary.largest_win_r, "R"), "text-emerald-300"],
        ["Largest loss", fmt(summary.largest_loss_r, "R"), "text-rose-300"],
        ["Winning streak", summary.max_consecutive_wins.toLocaleString(), "text-white"],
        ["Losing streak", summary.max_consecutive_losses.toLocaleString(), "text-white"],
      ],
    },
    {
      title: "Position Averages",
      items: [
        ["Average win", fmt(summary.avg_win_r, "R"), "text-emerald-300"],
        ["Average loss", fmt(summary.avg_loss_r, "R"), "text-rose-300"],
        ["Average P/L", fmt(summary.expectancy_r, "R"), (summary.expectancy_r ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"],
        ["Expected P/L", "Unavailable", "text-[#657187]"],
        ["Average risk", "Unavailable", "text-[#657187]"],
        ["Average quantity", fmt(summary.avg_quantity), "text-white"],
        ["Min / max quantity", `${fmt(summary.min_quantity)} / ${fmt(summary.max_quantity)}`, "text-white"],
        ["Quantity coverage", fmt(summary.quantity_coverage_pct, "%"), "text-[#93a1b6]"],
        ["Average hold", fmtDuration(summary.avg_hold_min), "text-white"],
        ["Median hold", fmtDuration(summary.median_hold_min), "text-white"],
        ["Hold-time exposure", fmt(summary.exposure_pct, "%"), "text-white"],
        ["Payoff ratio", fmt(summary.payoff_ratio), "text-amber-300"],
      ],
    },
    {
      title: "Edge & Survival",
      items: [
        ["Reward : risk", fmt(summary.payoff_ratio), "text-amber-300"],
        ["Break-even WR", fmt(summary.breakeven_win_rate_pct, "%"), "text-white"],
        ["Win-rate edge", fmt(summary.win_rate_edge_pct, "%"), (summary.win_rate_edge_pct ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"],
        ["Kelly fraction", fmt(summary.kelly_fraction_pct, "%"), (summary.kelly_fraction_pct ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"],
        ["Half Kelly", fmt(summary.half_kelly_fraction_pct, "%"), (summary.half_kelly_fraction_pct ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"],
        ["Risk of ruin", fmt(summary.risk_of_ruin_pct, "%"), "text-white"],
        ["Risk of ruin (1:1)", fmt(summary.risk_of_ruin_simple_pct, "%"), "text-[#93a1b6]"],
        ["Risk units", fmt(summary.risk_units), "text-[#93a1b6]"],
      ],
    },
  ];
  return <section className="overflow-hidden rounded-xl border border-white/10 bg-[#101620]">
    <div className="border-b border-white/10 px-4 py-3"><h2 className="font-semibold">Performance Metrics</h2><p className="text-xs text-[#657187]">Backtest-style diagnostics from completed internal realtime orders · unsupported account and cost values remain unavailable</p></div>
    <div className="grid divide-y divide-white/10 md:grid-cols-2 md:divide-x xl:grid-cols-5 xl:divide-y-0">
      {groups.map((group) => <div key={group.title} className="p-4"><h3 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#7f8ca3]">{group.title}</h3><dl className="space-y-2.5">{group.items.map(([label, value, tone]) => <div key={label} className="flex items-baseline justify-between gap-3"><dt className="text-xs text-[#7f8ca3]">{label}</dt><dd className={cx("text-right font-mono text-xs font-semibold", tone)}>{value}</dd></div>)}</dl></div>)}
    </div>
    <div className="border-t border-white/10 px-4 py-2 text-[10px] leading-4 text-[#657187]">Quantity statistics use only completed rows with a positive stored quantity; coverage shows that sample share. Hold-time exposure sums elapsed holds over the observed period and caps at 100%, so it is not broker account utilization.</div>
  </section>;
}

function ResearchPanel({ title, subtitle, icon: Icon, children }: { title: string; subtitle: string; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return <section className="overflow-hidden rounded-xl border border-white/10 bg-[#101620]"><div className="flex items-center gap-3 border-b border-white/10 px-4 py-3"><Icon className="size-4 shrink-0 text-amber-300" /><div><h3 className="text-sm font-semibold text-white">{title}</h3><p className="text-[10px] text-[#657187]">{subtitle}</p></div></div>{children}</section>;
}

function RealtimeValidationLab({ data }: { data: AnalyticsResponse }) {
  const gate = data.deployment_gate;
  if (!data.validation || !data.monte_carlo || !data.data_quality || !gate) return null;
  const passed = gate.status === "RESEARCH_PASSED_REVIEW_REQUIRED";
  return <section className="space-y-4">
    <div className="flex flex-col gap-2 border-b border-white/10 pb-3 md:flex-row md:items-end"><div><h2 className="text-lg font-semibold text-white">Research Validation</h2><p className="text-xs text-[#7f8ca3]">Chronological holdout, R-based path risk, attribution, and deployment review for the active Realtime filters.</p></div><div className={cx("inline-flex items-center gap-2 rounded border px-3 py-2 text-xs font-semibold md:ml-auto", passed ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300" : "border-rose-400/25 bg-rose-400/10 text-rose-300")}>{passed ? <ShieldCheck className="size-4" /> : <ShieldAlert className="size-4" />}{passed ? "Research passed - approval required" : `Not ready - ${gate.passed_checks}/${gate.total_checks} checks`}</div></div>
    <div className="grid gap-4 xl:grid-cols-2">
      <ResearchPanel title="Chronological Holdout" subtitle={`${data.validation.oos_pct}% out of sample · no parameter re-optimization`} icon={Activity}><HoldoutTable value={data.validation} /></ResearchPanel>
      <ResearchPanel title="Monte Carlo Path Risk" subtitle={`${data.monte_carlo.simulations} deterministic R-based bootstrap paths`} icon={TrendingDown}><MonteCarloR value={data.monte_carlo} /></ResearchPanel>
      <ResearchPanel title="Performance Attribution" subtitle="Session, year, direction, and strategy · realized R" icon={BarChart3}><RealtimeAttribution data={data} /></ResearchPanel>
      <ResearchPanel title="Data and Deployment Governance" subtitle={`${data.calculation_version ?? "realtime-analytics"} · internal-order source`} icon={ShieldCheck}><RealtimeGovernance data={data} /></ResearchPanel>
    </div>
  </section>;
}

function HoldoutTable({ value }: { value: ValidationPayload }) {
  const metrics: Array<{ label: string; read: (stats: RealtimeStats) => string }> = [
    { label: "Closed outcomes", read: (stats) => stats.outcomes.toLocaleString() },
    { label: "Win rate", read: (stats) => fmt(stats.win_rate_pct, "%") },
    { label: "Net result", read: (stats) => fmt(stats.net_r, "R") },
    { label: "Expectancy", read: (stats) => fmt(stats.expectancy_r, "R") },
    { label: "Profit factor", read: (stats) => fmt(stats.profit_factor) },
    { label: "Trade Sharpe", read: (stats) => fmt(stats.trade_sharpe) },
    { label: "Max drawdown", read: (stats) => fmt(stats.max_drawdown_r, "R") },
  ];
  return <div><div className="border-b border-white/10 px-4 py-3 text-xs text-[#7f8ca3]">Split at {dateTime(value.split_timestamp, "UTC")} UTC.</div><table className="w-full text-xs"><thead className="bg-[#0b0f16] text-[10px] uppercase text-[#7f8ca3]"><tr><th className="px-4 py-2 text-left">Metric</th><th className="px-4 py-2 text-right">In sample</th><th className="px-4 py-2 text-right">Out of sample</th></tr></thead><tbody className="divide-y divide-white/5">{metrics.map((metric) => <tr key={metric.label}><td className="px-4 py-2 text-[#93a1b6]">{metric.label}</td><td className="px-4 py-2 text-right font-mono">{metric.read(value.in_sample)}</td><td className="px-4 py-2 text-right font-mono text-white">{metric.read(value.out_of_sample)}</td></tr>)}</tbody></table><div className="border-t border-white/10 px-4 py-3 text-xs text-[#7f8ca3]">Expectancy degradation <span className={cx("ml-1 font-mono", (value.expectancy_degradation_pct ?? 0) > 50 ? "text-rose-300" : "text-white")}>{fmt(value.expectancy_degradation_pct, "%")}</span></div></div>;
}

function MonteCarloR({ value }: { value: MonteCarloPayload }) {
  const metrics = [
    ["Ending result P05", fmt(value.ending_r_p05, "R"), "text-rose-300"],
    ["Ending result median", fmt(value.ending_r_p50, "R"), "text-white"],
    ["Ending result P95", fmt(value.ending_r_p95, "R"), "text-emerald-300"],
    ["Median max drawdown", fmt(-value.max_drawdown_p50_r, "R"), "text-rose-300"],
    ["P95 max drawdown", fmt(-value.max_drawdown_p95_r, "R"), "text-rose-300"],
    ["Probability of loss", fmt(value.probability_of_loss_pct, "%"), value.probability_of_loss_pct > 20 ? "text-rose-300" : "text-white"],
    ["Probability of 20R DD", fmt(value.probability_of_20r_drawdown_pct, "%"), value.probability_of_20r_drawdown_pct > 10 ? "text-rose-300" : "text-white"],
  ];
  return <div className="grid grid-cols-2 gap-x-5 gap-y-4 p-4 sm:grid-cols-3">{metrics.map(([label, display, tone]) => <div key={label}><div className="text-[10px] text-[#7f8ca3]">{label}</div><div className={cx("mt-1 font-mono text-sm font-semibold", tone)}>{display}</div></div>)}<div className="col-span-2 border-t border-white/10 pt-3 text-[10px] leading-4 text-[#657187] sm:col-span-3">Bootstrap resampling of observed realized R. Seed {value.seed}; sequence-risk evidence only, not a forecast.</div></div>;
}

function RealtimeAttribution({ data }: { data: AnalyticsResponse }) {
  const [view, setView] = useState<"session" | "year" | "direction" | "strategy">("session");
  const project = (label: string, row: { outcomes: number; win_rate_pct: number | null; net_r: number; expectancy_r: number | null; profit_factor: number | null }) => ({
    label,
    outcomes: row.outcomes,
    win_rate_pct: row.win_rate_pct,
    net_r: row.net_r,
    expectancy_r: row.expectancy_r,
    profit_factor: row.profit_factor,
  });
  const rows = view === "session"
    ? (data.session_performance ?? []).map((row) => project(row.label, row))
    : view === "year"
      ? (data.year_performance ?? []).map((row) => project(row.year, row))
      : view === "direction"
        ? (data.direction_performance ?? []).filter((row) => row.direction !== "ALL").map((row) => project(row.label, row))
        : (data.strategy_performance ?? []).map((row) => project(row.strategy_id, row));
  return <div><div className="flex flex-wrap gap-1 border-b border-white/10 p-3">{(["session", "year", "direction", "strategy"] as const).map((option) => <button key={option} type="button" onClick={() => setView(option)} className={cx("rounded px-2 py-1 text-[10px] font-semibold uppercase", view === option ? "bg-violet-400/20 text-violet-200" : "text-[#657187] hover:text-white")}>{option}</button>)}</div><div className="max-h-[310px] overflow-auto"><table className="w-full min-w-[620px] text-xs"><thead className="sticky top-0 bg-[#101620] text-[10px] uppercase text-[#7f8ca3]"><tr>{["Group", "Closed", "WR", "Net R", "Expectancy", "PF"].map((label) => <th key={label} className={cx("px-3 py-2", label === "Group" ? "text-left" : "text-right")}>{label}</th>)}</tr></thead><tbody className="divide-y divide-white/5">{rows.map((row) => <tr key={`${view}-${row.label}`}><td className="px-3 py-2 text-white">{row.label}</td><td className="px-3 py-2 text-right font-mono">{row.outcomes}</td><td className="px-3 py-2 text-right font-mono">{fmt(row.win_rate_pct, "%")}</td><td className={cx("px-3 py-2 text-right font-mono", row.net_r >= 0 ? "text-emerald-300" : "text-rose-300")}>{fmt(row.net_r, "R")}</td><td className="px-3 py-2 text-right font-mono">{fmt(row.expectancy_r, "R")}</td><td className="px-3 py-2 text-right font-mono">{fmt(row.profit_factor)}</td></tr>)}</tbody></table></div></div>;
}

function RealtimeGovernance({ data }: { data: AnalyticsResponse }) {
  const quality = data.data_quality;
  const gate = data.deployment_gate;
  if (!quality || !gate) return null;
  return <div className="divide-y divide-white/10"><div className="grid grid-cols-2 gap-4 p-4 text-xs"><div><div className="text-[#657187]">Source</div><div className="mt-1 text-white">Realtime internal orders</div></div><div><div className="text-[#657187]">Closed sample</div><div className="mt-1 font-mono text-white">{quality.closed_orders.toLocaleString()}</div></div><div><div className="text-[#657187]">First close</div><div className="mt-1 font-mono text-white">{dateTime(quality.first_close_ts, "UTC")} UTC</div></div><div><div className="text-[#657187]">Last close</div><div className="mt-1 font-mono text-white">{dateTime(quality.last_close_ts, "UTC")} UTC</div></div></div><div className="p-4"><div className="mb-3 text-[10px] font-semibold uppercase text-[#657187]">Deployment checks</div><div className="grid gap-2 sm:grid-cols-2">{gate.checks.map((check) => <div key={check.id} className="flex items-center gap-2 text-xs text-[#d6deec]">{check.passed ? <Check className="size-4 shrink-0 text-emerald-300" /> : <CircleAlert className="size-4 shrink-0 text-rose-300" />}{check.label}</div>)}</div></div><div className="p-4"><div className="mb-2 text-[10px] font-semibold uppercase text-[#657187]">Missing-field counts</div><div className="flex flex-wrap gap-2">{Object.entries(quality.missing).map(([field, count]) => <span key={field} className={cx("rounded border px-2 py-1 font-mono text-[9px]", count ? "border-amber-300/20 bg-amber-300/[0.06] text-amber-200" : "border-white/10 text-[#93a1b6]")}>{field} {count}</span>)}</div></div><div className="p-4 text-[10px] leading-5 text-[#7f8ca3]">{quality.warnings.map((warning) => <div key={warning}>- {warning}</div>)}<div className="mt-2 text-rose-200/80">{gate.note}</div></div></div>;
}

function ChartCard({ title, subtitle, action, children }: { title: string; subtitle: string; action?: React.ReactNode; children: React.ReactNode }) { return <div className="rounded-xl border border-white/10 bg-[#101620] p-4"><div className="mb-4 flex items-start gap-3"><div><h2 className="font-semibold">{title}</h2><p className="text-xs text-[#657187]">{subtitle}</p></div>{action ? <div className="ml-auto">{action}</div> : null}</div>{children}</div>; }
function Toggle<T extends string>({ value, onChange, options }: { value: T; onChange: (value: T) => void; options: readonly T[] }) { return <div className="flex rounded-md border border-white/10 bg-black/20 p-0.5">{options.map((option) => <button key={option} onClick={() => onChange(option)} className={cx("rounded px-2 py-1 text-[10px] font-semibold uppercase", value === option ? "bg-violet-400/20 text-violet-200" : "text-[#657187]")}>{option}</button>)}</div>; }

function EquityDrawdownSeries({ rows }: { rows: Array<{ date: string; daily_r: number; equity_r: number; drawdown_r: number }> }) {
  if (!rows.length) return <ChartEmpty />;
  const width = 800, height = 220, pad = 24;
  const values = rows.map((row) => row.equity_r);
  const min = Math.min(...values, 0), max = Math.max(...values, 0), range = Math.max(max - min, 1);
  const maxDrawdown = Math.min(...rows.map((row) => row.drawdown_r), 0);
  const x = (index: number) => pad + index / Math.max(rows.length - 1, 1) * (width - pad * 2);
  const y = (value: number) => pad + (max - value) / range * (height - pad * 2);
  const points = rows.map((row, index) => `${x(index)},${y(row.equity_r)}`).join(" ");
  return <div><div className="mb-2 flex items-center justify-between gap-3 text-[10px] text-[#7f8ca3]"><span>Ending equity <b className="font-mono text-violet-200">{fmt(rows.at(-1)?.equity_r, "R")}</b></span><span>Max drawdown <b className="font-mono text-rose-300">{fmt(maxDrawdown, "R")}</b></span></div><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Realtime order equity curve and drawdown" className="h-56 w-full"><defs><linearGradient id="realtime-equity-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8b5cf6" stopOpacity=".35" /><stop offset="1" stopColor="#8b5cf6" stopOpacity="0" /></linearGradient></defs>{[0,1,2,3,4].map((i)=><line key={i} x1={pad} x2={width-pad} y1={pad+i*(height-pad*2)/4} y2={pad+i*(height-pad*2)/4} stroke="rgba(255,255,255,.06)" />)}<polygon points={`${pad},${height-pad} ${points} ${width-pad},${height-pad}`} fill="url(#realtime-equity-fill)" />{rows.map((row,index) => row.drawdown_r < 0 ? <rect key={`${row.date}-${index}`} x={x(index)-1.5} y={height-pad-(Math.abs(row.drawdown_r)/Math.max(Math.abs(maxDrawdown),1))*58} width="3" height={(Math.abs(row.drawdown_r)/Math.max(Math.abs(maxDrawdown),1))*58} fill="rgba(251,113,133,.3)" /> : null)}<polyline points={points} fill="none" stroke="#a78bfa" strokeWidth="3" strokeLinejoin="round" /></svg><div className="flex items-center gap-4 text-[10px] text-[#657187]"><span><span className="mr-1 inline-block h-0.5 w-4 bg-violet-400" />Equity R</span><span><span className="mr-1 inline-block h-2 w-4 bg-rose-400/30" />Drawdown R</span></div></div>;
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

function plannedRrParam(values: string[]) {
  return values.length === PLANNED_RR_BUCKET_IDS.length ? "ALL" : values.length ? values.join(",") : "NONE";
}

type WeekdayTimeCell = { day: string; slot: number; label: string; wins: number; losses: number; breakeven?: number; n: number; net_r: number; win_rate_pct: number | null };
type WeekdayRow = { day: string; net_r: number; wins?: number; losses?: number; breakeven?: number; n?: number; win_rate_pct?: number | null; expectancy_r?: number | null };

const winRateTone = (value: number | null | undefined) => value === null || value === undefined ? "border-white/5 bg-white/[0.02]" : value >= 67 ? "border-emerald-400/40 bg-emerald-500/25" : value >= 50 ? "border-cyan-400/40 bg-cyan-500/20" : "border-rose-400/40 bg-rose-500/20";
const signedR = (value: number) => `${value > 0 ? "+" : ""}${Number(value.toFixed(2))}R`;

// Same closed trades as the heatmap: each bar equals that day's heatmap column total.
function DayOfWeekPanel({ rows }: { rows: WeekdayRow[] }) {
  if (!rows.length || rows.every((row) => !row.n && !row.net_r)) return <ChartEmpty />;
  const maxAbs = Math.max(...rows.map((row) => Math.abs(row.net_r)), 1);
  return (
    <div>
      <div className="flex h-44 items-stretch gap-2">
        {rows.map((row) => {
          const height = `${Math.max(4, Math.abs(row.net_r) / maxAbs * 50)}%`;
          return (
            <div key={row.day} className="relative flex-1" title={`${row.day}: ${signedR(row.net_r)} · ${row.wins ?? 0}W / ${row.losses ?? 0}L${row.breakeven ? ` / ${row.breakeven}BE` : ""}`}>
              <div className="absolute inset-x-0 top-1/2 border-t border-white/15" />
              <div className={cx("absolute inset-x-1 rounded-sm", row.net_r >= 0 ? "bottom-1/2 bg-emerald-500/80" : "top-1/2 bg-rose-500/80")} style={{ height }} />
              <div className={cx("absolute inset-x-0 text-center font-mono text-xs font-bold text-white", row.net_r >= 0 ? "top-1/2 mt-1" : "bottom-1/2 mb-1")}>{signedR(row.net_r)}</div>
            </div>
          );
        })}
      </div>
      <table className="mt-2 w-full table-fixed text-center text-[11px]">
        <tbody>
          <tr className="text-xs font-semibold text-white">{rows.map((row) => <td key={row.day}>{row.day}</td>)}</tr>
          <tr>{rows.map((row) => <td key={row.day} className="pt-1"><span className={cx("inline-block rounded border px-1.5 py-0.5 font-mono font-bold text-white", winRateTone(row.win_rate_pct))}>{fmt(row.win_rate_pct ?? null, "%")}</span></td>)}</tr>
          <tr className="font-mono text-[#c3cddb]">{rows.map((row) => <td key={row.day} className="pt-1">{row.wins ?? 0}W / {row.losses ?? 0}L{row.breakeven ? ` / ${row.breakeven}BE` : ""}</td>)}</tr>
          <tr className="font-mono text-[#c3cddb]">{rows.map((row) => <td key={row.day}>n={row.n ?? 0} · {row.expectancy_r === null || row.expectancy_r === undefined ? "-" : signedR(row.expectancy_r)}/trade</td>)}</tr>
        </tbody>
      </table>
    </div>
  );
}
type HeatmapMode = "day × time" | "daily" | "monthly";
const HEATMAP_MODES: readonly HeatmapMode[] = ["day × time", "daily", "monthly"];
const WEEKDAY_ORDER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function WeekdayTimeHeatmap({ cells, totals }: { cells: WeekdayTimeCell[]; totals: WeekdayRow[] }) {
  if (!cells.length) return <ChartEmpty />;
  const days = WEEKDAY_ORDER.filter((day) => cells.some((cell) => cell.day === day));
  const slots = [...new Set(cells.map((cell) => cell.slot))].sort((a, b) => a - b);
  const byKey = new Map(cells.map((cell) => [`${cell.day}|${cell.slot}`, cell]));
  const totalByDay = new Map(totals.map((row) => [row.day, row]));
  const slotLabel = (slot: number) => `${String(Math.floor(slot / 60)).padStart(2, "0")}:${String(slot % 60).padStart(2, "0")}`;
  const cellBody = (wr: number | null | undefined, n: number, netR: number) => (
    <>
      <div className="font-mono text-xs font-bold text-white">{fmt(wr ?? null, "%")}</div>
      <div className="font-mono text-[10px] text-[#dbe3ee]">{signedR(netR)} · n={n}</div>
    </>
  );
  return (
    <div className="max-h-96 overflow-auto">
      <table className="w-full border-separate border-spacing-1 text-center">
        <thead className="sticky top-0 z-10 bg-[#101620]">
          <tr>
            <th className="w-14 text-[10px] font-normal text-[#aeb9ca]">Entry</th>
            {days.map((day) => <th key={day} className="text-xs font-semibold text-white">{day}</th>)}
          </tr>
        </thead>
        <tbody>
          {slots.map((slot) => (
            <tr key={slot}>
              <td className="font-mono text-[10px] text-[#aeb9ca]">{slotLabel(slot)}</td>
              {days.map((day) => {
                const cell = byKey.get(`${day}|${slot}`);
                if (!cell) return <td key={day} className="rounded-md bg-white/[0.02] text-[10px] text-[#4b5568]">–</td>;
                return (
                  <td key={day} title={`${day} ${slotLabel(slot)}–${slotLabel(slot + 30)} · WR ${fmt(cell.win_rate_pct, "%")} · ${cell.wins}W/${cell.losses}L${cell.breakeven ? `/${cell.breakeven}BE` : ""} · ${signedR(cell.net_r)}`} className={cx("rounded-md border px-1 py-1", winRateTone(cell.win_rate_pct), cell.n < 5 && "opacity-60")}>
                    {cellBody(cell.win_rate_pct, cell.n, cell.net_r)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot className="sticky bottom-0 bg-[#101620]">
          <tr>
            <td className="text-[10px] font-semibold text-white">Day total</td>
            {days.map((day) => {
              const total = totalByDay.get(day);
              return (
                <td key={day} className={cx("rounded-md border-2 px-1 py-1", winRateTone(total?.win_rate_pct))}>
                  {total ? cellBody(total.win_rate_pct, total.n ?? 0, total.net_r) : "–"}
                </td>
              );
            })}
          </tr>
        </tfoot>
      </table>
      <p className="mt-1 text-[10px] text-[#aeb9ca]">Each cell: win rate (W ÷ W+L) · net R · closed trades. Day total = Day-of-Week P&amp;L. Faded cells have fewer than 5 trades. Daily-timeframe entries sit on the 09:30 ET open.</p>
    </div>
  );
}

function MonthlyRHeatmap({ rows }: { rows: MonthlyRow[] }) {
  if (!rows.length) return <ChartEmpty />;
  const years = [...new Set(rows.map((row) => row.month.slice(0, 4)))].sort((a, b) => b.localeCompare(a));
  const byMonth = new Map(rows.map((row) => [row.month, row]));
  const maxAbs = Math.max(...rows.map((row) => Math.abs(row.net_r)), 1);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return <div className="overflow-auto"><table className="w-full min-w-[720px] border-separate border-spacing-1 text-center text-[11px]"><thead className="text-[#7f8ca3]"><tr><th className="px-2 text-left">Year</th>{monthNames.map((month) => <th key={month} className="px-2 py-1">{month}</th>)}</tr></thead><tbody>{years.map((year) => <tr key={year}><td className="px-2 text-left font-mono font-semibold text-white">{year}</td>{monthNames.map((month, index) => {
    const item = byMonth.get(`${year}-${String(index + 1).padStart(2, "0")}`);
    const alpha = item ? Math.min(0.72, 0.12 + Math.abs(item.net_r) / maxAbs * 0.6) : 0;
    return <td key={month} title={item ? `${item.month}: ${fmt(item.net_r, "R")} · ${item.wins + item.losses} closed` : `${year} ${month}: no outcomes`} className="rounded px-2 py-2 font-mono text-white" style={{ backgroundColor: item ? (item.net_r >= 0 ? `rgba(52,211,153,${alpha})` : `rgba(251,113,133,${alpha})`) : "rgba(255,255,255,.02)" }}>{item ? `${item.net_r >= 0 ? "+" : ""}${item.net_r.toFixed(1)}` : "-"}</td>;
  })}</tr>)}</tbody></table></div>;
}

const SMT_FILTER_LABELS: Record<string, string> = {
  ALL: "ALL - with or without SMT",
  ALIGNED: "SMT with the trade",
  OPPOSED: "SMT against the trade",
  ANY: "Any SMT at signal",
  NONE: "No SMT at signal",
};

/** SMT at signal time vs the index / correlated peer (India NIFTY 50, US SPY, forex correlated pair). */
function SmtCell({ smt }: { smt?: SmtResult | null }) {
  if (!smt) return <span className="font-mono text-[10px] text-[#657187]">pending</span>;
  const has = smt.status === "BULLISH_SMT" || smt.status === "BEARISH_SMT";
  if (!has) return <span className="font-mono text-[10px] text-[#657187]" title={`vs ${smt.peer_label ?? "peer"}`}>{smt.status === "NO_SMT" ? "none" : smt.status === "NO_PEER_DATA" ? "no peer data" : "n/a"}</span>;
  return (
    <span title={`${smt.status === "BULLISH_SMT" ? "Bullish" : "Bearish"} SMT vs ${smt.peer_label}${smt.event ? ` · confirmed ${new Date(smt.event.confirmed_at).toLocaleString()}` : ""}`}
      className={cx("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold", smt.aligned ? "border-pink-400/40 bg-pink-400/10 text-pink-200" : "border-amber-400/40 bg-amber-400/10 text-amber-200")}>
      {smt.status === "BULLISH_SMT" ? "▲ Bull" : "▼ Bear"} · {smt.aligned ? "with" : "against"}
    </span>
  );
}

function smtSummary(smt?: SmtResult | null): string {
  if (!smt) return "pending";
  if (smt.status === "BULLISH_SMT" || smt.status === "BEARISH_SMT") return `${smt.status === "BULLISH_SMT" ? "bullish" : "bearish"} SMT ${smt.aligned ? "with" : "against"} the trade`;
  return smt.status === "NO_SMT" ? "no SMT at signal" : smt.status === "NO_PEER_DATA" ? "no peer data" : "n/a";
}
function weeklySummary(wp?: WeeklyProfileResult | null): string {
  if (!wp) return "pending";
  const side = wp.live.aligned === true ? " · supports the trade" : wp.live.aligned === false ? " · against the trade" : "";
  return `${PROFILE_LABELS[wp.live.profile]}${side}`;
}

const WEEKLY_FILTER_LABELS: Record<string, string> = {
  ALL: "ALL - any week",
  ALIGNED: "Profile with the trade",
  OPPOSED: "Profile against the trade",
  ANY: "Any named profile",
  NONE: "No profile at signal",
  AVOID_SD: "Exclude Seek & Destroy",
  CLASSIC_TUE: "Classic Tuesday high/low",
  WED: "Wednesday high/low",
  WED_REVERSAL: "Wednesday weekly reversal",
  CONSOL_THU: "Consolidation Thursday reversal",
  MIDWEEK: "Consolidation midweek rally/decline",
  SEEK_DESTROY: "Seek & Destroy Friday (bull/bear)",
};

/** ICT weekly profile known at the signal; hover shows the prior-week range and what the week finally printed. */
function WeeklyProfileCell({ wp }: { wp?: WeeklyProfileResult | null }) {
  if (!wp) return <span className="font-mono text-[10px] text-[#657187]">pending</span>;
  const p = wp.live.profile;
  const named = !["NO_PROFILE", "MONDAY_FORMING", "NO_DATA", "UNSUPPORTED", "OTHER", "MONDAY_EXTREME"].includes(p);
  const lv = wp.levels;
  const title = [
    `${wp.signal_day ?? ""} · week of ${wp.week ?? "?"}`,
    lv ? `Prior week ${lv.pwl.toFixed(2)}-${lv.pwh.toFixed(2)} · EQ ${lv.eq.toFixed(2)}` : "",
    lv ? `Week so far: low ${lv.wtd_low_day} ${lv.wtd_low.toFixed(2)} · high ${lv.wtd_high_day} ${lv.wtd_high.toFixed(2)}` : "",
    wp.live.plan ? `Plan: swept ${wp.live.plan.swept} · stop beyond ${wp.live.plan.stop_ref.toFixed(2)} · T1 ${wp.live.plan.t1_label} ${wp.live.plan.t1.toFixed(2)} · T2 ${wp.live.plan.t2_label} ${wp.live.plan.t2.toFixed(2)}` : "",
    wp.hindsight ? `Week printed: ${PROFILE_LABELS[wp.hindsight.profile]} (low ${wp.hindsight.low_day}, high ${wp.hindsight.high_day})` : "Week not finished",
  ].filter(Boolean).join("\n");
  if (!named) return <span className="font-mono text-[10px] text-[#657187]" title={title}>{wp.signal_day ? `${wp.signal_day} · ` : ""}{PROFILE_LABELS[p]}</span>;
  const tone = p.startsWith("SEEK_DESTROY") ? "border-rose-400/40 bg-rose-400/10 text-rose-200"
    : wp.live.aligned ? "border-sky-400/40 bg-sky-400/10 text-sky-200" : "border-amber-400/40 bg-amber-400/10 text-amber-200";
  return <span title={title} className={cx("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold", tone)}>
    {PROFILE_LABELS[p]}{wp.live.aligned === null ? "" : wp.live.aligned ? " · with" : " · against"}
  </span>;
}

function SmtPerformanceTable({ rows, title = "SMT Divergence at Signal", subtitle = "Completed outcomes grouped by SMT vs the index / correlated peer (NIFTY 50 · SPY · forex pair) in the hour before the signal", groupLabel = "SMT at signal" }: { rows: Array<RealtimeStats & { group: string }>; title?: string; subtitle?: string; groupLabel?: string }) {
  const shown = rows.filter((row) => row.group !== "Pending" || row.outcomes > 0);
  return <DataCard title={title} subtitle={subtitle}>
    <table className="w-full min-w-[760px] text-xs"><thead className="bg-[#0b0f16] text-[10px] uppercase text-[#657187]"><tr>{[groupLabel, "Closed", "Win rate", "Net R", "Expectancy", "Profit factor", "Avg win", "Avg loss", "Max DD"].map((label) => <th key={label} className="px-3 py-2 text-left">{label}</th>)}</tr></thead>
      <tbody className="divide-y divide-white/5 font-mono">{shown.length ? shown.map((row) => <tr key={row.group}>
        <td className="px-3 py-2 font-sans font-semibold text-white">{row.group}</td>
        <td className="px-3 py-2">{fmt(row.outcomes)}</td>
        <td className="px-3 py-2">{fmt(row.win_rate_pct, "%")}</td>
        <td className={cx("px-3 py-2 font-bold", (row.net_r ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300")}>{fmt(row.net_r, "R")}</td>
        <td className="px-3 py-2">{fmt(row.expectancy_r, "R")}</td>
        <td className="px-3 py-2">{fmt(row.profit_factor)}</td>
        <td className="px-3 py-2 text-emerald-300">{fmt(row.avg_win_r, "R")}</td>
        <td className="px-3 py-2 text-rose-300">{fmt(row.avg_loss_r, "R")}</td>
        <td className="px-3 py-2 text-rose-300">{fmt(row.max_drawdown_r, "R")}</td>
      </tr>) : <tr><td colSpan={9} className="px-3 py-8 text-center text-[#657187]">No completed outcomes for this selection.</td></tr>}</tbody></table>
  </DataCard>;
}

function DirectionPerformanceTable({ rows }: { rows: DirectionPerformanceRow[] }) {
  if (!rows.length) return <DataCard title="All / BUY / SELL Statistics" subtitle="Completed internal outcomes by direction"><div className="grid h-40 place-items-center text-sm text-[#657187]">No completed outcomes for this selection.</div></DataCard>;
  const byDirection = new Map(rows.map((row) => [row.direction, row]));
  const columns = [byDirection.get("ALL"), byDirection.get("BUY"), byDirection.get("SELL")];
  const metrics: Array<{ label: string; read: (row: DirectionPerformanceRow) => string; tone?: "green" | "red" }> = [
    { label: "Closed outcomes", read: (row) => row.outcomes.toLocaleString() },
    { label: "Wins", read: (row) => row.wins.toLocaleString(), tone: "green" },
    { label: "Losses", read: (row) => row.losses.toLocaleString(), tone: "red" },
    { label: "Win rate", read: (row) => fmt(row.win_rate_pct, "%") },
    { label: "Net R", read: (row) => fmt(row.net_r, "R") },
    { label: "Expectancy", read: (row) => fmt(row.expectancy_r, "R") },
    { label: "Average win", read: (row) => fmt(row.avg_win_r, "R"), tone: "green" },
    { label: "Average loss", read: (row) => fmt(row.avg_loss_r, "R"), tone: "red" },
    { label: "Largest win", read: (row) => fmt(row.largest_win_r, "R"), tone: "green" },
    { label: "Largest loss", read: (row) => fmt(row.largest_loss_r, "R"), tone: "red" },
    { label: "Profit factor", read: (row) => fmt(row.profit_factor) },
    { label: "Max drawdown", read: (row) => fmt(row.max_drawdown_r, "R"), tone: "red" },
  ];
  return <DataCard title="All / BUY / SELL Statistics" subtitle="Backtest-style directional comparison · completed internal orders only"><table className="w-full min-w-[620px] text-xs"><thead className="sticky top-0 bg-[#101620] text-[10px] uppercase text-[#7f8ca3]"><tr><th className="px-4 py-2 text-left">Metric</th>{["All", "BUY", "SELL"].map((label) => <th key={label} className="px-4 py-2 text-right">{label}</th>)}</tr></thead><tbody className="divide-y divide-white/5">{metrics.map((metric) => <tr key={metric.label}><td className="px-4 py-2 text-[#93a1b6]">{metric.label}</td>{columns.map((row, index) => <td key={index} className={cx("px-4 py-2 text-right font-mono", metric.tone === "green" ? "text-emerald-300" : metric.tone === "red" ? "text-rose-300" : "text-white")}>{row ? metric.read(row) : "Unavailable"}</td>)}</tr>)}</tbody></table></DataCard>;
}

function HoldTimePerformanceTable({ rows }: { rows: HoldTimePerformanceRow[] }) {
  return <DataCard title="Performance by Hold Time" subtitle="Entry-to-close duration · early means under 60 minutes · descriptive, not a recommendation to widen stops">
    {rows.length ? <table className="w-full min-w-[1320px] text-xs"><thead className="sticky top-0 bg-[#101620] text-[10px] uppercase text-[#7f8ca3]"><tr>{["Hold bucket", "Avg hold", "Closed", "Trade share", "Wins", "Losses", "WR", "Loss rate", "Share of losses", "PF", "Expectancy", "Avg win", "Avg loss", "Net R", "Max DD"].map((label) => <th key={label} className={cx("px-3 py-2", label === "Hold bucket" ? "text-left" : "text-right")}>{label}</th>)}</tr></thead><tbody className="divide-y divide-white/5">{rows.map((row) => <tr key={row.bucket_id} className={row.early ? "bg-amber-300/[0.035]" : undefined}><td className="px-3 py-2 text-left"><span className={cx("font-semibold", row.early ? "text-amber-200" : "text-white")}>{row.label}</span>{row.early ? <span className="ml-2 rounded bg-amber-300/10 px-1.5 py-0.5 text-[9px] uppercase text-amber-200">early</span> : null}</td><td className="px-3 py-2 text-right font-mono">{fmtDuration(row.avg_hold_min)}</td><td className="px-3 py-2 text-right font-mono">{row.outcomes}</td><td className="px-3 py-2 text-right font-mono">{fmt(row.trade_share_pct, "%")}</td><td className="px-3 py-2 text-right font-mono text-emerald-300">{row.wins}</td><td className="px-3 py-2 text-right font-mono text-rose-300">{row.losses}</td><td className="px-3 py-2 text-right font-mono">{fmt(row.win_rate_pct, "%")}</td><td className="px-3 py-2 text-right font-mono">{fmt(row.loss_rate_pct, "%")}</td><td className="px-3 py-2 text-right font-mono">{fmt(row.loss_concentration_pct, "%")}</td><td className="px-3 py-2 text-right font-mono">{fmt(row.profit_factor)}</td><td className={cx("px-3 py-2 text-right font-mono", (row.expectancy_r ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300")}>{fmt(row.expectancy_r, "R")}</td><td className="px-3 py-2 text-right font-mono text-emerald-300">{fmt(row.avg_win_r, "R")}</td><td className="px-3 py-2 text-right font-mono text-rose-300">{fmt(row.avg_loss_r, "R")}</td><td className={cx("px-3 py-2 text-right font-mono", row.net_r >= 0 ? "text-emerald-300" : "text-rose-300")}>{fmt(row.net_r, "R")}</td><td className="px-3 py-2 text-right font-mono text-rose-300">{fmt(row.max_drawdown_r, "R")}</td></tr>)}</tbody></table> : <div className="grid h-40 place-items-center text-sm text-[#657187]">No completed orders have usable entry and close timestamps.</div>}
  </DataCard>;
}
function ChartEmpty() { return <div className="grid h-56 place-items-center text-sm text-[#657187]">No realized outcomes for this selection.</div>; }

function StrategyPerformanceTable({ rows }: { rows: StrategyPerformance[] }) { return <DataCard title="Strategy Performance" subtitle="Internal orders · realized R"><table className="w-full min-w-[760px] text-left text-xs"><thead><tr>{["Strategy","Orders","Outcomes","WR%","Avg Win R","Net R","Max DD R","PF","Exp. R"].map((label)=><th key={label} className="px-3 py-2 text-[#7f8ca3]">{label}</th>)}</tr></thead><tbody className="divide-y divide-white/5">{rows.map((row)=><tr key={row.strategy_id}><td className="px-3 py-2"><StrategyLink code={row.strategy_id} label={row.strategy_id} className="font-mono font-bold text-violet-300" /><div className="max-w-40 truncate text-[9px] text-[#657187]">{row.strategy_name}</div></td><td className="px-3 py-2">{row.orders}</td><td className="px-3 py-2">{row.outcomes}</td><td className="px-3 py-2">{fmt(row.win_rate_pct,"%")}</td><td className="px-3 py-2">{fmt(row.avg_win_r,"R")}</td><td className="px-3 py-2">{fmt(row.net_r,"R")}</td><td className="px-3 py-2 text-rose-300">{fmt(row.max_drawdown_r,"R")}</td><td className="px-3 py-2">{fmt(row.profit_factor)}</td><td className="px-3 py-2">{fmt(row.expectancy_r,"R")}</td></tr>)}</tbody></table></DataCard>; }
function StrategyCoverageTable({ rows }: { rows: StrategyCoverage[] }) { return <DataCard title="Strategy Coverage" subtitle="Signal generation footprint"><table className="w-full min-w-[720px] text-left text-xs"><thead><tr>{["Code","Strategy Name","Signals","BUY","SELL","Tickers","Avg Risk Pts","Share %"].map((label)=><th key={label} className="px-3 py-2 text-[#7f8ca3]">{label}</th>)}</tr></thead><tbody className="divide-y divide-white/5">{rows.map((row)=><tr key={row.strategy_id}><td className="px-3 py-2"><StrategyLink code={row.strategy_id} label={row.strategy_id} className="font-mono font-bold text-cyan-300" /></td><td className="max-w-48 truncate px-3 py-2">{row.strategy_name}</td><td className="px-3 py-2">{row.signals}</td><td className="px-3 py-2 text-emerald-300">{row.buy}</td><td className="px-3 py-2 text-rose-300">{row.sell}</td><td className="px-3 py-2">{row.tickers}</td><td className="px-3 py-2">{fmt(row.avg_risk_points)}</td><td className="px-3 py-2">{fmt(row.share_pct,"%")}</td></tr>)}</tbody></table></DataCard>; }
function tickerColor(ticker: string) { let hash = 0; for (const character of ticker) hash = (hash * 31 + character.charCodeAt(0)) >>> 0; return `hsl(${hash % 360} 66% 58%)`; }
function TickerDistribution({ rows, selected, onPick }: { rows: TickerDistributionRow[]; selected: string[]; onPick: (ticker: string) => void }) {
  if (!rows.length) return <DataCard title="Trade Distribution by Ticker" subtitle="Linked internal orders · current filters"><div className="grid h-48 place-items-center text-sm text-[#657187]">No linked orders for this selection.</div></DataCard>;
  const segments = rows.map((row, index) => {
    const offset = -rows.slice(0, index).reduce((sum, prior) => sum + prior.share_pct, 0);
    return { ...row, offset, color: tickerColor(row.ticker) };
  });
  const total = rows.reduce((sum, row) => sum + row.orders, 0);
  return <DataCard title="Trade Distribution by Ticker" subtitle="Percentage, order count, win rate, winning R, and net R · click a ticker to filter">
    <div className="grid gap-5 p-4 lg:grid-cols-[240px_1fr] lg:items-center">
      <div className="mx-auto w-full max-w-[240px]">
        <svg viewBox="0 0 120 120" role="img" aria-label={`Trade distribution across ${rows.length} tickers`} className="h-auto w-full">
          <circle cx="60" cy="60" r="46" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="19" />
          {segments.map((segment) => <circle key={segment.ticker} cx="60" cy="60" r="46" fill="none" stroke={segment.color} strokeWidth="19" pathLength="100" strokeDasharray={`${segment.share_pct} ${100 - segment.share_pct}`} strokeDashoffset={segment.offset} transform="rotate(-90 60 60)"><title>{`${displayTicker(segment.ticker)}: ${segment.orders} orders (${segment.share_pct.toFixed(2)}%)`}</title></circle>)}
          <text x="60" y="57" textAnchor="middle" className="fill-white font-mono text-[8px] font-semibold">{total.toLocaleString()}</text>
          <text x="60" y="66" textAnchor="middle" className="fill-[#7f8ca3] text-[4px] uppercase tracking-wider">linked orders</text>
        </svg>
      </div>
      <div className="grid max-h-[330px] gap-2 overflow-auto pr-1 sm:grid-cols-2 xl:grid-cols-3">
        {segments.map((row) => <button key={row.ticker} type="button" onClick={() => onPick(row.ticker)} className={cx("rounded-md border px-3 py-2 text-left transition hover:bg-white/[0.04]", selected.includes(row.ticker) ? "border-[#d9a441]/60 bg-[#d9a441]/10" : "border-white/10 bg-[#0b0f16]")}>
          <span className="flex items-center gap-2"><span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: row.color }} /><span className="min-w-0 flex-1 truncate font-mono text-xs font-bold text-white">{displayTicker(row.ticker)}</span><span className="font-mono text-xs font-semibold text-[#f2c873]">{row.share_pct.toFixed(2)}%</span><span className="w-16 text-right font-mono text-[10px] text-[#7f8ca3]">{row.orders} trades</span></span>
          <span className="mt-2 grid grid-cols-3 gap-2 border-t border-white/5 pt-2"><span><span className="block text-[9px] uppercase text-[#657187]">Win rate</span><span className="font-mono text-[11px] text-white">{fmt(row.win_rate_pct, "%")}</span></span><span><span className="block text-[9px] uppercase text-[#657187]">Win R</span><span className="font-mono text-[11px] text-emerald-300">+{fmt(row.win_r, "R")}</span></span><span><span className="block text-[9px] uppercase text-[#657187]">Net R</span><span className={cx("font-mono text-[11px]", row.net_r >= 0 ? "text-emerald-300" : "text-rose-300")}>{row.net_r >= 0 ? "+" : ""}{fmt(row.net_r, "R")}</span></span></span>
        </button>)}
      </div>
    </div>
  </DataCard>;
}
function SessionPerformanceTable({ rows }: { rows: SessionPerformanceRow[] }) { return <DataCard title="Performance Attribution by ICT Session" subtitle="DST-aware New York windows plus fixed IST market hours · overlaps are intentionally attributed to every matching session"><table className="w-full min-w-[920px] text-left text-xs"><thead><tr>{["ICT Session","Signals","Orders","Closed n","WR%","Avg Win R","Net R","Max DD R","PF","Exp. R"].map((label)=><th key={label} className="px-3 py-2 text-[#7f8ca3]">{label}</th>)}</tr></thead><tbody className="divide-y divide-white/5">{rows.map((row)=><tr key={row.session_id}><td className="px-3 py-2 font-medium text-white">{row.label}</td><td className="px-3 py-2 font-mono">{row.signals}</td><td className="px-3 py-2 font-mono">{row.orders}</td><td className="px-3 py-2 font-mono">{row.outcomes}</td><td className="px-3 py-2 font-mono">{fmt(row.win_rate_pct,"%")}</td><td className="px-3 py-2 font-mono text-emerald-300">{fmt(row.avg_win_r,"R")}</td><td className={cx("px-3 py-2 font-mono", row.net_r >= 0 ? "text-emerald-300" : "text-rose-300")}>{fmt(row.net_r,"R")}</td><td className="px-3 py-2 font-mono text-rose-300">{fmt(row.max_drawdown_r,"R")}</td><td className="px-3 py-2 font-mono">{fmt(row.profit_factor)}</td><td className="px-3 py-2 font-mono">{fmt(row.expectancy_r,"R")}</td></tr>)}</tbody></table></DataCard>; }
function RiskBinPerformanceTable({ rows }: { rows: RiskBinPerformanceRow[] }) {
  return <DataCard title="Performance by Risk Bin" subtitle="Same filtered population · unscored rows remain separate and never inherit a model bin">
    {rows.length ? <table className="w-full min-w-[1380px] text-left text-xs">
      <thead className="sticky top-0 bg-[#101620]"><tr>{["Risk Bin","Signals","Trades","Open","Closed","W","L","BE","Avg risk %","WR%","Loss%","Avg Win R","Avg Loss R","PF","Expectancy","Net R","Max DD R"].map((label)=><th key={label} className="px-3 py-2 text-[#7f8ca3]">{label}</th>)}</tr></thead>
      <tbody className="divide-y divide-white/5">{rows.map((row)=><tr key={row.label} className={row.risk_bin === null ? "bg-amber-300/[0.035]" : undefined}>
        <td className={cx("px-3 py-2 font-semibold", row.risk_bin === null ? "text-amber-200" : "text-white")}>{row.label}</td>
        <td className="px-3 py-2 font-mono">{row.signals}</td><td className="px-3 py-2 font-mono">{row.orders}</td><td className="px-3 py-2 font-mono text-cyan-300">{row.open}</td><td className="px-3 py-2 font-mono">{row.outcomes}</td><td className="px-3 py-2 font-mono text-emerald-300">{row.wins}</td><td className="px-3 py-2 font-mono text-rose-300">{row.losses}</td><td className="px-3 py-2 font-mono">{row.breakeven}</td>
        <td className="px-3 py-2 font-mono">{fmt(row.avg_risk_probability_pct,"%")}</td><td className="px-3 py-2 font-mono">{fmt(row.win_rate_pct,"%")}</td><td className="px-3 py-2 font-mono">{fmt(row.loss_rate_pct,"%")}</td><td className="px-3 py-2 font-mono text-emerald-300">{fmt(row.avg_win_r,"R")}</td><td className="px-3 py-2 font-mono text-rose-300">{fmt(row.avg_loss_r,"R")}</td><td className="px-3 py-2 font-mono">{fmt(row.profit_factor)}</td><td className={cx("px-3 py-2 font-mono", (row.expectancy_r ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300")}>{fmt(row.expectancy_r,"R")}</td><td className={cx("px-3 py-2 font-mono", row.net_r >= 0 ? "text-emerald-300" : "text-rose-300")}>{fmt(row.net_r,"R")}</td><td className="px-3 py-2 font-mono text-rose-300">{fmt(row.max_drawdown_r,"R")}</td>
      </tr>)}</tbody>
    </table> : <div className="grid h-32 place-items-center text-sm text-[#657187]">No risk-bin observations for this selection.</div>}
  </DataCard>;
}
function DataCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) { return <div className="overflow-hidden rounded-xl border border-white/10 bg-[#101620]"><div className="border-b border-white/10 px-4 py-3"><h2 className="font-semibold">{title}</h2><p className="text-xs text-[#657187]">{subtitle}</p></div><div className="max-h-[430px] overflow-auto">{children}</div></div>; }

function CompactLedger({ title, rows, onOpenTrade, onOpenChart }: { title: string; rows: FeedRow[]; onOpenTrade: Props["onOpenTrade"]; onOpenChart: (row: FeedRow) => void }) { return <DataCard title={title} subtitle={`${rows.length} rows returned · click a row to chart`}><table className="w-full min-w-[760px] text-left text-xs"><thead><tr>{["Ticker","Strategy","Side","Entry time","State","R","Open in"].map((label)=><th key={label} className="px-3 py-2 text-[#7f8ca3]">{label}</th>)}</tr></thead><tbody className="divide-y divide-white/5">{rows.map((row)=><tr key={`${title}-${row.order_id}`} onClick={()=>onOpenChart(row)} className="cursor-pointer hover:bg-violet-400/[0.06]"><td className="px-3 py-2 font-mono font-bold text-violet-300">{displayTicker(row.ticker)}</td><td className="px-3 py-2"><StrategyLink code={row.strategy_id} label={row.strategy_id ?? "-"} className="text-cyan-300" />{(row.strategy_key==="MSS_REVERSAL" || row.strategy_key==="REVERSAL_K1")?(row.oanda_status ? <div className="text-[10px] text-cyan-200">OANDA · live fill</div> : <div className="text-[10px] text-amber-200">Paper · {row.company_name?.includes("BACKFILL")?"Historical backfill":"Realtime signal"}</div>):null}</td><td className={cx("px-3 py-2",row.direction==="BUY"?"text-emerald-300":"text-rose-300")}>{row.direction}</td><td className="px-3 py-2 text-[#93a1b6]">{dateTime(row.entry_datetime,row.timezone)}</td><td className="px-3 py-2"><OutcomeBadge value={row.outcome ?? row.state ?? "UNKNOWN"} /></td><td className="px-3 py-2 font-mono">{fmt(row.realized_r,"R")}</td><td className="px-3 py-2"><div className="flex gap-1"><OpenButton label="Chart" icon={LineChart} onClick={(event)=>{ event?.stopPropagation(); onOpenChart(row); }} /><OpenButton label="Journal" onClick={(event)=>{ event?.stopPropagation(); onOpenTrade({ ...row, ticker: displayTicker(row.ticker) },"tradezella"); }} /><OpenButton label="Stonk" onClick={(event)=>{ event?.stopPropagation(); onOpenTrade({ ...row, ticker: displayTicker(row.ticker) },"stonk"); }} /></div></td></tr>)}</tbody></table></DataCard>; }

function OutcomeBadge({ value }: { value: string }) { const v=value.toUpperCase(); const tone=v==="WIN"?"bg-emerald-400/10 text-emerald-300":v==="LOSS"?"bg-rose-400/10 text-rose-300":v==="OPEN"?"bg-cyan-400/10 text-cyan-300":"bg-white/5 text-[#93a1b6]"; return <span className={cx("rounded px-2 py-1 font-mono text-[9px] font-bold",tone)}>{value}</span>; }
function OpenButton({ label, onClick, icon: Icon = ExternalLink }: { label: string; onClick: (event?: React.MouseEvent) => void; icon?: React.ComponentType<{ className?: string }> }) { return <button onClick={(event) => onClick(event)} className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[9px] text-[#b9c4d6] hover:border-violet-400/40 hover:text-violet-200">{label}<Icon className="size-2.5" /></button>; }
function Select({ label, value, options, onChange, formatOption = (option) => option }: { label: string; value: string; options: string[]; onChange: (value: string) => void; formatOption?: (option: string) => string }) { return <label className="block"><span className="mb-1 block text-[9px] font-semibold uppercase tracking-wider text-[#657187]">{label}</span><select aria-label={label} value={value} onChange={(event)=>onChange(event.target.value)} className="h-10 w-full rounded-md border border-white/10 bg-[#0b0f16] px-2 text-xs text-white outline-none focus:border-[#d9a441]/60">{[...new Set(options)].map((option)=><option key={option} value={option}>{formatOption(option)}</option>)}</select></label>; }
function MultiSelect({ label, values, options, onChange, formatOption = (option) => option, allLabel = "ALL", closeOnSelect = false, emptyMeansAll = true }: { label: string; values: string[]; options: string[]; onChange: (values: string[]) => void; formatOption?: (option: string) => string; allLabel?: string; closeOnSelect?: boolean; emptyMeansAll?: boolean }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const choices = [...new Set([...options, ...values])].sort();
  const everySelected = choices.length > 0 && choices.every((option) => values.includes(option));
  const summary = everySelected || (emptyMeansAll && values.length === 0) ? allLabel : values.length === 0 ? "None selected" : values.length === 1 ? formatOption(values[0]) : `${values.length} selected`;
  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDocClick); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const toggle = (option: string) => {
    onChange(values.includes(option) ? values.filter((value) => value !== option) : [...values, option]);
    if (closeOnSelect) setOpen(false);
  };
  return <div ref={boxRef} className="relative block">
    <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wider text-[#657187]">{label}</span>
    <button type="button" onClick={() => setOpen((value) => !value)} aria-haspopup="listbox" aria-expanded={open} className="flex h-10 w-full items-center rounded-md border border-white/10 bg-[#0b0f16] px-2 text-left text-xs text-white outline-none hover:border-[#d9a441]/40 focus-visible:border-[#d9a441]/60">
      <span className="truncate">{summary}</span><ChevronDown className={cx("ml-auto size-3.5 text-[#657187] transition", open && "rotate-180")} />
    </button>
    {open ? (
      <div className="absolute left-0 top-full z-30 mt-1 max-h-72 min-w-full overflow-y-auto rounded-md border border-violet-400/20 bg-[#0b0f16] p-1 shadow-2xl shadow-black/60">
        <div className="mb-1 flex items-center justify-between border-b border-white/10 px-2 py-1"><button type="button" onClick={() => { onChange([]); if (closeOnSelect) setOpen(false); }} className="text-[10px] text-[#7f8ca3] hover:text-white">{emptyMeansAll ? "Clear (= all)" : "Clear all"}</button><button type="button" onClick={() => { onChange([...options]); if (closeOnSelect) setOpen(false); }} className="text-[10px] text-[#7f8ca3] hover:text-white">Select all</button></div>
        {choices.map((option) => <label key={option} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-[#b9c4d6] hover:bg-violet-400/10 hover:text-white">
          <input type="checkbox" checked={values.includes(option)} onChange={() => toggle(option)} className="sr-only" />
          <span className={cx("grid size-4 place-items-center rounded border", values.includes(option) ? "border-[#d9a441] bg-[#d9a441]/25 text-[#f2c873]" : "border-white/20 bg-black/20 text-transparent")}><Check className="size-3" /></span>
          <span className="truncate">{formatOption(option)}</span>
        </label>)}
      </div>
    ) : null}
  </div>;
}
function DateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label className="block"><span className="mb-1 block text-[9px] font-semibold uppercase tracking-wider text-[#657187]">{label}</span><input aria-label={label} type="date" value={value} onChange={(event)=>onChange(event.target.value)} className="h-10 w-full rounded-md border border-white/10 bg-[#0b0f16] px-2 text-xs text-white outline-none focus:border-[#d9a441]/60" /></label>; }
function LoadingState() { return <div className="grid min-h-80 place-items-center rounded-xl border border-white/10 bg-[#101620]"><div className="text-center text-sm text-[#93a1b6]"><LoaderCircle className="mx-auto mb-3 size-8 animate-spin text-violet-300" />Loading realtime signals and orders…</div></div>; }
function ErrorState({ message, retry }: { message: string; retry: () => Promise<void> }) { return <div className="flex items-center gap-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] p-4 text-sm text-rose-200"><CircleAlert className="size-5 shrink-0" /><div><div className="font-semibold">Realtime analytics unavailable</div><div className="mt-1 text-xs text-rose-200/70">{message}</div></div><button onClick={()=>void retry()} className="ml-auto rounded-md border border-rose-300/20 px-3 py-2 text-xs">Retry</button></div>; }
