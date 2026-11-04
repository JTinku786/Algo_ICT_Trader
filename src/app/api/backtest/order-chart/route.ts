import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";
import { smtForTrades } from "@/lib/smt-signal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TS01V2_ENGINE = "ts01_tb_v2.2026-08-22";
// Keep in step with src/app/api/backtest/route.ts: the same pinned S10-V3 run.
const S10V3_RUN = "s10v3-a00c29e7eb268fb06515";

const BACKTEST_ORDERS = `(
  SELECT 'original'::text AS pipeline, order_id::text AS order_id, signal_id, market, symbol, direction, entry_price, filled_price,
         stoploss, tp1, tp2, tp3, filled_at
  FROM historical_ict_orders
  UNION ALL
  SELECT 'updated'::text AS pipeline, order_id::text AS order_id, signal_id, market, symbol, direction, entry_price, filled_price,
         stoploss, tp1, tp2, tp3, filled_at
  FROM historical_ict_orders_updated
  UNION ALL
  SELECT 'ts01'::text AS pipeline, order_key AS order_id, order_key AS signal_id, market,
         ticker AS symbol, direction, theoretical_entry AS entry_price, filled_price,
         stop_exec AS stoploss,
         NULLIF(order_json #>> '{geometry,targets,0,target_exit_price}', '')::double precision AS tp1,
         NULLIF(order_json #>> '{geometry,targets,1,target_exit_price}', '')::double precision AS tp2,
         NULLIF(order_json #>> '{geometry,targets,2,target_exit_price}', '')::double precision AS tp3,
         fill_bar_ts AS filled_at
  FROM historical_ict_ts01_orders_updated
  WHERE engine_version='ts01_tb_r2.2026-08-18' AND cohort='primary' AND state='FILLED'
  UNION ALL
  SELECT 'ts01v2'::text AS pipeline, order_key AS order_id, candidate_key AS signal_id, market,
         ticker AS symbol, direction, entry_price, entry_price AS filled_price,
         stop_price AS stoploss,
         NULLIF(targets #>> '{0,price}', '')::double precision AS tp1,
         NULLIF(targets #>> '{1,price}', '')::double precision AS tp2,
         NULLIF(targets #>> '{2,price}', '')::double precision AS tp3,
         fill_bar_ts AS filled_at
  FROM historical_ict_ts01v2_orders
  WHERE engine_version='${TS01V2_ENGINE}' AND state='FILLED'
  UNION ALL
  SELECT 's10v3'::text AS pipeline, o.order_id, o.order_id AS signal_id,
         'us'::text AS market, o.symbol,
         CASE WHEN (o.payload->>'d')::int = 1 THEN 'BUY' ELSE 'SELL' END AS direction,
         (o.payload->>'entry')::double precision AS entry_price,
         (o.payload->>'entry')::double precision AS filled_price,
         (o.payload->>'initial_stop')::double precision AS stoploss,
         (o.payload->'targets'->>0)::double precision AS tp1,
         (o.payload->'targets'->>1)::double precision AS tp2,
         (o.payload->'targets'->>2)::double precision AS tp3,
         to_timestamp((o.payload->>'fill_ts')::bigint) AS filled_at
  FROM historical_ict_s10_v3_orders_updated o
  WHERE o.run_id='${S10V3_RUN}' AND o.state='CLOSED'
  UNION ALL
  -- S16-V2: keep in step with src/app/api/backtest/route.ts (published runs, FILLED orders).
  SELECT 's16v2'::text AS pipeline, o.setup_id AS order_id, o.setup_id AS signal_id, r.market, o.symbol,
         o.direction, o.ce AS entry_price, o.fill_price AS filled_price, o.stop AS stoploss,
         o.tp1, o.tp2, o.tp3, o.fill_ts AS filled_at
  FROM s16v2_orders o
  JOIN s16v2_runs r ON r.run_id = o.run_id AND r.published
  WHERE o.state = 'FILLED'
  UNION ALL
  -- S01-V2: keep in step with src/app/api/backtest/route.ts (published runs, FILLED orders).
  SELECT 's01v2'::text AS pipeline, o.setup_id AS order_id, o.setup_id AS signal_id, r.market, o.symbol,
         o.direction, o.e_plan AS entry_price, o.fill_price AS filled_price, o.stop AS stoploss,
         o.tp1, o.tp2, o.tp3, o.fill_ts AS filled_at
  FROM s01v2_orders o
  JOIN s01v2_runs r ON r.run_id = o.run_id AND r.published
  WHERE o.state = 'FILLED'
  UNION ALL
  SELECT 's01v3'::text AS pipeline, o.setup_id AS order_id, o.setup_id AS signal_id, r.market, o.symbol,
         o.direction, o.e_plan AS entry_price, o.fill_price AS filled_price, o.stop AS stoploss,
         o.tp1, o.tp2, o.tp3, o.fill_ts AS filled_at
  FROM s01v3_orders o
  JOIN s01v3_runs r ON r.run_id = o.run_id AND r.published
  WHERE o.state = 'FILLED'
  UNION ALL
  -- Scalping_OB_OB_V2 (Scalping Labs 1h OB x 5m OB; frozen filters 2026-10-24). Resting limit at the
  -- 5m OB, so the fill IS the planned entry; one target = nearest liquidity >= 1R. realized_r is GROSS R
  -- on planned risk: losses exit at the 5m close beyond the stop, so they are not exactly -1R.
  SELECT 'scalpv2'::text AS pipeline, o.setup_id AS order_id, o.setup_id AS signal_id, 'us'::text AS market, o.symbol,
         o.direction, o.entry AS entry_price, o.fill_price AS filled_price, o.stop AS stoploss,
         o.tp1, NULL::double precision AS tp2, NULL::double precision AS tp3, o.fill_ts AS filled_at
  FROM scalping_ob_ob_v2_orders o
  JOIN scalping_ob_ob_v2_runs r ON r.run_id = o.run_id AND r.published
  WHERE o.state = 'FILLED'
  UNION ALL
  -- Scalping_OB_OB_V4 = V2 + planned move < 3% + crowding cap (<=3 earlier same-direction signals today) + 50% off at +2R
  -- (resting limit). realized_r is GROSS R on planned risk and blends the partial with the remainder's exit.
  SELECT 'scalpv4'::text AS pipeline, o.setup_id AS order_id, o.setup_id AS signal_id, 'us'::text AS market, o.symbol,
         o.direction, o.entry AS entry_price, o.fill_price AS filled_price, o.stop AS stoploss,
         o.tp1, NULL::double precision AS tp2, NULL::double precision AS tp3, o.fill_ts AS filled_at
  FROM scalping_ob_ob_v4_orders o
  JOIN scalping_ob_ob_v4_runs r ON r.run_id = o.run_id AND r.published
  WHERE o.state = 'FILLED'
  UNION ALL
  -- BPR_OB_V3 (Quiet Open A): 1h BPR x 5m OB, 09:30-10:55, chase <= +0.25%, quiet open < 0.2, move < 3%, no repeats
  -- (ticker, side, date), crowding <= 3, 50% off at +2R. realized_r = GROSS R on planned risk, partial blended.
  SELECT 'bprv3'::text AS pipeline, o.setup_id AS order_id, o.setup_id AS signal_id, 'us'::text AS market, o.symbol,
         o.direction, o.entry AS entry_price, o.fill_price AS filled_price, o.stop AS stoploss,
         o.tp1, NULL::double precision AS tp2, NULL::double precision AS tp3, o.fill_ts AS filled_at
  FROM scalping_bpr_ob_v3_orders o
  JOIN scalping_bpr_ob_v3_runs r ON r.run_id = o.run_id AND r.published
  WHERE o.state = 'FILLED'
)`;

// `realized_r` is an optional override; legacy pipelines leave it NULL and keep
// their existing win/loss semantics untouched.
const BACKTEST_TARGETS = `(
  SELECT 'original'::text AS pipeline, order_id::text AS order_id, target_no, target_price, target_rr, state, close_ts, close_price, close_reason,
         NULL::double precision AS realized_r
  FROM historical_ict_order_target_outcomes
  UNION ALL
  SELECT 'updated'::text AS pipeline, order_id::text AS order_id, target_no, target_price, target_rr, state, close_ts, close_price, close_reason,
         CASE WHEN (signal_id LIKE 'IG_Goldhunter_ICT2022_R2:%' OR signal_id LIKE 'IG_Goldhunter_ICT2022_V3:%') THEN realized_r ELSE NULL::double precision END AS realized_r
  FROM historical_ict_order_target_outcomes_updated
  UNION ALL
  SELECT 'ts01'::text AS pipeline, order_key AS order_id, target_no, target_price, target_rr,
         state, close_bar_ts AS close_ts, close_price, target_json->>'reason' AS close_reason,
         NULL::double precision AS realized_r
  FROM historical_ict_ts01_target_outcomes_updated
  WHERE engine_version='ts01_tb_r2.2026-08-18' AND cohort='primary'
  UNION ALL
  SELECT 'ts01v2'::text AS pipeline, o.order_key AS order_id,
         (leg->>'no')::int AS target_no,
         (leg->>'price')::double precision AS target_price,
         (leg->>'net_rr')::double precision AS target_rr,
         CASE
           WHEN leg->>'state' = 'CLOSED_TP' THEN 'CLOSED_TP'
           WHEN leg->>'state' = 'CLOSED_STOP' THEN 'CLOSED_SL'
           WHEN COALESCE((leg->>'realized_r')::double precision, 0) > 0 THEN 'CLOSED_TP'
           ELSE 'CLOSED_SL'
         END AS state,
         (leg->>'close_ts')::timestamptz AS close_ts,
         CASE WHEN UPPER(o.direction) = 'SELL'
              THEN o.entry_price - (leg->>'realized_r')::double precision * o.risk_points
              ELSE o.entry_price + (leg->>'realized_r')::double precision * o.risk_points
         END AS close_price,
         leg->>'state' AS close_reason,
         (leg->>'realized_r')::double precision AS realized_r
  FROM historical_ict_ts01v2_orders o, LATERAL jsonb_array_elements(o.legs) leg
  WHERE o.engine_version='${TS01V2_ENGINE}' AND o.state='FILLED'
    AND leg->>'realized_r' IS NOT NULL
  UNION ALL
  -- Mirrors the Backtest projection: one managed position, scaled out, so all
  -- three rows carry the same gross position-level R and the same close.
  SELECT 's10v3'::text AS pipeline, o.order_id, g.i AS target_no,
         (o.payload->'targets'->>(g.i - 1))::double precision AS target_price,
         ((o.payload->'targets'->>(g.i - 1))::double precision
            - (o.payload->>'entry')::double precision)
           * (o.payload->>'d')::double precision
           / NULLIF((o.payload->>'risk')::double precision, 0) AS target_rr,
         CASE WHEN x.gross_r > 0 THEN 'CLOSED_TP' ELSE 'CLOSED_SL' END AS state,
         x.closed_at AS close_ts,
         x.avg_exit_price AS close_price,
         x.exit_reason AS close_reason,
         x.gross_r AS realized_r
  FROM historical_ict_s10_v3_orders_updated o
  CROSS JOIN generate_series(1, 3) AS g(i)
  JOIN LATERAL (
    SELECT SUM((e.payload->>'fraction')::double precision
                 * ((e.payload->>'price')::double precision
                      - (o.payload->>'entry')::double precision))
             * (o.payload->>'d')::double precision
             / NULLIF((o.payload->>'risk')::double precision, 0) AS gross_r,
           SUM((e.payload->>'fraction')::double precision
                 * (e.payload->>'price')::double precision) AS avg_exit_price,
           MAX(e.event_ts) AS closed_at,
           (ARRAY_AGG(e.kind ORDER BY e.event_ts DESC, e.event_id DESC))[1] AS exit_reason
    FROM historical_ict_s10_v3_events_updated e
    WHERE e.run_id = o.run_id AND e.order_id = o.order_id
      AND e.payload->>'fraction' IS NOT NULL
  ) x ON TRUE
  WHERE o.run_id='${S10V3_RUN}' AND o.state='CLOSED'
    AND x.gross_r IS NOT NULL
    AND o.payload->'targets'->>(g.i - 1) IS NOT NULL
  UNION ALL
  -- S16-V2: three independent single-target outcomes; gross R on the pre-order risk.
  SELECT 's16v2'::text AS pipeline, u.setup_id AS order_id, u.target_no, u.target_price, u.rr_plan AS target_rr,
         u.state, u.exit_ts AS close_ts, u.exit_price AS close_price, u.exit_type AS close_reason,
         u.r_plan AS realized_r
  FROM s16v2_outcomes u
  JOIN s16v2_runs r ON r.run_id = u.run_id AND r.published
  UNION ALL
  -- S01-V2: same independent-target model; gross R on the planned risk (E_plan - stop).
  SELECT 's01v2'::text AS pipeline, u.setup_id AS order_id, u.target_no, u.target_price, u.rr_plan AS target_rr,
         u.state, u.exit_ts AS close_ts, u.exit_price AS close_price, u.exit_type AS close_reason,
         u.r_plan AS realized_r
  FROM s01v2_outcomes u
  JOIN s01v2_runs r ON r.run_id = u.run_id AND r.published
  UNION ALL
  SELECT 's01v3'::text AS pipeline, u.setup_id AS order_id, u.target_no, u.target_price, u.rr_plan AS target_rr,
         u.state, u.exit_ts AS close_ts, u.exit_price AS close_price, u.exit_type AS close_reason,
         u.r_plan AS realized_r
  FROM s01v3_outcomes u
  JOIN s01v3_runs r ON r.run_id = u.run_id AND r.published
  UNION ALL
  SELECT 'scalpv2'::text AS pipeline, u.setup_id AS order_id, u.target_no, u.target_price, u.rr_plan AS target_rr,
         u.state, u.exit_ts AS close_ts, u.exit_price AS close_price, u.exit_type AS close_reason,
         u.r_plan AS realized_r
  FROM scalping_ob_ob_v2_outcomes u
  JOIN scalping_ob_ob_v2_runs r ON r.run_id = u.run_id AND r.published
  UNION ALL
  SELECT 'scalpv4'::text AS pipeline, u.setup_id AS order_id, u.target_no, u.target_price, u.rr_plan AS target_rr,
         u.state, u.exit_ts AS close_ts, u.exit_price AS close_price, u.exit_type AS close_reason,
         u.r_plan AS realized_r
  FROM scalping_ob_ob_v4_outcomes u
  JOIN scalping_ob_ob_v4_runs r ON r.run_id = u.run_id AND r.published
  UNION ALL
  SELECT 'bprv3'::text AS pipeline, u.setup_id AS order_id, u.target_no, u.target_price, u.rr_plan AS target_rr,
         u.state, u.exit_ts AS close_ts, u.exit_price AS close_price, u.exit_type AS close_reason,
         u.r_plan AS realized_r
  FROM scalping_bpr_ob_v3_outcomes u
  JOIN scalping_bpr_ob_v3_runs r ON r.run_id = u.run_id AND r.published
)`;

// Keep the chart source aligned with the Backtest table: original historical
// rows and the corrected *_updated pipeline are both valid chart sources.
const BACKTEST_SIGNALS = `(
  SELECT 'original'::text AS pipeline, signal_hash, strategy_id, ticker, direction, entry_datetime,
         weekly_bias, daily_bias, one_hour_bias, strategy_json,
         five_min_relevant_order_block AS ob_5m,
         five_min_relevant_fvg AS fvg_5m,
         five_min_relevant_liquidity_levels AS liq_5m,
         five_min_relevant_swings AS sw_5m,
         five_min_relevant_bos_mss_choch AS bos_5m,
         fifteen_min_relevant_order_block AS ob_15m,
         fifteen_min_relevant_fvg AS fvg_15m,
         fifteen_min_relevant_liquidity_levels AS liq_15m,
         fifteen_min_relevant_swings AS sw_15m,
         fifteen_min_relevant_bos_mss_choch AS bos_15m,
         thirty_min_relevant_order_block AS ob_30m,
         thirty_min_relevant_fvg AS fvg_30m,
         thirty_min_relevant_liquidity_levels AS liq_30m,
         thirty_min_relevant_swings AS sw_30m,
         thirty_min_relevant_bos_mss_choch AS bos_30m,
         one_hour_relevant_order_block AS ob_1h,
         one_hour_relevant_fvg AS fvg_1h,
         one_hour_relevant_liquidity_levels AS liq_1h,
         one_hour_relevant_swings AS sw_1h,
         one_hour_relevant_bos_mss_choch AS bos_1h,
         daily_relevant_order_block AS ob_d,
         daily_relevant_fvg AS fvg_d,
         daily_relevant_liquidity_levels AS liq_d,
         daily_relevant_swings AS sw_d,
         daily_relevant_bos_mss_choch AS bos_d,
         weekly_relevant_order_block AS ob_w,
         weekly_relevant_fvg AS fvg_w,
         weekly_relevant_liquidity_levels AS liq_w,
         weekly_relevant_swings AS sw_w,
         weekly_relevant_bos_mss_choch AS bos_w
  FROM historical_ict_strategy_met_execution
  UNION ALL
  SELECT 'updated'::text AS pipeline, signal_hash, strategy_id, ticker, direction, entry_datetime,
         weekly_bias, daily_bias, one_hour_bias, strategy_json,
         five_min_relevant_order_block, five_min_relevant_fvg,
         five_min_relevant_liquidity_levels, five_min_relevant_swings,
         five_min_relevant_bos_mss_choch, fifteen_min_relevant_order_block,
         fifteen_min_relevant_fvg, fifteen_min_relevant_liquidity_levels,
         fifteen_min_relevant_swings, fifteen_min_relevant_bos_mss_choch,
         thirty_min_relevant_order_block, thirty_min_relevant_fvg,
         thirty_min_relevant_liquidity_levels, thirty_min_relevant_swings,
         thirty_min_relevant_bos_mss_choch, one_hour_relevant_order_block,
         one_hour_relevant_fvg, one_hour_relevant_liquidity_levels,
         one_hour_relevant_swings, one_hour_relevant_bos_mss_choch,
         daily_relevant_order_block, daily_relevant_fvg,
         daily_relevant_liquidity_levels, daily_relevant_swings,
         daily_relevant_bos_mss_choch, weekly_relevant_order_block,
         weekly_relevant_fvg, weekly_relevant_liquidity_levels,
         weekly_relevant_swings, weekly_relevant_bos_mss_choch
  FROM historical_ict_strategy_met_execution_updated
  UNION ALL
  SELECT 'ts01'::text AS pipeline, o.order_key AS signal_hash, o.strategy_id, o.ticker, o.direction,
         COALESCE(d.entry_ts, o.fill_bar_ts) AS entry_datetime,
         NULL::text AS weekly_bias, d.direction AS daily_bias, NULL::text AS one_hour_bias,
         d.strategy_json,
         NULL::jsonb AS ob_5m, NULL::jsonb AS fvg_5m, NULL::jsonb AS liq_5m,
         NULL::jsonb AS sw_5m, NULL::jsonb AS bos_5m,
         NULL::jsonb AS ob_15m, NULL::jsonb AS fvg_15m, NULL::jsonb AS liq_15m,
         NULL::jsonb AS sw_15m, NULL::jsonb AS bos_15m,
         NULL::jsonb AS ob_30m, NULL::jsonb AS fvg_30m, NULL::jsonb AS liq_30m,
         NULL::jsonb AS sw_30m, NULL::jsonb AS bos_30m,
         NULL::jsonb AS ob_1h, NULL::jsonb AS fvg_1h, NULL::jsonb AS liq_1h,
         NULL::jsonb AS sw_1h, NULL::jsonb AS bos_1h,
         NULL::jsonb AS ob_d, NULL::jsonb AS fvg_d, NULL::jsonb AS liq_d,
         NULL::jsonb AS sw_d, NULL::jsonb AS bos_d,
         NULL::jsonb AS ob_w, NULL::jsonb AS fvg_w, NULL::jsonb AS liq_w,
         NULL::jsonb AS sw_w, NULL::jsonb AS bos_w
  FROM historical_ict_ts01_orders_updated o
  JOIN historical_ict_ts01_daily_validation_updated d
    ON d.engine_version=o.engine_version AND d.cohort=o.cohort AND d.market=o.market
   AND d.ticker=o.ticker AND d.session_date=o.session_date
  WHERE o.engine_version='ts01_tb_r2.2026-08-18' AND o.cohort='primary' AND o.state='FILLED'
  UNION ALL
  -- V2 does not persist the wide per-timeframe overlay columns the original
  -- pipeline does. It does persist the three things that actually define the
  -- setup - the raided pool, the MSS, and the entry array - so those are shaped
  -- into the same 5m overlay contract here rather than returning a bare chart.
  SELECT 'ts01v2'::text AS pipeline, o.candidate_key AS signal_hash,
         'TS01-TB-V2'::text AS strategy_id, o.ticker, o.direction,
         o.fill_bar_ts AS entry_datetime,
         NULL::text AS weekly_bias,
         (SELECT g->'evidence'->>'htf_bias' FROM jsonb_array_elements(c.gates) g
           WHERE g->>'name' = 'HTF_BIAS_ALIGNMENT' LIMIT 1) AS daily_bias,
         NULL::text AS one_hour_bias,
         jsonb_build_object(
           'engine_version', o.engine_version,
           'strategy', 'TS01-TB-V2 (ICT 2022 Mentorship V2)',
           'direction', o.direction, 'variant', c.variant,
           'array_kind', o.array_kind, 'entry_depth', o.entry_depth,
           'raid', jsonb_build_object('pool', c.raid_pool, 'bar_ts', c.raid_bar_ts,
                                      'extreme', c.raid_extreme),
           'mss', jsonb_build_object('bar_ts', c.mss_bar_ts, 'swing_price', c.mss_swing_price,
                                     'close', c.mss_close),
           'displacement', c.displacement, 'entry_array', c.entry_array, 'gates', c.gates,
           'execution', jsonb_build_object('entry', o.entry_price, 'stop', o.stop_price,
                                           'risk_points', o.risk_points),
           'targets', o.targets, 'legs', o.legs, 'management', o.management
         ) AS strategy_json,
         CASE WHEN o.array_kind <> 'FVG' THEN jsonb_build_object('recent_10_order_blocks',
                jsonb_build_array(jsonb_build_object(
                  'top', c.entry_array->'hi', 'bottom', c.entry_array->'lo',
                  'formed_datetime_et', c.entry_array->>'ts',
                  'zone_type', o.array_kind, 'direction', o.direction,
                  'summary', 'V2 entry array (' || o.array_kind || ')')))
              END AS ob_5m,
         CASE WHEN o.array_kind = 'FVG' THEN jsonb_build_object('recent_10_fvgs',
                jsonb_build_array(jsonb_build_object(
                  'top', c.entry_array->'hi', 'bottom', c.entry_array->'lo',
                  'formed_datetime_et', c.entry_array->>'ts',
                  'zone_type', 'FVG', 'direction', o.direction,
                  'summary', 'V2 entry FVG, CE ' || COALESCE(c.entry_array->>'ce', '?'))))
              END AS fvg_5m,
         jsonb_build_object(
           CASE WHEN c.raid_pool->>'side' = 'BSL' THEN 'recent_10_buyside_liquidity_levels'
                ELSE 'recent_10_sellside_liquidity_levels' END,
           jsonb_build_array(jsonb_build_object(
             'level', c.raid_pool->'price', 'bar_timestamp_et', c.raid_bar_ts,
             'side', c.raid_pool->>'side', 'direction', o.direction,
             'ict_label', 'Raided ' || COALESCE(c.raid_pool->>'kind', 'pool')))) AS liq_5m,
         jsonb_build_object(
           CASE WHEN UPPER(o.direction) = 'BUY' THEN 'recent_10_swing_highs'
                ELSE 'recent_10_swing_lows' END,
           jsonb_build_array(jsonb_build_object(
             'level', c.mss_swing_price, 'bar_timestamp_et', c.mss_bar_ts,
             'direction', o.direction, 'ict_label', 'MSS swing'))) AS sw_5m,
         jsonb_build_object('recent_10_bos_mss_choch',
           jsonb_build_array(jsonb_build_object(
             'top', c.mss_swing_price, 'bottom', c.mss_swing_price,
             'event_datetime_et', c.mss_bar_ts, 'event_type', 'MSS',
             'direction', o.direction,
             'summary', 'MSS close ' || COALESCE(c.mss_close::text, '?')))) AS bos_5m,
         NULL::jsonb AS ob_15m, NULL::jsonb AS fvg_15m, NULL::jsonb AS liq_15m,
         NULL::jsonb AS sw_15m, NULL::jsonb AS bos_15m,
         NULL::jsonb AS ob_30m, NULL::jsonb AS fvg_30m, NULL::jsonb AS liq_30m,
         NULL::jsonb AS sw_30m, NULL::jsonb AS bos_30m,
         NULL::jsonb AS ob_1h, NULL::jsonb AS fvg_1h, NULL::jsonb AS liq_1h,
         NULL::jsonb AS sw_1h, NULL::jsonb AS bos_1h,
         NULL::jsonb AS ob_d, NULL::jsonb AS fvg_d, NULL::jsonb AS liq_d,
         NULL::jsonb AS sw_d, NULL::jsonb AS bos_d,
         NULL::jsonb AS ob_w, NULL::jsonb AS fvg_w, NULL::jsonb AS liq_w,
         NULL::jsonb AS sw_w, NULL::jsonb AS bos_w
  FROM historical_ict_ts01v2_orders o
  JOIN historical_ict_ts01v2_candidates c ON c.candidate_key = o.candidate_key
  WHERE o.engine_version='${TS01V2_ENGINE}' AND o.state='FILLED'
  UNION ALL
  -- S10-V3 persists its evidence as one nested object rather than as the wide
  -- per-timeframe overlay columns, and its zone timestamps are unix seconds.
  -- The overlay columns stay NULL here; extractS10V3Evidence() reshapes the
  -- payload into the overlay contract on the identification timeframe.
  SELECT 's10v3'::text AS pipeline, o.order_id AS signal_hash,
         'S10-V3'::text AS strategy_id, o.symbol AS ticker,
         CASE WHEN (o.payload->>'d')::int = 1 THEN 'BUY' ELSE 'SELL' END AS direction,
         to_timestamp((o.payload->>'fill_ts')::bigint) AS entry_datetime,
         NULL::text AS weekly_bias,
         CASE WHEN (o.payload->'strategy_json'->'daily'->>'bias')::int = 1 THEN 'bullish'
              WHEN (o.payload->'strategy_json'->'daily'->>'bias')::int = -1 THEN 'bearish'
         END AS daily_bias,
         NULL::text AS one_hour_bias,
         (o.payload->'strategy_json') || jsonb_build_object(
           'strategy_id', 'S10-V3', 'path', o.path, 'timeframe', o.timeframe,
           'execution', jsonb_build_object(
             'entry', o.payload->'entry', 'initial_stop', o.payload->'initial_stop',
             'risk_points', o.payload->'risk', 'targets', o.payload->'targets',
             'sizes', o.payload->'sizes', 'hits', o.payload->'hits',
             'exit_reason', o.payload->'reason', 'exit_price', o.payload->'exit_price')
         ) AS strategy_json,
         NULL::jsonb AS ob_5m, NULL::jsonb AS fvg_5m, NULL::jsonb AS liq_5m,
         NULL::jsonb AS sw_5m, NULL::jsonb AS bos_5m,
         NULL::jsonb AS ob_15m, NULL::jsonb AS fvg_15m, NULL::jsonb AS liq_15m,
         NULL::jsonb AS sw_15m, NULL::jsonb AS bos_15m,
         NULL::jsonb AS ob_30m, NULL::jsonb AS fvg_30m, NULL::jsonb AS liq_30m,
         NULL::jsonb AS sw_30m, NULL::jsonb AS bos_30m,
         NULL::jsonb AS ob_1h, NULL::jsonb AS fvg_1h, NULL::jsonb AS liq_1h,
         NULL::jsonb AS sw_1h, NULL::jsonb AS bos_1h,
         NULL::jsonb AS ob_d, NULL::jsonb AS fvg_d, NULL::jsonb AS liq_d,
         NULL::jsonb AS sw_d, NULL::jsonb AS bos_d,
         NULL::jsonb AS ob_w, NULL::jsonb AS fvg_w, NULL::jsonb AS liq_w,
         NULL::jsonb AS sw_w, NULL::jsonb AS bos_w
  FROM historical_ict_s10_v3_orders_updated o
  WHERE o.run_id='${S10V3_RUN}' AND o.state='CLOSED'
  UNION ALL
  -- S16-V2 keeps its whole causal decision trail in s16v2_setups.payload; the
  -- wide per-timeframe overlay columns stay NULL and extractS16V2Evidence()
  -- turns the payload into the overlay contract on the 5m execution timeframe.
  SELECT 's16v2'::text AS pipeline, st.setup_id AS signal_hash, 'S16-V2'::text AS strategy_id,
         st.symbol AS ticker, st.direction, st.decision_known_at AS entry_datetime,
         NULL::text AS weekly_bias,
         CASE WHEN st.direction = 'BUY' THEN 'bullish' ELSE 'bearish' END AS daily_bias,
         NULL::text AS one_hour_bias,
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
         ) AS strategy_json,
         NULL::jsonb AS ob_5m, NULL::jsonb AS fvg_5m, NULL::jsonb AS liq_5m,
         NULL::jsonb AS sw_5m, NULL::jsonb AS bos_5m,
         NULL::jsonb AS ob_15m, NULL::jsonb AS fvg_15m, NULL::jsonb AS liq_15m,
         NULL::jsonb AS sw_15m, NULL::jsonb AS bos_15m,
         NULL::jsonb AS ob_30m, NULL::jsonb AS fvg_30m, NULL::jsonb AS liq_30m,
         NULL::jsonb AS sw_30m, NULL::jsonb AS bos_30m,
         NULL::jsonb AS ob_1h, NULL::jsonb AS fvg_1h, NULL::jsonb AS liq_1h,
         NULL::jsonb AS sw_1h, NULL::jsonb AS bos_1h,
         NULL::jsonb AS ob_d, NULL::jsonb AS fvg_d, NULL::jsonb AS liq_d,
         NULL::jsonb AS sw_d, NULL::jsonb AS bos_d,
         NULL::jsonb AS ob_w, NULL::jsonb AS fvg_w, NULL::jsonb AS liq_w,
         NULL::jsonb AS sw_w, NULL::jsonb AS bos_w
  FROM s16v2_setups st
  JOIN s16v2_runs r ON r.run_id = st.run_id AND r.published
  JOIN s16v2_orders o ON o.run_id = st.run_id AND o.setup_id = st.setup_id AND o.state = 'FILLED'
  UNION ALL
  -- S01-V2: same contract as S16-V2 -- the payload is the evidence; extractS01V2Evidence()
  -- draws it on the 5m battleground chart.
  SELECT 's01v2'::text AS pipeline, st.setup_id AS signal_hash, 'S01-V2'::text AS strategy_id,
         st.symbol AS ticker, st.direction, st.rejection_ts AS entry_datetime,
         NULL::text AS weekly_bias,
         CASE WHEN st.direction = 'BUY' THEN 'bullish' ELSE 'bearish' END AS daily_bias,
         st.trend_1h AS one_hour_bias,
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
         ) AS strategy_json,
         NULL::jsonb AS ob_5m, NULL::jsonb AS fvg_5m, NULL::jsonb AS liq_5m,
         NULL::jsonb AS sw_5m, NULL::jsonb AS bos_5m,
         NULL::jsonb AS ob_15m, NULL::jsonb AS fvg_15m, NULL::jsonb AS liq_15m,
         NULL::jsonb AS sw_15m, NULL::jsonb AS bos_15m,
         NULL::jsonb AS ob_30m, NULL::jsonb AS fvg_30m, NULL::jsonb AS liq_30m,
         NULL::jsonb AS sw_30m, NULL::jsonb AS bos_30m,
         NULL::jsonb AS ob_1h, NULL::jsonb AS fvg_1h, NULL::jsonb AS liq_1h,
         NULL::jsonb AS sw_1h, NULL::jsonb AS bos_1h,
         NULL::jsonb AS ob_d, NULL::jsonb AS fvg_d, NULL::jsonb AS liq_d,
         NULL::jsonb AS sw_d, NULL::jsonb AS bos_d,
         NULL::jsonb AS ob_w, NULL::jsonb AS fvg_w, NULL::jsonb AS liq_w,
         NULL::jsonb AS sw_w, NULL::jsonb AS bos_w
  FROM s01v2_setups st
  JOIN s01v2_runs r ON r.run_id = st.run_id AND r.published
  JOIN s01v2_orders o ON o.run_id = st.run_id AND o.setup_id = st.setup_id AND o.state = 'FILLED'
  UNION ALL
  SELECT 's01v3'::text AS pipeline, st.setup_id AS signal_hash, 'S01-V3'::text AS strategy_id,
         st.symbol AS ticker, st.direction, st.rejection_ts AS entry_datetime,
         st.payload #>> '{bias,context,weekly}' AS weekly_bias,
         CASE WHEN st.direction = 'BUY' THEN 'bullish' ELSE 'bearish' END AS daily_bias,
         st.trend_1h AS one_hour_bias,
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
         ) AS strategy_json,
         NULL::jsonb AS ob_5m, NULL::jsonb AS fvg_5m, NULL::jsonb AS liq_5m,
         NULL::jsonb AS sw_5m, NULL::jsonb AS bos_5m,
         NULL::jsonb AS ob_15m, NULL::jsonb AS fvg_15m, NULL::jsonb AS liq_15m,
         NULL::jsonb AS sw_15m, NULL::jsonb AS bos_15m,
         NULL::jsonb AS ob_30m, NULL::jsonb AS fvg_30m, NULL::jsonb AS liq_30m,
         NULL::jsonb AS sw_30m, NULL::jsonb AS bos_30m,
         NULL::jsonb AS ob_1h, NULL::jsonb AS fvg_1h, NULL::jsonb AS liq_1h,
         NULL::jsonb AS sw_1h, NULL::jsonb AS bos_1h,
         NULL::jsonb AS ob_d, NULL::jsonb AS fvg_d, NULL::jsonb AS liq_d,
         NULL::jsonb AS sw_d, NULL::jsonb AS bos_d,
         NULL::jsonb AS ob_w, NULL::jsonb AS fvg_w, NULL::jsonb AS liq_w,
         NULL::jsonb AS sw_w, NULL::jsonb AS bos_w
  FROM s01v3_setups st
  JOIN s01v3_runs r ON r.run_id = st.run_id AND r.published
  JOIN s01v3_orders o ON o.run_id = st.run_id AND o.setup_id = st.setup_id AND o.state = 'FILLED'
  UNION ALL
  SELECT 'scalpv2'::text AS pipeline, st.setup_id AS signal_hash, 'Scalping_OB_OB_V2'::text AS strategy_id,
         st.symbol AS ticker, st.payload->>'direction' AS direction, st.entry_ts AS entry_datetime,
         NULL::text AS weekly_bias, NULL::text AS daily_bias, NULL::text AS one_hour_bias,
         st.payload AS strategy_json,
         NULL::jsonb AS ob_5m, NULL::jsonb AS fvg_5m, NULL::jsonb AS liq_5m, NULL::jsonb AS sw_5m, NULL::jsonb AS bos_5m,
         NULL::jsonb AS ob_15m, NULL::jsonb AS fvg_15m, NULL::jsonb AS liq_15m, NULL::jsonb AS sw_15m, NULL::jsonb AS bos_15m,
         NULL::jsonb AS ob_30m, NULL::jsonb AS fvg_30m, NULL::jsonb AS liq_30m, NULL::jsonb AS sw_30m, NULL::jsonb AS bos_30m,
         NULL::jsonb AS ob_1h, NULL::jsonb AS fvg_1h, NULL::jsonb AS liq_1h, NULL::jsonb AS sw_1h, NULL::jsonb AS bos_1h,
         NULL::jsonb AS ob_d, NULL::jsonb AS fvg_d, NULL::jsonb AS liq_d, NULL::jsonb AS sw_d, NULL::jsonb AS bos_d,
         NULL::jsonb AS ob_w, NULL::jsonb AS fvg_w, NULL::jsonb AS liq_w, NULL::jsonb AS sw_w, NULL::jsonb AS bos_w
  FROM scalping_ob_ob_v2_setups st
  JOIN scalping_ob_ob_v2_runs r ON r.run_id = st.run_id AND r.published
  UNION ALL
  SELECT 'scalpv4'::text AS pipeline, st.setup_id AS signal_hash, 'Scalping_OB_OB_V4'::text AS strategy_id,
         st.symbol AS ticker, st.payload->>'direction' AS direction, st.entry_ts AS entry_datetime,
         NULL::text AS weekly_bias, NULL::text AS daily_bias, NULL::text AS one_hour_bias,
         st.payload AS strategy_json,
         NULL::jsonb AS ob_5m, NULL::jsonb AS fvg_5m, NULL::jsonb AS liq_5m, NULL::jsonb AS sw_5m, NULL::jsonb AS bos_5m,
         NULL::jsonb AS ob_15m, NULL::jsonb AS fvg_15m, NULL::jsonb AS liq_15m, NULL::jsonb AS sw_15m, NULL::jsonb AS bos_15m,
         NULL::jsonb AS ob_30m, NULL::jsonb AS fvg_30m, NULL::jsonb AS liq_30m, NULL::jsonb AS sw_30m, NULL::jsonb AS bos_30m,
         NULL::jsonb AS ob_1h, NULL::jsonb AS fvg_1h, NULL::jsonb AS liq_1h, NULL::jsonb AS sw_1h, NULL::jsonb AS bos_1h,
         NULL::jsonb AS ob_d, NULL::jsonb AS fvg_d, NULL::jsonb AS liq_d, NULL::jsonb AS sw_d, NULL::jsonb AS bos_d,
         NULL::jsonb AS ob_w, NULL::jsonb AS fvg_w, NULL::jsonb AS liq_w, NULL::jsonb AS sw_w, NULL::jsonb AS bos_w
  FROM scalping_ob_ob_v4_setups st
  JOIN scalping_ob_ob_v4_runs r ON r.run_id = st.run_id AND r.published
  UNION ALL
  SELECT 'bprv3'::text AS pipeline, st.setup_id AS signal_hash, 'BPR_OB_V3'::text AS strategy_id,
         st.symbol AS ticker, st.payload->>'direction' AS direction, st.entry_ts AS entry_datetime,
         NULL::text AS weekly_bias, NULL::text AS daily_bias, NULL::text AS one_hour_bias,
         st.payload AS strategy_json,
         NULL::jsonb AS ob_5m, NULL::jsonb AS fvg_5m, NULL::jsonb AS liq_5m, NULL::jsonb AS sw_5m, NULL::jsonb AS bos_5m,
         NULL::jsonb AS ob_15m, NULL::jsonb AS fvg_15m, NULL::jsonb AS liq_15m, NULL::jsonb AS sw_15m, NULL::jsonb AS bos_15m,
         NULL::jsonb AS ob_30m, NULL::jsonb AS fvg_30m, NULL::jsonb AS liq_30m, NULL::jsonb AS sw_30m, NULL::jsonb AS bos_30m,
         NULL::jsonb AS ob_1h, NULL::jsonb AS fvg_1h, NULL::jsonb AS liq_1h, NULL::jsonb AS sw_1h, NULL::jsonb AS bos_1h,
         NULL::jsonb AS ob_d, NULL::jsonb AS fvg_d, NULL::jsonb AS liq_d, NULL::jsonb AS sw_d, NULL::jsonb AS bos_d,
         NULL::jsonb AS ob_w, NULL::jsonb AS fvg_w, NULL::jsonb AS liq_w, NULL::jsonb AS sw_w, NULL::jsonb AS bos_w
  FROM scalping_bpr_ob_v3_setups st
  JOIN scalping_bpr_ob_v3_runs r ON r.run_id = st.run_id AND r.published
)`;

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function epoch(v: string | null): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

// choose candle table by window length (seconds)
// `allowOneMinute` is set for the IGS forex series. 1m is its execution
// granularity, and it is not optional: the forex rows in historical_candles_5m
// /_15m/_1h stop at 2026-06-26 while historical_candles_1m runs to September,
// so falling through to the 5m table renders an EMPTY chart for any IGS trade
// after June rather than a coarse one.
function pickTable(spanSec: number, allowOneMinute = false) {
  const day = 86400;
  if (allowOneMinute && spanSec <= 2 * day) return { table: "historical_candles_1m", stepSec: 60 };
  if (spanSec <= 4 * day) return { table: "historical_candles_5m", stepSec: 300 };
  if (spanSec <= 25 * day) return { table: "historical_candles_1h", stepSec: 3600 };
  return { table: "candles_1d", stepSec: 86400 };
}

type ObjRow = Record<string, unknown>;
type StrategyTimeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "1D" | "1W";
type TimeframeOverlayKey = "timeframe_1m" | "timeframe_5m" | "timeframe_15m" | "timeframe_30m" | "timeframe_1h" | "timeframe_daily" | "timeframe_weekly";

function obj(value: unknown): ObjRow {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjRow : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function strategyTimeframe(value: unknown): { key: StrategyTimeframe; overlayKey: TimeframeOverlayKey; seconds: number } | null {
  const normalized = text(value)?.toLowerCase().replaceAll(" ", "").replace("minute", "m").replace("hour", "h");
  if (!normalized) return null;
  if (["1m", "1min"].includes(normalized)) return { key: "1m", overlayKey: "timeframe_1m", seconds: 60 };
  if (["5m", "5min"].includes(normalized)) return { key: "5m", overlayKey: "timeframe_5m", seconds: 300 };
  if (["15m", "15min"].includes(normalized)) return { key: "15m", overlayKey: "timeframe_15m", seconds: 900 };
  if (["30m", "30min"].includes(normalized)) return { key: "30m", overlayKey: "timeframe_30m", seconds: 1800 };
  if (["1h", "60m", "60min"].includes(normalized)) return { key: "1h", overlayKey: "timeframe_1h", seconds: 3600 };
  if (["1d", "daily", "day"].includes(normalized)) return { key: "1D", overlayKey: "timeframe_daily", seconds: 86400 };
  if (["1w", "weekly", "week"].includes(normalized)) return { key: "1W", overlayKey: "timeframe_weekly", seconds: 604800 };
  return null;
}

/** Map S10-V2's persisted BPR evidence onto its JSON-selected identification timeframe. */
function extractS10V2Evidence(strategyJson: unknown, fallbackDirection: unknown) {
  const root = obj(strategyJson);
  const bpr = obj(root.bpr);
  const bullishFvg = obj(root.bullish_fvg);
  const bearishFvg = obj(root.bearish_fvg);
  const dol = obj(root.dol);
  const pd = obj(root.pd_location);
  const tags = obj(root.tags);
  const timeframe = strategyTimeframe(root.identification_timeframe ?? bpr.timeframe ?? tags.timeframe);
  if (!timeframe) return null;

  const direction = text(root.direction) || text(fallbackDirection);
  const pairTime = epoch(text(bpr.pair_ts));
  const overlays = { order_blocks: [] as ObjRow[], fvgs: [] as ObjRow[], structure: [] as ObjRow[], liquidity: [] as ObjRow[], swings: [] as ObjRow[] };
  const evidenceTimes: number[] = [];
  const addZone = (source: ObjRow, label: string, zoneDirection: string | null, kind = "fvg") => {
    const top = num(source.top);
    const bottom = num(source.bottom);
    const time = epoch(text(source.formed_ts) || text(source.pair_ts));
    if (top === null || bottom === null || time === null) return;
    evidenceTimes.push(time);
    const zone = { kind, top, bottom, time, direction: zoneDirection, broken: false, mitigated: false, filled: false, label };
    if (kind === "bpr") overlays.order_blocks.push(zone);
    else overlays.fvgs.push(zone);
  };

  addZone(bullishFvg, "S10-V2 BULLISH FVG LEG", "BUY");
  addZone(bearishFvg, "S10-V2 BEARISH FVG LEG", "SELL");
  const ce = num(bpr.ce);
  addZone(bpr, `S10-V2 BPR${ce === null ? "" : ` · CE ${ce.toFixed(2)}`}`, direction, "bpr");

  const dolLevel = num(dol.level);
  if (dolLevel !== null && pairTime !== null) {
    evidenceTimes.push(pairTime);
    overlays.liquidity.push({
      kind: "liquidity",
      level: dolLevel,
      time: pairTime,
      side: text(dol.side),
      direction,
      label: `DRAW ON LIQUIDITY · ${(text(dol.side) || "DOL").toUpperCase()} · ${(text(dol.method) || "PERSISTED").toUpperCase()}`,
    });
  }

  const low = num(pd.ipda20_low);
  const eq50 = num(pd.ipda20_eq);
  const high = num(pd.ipda20_high);
  const ipda = low !== null && eq50 !== null && high !== null
    ? {
        low,
        q25: low + (high - low) * 0.25,
        eq50,
        q75: low + (high - low) * 0.75,
        high,
        start_time: null,
        end_time: pairTime,
        sessions: 20,
        selected_level: text(pd.half),
      }
    : null;

  return {
    direction,
    timeframe: timeframe.key,
    overlayKey: timeframe.overlayKey,
    timeframeSeconds: timeframe.seconds,
    earliestTime: evidenceTimes.length ? Math.min(...evidenceTimes) : pairTime,
    overlays,
    ipda,
    dailyBias: text(tags.daily_bias),
  };
}

/**
 * Map S10-V3's persisted evidence onto its identification timeframe.
 *
 * V3 stores the Balanced Price Range as a `pair` (hi/lo/formed) built from two
 * opposing FVG `legs`, alongside the daily gate and the inefficiencies it was
 * drawing towards.  Unlike V2, its timestamps are unix seconds rather than ISO
 * strings, so they are read directly rather than through `epoch`.
 */
function extractS10V3Evidence(strategyJson: unknown, fallbackDirection: unknown) {
  const root = obj(strategyJson);
  const pair = obj(root.pair);
  const daily = obj(root.daily);
  const timeframe = strategyTimeframe(pair.tf ?? root.timeframe);
  if (!timeframe) return null;

  const sideOf = (value: unknown) => {
    const n = num(value);
    return n === null ? null : n > 0 ? "BUY" : "SELL";
  };
  const unix = (value: unknown) => {
    const n = num(value);
    return n === null ? null : Math.round(n);
  };
  const direction = sideOf(pair.d) ?? text(fallbackDirection);
  const pairTime = unix(pair.formed);

  const overlays = { order_blocks: [] as ObjRow[], fvgs: [] as ObjRow[], structure: [] as ObjRow[], liquidity: [] as ObjRow[], swings: [] as ObjRow[] };
  const evidenceTimes: number[] = [];
  const addZone = (source: ObjRow, label: string, zoneDirection: string | null, kind = "fvg") => {
    const top = num(source.hi);
    const bottom = num(source.lo);
    const time = unix(source.formed);
    if (top === null || bottom === null || time === null) return;
    evidenceTimes.push(time);
    const zone = { kind, top, bottom, time, direction: zoneDirection, broken: false, mitigated: false, filled: false, label };
    if (kind === "bpr") overlays.order_blocks.push(zone);
    else overlays.fvgs.push(zone);
  };

  // The two opposing FVG legs whose overlap defines the BPR.
  for (const raw of Array.isArray(pair.legs) ? pair.legs : []) {
    const leg = obj(raw);
    const legSide = sideOf(leg.d);
    const quality = num(leg.quality);
    addZone(leg, `S10-V3 ${legSide === "BUY" ? "BULLISH" : "BEARISH"} FVG LEG${quality === null ? "" : ` · Q ${quality.toFixed(2)}`}`, legSide);
  }
  const pairQuality = num(pair.quality);
  addZone(pair, `S10-V3 BPR${pairQuality === null ? "" : ` · Q ${pairQuality.toFixed(2)}`}`, direction, "bpr");

  // Unconsumed inefficiencies the engine was targeting.
  for (const raw of Array.isArray(root.target_fvgs) ? root.target_fvgs : []) {
    const target = obj(raw);
    addZone(target, "S10-V3 TARGET FVG", sideOf(target.d));
  }

  // Daily swing pivots that framed the draw on liquidity.
  for (const raw of Array.isArray(daily.pivots) ? daily.pivots : []) {
    const pivot = obj(raw);
    const level = num(pivot.level);
    const time = unix(pivot.known_at) ?? pairTime;
    if (level === null || time === null) continue;
    const side = num(pivot.side);
    evidenceTimes.push(time);
    overlays.liquidity.push({
      kind: "liquidity",
      level,
      time,
      side: side === null ? null : side > 0 ? "BSL" : "SSL",
      direction,
      label: `DAILY PIVOT · ${side !== null && side > 0 ? "BSL" : "SSL"}`,
    });
  }

  // V3 gates entries off the daily premium/discount envelope, so render it in
  // the same band the other strategies use for their IPDA range.
  const low = num(daily.lo);
  const high = num(daily.hi);
  const eq50 = num(daily.eq);
  const ipda = low !== null && high !== null && eq50 !== null
    ? {
        low,
        q25: low + (high - low) * 0.25,
        eq50,
        q75: low + (high - low) * 0.75,
        high,
        start_time: null,
        end_time: unix(daily.known_at) ?? pairTime,
        sessions: 20,
        selected_level: null as string | null,
      }
    : null;

  const bias = num(daily.bias);
  return {
    direction,
    timeframe: timeframe.key,
    overlayKey: timeframe.overlayKey,
    timeframeSeconds: timeframe.seconds,
    earliestTime: evidenceTimes.length ? Math.min(...evidenceTimes) : pairTime,
    overlays,
    ipda,
    dailyBias: bias === null ? null : bias > 0 ? "bullish" : "bearish",
  };
}

/** S16-V2: sweep -> MSS -> leg PD array -> stop -> bucketed targets, all on the 5m execution timeframe. */
function extractS16V2Evidence(strategyJson: unknown, fallbackDirection: unknown) {
  const root = obj(strategyJson);
  const direction = text(root.direction) ?? text(fallbackDirection);
  const buy = (direction || "").toUpperCase() !== "SELL";
  const overlays = { order_blocks: [] as ObjRow[], fvgs: [] as ObjRow[], structure: [] as ObjRow[], liquidity: [] as ObjRow[], swings: [] as ObjRow[] };
  const times: number[] = [];
  const t = (v: unknown) => epoch(text(v));
  const level = (price: unknown, time: unknown, label: string, side: string | null, kind = "liquidity") => {
    const p = num(price);
    const tt = t(time);
    if (p === null || tt === null) return;
    times.push(tt);
    (kind === "swing" ? overlays.swings : overlays.liquidity).push({ kind, level: p, time: tt, side, direction, label });
  };
  const zone = (lohi: unknown, time: unknown, label: string, kind: "fvg" | "order_block", zoneDirection: string | null) => {
    const arr = Array.isArray(lohi) ? lohi : [];
    const a = num(arr[0]);
    const b = num(arr[1]);
    const tt = t(time);
    if (a === null || b === null || tt === null) return;
    times.push(tt);
    const z = { kind, top: Math.max(a, b), bottom: Math.min(a, b), time: tt, direction: zoneDirection, broken: false, mitigated: false, filled: false, label };
    if (kind === "order_block") overlays.order_blocks.push(z);
    else overlays.fvgs.push(z);
  };

  const pool = obj(root.selected_pool);
  const poolSide = buy ? "SSL" : "BSL";
  level(pool.price, pool.formed ?? pool.known_at,
        `SWEPT POOL · ${(text(pool.tf) || "").toUpperCase()} ${text(pool.kind) || ""}${pool.ref ? ` ${text(pool.ref)}` : ""}`.trim(), poolSide);
  const sweep = obj(root.sweep);
  const extreme = obj(root.sweep_extreme);
  level(extreme.price, extreme.ts, buy ? "SWEEP LOW (RAID EXTREME)" : "SWEEP HIGH (RAID EXTREME)", poolSide);
  const mss = obj(root.mss);
  const mssTime = t(mss.ts);
  const broken = num(mss.broken_swing);
  if (mssTime !== null && broken !== null) {
    times.push(mssTime);
    overlays.structure.push({ kind: "mss", top: broken, bottom: broken, time: mssTime, direction, broken: false, mitigated: false, filled: false, label: "MSS · 5M CLOSE BEYOND SWING" });
  }
  const disp = obj(root.displacement);
  const dispTime = t(disp.ts);
  if (dispTime !== null) times.push(dispTime);

  const pd = obj(root.pd_array);
  const pdType = text(pd.type) || "FVG";
  zone(pd.zone, pd.formed, `S16-V2 ENTRY ${pdType === "OVERLAP" ? "FVG+OB OVERLAP" : pdType} · CE ${num(pd.ce) ?? ""}`,
       pdType === "OB" ? "order_block" : "fvg", direction);

  const stop = obj(root.stop);
  level(stop.price, extreme.ts ?? sweep.ts, "STOP · BEYOND SWEEP EXTREME", null, "swing");

  for (const raw of Array.isArray(root.targets) ? root.targets : []) {
    const tg = obj(raw);
    const bucket = num(tg.bucket);
    const fam = text(tg.family) || "";
    const label = `TP${bucket ?? ""} · ${fam === "PROJECTION" ? "PROJECTION (NO ICT LEVEL)" : `${(text(tg.tf) || "").toUpperCase()} ${fam}`} · ${num(tg.rr_plan)?.toFixed(2) ?? ""}R`;
    const when = tg.formed ?? tg.known_at ?? mss.ts;
    if (Array.isArray(tg.zone)) zone(tg.zone, when, label, "fvg", buy ? "SELL" : "BUY");
    level(tg.price, when, label, buy ? "BSL" : "SSL");
  }

  const lo = num(extreme.price);
  const hi = num(mss.mss_point);
  const eq = num(mss.discount_line);
  const ipda = lo !== null && hi !== null && eq !== null
    ? {
        low: Math.min(lo, hi),
        q25: Math.min(lo, hi) + Math.abs(hi - lo) * 0.25,
        eq50: eq,
        q75: Math.min(lo, hi) + Math.abs(hi - lo) * 0.75,
        high: Math.max(lo, hi),
        start_time: t(extreme.ts),
        end_time: mssTime,
        sessions: 1,
        selected_level: buy ? "DISCOUNT (SWEEP LOW → MSS HIGH)" : "PREMIUM (SWEEP HIGH → MSS LOW)",
        anchored: true,
        title: "S16-V2 sweep→MSS leg fib",
      }
    : null;
  const sweepTime = t(sweep.ts);
  return {
    direction,
    timeframe: "5m" as StrategyTimeframe,
    overlayKey: "timeframe_5m" as TimeframeOverlayKey,
    timeframeSeconds: 300,
    // anchor the window on the raid, not on a pool that may have formed days earlier
    earliestTime: sweepTime ?? (times.length ? Math.min(...times) : null),
    overlays,
    ipda,
    dailyBias: buy ? "bullish" : "bearish",
  };
}

/**
 * S01-V2 Bread & Butter: HTF (15m/30m/1h) sweep of the best pool -> 5m displacement ->
 * MSS/BOS/CHoCH -> 5m FVG/OB in discount -> rejection close beyond the zone -> market
 * fill at the next 5m open -> S16-V2 bucketed targets. Drawn on the 5m battleground chart.
 */
function extractS01V2Evidence(strategyJson: unknown, fallbackDirection: unknown, strategyCode = "S01-V2") {
  const root = obj(strategyJson);
  const direction = text(root.direction) ?? text(fallbackDirection);
  const buy = (direction || "").toUpperCase() !== "SELL";
  const overlays = { order_blocks: [] as ObjRow[], fvgs: [] as ObjRow[], structure: [] as ObjRow[], liquidity: [] as ObjRow[], swings: [] as ObjRow[] };
  const times: number[] = [];
  const t = (v: unknown) => epoch(text(v));
  const level = (price: unknown, time: unknown, label: string, side: string | null, kind = "liquidity") => {
    const p = num(price);
    const tt = t(time);
    if (p === null || tt === null) return;
    times.push(tt);
    (kind === "swing" ? overlays.swings : overlays.liquidity).push({ kind, level: p, time: tt, side, direction, label });
  };
  const zone = (lohi: unknown, time: unknown, label: string, kind: "fvg" | "order_block", zoneDirection: string | null) => {
    const arr = Array.isArray(lohi) ? lohi : [];
    const a = num(arr[0]);
    const b = num(arr[1]);
    const tt = t(time);
    if (a === null || b === null || tt === null) return;
    times.push(tt);
    const z = { kind, top: Math.max(a, b), bottom: Math.min(a, b), time: tt, direction: zoneDirection, broken: false, mitigated: false, filled: false, label };
    if (kind === "order_block") overlays.order_blocks.push(z);
    else overlays.fvgs.push(z);
  };

  const poolSide = buy ? "SSL" : "BSL";
  const pool = obj(root.selected_pool);
  const sweep = obj(root.sweep);
  const sweepTf = (text(sweep.tf) || "").toUpperCase();
  level(pool.price, pool.formed ?? pool.known_at,
        `SWEPT POOL · ${(text(pool.tf) || "").toUpperCase()} ${text(pool.kind) || ""}${pool.ref ? ` ${text(pool.ref)}` : ""} · SWEEP ON ${sweepTf}${sweep.killzone ? ` · ${text(sweep.killzone)}` : ""}`.trim(), poolSide);
  const extreme = obj(root.sweep_extreme);
  level(extreme.price, extreme.ts, buy ? "SWEEP LOW (RAID EXTREME)" : "SWEEP HIGH (RAID EXTREME)", poolSide);

  const disp = obj(root.displacement);
  const dispTime = t(disp.ts);
  if (dispTime !== null) times.push(dispTime);
  const sb = obj(root.structure_break);
  const sbTime = t(sb.ts);
  const broken = num(sb.broken_swing);
  if (sbTime !== null && broken !== null) {
    times.push(sbTime);
    overlays.structure.push({ kind: "mss", top: broken, bottom: broken, time: sbTime, direction, broken: false, mitigated: false, filled: false,
                              label: `${(text(sb.label) || "MSS").toUpperCase()} · 5M CLOSE BEYOND SWING` });
  }

  const pd = obj(root.pd_array);
  const pdType = text(pd.type) || "FVG";
  zone(pd.zone, pd.formed, `${strategyCode} ENTRY ${pdType === "OVERLAP" ? "FVG+OB OVERLAP" : pdType} · 5M`,
       pdType === "OB" ? "order_block" : "fvg", direction);

  const rej = obj(root.rejection);
  level(rej.e_plan, rej.ts, "REJECTION CLOSE (E_PLAN) · FILL NEXT 5M OPEN", null, "swing");
  const stop = obj(root.stop);
  level(stop.price, extreme.ts ?? sweep.candle_open, "STOP · BEYOND SWEEP EXTREME", null, "swing");

  for (const raw of Array.isArray(root.targets) ? root.targets : []) {
    const tg = obj(raw);
    const bucket = num(tg.bucket);
    const fam = text(tg.family) || "";
    const label = `TP${bucket ?? ""} · ${fam === "PROJECTION" ? "PROJECTION (NO ICT LEVEL)" : `${(text(tg.tf) || "").toUpperCase()} ${fam}`} · ${num(tg.rr_plan)?.toFixed(2) ?? ""}R`;
    const when = tg.formed ?? tg.known_at ?? rej.ts ?? sb.ts;
    if (Array.isArray(tg.zone)) zone(tg.zone, when, label, "fvg", buy ? "SELL" : "BUY");
    level(tg.price, when, label, buy ? "BSL" : "SSL");
  }

  // Spec 1.3: the fib is measured through the rejection candle (entry datetime), not frozen at
  // the MSS candle. Older runs without `fib_at_entry` fall back to the sweep->MSS leg.
  const fib = obj(root.fib_at_entry);
  const hasFib = num(fib.leg_extreme) !== null;
  const lo = num(extreme.price);
  const hi = hasFib ? num(fib.leg_extreme) : num(sb.leg_high);
  const eq = hasFib ? num(fib.eq) : num(sb.discount_line);
  if (hasFib) {
    level(fib.leg_extreme, fib.leg_extreme_ts,
          `${buy ? "LEG HIGH" : "LEG LOW"} AT ENTRY · ENTRY AT ${Math.round((num(fib.entry_location_pct) ?? 0) * 100)}% OF LEG`, null, "swing");
  }
  const ipda = lo !== null && hi !== null
    ? {
        low: Math.min(lo, hi),
        q25: Math.min(lo, hi) + Math.abs(hi - lo) * 0.25,
        eq50: eq ?? (lo + hi) / 2,
        q75: Math.min(lo, hi) + Math.abs(hi - lo) * 0.75,
        high: Math.max(lo, hi),
        start_time: t(extreme.ts),
        end_time: hasFib ? t(rej.ts) ?? sbTime : sbTime,
        sessions: 1,
        selected_level: buy ? "DISCOUNT (SWEEP LOW → LEG HIGH AT ENTRY)" : "PREMIUM (SWEEP HIGH → LEG LOW AT ENTRY)",
        anchored: true,
        title: hasFib ? `${strategyCode} sweep→entry leg fib` : `${strategyCode} sweep→structure-break leg fib`,
      }
    : null;
  const sweepTime = t(sweep.candle_open);

  // ---- Higher-timeframe labels: each selected data point on the timeframe it was taken from ----
  // The chart shows at most 2 liquidity / 2 swing / 2 structure labels per timeframe, so each
  // timeframe gets: liquidity = selected pool + sweep candle; swings = entry (with that TF's bias
  // or trend) + one other swept pool; structure = targets taken from that TF.
  type Bucket = { order_blocks: ObjRow[]; fvgs: ObjRow[]; structure: ObjRow[]; liquidity: ObjRow[]; swings: ObjRow[] };
  const newBucket = (): Bucket => ({ order_blocks: [], fvgs: [], structure: [], liquidity: [], swings: [] });
  const htf: Record<"timeframe_15m" | "timeframe_30m" | "timeframe_1h" | "timeframe_daily", Bucket> = {
    timeframe_15m: newBucket(), timeframe_30m: newBucket(), timeframe_1h: newBucket(), timeframe_daily: newBucket(),
  };
  const htfKey = (tf: unknown) => {
    const v = (text(tf) || "").toLowerCase();
    return v === "15m" ? "timeframe_15m" : v === "30m" ? "timeframe_30m" : v === "1h" ? "timeframe_1h"
      : v === "d" || v === "w" || v === "m" ? "timeframe_daily" : null;
  };
  const htfLevel = (key: keyof typeof htf | null, kind: "liquidity" | "swing", price: unknown, time: unknown, label: string, side: string | null) => {
    const p = num(price);
    const tt = t(time);
    if (!key || p === null || tt === null) return;
    (kind === "swing" ? htf[key].swings : htf[key].liquidity).push({ kind, level: p, time: tt, side, direction, label });
  };
  const poolName = (p: ObjRow) => `${(text(p.tf) || "").toUpperCase()} ${text(p.ref) || text(p.kind) || ""}${num(p.touches) ? ` ×${num(p.touches)}` : ""}`.trim();
  // selected pool on its own timeframe (PDL/PWL references land on the daily chart)
  htfLevel(htfKey(pool.tf), "liquidity", pool.price, pool.formed ?? pool.known_at,
           `SELECTED POOL · ${poolName(pool)} ${num(pool.price) ?? ""} · ${text(pool.family) || ""}`, poolSide);
  // the sweep candle on the sweep timeframe: wick beyond the pool, close back inside
  htfLevel(htfKey(sweep.tf), "liquidity", sweep.low, sweep.candle_open,
           `SWEEP CANDLE ${sweepTf} · WICK ${num(sweep.low) ?? ""} · CLOSE ${num(sweep.close) ?? ""} BACK INSIDE`, poolSide);
  // one other pool raided by the same move, per timeframe (most recent)
  const selectedId = text(pool.id);
  const seenOther = new Set<string>();
  const others = (Array.isArray(root.swept_pools) ? root.swept_pools : []).map(obj)
    .filter((p) => text(p.id) !== selectedId)
    .sort((a, b) => (t(b.formed) ?? 0) - (t(a.formed) ?? 0));
  for (const p of others) {
    const key = htfKey(p.tf);
    if (!key || seenOther.has(key)) continue;
    seenOther.add(key);
    htfLevel(key, "swing", p.price, p.formed ?? p.known_at, `ALSO SWEPT · ${poolName(p)} ${num(p.price) ?? ""}`, poolSide);
  }
  // entry marker carrying that timeframe's filter reading
  const trend = obj(root.trend);
  const entryPx = rej.e_plan;
  const entryAt = rej.ts ?? sb.ts;
  const upper = (v: unknown) => (text(v) || "n/a").toUpperCase();
  htfLevel("timeframe_daily", "swing", entryPx, entryAt, `ENTRY · DAILY BIAS ${buy ? "BULLISH" : "BEARISH"} (250 D BARS) · PERMITS ${buy ? "BUY" : "SELL"}`, null);
  htfLevel("timeframe_1h", "swing", entryPx, entryAt, `ENTRY · 1H TREND ${upper(trend["1h"])} (150 BARS · GATE)`, null);
  htfLevel("timeframe_30m", "swing", entryPx, entryAt, `ENTRY · 30M TREND ${upper(trend["30m"])} (150 BARS · GATE)`, null);
  htfLevel("timeframe_15m", "swing", entryPx, entryAt, `ENTRY · 15M TREND ${upper(trend["15m"])} (150 BARS · INFO ONLY)`, null);
  // targets on the timeframe they were taken from
  for (const raw of Array.isArray(root.targets) ? root.targets : []) {
    const tg = obj(raw);
    const key = htfKey(tg.tf);
    const p = num(tg.price);
    const when = t(tg.formed ?? tg.known_at);
    if (!key || p === null || when === null) continue;
    const label = `TP${num(tg.bucket) ?? ""} · ${(text(tg.tf) || "").toUpperCase()} ${text(tg.ref) || text(tg.gap) || text(tg.family) || ""} · ${num(tg.rr_plan)?.toFixed(2) ?? ""}R`;
    htf[key].structure.push({ kind: "target", top: p, bottom: p, time: when, direction, broken: false, mitigated: false, filled: false, label });
    const z = Array.isArray(tg.zone) ? tg.zone : null;
    if (z && num(z[0]) !== null && num(z[1]) !== null) {
      htf[key].fvgs.push({ kind: "fvg", top: Math.max(num(z[0])!, num(z[1])!), bottom: Math.min(num(z[0])!, num(z[1])!), time: when,
                           direction: buy ? "SELL" : "BUY", broken: false, mitigated: false, filled: false, label });
    }
  }

  return {
    direction,
    timeframe: "5m" as StrategyTimeframe,
    overlayKey: "timeframe_5m" as TimeframeOverlayKey,
    timeframeSeconds: 300,
    earliestTime: sweepTime ?? (times.length ? Math.min(...times) : null),
    overlays,
    ipda,
    dailyBias: buy ? "bullish" : "bearish",
    oneHourBias: text(trend["1h"]),
    htf,
  };
}

/** Extract only pre-entry IPDA/MSS/FVG evidence that the V5 detector persisted. */
function extractIpdaEvidence(strategyJson: unknown, direction: unknown) {
  const pattern = obj(obj(strategyJson).pattern);
  const range = obj(pattern.ipda_range);
  const fvg = obj(pattern.fvg);
  const mss = obj(pattern.mss);
  const stopSwing = obj(pattern.previous_confirmed_swing_stop);
  const sweep = obj(pattern.liquidity_extreme);
  const low = num(range.low);
  const q25 = num(range.q25);
  const eq50 = num(range.eq50);
  const q75 = num(range.q75);
  const high = num(range.high);
  const ipda = [low, q25, eq50, q75, high].every((value) => value !== null)
    ? {
        low, q25, eq50, q75, high,
        start_time: epoch(text(range.start_ts)),
        end_time: epoch(text(range.end_ts)),
        sessions: num(range.sessions) ?? 20,
        selected_level: text(pattern.ipda_level_name),
      }
    : null;
  const fvgTime = epoch(text(fvg.formation_ts));
  const fvgLow = num(fvg.zone_low);
  const fvgHigh = num(fvg.zone_high);
  const fvgOverlay = fvgTime !== null && fvgLow !== null && fvgHigh !== null
    ? { kind: "fvg", top: fvgHigh, bottom: fvgLow, time: fvgTime, direction: text(fvg.direction) || text(direction), broken: false, mitigated: false, filled: false, label: "VIRGIN FVG · FIRST TOUCH" }
    : null;
  const mssTime = epoch(text(mss.break_ts));
  const mssPrice = num(mss.break_close) ?? num(obj(mss.pivot).price);
  const mssOverlay = mssTime !== null && mssPrice !== null
    ? { kind: "mss", top: mssPrice, bottom: mssPrice, time: mssTime, direction: text(mss.direction) || text(direction), broken: false, mitigated: false, filled: false, label: "MSS · CLOSE CONFIRMED" }
    : null;
  const swingTime = epoch(text(stopSwing.confirmation_ts) || text(stopSwing.pivot_ts));
  const swingPrice = num(stopSwing.price);
  const swingOverlay = swingTime !== null && swingPrice !== null
    ? { kind: "swing", level: swingPrice, time: swingTime, side: text(stopSwing.kind), direction: text(direction), label: `${text(stopSwing.timeframe)?.toUpperCase() || "STRUCTURAL"} STOP SWING` }
    : null;
  const sweepTime = epoch(text(sweep.source_ts));
  const sweepPrice = num(sweep.price);
  const sweepOverlay = sweepTime !== null && sweepPrice !== null
    ? { kind: "liquidity", level: sweepPrice, time: sweepTime, side: null, direction: text(direction), label: "LIQUIDITY SWEEP" }
    : null;
  return { ipda, fvgOverlay, mssOverlay, swingOverlay, sweepOverlay };
}

/** Map IGS02's five persisted qualification steps onto the 1m chart. */
function extractIgs02Evidence(strategyJson: unknown, fallbackDirection: unknown) {
  const root = obj(strategyJson);
  const direction = (text(root.direction) ?? text(fallbackDirection) ?? "BUY").toUpperCase();
  const overlays = { order_blocks: [] as ObjRow[], fvgs: [] as ObjRow[], structure: [] as ObjRow[], liquidity: [] as ObjRow[], swings: [] as ObjRow[] };
  const evidenceTimes: number[] = [];
  const steps = Array.isArray(root.checklist) ? root.checklist.map(obj) : [];
  const detailsForStep = (stepNo: number) => {
    const step = steps.find((item) => num(item.step) === stepNo);
    return obj(obj(step?.status).details);
  };
  const remember = (time: number | null) => {
    if (time !== null) evidenceTimes.push(time);
    return time;
  };
  const etClock = (value: unknown) => text(value)?.match(/[ T](\d{2}:\d{2})/)?.[1] ?? null;
  const setupTf = (text(obj(root.timeframe).setup) || "2m").toUpperCase();

  const accumulation = detailsForStep(1);
  const accumulationLow = num(accumulation.low);
  const accumulationHigh = num(accumulation.high);
  const accumulationStart = remember(epoch(text(accumulation.start)));
  const accumulationEnd = remember(epoch(text(accumulation.end)));
  const accumulationStartClock = etClock(accumulation.start);
  const accumulationEndClock = etClock(accumulation.end);

  const manipulation = detailsForStep(2);
  const sweepExtreme = num(manipulation.extreme);
  const sweptPool = num(manipulation.pool_swept) ?? (direction === "BUY" ? accumulationLow : accumulationHigh);
  const sweepTime = remember(epoch(text(manipulation.timestamp)));
  const sweepClock = etClock(manipulation.timestamp);
  const sweepPips = num(manipulation.sweep_pips);
  const sweptSide = direction === "BUY" ? "SELLSIDE" : "BUYSIDE";

  if (accumulationLow !== null && accumulationHigh !== null && accumulationStart !== null) {
    overlays.order_blocks.push({
      kind: "liquidity_generation",
      top: accumulationHigh,
      bottom: accumulationLow,
      time: accumulationStart,
      end_time: accumulationEnd,
      direction,
      broken: false,
      mitigated: false,
      filled: false,
      label: `ACCUMULATION RANGE / ${setupTf}${accumulationStartClock && accumulationEndClock ? ` / ${accumulationStartClock}-${accumulationEndClock} ET` : ""}`,
    });
  }
  if (sweptPool !== null && accumulationStart !== null) {
    overlays.liquidity.push({
      kind: "liquidity",
      level: sweptPool,
      time: accumulationStart,
      end_time: sweepTime,
      side: direction === "BUY" ? "sellside" : "buyside",
      direction,
      label: `${sweptSide} LIQUIDITY / ACCUMULATION ${direction === "BUY" ? "LOW" : "HIGH"}`,
    });
  }
  if (sweptPool !== null && sweepExtreme !== null && sweepTime !== null) {
    overlays.structure.push({
      kind: "liquidity_grab",
      top: Math.max(sweptPool, sweepExtreme),
      bottom: Math.min(sweptPool, sweepExtreme),
      time: sweepTime,
      end_time: sweepTime,
      direction,
      broken: false,
      mitigated: false,
      filled: false,
      label: `LIQUIDITY SWEEP / ${sweptSide}${sweepClock ? ` / ${sweepClock} ET` : ""}${sweepPips === null ? "" : ` / ${sweepPips.toFixed(1)} PIP`}`,
    });
  }

  const mss = detailsForStep(3);
  const mssLevel = num(mss.level);
  const mssTime = remember(epoch(text(mss.timestamp)));
  const mssClock = etClock(mss.timestamp);
  if (mssLevel !== null && mssTime !== null) {
    overlays.structure.push({
      kind: "mss",
      top: mssLevel,
      bottom: mssLevel,
      time: mssTime,
      direction,
      broken: false,
      mitigated: false,
      filled: false,
      label: `MSS / ${setupTf} CLOSE ${direction === "BUY" ? "ABOVE" : "BELOW"} LAST OPPOSING SWING${mssClock ? ` / ${mssClock} ET` : ""}`,
    });
  }

  const retest = detailsForStep(5);
  const entryPrice = num(retest.entry) ?? num(obj(root.execution_plan).entry);
  const entryTime = remember(epoch(text(retest.timestamp) || text(obj(root.execution_plan).entry_ts)));
  const entryClock = etClock(retest.timestamp) ?? etClock(obj(root.execution_plan).entry_ts);

  const fvg = detailsForStep(4);
  const fvgTop = num(fvg.top);
  const fvgBottom = num(fvg.bottom);
  const fvgTime = remember(epoch(text(fvg.formed_at)));
  const fvgClock = etClock(fvg.formed_at);
  const gapPips = num(fvg.gap_pips);
  if (fvgTop !== null && fvgBottom !== null && fvgTime !== null) {
    overlays.fvgs.push({
      kind: "fvg",
      primary: true,
      zone_role: "source_fvg",
      polarity: direction === "BUY" ? "bullish" : "bearish",
      top: fvgTop,
      bottom: fvgBottom,
      time: fvgTime,
      direction,
      broken: false,
      mitigated: false,
      filled: false,
      label: `${direction === "BUY" ? "BULLISH" : "BEARISH"} FVG / ENTRY ARRAY${fvgClock ? ` / FORMED ${fvgClock}` : ""}${entryClock ? ` / RETEST ${entryClock}` : ""}${gapPips === null ? "" : ` / ${gapPips.toFixed(1)} PIP`} / IFVG NOT RECORDED`,
    });
  }

  if (entryPrice !== null && entryTime !== null) {
    overlays.swings.push({
      kind: "swing",
      level: entryPrice,
      time: entryTime,
      side: direction === "BUY" ? "sellside" : "buyside",
      direction,
      label: `ENTRY / FVG ${text(retest.zone_edge)?.toUpperCase() || "EDGE"} RETEST / AFTER MSS`,
    });
  }

  const dol = obj(root.draw_on_liquidity);
  const dolLevel = num(dol.level);
  const sessionDate = text(root.session_date);
  const knownAt = text(dol.knowable_at)?.match(/\b(\d{2}:\d{2})\b/)?.[1] ?? null;
  const offsetSource = text(manipulation.timestamp) || text(retest.timestamp) || text(obj(root.execution_plan).entry_ts);
  const utcOffset = offsetSource?.match(/([+-]\d{2}:\d{2})$/)?.[1] ?? "-05:00";
  const dolTime = remember(sessionDate && knownAt ? epoch(`${sessionDate}T${knownAt}:00${utcOffset}`) : accumulationStart);
  const dolName = (text(dol.name) || "draw_on_liquidity").toUpperCase().replaceAll("_", " ");
  if (dolLevel !== null && dolTime !== null) {
    overlays.liquidity.push({
      kind: "liquidity",
      level: dolLevel,
      time: dolTime,
      end_time: entryTime,
      side: direction === "BUY" ? "buyside" : "sellside",
      direction,
      label: `DRAW ON LIQUIDITY / ${dolName}${knownAt ? ` / KNOWN ${knownAt} ET` : ""}`,
    });
  }

  return {
    overlays,
    direction,
    timeframe: "1m" as StrategyTimeframe,
    overlayKey: "timeframe_1m" as TimeframeOverlayKey,
    timeframeSeconds: 60,
    earliestTime: evidenceTimes.length ? Math.min(...evidenceTimes) : null,
  };
}

/**
 * IGS03_LondonBSLSweep_CISD: CISD short in premium after a London BSL sweep.
 * Its checklist stores evidence on step.details (not step.status.details):
 *   1 BSL sweep        2 CISD            3 bearish OB + mean threshold
 *   4 dealing range    5 bearish FVG     6 iFVG (confluence, may be null)
 * Setup TF is 15m; charted on 1m like the rest of the IGS series.
 */
function extractIgs03Evidence(strategyJson: unknown, fallbackDirection: unknown) {
  const root = obj(strategyJson);
  const direction = (text(root.direction) ?? text(fallbackDirection) ?? "SELL").toUpperCase();
  const overlays = { order_blocks: [] as ObjRow[], fvgs: [] as ObjRow[], structure: [] as ObjRow[], liquidity: [] as ObjRow[], swings: [] as ObjRow[] };
  const evidenceTimes: number[] = [];
  const steps = Array.isArray(root.checklist) ? root.checklist.map(obj) : [];
  const step = (n: number) => {
    const s = steps.find((item) => num(item.step) === n);
    return obj(s?.details ?? obj(s?.status).details);
  };
  const remember = (time: number | null) => {
    if (time !== null) evidenceTimes.push(time);
    return time;
  };
  const clock = (value: unknown) => text(value)?.match(/[ T](\d{2}:\d{2})/)?.[1] ?? null;
  const pip = num(obj(root.params).pip) ?? 0.0001;
  const pips = (a: number, b: number) => `${(Math.abs(a - b) / pip).toFixed(1)} PIP`;
  const tf = (text(root.timeframe) || "15min").replace("min", "M").toUpperCase();
  const outcome = obj(root.outcome);
  const fillTime = epoch(text(outcome.filled_at));
  const closeTime = epoch(text(outcome.close_ts)) ?? fillTime;

  // 1. BSL swing high and the London-killzone sweep through it
  const sweep = step(1);
  const bsl = num(sweep.bsl_level);
  const sweepHigh = num(sweep.sweep_high);
  const bslTime = remember(epoch(text(sweep.bsl_formed)));
  const sweepTime = remember(epoch(text(sweep.sweep_candle)));
  if (bsl !== null && bslTime !== null) {
    overlays.liquidity.push({
      kind: "liquidity", level: bsl, time: bslTime, end_time: sweepTime,
      side: "buyside", direction,
      label: `BSL / ${tf} SWING HIGH${clock(sweep.bsl_formed) ? ` ${clock(sweep.bsl_formed)}` : ""}`,
    });
  }
  if (bsl !== null && sweepHigh !== null && sweepTime !== null) {
    overlays.structure.push({
      kind: "liquidity_grab", top: Math.max(bsl, sweepHigh), bottom: Math.min(bsl, sweepHigh),
      time: sweepTime, end_time: sweepTime, direction, broken: false, mitigated: false, filled: false,
      label: `BSL SWEEP / LONDON KZ${clock(sweep.sweep_candle) ? ` / ${clock(sweep.sweep_candle)} ET` : ""} / ${pips(sweepHigh, bsl)}`,
    });
  }

  // 3. Bearish OB (last up-close candle of the run) and its mean threshold
  const ob = step(3);
  const obTop = num(ob.top);
  const obBottom = num(ob.bottom);
  const obMt = num(ob.mt);
  const obTime = remember(epoch(text(ob.ob_candle)));
  if (obTop !== null && obBottom !== null && obTime !== null) {
    overlays.order_blocks.push({
      kind: "order_block", top: obTop, bottom: obBottom, time: obTime, end_time: fillTime,
      direction, broken: false, mitigated: false, filled: false,
      label: `BEARISH OB / ${tf}${clock(ob.ob_candle) ? ` ${clock(ob.ob_candle)}` : ""}`,
    });
  }
  if (obMt !== null && obTime !== null) {
    overlays.swings.push({
      kind: "swing", level: obMt, time: obTime, end_time: closeTime, side: "buyside", direction,
      label: "OB MEAN THRESHOLD / STOP ABOVE",
    });
  }

  // 2. CISD: close below the open of the up-close run that printed the high
  const cisd = step(2);
  const cisdLevel = num(cisd.cisd_level);
  const runStart = remember(epoch(text(cisd.run_start)));
  const cisdTime = remember(epoch(text(cisd.cisd_close_candle)));
  if (cisdLevel !== null && (runStart ?? cisdTime) !== null) {
    overlays.structure.push({
      kind: "mss", top: cisdLevel, bottom: cisdLevel, time: runStart ?? cisdTime, end_time: cisdTime,
      direction, broken: false, mitigated: false, filled: false,
      label: `CISD / ${tf} CLOSE BELOW UP-RUN OPEN${clock(cisd.cisd_close_candle) ? ` / ${clock(cisd.cisd_close_candle)} ET` : ""}`,
    });
  }

  // 5. Bearish FVG left by the displacement leg
  const fvg = step(5);
  const fvgTop = num(fvg.top);
  const fvgBottom = num(fvg.bottom);
  const fvgTime = remember(epoch(text(fvg.formed_datetime)));
  if (fvgTop !== null && fvgBottom !== null && fvgTime !== null) {
    overlays.fvgs.push({
      kind: "fvg", primary: true, zone_role: "source_fvg", polarity: "bearish",
      top: fvgTop, bottom: fvgBottom, time: fvgTime, end_time: fillTime, direction,
      broken: false, mitigated: false, filled: false,
      label: `BEARISH FVG / DISPLACEMENT${clock(fvg.formed_datetime) ? ` / ${clock(fvg.formed_datetime)}` : ""} / ${pips(fvgTop, fvgBottom)}`,
    });
  }

  // 6. iFVG: bullish gap from the rally, closed through (confluence only)
  const ifvg = step(6);
  const ifvgTop = num(ifvg.top);
  const ifvgBottom = num(ifvg.bottom);
  const ifvgTime = epoch(text(ifvg.formed_datetime));
  if (ifvgTop !== null && ifvgBottom !== null && ifvgTime !== null) {
    overlays.fvgs.push({
      kind: "fvg", primary: false, zone_role: "ifvg", polarity: "bearish",
      top: ifvgTop, bottom: ifvgBottom, time: ifvgTime, end_time: epoch(text(ifvg.inverted_datetime)),
      direction, broken: false, mitigated: false, filled: false,
      label: `iFVG / BULLISH GAP${clock(ifvg.formed_datetime) ? ` ${clock(ifvg.formed_datetime)}` : ""} INVERTED${clock(ifvg.inverted_datetime) ? ` ${clock(ifvg.inverted_datetime)}` : ""}`,
    });
  }

  // 4. Dealing range: SSL (target) and equilibrium (entry must be above = premium)
  const range = step(4);
  const ssl = num(range.ssl);
  const eq = num(range.equilibrium);
  const sslTime = epoch(text(range.ssl_formed));
  // SSL can form many hours before the sweep; anchor it no earlier than 2h
  // before the BSL so the 1m window stays readable.
  const rangeAnchor = sslTime !== null && bslTime !== null ? Math.max(sslTime, bslTime - 7200) : sslTime;
  remember(rangeAnchor);
  if (ssl !== null && rangeAnchor !== null) {
    overlays.liquidity.push({
      kind: "liquidity", level: ssl, time: rangeAnchor, end_time: closeTime, side: "sellside", direction,
      label: `SELL SIDE LIQUIDITY / TARGET${clock(range.ssl_formed) ? ` / LOW ${clock(range.ssl_formed)}` : ""}`,
    });
  }
  if (eq !== null && rangeAnchor !== null) {
    overlays.swings.push({
      kind: "swing", level: eq, time: rangeAnchor, end_time: fillTime, side: null, direction,
      label: "EQUILIBRIUM 50% / PREMIUM ABOVE",
    });
  }

  // Entry: sell limit back at the CISD level, in premium
  const entry = num(root.entry_price);
  if (entry !== null && fillTime !== null) {
    overlays.swings.push({
      kind: "swing", level: entry, time: fillTime, side: "buyside", direction,
      label: `ENTRY / SELL LIMIT AT ${text(root.entry_level_type) === "fvg_ce" ? "FVG CE" : "CISD"}${clock(outcome.filled_at) ? ` / ${clock(outcome.filled_at)} ET` : ""}`,
    });
  }

  return {
    overlays,
    direction,
    timeframe: "1m" as StrategyTimeframe,
    overlayKey: "timeframe_1m" as TimeframeOverlayKey,
    timeframeSeconds: 60,
    earliestTime: evidenceTimes.length ? Math.min(...evidenceTimes) : null,
  };
}

/**
 * Map an IGS-series strategy_json (forex 1m) onto the shared overlay contract.
 *
 * IGS01 records its evidence as a 4-step checklist rather than the wide
 * per-timeframe columns the original pipeline persists, so every label the
 * chart shows is read out of `strategy_json` here:
 *
 *   step 1 liquidity_pool  -> liquidity level + one swing marker per equal high
 *   step 2 liquidity_grab  -> liquidity level at the grab extreme (= the stop)
 *   step 3 inversion_fvg   -> fvg zone, plus an MSS structure marker on the
 *                             bar that CLOSED THROUGH it (the inversion IS the
 *                             structure shift for this strategy)
 *   step 4 ifvg_reentry    -> swing marker at the limit fill
 *   sl_target_patch        -> structural stop level
 *   target_plan[]          -> one liquidity level per target, labelled with the
 *                             PD array that produced it and its RR
 */
function extractIgs01Evidence(strategyJson: unknown, fallbackDirection: unknown) {
  const root = obj(strategyJson);
  const direction = text(root.direction) ?? text(fallbackDirection);
  const overlays = { order_blocks: [] as ObjRow[], fvgs: [] as ObjRow[], structure: [] as ObjRow[], liquidity: [] as ObjRow[], swings: [] as ObjRow[] };
  const evidenceTimes: number[] = [];
  const side = direction === "SELL" ? "buyside" : "sellside";

  const steps = Array.isArray(root.checklist) ? root.checklist.map(obj) : [];
  const detailsFor = (eventType: string): ObjRow => {
    for (const step of steps) {
      const details = obj(obj(step.status).details);
      if (text(details.event_type) === eventType) return details;
    }
    return {};
  };
  const span = (d: ObjRow) => ({
    from: epoch(text(d.start_datetime)),
    to: epoch(text(d.end_datetime)),
  });
  const note = (t: number | null) => { if (t !== null) evidenceTimes.push(t); };

  // 1. Liquidity generation. A bounded box over the window that built the pool,
  //    plus the pool level itself carried forward to where it was taken.
  const pool = detailsFor("liquidity_pool");
  const poolLevel = num(pool.level);
  const poolSpan = span(pool);
  const rangeHigh = num(pool.range_high);
  const rangeLow = num(pool.range_low);
  const touches = Array.isArray(pool.touches) ? pool.touches.length : 0;
  if (rangeHigh !== null && rangeLow !== null && poolSpan.from !== null) {
    note(poolSpan.from);
    overlays.order_blocks.push({
      kind: "liquidity_generation", top: rangeHigh, bottom: rangeLow,
      time: poolSpan.from, end_time: poolSpan.to, direction,
      broken: false, mitigated: false, filled: false,
      label: `LIQUIDITY GENERATION · ${touches} EQUAL ${direction === "SELL" ? "HIGHS" : "LOWS"}`,
    });
  }

  // 2. Accumulation range: the low/high the market coiled between beforehand.
  const acc = detailsFor("accumulation_range");
  const accSpan = span(acc);
  const accEdge = direction === "SELL" ? num(acc.low) : num(acc.high);
  if (accEdge !== null && accSpan.from !== null) {
    note(accSpan.from);
    overlays.liquidity.push({
      kind: "liquidity", level: accEdge, time: accSpan.from, end_time: accSpan.to,
      side: direction === "SELL" ? "sellside" : "buyside", direction,
      label: `ACCUMULATION ${direction === "SELL" ? "LOW" : "HIGH"}`,
    });
  }

  // 3. The grab is a WINDOW, not a point: first bar through the pool to the bar
  //    that closed back inside it, with the extreme marked where it printed.
  const grab = detailsFor("liquidity_grab");
  const grabSpan = span(grab);
  const grabExtreme = num(grab.extreme);
  const grabExtremeAt = epoch(text(grab.extreme_datetime));
  if (grabExtreme !== null && grabSpan.from !== null) {
    note(grabSpan.from);
    overlays.structure.push({
      kind: "liquidity_grab", top: grabExtreme, bottom: poolLevel ?? grabExtreme,
      time: grabSpan.from, end_time: grabSpan.to, direction,
      broken: false, mitigated: false, filled: false,
      label: `LIQUIDITY GRAB · ${side.toUpperCase()} SWEPT`,
    });
  }
  if (poolLevel !== null && poolSpan.from !== null) {
    overlays.liquidity.push({
      kind: "liquidity", level: poolLevel, time: poolSpan.from,
      end_time: grabExtremeAt ?? grabSpan.to, side, direction,
      label: `${side.toUpperCase()} LIQUIDITY`,
    });
  }

  // 4. The gap has TWO lives, drawn as two adjoining boxes:
  //      a) the ORIGINAL gap, in its own polarity colour, from the bar that
  //         formed it up to the bar that closed through it;
  //      b) the INVERTED gap from that moment until price traded back into it.
  //    Drawing only (b) hides where the imbalance came from, which is the half
  //    that explains why the level matters.
  const ifvg = detailsFor("inversion_fvg");
  const top = num(ifvg.top);
  const bottom = num(ifvg.bottom);
  const ifvgSpan = span(ifvg);
  const formed = epoch(text(ifvg.formed_datetime)) ?? ifvgSpan.from;
  const inverted = epoch(text(ifvg.inverted_datetime));
  const wasBullish = text(ifvg.original_polarity) === "bullish";
  // Time-of-day taken straight off the persisted ISO string so the label always
  // agrees with strategy_json instead of re-deriving a zone in the browser.
  const hhmm = (iso: string | null) => (iso ? (iso.match(/T(\d{2}:\d{2})/)?.[1] ?? null) : null);
  const formedAt = hhmm(text(ifvg.formed_datetime));
  const invertedAt = hhmm(text(ifvg.inverted_datetime));
  // IGS is the forex series, so quote the gap height in pips. Guarded on price
  // magnitude so a non-FX symbol never gets a nonsense pip count.
  const gapPips = top !== null && bottom !== null && top < 10
    ? `${((top - bottom) / 0.0001).toFixed(1)} PIP`
    : null;

  if (top !== null && bottom !== null && formed !== null) {
    note(formed);
    overlays.fvgs.push({
      kind: "fvg", primary: true, zone_role: "source_fvg",
      polarity: wasBullish ? "bullish" : "bearish",
      top, bottom, time: formed, end_time: inverted ?? ifvgSpan.to, direction,
      broken: false, mitigated: false, filled: false,
      // There is exactly ONE gap in this setup. This box and the IFVG box below
      // are the same price range in two states; both labels say so, because the
      // old wording read as if two separate gaps existed.
      label: `THE GAP · ${wasBullish ? "BULLISH" : "BEARISH"} FVG${formedAt ? ` FORMED ${formedAt}` : ""}${gapPips ? ` · ${gapPips}` : ""}`,
    });
  }
  if (top !== null && bottom !== null && inverted !== null) {
    note(inverted);
    overlays.fvgs.push({
      // `primary` keeps the chart's generic IFVG-suppression filter from
      // deleting the entry array itself.
      kind: "fvg", primary: true, zone_role: "ifvg",
      polarity: wasBullish ? "bearish" : "bullish",   // polarity AFTER inversion
      top, bottom, time: inverted, end_time: ifvgSpan.to, direction,
      broken: false, mitigated: false, filled: false,
      label: `SAME GAP INVERTED${invertedAt ? ` ${invertedAt}` : ""} · NOW ${direction === "BUY" ? "BULLISH SUPPORT" : "BEARISH RESISTANCE"}`,
    });
    overlays.structure.push({
      kind: "mss", top: direction === "SELL" ? bottom : top, bottom: direction === "SELL" ? bottom : top,
      time: inverted, direction,
      broken: false, mitigated: false, filled: false,
      label: `MSS · CLOSE THROUGH THE GAP${invertedAt ? ` ${invertedAt}` : ""}`,
    });
  }

  // 5. The fill. V1 fills a limit at the inverted zone edge ("ifvg_reentry");
  //    V2 has no IFVG at all and enters at the close of the bar that confirmed
  //    the sweep rejected ("sweep_rejection_entry"). Same marker, both shapes.
  const entry = detailsFor("ifvg_reentry");
  const sweepEntry = detailsFor("sweep_rejection_entry");
  const fill = Object.keys(entry).length ? entry : sweepEntry;
  const entryPrice = num(fill.price);
  const entryTime = epoch(text(fill.entry_datetime));
  if (entryPrice !== null && entryTime !== null) {
    note(entryTime);
    const rejPips = num(fill.rejection_pips);
    overlays.swings.push({
      kind: "swing", level: entryPrice, time: entryTime, side, direction,
      label: Object.keys(entry).length
        ? "ENTRY · IFVG RE-ENTRY"
        : `ENTRY · SWEEP REJECTION CLOSE${rejPips === null ? "" : ` · ${rejPips} PIP`}`,
    });
  }

  // Targets, each labelled with the PD array that produced it.
  const plan = Array.isArray(root.target_plan) ? root.target_plan.map(obj) : [];
  for (const t of plan) {
    const price = num(t.price);
    if (price === null) continue;
    const at = epoch(text(t.formed)) ?? entryTime;
    if (at === null) continue;
    const rr = num(t.actual_rr);
    const evt = (text(t.event_type) || "target").toUpperCase().replace(/_/g, " ");
    const tfLabel = text(t.timeframe);
    overlays.liquidity.push({
      kind: "liquidity", level: price, time: at, end_time: entryTime, side, direction,
      label: `TP${num(t.target_no) ?? "?"} · ${evt}${tfLabel ? ` ${tfLabel.toUpperCase()}` : ""}${rr === null ? "" : ` · ${rr.toFixed(2)}R`}`,
    });
  }

  return {
    overlays,
    direction,
    timeframe: "1m" as StrategyTimeframe,
    overlayKey: "timeframe_1m" as TimeframeOverlayKey,
    timeframeSeconds: 60,
    earliestTime: evidenceTimes.length ? Math.min(...evidenceTimes) : null,
  };
}

/** Map the frozen TS01 strategy_json into the shared multi-timeframe chart contract. */
function extractTs01Evidence(strategyJson: unknown, fallbackDirection: unknown) {
  const root = obj(strategyJson);
  const candidates = Array.isArray(root.candidates) ? root.candidates.map(obj) : [];
  const selectedKey = text(root.selected_attempt);
  const candidate = candidates.find((item) => text(item.candidate_key) === selectedKey) || candidates[0] || {};
  const direction = text(candidate.direction) || text(root.direction) || text(fallbackDirection);
  const overlays = {
    timeframe_5m: { order_blocks: [] as ObjRow[], fvgs: [] as ObjRow[], structure: [] as ObjRow[], liquidity: [] as ObjRow[], swings: [] as ObjRow[] },
    timeframe_15m: { order_blocks: [] as ObjRow[], fvgs: [] as ObjRow[], structure: [] as ObjRow[], liquidity: [] as ObjRow[], swings: [] as ObjRow[] },
    timeframe_daily: { order_blocks: [] as ObjRow[], fvgs: [] as ObjRow[], structure: [] as ObjRow[], liquidity: [] as ObjRow[], swings: [] as ObjRow[] },
    timeframe_weekly: { order_blocks: [] as ObjRow[], fvgs: [] as ObjRow[], structure: [] as ObjRow[], liquidity: [] as ObjRow[], swings: [] as ObjRow[] },
  };

  const fvg = obj(candidate.fvg);
  const fvgTime = epoch(text(fvg.created_bar_ts));
  const fvgLow = num(fvg.low);
  const fvgHigh = num(fvg.high);
  if (fvgTime !== null && fvgLow !== null && fvgHigh !== null) {
    overlays.timeframe_5m.fvgs.push({ kind: "fvg", top: fvgHigh, bottom: fvgLow, time: fvgTime, direction, broken: false, mitigated: false, filled: false, label: (text(root.strategy_id) || "").startsWith("IG_Goldhunter_ICT2022") ? "Goldhunter 5M FVG · BOUNDARY ENTRY" : "TS01 5M FVG · CE ENTRY" });
  }

  const gates = Array.isArray(candidate.gates) ? candidate.gates.map(obj) : [];
  const mssGate = gates.find((gate) => text(gate.name) === "MSS_CLOSE");
  const mssPrice = num(obj(mssGate?.evidence).close) ?? num(obj(mssGate?.evidence).swing_price) ?? num(obj(candidate.structure_break).level);
  const mssTime = epoch(text(candidate.mss_bar_ts) || text(obj(candidate.structure_break).broken_bar_ts));
  if (mssTime !== null && mssPrice !== null) {
    overlays.timeframe_5m.structure.push({ kind: "mss", top: mssPrice, bottom: mssPrice, time: mssTime, direction, broken: false, mitigated: false, filled: false, label: "TS01 MSS · CLOSE CONFIRMED" });
  }

  const raid = obj(candidate.raid_pool);
  const raidPrice = num(raid.price);
  const raidTime = epoch(text(candidate.raid_bar_ts) || text(raid.first_tap_ts) || text(raid.formed_at));
  const raidLevel = raidTime !== null && raidPrice !== null
    ? { kind: "liquidity", level: raidPrice, time: raidTime, side: text(raid.side), direction, label: `RAID · ${text(raid.pool_type) || "LIQUIDITY"}` }
    : null;
  const raidTf = (text(raid.timeframe) || "5m").toLowerCase();
  if (raidLevel) {
    if (raidTf.includes("15")) overlays.timeframe_15m.liquidity.push(raidLevel);
    else if (raidTf.includes("1d") || raidTf.includes("daily")) overlays.timeframe_daily.liquidity.push(raidLevel);
    else if (raidTf.includes("1w") || raidTf.includes("week")) overlays.timeframe_weekly.liquidity.push(raidLevel);
    else overlays.timeframe_5m.liquidity.push(raidLevel);
  }

  const confirmation = obj(candidate.confirmation_swing);
  const swingPrice = num(confirmation.price);
  const swingTime = epoch(text(confirmation.pivot_ts) || text(confirmation.known_at));
  if (swingTime !== null && swingPrice !== null) {
    overlays.timeframe_5m.swings.push({ kind: "swing", level: swingPrice, time: swingTime, side: text(confirmation.side), direction, label: "PRE-RAID CONFIRMED SWING" });
  }

  const htf = obj(candidate.htf_context || root.htf_context);
  const directionEvent = obj(htf.direction_event);
  const dailyFvg = obj(directionEvent.fvg);
  const dailyTime = epoch(text(directionEvent.event_bar_ts) || text(dailyFvg.created_bar_ts));
  const dailyLow = num(dailyFvg.low);
  const dailyHigh = num(dailyFvg.high);
  if (dailyTime !== null && dailyLow !== null && dailyHigh !== null) {
    overlays.timeframe_daily.fvgs.push({ kind: "fvg", top: dailyHigh, bottom: dailyLow, time: dailyTime, direction, broken: false, mitigated: false, filled: false, label: "D1 DIRECTION FVG" });
  }
  const brokenPrice = num(directionEvent.broken_swing_price) ?? num(obj(directionEvent.structure).level);
  if (dailyTime !== null && brokenPrice !== null) {
    overlays.timeframe_daily.structure.push({ kind: "structure", top: brokenPrice, bottom: brokenPrice, time: dailyTime, direction, broken: true, mitigated: false, filled: false, label: "D1 CONFIRMED SWING BREAK" });
  }
  const dealingRange = obj(htf.dealing_range);
  for (const [label, level] of [["D1 RANGE HIGH", num(dealingRange.high)], ["D1 RANGE LOW", num(dealingRange.low)]] as const) {
    if (dailyTime !== null && level !== null) overlays.timeframe_daily.swings.push({ kind: "swing", level, time: dailyTime, side: label.endsWith("HIGH") ? "BSL" : "SSL", direction, label });
  }

  const objective = obj(htf.objective);
  const objectivePrice = num(objective.price);
  const objectiveTime = epoch(text(objective.formed_at) || text(objective.known_at));
  if (objectiveTime !== null && objectivePrice !== null) {
    const level = { kind: "liquidity", level: objectivePrice, time: objectiveTime, side: text(objective.side), direction, label: `HTF DRAW · ${text(objective.pool_type) || "LIQUIDITY"}` };
    const tf = (text(objective.timeframe) || "1d").toLowerCase();
    if (tf.includes("1w") || tf.includes("week")) overlays.timeframe_weekly.liquidity.push(level);
    else overlays.timeframe_daily.liquidity.push(level);
  }
  return { direction, overlays };
}

function mapZone(o: ObjRow, kindFallback: string) {
  const top = num(o.top);
  const bottom = num(o.bottom);
  const t = epoch((o.formed_datetime_et as string) || (o.start_datetime_et as string) || (o.bar_timestamp_et as string) || (o.event_datetime_et as string) || null);
  if (top === null || bottom === null || t === null) return null;
  return {
    kind: (o.zone_type as string) || (o.event_type as string) || kindFallback,
    top,
    bottom,
    time: t,
    direction: (o.direction as string) || null,
    broken: Boolean(o.broken),
    mitigated: Boolean(o.mitigated),
    filled: Boolean(o.fully_filled),
    label: (o.summary as string) || "",
  };
}

function mapLevel(o: ObjRow, kind: string) {
  const level = num(o.level);
  const t = epoch((o.bar_timestamp_et as string) || (o.formed_datetime_et as string) || (o.event_datetime_et as string) || null);
  if (level === null) return null;
  return {
    kind,
    level,
    time: t,
    side: (o.side as string) || null,
    direction: (o.direction as string) || null,
    label: (o.ict_label as string) || (o.liquidity_label as string) || (o.event_type as string) || kind,
  };
}


// Barchart history (historical_candles_5m / _1h) ends before today for US symbols (2026-06-03).
// For anything later, fall back to the live yfinance tables, but ONLY after the last historical
// bar of that symbol, so the two sources never overlap and older charts are byte-identical.
const LIVE_FALLBACK: Record<string, string> = {
  historical_candles_5m: "candles_5m",
  historical_candles_1h: "candles_1h",
};
function candleSource(table: string): string {
  const live = LIVE_FALLBACK[table];
  if (!live) return table;
  const cols = "yahoo_symbol, base_symbol, candle_ts, open_price, high_price, low_price, close_price, volume";
  return `(SELECT ${cols} FROM ${table}
           UNION ALL
           SELECT ${cols} FROM ${live} c
           WHERE c.candle_ts > COALESCE((SELECT MAX(h.candle_ts) FROM ${table} h WHERE h.yahoo_symbol = c.yahoo_symbol),
                                        '-infinity'::timestamptz)) candle_src`;
}

function stepTable(step: number) {
  // Must mirror pickTable(). Without the 1m case a 60s step fell through to the
  // 5m table, whose forex rows stop at 2026-06-26 — so panning left on any IGS
  // chart returned nothing and reported "No earlier candles available".
  if (step <= 60) return { table: "historical_candles_1m", stepSec: 60 };
  if (step <= 600) return { table: "historical_candles_5m", stepSec: 300 };
  if (step <= 7200) return { table: "historical_candles_1h", stepSec: 3600 };
  return { table: "candles_1d", stepSec: 86400 };
}

function timeframeLabel(stepSec: number) {
  return stepSec === 60 ? "1m" : stepSec === 300 ? "5m" : stepSec === 3600 ? "1h" : "1d";
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const orderId = (sp.get("order_id") || "").trim();
  const target_no = [1, 2, 3].includes(Number(sp.get("target_no"))) ? Number(sp.get("target_no")) : 1;
  // Optional explicit candle window (used by the chart to lazy-load older bars
  // when the user pans/drag-scrolls to the left). When present we return only
  // candles for that range and skip the heavy ICT overlay assembly.
  const fromTsParam = Number(sp.get("from_ts"));
  const toTsParam = Number(sp.get("to_ts"));
  const stepParam = Number(sp.get("step")) || 300;
  const candlesOnly = Number.isFinite(fromTsParam) && Number.isFinite(toTsParam) && fromTsParam > 0 && toTsParam > fromTsParam;
  if (!orderId) {
    return NextResponse.json({ success: false, error: "order_id required" }, { status: 400 });
  }

  const restApiUrl = process.env.CANDLES_REST_API_URL;
  if (restApiUrl) {
    const upstreamUrl = new URL("/api/backtest/order-chart", restApiUrl);
    for (const [key, value] of sp.entries()) {
      upstreamUrl.searchParams.set(key, value);
    }
    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        headers: process.env.CANDLES_REST_API_TOKEN
          ? { "x-api-key": process.env.CANDLES_REST_API_TOKEN }
          : undefined,
        cache: "no-store",
      });
      const payload = await upstreamResponse.json();
      return NextResponse.json(payload, { status: upstreamResponse.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown REST API error";
      return NextResponse.json({ success: false, error: `REST API unavailable: ${message}` }, { status: 502 });
    }
  }

  try {
    const pool = getPostgresPool();
    const orderRes = await pool.query(
      `SELECT o.pipeline, o.order_id, o.signal_id, o.symbol, o.market, o.direction,
              o.entry_price, o.filled_price, o.stoploss, o.tp1, o.tp2, o.tp3,
              o.filled_at, t.target_no, t.target_price, t.target_rr, t.state,
              t.close_ts, t.close_price, t.close_reason, t.realized_r
       FROM ${BACKTEST_ORDERS} o
       JOIN ${BACKTEST_TARGETS} t ON t.order_id=o.order_id AND t.pipeline=o.pipeline
       WHERE o.order_id = $1 AND t.target_no = $2
       LIMIT 1`,
      [orderId, target_no],
    );
    if (orderRes.rowCount === 0) {
      return NextResponse.json({ success: false, error: "order not found" }, { status: 404 });
    }
    const o = orderRes.rows[0];
    const symbol = o.symbol as string;

    // ----- Older-candle window fetch (lazy pan-left) --------------------------
    if (candlesOnly) {
      const { table: tbl, stepSec: st } = stepTable(stepParam);
      const fromIso = new Date(fromTsParam * 1000).toISOString();
      const toIso = new Date(toTsParam * 1000).toISOString();
      const shape = (rows: Record<string, unknown>[]) => rows
        .map((r) => ({ time: epoch(r.candle_ts as string), open: num(r.open_price), high: num(r.high_price), low: num(r.low_price), close: num(r.close_price), volume: num(r.volume) }))
        .filter((c) => c.time !== null && c.open !== null);

      const res = await pool.query(
        `SELECT candle_ts, open_price, high_price, low_price, close_price, volume
         FROM ${candleSource(tbl)}
         WHERE (yahoo_symbol = $1 OR base_symbol = $1)
           AND candle_ts >= $2::timestamptz AND candle_ts <= $3::timestamptz
         ORDER BY candle_ts ASC LIMIT 3000`,
        [symbol, fromIso, toIso],
      );
      let candles = shape(res.rows);

      // A bounded window that lands entirely in a market gap (an FX weekend, a
      // holiday, a data hole) is not the same as "history exhausted". Fall back
      // to the newest bars at or before `to_ts` so panning left keeps working
      // across the gap instead of dead-ending at it.
      if (candles.length === 0) {
        const back = await pool.query(
          `SELECT candle_ts, open_price, high_price, low_price, close_price, volume
           FROM ${candleSource(tbl)}
           WHERE (yahoo_symbol = $1 OR base_symbol = $1)
             AND candle_ts <= $2::timestamptz
           ORDER BY candle_ts DESC LIMIT 1500`,
          [symbol, toIso],
        );
        candles = shape(back.rows).sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
      }

      return NextResponse.json({ success: true, candles, window: { from: fromTsParam, to: toTsParam }, timeframe: timeframeLabel(st) });
    }

    let signal: ObjRow | null = null;
    if (o.signal_id) {
      const sigRes = await pool.query(
        `SELECT *
         FROM ${BACKTEST_SIGNALS}
         WHERE signal_hash = $1 AND pipeline = $2 LIMIT 1`,
        [o.signal_id, o.pipeline],
      );
      signal = sigRes.rowCount && sigRes.rowCount > 0 ? sigRes.rows[0] as ObjRow : null;
    }
    // Both S10 generations describe a BPR, but they persist it differently, so
    // each has its own reader feeding the same overlay contract downstream.
    const strategyCode = (text(signal?.strategy_id) ?? text(obj(signal?.strategy_json).strategy_id) ?? "").toUpperCase();
    // IGS is the forex 1m series; its evidence lives in a checklist rather than
    // the wide per-timeframe overlay columns, and it must be charted on 1m.
    const isIgs03 = strategyCode === "IGS03_LONDONBSLSWEEP_CISD";
    const igsEvidence = strategyCode === "IGS02_MANIPULATION_MSS_IFVG"
      ? extractIgs02Evidence(signal?.strategy_json, o.direction)
      : isIgs03
        ? extractIgs03Evidence(signal?.strategy_json, o.direction)
        : strategyCode.startsWith("IGS")
        ? extractIgs01Evidence(signal?.strategy_json, o.direction)
        : null;
    const s10Code = strategyCode;
    const s10Evidence = s10Code === "S10-V2"
      ? extractS10V2Evidence(signal?.strategy_json, signal?.direction)
      : s10Code === "S10-V3"
        ? extractS10V3Evidence(signal?.strategy_json, signal?.direction)
        : s10Code === "S16-V2"
          ? extractS16V2Evidence(signal?.strategy_json, signal?.direction)
          : ["S01-V2","S01-V3"].includes(s10Code)
            ? extractS01V2Evidence(signal?.strategy_json, signal?.direction, s10Code)
            : null;

    const filledSec = epoch(o.filled_at) ?? 0;
    const closeSec = epoch(o.close_ts) ?? filledSec;
    const rawSpan = Math.max(closeSec - filledSec, 3600);
    const { table, stepSec } = pickTable(rawSpan, Boolean(igsEvidence));
    // TS01 needs enough causal history to render its Daily/Weekly context in
    // addition to the 5m execution. Other strategies retain the compact path.
    const isTs01 = o.pipeline === "ts01" || o.pipeline === "ts01v2" || strategyCode.startsWith("IG_GOLDHUNTER_ICT2022");
    const pad = isTs01
      ? Math.max(rawSpan * 0.4, 45 * 86400)
      : Math.max(rawSpan * 0.4, 30 * stepSec);
    // S10-V2 permits opposing FVG legs up to three days apart. Include the
    // earliest persisted leg plus one identification candle so neither leg is
    // silently clipped out of the chart window.
    const structuralEvidence = s10Evidence ?? igsEvidence;
    const evidenceFromSec = structuralEvidence?.earliestTime === null || structuralEvidence?.earliestTime === undefined
      ? filledSec - pad
      : structuralEvidence.earliestTime - structuralEvidence.timeframeSeconds;
    const fromSec = Math.min(filledSec - pad, evidenceFromSec);
    const toSec = closeSec + pad;
    const fromIso = new Date(fromSec * 1000).toISOString();
    const toIso = new Date(toSec * 1000).toISOString();

    const candleRes = await pool.query(
      `SELECT candle_ts, open_price, high_price, low_price, close_price, volume
       FROM ${candleSource(table)}
       WHERE (yahoo_symbol = $1 OR base_symbol = $1)
         AND candle_ts >= $2::timestamptz AND candle_ts <= $3::timestamptz
       ORDER BY candle_ts ASC
       LIMIT ${isTs01 ? 8000 : isIgs03 ? 4000 : 1500}`,
      [symbol, fromIso, toIso],
    );

    const candles = candleRes.rows
      .map((r) => ({
        time: epoch(r.candle_ts as string),
        open: num(r.open_price),
        high: num(r.high_price),
        low: num(r.low_price),
        close: num(r.close_price),
        volume: num(r.volume),
      }))
      .filter((c) => c.time !== null && c.open !== null);

    // Signal ICT overlays (all timeframes) — best-effort join
    const overlays: {
      order_blocks: unknown[];
      fvgs: unknown[];
      liquidity: unknown[];
      swings: unknown[];
      structure: unknown[];
      ipda: unknown | null;
      bias: unknown | null;
      strategy_timeframe: StrategyTimeframe | null;
      timeframe_1m: Record<string, unknown[]>;
      timeframe_5m: Record<string, unknown[]>;
      timeframe_15m: Record<string, unknown[]>;
      timeframe_30m: Record<string, unknown[]>;
      timeframe_1h: Record<string, unknown[]>;
      timeframe_daily: Record<string, unknown[]>;
      timeframe_weekly: Record<string, unknown[]>;
    } = { order_blocks: [], fvgs: [], liquidity: [], swings: [], structure: [], ipda: null, bias: null, strategy_timeframe: null, timeframe_1m: {}, timeframe_5m: {}, timeframe_15m: {}, timeframe_30m: {}, timeframe_1h: {}, timeframe_daily: {}, timeframe_weekly: {} };

    if (signal) {
        const s = signal;
        const inWindow = (t: number | null) => t === null || (t >= fromSec - stepSec && t <= toSec + stepSec);

        // Helper to extract zone-type overlays from a column
        function extractZones(col: unknown, kind: string) {
          const items = ((col as Record<string, unknown>)?.recent_10_order_blocks
            || (col as Record<string, unknown>)?.recent_10_fvgs
            || (col as Record<string, unknown>)?.recent_10_bos_mss_choch
            || []) as ObjRow[];
          return items.map((x) => mapZone(x, kind)).filter((z) => z && inWindow(z.time));
        }
        function extractLevels(col: unknown, kind: string) {
          const items = [
            ...(((col as Record<string, unknown>)?.recent_10_buyside_liquidity_levels || []) as ObjRow[]),
            ...(((col as Record<string, unknown>)?.recent_10_sellside_liquidity_levels || []) as ObjRow[]),
            ...(((col as Record<string, unknown>)?.recent_10_swing_highs || []) as ObjRow[]),
            ...(((col as Record<string, unknown>)?.recent_10_swing_lows || []) as ObjRow[]),
          ];
          return items.map((x) => mapLevel(x, kind)).filter((z) => z && inWindow(z.time));
        }

        // 5m overlays
        overlays.timeframe_5m["order_blocks"] = extractZones(s.ob_5m, "order_block");
        overlays.timeframe_5m["fvgs"] = extractZones(s.fvg_5m, "fvg");
        overlays.timeframe_5m["liquidity"] = extractLevels(s.liq_5m, "liquidity");
        overlays.timeframe_5m["swings"] = extractLevels(s.sw_5m, "swing");
        overlays.timeframe_5m["structure"] = extractZones(s.bos_5m, "structure");

        const ipdaEvidence = extractIpdaEvidence(s.strategy_json, s.direction);
        overlays.ipda = ipdaEvidence.ipda;
        if (ipdaEvidence.fvgOverlay) overlays.timeframe_5m["fvgs"].push(ipdaEvidence.fvgOverlay);
        if (ipdaEvidence.mssOverlay) overlays.timeframe_5m["structure"].push(ipdaEvidence.mssOverlay);
        if (ipdaEvidence.swingOverlay) overlays.timeframe_5m["swings"].push(ipdaEvidence.swingOverlay);
        if (ipdaEvidence.sweepOverlay) overlays.timeframe_5m["liquidity"].push(ipdaEvidence.sweepOverlay);

        // 30m overlays (best-effort, may be null)
        overlays.timeframe_30m["order_blocks"] = extractZones(s.ob_30m, "order_block");
        overlays.timeframe_30m["fvgs"] = extractZones(s.fvg_30m, "fvg");
        overlays.timeframe_30m["liquidity"] = extractLevels(s.liq_30m, "liquidity");
        overlays.timeframe_30m["swings"] = extractLevels(s.sw_30m, "swing");
        overlays.timeframe_30m["structure"] = extractZones(s.bos_30m, "structure");

        // 15m overlays
        overlays.timeframe_15m["order_blocks"] = extractZones(s.ob_15m, "order_block");
        overlays.timeframe_15m["fvgs"] = extractZones(s.fvg_15m, "fvg");
        overlays.timeframe_15m["liquidity"] = extractLevels(s.liq_15m, "liquidity");
        overlays.timeframe_15m["swings"] = extractLevels(s.sw_15m, "swing");
        overlays.timeframe_15m["structure"] = extractZones(s.bos_15m, "structure");

        // 1h overlays
        overlays.timeframe_1h["order_blocks"] = extractZones(s.ob_1h, "order_block");
        overlays.timeframe_1h["fvgs"] = extractZones(s.fvg_1h, "fvg");
        overlays.timeframe_1h["liquidity"] = extractLevels(s.liq_1h, "liquidity");
        overlays.timeframe_1h["swings"] = extractLevels(s.sw_1h, "swing");
        overlays.timeframe_1h["structure"] = extractZones(s.bos_1h, "structure");

        // Daily overlays
        overlays.timeframe_daily["order_blocks"] = extractZones(s.ob_d, "order_block");
        overlays.timeframe_daily["fvgs"] = extractZones(s.fvg_d, "fvg");
        overlays.timeframe_daily["liquidity"] = extractLevels(s.liq_d, "liquidity");
        overlays.timeframe_daily["swings"] = extractLevels(s.sw_d, "swing");
        overlays.timeframe_daily["structure"] = extractZones(s.bos_d, "structure");

        // Weekly overlays
        overlays.timeframe_weekly["order_blocks"] = extractZones(s.ob_w, "order_block");
        overlays.timeframe_weekly["fvgs"] = extractZones(s.fvg_w, "fvg");
        overlays.timeframe_weekly["liquidity"] = extractLevels(s.liq_w, "liquidity");
        overlays.timeframe_weekly["swings"] = extractLevels(s.sw_w, "swing");
        overlays.timeframe_weekly["structure"] = extractZones(s.bos_w, "structure");

        // Bias
        overlays.bias = {
          weekly: s.weekly_bias,
          daily: s.daily_bias,
          one_hour: s.one_hour_bias,
        };

        if (o.pipeline === "ts01" || strategyCode.startsWith("IG_GOLDHUNTER_ICT2022")) {
          const ts01 = extractTs01Evidence(s.strategy_json, s.direction);
          overlays.timeframe_5m = ts01.overlays.timeframe_5m;
          overlays.timeframe_15m = ts01.overlays.timeframe_15m;
          overlays.timeframe_daily = ts01.overlays.timeframe_daily;
          overlays.timeframe_weekly = ts01.overlays.timeframe_weekly;
          overlays.bias = { weekly: null, daily: ts01.direction, one_hour: null };
        }

        if (igsEvidence) {
          overlays.timeframe_1m = igsEvidence.overlays as unknown as Record<string, unknown[]>;
          overlays.strategy_timeframe = igsEvidence.timeframe;
          overlays.bias = { weekly: null, daily: igsEvidence.direction, one_hour: null };
        }

        if (s10Evidence) {
          const bucket = overlays[s10Evidence.overlayKey];
          for (const key of ["order_blocks", "fvgs", "structure", "liquidity", "swings"] as const) {
            bucket[key] = [...((bucket[key] || []) as unknown[]), ...s10Evidence.overlays[key]];
          }
          overlays.ipda = s10Evidence.ipda;
          overlays.strategy_timeframe = s10Evidence.timeframe;
          overlays.bias = { weekly: null, daily: s10Evidence.dailyBias, one_hour: null };
          // S01-V2: selected data points per higher timeframe (15m / 30m / 1h / daily)
          const htfEvidence = (s10Evidence as { htf?: Record<string, Record<string, unknown[]>>; oneHourBias?: string | null });
          if (htfEvidence.htf) {
            for (const [tfKey, buckets] of Object.entries(htfEvidence.htf)) {
              const target = overlays[tfKey as TimeframeOverlayKey];
              for (const [k, arr] of Object.entries(buckets)) target[k] = [...((target[k] || []) as unknown[]), ...arr];
            }
            overlays.bias = { weekly: null, daily: s10Evidence.dailyBias, one_hour: htfEvidence.oneHourBias ?? null };
          }
        }

        // Also populate the flat arrays for backward compat
        overlays.order_blocks = [
          ...((overlays.timeframe_1m["order_blocks"] || []) as ObjRow[]),
          ...((overlays.timeframe_5m["order_blocks"] || []) as ObjRow[]),
          ...((overlays.timeframe_30m["order_blocks"] || []) as ObjRow[]),
        ];
        overlays.fvgs = [
          ...((overlays.timeframe_1m["fvgs"] || []) as ObjRow[]),
          ...((overlays.timeframe_5m["fvgs"] || []) as ObjRow[]),
          ...((overlays.timeframe_30m["fvgs"] || []) as ObjRow[]),
        ];
        overlays.liquidity = [
          ...((overlays.timeframe_1m["liquidity"] || []) as ObjRow[]),
          ...((overlays.timeframe_5m["liquidity"] || []) as ObjRow[]),
          ...((overlays.timeframe_30m["liquidity"] || []) as ObjRow[]),
        ];
        overlays.swings = [
          ...((overlays.timeframe_1m["swings"] || []) as ObjRow[]),
          ...((overlays.timeframe_5m["swings"] || []) as ObjRow[]),
          ...((overlays.timeframe_30m["swings"] || []) as ObjRow[]),
        ];
        overlays.structure = [
          ...((overlays.timeframe_1m["structure"] || []) as ObjRow[]),
          ...((overlays.timeframe_5m["structure"] || []) as ObjRow[]),
          ...((overlays.timeframe_30m["structure"] || []) as ObjRow[]),
        ];
    }

    // Same rule as the main backtest route: when a pipeline records the actual
    // realised R, use it. V2's breakeven/trim management means a CLOSED_STOP leg
    // is frequently 0R or better, so the legacy "loss = -1R" shortcut would
    // mislabel it on the chart header.
    const explicitR = num(o.realized_r);
    const isWin = explicitR !== null ? explicitR > 0 : o.state === "CLOSED_TP";
    const rr = num(o.target_rr);
    const shownR = explicitR !== null ? explicitR : isWin ? rr : -1;

    // SMT divergence at signal time (same cache key as /api/backtest).
    let smt = null;
    try {
      const key = `backtest:${o.order_id}`;
      smt = (await smtForTrades(pool, [{ key, symbol, market: o.market ?? null, signalTs: (signal?.entry_datetime as string | undefined) ?? o.filled_at, direction: o.direction ?? null }], 1)).get(key) ?? null;
    } catch { /* advisory */ }

    return NextResponse.json({
      success: true,
      order: {
        order_id: o.order_id,
        symbol,
        market: o.market,
        direction: o.direction,
        entry_price: num(o.entry_price),
        filled_price: num(o.filled_price),
        stoploss: num(o.stoploss),
        tp1: num(o.tp1),
        tp2: num(o.tp2),
        tp3: num(o.tp3),
        filled_at: o.filled_at,
        close_ts: o.close_ts,
        close_price: num(o.close_price),
        close_reason: o.close_reason,
        target_no: o.target_no,
        target_price: num(o.target_price),
        realized_r: shownR,
        outcome: isWin ? "WIN" : "LOSS",
      },
      timeframe: table.replace("historical_candles_", "").replace("candles_", ""),
      markers: {
        entry: { time: filledSec, price: num(o.filled_price) ?? num(o.entry_price) },
        exit: { time: closeSec, price: num(o.close_price), outcome: isWin ? "WIN" : "LOSS" },
      },
      candles,
      overlays,
      smt,
      window: { from: fromSec, to: toSec },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Postgres error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
