import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ATM option legs recorded by the Scalping Labs paper lanes (scalping_options.py): contract, prices at entry /
// +2R partial / exit, and every 5-minute bar of the contract from the entry candle to the exit candle.
const LANES = [
  { strategy: "Scalping_OB_OB_V4", prefix: "realtime_production_scalping_ob_ob_v4" },
  { strategy: "BPR_OB_V3", prefix: "realtime_production_bpr_ob_v3" },
  { strategy: "IFVG_OB_V1", prefix: "realtime_production_ifvg_ob_v1" },
] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sec = (v: unknown) => (v ? Math.floor(new Date(String(v)).getTime() / 1000) : null);
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

export async function GET(req: NextRequest) {
  const orderId = (req.nextUrl.searchParams.get("order_id") || "").trim();
  if (!UUID_RE.test(orderId)) return NextResponse.json({ success: false, error: "valid order_id required" }, { status: 400 });
  const pool = getPostgresPool();
  for (const lane of LANES) {
    const leg = await pool.query(
      `SELECT l.*, o.ticker AS underlying, o.direction, o.entry_price AS underlying_entry, o.stoploss, o.tp1, o.partial_price,
              o.entry_datetime, o.partial_at, o.close_ts, o.close_price, o.state, o.realized_r, o.execution_status, o.source_mode,
              o.strategy_json->'minute_execution_replay' AS timing_audit
         FROM ${lane.prefix}_option_legs l JOIN ${lane.prefix}_orders o USING (order_id) WHERE l.order_id = $1`, [orderId]);
    if (!leg.rows.length) continue;
    const l = leg.rows[0];
    const registry = await pool.query(
      `SELECT trade_id,ticker,strategy_name,direction,entry_date,mode,instrument_id
         FROM realtime_production_scalping_option_trades WHERE reference_order_id=$1`, [orderId]);
    const executions = await pool.query(
      `SELECT execution_id, status, reason, trigger_bar, detected_at, filled_at, entry_quote_at, underlying_fill, drift_r,
              entry_option_price, exit_at, exit_option_price, exit_reason, option_return_pct, remaining, contract
         FROM realtime_production_scalping_minute_executions
        WHERE lane=$1 AND ticker=$2 AND direction=$3
          AND trade_date=($4::timestamptz AT TIME ZONE 'America/New_York')::date
        ORDER BY filled_at DESC NULLS LAST, detected_at DESC LIMIT 1`,
      [lane.strategy, l.underlying, l.direction, l.entry_datetime]);
    const paper = executions.rows[0];
    const referenceEnd = l.close_ts ?? new Date().toISOString();
    const paperEnd = paper?.exit_at ?? new Date().toISOString();
    const paperBars = paper?.filled_at ? await pool.query(
      `SELECT bar_ts, open, high, low, close, interpolated FROM realtime_production_scalping_minute_option_bars
        WHERE execution_id=$1 AND bar_ts >= $2::timestamptz
          AND bar_ts+interval '5 minutes' <= $3::timestamptz ORDER BY bar_ts`,
      [paper.execution_id, paper.filled_at, paperEnd]) : { rows: [] };
    const paperEvents = paper?.filled_at ? await pool.query(
      `SELECT event_at, kind, payload FROM realtime_production_scalping_minute_events
        WHERE execution_id=$1 AND kind IN ('ENTRY_FILLED','PARTIAL_2R','TARGET','STOP_CLOSE') ORDER BY event_at`,
      [paper.execution_id]) : { rows: [] };
    const bars = await pool.query(
      `SELECT bar_ts, open, high, low, close, interpolated FROM ${lane.prefix}_option_bars
        WHERE order_id = $1 AND bar_ts >= $2::timestamptz
          AND bar_ts+interval '5 minutes' <= $3::timestamptz ORDER BY bar_ts`,
      [orderId, l.entry_datetime, referenceEnd]);
    const markers = [
      { time: sec(l.entry_datetime), kind: "ENTRY", price: num(l.entry_option_price), label: `Entry ${num(l.entry_option_price)?.toFixed(2) ?? "-"}` },
      ...(l.partial_at ? [{ time: sec(l.partial_at), kind: "PARTIAL", price: num(l.partial_option_price), label: `+2R half ${num(l.partial_option_price)?.toFixed(2) ?? "-"}` }] : []),
      ...(l.close_ts ? [{ time: sec(l.close_ts), kind: l.state === "CLOSED_TP" ? "EXIT_WIN" : "EXIT_LOSS", price: num(l.exit_option_price), label: `Exit ${num(l.exit_option_price)?.toFixed(2) ?? "-"}` }] : []),
    ];
    return NextResponse.json({
      success: true,
      strategy: lane.strategy,
      stored_trade: registry.rows[0] ?? null,
      paper_execution: executions.rows[0] ?? null,
      timing_audit: l.timing_audit ?? null,
      window: { start: sec(l.entry_datetime), end: sec(referenceEnd), timezone: "America/New_York" },
      execution_window: paper?.filled_at ? { start: sec(paper.filled_at), end: sec(paperEnd), timezone: "America/New_York" } : null,
      execution_bars: paperBars.rows.map((b) => ({ time: sec(b.bar_ts), open: num(b.open), high: num(b.high), low: num(b.low), close: num(b.close), interpolated: !!b.interpolated })),
      execution_markers: paperEvents.rows.map((e) => ({
        time: sec(e.kind === 'ENTRY_FILLED' ? paper.filled_at : e.kind === 'PARTIAL_2R' ? e.event_at : paper.exit_at ?? e.event_at),
        kind: e.kind === 'ENTRY_FILLED' ? 'ENTRY' : e.kind === 'PARTIAL_2R' ? 'PARTIAL' : 'EXIT',
        price: num(e.payload.price ?? e.payload.fill), label: `${e.kind} ${num(e.payload.price ?? e.payload.fill)?.toFixed(2) ?? '-'}`,
      })),
      price_basis: "Historical option candle closes; not broker fills. Minute paper executions are reported separately.",
      leg: {
        occ_symbol: l.occ_symbol, option_type: l.option_type,
        expiration: l.expiration instanceof Date ? l.expiration.toISOString().slice(0, 10) : String(l.expiration ?? "").slice(0, 10), strike: num(l.strike), days_to_expiry: l.days_to_expiry,
        contract_rule: l.contract_rule, multiplier: l.contract_multiplier, underlying: l.underlying, direction: l.direction,
        underlying_entry: num(l.underlying_entry), stop: num(l.stoploss), target: num(l.tp1), entry_ts: l.entry_datetime,
        exit_ts: l.close_ts, entry_price_bar_ts: l.entry_ts, exit_price_bar_ts: l.exit_ts,
        entry_price: num(l.entry_option_price), entry_bid: num(l.entry_bid), entry_ask: num(l.entry_ask), entry_mark: num(l.entry_mark),
        premium_per_contract: num(l.premium_per_contract), partial_price: num(l.partial_option_price), exit_price: num(l.exit_option_price),
        return_pct: num(l.option_return_pct), underlying_r: num(l.realized_r), state: l.state, execution_status: l.execution_status,
        source_mode: l.source_mode, same_bar_round_trip: l.same_bar_round_trip, bars_complete: l.bars_complete, entry_bar: l.entry_bar, data_quality: l.data_quality,
        underlying_entry_datetime: l.entry_datetime, underlying_exit_datetime: l.close_ts,
      },
      bars: bars.rows.map((b) => ({ time: sec(b.bar_ts), open: num(b.open), high: num(b.high), low: num(b.low), close: num(b.close), interpolated: !!b.interpolated })),
      markers,
    });
  }
  return NextResponse.json({ success: false, error: "no option leg for this order (only Scalping_OB_OB_V4 / BPR_OB_V3 / IFVG_OB_V1 paper orders carry one)" }, { status: 404 });
}
