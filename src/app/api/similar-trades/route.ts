import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HISTORICAL_SIGNALS = "historical_ict_strategy_met_execution_updated";
const HISTORICAL_ORDERS = "historical_ict_orders_updated";
const HISTORICAL_OUTCOMES = "historical_ict_order_target_outcomes_updated";

type Row = Record<string, unknown>;
type Feature = { key: string; label: string; weight: number };

const ICT_FEATURES: Feature[] = [
  { key: "five_min_relevant_order_block", label: "5m order blocks", weight: 5 },
  { key: "five_min_relevant_fvg", label: "5m FVG", weight: 5 },
  { key: "five_min_relevant_liquidity_levels", label: "5m liquidity", weight: 4 },
  { key: "five_min_relevant_swings", label: "5m swings", weight: 3 },
  { key: "five_min_relevant_bos_mss_choch", label: "5m structure", weight: 5 },
  { key: "fifteen_min_relevant_order_block", label: "15m order blocks", weight: 4 },
  { key: "fifteen_min_relevant_fvg", label: "15m FVG", weight: 4 },
  { key: "fifteen_min_relevant_liquidity_levels", label: "15m liquidity", weight: 3 },
  { key: "fifteen_min_relevant_swings", label: "15m swings", weight: 2 },
  { key: "fifteen_min_relevant_bos_mss_choch", label: "15m structure", weight: 4 },
  { key: "thirty_min_relevant_order_block", label: "30m order blocks", weight: 3 },
  { key: "thirty_min_relevant_fvg", label: "30m FVG", weight: 3 },
  { key: "thirty_min_relevant_liquidity_levels", label: "30m liquidity", weight: 2 },
  { key: "thirty_min_relevant_swings", label: "30m swings", weight: 2 },
  { key: "thirty_min_relevant_bos_mss_choch", label: "30m structure", weight: 3 },
  { key: "one_hour_relevant_order_block", label: "1h order blocks", weight: 2 },
  { key: "one_hour_relevant_fvg", label: "1h FVG", weight: 2 },
  { key: "one_hour_relevant_liquidity_levels", label: "1h liquidity", weight: 2 },
  { key: "one_hour_relevant_swings", label: "1h swings", weight: 1 },
  { key: "one_hour_relevant_bos_mss_choch", label: "1h structure", weight: 2 },
  { key: "daily_relevant_order_block", label: "daily order blocks", weight: 1 },
  { key: "daily_relevant_fvg", label: "daily FVG", weight: 1 },
  { key: "daily_relevant_liquidity_levels", label: "daily liquidity", weight: 1 },
  { key: "daily_relevant_swings", label: "daily swings", weight: 1 },
  { key: "daily_relevant_bos_mss_choch", label: "daily structure", weight: 1 },
];

const BIAS_FEATURES: Feature[] = [
  { key: "five_min_bias", label: "5m bias", weight: 4 },
  { key: "fifteen_min_bias", label: "15m bias", weight: 4 },
  { key: "thirty_min_bias", label: "30m bias", weight: 3 },
  { key: "one_hour_bias", label: "1h bias", weight: 3 },
  { key: "daily_bias", label: "daily bias", weight: 2 },
  { key: "weekly_bias", label: "weekly bias", weight: 1 },
];

const SIGNAL_COLUMNS = [
  "signal_hash", "market", "ticker", "direction", "entry_datetime", "strategy_id",
  ...BIAS_FEATURES.map((feature) => feature.key),
  ...ICT_FEATURES.map((feature) => feature.key),
];

function signalFields(alias = "") {
  return SIGNAL_COLUMNS.map((column) => `${alias}${column}`).join(", ");
}

function n(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function contentTokens(value: unknown): Set<string> {
  const tokens = new Set<string>();
  const allowed = /\b(order[ _-]?block|fvg|ifvg|liquidity|swing|bos|mss|choch|breaker|bull(?:ish)?|bear(?:ish)?|buy|sell|high|low)\b/gi;
  const visit = (item: unknown, key = "") => {
    if (item === null || item === undefined) return;
    if (typeof item === "string") {
      if (!key || /(type|kind|direction|side|event|label|structure|bias|zone)/i.test(key)) {
        for (const match of item.matchAll(allowed)) tokens.add(match[1].toLowerCase().replace(/[ _-]/g, "_"));
      }
      return;
    }
    if (Array.isArray(item)) {
      item.slice(0, 20).forEach((child) => visit(child, key));
      return;
    }
    if (typeof item === "object") {
      for (const [childKey, child] of Object.entries(item as Row)) visit(child, childKey);
    }
  };
  visit(value);
  return tokens;
}

function hasEvidence(value: unknown) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === "object" && Object.keys(value as Row).length);
}

function overlap(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return left.size === right.size ? 1 : 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  return common / new Set([...left, ...right]).size;
}

function realizedR(row: Row): number | null {
  const reason = normalized(row.close_reason);
  if (reason === "target_hit") return n(row.target_rr_filled) ?? n(row.target_rr);
  if (reason === "stoploss_hit") return -1;
  const entry = n(row.filled_price) ?? n(row.entry_price);
  const stop = n(row.stoploss);
  const close = n(row.close_price);
  if (entry === null || stop === null || close === null || entry === stop) return null;
  return normalized(row.direction) === "sell" ? (entry - close) / Math.abs(entry - stop) : (close - entry) / Math.abs(entry - stop);
}

function scoreSimilarity(current: Row, candidate: Row) {
  let earned = 0;
  let possible = 0;
  const matched: string[] = [];
  const add = (weight: number, match: number, label: string) => {
    possible += weight;
    earned += weight * match;
    if (match >= 0.999) matched.push(label);
  };
  add(8, normalized(current.direction) === normalized(candidate.direction) ? 1 : 0, "direction");
  add(4, normalized(current.market) === normalized(candidate.market) ? 1 : 0, "market");
  for (const feature of BIAS_FEATURES) {
    const left = normalized(current[feature.key]);
    const right = normalized(candidate[feature.key]);
    if (left && right) add(feature.weight, left === right ? 1 : 0, feature.label);
  }
  for (const feature of ICT_FEATURES) {
    const left = current[feature.key];
    const right = candidate[feature.key];
    if (!hasEvidence(left) && !hasEvidence(right)) continue;
    const tokenScore = overlap(contentTokens(left), contentTokens(right));
    const presenceScore = hasEvidence(left) === hasEvidence(right) ? 0.5 : 0;
    add(feature.weight, Math.max(tokenScore, presenceScore), feature.label);
  }
  return { score: possible ? Math.round((earned / possible) * 100) : 0, matched: matched.slice(0, 6) };
}

function toIso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return value ? String(value) : null;
}

function resultSummary(rows: Array<Row & { similarity_score: number; realized_r: number | null }>) {
  const closed = rows.filter((row) => row.realized_r !== null);
  const wins = closed.filter((row) => (row.realized_r ?? 0) > 0);
  const averageR = closed.length ? closed.reduce((sum, row) => sum + (row.realized_r ?? 0), 0) / closed.length : null;
  const winRate = closed.length ? (wins.length / closed.length) * 100 : null;
  const topMatches = rows.slice(0, 5);
  const common = new Map<string, number>();
  for (const row of topMatches) for (const label of (row.matched_features as string[])) common.set(label, (common.get(label) ?? 0) + 1);
  const strongest = [...common.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([label]) => label);
  return {
    sample_size: rows.length,
    closed_count: closed.length,
    win_rate_pct: winRate === null ? null : Math.round(winRate * 10) / 10,
    average_realized_r: averageR === null ? null : Math.round(averageR * 100) / 100,
    average_similarity_pct: rows.length ? Math.round(rows.reduce((sum, row) => sum + row.similarity_score, 0) / rows.length) : null,
    strongest_matches: strongest,
    evidence_readout: closed.length
      ? `${wins.length}/${closed.length} closed reference trades finished positive; average realized outcome was ${averageR === null ? "not computable" : `${averageR >= 0 ? "+" : ""}${averageR.toFixed(2)}R`}.`
      : "No closed reference outcomes were available in the newest comparable sample.",
  };
}

async function loadCurrent(source: string, identifierParam: string, identifier: string): Promise<Row | null> {
  const pool = getPostgresPool();
  const whereSignal = identifierParam === "signal_hash";
  if (source === "realtime") {
    const query = whereSignal
      ? `SELECT ${signalFields()} FROM realtime_production_ict_strategy_met_execution WHERE signal_hash = $1 LIMIT 1`
      : `SELECT ${signalFields("s.")} FROM realtime_production_orders o JOIN realtime_production_ict_strategy_met_execution s ON s.signal_hash=o.signal_id WHERE o.order_id::text = $1 LIMIT 1`;
    const row = (await pool.query(query, [identifier])).rows[0] as Row | undefined;
    return row ?? null;
  }
  const query = whereSignal
    ? `SELECT ${signalFields()} FROM ${HISTORICAL_SIGNALS} WHERE signal_hash = $1 LIMIT 1`
    : `SELECT ${signalFields("s.")} FROM ${HISTORICAL_ORDERS} o JOIN ${HISTORICAL_SIGNALS} s ON s.signal_hash=o.signal_id WHERE o.order_id = $1 LIMIT 1`;
  const row = (await pool.query(query, [identifier])).rows[0] as Row | undefined;
  return row ?? null;
}

export async function GET(request: NextRequest) {
  const source = request.nextUrl.searchParams.get("source") === "backtest" ? "backtest" : "realtime";
  const identifierParam = request.nextUrl.searchParams.get("identifier_param") === "signal_hash" ? "signal_hash" : "order_id";
  const identifier = (request.nextUrl.searchParams.get("identifier") || "").trim();
  if (!identifier) return NextResponse.json({ success: false, error: "identifier required" }, { status: 400 });

  const bridge = process.env.CANDLES_REST_API_URL;
  if (bridge) {
    const upstream = new URL("/api/similar-trades", bridge);
    for (const [key, value] of request.nextUrl.searchParams.entries()) upstream.searchParams.set(key, value);
    try {
      const response = await fetch(upstream, { headers: process.env.CANDLES_REST_API_TOKEN ? { "x-api-key": process.env.CANDLES_REST_API_TOKEN } : undefined, cache: "no-store" });
      return NextResponse.json(await response.json(), { status: response.status });
    } catch (error) {
      return NextResponse.json({ success: false, error: `Similarity service unavailable: ${error instanceof Error ? error.message : "unknown error"}` }, { status: 502 });
    }
  }

  try {
    const current = await loadCurrent(source, identifierParam, identifier);
    if (!current) return NextResponse.json({ success: false, error: "Current setup was not found" }, { status: 404 });
    const pool = getPostgresPool();
    const recent = await pool.query(
      `SELECT ${signalFields("s.")}, o.order_id, o.entry_price AS order_entry_price, o.filled_price, o.stoploss,
              t.close_ts, t.close_price, t.close_reason, t.target_rr, t.target_rr_filled
       FROM ${HISTORICAL_SIGNALS} s
       JOIN ${HISTORICAL_ORDERS} o ON o.signal_id=s.signal_hash
       JOIN ${HISTORICAL_OUTCOMES} t ON t.order_id=o.order_id AND t.target_no=1
       WHERE UPPER(s.strategy_id)=UPPER($1) AND s.signal_hash <> $2
         AND t.state <> 'OPEN' AND t.close_reason IS NOT NULL AND t.close_reason <> 'missed_entry'
       ORDER BY s.entry_datetime DESC NULLS LAST
       LIMIT 30`,
      [String(current.strategy_id), String(current.signal_hash)],
    );
    const matches = recent.rows.map((row: Row) => {
      const { score, matched } = scoreSimilarity(current, row);
      const r = realizedR(row);
      return {
        order_id: String(row.order_id), signal_hash: String(row.signal_hash), symbol: String(row.ticker), market: String(row.market),
        direction: String(row.direction), strategy_id: String(row.strategy_id), entry_datetime: toIso(row.entry_datetime), close_ts: toIso(row.close_ts),
        close_reason: String(row.close_reason), realized_r: r === null ? null : Math.round(r * 100) / 100,
        similarity_score: score, matched_features: matched,
      };
    }).sort((a, b) => b.similarity_score - a.similarity_score || String(b.entry_datetime).localeCompare(String(a.entry_datetime)));
    const summary = resultSummary(matches);
    return NextResponse.json({
      success: true,
      calculation_version: "similar-trades-v1",
      current: { signal_hash: current.signal_hash, market: current.market, ticker: current.ticker, strategy_id: current.strategy_id, direction: current.direction, entry_datetime: toIso(current.entry_datetime) },
      methodology: "Exact strategy match; newest 30 completed updated-pipeline trades; deterministic comparison of direction, market, multi-timeframe bias, and persisted ICT order-block/FVG/liquidity/swing/structure evidence. The model, when requested, explains this fixed evidence only.",
      summary,
      trades: matches,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Unable to load similar trades" }, { status: 500 });
  }
}
