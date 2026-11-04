"use client";
import S01V3Smoke from "./s01-v3-smoke";
import BacktestPlayground from "./backtest-playground";

import {
  Activity,
  AlertTriangle,
  ArrowUpDown,
  BarChart3,
  CheckCircle2,
  Clock3,
  Database,
  Download,
  FlaskConical,
  LineChart,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  TrendingDown,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ICT_SESSION_IDS, ictSessionDisplayLabel } from "@/lib/ict-sessions";
import { downloadCsv } from "@/lib/download-csv";
import {
  ARCHIVED_STRATEGIES,
  STRATEGY_MARKETS,
  STRATEGY_STATUS_OPTIONS,
  liveStrategyIds,
  paperStrategyIds,
  shortStrategyLabel,
  strategyDeploymentBadge,
  strategyStatusLabel,
  type StrategyStatus,
} from "@/lib/strategy-status";
import { OrderChart } from "./order-chart";
import { MssLinkBar } from "./mss-link-bar";
import { SmtLinkBar } from "./smt-link-bar";
import { DailyForwardChart } from "./daily-forward-chart";
import { StrategyLink } from "./blog-context";

type DirectionStats = {
  trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  net_r: number;
  net_usd: number;
  avg_r: number;
  avg_win_r: number;
  avg_loss_r: number;
  largest_win_r: number;
  largest_loss_r: number;
};

type Summary = {
  sizing?: {
    mode?: "fixed_risk" | "fixed_qty";
    initial_capital?: number;
    risk_usd?: number;
    quantity?: number;
    commission_bps?: number;
    slippage_bps?: number;
  };
  initial_capital?: number;
  ending_capital?: number;
  net_profit_pct?: number;
  exposure_pct?: number;
  cagr?: number | null;
  annual_return_pct?: number;
  risk_adjusted_return_pct?: number | null;
  total: number;
  wins?: number;
  losses?: number;
  long_trades?: number;
  short_trades?: number;
  win_rate?: number;
  net_r?: number;
  net_usd?: number;
  gross_pnl_before_costs_usd?: number;
  transaction_costs_usd?: number;
  gross_profit_usd?: number;
  gross_loss_usd?: number;
  gross_profit_r?: number;
  gross_loss_r?: number;
  profit_factor?: number | null;
  expectancy_r?: number;
  expectancy_usd?: number;
  avg_win_r?: number;
  avg_loss_r?: number;
  payoff_ratio?: number | null;
  breakeven_win_rate_pct?: number | null;
  win_rate_edge_pct?: number | null;
  kelly_fraction_pct?: number | null;
  half_kelly_fraction_pct?: number | null;
  risk_of_ruin_pct?: number | null;
  risk_of_ruin_simple_pct?: number | null;
  risk_units?: number | null;
  largest_win_r?: number;
  largest_loss_r?: number;
  value_at_risk_r?: number;
  value_at_risk_usd?: number;
  best_win_usd?: number;
  worst_loss_usd?: number;
  max_consec_wins?: number;
  max_consec_losses?: number;
  max_trade_drawdown_r?: number;
  max_drawdown_r?: number;
  max_drawdown_usd?: number;
  max_drawdown_pct?: number;
  recovery_factor?: number | null;
  sharpe?: number | null;
  sortino?: number | null;
  calmar?: number | null;
  car_maxdd?: number | null;
  rar_maxdd?: number | null;
  ulcer_index?: number;
  k_ratio?: number | null;
  avg_hold_min?: number | null;
  risk_usd?: number;
  avg_quantity?: number | null;
  min_quantity?: number | null;
  max_quantity?: number | null;
  group_stats?: {
    all: DirectionStats;
    long: DirectionStats;
    short: DirectionStats;
  };
};

type EquityPoint = { i: number; t: number; r: number; balance: number; dd: number };
type MonthlyPoint = { month: string; net_r: number; trades: number; wins: number };
type StrategyOption = {
  strategy_id: string;
  strategy_name?: string | null;
  strategy_key?: string | null;
  n: number;
  markets?: string[] | null;
  target_nos?: number[] | null;
};
type TickerDistributionRow = { ticker: string; trades: number; percentage: number; win_rate: number; win_r: number; pnl_usd: number };
type BreakdownRow = {
  strategy_id: string;
  strategy_name?: string | null;
  trades: number;
  win_rate: number;
  net_r: number;
  expectancy_r: number;
  profit_factor: number | null;
  payoff_ratio?: number | null;
  breakeven_win_rate_pct?: number | null;
  win_rate_edge_pct?: number | null;
  kelly_fraction_pct?: number | null;
  risk_of_ruin_pct?: number | null;
};
type TradeRow = {
  /** SMT divergence vs the index / correlated peer at signal time. */
  smt_status?: string | null;
  smt_aligned?: boolean | null;
  smt_peer?: string | null;
  market?: string | null;
  /** ICT weekly profile: live = known at the signal, hindsight = what the week printed (label). */
  wp_live?: string | null;
  wp_live_aligned?: boolean | null;
  wp_hindsight?: string | null;
  wp_hindsight_aligned?: boolean | null;
  wp_day?: string | null;
  pipeline?: string | null;
  order_id: string;
  symbol: string;
  strategy_id: string | null;
  strategy_name?: string | null;
  direction: string | null;
  entry_datetime: string | null;
  filled_at: string | null;
  close_ts: string | null;
  entry: number | null;
  filled: number | null;
  stop: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  close_price: number | null;
  r: number;
  move_pct: number | null;
  planned_move_pct?: number | null;
  planned_risk_pct?: number | null;
  target_price?: number | null;
  target_ratio?: number | null;
  exit_type?: "TP" | "SL" | "TIME" | "OTHER";
  quantity: number | null;
  risk_usd: number | null;
  gross_pnl_usd: number | null;
  transaction_cost_usd: number | null;
  pnl_usd: number | null;
  outcome: "WIN" | "LOSS";
  hold_min: number | null;
  risk_probability: number | null;
  risk_bin: number | null;
  strategy_json_available: boolean;
  strategy_json_keys: string[];
};
type StrategyJsonTrade = {
  order_id: string;
  ticker: string;
  strategy_id: string;
  entry_datetime: string;
  pipeline?: string | null;
  strategy_json: unknown;
};
type ResearchStats = DirectionStats & {
  expectancy_usd: number;
  trade_sharpe: number | null;
  max_drawdown_usd: number;
  profit_factor: number | null;
};
type AttributionRow = ResearchStats & { label: string };
type HoldTimePerformanceRow = ResearchStats & {
  bucket_id: string;
  label: string;
  early: boolean;
  min_minutes: number;
  max_minutes: number | null;
  avg_hold_min: number | null;
  median_hold_min: number | null;
  trade_share_pct: number;
  loss_rate_pct: number | null;
  loss_concentration_pct: number | null;
  expectancy_r: number;
  max_drawdown_r: number;
};
type Research = {
  validation: {
    method: string;
    oos_pct: number;
    split_trade_index: number;
    split_timestamp: string | null;
    in_sample: ResearchStats;
    out_of_sample: ResearchStats;
    expectancy_degradation_pct: number | null;
  };
  monte_carlo: {
    method: string;
    simulations: number;
    seed: number;
    ending_equity_p05: number;
    ending_equity_p50: number;
    ending_equity_p95: number;
    max_drawdown_p50_usd: number;
    max_drawdown_p95_usd: number;
    probability_of_loss_pct: number;
    probability_of_20pct_drawdown_pct: number;
  };
  attribution: {
    by_year: AttributionRow[];
    by_session: AttributionRow[];
    by_direction: AttributionRow[];
    by_strategy: AttributionRow[];
    by_smt?: AttributionRow[];
    by_weekly_profile?: AttributionRow[];
    by_weekly_profile_hindsight?: AttributionRow[];
    by_weekday?: AttributionRow[];
  };
  hold_time_performance: HoldTimePerformanceRow[];
  data_quality: {
    status: "PASS" | "REVIEW";
    closed_trades: number;
    first_close_ts: string | null;
    last_close_ts: string | null;
    missing: Record<string, number>;
    warnings: string[];
  };
  audit: {
    calculation_version: string;
    generated_at: string;
    source: string;
    assumptions: string[];
  };
  deployment_gate: {
    status: "RESEARCH_PASSED_REVIEW_REQUIRED" | "NOT_READY";
    passed_checks: number;
    total_checks: number;
    checks: Array<{ id: string; label: string; passed: boolean }>;
    note: string;
  };
};
type BacktestResponse = {
  success: boolean;
  error?: string;
  filters?: { symbols: string[]; strategies: StrategyOption[]; years: string[] };
  summary?: Summary;
  equity?: EquityPoint[];
  monthly?: MonthlyPoint[];
  strategy_breakdown?: BreakdownRow[];
  ticker_distribution?: TickerDistributionRow[];
  research?: Research;
  strategy_profile?: {
    strategy_id: string;
    strategy_name: string;
    engine_version: string;
    cohort: string;
    sessions: number | string;
    attempts: number | string;
    fills: number | string;
    excluded_sessions: number | string;
    first_session: string;
    last_session: string;
    fully_resolved_fills: number | string;
    unresolved_fills: number | string;
    unresolved_legs: number | string;
    fully_resolved_net_r: number | string;
    closed_leg_net_r: number | string;
  };
  population_snapshot?: {
    metricVersion: string;
    identityName: string;
    identityDefinition: string;
    calculatedAt: string;
    sourceRowCount: number | string;
    uniqueSetups: number | string;
    fullyResolved: number | string;
    missedEntries: number | string;
    openOrders: number | string;
    status: string;
    sourceHash: string;
  };
  trades?: TradeRow[];
  total_trades?: number;
  smt_coverage?: { computed: number; total: number };
  weekly_profile_coverage?: { computed: number; total: number };
  returned?: number;
};

type ColumnKey = "entry_datetime" | "smt_status" | "wp_live" | "wp_hindsight" | "close_ts" | "symbol" | "strategy_id" | "strategy_name" | "direction" | "filled" | "stop" | "tp1" | "tp2" | "tp3" | "close_price" | "quantity" | "risk_usd" | "gross_pnl_usd" | "transaction_cost_usd" | "pnl_usd" | "r" | "move_pct" | "planned_move_pct" | "planned_risk_pct" | "target_ratio" | "hold_min" | "outcome" | "risk_probability" | "risk_bin" | "strategy_json_available" | "pipeline";
type Column = { key: ColumnKey; label: string; numeric?: boolean; defaultVisible: boolean; render: (trade: TradeRow) => string; tone?: (trade: TradeRow) => "green" | "red" | "muted" | "white" };

const BUILD_OPTIONS = ["ALL", "updated", "original"] as const;
const BUILD_LABELS: Record<string, string> = {
  ALL: "ALL - both builds",
  updated: "Structural stop (rebuilt)",
  original: "Percent floor (original)",
  ts01: "TS01", ts01v2: "TS01 V2", s10v3: "S10 V3",
};
// Exchange-local flatten times. The last hour is on the 5-minute grid because
// that is where the close-time decision actually lives.
const CLOSE_TIME_OPTIONS = [
  "NONE", "11:00", "12:00", "13:00", "14:00", "14:30",
  "15:00", "15:05", "15:10", "15:15", "15:20", "15:25",
  "15:30", "15:35", "15:40", "15:45", "15:50", "15:55",
];

// Target R:R filter presets as "min-max" (strict: > min and < max).
const TARGET_RR_OPTIONS = ["NONE", "0-100", "0.5-5", "1-5", "1.5-5", "2-5", "2-10", "3-100", "CUSTOM"];
// Move % filter presets as "min~max" in percent (strict: > min and < max).
// "~" is the separator because bounds can be negative.
const PLANNED_RISK_PCT_OPTIONS = ["NONE", "0.1~1000", "0.2~1000", "0.3~1000", "0.5~1000", "1~1000", "0~0.2", "CUSTOM"];
const PLANNED_MOVE_PCT_OPTIONS = ["NONE", "0~1000", "0.25~1000", "0.5~1000", "1~1000", "2~1000", "0~0.5", "0~1", "CUSTOM"];
const MOVE_PCT_OPTIONS = ["NONE", "0~1000", "-1000~0", "0.25~1000", "0.5~1000", "1~1000", "-1000~-0.5", "-1000~-1", "CUSTOM"];
function movePctLabel(value: string) {
  if (value === "NONE") return "None - all trades";
  if (value === "CUSTOM") return "Custom range";
  const [min, max] = value.split("~").map(Number);
  if (max >= 1000) return `> ${min.toFixed(2)}%`;
  if (min <= -1000) return `< ${max.toFixed(2)}%`;
  return `> ${min.toFixed(2)}% and < ${max.toFixed(2)}%`;
}
function targetRrLabel(value: string) {
  if (value === "NONE") return "None - all trades";
  if (value === "CUSTOM") return "Custom range";
  const [min, max] = value.split("-");
  return `> ${Number(min).toFixed(2)} and < ${Number(max).toFixed(2)}`;
}

const GREEN = "#2fbf71";
const RED = "#e5484d";
const MUTED = "#93a1b6";

const COLUMNS: Column[] = [
  { key: "entry_datetime", label: "Entry Date", defaultVisible: true, render: (t) => fmtDate(t.entry_datetime) },
  { key: "close_ts", label: "Exit Date", defaultVisible: true, render: (t) => fmtDate(t.close_ts) },
  { key: "symbol", label: "Ticker", defaultVisible: false, render: (t) => t.symbol },
  { key: "strategy_id", label: "Strategy", defaultVisible: true, render: (t) => t.strategy_id || "-" },
  { key: "strategy_name", label: "Name", defaultVisible: false, render: (t) => strategyDisplayName(t.strategy_id, t.strategy_name) },
  // Which engine produced the row. S15 and friends exist in two pipelines with
  // different stop models, so the desk needs to see which one a trade came from.
  { key: "pipeline", label: "Build", defaultVisible: false, render: (t) => BUILD_LABELS[t.pipeline ?? ""] ?? (t.pipeline || "-") },
  { key: "direction", label: "Dir", defaultVisible: true, render: (t) => t.direction || "-", tone: (t) => ((t.direction || "").toUpperCase() === "BUY" ? "green" : "red") },
  { key: "outcome", label: "Result", defaultVisible: true, render: (t) => t.outcome, tone: (t) => (t.outcome === "WIN" ? "green" : "red") },
  { key: "risk_bin", label: "Risk Bin", numeric: true, defaultVisible: true, render: (t) => (t.risk_bin === null || t.risk_bin === undefined ? "-" : `${t.risk_bin}/10`), tone: () => "muted" },
  { key: "risk_probability", label: "Risk Prob", numeric: true, defaultVisible: true, render: (t) => (t.risk_probability === null || t.risk_probability === undefined ? "-" : `${(t.risk_probability * 100).toFixed(1)}%`), tone: (t) => (t.risk_probability === null || t.risk_probability === undefined ? "muted" : t.risk_probability >= 0.55 ? "green" : t.risk_probability < 0.35 ? "red" : "muted") },
  { key: "filled", label: "Entry", numeric: true, defaultVisible: true, render: (t) => fmt(t.filled, priceDigits(t.symbol)) },
  { key: "stop", label: "Stop", numeric: true, defaultVisible: false, render: (t) => fmt(t.stop, priceDigits(t.symbol)) },
  { key: "tp1", label: "TP1", numeric: true, defaultVisible: false, render: (t) => fmt(t.tp1, priceDigits(t.symbol)) },
  { key: "tp2", label: "TP2", numeric: true, defaultVisible: false, render: (t) => fmt(t.tp2, priceDigits(t.symbol)) },
  { key: "tp3", label: "TP3", numeric: true, defaultVisible: false, render: (t) => fmt(t.tp3, priceDigits(t.symbol)) },
  { key: "smt_status", label: "SMT", defaultVisible: true, render: (t) => t.smt_status === "BULLISH_SMT" || t.smt_status === "BEARISH_SMT" ? `${t.smt_status === "BULLISH_SMT" ? "▲ Bull" : "▼ Bear"} · ${t.smt_aligned ? "with" : "against"}` : t.smt_status === "NO_SMT" ? "none" : t.smt_status === "NO_PEER_DATA" ? "no peer data" : t.smt_status ? "n/a" : "pending" },
  { key: "wp_live", label: "Weekly profile", defaultVisible: true, render: (t) => t.wp_live ? `${t.wp_day ? `${t.wp_day} · ` : ""}${t.wp_live}${t.wp_live_aligned === true ? " · with" : t.wp_live_aligned === false ? " · against" : ""}` : "pending" },
  { key: "wp_hindsight", label: "Week printed", defaultVisible: false, render: (t) => t.wp_hindsight ? `${t.wp_hindsight}${t.wp_hindsight_aligned === true ? " · with" : t.wp_hindsight_aligned === false ? " · against" : ""}` : t.wp_live ? "week not finished" : "pending" },
  { key: "close_price", label: "Exit", numeric: true, defaultVisible: true, render: (t) => fmt(t.close_price, priceDigits(t.symbol)) },
  { key: "quantity", label: "Qty", numeric: true, defaultVisible: false, render: (t) => fmt(t.quantity, 2) },
  { key: "risk_usd", label: "Risk $", numeric: true, defaultVisible: false, render: (t) => money(t.risk_usd) },
  { key: "gross_pnl_usd", label: "Gross $", numeric: true, defaultVisible: false, render: (t) => money(t.gross_pnl_usd), tone: (t) => ((t.gross_pnl_usd ?? 0) >= 0 ? "green" : "red") },
  { key: "transaction_cost_usd", label: "Costs $", numeric: true, defaultVisible: false, render: (t) => money(t.transaction_cost_usd), tone: () => "red" },
  { key: "pnl_usd", label: "Net P/L $", numeric: true, defaultVisible: true, render: (t) => money(t.pnl_usd), tone: (t) => ((t.pnl_usd ?? 0) >= 0 ? "green" : "red") },
  { key: "r", label: "R", numeric: true, defaultVisible: true, render: (t) => `${t.r >= 0 ? "+" : ""}${fmt(t.r)}`, tone: (t) => (t.r >= 0 ? "green" : "red") },
  // Plain-price view of R: signed % move from the fill to the exit
  // (+ = price moved the trade's way). Sorts numerically on the raw value.
  { key: "move_pct", label: "Actual Move %", numeric: true, defaultVisible: true, render: (t) => t.move_pct === null || t.move_pct === undefined ? "-" : `${t.move_pct >= 0 ? "+" : ""}${t.move_pct.toFixed(2)}%`, tone: (t) => (t.move_pct === null || t.move_pct === undefined ? "muted" : t.move_pct >= 0 ? "green" : "red") },
  { key: "planned_move_pct", label: "Planned Move %", numeric: true, defaultVisible: true, render: (t) => t.planned_move_pct === null || t.planned_move_pct === undefined ? "-" : `${t.planned_move_pct >= 0 ? "+" : ""}${t.planned_move_pct.toFixed(2)}%`, tone: (t) => (t.planned_move_pct === null || t.planned_move_pct === undefined ? "muted" : t.planned_move_pct >= 0 ? "green" : "red") },
  { key: "planned_risk_pct", label: "Planned Risk %", numeric: true, defaultVisible: true, render: (t) => t.planned_risk_pct === null || t.planned_risk_pct === undefined ? "-" : `${t.planned_risk_pct.toFixed(2)}%`, tone: () => "muted" },
  // Planned reward:risk of the Target selected above (1/2/3), from the fill:
  // BUY (target-entry)/(entry-stop), SELL (entry-target)/(stop-entry).
  { key: "target_ratio", label: "Target RR", numeric: true, defaultVisible: true, render: (t) => t.target_ratio === null || t.target_ratio === undefined ? "-" : t.target_ratio.toFixed(2), tone: (t) => (t.target_ratio === null || t.target_ratio === undefined ? "muted" : t.target_ratio > 0 ? "white" : "red") },
  { key: "hold_min", label: "Hold", numeric: true, defaultVisible: true, render: (t) => fmtHold(t.hold_min), tone: () => "muted" },
  { key: "strategy_json_available", label: "Strategy JSON", defaultVisible: true, render: (t) => t.strategy_json_available ? `View (${t.strategy_json_keys.length} keys)` : "Not recorded", tone: (t) => t.strategy_json_available ? "white" : "muted" },
];

const DEFAULT_COLUMNS = COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key);

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}
function fmt(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return Number(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// Price precision follows the instrument. Equities quote to 2dp, but FX majors
// quote to 5 and JPY crosses to 3 — rendering EURUSD at 2dp collapses an entire
// setup ("1.16") and makes a 2.8-pip stop indistinguishable from its target.
function isForexSymbol(symbol?: string | null) {
  const s = (symbol || "").toUpperCase();
  return s.startsWith("^") && /EUR|USD|GBP|JPY|CHF|AUD|NZD|CAD/.test(s);
}
function priceDigits(symbol?: string | null, market?: string | null) {
  const s = (symbol || "").toUpperCase();
  if (/XAU|XAG/.test(s)) return 2;                       // metals quote like equities
  if ((market || "").toLowerCase() === "forex" || isForexSymbol(s)) return /JPY/.test(s) ? 3 : 5;
  return 2;
}

function fmtInt(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function money(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
function pct(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return `${fmt(value, digits)}%`;
}
function fmtDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", { year: "2-digit", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
function fmtHold(minutes: number | null) {
  if (minutes === null || minutes === undefined) return "-";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}
function strategyDisplayName(strategyId?: string | null, strategyName?: string | null) {
  if (!strategyId) return "-";
  if (strategyId === "IG_Goldhunter_ICT2022_V3") return "Gold Hunter ICT 2022 V3";
  if (strategyId === "IG_Goldhunter_ICT2022_R2") return "Gold Hunter ICT 2022 V2";
  if (strategyId === "IG_Goldhunter_ICT2022") return "IG_Goldhunter_ICT2022 — ICT 2022 Goldhunter";
  if (strategyId === "S01-V3") return "S01 V3 — Daily HTF Bias (US backtest)";
  const statusName = STRATEGY_STATUS_DISPLAY_NAMES[strategyId];
  if (statusName) return statusName;
  if (strategyName) return strategyName;
  if (strategyId === "TS01-TB") return "ICT 2022 Mentorship (V1)";
  if (strategyId === "TS01-TB-V2") return "ICT 2022 Mentorship V2";
  if (strategyId === "S-ICT-COUNTER-TRADE") return "S-ICT COUNTER TRADE";
  if (strategyId.startsWith("S-CH")) return `S-CH ${strategyId.replace("S-CH", "")}`;
  if (strategyId.startsWith("S")) return `Strategy ${strategyId}`;
  if (strategyId.startsWith("A")) return `A-Series ${strategyId}`;
  return strategyId;
}
function toneClass(tone?: "green" | "red" | "muted" | "white") {
  if (tone === "green") return "text-[#62d894]";
  if (tone === "red") return "text-[#ff8b91]";
  if (tone === "muted") return "text-[#93a1b6]";
  return "text-white";
}

type Market = "ALL" | "US" | "INDIA" | "FOREX" | "INDICES";
const STRATEGY_STATUS_DISPLAY_NAMES: Record<string, string> = {
  S03: "ICT Breaker Block",
  "S-CH08": "Multi-TF FVG Hierarchy Retest",
  "S-CH10": "SMT Divergence Confirmation",
  S16: "HTF Bias Liquidity Sweep MSS OB/FVG Retest",
  "S03-SELL": "S03 SELL",
  A03: "Unfilled FVG + iFVG Confluence Scalp",
  "S-ICT-IPDA-PD-ARRAY-PREVIOUS-SWING-V4": "Strategy S-ICT-IPDA-PD-ARRAY-PREVIOUS-SWING-V4",
  // IGS series: forex 1m setups reproduced from reference charts. The id does
  // not start with S or A, so without an entry here strategyDisplayName falls
  // through and renders the raw slug.
  IGS01_LondonLiqGrab_IFVG: "London Killzone Liquidity Grab \u2192 IFVG",
  IGS01V2_LondonLiqGrab_SweepReversal:
    "London Killzone Sweep Reversal (V2, no IFVG)",
  IGS02_Manipulation_MSS_IFVG: "NY Manipulation \u2192 MSS \u2192 FVG",
};

// Every strategy in this tab has a backtest, so "Backtesting" lists all of them
// (live and paper ones included, tagged in the dropdown). Live / Paper /
// Archived narrow to the shared assignment in lib/strategy-status.ts. Every
// status is scoped to strategies that actually traded in the selected market.
function strategyIdsForStatus(status: StrategyStatus, market: Market, options: StrategyOption[]) {
  const key = market === "ALL" ? null : market.toLowerCase();
  const inMarket = options
    .filter((option) => key === null || !option.markets?.length || option.markets.includes(key))
    .map((option) => option.strategy_id);
  const known = key === null || (STRATEGY_MARKETS as string[]).includes(key);
  if (status === "LIVE") return known ? liveStrategyIds(key).filter((id) => inMarket.includes(id)) : [];
  if (status === "PAPER_TRADING") return known ? paperStrategyIds(key).filter((id) => inMarket.includes(id)) : [];
  if (status === "ARCHIVED") return inMarket.filter((id) => ARCHIVED_STRATEGIES.has(id));
  return inMarket.filter((id) => !ARCHIVED_STRATEGIES.has(id));
}

function targetOptionsForStrategies(strategyIds: string[], options: StrategyOption[]) {
  const selected = strategyIds.length
    ? options.filter((option) => strategyIds.includes(option.strategy_id))
    : options;
  const targetNos = new Set(selected.flatMap((option) => option.target_nos ?? []));
  return targetNos.size
    ? [...targetNos].sort((a, b) => a - b).map(String)
    : ["1", "2", "3"];
}

function validTargetForStrategies(current: string, strategyIds: string[], options: StrategyOption[]) {
  const available = targetOptionsForStrategies(strategyIds, options);
  return available.includes(current) ? current : available[0];
}

const MARKET_OPTIONS: { value: Market; label: string }[] = [
  { value: "ALL", label: "ALL - all markets" },
  { value: "US", label: "US Stocks" },
  { value: "INDIA", label: "Indian Stocks" },
  { value: "FOREX", label: "Forex" },
  { value: "INDICES", label: "Indices" },
];

function getSymbolMarket(symbol: string): Market {
  if (["NIFTY50", "BANKNIFTY"].includes(symbol.toUpperCase())) return "INDIA";
  if (symbol.startsWith("^")) {
    // ^ prefixed: if it contains a major currency code, treat as Forex, else Indices
    if (/EUR|USD|GBP|JPY|CHF|AUD|NZD|CAD/.test(symbol)) return "FOREX";
    return "INDICES";
  }
  if (symbol.endsWith(".NS") || symbol.endsWith(".BO") || /^NSE:|^BSE:/.test(symbol)) return "INDIA";
  return "US";
}

export default function BacktestDashboard() {
  const [showS16Forex, setShowS16Forex] = useState(false);
  const [market, setMarket] = useState<Market>("ALL");
  // Empty selections mean all tickers, matching the strategy multi-select.
  const [symbols, setSymbols] = useState<string[]>([]);
  // Default to the published Goldhunter 2022 replay.
  const [strategyStatus, setStrategyStatus] = useState<StrategyStatus>("BACKTESTING");
  // Default: Scalping_OB_OB_V4 + BPR_OB_V3 together (both no-repeat, 31 US tickers, 50% at +2R, 1 bp a side).
  const [strategies, setStrategies] = useState<string[]>(["Scalping_OB_OB_V4", "BPR_OB_V3"]);
  const [direction, setDirection] = useState("ALL");
  const [build, setBuild] = useState("ALL");
  const [closeTime, setCloseTime] = useState("NONE");
  const [targetNo, setTargetNo] = useState("1");
  // Keep the complete selection explicit so users can uncheck individual
  // overlapping windows from the default all-session view.
  const [ictSessions, setIctSessions] = useState<string[]>(() => [...ICT_SESSION_IDS]);
  // V3 covers all available stored US history from 2017.
  const [year, setYear] = useState("ALL");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [sizingMode, setSizingMode] = useState<"fixed_risk" | "fixed_qty">("fixed_risk");
  const [initialCapital, setInitialCapital] = useState("100000");
  const [riskUsd, setRiskUsd] = useState("100");
  const [quantity, setQuantity] = useState("100");
  // Goldhunter already includes adverse-tick entry/exit prices. Extra costs
  // start at zero; gross-R strategies reset to their own standard cost model.
  const [commissionBps, setCommissionBps] = useState("0");
  // 1 bp slippage per side (2 bp round trip) matches the cost used to research the default strategy (Scalping_OB_OB_V2).
  const [slippageBps, setSlippageBps] = useState("1");
  const [oosPct, setOosPct] = useState("30");
  const [targetRr, setTargetRr] = useState("NONE");
  const [rrMinCustom, setRrMinCustom] = useState("");
  const [rrMaxCustom, setRrMaxCustom] = useState("");
  const [rrMin, rrMax] = targetRr === "NONE" ? ["", ""] : targetRr === "CUSTOM" ? [rrMinCustom, rrMaxCustom] : targetRr.split("-");
  const [movePct, setMovePct] = useState("NONE");
  const [moveMinCustom, setMoveMinCustom] = useState("");
  const [moveMaxCustom, setMoveMaxCustom] = useState("");
  const [plannedMove, setPlannedMove] = useState("NONE");
  const [plannedMinCustom, setPlannedMinCustom] = useState("");
  const [plannedMaxCustom, setPlannedMaxCustom] = useState("");
  const [plannedRisk, setPlannedRisk] = useState("NONE");
  const [smtFilter, setSmtFilter] = useState("ALL");
  const [weeklyFilter, setWeeklyFilter] = useState("ALL");
  const [riskMinCustom, setRiskMinCustom] = useState("");
  const [riskMaxCustom, setRiskMaxCustom] = useState("");
  const [riskMin, riskMax] = plannedRisk === "NONE" ? ["", ""] : plannedRisk === "CUSTOM" ? [riskMinCustom, riskMaxCustom] : plannedRisk.split("~");
  const [plannedMin, plannedMax] = plannedMove === "NONE" ? ["", ""] : plannedMove === "CUSTOM" ? [plannedMinCustom, plannedMaxCustom] : plannedMove.split("~");
  const [moveMin, moveMax] = movePct === "NONE" ? ["", ""] : movePct === "CUSTOM" ? [moveMinCustom, moveMaxCustom] : movePct.split("~");
  const [data, setData] = useState<BacktestResponse | null>(null);
  const [filters, setFilters] = useState<NonNullable<BacktestResponse["filters"]> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sortKey, setSortKey] = useState<keyof TradeRow>("close_ts");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(DEFAULT_COLUMNS);
  const [selectedOrder, setSelectedOrder] = useState<TradeRow | null>(null);
  const [strategyJsonOrder, setStrategyJsonOrder] = useState<TradeRow | null>(null);
  const [strategyJsonTrade, setStrategyJsonTrade] = useState<StrategyJsonTrade | null>(null);
  const [strategyJsonLoading, setStrategyJsonLoading] = useState(false);
  const [strategyJsonError, setStrategyJsonError] = useState("");
  const [csvExporting, setCsvExporting] = useState(false);
  const [csvExportStatus, setCsvExportStatus] = useState("");
  const activeRequest = useRef<AbortController | null>(null);
  const strategyJsonRequest = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);

  const allSymbols = useMemo(() => filters?.symbols ?? data?.filters?.symbols ?? [], [filters, data]);
  const marketSymbols = useMemo(() => {
    if (market === "ALL") return allSymbols;
    return allSymbols.filter((s) => getSymbolMarket(s) === market);
  }, [allSymbols, market]);
  const symbol = useMemo(() => {
    if (symbols.length) return symbols.join(",");
    if (market === "ALL") return "ALL";
    return marketSymbols.length ? marketSymbols.join(",") : "NONE";
  }, [symbols, market, marketSymbols]);
  const allStrategyOptions = useMemo(() => filters?.strategies ?? data?.filters?.strategies ?? [], [filters, data]);
  const statusStrategyIds = useMemo(
    () => strategyIdsForStatus(strategyStatus, market, allStrategyOptions),
    [strategyStatus, market, allStrategyOptions],
  );
  const availableTargetNos = useMemo(
    () => targetOptionsForStrategies(strategies, allStrategyOptions),
    [strategies, allStrategyOptions],
  );
  function selectStrategies(next: string[]) {
    setStrategies(next);
    setTargetNo((current) => validTargetForStrategies(current, next, allStrategyOptions));
    if (market === "US" && next.length === 1 && next[0] === "S16") {
      setBuild("updated");
      setCloseTime("NONE");
    }
    if (next.length === 1 && ["Scalping_OB_OB_V2", "Scalping_OB_OB_V4", "BPR_OB_V3"].includes(next[0])) {
      // Gross-R engine researched at 2 bp round-trip cost (1 bp per side); single published run.
      setBuild("ALL");
      setCloseTime("NONE");
      setCommissionBps("0");
      setSlippageBps("1");
    }
    if (next.length === 1 && (next[0] === "S16-V2" || ["S01-V2","S01-V3"].includes(next[0]))) {
      // Gross-R engine: apply the standard cost model; its own run is the only build.
      setBuild("ALL");
      setCloseTime("NONE");
      setCommissionBps("1");
      setSlippageBps("2");
    }
    if (next.some((id) => id.startsWith("TS01-TB") || id.startsWith("IG_Goldhunter_ICT2022"))) {
      setMarket("ALL");
      setSymbols([]);
      setYear("ALL");
      setStartDate("");
      setEndDate("");
      // TS01 already persists the approved one-tick adverse entry and exit
      // prices. Keep the website baseline free of a second synthetic cost layer.
      setCommissionBps("0");
      setSlippageBps("0");
    } else if (next.length === 1 && next[0] === "IGS02_Manipulation_MSS_IFVG") {
      setMarket("FOREX");
      setSymbols([]);
      setBuild("updated");
      setCloseTime("NONE");
      setYear("ALL");
      setStartDate("");
      setEndDate("");
      // This one-trade reference result was costed at 3 bps per side.
      setCommissionBps("3");
      setSlippageBps("0");
    }
  }
  function setStrategy(value: string) {
    selectStrategies(value === "ALL" ? [] : [value]);
  }
  const strategy = useMemo(() => strategies.length ? strategies.join(",") : "NONE", [strategies]);
  const tickerSelectionLabel = symbols.length === 0
    ? `All tickers (${market === "ALL" ? "all markets" : MARKET_OPTIONS.find((item) => item.value === market)?.label ?? market})`
    : symbols.length === 1
      ? symbols[0]
      : `${symbols.length} tickers`;
  const serverTradeSort = sortKey === "entry_datetime" ? "entry_datetime" : "close_ts";
  const serverTradeOrder = sortKey === "entry_datetime" || sortKey === "close_ts" ? sortDir : "desc";
  const ictSessionParam = ictSessions.length === ICT_SESSION_IDS.length
    ? "ALL"
    : ictSessions.length
      ? ictSessions.join(",")
      : "NONE";
  const buildRequestParams = useCallback(() => new URLSearchParams({
    symbol,
    strategy_id: strategy,
    direction,
    build,
    close_time: closeTime,
    target_no: targetNo,
    year,
    start_date: startDate,
    end_date: endDate,
    trade_sort: serverTradeSort,
    trade_order: serverTradeOrder,
    ict_sessions: ictSessionParam,
    sizing_mode: sizingMode,
    initial_capital: initialCapital,
    risk_usd: riskUsd,
    quantity,
    commission_bps: commissionBps,
    slippage_bps: slippageBps,
    oos_pct: oosPct,
    rr_min: rrMin,
    rr_max: rrMax,
    move_min: moveMin,
    move_max: moveMax,
    planned_min: plannedMin,
    planned_max: plannedMax,
    risk_min: riskMin,
    risk_max: riskMax,
    smt: smtFilter,
    wp: weeklyFilter,
    include_filters: "false",
  }), [smtFilter, weeklyFilter, symbol, strategy, direction, build, closeTime, targetNo, year, startDate, endDate, serverTradeSort, serverTradeOrder, ictSessionParam, sizingMode, initialCapital, riskUsd, quantity, commissionBps, slippageBps, oosPct, rrMin, rrMax, moveMin, moveMax, plannedMin, plannedMax, riskMin, riskMax]);
  const load = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const requestId = ++requestSequence.current;
    const timeout = window.setTimeout(() => controller.abort(), 60_000);
    setLoading(true);
    setError("");
    const params = buildRequestParams();
    try {
      const response = await fetch(`/api/backtest?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = (await response.json()) as BacktestResponse;
      if (!response.ok || !payload.success) throw new Error(payload.error || "Backtest request failed");
      if (requestId !== requestSequence.current) return;
      setData(payload);
      setSelectedOrder(null);
      strategyJsonRequest.current?.abort();
      setStrategyJsonOrder(null);
      setStrategyJsonTrade(null);
      setStrategyJsonError("");
      setStrategyJsonLoading(false);
    } catch (err) {
      if (requestId !== requestSequence.current) return;
      setData(null);
      setError(controller.signal.aborted ? "Backtest request timed out. Please try again." : err instanceof Error ? err.message : "Backtest request failed");
    } finally {
      window.clearTimeout(timeout);
      if (requestId === requestSequence.current) {
        setLoading(false);
        activeRequest.current = null;
      }
    }
  }, [buildRequestParams]);

  // Results load ONLY when the user clicks Run. No request on mount and none
  // when a filter changes; this effect just aborts in-flight work on unmount.
  useEffect(() => {
    return () => {
      activeRequest.current?.abort();
      strategyJsonRequest.current?.abort();
    };
  }, []);

  // Metadata can involve broad historical scans.  It is intentionally loaded
  // outside the Run lifecycle so a dropdown refresh never holds the selected
  // backtest result hostage.
  const [filtersError, setFiltersError] = useState("");
  const [filtersAttempt, setFiltersAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/backtest?filters_only=true", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as BacktestResponse;
        if (!response.ok || !payload?.success || !payload.filters) throw new Error(payload?.error || `HTTP ${response.status}`);
        setFilters(payload.filters);
        setFiltersError("");
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setFiltersError(cause instanceof Error ? cause.message : "Strategy list failed to load");
      });
    return () => controller.abort();
  }, [filtersAttempt]);

  const summary = data?.summary;
  const trades = useMemo(() => data?.trades ?? [], [data]);
  const strategyNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of allStrategyOptions) map.set(item.strategy_id, strategyDisplayName(item.strategy_id, item.strategy_name || item.strategy_key));
    return map;
  }, [allStrategyOptions]);
  const strategySelectionLabel = statusStrategyIds.length === 0
    ? `No ${strategyStatusLabel(strategyStatus)} strategies assigned`
    : strategies.length === 0
      ? "No strategies selected"
      : strategies.length === statusStrategyIds.length
        ? `${strategyStatusLabel(strategyStatus)} strategies (${strategies.length})`
    : strategies.length === 1
      ? strategyNameById.get(strategies[0]) || strategies[0]
      : `${strategies.length} strategies`;
  const s16UsSelected = (market === "US" || market === "ALL") && strategies.length === 1 && strategies[0] === "S16";
  const canonicalS16 = s16UsSelected && build !== "original";
  const buildOptions = s16UsSelected ? ["updated", "original"] : [...BUILD_OPTIONS];
  const selectedBuild = s16UsSelected && build === "ALL" ? "updated" : build;
  const selectedColumns = COLUMNS.filter((column) => visibleColumns.includes(column.key));
  const sortedTrades = useMemo(() => {
    return [...trades].sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      // Keep missing values at the bottom in either direction and compare the
      // displayed date columns as timestamps rather than formatted strings.
      if (va === null || va === undefined || va === "") return vb === null || vb === undefined || vb === "" ? 0 : 1;
      if (vb === null || vb === undefined || vb === "") return -1;
      const cmp = sortKey === "entry_datetime" || sortKey === "close_ts"
        ? new Date(String(va)).getTime() - new Date(String(vb)).getTime()
        : typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" });
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [trades, sortDir, sortKey]);
  const netPositive = (summary?.net_r ?? 0) >= 0;

  async function exportTradeList() {
    setCsvExporting(true);
    setCsvExportStatus("");
    const params = buildRequestParams();
    params.set("format", "csv");
    params.set("columns", selectedColumns.map((column) => column.key).join(","));
    try {
      const count = await downloadCsv(`/api/backtest?${params}`, "backtest-trades.csv");
      setCsvExportStatus(`${count || data?.total_trades || 0} rows exported with full strategy_json`);
    } catch (cause) {
      setCsvExportStatus(cause instanceof Error ? cause.message : "CSV export failed");
    } finally {
      setCsvExporting(false);
    }
  }

  function toggleSort(key: keyof TradeRow) {
    if (sortKey === key) setSortDir((current) => (current === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function changeMarket(value: string) {
    const nextMarket = value as Market;
    const nextStrategies = strategyIdsForStatus(strategyStatus, nextMarket, allStrategyOptions);
    setMarket(nextMarket);
    setSymbols([]);
    setStrategies(nextStrategies);
    setTargetNo((current) => validTargetForStrategies(current, nextStrategies, allStrategyOptions));
    if (nextMarket === "US" && nextStrategies.length === 1 && nextStrategies[0] === "S16") {
      setBuild("updated");
      setCloseTime("NONE");
    }
  }

  function changeStrategyStatus(value: string) {
    const nextStatus = value as StrategyStatus;
    const nextStrategies = strategyIdsForStatus(nextStatus, market, allStrategyOptions);
    setStrategyStatus(nextStatus);
    setStrategies(nextStrategies);
    setTargetNo((current) => validTargetForStrategies(current, nextStrategies, allStrategyOptions));
    if (market === "US" && nextStrategies.length === 1 && nextStrategies[0] === "S16") {
      setBuild("updated");
      setCloseTime("NONE");
    }
  }

  async function inspectStrategyJson(trade: TradeRow) {
    strategyJsonRequest.current?.abort();
    setStrategyJsonOrder(trade);
    setStrategyJsonTrade(null);
    setStrategyJsonError("");
    if (!trade.strategy_json_available) {
      setStrategyJsonLoading(false);
      setStrategyJsonError("No strategy_json was persisted for this trade.");
      return;
    }
    const controller = new AbortController();
    strategyJsonRequest.current = controller;
    setStrategyJsonLoading(true);
    try {
      const response = await fetch(`/api/backtest/trade-context?order_id=${encodeURIComponent(trade.order_id)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await response.json() as { success?: boolean; error?: string; trade?: StrategyJsonTrade };
      if (!response.ok || !payload.success || !payload.trade) throw new Error(payload.error || "Strategy JSON request failed");
      if (strategyJsonRequest.current !== controller) return;
      setStrategyJsonTrade(payload.trade);
    } catch (error) {
      if (controller.signal.aborted || strategyJsonRequest.current !== controller) return;
      setStrategyJsonError(error instanceof Error ? error.message : "Strategy JSON request failed");
    } finally {
      if (strategyJsonRequest.current === controller) {
        strategyJsonRequest.current = null;
        setStrategyJsonLoading(false);
      }
    }
  }

  function selectTrade(trade: TradeRow) {
    setSelectedOrder(trade);
    void inspectStrategyJson(trade);
  }

  function clearSelectedTrade() {
    strategyJsonRequest.current?.abort();
    strategyJsonRequest.current = null;
    setSelectedOrder(null);
    setStrategyJsonOrder(null);
    setStrategyJsonTrade(null);
    setStrategyJsonError("");
    setStrategyJsonLoading(false);
  }

  function askTitaniaAboutTrade() {
    if (!strategyJsonTrade) return;
    const message = [
      "Analyze this backtest trade using its strategy_json.",
      `ticker=${strategyJsonTrade.ticker};`,
      `strategy=${strategyJsonTrade.strategy_id};`,
      `entry_datetime=${strategyJsonTrade.entry_datetime}.`,
      "Explain why it qualified, which checklist gates passed, and the key ICT evidence."
    ].join(" ");
    window.dispatchEvent(new CustomEvent("titania:prefill", { detail: { message } }));
  }

  if (showS16Forex) {
    return <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#d9a441]/30 bg-[#101620] p-4">
        <div><h2 className="text-lg font-semibold">S16 Forex · all-history analysis</h2><p className="text-xs text-[#93a1b6]">Audited forex replay · sources separated · original T1 / T2 / T3 · frozen October 20 snapshot</p></div>
        <button type="button" onClick={() => setShowS16Forex(false)} className="rounded border border-white/20 px-3 py-2 text-sm">Back to standard Backtest</button>
      </div>
      <iframe title="S16 Forex complete backtest analysis" src="/reports/s16-forex-20261020/index.html" className="h-[85vh] w-full rounded-md border border-white/10" />
    </section>;
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#d9a441]/30 bg-[#101620] p-4">
        <div><h2 className="font-semibold text-[#f2c873]">S16 Forex · diagnostic baseline</h2><p className="mt-1 text-xs text-[#93a1b6]">FX model not validated: equity-scale buffer, missing reclaim gate and calendar-clock limitations. 1,412 currency-pair signals · source-isolated T1 / T2 / T3 evidence and independent review.</p></div>
        <div className="flex gap-3 text-sm"><button type="button" onClick={() => setShowS16Forex(true)} className="rounded border border-[#d9a441]/40 px-3 py-2 text-[#f2c873]">Open S16 Forex analysis</button><a href="/reports/s16-forex-20261020/index.html" target="_blank" rel="noreferrer" className="self-center text-[#93a1b6] underline">Open artifact</a></div>
      </div>
      <div className="rounded-md border border-white/10 bg-[#101620] p-3">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
          <Selector label="Market" value={market} onChange={changeMarket} options={MARKET_OPTIONS.map((m) => m.value)} labelMap={(value) => MARKET_OPTIONS.find((m) => m.value === value)?.label ?? value} />
          <MultiSelector
            label="Ticker"
            values={symbols}
            onChange={setSymbols}
            options={marketSymbols}
            allLabel={`ALL - ${market === "ALL" ? "all tickers" : MARKET_OPTIONS.find((item) => item.value === market)?.label ?? market}`}
            emptyMessage="Loading tickers…"
          />
          <Selector
            label="Strategy Status"
            value={strategyStatus}
            onChange={changeStrategyStatus}
            options={STRATEGY_STATUS_OPTIONS.map((option) => option.value)}
            labelMap={(value) => strategyStatusLabel(value as StrategyStatus)}
          />
          <MultiSelector
            label="Strategy"
            values={strategies}
            onChange={selectStrategies}
            options={statusStrategyIds}
            labelMap={(value) => {
              if (value === "IG_Goldhunter_ICT2022_V3") return "Gold Hunter ICT 2022 V3";
              if (value === "IG_Goldhunter_ICT2022_R2") return "Gold Hunter ICT 2022 V2";
              const badge = strategyStatus === "BACKTESTING" ? strategyDeploymentBadge(value, market === "ALL" ? null : market) : "";
              const id = value === "IGS02_Manipulation_MSS_IFVG"
                ? value
                : shortStrategyLabel(value).split(" · ")[0];
              return `${id} - ${strategyNameById.get(value) || value}${badge ? ` · ${badge}` : ""}`;
            }}
            allLabel={`ALL - ${strategyStatusLabel(strategyStatus)} strategies`}
            closeOnSelect
            emptyMeansAll={false}
            emptyMessage={filtersError
              ? `Strategy list failed to load: ${filtersError}`
              : !filters
                ? "Loading strategies…"
                : `No ${strategyStatusLabel(strategyStatus)} strategies in ${MARKET_OPTIONS.find((item) => item.value === market)?.label ?? market}`}
          />
          <Selector label="Direction" value={direction} onChange={setDirection} options={["ALL", "BUY", "SELL"]} />
          <Selector
            label="Build"
            value={selectedBuild}
            onChange={setBuild}
            options={buildOptions}
            labelMap={(value) => s16UsSelected
              ? value === "updated" ? "Canonical structural (updated)" : "Legacy original (comparison)"
              : BUILD_LABELS[value] ?? value}
          />
          <Selector
            label="Close trades at"
            value={closeTime}
            onChange={setCloseTime}
            options={CLOSE_TIME_OPTIONS}
            labelMap={(value) => value === "NONE" ? "NONE - run to stop/target" : `${value} exchange-local`}
          />
          <MultiSelector
            label="ICT Entry Sessions"
            values={ictSessions}
            onChange={setIctSessions}
            options={[...ICT_SESSION_IDS]}
            labelMap={ictSessionDisplayLabel}
            allLabel="ALL - all ICT sessions"
            emptyMeansAll={false}
            emptyMessage="No ICT sessions configured"
          />
          <Selector label="Target" value={targetNo} onChange={setTargetNo} options={availableTargetNos} labelMap={(value) => `Target ${value}`} />
          <Selector label="Target R:R" value={targetRr} onChange={setTargetRr} options={TARGET_RR_OPTIONS} labelMap={targetRrLabel} />
          {targetRr === "CUSTOM" ? <>
            <MoneyField label="R:R greater than" value={rrMinCustom} onChange={setRrMinCustom} />
            <MoneyField label="R:R less than" value={rrMaxCustom} onChange={setRrMaxCustom} />
          </> : null}
          <Selector label="Actual Move %" value={movePct} onChange={setMovePct} options={MOVE_PCT_OPTIONS} labelMap={movePctLabel} />
          {movePct === "CUSTOM" ? <>
            <MoneyField label="Actual Move % greater than" value={moveMinCustom} onChange={setMoveMinCustom} />
            <MoneyField label="Actual Move % less than" value={moveMaxCustom} onChange={setMoveMaxCustom} />
          </> : null}
          <Selector label="Planned Move %" value={plannedMove} onChange={setPlannedMove} options={PLANNED_MOVE_PCT_OPTIONS} labelMap={movePctLabel} />
          {plannedMove === "CUSTOM" ? <>
            <MoneyField label="Planned Move % greater than" value={plannedMinCustom} onChange={setPlannedMinCustom} />
            <MoneyField label="Planned Move % less than" value={plannedMaxCustom} onChange={setPlannedMaxCustom} />
          </> : null}
          <Selector label="Planned Risk %" value={plannedRisk} onChange={setPlannedRisk} options={PLANNED_RISK_PCT_OPTIONS} labelMap={movePctLabel} />
          {plannedRisk === "CUSTOM" ? <>
            <MoneyField label="Planned Risk % greater than" value={riskMinCustom} onChange={setRiskMinCustom} />
            <MoneyField label="Planned Risk % less than" value={riskMaxCustom} onChange={setRiskMaxCustom} />
          </> : null}
          <Selector label="SMT divergence" value={smtFilter} onChange={setSmtFilter} options={["ALL", "ALIGNED", "OPPOSED", "ANY", "NONE"]} labelMap={(value) => ({ ALL: "ALL - with or without SMT", ALIGNED: "SMT with the trade", OPPOSED: "SMT against the trade", ANY: "Any SMT at signal", NONE: "No SMT at signal" } as Record<string, string>)[value] ?? value} />
          <Selector label="Weekly profile" value={weeklyFilter} onChange={setWeeklyFilter} options={["ALL", "ALIGNED", "OPPOSED", "ANY", "NONE", "AVOID_SD", "CLASSIC_TUE", "WED", "WED_REVERSAL", "CONSOL_THU", "MIDWEEK", "SEEK_DESTROY"]} labelMap={(value) => ({ ALL: "ALL - any week", ALIGNED: "Profile with the trade", OPPOSED: "Profile against the trade", ANY: "Any named profile", NONE: "No profile at signal", AVOID_SD: "Exclude Seek & Destroy", CLASSIC_TUE: "Classic Tuesday high/low", WED: "Wednesday high/low", WED_REVERSAL: "Wednesday weekly reversal", CONSOL_THU: "Consolidation Thursday reversal", MIDWEEK: "Consolidation midweek rally/decline", SEEK_DESTROY: "Seek & Destroy Friday (bull/bear)" } as Record<string, string>)[value] ?? value} />
          <Selector label="Year" value={year} onChange={setYear} options={["ALL", ...(filters?.years ?? data?.filters?.years ?? [])]} />
          <DateField label="Start date" value={startDate} onChange={setStartDate} />
          <DateField label="End date" value={endDate} onChange={setEndDate} />
          <Selector label="Sizing" value={sizingMode} onChange={(value) => setSizingMode(value === "fixed_qty" ? "fixed_qty" : "fixed_risk")} options={["fixed_risk", "fixed_qty"]} labelMap={(value) => value === "fixed_qty" ? "Fixed quantity" : "Fixed risk"} />
          <MoneyField label="Initial capital" value={initialCapital} onChange={setInitialCapital} />
          {sizingMode === "fixed_qty" ? (
            <MoneyField label="Quantity" value={quantity} onChange={setQuantity} />
          ) : (
            <MoneyField label="Risk $/trade" value={riskUsd} onChange={setRiskUsd} />
          )}
          <MoneyField label="Commission bps" value={commissionBps} onChange={setCommissionBps} />
          <MoneyField label="Slippage bps" value={slippageBps} onChange={setSlippageBps} />
          <MoneyField label="OOS holdout %" value={oosPct} onChange={setOosPct} />
          <button
            onClick={() => void load()}
            disabled={loading}
            className="flex h-10 items-center justify-center gap-2 self-end rounded-md bg-[#d9a441] px-4 text-sm font-semibold text-[#151109] transition hover:bg-[#edbf5e] xl:col-span-8"
          >
            <RefreshCw className={cx("size-4", loading && "animate-spin")} />
            Run
          </button>
          {filtersError ? (
            <div className="flex items-center gap-3 rounded-md border border-rose-400/20 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-200 xl:col-span-8">
              Strategy and ticker lists failed to load ({filtersError}).
              <button type="button" onClick={() => { setFiltersError(""); setFiltersAttempt((value) => value + 1); }} className="ml-auto rounded border border-rose-300/30 px-2 py-1">Retry</button>
            </div>
          ) : null}
        </div>
        <div className="mt-2 font-mono text-[11px] text-[#93a1b6]">
          {tickerSelectionLabel} | {strategyStatusLabel(strategyStatus)} status · {strategySelectionLabel} - {data?.total_trades ?? 0} {canonicalS16 ? `proper Target ${targetNo} outcomes` : "closed trades"}. {sizingMode === "fixed_qty" ? `Sizing: ${fmt(Number(quantity), 0)} units from ${money(Number(initialCapital))} capital.` : `Sizing: ${money(Number(riskUsd))} risk per trade from ${money(Number(initialCapital))} capital.`} Net results include {fmt(Number(commissionBps), 1)} bps commission + {fmt(Number(slippageBps), 1)} bps slippage per side.
        </div>
        {strategies.length === 1 ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="text-[#7f8ca3]">Strategy reference:</span>
            <StrategyLink code={strategies[0]} label={`${strategies[0]} — ${strategyNameById.get(strategies[0]) || "read strategy blog"}`} className="rounded border border-[#d9a441]/30 bg-[#d9a441]/10 px-2 py-1 font-semibold text-[#f2c873]" showIcon />
            <span className="text-[#657187]">Click any strategy code in the tables below to open its blog.</span>
          </div>
        ) : null}
        {canonicalS16 && data?.population_snapshot ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/10 pt-3 text-[11px] text-[#aab5c7]">
            <ShieldCheck className="size-4 text-emerald-400" />
            <span className="font-semibold text-white">Audited S16 US population</span>
            <span>{fmtInt(Number(data.population_snapshot.sourceRowCount))} source rows</span>
            <span className="text-[#657187]">→</span>
            <span>{fmtInt(Number(data.population_snapshot.uniqueSetups))} unique structural setups</span>
            <span>{fmtInt(Number(data.population_snapshot.fullyResolved))} fully resolved</span>
            <span>{fmtInt(Number(data.population_snapshot.missedEntries))} missed</span>
            <span>{fmtInt(Number(data.population_snapshot.openOrders))} open</span>
            <span className="text-cyan-300">Target {targetNo}: {fmtInt(data?.total_trades ?? 0)} proper evaluable</span>
          </div>
        ) : null}
      </div>

      {strategies.includes("IG_Goldhunter_ICT2022_V3") ? <div className="mb-3 rounded border border-emerald-400/20 bg-emerald-400/5 p-3 text-xs text-[#c9d4e1]"><strong className="text-emerald-300">Gold Hunter ICT 2022 V3</strong> · Planned price move to nearest T1 ≥0.7% · Minimum T1 net room 0.786R · Three distinct fresh opposing liquidity targets · Independent full-position exits per target · Fresh sweep/reclaim → MSS → displacement-leg FVG → later limit fill · Entries 09:30–session close New York · 5-minute close-confirmed stop, exit next eligible bar open · Target touch · No EOD exit · Duplicate economic orders removed. Stored 31-symbol US universe from 2017 through available 2026 data; most stocks end June 3, QQQ August 12, SPY October 20. $0.01/share per side included; controls add costs. Historical research, including previously inspected 2026 data. <a href="/reports/goldhunter-v3/index.html" target="_blank" rel="noreferrer" className="ml-2 text-emerald-300 underline">Coverage, rules and annual results</a></div> : null}
      {strategies.includes("IG_Goldhunter_ICT2022_R2") ? <div className="mb-3 rounded border border-sky-400/20 bg-sky-400/5 p-3 text-xs text-[#c9d4e1]">Gold Hunter ICT 2022 V2 · 53 original fills · T1/T2/T3 are the nearest three distinct, fresh opposing liquidity pools known at activation · Select Target 1, 2 or 3 above for independent full-position exit results; these are not partial scale-outs · Entries 09:30–16:00 New York · Fresh MSS followed by an FVG in the displacement leg · Sweep with reclaim · Minimum net target room 0.786R · 5-minute close-confirmed stop, exit next bar open · Target touch · No EOD exit. Baseline costs of $0.01/share per side are included; controls add costs. Frozen research run includes two duplicate economic orders identified in review. The chronological split below is retrospective, not an untouched holdout. Stock coverage ends June 3, 2026; no later ETF fills. <a href="/reports/goldhunter-v2-strength/index.html" target="_blank" rel="noreferrer" className="ml-2 underline text-sky-300">Review every trade · Strength 1–5 and candle replay</a></div> : null}
      {strategies.includes("IG_Goldhunter_ICT2022") ? <div className="mb-3 rounded border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-[#c9d4e1]">Goldhunter 2022 · 95 filled trades · one opposing-liquidity target · original EOD exit model. Most stocks end June 3, 2026; QQQ extends to August 12 and SPY to October 19. Modeled adverse ticks are already included; costs above are additional. Target hit and positive-return rates differ because EOD exits can be profitable.</div> : null}
      {strategies.includes("S01-V3") ? <S01V3Smoke key={year} year={year} /> : null}
      {strategies.length === 1 && strategies[0].startsWith("TS01-TB")
        ? <Ts01BaselineCard profile={data?.strategy_profile} targetNo={targetNo} />
        : null}

      {/* IGS01V2 used to render its specification and a separate 2017-2025
          summary inline here.  Both are gone: the rules now live in the
          strategy blog, reached through the "Strategy reference" link above
          like every other strategy, and the 2017-2026 population is in the
          dashboard's own tables below since it was republished to the updated
          pipeline.  This tab shows results; the blog explains them. */}

      {error ? <div className="rounded-md border border-[#e5484d]/30 bg-[#e5484d]/10 p-4 text-sm text-[#ff9da2]">Error: {error}</div> : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        <Kpi label="Net Profit" value={`${fmt(summary?.net_r)}R`} tone={netPositive ? "green" : "red"} big />
        <Kpi label="Net P/L" value={money(summary?.net_usd)} tone={netPositive ? "green" : "red"} />
        <Kpi label="Win Rate" value={pct(summary?.win_rate)} />
        <Kpi label="Profit Factor" value={fmt(summary?.profit_factor)} tone={(summary?.profit_factor ?? 0) >= 1 ? "green" : "red"} />
        <Kpi label="Max Drawdown" value={`${fmt(summary?.max_drawdown_r)}R`} tone="red" />
        <Kpi label="Capital" value={money(summary?.initial_capital)} />
        <Kpi label="Cost Drag" value={money(summary?.transaction_costs_usd)} tone="red" />
        <Kpi label={canonicalS16 ? "Proper setups" : "Trades"} value={fmtInt(summary?.total)} />
      </div>

      <PerformanceMatrix summary={summary} />

      <ResearchLab research={data?.research} />

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Panel icon={Activity} title="Equity and Drawdown" note="TradingView-style overview">
          <EquityDrawdownChart points={data?.equity ?? []} />
        </Panel>
        <Panel icon={BarChart3} title="Statistics" note="All / Long / Short">
          <DirectionStatsTable summary={summary} />
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Panel icon={TrendingUp} title="Monthly Performance" note="R by month">
          <MonthlyBars monthly={data?.monthly ?? []} />
          <MonthlyHeatmap monthly={data?.monthly ?? []} />
        </Panel>
        <Panel icon={LineChart} title="Strategy Breakdown" note={`${data?.strategy_breakdown?.length ?? 0} rows`}>
          <BreakdownTable rows={data?.strategy_breakdown ?? []} onPick={setStrategy} />
        </Panel>
      </div>

      <Panel icon={BarChart3} title="Trade Distribution by Ticker" note={`${data?.ticker_distribution?.length ?? 0} tickers · percentage of ${canonicalS16 ? "evaluable outcomes" : "closed trades"}`}>
        <TickerDistribution rows={data?.ticker_distribution ?? []} selected={symbols} onPick={(ticker) => setSymbols([ticker])} />
      </Panel>

      <Panel icon={BarChart3} title="Trade List" note={`${trades.length} shown${data && data.total_trades && data.total_trades > trades.length ? ` of ${data.total_trades}` : ""} · select a row to load chart + JSON`}>
        <ColumnChooser visibleColumns={visibleColumns} onChange={setVisibleColumns} onExport={() => void exportTradeList()} exporting={csvExporting} exportStatus={csvExportStatus} />
        <div className="max-h-[560px] overflow-auto">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="sticky top-0 z-10 border-b border-white/10 bg-[#0b0f16] text-[11px] uppercase text-[#7f8ca3]">
              <tr>
                {selectedColumns.map((column) => (
                  <SortTh key={column.key} label={column.label} k={column.key} sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} num={column.numeric} />
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10 font-mono">
              {!loading && sortedTrades.length === 0 ? (
                <tr>
                  <td colSpan={Math.max(selectedColumns.length, 1)} className="px-4 py-8 text-center text-[#93a1b6]">No trades for this selection.</td>
                </tr>
              ) : null}
              {sortedTrades.map((trade) => (
                <tr
                  key={trade.order_id}
                  onClick={() => selectTrade(trade)}
                  className={cx("cursor-pointer transition hover:bg-white/[0.03]", selectedOrder?.order_id === trade.order_id && "bg-[#d9a441]/10")}
                >
                  {selectedColumns.map((column) => (
                    <TradeCell key={column.key} column={column} trade={trade} onSelectTrade={selectTrade} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Panel icon={BarChart3} title="Order Chart" note={selectedOrder ? `${selectedOrder.symbol} · ${selectedOrder.strategy_id} · ${fmtDate(selectedOrder.entry_datetime)}` : "select a trade"}>
          {selectedOrder ? <><div className="border-b border-white/10 px-3 py-2"><MssLinkBar trade={{ symbol: selectedOrder.symbol, direction: selectedOrder.direction, entryTs: selectedOrder.filled_at ?? selectedOrder.entry_datetime }} /><div className="mt-2"><SmtLinkBar trade={{ symbol: selectedOrder.symbol, market: selectedOrder.market, direction: selectedOrder.direction, entryTs: selectedOrder.entry_datetime ?? selectedOrder.filled_at }} smtText={selectedOrder.smt_status === "BULLISH_SMT" || selectedOrder.smt_status === "BEARISH_SMT" ? `${selectedOrder.smt_status === "BULLISH_SMT" ? "bullish" : "bearish"} SMT ${selectedOrder.smt_aligned ? "with" : "against"} the trade` : selectedOrder.smt_status === "NO_SMT" ? "no SMT at signal" : selectedOrder.smt_status ? "no peer data" : "pending"} weeklyText={selectedOrder.wp_live ? `${selectedOrder.wp_live}${selectedOrder.wp_live_aligned === true ? " · supports the trade" : selectedOrder.wp_live_aligned === false ? " · against the trade" : ""}` : "pending"} /></div></div><OrderChart order={{ order_id: selectedOrder.order_id, symbol: selectedOrder.symbol, strategy_id: selectedOrder.strategy_id, direction: selectedOrder.direction, r: selectedOrder.r }} targetNo={targetNo} endpoint="/api/backtest/order-chart" onClose={clearSelectedTrade} /></> : <div className="grid h-[520px] place-items-center px-6 text-center text-sm text-[#93a1b6]">Select a Trade List row to load its chart and persisted strategy_json together.</div>}
        </Panel>

        <Panel icon={LineChart} title="HTF ICT · Daily / 1H / 30m / 15m · ±20 / 40 / 60 bars" note={selectedOrder ? `${selectedOrder.symbol} · ${selectedOrder.direction ?? ""} · fill ${selectedOrder.filled ?? selectedOrder.entry ?? "-"}` : "select a trade"}>
          {selectedOrder ? (
            <DailyForwardChart
              key={selectedOrder.order_id}
              trade={{
                symbol: selectedOrder.symbol,
                direction: selectedOrder.direction,
                entryTs: selectedOrder.filled_at ?? selectedOrder.entry_datetime,
                fill: selectedOrder.filled ?? selectedOrder.entry,
                stop: selectedOrder.stop,
                target: selectedOrder.target_price ?? selectedOrder.tp1,
                orderId: selectedOrder.order_id,
                strategyId: selectedOrder.strategy_id,
              }}
            />
          ) : <div className="grid h-[520px] place-items-center px-6 text-center text-sm text-[#93a1b6]">Select a Trade List row to see the daily chart after entry.</div>}
        </Panel>
      </div>

      {selectedOrder ? <BacktestPlayground key={selectedOrder.order_id} trade={{orderId:selectedOrder.order_id,symbol:selectedOrder.symbol,strategyId:selectedOrder.strategy_id,direction:selectedOrder.direction,entryTs:selectedOrder.filled_at ?? selectedOrder.entry_datetime,entry:selectedOrder.filled ?? selectedOrder.entry,stop:selectedOrder.stop,targetNo, target:selectedOrder.target_price ?? selectedOrder.tp1}} /> : null}

        <Panel icon={Database} title="Strategy JSON Evidence" note={strategyJsonOrder ? `${strategyJsonOrder.symbol} · ${strategyJsonOrder.strategy_id || "Unknown strategy"}` : "select a trade"}>
          <div className="flex h-[460px] min-h-0 flex-col p-3">
            {strategyJsonOrder ? (
              <div className="mb-3 rounded-lg border border-[#64d2ff]/20 bg-[#64d2ff]/5 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#64d2ff]">Exact trade identity</div>
                <div className="mt-1 break-all font-mono text-xs text-[#d6deec]">
                  ticker={strategyJsonOrder.symbol} · strategy={strategyJsonOrder.strategy_id || "unknown"} · entry_datetime={strategyJsonOrder.entry_datetime || "unknown"}
                </div>
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-white/10 bg-[#080b10] p-4">
              {!strategyJsonOrder ? <div className="grid h-full place-items-center px-6 text-center text-sm text-[#93a1b6]">The selected trade’s persisted qualification evidence will appear here and can be scrolled independently of the chart.</div> : null}
              {strategyJsonLoading ? <div className="text-sm text-[#93a1b6]">Loading persisted strategy_json…</div> : null}
              {strategyJsonError ? <div className="rounded border border-[#e5484d]/30 bg-[#e5484d]/10 p-3 text-sm text-[#ff8b91]">{strategyJsonError}</div> : null}
              {strategyJsonTrade ? <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-[#d6deec]">{JSON.stringify(strategyJsonTrade.strategy_json, null, 2)}</pre> : null}
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-xs text-[#7f8ca3]">Compare each persisted gate and price level directly with the chart.</span>
              <button type="button" disabled={!strategyJsonTrade} onClick={askTitaniaAboutTrade} className="shrink-0 rounded-md bg-[#d9a441] px-3 py-2 text-xs font-semibold text-[#0b0f16] disabled:cursor-not-allowed disabled:opacity-40">Ask Titania</button>
            </div>
          </div>
        </Panel>
    </section>
  );
}

function Selector({ label, value, onChange, options, labelMap }: { label: string; value: string; onChange: (value: string) => void; options: string[]; labelMap?: (value: string) => string }) {
  return (
    <div>
      <span className="mb-1.5 block text-[11px] font-semibold uppercase text-[#7f8ca3]">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full rounded-md border border-white/10 bg-[#0b0f16] px-3 text-sm text-white outline-none">
        {options.map((option) => <option key={option} value={option}>{labelMap ? labelMap(option) : option}</option>)}
      </select>
    </div>
  );
}

/**
 * Checkbox dropdown for selecting several strategies at once.
 * An empty selection means "all strategies" - the same thing the old single
 * Selector meant by "ALL", so the API contract does not change.
 */
function MultiSelector({ label, values, onChange, options, labelMap, allLabel = "ALL", closeOnSelect = false, emptyMeansAll = true, emptyMessage = "Loading options…" }: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  options: string[];
  labelMap?: (value: string) => string;
  allLabel?: string;
  closeOnSelect?: boolean;
  emptyMeansAll?: boolean;
  emptyMessage?: string;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle(option: string) {
    onChange(values.includes(option) ? values.filter((v) => v !== option) : [...values, option]);
    if (closeOnSelect) setOpen(false);
  }

  const everyOptionSelected = options.length > 0 && values.length === options.length;
  const summary = (emptyMeansAll && values.length === 0) || everyOptionSelected
    ? allLabel
    : values.length === 0
      ? "None selected"
    : values.length === 1
      ? (labelMap ? labelMap(values[0]) : values[0])
      : `${values.length} selected`;

  return (
    <div ref={boxRef} className="relative">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase text-[#7f8ca3]">{label}</span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-md border border-white/10 bg-[#0b0f16] px-3 text-left text-sm text-white outline-none focus:border-[#d9a441]/70"
      >
        <span className="truncate">{summary}</span>
        <span className="shrink-0 text-[10px] text-[#7f8ca3]">{open ? "▲" : "▼"}</span>
      </button>
      {open ? (
        <div
          role="listbox"
          className="absolute z-30 mt-1 max-h-72 w-full min-w-[260px] overflow-auto rounded-md border border-white/10 bg-[#101620] p-1 shadow-xl shadow-black/50"
        >
          <div className="flex items-center justify-between gap-2 border-b border-white/10 px-2 py-1.5">
            <button type="button" onClick={() => { onChange([]); if (closeOnSelect) setOpen(false); }} className="text-[11px] font-semibold uppercase text-[#7f8ca3] hover:text-white">
              {emptyMeansAll ? "Clear (= all)" : "Clear all"}
            </button>
            <button type="button" onClick={() => { onChange([...options]); if (closeOnSelect) setOpen(false); }} className="text-[11px] font-semibold uppercase text-[#7f8ca3] hover:text-white">
              Select all
            </button>
          </div>
          {options.length === 0 ? (
            <p className="px-2 py-2 text-xs text-[#7f8ca3]">{emptyMessage}</p>
          ) : options.map((option) => {
            const checked = values.includes(option);
            return (
              <label
                key={option}
                className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-white/5 ${checked ? "text-white" : "text-[#c3ccdb]"}`}
              >
                <input type="checkbox" checked={checked} onChange={() => toggle(option)} className="h-3.5 w-3.5 accent-[#d9a441]" />
                <span className="truncate">{labelMap ? labelMap(option) : option}</span>
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div>
      <span className="mb-1.5 block text-[11px] font-semibold uppercase text-[#7f8ca3]">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-md border border-white/10 bg-[#0b0f16] px-3 font-mono text-sm text-white outline-none focus:border-[#d9a441]/70"
      />
    </div>
  );
}

function MoneyField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div>
      <span className="mb-1.5 block text-[11px] font-semibold uppercase text-[#7f8ca3]">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/[^0-9.]/g, ""))}
        className="h-10 w-full rounded-md border border-white/10 bg-[#0b0f16] px-3 font-mono text-sm text-white outline-none focus:border-[#d9a441]/70"
      />
    </div>
  );
}

function Kpi({ label, value, tone, big }: { label: string; value: string; tone?: "green" | "red"; big?: boolean }) {
  return (
    <div className="rounded-md border border-white/10 bg-[#101620] p-3">
      <div className="text-[10px] font-semibold uppercase text-[#7f8ca3]">{label}</div>
      <div className={cx("mt-1.5 font-mono font-semibold", big ? "text-2xl" : "text-lg", toneClass(tone || "white"))}>{value}</div>
    </div>
  );
}

function Ts01BaselineCard({ profile, targetNo }: { profile?: BacktestResponse["strategy_profile"]; targetNo: string }) {
  const n = (value: number | string | undefined) => value === undefined ? undefined : Number(value);
  const fullyResolvedR = n(profile?.fully_resolved_net_r);
  const closedLegR = n(profile?.closed_leg_net_r);
  return (
    <div className="rounded-md border border-amber-400/25 bg-gradient-to-r from-amber-400/[0.08] to-cyan-400/[0.04] p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#f2c873]">Frozen textbook baseline · not live-approved</div>
          <h2 className="mt-1 text-lg font-semibold text-white">ICT : TS01 2022 ICT Mentorship</h2>
          <p className="mt-1 max-w-4xl text-xs leading-5 text-[#aeb9ca]">
            Completed HTF direction and draw → fresh liquidity raid → completed 5m MSS plus FVG → later CE fill → three distinct real-liquidity targets. Engine <span className="font-mono text-[#d6deec]">{profile?.engine_version || "ts01_tb_r2.2026-08-18"}</span>; primary cohort only.
          </p>
        </div>
        <span className="ml-auto rounded-full border border-rose-400/30 bg-rose-400/10 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-rose-200">Research failed promotion gate</span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        <MiniBaseline label="Sessions" value={fmtInt(n(profile?.sessions))} />
        <MiniBaseline label="Attempts" value={fmtInt(n(profile?.attempts))} />
        <MiniBaseline label="Fills" value={fmtInt(n(profile?.fills))} />
        <MiniBaseline label="Resolved fills" value={fmtInt(n(profile?.fully_resolved_fills))} />
        <MiniBaseline label="Open-leg fills" value={fmtInt(n(profile?.unresolved_fills))} />
        <MiniBaseline label="Open legs" value={fmtInt(n(profile?.unresolved_legs))} />
        <MiniBaseline label="Resolved net" value={fullyResolvedR === undefined ? "-" : `${fmt(fullyResolvedR, 4)}R`} bad />
        <MiniBaseline label="Closed-leg net" value={closedLegR === undefined ? "-" : `${fmt(closedLegR, 4)}R`} bad />
      </div>
      <div className="mt-3 rounded border border-white/10 bg-black/20 px-3 py-2 text-[11px] leading-5 text-[#93a1b6]">
        Outcome definition: the selected Target {targetNo} view includes only that leg’s <span className="text-emerald-300">CLOSED_TP</span> and <span className="text-rose-300">CLOSED_SL</span> rows. <span className="text-[#d6deec]">UNRESOLVED_SESSION_END</span> legs are excluded rather than marked as wins or losses. “Resolved net” is the equal-third combined R for the 48 fills whose three legs all resolved; “closed-leg net” includes only realized legs from all fills and is not a final portfolio return.
      </div>
    </div>
  );
}

function MiniBaseline({ label, value, bad = false }: { label: string; value: string; bad?: boolean }) {
  return <div className="rounded border border-white/10 bg-[#0b0f16]/80 px-3 py-2"><div className="text-[9px] font-semibold uppercase text-[#7f8ca3]">{label}</div><div className={cx("mt-1 font-mono text-sm font-semibold", bad ? "text-[#ff8b91]" : "text-white")}>{value}</div></div>;
}

function Panel({ icon: Icon, title, note, children }: { icon: React.ComponentType<{ className?: string }>; title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-white/10 bg-[#101620]">
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <Icon className="size-4 text-[#d9a441]" />
        <h2 className="font-semibold">{title}</h2>
        {note ? <span className="ml-auto font-mono text-[11px] text-[#93a1b6]">{note}</span> : null}
      </div>
      {children}
    </div>
  );
}

function MetricGrid({ title, rows }: { title: string; rows: Array<[string, string, ("green" | "red" | "white" | "muted")?]> }) {
  return (
    <div className="rounded-md border border-white/10 bg-[#101620] p-4">
      <h3 className="mb-4 text-sm font-semibold text-white">{title}</h3>
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
        {rows.map(([label, value, tone]) => (
          <div key={label}>
            <div className="text-sm text-[#d6deec]">{label}</div>
            <div className={cx("mt-1 font-mono text-lg", toneClass(tone || "white"))}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PerformanceMatrix({ summary }: { summary?: Summary }) {
  if (!summary || !summary.total) return <div className="rounded-md border border-white/10 bg-[#101620] p-6 text-sm text-[#93a1b6]">Run a backtest to populate metrics.</div>;
  return (
    <div className="space-y-4">
      <MetricGrid title="Performance Metrics" rows={[
        ["Initial Capital", money(summary.initial_capital), "white"],
        ["Ending Equity", money(summary.ending_capital), (summary.net_usd ?? 0) >= 0 ? "green" : "red"],
        ["Return on Capital", pct(summary.net_profit_pct), (summary.net_profit_pct ?? 0) >= 0 ? "green" : "red"],
        ["Return on Risk", `${fmt(summary.net_r)}R`, (summary.net_r ?? 0) >= 0 ? "green" : "red"],
        ["Gross P/L", money(summary.gross_pnl_before_costs_usd), (summary.gross_pnl_before_costs_usd ?? 0) >= 0 ? "green" : "red"],
        ["Execution Costs", money(summary.transaction_costs_usd), "red"],
        ["Net P/L", money(summary.net_usd), (summary.net_usd ?? 0) >= 0 ? "green" : "red"],
        ["Value at Risk", money(summary.value_at_risk_usd), "red"],
        ["CAGR", pct(summary.cagr), (summary.cagr ?? 0) >= 0 ? "green" : "red"],
      ]} />
      <MetricGrid title="Performance Ratios" rows={[
        ["Profit Factor", fmt(summary.profit_factor), (summary.profit_factor ?? 0) >= 1 ? "green" : "red"],
        ["Max Drawdown", `${fmt(summary.max_drawdown_r)}R`, "red"],
        ["Sharpe", fmt(summary.sharpe), "white"],
        ["Sortino", fmt(summary.sortino), "white"],
        ["Calmar", fmt(summary.calmar), "white"],
        ["Recovery Factor", fmt(summary.recovery_factor), "white"],
        ["CAR/MaxDD", fmt(summary.car_maxdd), "white"],
        ["RAR/MaxDD", fmt(summary.rar_maxdd), "white"],
        ["Ulcer Index", fmt(summary.ulcer_index), "white"],
        ["K-Ratio", fmt(summary.k_ratio), "white"],
      ]} />
      <MetricGrid title="Win/Loss Metrics" rows={[
        ["Positions", fmtInt(summary.total), "white"],
        ["Win Rate", pct(summary.win_rate), "green"],
        ["Wins", fmtInt(summary.wins), "green"],
        ["Losses", fmtInt(summary.losses), "red"],
        ["Best Win", `${fmt(summary.largest_win_r)}R`, "green"],
        ["Worst Loss", `${fmt(summary.largest_loss_r)}R`, "red"],
        ["Winning Streak", fmtInt(summary.max_consec_wins), "white"],
        ["Losing Streak", fmtInt(summary.max_consec_losses), "white"],
      ]} />
      <MetricGrid title="Position Averages" rows={[
        ["Win", `${fmt(summary.avg_win_r)}R`, "green"],
        ["Loss", `${fmt(summary.avg_loss_r)}R`, "red"],
        ["P/L", `${fmt(summary.expectancy_r)}R`, (summary.expectancy_r ?? 0) >= 0 ? "green" : "red"],
        ["Expected P/L", money(summary.expectancy_usd), (summary.expectancy_usd ?? 0) >= 0 ? "green" : "red"],
        ["Avg Risk", money(summary.risk_usd), "white"],
        ["Avg Quantity", fmt(summary.avg_quantity, 2), "white"],
        ["Min Quantity", fmt(summary.min_quantity, 2), "white"],
        ["Max Quantity", fmt(summary.max_quantity, 2), "white"],
        ["Duration", fmtHold(summary.avg_hold_min ?? null), "white"],
        ["Exposure", pct(summary.exposure_pct), "white"],
        ["Payoff Ratio", fmt(summary.payoff_ratio), "white"],
      ]} />
      <MetricGrid title="Edge and Survival" rows={[
        ["Reward:Risk (b)", fmt(summary.payoff_ratio), "white"],
        ["Break-Even Win Rate", pct(summary.breakeven_win_rate_pct), "white"],
        ["Win Rate Edge", pct(summary.win_rate_edge_pct), (summary.win_rate_edge_pct ?? 0) > 0 ? "green" : "red"],
        ["Kelly Fraction", pct(summary.kelly_fraction_pct, 2), (summary.kelly_fraction_pct ?? 0) > 0 ? "green" : "red"],
        ["Half Kelly", pct(summary.half_kelly_fraction_pct, 2), (summary.half_kelly_fraction_pct ?? 0) > 0 ? "green" : "red"],
        ["Risk of Ruin", pct(summary.risk_of_ruin_pct, 2), (summary.risk_of_ruin_pct ?? 0) < 1 ? "green" : (summary.risk_of_ruin_pct ?? 0) < 10 ? "white" : "red"],
        ["Risk of Ruin (1:1)", pct(summary.risk_of_ruin_simple_pct, 2), "muted"],
        ["Risk Units", fmtInt(summary.risk_units ?? undefined), "muted"],
      ]} />
      <p className="px-1 text-[11px] leading-relaxed text-[#7f8ca3]">
        Break-even win rate is 1/(1+b) against the realized reward:risk b, so the win rate edge is how far this population sits above the level where it only pays for itself.
        Kelly is the simplified f* = p − (1−p)/b on the account, half Kelly being the usual working size.
        Risk of ruin is the probability of losing the account at {fmtInt(summary.risk_units ?? undefined)} risk units, scaled by the payoff; the 1:1 column is the textbook equal-payoff formula, which reads 100% for any win rate under 50%.
      </p>
    </div>
  );
}

function ResearchLab({ research }: { research?: Research }) {
  if (!research) {
    return <div className="rounded-md border border-white/10 bg-[#101620] p-6 text-sm text-[#93a1b6]">Research validation is unavailable for this result.</div>;
  }
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-white/10 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <FlaskConical className="size-5 text-[#d9a441]" />
            <h2 className="text-lg font-semibold">Research Validation</h2>
          </div>
          <p className="mt-1 text-xs text-[#93a1b6]">Net-of-cost evidence, chronological holdout, path risk, attribution and deployment review.</p>
        </div>
        <GateBadge gate={research.deployment_gate} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel icon={FlaskConical} title="Chronological Holdout" note={`${fmt(research.validation.oos_pct, 0)}% OOS`}>
          <ValidationTable validation={research.validation} />
        </Panel>
        <Panel icon={TrendingDown} title="Monte Carlo Path Risk" note={`${fmtInt(research.monte_carlo.simulations)} deterministic paths`}>
          <MonteCarloSummary value={research.monte_carlo} />
        </Panel>
        <Panel icon={BarChart3} title="Performance Attribution" note="entry-time ICT sessions · DST-aware · net of costs">
          <AttributionTable attribution={research.attribution} />
        </Panel>
        <Panel icon={ShieldCheck} title="Data and Deployment Governance" note={research.audit.calculation_version}>
          <GovernanceSummary research={research} />
        </Panel>
      </div>
      <Panel icon={Clock3} title="Performance by Hold Time" note="early-loss trap diagnostic · net of configured costs">
        <HoldTimePerformanceTable rows={research.hold_time_performance ?? []} />
      </Panel>
    </section>
  );
}

function GateBadge({ gate }: { gate: Research["deployment_gate"] }) {
  const passed = gate.status === "RESEARCH_PASSED_REVIEW_REQUIRED";
  return (
    <div className={cx("flex items-center gap-2 rounded border px-3 py-2 text-xs font-semibold", passed ? "border-[#2fbf71]/35 bg-[#2fbf71]/10 text-[#62d894]" : "border-[#e5484d]/35 bg-[#e5484d]/10 text-[#ff9da2]")}>
      {passed ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
      {passed ? "Research passed - approval required" : `Not ready - ${gate.passed_checks}/${gate.total_checks} checks`}
    </div>
  );
}

function ValidationTable({ validation }: { validation: Research["validation"] }) {
  const rows: Array<[string, (stats: ResearchStats) => string]> = [
    ["Trades", (stats) => fmtInt(stats.trades)],
    ["Win rate", (stats) => pct(stats.win_rate)],
    ["Net P/L", (stats) => money(stats.net_usd)],
    ["Expectancy", (stats) => money(stats.expectancy_usd)],
    ["Profit factor", (stats) => fmt(stats.profit_factor)],
    ["Trade Sharpe", (stats) => fmt(stats.trade_sharpe)],
    ["Max drawdown", (stats) => money(stats.max_drawdown_usd)],
  ];
  return (
    <div>
      <div className="border-b border-white/10 px-4 py-3 text-xs text-[#93a1b6]">
        Split at {fmtDate(validation.split_timestamp)}. No parameters are re-optimized in this holdout.
      </div>
      <table className="w-full text-sm">
        <thead className="bg-[#0b0f16] text-[11px] uppercase text-[#7f8ca3]">
          <tr><th className="px-4 py-2 text-left">Metric</th><th className="px-4 py-2 text-right">In sample</th><th className="px-4 py-2 text-right">Out of sample</th></tr>
        </thead>
        <tbody className="divide-y divide-white/5 font-mono">
          {rows.map(([label, read]) => (
            <tr key={label}>
              <td className="px-4 py-2 font-sans text-[#93a1b6]">{label}</td>
              <td className="px-4 py-2 text-right text-[#d6deec]">{read(validation.in_sample)}</td>
              <td className="px-4 py-2 text-right text-white">{read(validation.out_of_sample)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-white/10 px-4 py-3 text-xs text-[#93a1b6]">
        Expectancy degradation: <span className={cx("font-mono", (validation.expectancy_degradation_pct ?? 0) > 50 ? "text-[#ff9da2]" : "text-[#d6deec]")}>{pct(validation.expectancy_degradation_pct)}</span>
      </div>
    </div>
  );
}

function MonteCarloSummary({ value }: { value: Research["monte_carlo"] }) {
  const metrics: Array<[string, string, "green" | "red" | "white"]> = [
    ["Ending equity P05", money(value.ending_equity_p05), "red"],
    ["Ending equity median", money(value.ending_equity_p50), "white"],
    ["Ending equity P95", money(value.ending_equity_p95), "green"],
    ["Median max drawdown", money(-value.max_drawdown_p50_usd), "red"],
    ["P95 max drawdown", money(-value.max_drawdown_p95_usd), "red"],
    ["Probability of loss", pct(value.probability_of_loss_pct), value.probability_of_loss_pct > 20 ? "red" : "white"],
    ["Probability of 20% DD", pct(value.probability_of_20pct_drawdown_pct), value.probability_of_20pct_drawdown_pct > 10 ? "red" : "white"],
  ];
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-5 p-4 md:grid-cols-3">
      {metrics.map(([label, display, tone]) => (
        <div key={label}>
          <div className="text-xs text-[#93a1b6]">{label}</div>
          <div className={cx("mt-1 font-mono text-base", toneClass(tone))}>{display}</div>
        </div>
      ))}
      <div className="col-span-2 border-t border-white/10 pt-3 text-[11px] text-[#7f8ca3] md:col-span-3">
        Bootstrap resampling of observed net trade P/L. Seed {value.seed}; sequence risk only, not a forecast.
      </div>
    </div>
  );
}

function AttributionTable({ attribution }: { attribution: Research["attribution"] }) {
  const [view, setView] = useState<keyof Research["attribution"]>("by_session");
  const views: Array<[keyof Research["attribution"], string]> = [
    ["by_session", "Session"],
    ["by_year", "Year"],
    ["by_direction", "Direction"],
    ["by_strategy", "Strategy"],
    ["by_smt", "SMT"],
    ["by_weekly_profile", "Weekly profile"],
    ["by_weekly_profile_hindsight", "Week printed"],
    ["by_weekday", "Weekday"],
  ];
  return (
    <div>
      <div className="flex gap-1 border-b border-white/10 p-2">
        {views.map(([key, label]) => (
          <button key={key} onClick={() => setView(key)} className={cx("rounded px-2.5 py-1.5 text-xs", view === key ? "bg-[#d9a441]/15 text-[#f2c873]" : "text-[#93a1b6] hover:text-white")}>{label}</button>
        ))}
      </div>
      <div className="max-h-[310px] overflow-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="sticky top-0 bg-[#0b0f16] text-[11px] uppercase text-[#7f8ca3]">
            <tr><th className="px-3 py-2 text-left">{views.find(([key]) => key === view)?.[1]}</th><th className="px-3 py-2 text-right">Trades</th><th className="px-3 py-2 text-right">WR</th><th className="px-3 py-2 text-right">Net P/L</th><th className="px-3 py-2 text-right">Expectancy</th><th className="px-3 py-2 text-right">PF</th></tr>
          </thead>
          <tbody className="divide-y divide-white/5 font-mono">
            {(attribution[view] ?? []).map((row) => (
              <tr key={row.label}>
                <td className="px-3 py-2 font-sans text-[#d6deec]">{row.label}</td>
                <td className="px-3 py-2 text-right">{fmtInt(row.trades)}</td>
                <td className="px-3 py-2 text-right">{pct(row.win_rate)}</td>
                <td className={cx("px-3 py-2 text-right", row.net_usd >= 0 ? "text-[#62d894]" : "text-[#ff8b91]")}>{money(row.net_usd)}</td>
                <td className="px-3 py-2 text-right">{money(row.expectancy_usd)}</td>
                <td className="px-3 py-2 text-right">{fmt(row.profit_factor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view === "by_session" ? (
        <div className="border-t border-white/10 px-3 py-2 text-[11px] text-[#7f8ca3]">
          America/New_York applies the exact EDT/EST transition date; NSE remains fixed in IST. Overlapping entries appear in every matching selected session.
        </div>
      ) : null}
    </div>
  );
}

function HoldTimePerformanceTable({ rows }: { rows: HoldTimePerformanceRow[] }) {
  if (!rows.length) return <div className="grid h-36 place-items-center text-sm text-[#7f8ca3]">No completed trades have a usable hold time.</div>;
  return (
    <div>
      <div className="max-h-[420px] overflow-auto">
        <table className="w-full min-w-[1480px] text-xs">
          <thead className="sticky top-0 bg-[#0b0f16] text-[10px] uppercase text-[#7f8ca3]">
            <tr>{["Hold bucket","Avg hold","Trades","Trade share","Wins","Losses","WR","Loss rate","Share of all losses","PF","Expectancy R","Avg win R","Avg loss R","Net R","Max DD R"].map((label)=><th key={label} className={cx("px-3 py-2", label === "Hold bucket" ? "text-left" : "text-right")}>{label}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-white/5 font-mono">
            {rows.map((row) => (
              <tr key={row.bucket_id} className={row.early ? "bg-[#d9a441]/[0.045]" : undefined}>
                <td className="px-3 py-2 text-left font-sans"><span className={cx("font-semibold", row.early ? "text-[#f2c873]" : "text-[#d6deec]")}>{row.label}</span>{row.early ? <span className="ml-2 rounded bg-[#d9a441]/15 px-1.5 py-0.5 text-[9px] uppercase text-[#f2c873]">early</span> : null}</td>
                <td className="px-3 py-2 text-right text-[#aeb9ca]">{fmtHold(row.avg_hold_min)}</td>
                <td className="px-3 py-2 text-right">{fmtInt(row.trades)}</td><td className="px-3 py-2 text-right">{pct(row.trade_share_pct)}</td><td className="px-3 py-2 text-right text-[#62d894]">{fmtInt(row.wins)}</td><td className="px-3 py-2 text-right text-[#ff8b91]">{fmtInt(row.losses)}</td>
                <td className="px-3 py-2 text-right">{pct(row.win_rate)}</td><td className="px-3 py-2 text-right">{pct(row.loss_rate_pct)}</td><td className="px-3 py-2 text-right">{pct(row.loss_concentration_pct)}</td><td className="px-3 py-2 text-right">{fmt(row.profit_factor)}</td>
                <td className={cx("px-3 py-2 text-right", row.expectancy_r >= 0 ? "text-[#62d894]" : "text-[#ff8b91]")}>{fmt(row.expectancy_r, 3)}R</td><td className="px-3 py-2 text-right text-[#62d894]">{fmt(row.avg_win_r, 3)}R</td><td className="px-3 py-2 text-right text-[#ff8b91]">{fmt(row.avg_loss_r, 3)}R</td><td className={cx("px-3 py-2 text-right", row.net_r >= 0 ? "text-[#62d894]" : "text-[#ff8b91]")}>{fmt(row.net_r, 2)}R</td><td className="px-3 py-2 text-right text-[#ff8b91]">{fmt(row.max_drawdown_r, 2)}R</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-white/10 px-3 py-2 text-[11px] leading-5 text-[#7f8ca3]">Early means a completed hold under 60 minutes. “Share of all losses” shows loss concentration across the selected backtest. This is descriptive evidence of trap-like behavior, not proof that extending the stop or hold would improve results.</div>
    </div>
  );
}

function GovernanceSummary({ research }: { research: Research }) {
  return (
    <div className="divide-y divide-white/10">
      <div className="grid grid-cols-2 gap-4 p-4 text-xs md:grid-cols-4">
        <AuditValue label="Source" value={research.audit.source} icon={Database} wide />
        <AuditValue label="First close" value={fmtDate(research.data_quality.first_close_ts)} />
        <AuditValue label="Last close" value={fmtDate(research.data_quality.last_close_ts)} />
      </div>
      <div className="p-4">
        <div className="mb-3 text-xs font-semibold uppercase text-[#7f8ca3]">Deployment checks</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {research.deployment_gate.checks.map((check) => (
            <div key={check.id} className="flex items-center gap-2 text-xs text-[#d6deec]">
              {check.passed ? <CheckCircle2 className="size-4 shrink-0 text-[#62d894]" /> : <XCircle className="size-4 shrink-0 text-[#ff8b91]" />}
              {check.label}
            </div>
          ))}
        </div>
      </div>
      <div className="p-4">
        <div className="mb-2 text-xs font-semibold uppercase text-[#7f8ca3]">Model limitations</div>
        <ul className="space-y-1.5 text-xs text-[#93a1b6]">
          {research.data_quality.warnings.map((warning) => <li key={warning}>- {warning}</li>)}
        </ul>
      </div>
      <div className="p-4 text-[11px] text-[#7f8ca3]">
        Generated {fmtDate(research.audit.generated_at)}. {research.deployment_gate.note}
      </div>
    </div>
  );
}

function AuditValue({ label, value, icon: Icon, wide }: { label: string; value: string; icon?: React.ComponentType<{ className?: string }>; wide?: boolean }) {
  return (
    <div className={cx(wide && "col-span-2")}>
      <div className="flex items-center gap-1.5 text-[#7f8ca3]">{Icon ? <Icon className="size-3.5" /> : null}{label}</div>
      <div className="mt-1 break-words font-mono text-[#d6deec]">{value}</div>
    </div>
  );
}

// Math.min/Math.max with a spread argument throws "Maximum call stack size
// exceeded" on a large series. The API downsamples the equity curve, but fold
// here too so an older cached payload still renders.
function foldExtent(points: readonly EquityPoint[], pick: (p: EquityPoint) => number) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const point of points) {
    const value = pick(point);
    if (!Number.isFinite(value)) continue;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  return { lo, hi };
}

function EquityDrawdownChart({ points }: { points: EquityPoint[] }) {
  if (!points.length) return <div className="grid h-[320px] place-items-center text-sm text-[#93a1b6]">No equity data.</div>;
  const width = 900;
  const height = 320;
  const pad = 28;
  const rExtent = foldExtent(points, (p) => p.r);
  const ddExtent = foldExtent(points, (p) => p.dd);
  const minY = Math.min(rExtent.lo, 0);
  const maxY = Math.max(rExtent.hi, 1);
  const minDd = Math.min(ddExtent.lo, -1);
  const x = (index: number) => pad + (index / Math.max(points.length - 1, 1)) * (width - pad * 2);
  const y = (value: number) => pad + ((maxY - value) / Math.max(maxY - minY, 1)) * (height - pad * 2);
  const zeroY = y(0);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.r).toFixed(1)}`).join(" ");
  const area = `${line} L ${x(points.length - 1)} ${zeroY} L ${x(0)} ${zeroY} Z`;
  return (
    <div className="p-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[320px] w-full">
        <defs>
          <linearGradient id="equityFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={GREEN} stopOpacity="0.35" />
            <stop offset="100%" stopColor={GREEN} stopOpacity="0.03" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3].map((i) => <line key={i} x1={pad} x2={width - pad} y1={pad + i * 82} y2={pad + i * 82} stroke="rgba(255,255,255,0.06)" />)}
        <path d={area} fill="url(#equityFill)" />
        <path d={line} fill="none" stroke={GREEN} strokeWidth="2.5" />
        {points.map((p, i) => {
          if (p.dd >= 0) return null;
          const barHeight = Math.max(1, (Math.abs(p.dd) / Math.abs(minDd)) * 90);
          return <rect key={`${p.t}-${i}`} x={x(i) - 1.5} y={height - pad - barHeight} width="3" height={barHeight} fill="rgba(200,145,255,0.35)" />;
        })}
        <text x={pad} y={18} fill={MUTED} fontSize="12">Equity {fmt(points[points.length - 1]?.r)}R</text>
        <text x={width - pad} y={18} fill={MUTED} fontSize="12" textAnchor="end">Max DD {fmt(minDd)}R</text>
      </svg>
    </div>
  );
}

function MonthlyBars({ monthly }: { monthly: MonthlyPoint[] }) {
  if (!monthly.length) return <div className="grid h-[180px] place-items-center text-sm text-[#93a1b6]">No monthly data.</div>;
  const recent = monthly.slice(-24);
  const maxAbs = Math.max(...recent.map((m) => Math.abs(m.net_r)), 1);
  return (
    <div className="flex h-[190px] items-end gap-1 overflow-x-auto px-4 pb-4 pt-5">
      {recent.map((month) => {
        const h = Math.max(4, (Math.abs(month.net_r) / maxAbs) * 130);
        return (
          <div key={month.month} className="flex min-w-8 flex-col items-center gap-1">
            <div title={`${month.month}: ${fmt(month.net_r)}R, ${month.trades} trades`} className="w-5 rounded-t" style={{ height: h, backgroundColor: month.net_r >= 0 ? GREEN : RED }} />
            <span className="font-mono text-[9px] text-[#7f8ca3]">{month.month.slice(2).replace("-", "/")}</span>
          </div>
        );
      })}
    </div>
  );
}

function MonthlyHeatmap({ monthly }: { monthly: MonthlyPoint[] }) {
  const years = [...new Set(monthly.map((m) => m.month.slice(0, 4)))].sort((a, b) => b.localeCompare(a));
  const byMonth = new Map(monthly.map((m) => [m.month, m]));
  const maxAbs = Math.max(...monthly.map((m) => Math.abs(m.net_r)), 1);
  if (!monthly.length) return null;
  return (
    <div className="overflow-auto px-3 pb-3">
      <table className="w-full min-w-[560px] border-separate border-spacing-1 text-center text-[11px]">
        <thead className="text-[#7f8ca3]">
          <tr><th className="text-left">Year</th>{["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((m) => <th key={m}>{m}</th>)}</tr>
        </thead>
        <tbody>
          {years.map((year) => (
            <tr key={year}>
              <td className="pr-2 text-left font-mono text-[#d6deec]">{year}</td>
              {Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0")).map((month) => {
                const item = byMonth.get(`${year}-${month}`);
                const alpha = item ? Math.min(0.85, 0.15 + Math.abs(item.net_r) / maxAbs) : 0;
                return (
                  <td key={month} className="rounded px-1 py-1.5 font-mono text-white" style={{ backgroundColor: item ? (item.net_r >= 0 ? `rgba(47,191,113,${alpha})` : `rgba(229,72,77,${alpha})`) : "transparent" }}>
                    {item ? `${item.net_r >= 0 ? "+" : ""}${item.net_r.toFixed(1)}` : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DirectionStatsTable({ summary }: { summary?: Summary }) {
  const groups = summary?.group_stats;
  if (!summary || !groups) return <div className="grid h-[320px] place-items-center text-sm text-[#93a1b6]">No statistics.</div>;
  const rows: Array<[string, (stats: DirectionStats) => string, ("green" | "red" | "white" | "muted")?]> = [
    ["Trades", (s) => fmtInt(s.trades), "white"],
    ["Wins", (s) => fmtInt(s.wins), "green"],
    ["Losses", (s) => fmtInt(s.losses), "red"],
    ["Win rate", (s) => pct(s.win_rate), "white"],
    ["Net R", (s) => fmt(s.net_r), "white"],
    ["Net $", (s) => money(s.net_usd), "white"],
    ["Avg R", (s) => fmt(s.avg_r), "white"],
    ["Avg Win", (s) => fmt(s.avg_win_r), "green"],
    ["Avg Loss", (s) => fmt(s.avg_loss_r), "red"],
    ["Largest Win", (s) => fmt(s.largest_win_r), "green"],
    ["Largest Loss", (s) => fmt(s.largest_loss_r), "red"],
  ];
  return (
    <div className="max-h-[360px] overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-[#0b0f16] text-[11px] uppercase text-[#7f8ca3]">
          <tr><th className="px-4 py-2 text-left">Metric</th><th className="px-4 py-2 text-right">All</th><th className="px-4 py-2 text-right">Long</th><th className="px-4 py-2 text-right">Short</th></tr>
        </thead>
        <tbody className="divide-y divide-white/5 font-mono">
          {rows.map(([label, read, tone]) => (
            <tr key={label}>
              <td className="px-4 py-2 font-sans text-[#93a1b6]">{label}</td>
              <td className={cx("px-4 py-2 text-right", toneClass(tone))}>{read(groups.all)}</td>
              <td className={cx("px-4 py-2 text-right", toneClass(tone))}>{read(groups.long)}</td>
              <td className={cx("px-4 py-2 text-right", toneClass(tone))}>{read(groups.short)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function tickerColor(ticker: string) {
  let hash = 0;
  for (const character of ticker) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 66% 58%)`;
}

function TickerDistribution({ rows, selected, onPick }: { rows: TickerDistributionRow[]; selected: string[]; onPick: (ticker: string) => void }) {
  if (!rows.length) return <div className="grid h-[280px] place-items-center text-sm text-[#93a1b6]">No ticker distribution for this selection.</div>;
  const total = rows.reduce((sum, row) => sum + row.trades, 0);
  const segments = rows.map((row, index) => {
    const percentage = total ? (row.trades / total) * 100 : 0;
    const priorTrades = rows.slice(0, index).reduce((sum, prior) => sum + prior.trades, 0);
    const offset = total ? -(priorTrades / total) * 100 : 0;
    return { ...row, percentage, offset, color: tickerColor(row.ticker) };
  });

  return (
    <div className="grid gap-5 p-4 lg:grid-cols-[280px_1fr] lg:items-center">
      <div className="mx-auto w-full max-w-[280px]">
        <svg viewBox="0 0 120 120" role="img" aria-label={`Trade distribution across ${rows.length} tickers`} className="h-auto w-full">
          <circle cx="60" cy="60" r="46" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="20" />
          {segments.map((segment) => (
            <circle
              key={segment.ticker}
              cx="60"
              cy="60"
              r="46"
              fill="none"
              stroke={segment.color}
              strokeWidth="20"
              pathLength="100"
              strokeDasharray={`${segment.percentage} ${100 - segment.percentage}`}
              strokeDashoffset={segment.offset}
              transform="rotate(-90 60 60)"
            >
              <title>{`${segment.ticker}: ${segment.trades.toLocaleString()} trades (${segment.percentage.toFixed(2)}%)`}</title>
            </circle>
          ))}
          <text x="60" y="57" textAnchor="middle" className="fill-white font-mono text-[8px] font-semibold">{fmtInt(total)}</text>
          <text x="60" y="66" textAnchor="middle" className="fill-[#7f8ca3] text-[4px] uppercase tracking-wider">closed trades</text>
        </svg>
      </div>
      <div className="max-h-[300px] overflow-auto pr-1">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {segments.map((segment) => {
            const active = selected.includes(segment.ticker);
            return (
              <button
                key={segment.ticker}
                type="button"
                onClick={() => onPick(segment.ticker)}
                aria-label={`Filter backtest to ${segment.ticker}`}
                className={cx("rounded-md border px-3 py-2 text-left transition hover:bg-white/[0.04]", active ? "border-[#d9a441]/60 bg-[#d9a441]/10" : "border-white/10 bg-[#0b0f16]")}
              >
                <span className="flex items-center gap-2">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: segment.color }} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-white">{segment.ticker}</span>
                  <span className="shrink-0 text-right font-mono text-xs font-semibold text-[#f2c873]">{segment.percentage.toFixed(2)}%</span>
                  <span className="w-16 shrink-0 text-right font-mono text-[10px] text-[#7f8ca3]">{fmtInt(segment.trades)} trades</span>
                </span>
                <span className="mt-2 grid grid-cols-3 gap-2 border-t border-white/5 pt-2">
                  <span><span className="block text-[9px] font-semibold uppercase text-[#657187]">Win rate</span><span className="mt-0.5 block font-mono text-[11px] text-white">{fmt(segment.win_rate, 1)}%</span></span>
                  <span><span className="block text-[9px] font-semibold uppercase text-[#657187]">Win R</span><span className="mt-0.5 block font-mono text-[11px] text-[#62d894]">+{fmt(segment.win_r)}R</span></span>
                  <span><span className="block text-[9px] font-semibold uppercase text-[#657187]">Net P/L</span><span className={cx("mt-0.5 block font-mono text-[11px]", segment.pnl_usd >= 0 ? "text-[#62d894]" : "text-[#ff8b91]")}>{money(segment.pnl_usd)}</span></span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BreakdownTable({ rows, onPick }: { rows: BreakdownRow[]; onPick: (id: string) => void }) {
  if (!rows.length) return <div className="grid h-[260px] place-items-center text-sm text-[#93a1b6]">No strategy rows.</div>;
  return (
    <div className="max-h-[340px] overflow-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="sticky top-0 border-b border-white/10 bg-[#0b0f16] text-[11px] uppercase text-[#7f8ca3]">
          <tr><th className="px-3 py-2">Strategy</th><th className="px-3 py-2">Name</th><th className="px-3 py-2 text-right">Trades</th><th className="px-3 py-2 text-right">WR%</th><th className="px-3 py-2 text-right">Net R</th><th className="px-3 py-2 text-right">PF</th><th className="px-3 py-2 text-right">BE WR%</th><th className="px-3 py-2 text-right">Edge</th><th className="px-3 py-2 text-right">Kelly%</th><th className="px-3 py-2 text-right">RoR%</th></tr>
        </thead>
        <tbody className="divide-y divide-white/10 font-mono">
          {rows.map((row) => (
            <tr key={row.strategy_id} onClick={() => onPick(row.strategy_id)} className="cursor-pointer hover:bg-white/[0.03]">
              <td className="px-3 py-2 text-white"><StrategyLink code={row.strategy_id} label={row.strategy_id} /></td>
              <td className="px-3 py-2 font-sans text-[#d6deec]">{strategyDisplayName(row.strategy_id, row.strategy_name)}</td>
              <td className="px-3 py-2 text-right text-[#d6deec]">{fmtInt(row.trades)}</td>
              <td className="px-3 py-2 text-right text-[#d6deec]">{fmt(row.win_rate, 1)}</td>
              <td className={cx("px-3 py-2 text-right font-semibold", row.net_r >= 0 ? "text-[#62d894]" : "text-[#ff8b91]")}>{row.net_r >= 0 ? "+" : ""}{fmt(row.net_r)}</td>
              <td className="px-3 py-2 text-right text-[#f2c873]">{fmt(row.profit_factor)}</td>
              <td className="px-3 py-2 text-right text-[#d6deec]">{fmt(row.breakeven_win_rate_pct, 1)}</td>
              <td className={cx("px-3 py-2 text-right", (row.win_rate_edge_pct ?? 0) > 0 ? "text-[#62d894]" : "text-[#ff8b91]")}>{fmt(row.win_rate_edge_pct, 1)}</td>
              <td className={cx("px-3 py-2 text-right", (row.kelly_fraction_pct ?? 0) > 0 ? "text-[#62d894]" : "text-[#ff8b91]")}>{fmt(row.kelly_fraction_pct, 2)}</td>
              <td className={cx("px-3 py-2 text-right", (row.risk_of_ruin_pct ?? 0) < 10 ? "text-[#d6deec]" : "text-[#ff8b91]")}>{fmt(row.risk_of_ruin_pct, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ColumnChooser({ visibleColumns, onChange, onExport, exporting, exportStatus }: { visibleColumns: ColumnKey[]; onChange: (columns: ColumnKey[]) => void; onExport: () => void; exporting: boolean; exportStatus: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
      <SlidersHorizontal className="size-4 text-[#d9a441]" />
      <span className="mr-1 text-xs font-semibold uppercase text-[#7f8ca3]">Columns</span>
      {COLUMNS.map((column) => {
        const active = visibleColumns.includes(column.key);
        return (
          <button
            key={column.key}
            onClick={() => {
              const next = active ? visibleColumns.filter((key) => key !== column.key) : [...visibleColumns, column.key];
              onChange(next.length ? next : [column.key]);
            }}
            className={cx("rounded border px-2 py-1 text-[11px]", active ? "border-[#d9a441]/50 bg-[#d9a441]/15 text-[#f2c873]" : "border-white/10 text-[#93a1b6]")}
          >
            {column.label}
          </button>
        );
      })}
      <div className="ml-auto flex items-center gap-2">
        {exportStatus ? <span className="max-w-72 text-right text-[10px] text-[#93a1b6]">{exportStatus}</span> : null}
        <button type="button" disabled={exporting} onClick={onExport} className="inline-flex items-center gap-1.5 rounded border border-emerald-400/35 bg-emerald-400/10 px-3 py-1.5 text-[11px] font-semibold text-emerald-200 hover:border-emerald-300/60 disabled:cursor-wait disabled:opacity-50">
          <Download className="size-3.5" />{exporting ? "Exporting…" : "Export CSV"}
        </button>
      </div>
      <span className="w-full text-[10px] text-[#657187]">CSV uses the selected columns and always adds the complete strategy_json for every filtered trade.</span>
    </div>
  );
}

function SortTh({ label, k, sortKey, sortDir, onClick, num }: { label: string; k: keyof TradeRow; sortKey: keyof TradeRow; sortDir: "asc" | "desc"; onClick: (key: keyof TradeRow) => void; num?: boolean }) {
  const active = sortKey === k;
  return (
    <th className={cx("px-3 py-3 font-semibold", num && "text-right")}>
      <button onClick={() => onClick(k)} className={cx("inline-flex items-center gap-1 hover:text-white", active && "text-[#f2c873]")}>
        {label}
        {active ? <span className="text-[9px]">{sortDir === "asc" ? "▲" : "▼"}</span> : <ArrowUpDown className="size-3 opacity-40" />}
      </button>
    </th>
  );
}

function TradeCell({ column, trade, onSelectTrade }: { column: Column; trade: TradeRow; onSelectTrade: (trade: TradeRow) => void }) {
  const tone = column.tone?.(trade) || "white";
  if (column.key === "outcome") {
    return (
      <td className="px-3 py-2">
        <span className={cx("rounded px-1.5 py-0.5 text-[10px] font-semibold", trade.outcome === "WIN" ? "bg-[#2fbf71]/15 text-[#62d894]" : "bg-[#e5484d]/15 text-[#ff8b91]")}>{column.render(trade)}</span>
      </td>
    );
  }
  if (column.key === "strategy_id") {
    return <td className="px-3 py-2 text-white"><StrategyLink code={trade.strategy_id} label={trade.strategy_id || "-"} /></td>;
  }
  if (column.key === "strategy_json_available") {
    return (
      <td className="px-3 py-2">
        {trade.strategy_json_available ? (
          <button type="button" onClick={(event) => { event.stopPropagation(); onSelectTrade(trade); }} className="rounded border border-[#64d2ff]/25 bg-[#64d2ff]/10 px-2 py-1 text-[11px] font-semibold text-[#bfeaff] hover:border-[#64d2ff]/50">
            Inspect · {trade.strategy_json_keys.length} keys
          </button>
        ) : <span className="text-[#7f8ca3]">Not recorded</span>}
      </td>
    );
  }
  return <td className={cx("px-3 py-2", column.numeric && "text-right", toneClass(tone))}>{column.render(trade)}</td>;
}
