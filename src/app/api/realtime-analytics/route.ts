import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";
import { buildCsv, csvDownloadResponse, selectedCsvKeys } from "@/lib/csv-export";
import { OANDA_EXECUTED_ROWS_SOURCE, REALTIME_ROWS_SOURCE } from "@/lib/realtime-rows-sql";
import { computeEdgeMetrics } from "@/lib/edge-metrics";
import {
  ICT_SESSION_DEFINITIONS,
  getIctSessionIds,
  ictSessionDisplayLabel,
  parseIctSessionSelection,
  passesIctSessionFilter,
} from "@/lib/ict-sessions";
import { parsePlannedRrSelection, plannedRrBucketId } from "@/lib/planned-rr";
import { parseSmtFilter, passesSmtFilter, smtForTrades, smtGroup, type SmtResult } from "@/lib/smt-signal";
import { parseWeeklyFilter, passesWeeklyFilter, weeklyHindsightGroup, weeklyLiveGroup, weeklyProfilesForTrades, type WeeklyProfileResult } from "@/lib/weekly-profile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Row = Record<string, unknown>;

const SORT_FIELDS: Record<string, string> = {
  entry_datetime: "entry_datetime",
  close_ts: "close_ts",
  market: "market",
  ticker: "ticker",
  strategy_id: "strategy_id",
  direction: "direction",
  state: "state",
  realized_r: "realized_r",
  risk_probability: "risk_probability",
  risk_bin: "risk_bin",
};

const REALTIME_CSV_KEYS = [
  "entry_datetime", "close_ts", "market", "ticker", "strategy_id", "signal_timeframe", "direction",
  "entry_price", "stoploss", "tp1", "tp2", "tp3", "state", "realized_r",
  "risk_probability", "risk_bin", "wp_group", "wp_hindsight_group",
] as const;

function realtimeCsv(rows: Row[], rawColumns: string | null) {
  const keys = selectedCsvKeys(rawColumns, REALTIME_CSV_KEYS, REALTIME_CSV_KEYS);
  const columns = [
    ...keys.map((key) => ({ key, value: (row: Row) => row[key] })),
    { key: "strategy_json", value: (row: Row) => row.strategy_json ?? null },
  ];
  return buildCsv(columns, rows);
}

// broker=OANDA rows carry the account's own fill / exit / R for Reversal k1
// (see OANDA_EXECUTED_ROWS_SOURCE); use them instead of the paper setup values.
function withOandaExecution(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.oanda_status === null || raw.oanda_status === undefined) return raw;
  return {
    ...raw,
    filled_price: raw.oanda_fill_price ?? raw.filled_price,
    filled_at: raw.oanda_fill_ts ?? raw.filled_at,
    close_price: raw.oanda_close_price ?? raw.close_price,
    close_ts: raw.oanda_close_ts ?? raw.close_ts,
    live_realized_r: raw.oanda_realized_r ?? raw.live_realized_r,
    state: raw.oanda_status,
  };
}

function n(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function outcome(state: string, realizedR: number | null) {
  const upper = state.toUpperCase();
  if (upper === "OPEN" || upper.includes("PENDING") || upper === "FILLED") return "OPEN";
  if (upper === "INVALID_EXECUTION") return "INVALID_EXECUTION";
  if (upper === "UNVERIFIED") return "UNVERIFIED";
  if (upper === "DUPLICATE_SETUP") return "DUPLICATE_SETUP";
  if (upper === "CLOSED_TP") return "WIN";
  if (upper === "CLOSED_SL") return "LOSS";
  if (upper.startsWith("CLOSED")) {
    if (realizedR === null || Math.abs(realizedR) < 0.000001) return "BREAKEVEN";
    return realizedR > 0 ? "WIN" : "LOSS";
  }
  return upper ? "UNKNOWN" : "SIGNAL_ONLY";
}

function marketTimezone(market: string, exchangeTimezone: string) {
  if (exchangeTimezone) return exchangeTimezone;
  return market.toLowerCase() === "india" ? "Asia/Kolkata" : "America/New_York";
}

function localMinuteOfDay(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return (hour % 24) * 60 + minute;
}

// Daily-timeframe signals are stored on the bar date (local midnight). For any
// time-of-day analysis (ICT sessions, weekday x time heatmap) place them on the
// cash-session open instead: 09:30 ET, or 09:15 IST for NSE.
function entryClockTimestamp(value: unknown, timeframe: string, timezone: string) {
  const raw = text(value);
  if (!raw) return raw;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return raw;
  if (!/^(1d|d|d1|daily|1day)$/i.test(timeframe.trim())) return raw;
  if (localMinuteOfDay(date, timezone) !== 0) return raw;
  const openMinute = timezone === "Asia/Kolkata" ? 9 * 60 + 15 : 9 * 60 + 30;
  let shifted = new Date(date.getTime() + openMinute * 60_000);
  shifted = new Date(shifted.getTime() + (openMinute - localMinuteOfDay(shifted, timezone)) * 60_000); // DST-safe
  return shifted.toISOString();
}

function localDate(value: unknown, timezone: string) {
  if (!value) return "";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function dateTimeKey(value: unknown) {
  if (!value) return -Infinity;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return -Infinity;
  return date.getTime();
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function minutesBetween(a: unknown, b: unknown) {
  const start = dateTimeKey(a);
  const end = dateTimeKey(b);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return (end - start) / 60_000;
}

const HOLD_TIME_BUCKETS = [
  { id: "under_15m", label: "Under 15m", min: 0, max: 15, early: true },
  { id: "15_30m", label: "15-30m", min: 15, max: 30, early: true },
  { id: "30_60m", label: "30-60m", min: 30, max: 60, early: true },
  { id: "1_2h", label: "1-2h", min: 60, max: 120, early: false },
  { id: "2_4h", label: "2-4h", min: 120, max: 240, early: false },
  { id: "4_8h", label: "4-8h", min: 240, max: 480, early: false },
  { id: "8_24h", label: "8-24h", min: 480, max: 1_440, early: false },
  { id: "1_3d", label: "1-3d", min: 1_440, max: 4_320, early: false },
  { id: "3_7d", label: "3-7d", min: 4_320, max: 10_080, early: false },
  { id: "over_7d", label: "7d+", min: 10_080, max: Infinity, early: false },
] as const;

function stats(rows: Row[]) {
  const closed = rows
    .filter((row) => ["WIN", "LOSS", "BREAKEVEN"].includes(text(row.outcome)))
    .sort((a, b) => {
      const aKey = dateTimeKey(a.close_ts ?? a.filled_at ?? a.entry_datetime);
      const bKey = dateTimeKey(b.close_ts ?? b.filled_at ?? b.entry_datetime);
      return aKey - bKey;
    });
  const wins = closed.filter((row) => text(row.outcome) === "WIN");
  const losses = closed.filter((row) => text(row.outcome) === "LOSS");
  const rValues = closed.map((row) => n(row.realized_r)).filter((value): value is number => value !== null);
  const grossWin = rValues.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(rValues.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const netR = rValues.reduce((sum, value) => sum + value, 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let drawdownSquares = 0;
  for (const value of rValues) {
    equity += value;
    peak = Math.max(peak, equity);
    const drawdown = equity - peak;
    maxDrawdown = Math.min(maxDrawdown, drawdown);
    drawdownSquares += drawdown ** 2;
  }
  const daily = new Map<string, number>();
  for (const row of closed) {
    const key = text(row.local_date);
    if (key) daily.set(key, (daily.get(key) ?? 0) + (n(row.realized_r) ?? 0));
  }
  const dailyValues = [...daily.values()];
  const dailyMean = dailyValues.length ? dailyValues.reduce((sum, value) => sum + value, 0) / dailyValues.length : null;
  const dailyVariance = dailyValues.length > 1 && dailyMean !== null
    ? dailyValues.reduce((sum, value) => sum + (value - dailyMean) ** 2, 0) / (dailyValues.length - 1)
    : null;
  const sharpe = dailyVariance && dailyVariance > 0 && dailyMean !== null ? dailyMean / Math.sqrt(dailyVariance) * Math.sqrt(252) : null;
  const buy = closed.filter((row) => text(row.direction).toUpperCase() === "BUY");
  const sell = closed.filter((row) => text(row.direction).toUpperCase() === "SELL");
  const wr = (items: Row[]) => items.length ? 100 * items.filter((row) => text(row.outcome) === "WIN").length / items.length : null;

  let winStreak = 0;
  let lossStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  for (const row of closed) {
    if (row.outcome === "WIN") {
      winStreak += 1;
      lossStreak = 0;
      maxWinStreak = Math.max(maxWinStreak, winStreak);
    } else if (row.outcome === "LOSS") {
      lossStreak += 1;
      winStreak = 0;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    } else {
      winStreak = 0;
      lossStreak = 0;
    }
  }
  const holdMinutes = closed.map((row) => n(row.hold_minutes)).filter((value): value is number => value !== null);
  const sortedHolds = [...holdMinutes].sort((a, b) => a - b);
  const quantities = closed.map((row) => n(row.qty)).filter((value): value is number => value !== null && value > 0);
  const meanR = rValues.length ? netR / rValues.length : null;
  const tradeVariance = meanR === null || !rValues.length
    ? null
    : rValues.reduce((sum, value) => sum + (value - meanR) ** 2, 0) / rValues.length;
  const tradeStd = tradeVariance === null ? null : Math.sqrt(tradeVariance);
  const downsideValues = rValues.filter((value) => value < 0);
  const downsideStd = downsideValues.length
    ? Math.sqrt(downsideValues.reduce((sum, value) => sum + value ** 2, 0) / downsideValues.length)
    : null;
  const sortedR = [...rValues].sort((a, b) => a - b);
  const valueAtRiskR = sortedR.length ? sortedR[Math.max(0, Math.floor(sortedR.length * 0.05) - 1)] : null;
  const firstTimestamp = closed[0] ? dateTimeKey(closed[0].close_ts ?? closed[0].filled_at ?? closed[0].entry_datetime) : null;
  const lastTimestamp = closed.at(-1) ? dateTimeKey(closed.at(-1)?.close_ts ?? closed.at(-1)?.filled_at ?? closed.at(-1)?.entry_datetime) : null;
  const elapsedMinutes = firstTimestamp !== null && lastTimestamp !== null && Number.isFinite(firstTimestamp) && Number.isFinite(lastTimestamp) && lastTimestamp > firstTimestamp
    ? (lastTimestamp - firstTimestamp) / 60_000
    : null;
  const exposurePct = elapsedMinutes && elapsedMinutes > 0
    ? Math.min(100, 100 * holdMinutes.reduce((sum, value) => sum + value, 0) / elapsedMinutes)
    : null;
  const elapsedYears = firstTimestamp !== null && lastTimestamp !== null && Number.isFinite(firstTimestamp) && Number.isFinite(lastTimestamp) && lastTimestamp > firstTimestamp
    ? Math.max((lastTimestamp - firstTimestamp) / (365.25 * 86_400_000), 1 / 365)
    : null;
  const annualizedReturnR = elapsedYears ? netR / elapsedYears : null;

  const avgWinR = wins.length
    ? wins.reduce((sum, row) => sum + (n(row.realized_r) ?? 0), 0) / wins.length
    : 0;
  const avgLossR = losses.length
    ? losses.reduce((sum, row) => sum + (n(row.realized_r) ?? 0), 0) / losses.length
    : 0;
  // Live orders carry no account size, so risk of ruin is quoted against the
  // house convention of 1% risk per trade (100 risk units in the account).
  const edge = computeEdgeMetrics({
    winRatePct: closed.length ? 100 * wins.length / closed.length : null,
    avgWinR,
    avgLossR,
    rMultiples: rValues,
    fallbackRiskUnits: 100,
  });

  return {
    outcomes: closed.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: closed.length - wins.length - losses.length,
    win_rate_pct: closed.length ? round(100 * wins.length / closed.length) : null,
    buy_win_rate_pct: wr(buy) === null ? null : round(wr(buy)!),
    sell_win_rate_pct: wr(sell) === null ? null : round(wr(sell)!),
    profit_factor: grossLoss > 0 ? round(grossWin / grossLoss) : grossWin > 0 ? null : null,
    gross_win_r: round(grossWin),
    gross_loss_r: round(-grossLoss),
    net_r: round(netR),
    expectancy_r: rValues.length ? round(netR / rValues.length) : null,
    avg_win_r: wins.length ? round(wins.reduce((sum, row) => sum + (n(row.realized_r) ?? 0), 0) / wins.length) : null,
    avg_loss_r: losses.length ? round(losses.reduce((sum, row) => sum + (n(row.realized_r) ?? 0), 0) / losses.length) : null,
    largest_win_r: wins.length ? round(Math.max(...wins.map((row) => n(row.realized_r) ?? 0))) : null,
    largest_loss_r: losses.length ? round(Math.min(...losses.map((row) => n(row.realized_r) ?? 0))) : null,
    avg_hold_min: holdMinutes.length ? round(holdMinutes.reduce((sum, value) => sum + value, 0) / holdMinutes.length) : null,
    median_hold_min: sortedHolds.length ? round(sortedHolds[Math.floor((sortedHolds.length - 1) / 2)]) : null,
    exposure_pct: exposurePct === null ? null : round(exposurePct),
    avg_quantity: quantities.length ? round(quantities.reduce((sum, value) => sum + value, 0) / quantities.length, 4) : null,
    min_quantity: quantities.length ? round(Math.min(...quantities), 4) : null,
    max_quantity: quantities.length ? round(Math.max(...quantities), 4) : null,
    quantity_coverage_pct: closed.length ? round(100 * quantities.length / closed.length) : null,
    max_consecutive_wins: maxWinStreak,
    max_consecutive_losses: maxLossStreak,
    value_at_risk_r: valueAtRiskR === null ? null : round(valueAtRiskR),
    max_drawdown_r: round(maxDrawdown),
    recovery_factor: maxDrawdown < 0 ? round(netR / Math.abs(maxDrawdown)) : null,
    sharpe_daily_r: sharpe === null ? null : round(sharpe),
    trade_sharpe: meanR !== null && tradeStd && tradeStd > 0 ? round(meanR / tradeStd) : null,
    sortino: meanR !== null && downsideStd && downsideStd > 0 ? round(meanR / downsideStd) : null,
    annualized_return_r: annualizedReturnR === null ? null : round(annualizedReturnR),
    annualized_r_maxdd: annualizedReturnR !== null && maxDrawdown < 0 ? round(annualizedReturnR / Math.abs(maxDrawdown)) : null,
    rar_maxdd: meanR !== null && tradeStd && tradeStd > 0 && maxDrawdown < 0 ? round((meanR / tradeStd) / Math.abs(maxDrawdown)) : null,
    ulcer_index_r: rValues.length ? round(Math.sqrt(drawdownSquares / rValues.length)) : null,
    k_ratio: meanR !== null && tradeStd && tradeStd > 0 ? round(meanR / tradeStd) : null,
    ...edge,
  };
}

function holdTimePerformance(rows: Row[]) {
  const closedWithHold = rows.filter((row) =>
    ["WIN", "LOSS", "BREAKEVEN"].includes(text(row.outcome)) && (n(row.hold_minutes) ?? -1) >= 0,
  );
  const totalLosses = closedWithHold.filter((row) => row.outcome === "LOSS").length;
  return HOLD_TIME_BUCKETS.map((bucket) => {
    const bucketRows = closedWithHold.filter((row) => {
      const value = n(row.hold_minutes);
      return value !== null && value >= bucket.min && value < bucket.max;
    });
    const bucketStats = stats(bucketRows);
    return {
      bucket_id: bucket.id,
      label: bucket.label,
      early: bucket.early,
      trade_share_pct: closedWithHold.length ? round(100 * bucketRows.length / closedWithHold.length) : 0,
      loss_rate_pct: bucketStats.outcomes ? round(100 * bucketStats.losses / bucketStats.outcomes) : null,
      loss_concentration_pct: totalLosses ? round(100 * bucketStats.losses / totalLosses) : null,
      ...bucketStats,
    };
  }).filter((row) => row.outcomes > 0);
}

function percentile(sorted: number[], probability: number) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * probability)));
  return sorted[index];
}

function createSeededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4_294_967_296;
  };
}

function monteCarloR(rows: Row[]) {
  const values = rows
    .filter((row) => ["WIN", "LOSS", "BREAKEVEN"].includes(text(row.outcome)))
    .map((row) => n(row.realized_r))
    .filter((value): value is number => value !== null);
  const simulations = values.length ? 500 : 0;
  const random = createSeededRandom(16012026);
  const endingR: number[] = [];
  const maxDrawdownsR: number[] = [];
  let losingPaths = 0;
  let drawdown20RPaths = 0;
  for (let simulation = 0; simulation < simulations; simulation += 1) {
    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;
    for (let index = 0; index < values.length; index += 1) {
      equity += values[Math.floor(random() * values.length)];
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak - equity);
    }
    endingR.push(equity);
    maxDrawdownsR.push(maxDrawdown);
    if (equity < 0) losingPaths += 1;
    if (maxDrawdown >= 20) drawdown20RPaths += 1;
  }
  endingR.sort((a, b) => a - b);
  maxDrawdownsR.sort((a, b) => a - b);
  return {
    method: "bootstrap_with_replacement",
    simulations,
    seed: 16012026,
    ending_r_p05: round(percentile(endingR, 0.05)),
    ending_r_p50: round(percentile(endingR, 0.5)),
    ending_r_p95: round(percentile(endingR, 0.95)),
    max_drawdown_p50_r: round(percentile(maxDrawdownsR, 0.5)),
    max_drawdown_p95_r: round(percentile(maxDrawdownsR, 0.95)),
    probability_of_loss_pct: simulations ? round(100 * losingPaths / simulations, 1) : 0,
    probability_of_20r_drawdown_pct: simulations ? round(100 * drawdown20RPaths / simulations, 1) : 0,
  };
}

function realtimeValidation(rows: Row[]) {
  const closed = rows
    .filter((row) => ["WIN", "LOSS", "BREAKEVEN"].includes(text(row.outcome)))
    .sort((a, b) => dateTimeKey(a.close_ts ?? a.filled_at ?? a.entry_datetime) - dateTimeKey(b.close_ts ?? b.filled_at ?? b.entry_datetime));
  const splitIndex = closed.length > 1 ? Math.min(closed.length - 1, Math.max(1, Math.floor(closed.length * 0.7))) : closed.length;
  const inSample = closed.slice(0, splitIndex);
  const outOfSample = closed.slice(splitIndex);
  const inStats = stats(inSample);
  const outStats = stats(outOfSample);
  const expectancyDegradation = inStats.expectancy_r
    ? 100 * (1 - (outStats.expectancy_r ?? 0) / inStats.expectancy_r)
    : null;
  const missing = {
    entry_price: closed.filter((row) => n(row.entry_price) === null).length,
    stoploss: closed.filter((row) => n(row.stoploss) === null).length,
    close_price: closed.filter((row) => n(row.close_price) === null).length,
    timestamps: closed.filter((row) => !(row.filled_at ?? row.entry_datetime) || !row.close_ts).length,
    quantity: closed.filter((row) => (n(row.qty) ?? 0) <= 0).length,
  };
  const checks = [
    { id: "sample_size", label: "At least 100 closed internal orders", passed: closed.length >= 100 },
    { id: "oos_sample", label: "At least 30 out-of-sample orders", passed: outOfSample.length >= 30 },
    { id: "broker_costs", label: "Broker fills and execution costs reconciled", passed: false },
    { id: "critical_fields", label: "Critical price and timestamp fields complete", passed: missing.entry_price + missing.stoploss + missing.close_price + missing.timestamps === 0 },
    { id: "oos_profitability", label: "Out-of-sample expectancy positive", passed: (outStats.expectancy_r ?? 0) > 0 },
    { id: "oos_profit_factor", label: "Out-of-sample profit factor above 1", passed: (outStats.profit_factor ?? 0) > 1 },
  ];
  const passedChecks = checks.filter((check) => check.passed).length;
  return {
    validation: {
      method: "chronological_holdout",
      oos_pct: 30,
      split_trade_index: splitIndex,
      split_timestamp: outOfSample[0]?.close_ts ?? null,
      in_sample: inStats,
      out_of_sample: outStats,
      expectancy_degradation_pct: expectancyDegradation === null ? null : round(expectancyDegradation),
    },
    monte_carlo: monteCarloR(closed),
    data_quality: {
      status: Object.values(missing).some((count) => count > 0) ? "REVIEW" : "PASS",
      closed_orders: closed.length,
      first_close_ts: closed[0]?.close_ts ?? null,
      last_close_ts: closed.at(-1)?.close_ts ?? null,
      missing,
      warnings: [
        "Performance is based on internal realtime orders, not broker-confirmed fills.",
        "Execution costs, spread, partial fills, market impact, borrow, tax, and regulatory fees are not modeled.",
        "This is a chronological holdout, not parameter-optimized walk-forward validation.",
        "Monte Carlo resamples observed realized R with replacement; it is path-risk evidence, not a forecast.",
      ],
    },
    deployment_gate: {
      status: passedChecks === checks.length ? "RESEARCH_PASSED_REVIEW_REQUIRED" : "NOT_READY",
      passed_checks: passedChecks,
      total_checks: checks.length,
      checks,
      note: "This review never approves live capital. Broker reconciliation, risk, operations, and execution approval remain mandatory.",
    },
  };
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const csvExport = sp.get("format") === "csv";
  const market = (sp.get("market") || "ALL").trim();
  const tickers = (sp.get("ticker") || "ALL").split(",").map((value) => value.trim().toUpperCase()).filter((value) => value && value !== "ALL");
  const strategies = (sp.get("strategy") || "ALL").split(",").map((value) => value.trim().toUpperCase()).filter((value) => value && value !== "ALL");
  const selectedIctSessions = parseIctSessionSelection(sp.get("ict_session"));
  const selectedIctSessionSet = selectedIctSessions === null ? null : new Set<string>(selectedIctSessions);
  const selectedPlannedRr = parsePlannedRrSelection(sp.get("planned_rr"));
  const selectedPlannedRrSet = selectedPlannedRr === null ? null : new Set<string>(selectedPlannedRr);
  const direction = (sp.get("direction") || "ALL").trim().toUpperCase();
  const status = (sp.get("status") || "ALL").trim().toUpperCase();
  const sourceMode = (sp.get("source_mode") || "ALL").trim().toUpperCase();
  const broker = (sp.get("broker") || "ALL").trim().toUpperCase();
  const smtFilter = parseSmtFilter(sp.get("smt"));
  const weeklyFilter = parseWeeklyFilter(sp.get("wp"));
  const rowsSource = broker === "OANDA" ? OANDA_EXECUTED_ROWS_SOURCE : REALTIME_ROWS_SOURCE;
  // Duplicate setups (later timeframe copy of the same ICT sweep extreme): EXCLUDE = one trade per setup (default),
  // INCLUDE = count the copies with their own outcome, ONLY = just the copies.
  const duplicatesParam = (sp.get("duplicates") || "").trim().toUpperCase();
  const duplicates = duplicatesParam === "INCLUDE" || duplicatesParam === "ONLY" ? duplicatesParam : "EXCLUDE";
  const requestedScoreModel = (sp.get("score_model") || "incumbent").trim();
  const allowedScoreModels = new Set([
    "incumbent",
    "s03_catboost_v2_stable_tp1",
    "s03_catboost_v2_stable_tp2",
  ]);
  const scoreModel = allowedScoreModels.has(requestedScoreModel) ? requestedScoreModel : "incumbent";
  const dateFrom = (sp.get("date_from") || "").trim();
  const dateTo = (sp.get("date_to") || "").trim();
  const minOptionDte = Math.max(0, Math.min(365, Number(sp.get("min_option_dte") || 0) || 0));
  const page = Math.max(1, Number(sp.get("page") || 1));
  const pageSize = Math.min(100, Math.max(10, Number(sp.get("page_size") || 25)));
  const sort = SORT_FIELDS[sp.get("sort") || "entry_datetime"] || "entry_datetime";
  const order = sp.get("order") === "asc" ? "asc" : "desc";

  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace("?", `$${params.length}`));
  };
  if (market !== "ALL") add("LOWER(r.market) = LOWER(?)", market);
  if (direction !== "ALL") add("UPPER(r.direction) = UPPER(?)", direction);
  // PENDING rows (resting limit orders) count as open, matching outcome().
  // With duplicates included, a DUPLICATE_SETUP row is judged by its own underlying state.
  const stateExpr = duplicates === "EXCLUDE" ? "r.state" : "CASE WHEN r.state = 'DUPLICATE_SETUP' THEN COALESCE(r.strategy_json->>'raw_state', r.state) ELSE r.state END";
  if (status === "OPEN") conditions.push(`(${stateExpr} = 'OPEN' OR ${stateExpr} LIKE '%PENDING%')`);
  if (status === "INVALID_EXECUTION") conditions.push(`${stateExpr} = 'INVALID_EXECUTION'`);
  if (status === "UNVERIFIED") conditions.push(`${stateExpr} = 'UNVERIFIED'`);
  if (status === "COMPLETED") conditions.push(`${stateExpr} LIKE 'CLOSED%'`);
  if (sourceMode === "REALTIME" || sourceMode === "BACKFILL") add("r.strategy_json->>'source_mode' = ?",sourceMode);
  const localEntryDate="(COALESCE(r.filled_at,r.entry_datetime) AT TIME ZONE COALESCE(NULLIF(r.exchange_timezone,''),CASE WHEN LOWER(r.market)='india' THEN 'Asia/Kolkata' ELSE 'America/New_York' END))::date";
  if(dateFrom)add(`${localEntryDate} >= ?::date`,dateFrom);
  if(dateTo)add(`${localEntryDate} <= ?::date`,dateTo);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    // Source raw rows either directly from Postgres or, when the app is deployed
    // without DB access (e.g. Vercel), from the local REST API bridge. All the
    // timezone-aware aggregation below runs identically on either source.
    let rawRows: Record<string, unknown>[];
    const restApiUrl = process.env.CANDLES_REST_API_URL;
    if (restApiUrl) {
      const upstream = new URL("/api/realtime-analytics/rows", restApiUrl);
      for (const [key, value] of sp.entries()) upstream.searchParams.set(key, value);
      // Fetch the filter universe and apply multi-ticker/session filtering here;
      // the bridge remains compatible with its original single-ticker contract.
      upstream.searchParams.set("ticker", "ALL");
      upstream.searchParams.set("strategy", "ALL");
      const upstreamResponse = await fetch(upstream, {
        headers: process.env.CANDLES_REST_API_TOKEN ? { "x-api-key": process.env.CANDLES_REST_API_TOKEN } : undefined,
        cache: "no-store",
      });
      const payload = await upstreamResponse.json();
      if (!upstreamResponse.ok || payload?.success === false) {
        return NextResponse.json({ success: false, error: payload?.error || `REST API error (${upstreamResponse.status})` }, { status: upstreamResponse.ok ? 502 : upstreamResponse.status });
      }
      rawRows = (payload.rows ?? []) as Record<string, unknown>[];
    } else {
      const pool = getPostgresPool();
      const result = await pool.query(
        `SELECT r.* FROM ${rowsSource} r
         ${where}
         ORDER BY r.entry_datetime DESC NULLS LAST
         ${dateFrom&&dateTo||csvExport?"":"LIMIT 10000"}`,
        params,
      );
      rawRows = result.rows as Record<string, unknown>[];
    }

    const normalizedAll = rawRows.map((sourceRow): Row => {
      const raw = withOandaExecution(sourceRow);
      const strategyJson = objectValue(raw.strategy_json);
      const mlScore = objectValue(strategyJson.ml_score);
      const mlScoreStatus = objectValue(strategyJson.ml_score_status);
      const mlScores = objectValue(strategyJson.ml_scores);
      const mlScoreStatuses = objectValue(strategyJson.ml_score_statuses);
      const selectedMlScore = scoreModel === "incumbent" ? mlScore : objectValue(mlScores[scoreModel]);
      const selectedMlStatus = scoreModel === "incumbent"
        ? mlScoreStatus
        : objectValue(mlScoreStatuses.s03_catboost_v2_stable);
      const entry = n(raw.filled_price) ?? n(raw.entry_price) ?? n(raw.signal_entry_price);
      const stop = n(raw.stoploss) ?? n(raw.signal_stoploss);
      const close = n(raw.close_price);
      const directionUpper = text(raw.direction).toUpperCase();
      const riskPoints = entry !== null && stop !== null ? Math.abs(entry - stop) : null;
      const pnlPoints = entry !== null && close !== null
        ? (directionUpper === "SELL" ? entry - close : close - entry)
        : null;
      const computedR = riskPoints && riskPoints > 0 && pnlPoints !== null ? pnlPoints / riskPoints : null;
      // Broker-reconciled sources (IGS01V2 / OANDA) carry their own realized R.
      const realizedR = n(raw.live_realized_r) ?? computedR;
      const plannedRr = riskPoints && riskPoints > 0 && n(raw.target_1) !== null && entry !== null
        ? Math.abs(n(raw.target_1)! - entry) / riskPoints
        : null;
      const timezone = marketTimezone(text(raw.market), text(raw.exchange_timezone));
      const local = localDate(raw.filled_at ?? raw.entry_datetime, timezone);
      const isDuplicate = text(raw.state).toUpperCase() === "DUPLICATE_SETUP";
      const state = isDuplicate && duplicates !== "EXCLUDE" ? text(strategyJson.raw_state) || text(raw.state) : text(raw.state);
      const rowOutcome = outcome(state, realizedR);
      const qty = n(raw.qty);
      const holdMinutes = rowOutcome === "OPEN" || !raw.close_ts
        ? null
        : minutesBetween(raw.filled_at ?? raw.entry_datetime, raw.close_ts);
      const signalTimeframe = text(objectValue(raw.strategy_json).timeframe) || (/-1d$/i.test(text(raw.strategy_id)) ? "1d" : "");
      const entryClockAt = entryClockTimestamp(raw.filled_at ?? raw.entry_datetime, signalTimeframe, timezone);
      const ictSessionIds = getIctSessionIds(
        entryClockAt,
        text(raw.market),
        text(raw.ticker),
      );
      return {
        ...raw,
        strategy_json: raw.strategy_json ?? null,
        signal_timeframe: text(objectValue(raw.strategy_json).timeframe) || null,
        entry_price: entry,
        stoploss: stop,
        tp1: n(raw.tp1) ?? n(raw.target_1),
        tp2: n(raw.tp2) ?? n(raw.target_2),
        tp3: n(raw.tp3) ?? n(raw.target_3),
        risk_points: riskPoints === null ? null : round(riskPoints, 4),
        planned_rr: plannedRr === null ? null : round(plannedRr),
        pnl_points: pnlPoints === null ? null : round(pnlPoints, 4),
        realized_r: realizedR,
        pnl_value: qty && qty > 0 && pnlPoints !== null ? round(qty * pnlPoints) : null,
        hold_minutes: holdMinutes === null ? null : round(holdMinutes),
        outcome: rowOutcome,
        risk_probability: scoreModel === "incumbent"
          ? n(raw.risk_probability) ?? n(selectedMlScore.prob)
          : n(selectedMlScore.prob),
        risk_bin: scoreModel === "incumbent"
          ? n(raw.risk_bin) ?? n(selectedMlScore.bin)
          : n(selectedMlScore.bin),
        risk_n_bins: scoreModel === "incumbent"
          ? n(selectedMlScore.n_bins) ?? 10
          : n(selectedMlScore.n_bins) ?? 5,
        ml_score_status: Object.keys(selectedMlStatus).length ? selectedMlStatus : null,
        ml_model_version: text(selectedMlScore.model_version) || text(selectedMlStatus.model_version) || null,
        timezone,
        local_date: local,
        entry_clock_at: entryClockAt,
        ict_session_ids: ictSessionIds,
      };
    });
    // Apply date boundaries after converting each row to its market-local trading
    // date. PostgreSQL session dates would otherwise shift India/US rows around
    // midnight and disagree with the IST/ET dates shown in the interface.
    const dateScoped = normalizedAll.filter((row) => {
      const date = text(row.local_date);
      if (!date) return !dateFrom && !dateTo;
      if (dateFrom && date < dateFrom) return false;
      if (dateTo && date > dateTo) return false;
      return true;
    });
    const preSmt = dateScoped.filter((row) => {
      if (minOptionDte > 0) {
        const dte = n(objectValue(objectValue(row.strategy_json).atm_option).days_to_expiry);
        if (dte === null || dte < minOptionDte) return false;
      }
      if ((sourceMode === "REALTIME" || sourceMode === "BACKFILL") && objectValue(row.strategy_json).source_mode !== sourceMode) return false;
      if (duplicates === "ONLY" && !objectValue(row.strategy_json).duplicate_of) return false;
      if (tickers.length && !tickers.includes(text(row.ticker).toUpperCase())) return false;
      if (strategies.length && !strategies.includes(text(row.strategy_id).toUpperCase())) return false;
      if (selectedIctSessionSet !== null) {
        const rowSessions = Array.isArray(row.ict_session_ids) ? row.ict_session_ids.map(text) : [];
        if (!passesIctSessionFilter(rowSessions, selectedIctSessionSet)) return false;
      }
      if (selectedPlannedRrSet !== null) {
        // Rows without a computable planned R:R drop out once any bucket is deselected.
        const bucket = plannedRrBucketId(n(row.planned_rr));
        if (bucket === null || !selectedPlannedRrSet.has(bucket)) return false;
      }
      return true;
    });
    // SMT divergence vs the index / correlated peer at signal time (cached per trade).
    const smtKey = (row: Row) => `realtime:${text(row.order_id) || text(row.signal_hash)}`;
    let smtResults = new Map<string, SmtResult>();
    try {
      smtResults = await smtForTrades(getPostgresPool(), preSmt.map((row) => ({
        key: smtKey(row), symbol: text(row.ticker) || null, market: text(row.market) || null,
        signalTs: (row.entry_datetime ?? row.filled_at ?? null) as string | null, direction: text(row.direction) || null,
      })), Math.min(1000, Math.max(0, Number(sp.get("smt_batch") || 150) || 150)));
    } catch {
      /* SMT is advisory: without the database path the rows simply carry no SMT */
    }
    // ICT weekly profile at signal time (live = known at the signal; hindsight = label once the week is done).
    let wpResults = new Map<string, WeeklyProfileResult>();
    try {
      wpResults = await weeklyProfilesForTrades(getPostgresPool(), preSmt.map((row) => ({
        key: smtKey(row), symbol: text(row.ticker) || null, market: text(row.market) || null,
        signalTs: (row.entry_datetime ?? row.filled_at ?? null) as string | null, direction: text(row.direction) || null,
      })), Math.min(1000, Math.max(0, Number(sp.get("wp_batch") || 150) || 150)));
    } catch {
      /* weekly profile is advisory */
    }
    const withSmt = preSmt.map((row): Row => {
      const smt = smtResults.get(smtKey(row));
      const wp = wpResults.get(smtKey(row));
      return { ...row, smt: smt ?? null, smt_group: smtGroup(smt), weekly_profile: wp ?? null, wp_group: weeklyLiveGroup(wp), wp_hindsight_group: weeklyHindsightGroup(wp) };
    });
    const normalized = withSmt.filter((row) => passesSmtFilter((row.smt as SmtResult | null) ?? undefined, smtFilter)
      && passesWeeklyFilter((row.weekly_profile as WeeklyProfileResult | null) ?? undefined, weeklyFilter));

    const sortValue = (row: Row) => {
      if (sort === "entry_datetime" || sort === "close_ts") {
        const value = dateTimeKey(row[sort]);
        // Missing/invalid timestamps belong at the end for either direction.
        return Number.isFinite(value) ? value : (order === "asc" ? Infinity : -Infinity);
      }
      if (["realized_r", "risk_probability", "risk_bin"].includes(sort)) {
        const value = n(row[sort]);
        // Keep unscored rows at the end in both directions. They must not be
        // mixed into a numeric comparison as empty strings.
        return value ?? (order === "asc" ? Infinity : -Infinity);
      }
      return text(row[sort]);
    };
    const sorted = [...normalized].sort((a, b) => {
      const av = sortValue(a); const bv = sortValue(b);
      const comparison = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      if (comparison !== 0) return order === "asc" ? comparison : -comparison;
      const tieBreaker = `${text(a.signal_hash)}-${text(a.order_id)}`.localeCompare(`${text(b.signal_hash)}-${text(b.order_id)}`);
      return order === "asc" ? tieBreaker : -tieBreaker;
    });
    if (csvExport) {
      const filename = `realtime-trades-${new Date().toISOString().slice(0, 10)}.csv`;
      return csvDownloadResponse(realtimeCsv(sorted, sp.get("columns")), filename, sorted.length);
    }

    const performanceRows = normalized.filter((row) => row.order_id);
    const latestByMarket: Record<string, { market: string; timezone: string; date: string; orders: number; last_7_days: number; last_30_days: number }> = {};
    for (const row of performanceRows) {
      const key = text(row.market).toLowerCase() || "unknown";
      const date = text(row.local_date);
      if (!date) continue;
      if (!latestByMarket[key] || date > latestByMarket[key].date) {
        latestByMarket[key] = { market: text(row.market), timezone: text(row.timezone), date, orders: 0, last_7_days: 0, last_30_days: 0 };
      }
    }
    for (const item of Object.values(latestByMarket)) {
      const marketRows = performanceRows.filter((row) => text(row.market).toLowerCase() === item.market.toLowerCase());
      item.orders = marketRows.filter((row) => text(row.local_date) === item.date).length;
      item.last_7_days = marketRows.filter((row) => {
        const diff = daysBetween(text(row.local_date), item.date);
        return diff >= 0 && diff < 7;
      }).length;
      item.last_30_days = marketRows.filter((row) => {
        const diff = daysBetween(text(row.local_date), item.date);
        return diff >= 0 && diff < 30;
      }).length;
    }

    const dailyMap = new Map<string, { date: string; signals: number; buy: number; sell: number; net_r: number; wins: number; losses: number }>();
    for (const row of normalized) {
      const date = text(row.local_date) || localDate(row.entry_datetime, text(row.timezone));
      if (!date) continue;
      const item = dailyMap.get(date) ?? { date, signals: 0, buy: 0, sell: 0, net_r: 0, wins: 0, losses: 0 };
      item.signals += 1;
      item.buy += text(row.direction).toUpperCase() === "BUY" ? 1 : 0;
      item.sell += text(row.direction).toUpperCase() === "SELL" ? 1 : 0;
      item.net_r += n(row.realized_r) ?? 0;
      item.wins += row.outcome === "WIN" ? 1 : 0;
      item.losses += row.outcome === "LOSS" ? 1 : 0;
      dailyMap.set(date, item);
    }
    const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map((item) => ({ ...item, net_r: round(item.net_r), win_rate_pct: item.wins + item.losses ? round(100 * item.wins / (item.wins + item.losses)) : null }));
    const closedChronological = performanceRows
      .filter((row) => ["WIN", "LOSS", "BREAKEVEN"].includes(text(row.outcome)))
      .sort((a, b) => dateTimeKey(a.close_ts ?? a.filled_at ?? a.entry_datetime) - dateTimeKey(b.close_ts ?? b.filled_at ?? b.entry_datetime));
    let cumulative = 0;
    let equityPeak = 0;
    const equity = closedChronological.map((row) => {
      const realizedR = n(row.realized_r) ?? 0;
      cumulative += realizedR;
      equityPeak = Math.max(equityPeak, cumulative);
      return {
        date: text(row.close_ts ?? row.filled_at ?? row.entry_datetime ?? row.local_date),
        daily_r: round(realizedR),
        equity_r: round(cumulative),
        drawdown_r: round(cumulative - equityPeak),
      };
    });

    // Day-of-week P&L and the weekday x time heatmap are built from the SAME
    // closed trades (WIN/LOSS/BREAKEVEN, entry weekday in market time), so each
    // day's bar always equals the sum of that day's heatmap column.
    // Win rate = wins / (wins + losses); breakevens count in n and net R only.
    const SLOT_MINUTES = 30;
    const clockFormatters = new Map<string, Intl.DateTimeFormat>();
    const entryClock = (value: unknown, timeZone: string) => {
      const date = new Date(text(value));
      if (!Number.isFinite(date.getTime())) return null;
      let formatter = clockFormatters.get(timeZone);
      if (!formatter) {
        try {
          formatter = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
        } catch {
          formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
        }
        clockFormatters.set(timeZone, formatter);
      }
      const parts = formatter.formatToParts(date);
      const day = parts.find((part) => part.type === "weekday")?.value;
      const hour = Number(parts.find((part) => part.type === "hour")?.value);
      const minute = Number(parts.find((part) => part.type === "minute")?.value);
      if (!day || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
      return { day, slot: Math.floor(((hour % 24) * 60 + minute) / SLOT_MINUTES) * SLOT_MINUTES };
    };
    type DayTimeCell = { day: string; slot: number; wins: number; losses: number; breakeven: number; net_r: number };
    const emptyCell = (day: string, slot: number): DayTimeCell => ({ day, slot, wins: 0, losses: 0, breakeven: 0, net_r: 0 });
    const addOutcome = (cell: DayTimeCell, row: Row) => {
      cell.wins += row.outcome === "WIN" ? 1 : 0;
      cell.losses += row.outcome === "LOSS" ? 1 : 0;
      cell.breakeven += row.outcome === "BREAKEVEN" ? 1 : 0;
      cell.net_r += n(row.realized_r) ?? 0;
    };
    const finishCell = (cell: DayTimeCell) => {
      const decided = cell.wins + cell.losses;
      return { ...cell, n: decided + cell.breakeven, net_r: round(cell.net_r), win_rate_pct: decided ? round(100 * cell.wins / decided) : null };
    };
    const weekdayTimeMap = new Map<string, DayTimeCell>();
    const weekdayTotals = new Map<string, DayTimeCell>();
    for (const row of normalized) {
      if (row.outcome !== "WIN" && row.outcome !== "LOSS" && row.outcome !== "BREAKEVEN") continue;
      const at = entryClock(row.entry_clock_at ?? row.filled_at ?? row.entry_datetime, text(row.timezone) || "America/New_York");
      if (!at) continue;
      const key = `${at.day}|${at.slot}`;
      const cell = weekdayTimeMap.get(key) ?? emptyCell(at.day, at.slot);
      addOutcome(cell, row);
      weekdayTimeMap.set(key, cell);
      const total = weekdayTotals.get(at.day) ?? emptyCell(at.day, -1);
      addOutcome(total, row);
      weekdayTotals.set(at.day, total);
    }
    const weekday_time = [...weekdayTimeMap.values()].map((cell) => ({
      ...finishCell(cell),
      label: `${String(Math.floor(cell.slot / 60)).padStart(2, "0")}:${String(cell.slot % 60).padStart(2, "0")}`,
    }));
    const WEEKDAY_ORDER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const weekdays = WEEKDAY_ORDER
      .filter((day) => weekdayTotals.has(day) || ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(day))
      .map((day) => {
        const { wins, losses, breakeven, n: closed, net_r, win_rate_pct } = finishCell(weekdayTotals.get(day) ?? emptyCell(day, -1));
        return { day, wins, losses, breakeven, n: closed, net_r, win_rate_pct, expectancy_r: closed ? round(net_r / closed) : null };
      });

    const monthMap = new Map<string, { month: string; signals: number; wins: number; losses: number; net_r: number }>();
    for (const item of daily) {
      const key = item.date.slice(0, 7);
      const month = monthMap.get(key) ?? { month: key, signals: 0, wins: 0, losses: 0, net_r: 0 };
      month.signals += item.signals; month.wins += item.wins; month.losses += item.losses; month.net_r += item.net_r;
      monthMap.set(key, month);
    }
    const monthly = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month)).map((item) => ({ ...item, net_r: round(item.net_r), win_rate_pct: item.wins + item.losses ? round(100 * item.wins / (item.wins + item.losses)) : null }));

    const groups = new Map<string, Row[]>();
    for (const row of normalized) {
      const key = text(row.strategy_id) || "Unknown";
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const strategyPerformance = [...groups.entries()].map(([strategyId, rows]) => ({ strategy_id: strategyId, strategy_name: text(rows[0]?.strategy), orders: rows.filter((row) => row.order_id).length, ...stats(rows.filter((row) => row.order_id)) })).sort((a, b) => b.orders - a.orders);
    const totalSignals = Math.max(normalized.length, 1);
    const strategyCoverage = [...groups.entries()].map(([strategyId, rows]) => ({
      strategy_id: strategyId,
      strategy_name: text(rows[0]?.strategy),
      signals: rows.length,
      buy: rows.filter((row) => text(row.direction).toUpperCase() === "BUY").length,
      sell: rows.filter((row) => text(row.direction).toUpperCase() === "SELL").length,
      tickers: new Set(rows.map((row) => text(row.ticker))).size,
      avg_risk_points: rows.some((row) => n(row.risk_points) !== null) ? round(rows.reduce((sum, row) => sum + (n(row.risk_points) ?? 0), 0) / rows.filter((row) => n(row.risk_points) !== null).length, 4) : null,
      share_pct: round(100 * rows.length / totalSignals),
    })).sort((a, b) => b.signals - a.signals);

    const tickerGroups = new Map<string, Row[]>();
    for (const row of normalized) {
      const key = text(row.ticker) || "Unknown";
      tickerGroups.set(key, [...(tickerGroups.get(key) ?? []), row]);
    }
    const totalOrders = Math.max(performanceRows.length, 1);
    const tickerDistribution = [...tickerGroups.entries()].map(([tickerId, rows]) => {
      const linkedOrders = rows.filter((row) => row.order_id);
      const rowStats = stats(linkedOrders);
      const rValues = linkedOrders.map((row) => n(row.realized_r)).filter((value): value is number => value !== null);
      return {
        ticker: tickerId,
        signals: rows.length,
        orders: linkedOrders.length,
        share_pct: round(100 * linkedOrders.length / totalOrders),
        win_rate_pct: rowStats.win_rate_pct,
        win_r: round(rValues.filter((value) => value > 0).reduce((sum, value) => sum + value, 0)),
        net_r: rowStats.net_r,
      };
    }).filter((row) => row.orders > 0).sort((a, b) => b.orders - a.orders || a.ticker.localeCompare(b.ticker));

    const sessionPerformance = ICT_SESSION_DEFINITIONS.filter((session) => selectedIctSessionSet === null || selectedIctSessionSet.has(session.id)).map((session) => {
      const rows = normalized.filter((row) => Array.isArray(row.ict_session_ids) && row.ict_session_ids.includes(session.id));
      const linkedOrders = rows.filter((row) => row.order_id);
      return {
        session_id: session.id,
        label: ictSessionDisplayLabel(session.id),
        signals: rows.length,
        orders: linkedOrders.length,
        ...stats(linkedOrders),
      };
    }).filter((row) => row.signals > 0);

    const scoreBandCount = scoreModel === "incumbent" ? 10 : 5;
    const riskBinGroups = new Map<number | null, Row[]>();
    for (const row of normalized) {
      const rawBin = n(row.risk_bin);
      const riskBin = rawBin !== null && Number.isInteger(rawBin) && rawBin >= 1 && rawBin <= scoreBandCount ? rawBin : null;
      riskBinGroups.set(riskBin, [...(riskBinGroups.get(riskBin) ?? []), row]);
    }
    const riskBinPerformance = [...riskBinGroups.entries()].map(([riskBin, rows]) => {
      const linkedOrders = rows.filter((row) => row.order_id);
      const closedStats = stats(linkedOrders);
      const scoredProbabilities = rows.map((row) => n(row.risk_probability)).filter((value): value is number => value !== null);
      return {
        risk_bin: riskBin,
        label: riskBin === null ? "Unscored" : `Bin ${riskBin}/${scoreBandCount}`,
        signals: rows.length,
        orders: linkedOrders.length,
        open: linkedOrders.filter((row) => text(row.outcome) === "OPEN").length,
        avg_risk_probability_pct: scoredProbabilities.length
          ? round(100 * scoredProbabilities.reduce((sum, value) => sum + value, 0) / scoredProbabilities.length)
          : null,
        loss_rate_pct: closedStats.outcomes ? round(100 * closedStats.losses / closedStats.outcomes) : null,
        ...closedStats,
      };
    }).sort((a, b) => {
      if (a.risk_bin === null) return 1;
      if (b.risk_bin === null) return -1;
      return a.risk_bin - b.risk_bin;
    });

    const rrBins = [
      { label: "Loss <= -1R", min: -Infinity, max: -1 },
      { label: "-1R to 0R", min: -1, max: 0 },
      { label: "0R to 1R", min: 0, max: 1 },
      { label: "1R to 2R", min: 1, max: 2 },
      { label: "2R to 3R", min: 2, max: 3 },
      { label: "3R+", min: 3, max: Infinity },
    ].map((bin) => ({ label: bin.label, count: performanceRows.filter((row) => {
      const value = n(row.realized_r);
      return value !== null && value >= bin.min && value < bin.max;
    }).length }));

    const start = (page - 1) * pageSize;
    const directionPerformance = [
      { label: "All", direction: "ALL", ...stats(performanceRows) },
      { label: "BUY", direction: "BUY", ...stats(performanceRows.filter((row) => text(row.direction).toUpperCase() === "BUY")) },
      { label: "SELL", direction: "SELL", ...stats(performanceRows.filter((row) => text(row.direction).toUpperCase() === "SELL")) },
    ];
    const yearGroups = new Map<string, Row[]>();
    for (const row of performanceRows.filter((item) => ["WIN", "LOSS", "BREAKEVEN"].includes(text(item.outcome)))) {
      const timestamp = row.close_ts ?? row.filled_at ?? row.entry_datetime;
      const parsed = timestamp ? new Date(String(timestamp)) : null;
      const year = parsed && !Number.isNaN(parsed.getTime()) ? String(parsed.getUTCFullYear()) : "Unknown";
      yearGroups.set(year, [...(yearGroups.get(year) ?? []), row]);
    }
    const yearPerformance = [...yearGroups.entries()]
      .map(([year, rows]) => ({ year, ...stats(rows) }))
      .sort((a, b) => b.year.localeCompare(a.year));
    const validation = realtimeValidation(performanceRows);
    const smtPerformance = ["SMT with the trade", "SMT against the trade", "No SMT at signal", "No peer data", "Pending"]
      .map((group) => ({ group, ...stats(performanceRows.filter((row) => row.smt_group === group)) }))
      .filter((row) => row.outcomes > 0 || performanceRows.some((r) => r.smt_group === row.group));
    const groupPerformance = (field: string) => [...new Set(performanceRows.map((row) => text(row[field]) || "Pending"))]
      .map((group) => ({ group, ...stats(performanceRows.filter((row) => (text(row[field]) || "Pending") === group)) }))
      .sort((a, b) => b.outcomes - a.outcomes);
    const weeklyProfilePerformance = groupPerformance("wp_group");
    const weeklyHindsightPerformance = groupPerformance("wp_hindsight_group");

    return NextResponse.json({
      success: true,
      generated_at: new Date().toISOString(),
      data_as_of: normalized[0]?.entry_datetime ?? null,
      calculation_version: "realtime-analytics-v3",
      filters: {
        markets: [...new Set(dateScoped.map((row) => text(row.market)).filter(Boolean))].sort(),
        tickers: [...new Set(dateScoped.map((row) => text(row.ticker)).filter(Boolean))].sort(),
        strategies: [...new Set(dateScoped.map((row) => text(row.strategy_id)).filter(Boolean))].sort(),
      },
      query: { market, tickers, strategies, ict_sessions: selectedIctSessions, planned_rr: selectedPlannedRr, direction, status, duplicates, score_model: scoreModel, date_from: dateFrom, date_to: dateTo, min_option_dte: minOptionDte, page, page_size: pageSize, sort, order },
      counts: { latest_by_market: Object.values(latestByMarket), signals: normalized.length, orders: performanceRows.length, open: performanceRows.filter((row) => row.outcome === "OPEN").length, duplicate_setup: performanceRows.filter((row) => row.outcome === "DUPLICATE_SETUP").length, invalid_execution: performanceRows.filter((row) => row.outcome === "INVALID_EXECUTION").length, unverified: performanceRows.filter((row) => row.outcome === "UNVERIFIED").length, completed: performanceRows.filter((row) => ["WIN", "LOSS", "BREAKEVEN"].includes(text(row.outcome))).length },
      summary: { strategies: new Set(normalized.map((row) => row.strategy_id)).size, tickers: new Set(normalized.map((row) => row.ticker)).size, buy_setups: normalized.filter((row) => text(row.direction).toUpperCase() === "BUY").length, sell_setups: normalized.filter((row) => text(row.direction).toUpperCase() === "SELL").length, avg_risk_points: normalized.some((row) => n(row.risk_points) !== null) ? round(normalized.reduce((sum, row) => sum + (n(row.risk_points) ?? 0), 0) / normalized.filter((row) => n(row.risk_points) !== null).length, 4) : null, avg_planned_rr: normalized.some((row) => n(row.planned_rr) !== null) ? round(normalized.reduce((sum, row) => sum + (n(row.planned_rr) ?? 0), 0) / normalized.filter((row) => n(row.planned_rr) !== null).length) : null, ...stats(performanceRows) },
      series: { daily, monthly, equity, weekdays, weekday_time, rr_distribution: rrBins },
      strategy_performance: strategyPerformance,
      strategy_coverage: strategyCoverage,
      ticker_distribution: tickerDistribution,
      session_performance: sessionPerformance,
      risk_bin_performance: riskBinPerformance,
      direction_performance: directionPerformance,
      smt_performance: smtPerformance,
      weekly_profile_performance: weeklyProfilePerformance,
      weekly_profile_hindsight_performance: weeklyHindsightPerformance,
      year_performance: yearPerformance,
      hold_time_performance: holdTimePerformance(performanceRows),
      validation: validation.validation,
      monte_carlo: validation.monte_carlo,
      data_quality: validation.data_quality,
      deployment_gate: validation.deployment_gate,
      open_orders: performanceRows.filter((row) => row.outcome === "OPEN").slice(0, 100),
      outcomes_ledger: performanceRows.filter((row) => ["WIN", "LOSS", "BREAKEVEN"].includes(text(row.outcome))).slice(0, 200),
      pagination: { page, page_size: pageSize, total: normalized.length, pages: Math.max(1, Math.ceil(normalized.length / pageSize)) },
      rows: sorted.slice(start, start + pageSize),
      warnings: ["Performance metrics use internal realtime orders, not broker fills.", "Currency P&L is unavailable when stored quantity is zero; R and points remain available.", "Hold time runs from filled_at (or entry_datetime when unavailable) through close_ts.", "Sharpe is annualized from daily realized R.", "Kelly, break-even win rate and risk of ruin are derived from the realized win rate and payoff ratio; risk of ruin assumes 1% risk per trade (100 risk units).", "ICT session windows may overlap; a trade is attributed to every matching DST-aware window."],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Postgres error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
