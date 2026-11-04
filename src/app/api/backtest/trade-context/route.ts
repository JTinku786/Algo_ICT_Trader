import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// V1 order keys are a full SHA-256 (64 hex). V2 truncates its keys to 32 hex,
// so a 64-only guard rejected every V2 order before it reached the database.
const TS01_KEY_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/i;
// S16-V2 and S01-V2 setup ids are a 24-hex sha1 prefix (engine.py _setup_id).
const S16V2_KEY_RE = /^[0-9a-f]{24}$/i;

const TS01V2_ENGINE = "ts01_tb_v2.2026-08-22";

const BACKTEST_ORDERS = `(
  SELECT 'original'::text AS pipeline, order_id::text AS order_id, signal_id, symbol, strategy_id FROM historical_ict_orders
  UNION ALL
  SELECT 'updated'::text AS pipeline, order_id::text AS order_id, signal_id, symbol, strategy_id FROM historical_ict_orders_updated
  UNION ALL
  SELECT 'ts01'::text AS pipeline, order_key AS order_id, order_key AS signal_id, ticker AS symbol, strategy_id
  FROM historical_ict_ts01_orders_updated
  WHERE engine_version='ts01_tb_r2.2026-08-18' AND cohort='primary' AND state='FILLED'
  UNION ALL
  SELECT 'ts01v2'::text AS pipeline, order_key AS order_id, candidate_key AS signal_id,
         ticker AS symbol, 'TS01-TB-V2'::text AS strategy_id
  FROM historical_ict_ts01v2_orders
  WHERE engine_version='${TS01V2_ENGINE}' AND state='FILLED'
  UNION ALL
  SELECT 's16v2'::text AS pipeline, o.setup_id AS order_id, o.setup_id AS signal_id, o.symbol, 'S16-V2'::text AS strategy_id
  FROM s16v2_orders o
  JOIN s16v2_runs r ON r.run_id = o.run_id AND r.published
  WHERE o.state = 'FILLED'
  UNION ALL
  SELECT 's01v2'::text AS pipeline, o.setup_id AS order_id, o.setup_id AS signal_id, o.symbol, 'S01-V2'::text AS strategy_id
  FROM s01v2_orders o
  JOIN s01v2_runs r ON r.run_id = o.run_id AND r.published
  WHERE o.state = 'FILLED'
  UNION ALL
  SELECT 's01v3'::text AS pipeline, o.setup_id AS order_id, o.setup_id AS signal_id, o.symbol, 'S01-V3'::text AS strategy_id
  FROM s01v3_orders o
  JOIN s01v3_runs r ON r.run_id = o.run_id AND r.published
  WHERE o.state = 'FILLED'
  UNION ALL
  SELECT 'scalpv2'::text AS pipeline, o.setup_id AS order_id, o.setup_id AS signal_id, o.symbol, 'Scalping_OB_OB_V2'::text AS strategy_id
  FROM scalping_ob_ob_v2_orders o
  JOIN scalping_ob_ob_v2_runs r ON r.run_id = o.run_id AND r.published
  WHERE o.state = 'FILLED'
  UNION ALL
  SELECT 'scalpv4'::text AS pipeline, o.setup_id AS order_id, o.setup_id AS signal_id, o.symbol, 'Scalping_OB_OB_V4'::text AS strategy_id
  FROM scalping_ob_ob_v4_orders o
  JOIN scalping_ob_ob_v4_runs r ON r.run_id = o.run_id AND r.published
  WHERE o.state = 'FILLED'
  UNION ALL
  SELECT 'bprv3'::text AS pipeline, o.setup_id AS order_id, o.setup_id AS signal_id, o.symbol, 'BPR_OB_V3'::text AS strategy_id
  FROM scalping_bpr_ob_v3_orders o
  JOIN scalping_bpr_ob_v3_runs r ON r.run_id = o.run_id AND r.published
  WHERE o.state = 'FILLED'
)`;

const BACKTEST_SIGNALS = `(
  SELECT 'original'::text AS pipeline, signal_hash, ticker, strategy_id, entry_datetime, strategy_json
  FROM historical_ict_strategy_met_execution
  UNION ALL
  SELECT 'updated'::text AS pipeline, signal_hash, ticker, strategy_id, entry_datetime, strategy_json
  FROM historical_ict_strategy_met_execution_updated
  UNION ALL
  SELECT 'ts01'::text AS pipeline, o.order_key AS signal_hash, o.ticker, o.strategy_id,
         COALESCE(d.entry_ts, o.fill_bar_ts) AS entry_datetime, d.strategy_json
  FROM historical_ict_ts01_orders_updated o
  JOIN historical_ict_ts01_daily_validation_updated d
    ON d.engine_version=o.engine_version AND d.cohort=o.cohort AND d.market=o.market
   AND d.ticker=o.ticker AND d.session_date=o.session_date
  WHERE o.engine_version='ts01_tb_r2.2026-08-18' AND o.cohort='primary' AND o.state='FILLED'
  UNION ALL
  -- Same assembled evidence object the main backtest route builds, so the
  -- Strategy JSON inspector shows an identical decision trail here.
  SELECT 'ts01v2'::text AS pipeline, o.candidate_key AS signal_hash, o.ticker,
         'TS01-TB-V2'::text AS strategy_id, o.fill_bar_ts AS entry_datetime,
         jsonb_build_object(
           'engine_version', o.engine_version,
           'strategy', 'TS01-TB-V2 (ICT 2022 Mentorship V2)',
           'direction', o.direction,
           'variant', c.variant,
           'array_kind', o.array_kind,
           'entry_depth', o.entry_depth,
           'raid', jsonb_build_object('pool', c.raid_pool, 'bar_ts', c.raid_bar_ts,
                                      'extreme', c.raid_extreme),
           'mss', jsonb_build_object('bar_ts', c.mss_bar_ts, 'swing_price', c.mss_swing_price,
                                     'close', c.mss_close),
           'displacement', c.displacement,
           'entry_array', c.entry_array,
           'gates', c.gates,
           'execution', jsonb_build_object('entry', o.entry_price, 'stop', o.stop_price,
                                           'risk_points', o.risk_points),
           'targets', o.targets,
           'legs', o.legs,
           'management', o.management
         ) AS strategy_json
  FROM historical_ict_ts01v2_orders o
  JOIN historical_ict_ts01v2_candidates c ON c.candidate_key = o.candidate_key
  WHERE o.engine_version='${TS01V2_ENGINE}' AND o.state='FILLED'
  UNION ALL
  -- S16-V2: full causal decision trail + fill + the three independent target outcomes.
  SELECT 's16v2'::text AS pipeline, st.setup_id AS signal_hash, st.symbol AS ticker, 'S16-V2'::text AS strategy_id,
         st.decision_known_at AS entry_datetime,
         st.payload || jsonb_build_object(
           'run_id', st.run_id,
           'order', jsonb_build_object('placed_at', o.placed_at, 'ce', o.ce, 'stop', o.stop,
                                       'fill_ts', o.fill_ts, 'fill_price', o.fill_price,
                                       'fill_method', o.fill_method, 'risk_plan', o.risk_plan,
                                       'fill_through_extreme', o.fill_through_extreme,
                                       'fill_through_stop', o.fill_through_stop,
                                       'score_final', o.score_final),
           'outcomes', (SELECT jsonb_agg(jsonb_build_object('target_no', u.target_no, 'target_price', u.target_price,
                                   'rr_plan', u.rr_plan, 'selection', u.selection, 'exit_type', u.exit_type,
                                   'exit_ts', u.exit_ts, 'exit_price', u.exit_price, 'trigger_ts', u.trigger_ts,
                                   'trigger_close', u.trigger_close, 'r_plan', u.r_plan, 'overnight', u.overnight)
                                   ORDER BY u.target_no)
                        FROM s16v2_outcomes u WHERE u.run_id = st.run_id AND u.setup_id = st.setup_id)
         ) AS strategy_json
  FROM s16v2_setups st
  JOIN s16v2_runs r ON r.run_id = st.run_id AND r.published
  JOIN s16v2_orders o ON o.run_id = st.run_id AND o.setup_id = st.setup_id AND o.state = 'FILLED'
  UNION ALL
  -- S01-V2: same shape as S16-V2 (payload + order + outcomes).
  SELECT 's01v2'::text AS pipeline, st.setup_id AS signal_hash, st.symbol AS ticker, 'S01-V2'::text AS strategy_id,
         st.rejection_ts AS entry_datetime,
         st.payload || jsonb_build_object(
           'run_id', st.run_id,
           'order', jsonb_build_object('rejection_ts', o.rejection_ts, 'e_plan', o.e_plan, 'stop', o.stop,
                                       'fill_ts', o.fill_ts, 'fill_price', o.fill_price,
                                       'fill_minus_eplan', o.fill_minus_eplan, 'risk_plan', o.risk_plan,
                                       'killzone', o.killzone, 'sweep_tf', o.sweep_tf),
           'outcomes', (SELECT jsonb_agg(jsonb_build_object('target_no', u.target_no, 'target_price', u.target_price,
                                   'rr_plan', u.rr_plan, 'selection', u.selection, 'exit_type', u.exit_type,
                                   'exit_ts', u.exit_ts, 'exit_price', u.exit_price, 'trigger_ts', u.trigger_ts,
                                   'trigger_close', u.trigger_close, 'r_plan', u.r_plan, 'overnight', u.overnight)
                                   ORDER BY u.target_no)
                        FROM s01v2_outcomes u WHERE u.run_id = st.run_id AND u.setup_id = st.setup_id)
         ) AS strategy_json
  FROM s01v2_setups st
  JOIN s01v2_runs r ON r.run_id = st.run_id AND r.published
  JOIN s01v2_orders o ON o.run_id = st.run_id AND o.setup_id = st.setup_id AND o.state = 'FILLED'
  UNION ALL
  SELECT 's01v3'::text AS pipeline, st.setup_id AS signal_hash, st.symbol AS ticker, 'S01-V3'::text AS strategy_id,
         st.rejection_ts AS entry_datetime,
         st.payload || jsonb_build_object(
           'run_id', st.run_id,
           'order', jsonb_build_object('rejection_ts', o.rejection_ts, 'e_plan', o.e_plan, 'stop', o.stop,
                                       'fill_ts', o.fill_ts, 'fill_price', o.fill_price,
                                       'fill_minus_eplan', o.fill_minus_eplan, 'risk_plan', o.risk_plan,
                                       'killzone', o.killzone, 'sweep_tf', o.sweep_tf),
           'outcomes', (SELECT jsonb_agg(jsonb_build_object('target_no', u.target_no, 'target_price', u.target_price,
                                   'rr_plan', u.rr_plan, 'selection', u.selection, 'exit_type', u.exit_type,
                                   'exit_ts', u.exit_ts, 'exit_price', u.exit_price, 'trigger_ts', u.trigger_ts,
                                   'trigger_close', u.trigger_close, 'r_plan', u.r_plan, 'overnight', u.overnight)
                                   ORDER BY u.target_no)
                        FROM s01v3_outcomes u WHERE u.run_id = st.run_id AND u.setup_id = st.setup_id)
         ) AS strategy_json
  FROM s01v3_setups st
  JOIN s01v3_runs r ON r.run_id = st.run_id AND r.published
  JOIN s01v3_orders o ON o.run_id = st.run_id AND o.setup_id = st.setup_id AND o.state = 'FILLED'
  UNION ALL
  SELECT 'scalpv2'::text AS pipeline, st.setup_id AS signal_hash, st.symbol AS ticker, 'Scalping_OB_OB_V2'::text AS strategy_id,
         st.entry_ts AS entry_datetime, st.payload AS strategy_json
  FROM scalping_ob_ob_v2_setups st
  JOIN scalping_ob_ob_v2_runs r ON r.run_id = st.run_id AND r.published
  UNION ALL
  SELECT 'scalpv4'::text AS pipeline, st.setup_id AS signal_hash, st.symbol AS ticker, 'Scalping_OB_OB_V4'::text AS strategy_id,
         st.entry_ts AS entry_datetime, st.payload AS strategy_json
  FROM scalping_ob_ob_v4_setups st
  JOIN scalping_ob_ob_v4_runs r ON r.run_id = st.run_id AND r.published
  UNION ALL
  SELECT 'bprv3'::text AS pipeline, st.setup_id AS signal_hash, st.symbol AS ticker, 'BPR_OB_V3'::text AS strategy_id,
         st.entry_ts AS entry_datetime, st.payload AS strategy_json
  FROM scalping_bpr_ob_v3_setups st
  JOIN scalping_bpr_ob_v3_runs r ON r.run_id = st.run_id AND r.published
)`;

export async function GET(request: NextRequest) {
  const orderId = (request.nextUrl.searchParams.get("order_id") || "").trim();
  if (!UUID_RE.test(orderId) && !TS01_KEY_RE.test(orderId) && !S16V2_KEY_RE.test(orderId)) {
    return NextResponse.json({ success: false, error: "valid order_id required" }, { status: 400 });
  }

  const restApiUrl = process.env.CANDLES_REST_API_URL;
  if (restApiUrl) {
    const upstreamUrl = new URL("/api/backtest/trade-context", restApiUrl);
    upstreamUrl.searchParams.set("order_id", orderId);
    try {
      const upstream = await fetch(upstreamUrl, {
        headers: process.env.CANDLES_REST_API_TOKEN
          ? { "x-api-key": process.env.CANDLES_REST_API_TOKEN }
          : undefined,
        cache: "no-store",
      });
      return NextResponse.json(await upstream.json(), {
        status: upstream.status,
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown REST API error";
      return NextResponse.json({ success: false, error: `REST API unavailable: ${message}` }, { status: 502 });
    }
  }

  try {
    const pool = getPostgresPool();
    const result = await pool.query(
      `SELECT o.order_id, COALESCE(s.ticker, o.symbol) AS ticker,
              COALESCE(s.strategy_id, o.strategy_id) AS strategy_id,
              s.entry_datetime, s.pipeline, s.strategy_json
       FROM ${BACKTEST_ORDERS} o
       LEFT JOIN ${BACKTEST_SIGNALS} s ON s.signal_hash=o.signal_id AND s.pipeline=o.pipeline
       WHERE o.order_id=$1
       LIMIT 1`,
      [orderId],
    );
    if (!result.rowCount) {
      return NextResponse.json({ success: false, error: "trade not found" }, { status: 404 });
    }
    const row = result.rows[0];
    return NextResponse.json({
      success: true,
      trade: {
        order_id: row.order_id,
        ticker: row.ticker,
        strategy_id: row.strategy_id,
        entry_datetime: row.entry_datetime,
        pipeline: row.pipeline,
        strategy_json: row.strategy_json,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Postgres error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
