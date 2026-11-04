import { NextRequest, NextResponse } from "next/server";
import { parseSmtFilter, passesSmtFilter, smtForTrades, smtGroup, type SmtResult } from "@/lib/smt-signal";
import { parseWeeklyFilter, passesWeeklyFilter, weeklyHindsightGroup, weeklyLiveGroup, weeklyProfilesForTrades, PROFILE_LABELS, type WeeklyProfileResult } from "@/lib/weekly-profile";
import { getPostgresPool } from "@/lib/db";
import { buildCsv, csvDownloadResponse, selectedCsvKeys } from "@/lib/csv-export";
import { computeEdgeMetrics } from "@/lib/edge-metrics";
import {
  ICT_SESSION_DEFINITIONS,
  getIctSessionIds,
  ictSessionDisplayLabel,
  parseIctSessionSelection,
  passesIctSessionFilter,
  type IctSessionId,
} from "@/lib/ict-sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Coalesce concurrent dropdown loads and reuse metadata briefly. Failed loads
// are never cached, so Retry always has a chance to recover.
type FilterMetadata = {
  symbols: string[];
  strategies: Array<{ strategy_id: string; strategy_name: string | null; strategy_key: string | null; n: number; target_nos: number[]; markets: string[] }>;
  years: string[];
};
const filterMetadataCache = new Map<string, { expiresAt: number; value: Promise<FilterMetadata> }>();


// The original historical pipeline remains frozen.  Expose the isolated
// updated counter-trade family through a read-only common projection so the
// existing dashboard calculations and filters remain unchanged.
const TS01V2_ENGINE = "ts01_tb_v2.2026-08-22";

// S10-V3 (BPR / merged-imbalance rebuild) keeps its own run-scoped tables and
// is re-run freely, so pin the canonical completed full-history run.  The
// earlier runs are flagged superseded_conformance_defects /
// superseded_daily_basis_fix and must never reach the dashboard.
const S10V3_RUN = "s10v3-a00c29e7eb268fb06515";

// IGS01V2 was re-run end to end over 2017-01-02 .. 2026-09-07 on the rebuilt
// execution engine and republished into the 'updated' tables.  Named here
// because two places have to agree about which pipeline owns it.
const IGS01V2_STRATEGY_ID = "IGS01V2_LondonLiqGrab_SweepReversal";

// S16 can be rediscovered and persisted several times after the same setup was
// first detected. Its structural identity is the complete event chain, not
// ticker + entry timestamp and not signal_hash. The dashboard executes only
// checklist-complete canonical rows: the full population remains 3,934, while
// 264 TP2-evaluable rows with displacement before the final sweep extreme are
// excluded from the audited 3,383 proper-setup cohort.
const S16_PROPER_ORDER_IDS = `(
  SELECT ranked.order_id
  FROM (
    SELECT o.order_id::text AS order_id,
           (s.strategy_json #>> '{no_lookahead,passed}')::boolean AS proper_setup,
           row_number() OVER (
             PARTITION BY
               s.ticker,
               s.direction,
               s.strategy_json #>> '{selected_pool,created_at}',
               s.strategy_json #>> '{sweep,sweep_ts}',
               s.strategy_json #>> '{mss,mss_ts}',
               s.strategy_json #>> '{pd_array,created_at}',
               s.strategy_json #>> '{entry_retest,retest_ts}',
               round(s.entry_price::numeric, 6)
             ORDER BY s.as_of_ts, s.signal_hash
           ) AS occurrence
    FROM historical_ict_strategy_met_execution_updated s
    JOIN historical_ict_orders_updated o
      ON o.signal_id=s.signal_hash AND o.strategy_id=s.strategy_id
    WHERE s.strategy_id='S16' AND s.market='us'
  ) ranked
  WHERE ranked.occurrence=1 AND ranked.proper_setup
)`;

const BACKTEST_ORDERS = `(
  SELECT 'original'::text AS pipeline, order_id::text AS order_id, signal_id, market, source_market, symbol, strategy_id, run_date,
         state, direction, entry_price, stoploss, tp1, tp2, tp3, filled_price, filled_at,
         risk_probability, risk_bin, updated_at AS order_updated_at
  FROM historical_ict_orders
  -- IGS01V2's 552 rows here are 2026-only and come from the OLD engine (the
  -- pre-rebuild fill model and an 8h time limit).  Compared leg for leg against
  -- the rebuilt engine's tie-out they differ on 207 of 1,656 legs, so they are a
  -- different strategy wearing the same strategy_id.  The rebuilt 2017-2026
  -- population lives in the 'updated' tables below.  Excluded rather than
  -- deleted: the frozen table keeps its history, and removing this line brings
  -- the old numbers straight back.
  WHERE strategy_id IS DISTINCT FROM '${IGS01V2_STRATEGY_ID}'
  UNION ALL
  SELECT 'updated'::text AS pipeline, order_id::text AS order_id, signal_id, market, source_market, symbol, strategy_id, run_date,
         state, direction, entry_price, stoploss, tp1, tp2, tp3, filled_price, filled_at,
         risk_probability, risk_bin, updated_at AS order_updated_at
  FROM historical_ict_orders_updated
  UNION ALL
  SELECT 'ts01'::text AS pipeline, order_key AS order_id, order_key AS signal_id,
         market, market AS source_market, ticker AS symbol, strategy_id, session_date AS run_date,
         state, direction, theoretical_entry AS entry_price, stop_exec AS stoploss,
         NULLIF(order_json #>> '{geometry,targets,0,target_exit_price}', '')::double precision AS tp1,
         NULLIF(order_json #>> '{geometry,targets,1,target_exit_price}', '')::double precision AS tp2,
         NULLIF(order_json #>> '{geometry,targets,2,target_exit_price}', '')::double precision AS tp3,
         filled_price, fill_bar_ts AS filled_at, NULL::double precision AS risk_probability,
         NULL::integer AS risk_bin, updated_at AS order_updated_at
  FROM historical_ict_ts01_orders_updated
  WHERE engine_version='ts01_tb_r2.2026-08-18' AND cohort='primary' AND state='FILLED'
  UNION ALL
  -- TS01-TB V2. Separate engine, separate tables, surfaced under its own
  -- strategy_id so V1 and V2 can be selected together and compared side by side.
  SELECT 'ts01v2'::text AS pipeline, order_key AS order_id, candidate_key AS signal_id,
         market, market AS source_market, ticker AS symbol,
         'TS01-TB-V2'::text AS strategy_id, session_date AS run_date,
         state, direction, entry_price, stop_price AS stoploss,
         NULLIF(targets #>> '{0,price}', '')::double precision AS tp1,
         NULLIF(targets #>> '{1,price}', '')::double precision AS tp2,
         NULLIF(targets #>> '{2,price}', '')::double precision AS tp3,
         -- V2 is a resting limit at the array edge: the fill IS the quoted entry.
         entry_price AS filled_price, fill_bar_ts AS filled_at,
         NULL::double precision AS risk_probability, NULL::integer AS risk_bin,
         created_at AS order_updated_at
  FROM historical_ict_ts01v2_orders
  WHERE engine_version='${TS01V2_ENGINE}' AND state='FILLED'
  UNION ALL
  -- S10-V3. A resting limit at the edge of a Balanced Price Range, managed with
  -- scale-outs, stored as one run-scoped row per order with the whole decision
  -- trail inline in its payload column.  Only CLOSED orders are projected:
  -- PENDING, CANCELLED and SUPPRESSED never became trades.
  SELECT 's10v3'::text AS pipeline, o.order_id, o.order_id AS signal_id,
         'us'::text AS market, 'us'::text AS source_market, o.symbol,
         'S10-V3'::text AS strategy_id,
         (to_timestamp((o.payload->>'fill_ts')::bigint) AT TIME ZONE 'America/New_York')::date AS run_date,
         'FILLED'::text AS state,
         CASE WHEN (o.payload->>'d')::int = 1 THEN 'BUY' ELSE 'SELL' END AS direction,
         (o.payload->>'entry')::double precision AS entry_price,
         -- Size against the ORIGINAL stop.  The live stop migrates to breakeven
         -- during management, which would otherwise collapse the risk unit to
         -- zero and send position sizing to infinity.
         (o.payload->>'initial_stop')::double precision AS stoploss,
         (o.payload->'targets'->>0)::double precision AS tp1,
         (o.payload->'targets'->>1)::double precision AS tp2,
         (o.payload->'targets'->>2)::double precision AS tp3,
         -- The fill IS the quoted entry: a resting limit at the zone edge.
         (o.payload->>'entry')::double precision AS filled_price,
         to_timestamp((o.payload->>'fill_ts')::bigint) AS filled_at,
         NULL::double precision AS risk_probability, NULL::integer AS risk_bin,
         to_timestamp((o.payload->>'exit_ts')::bigint) AS order_updated_at
  FROM historical_ict_s10_v3_orders_updated o
  WHERE o.run_id='${S10V3_RUN}' AND o.state='CLOSED'
  UNION ALL
  -- S16-V2 (causal streaming rebuild, spec s16v2-spec-1.4). Run-scoped tables;
  -- only runs flagged published=TRUE reach the dashboard. A resting CE limit, so
  -- only FILLED orders are trades. entry_price is the planned CE.
  SELECT 's16v2'::text AS pipeline, o.setup_id AS order_id, o.setup_id AS signal_id,
         r.market, r.market AS source_market, o.symbol, 'S16-V2'::text AS strategy_id, o.run_date,
         o.state, o.direction, o.ce AS entry_price, o.stop AS stoploss, o.tp1, o.tp2, o.tp3,
         o.fill_price AS filled_price, o.fill_ts AS filled_at,
         NULL::double precision AS risk_probability, NULL::integer AS risk_bin, o.fill_ts AS order_updated_at
  FROM s16v2_orders o
  JOIN s16v2_runs r ON r.run_id = o.run_id AND r.published
  WHERE o.state = 'FILLED'
  UNION ALL
  -- S01-V2 Bread & Butter (causal rebuild, spec s01v2-spec-1.2). Market order at the
  -- open of the bar after the 5m rejection; entry_price is the planned entry (the
  -- rejection close, E_plan), filled_price the real next-bar open.
  SELECT 's01v2'::text AS pipeline, o.setup_id AS order_id, o.setup_id AS signal_id,
         r.market, r.market AS source_market, o.symbol, 'S01-V2'::text AS strategy_id, o.run_date,
         o.state, o.direction, o.e_plan AS entry_price, o.stop AS stoploss, o.tp1, o.tp2, o.tp3,
         o.fill_price AS filled_price, o.fill_ts AS filled_at,
         NULL::double precision AS risk_probability, NULL::integer AS risk_bin, o.fill_ts AS order_updated_at
  FROM s01v2_orders o
  JOIN s01v2_runs r ON r.run_id = o.run_id AND r.published
  WHERE o.state = 'FILLED'
  UNION ALL
  SELECT 's01v3'::text AS pipeline, o.setup_id AS order_id, o.setup_id AS signal_id,
         r.market, r.market AS source_market, o.symbol, 'S01-V3'::text AS strategy_id, o.run_date,
         o.state, o.direction, o.e_plan AS entry_price, o.stop AS stoploss, o.tp1, o.tp2, o.tp3,
         o.fill_price AS filled_price, o.fill_ts AS filled_at,
         NULL::double precision AS risk_probability, NULL::integer AS risk_bin, o.fill_ts AS order_updated_at
  FROM s01v3_orders o
  JOIN s01v3_runs r ON r.run_id = o.run_id AND r.published
  WHERE o.state = 'FILLED'
  UNION ALL
  -- Scalping_OB_OB_V2 (Scalping Labs 1h OB x 5m OB; frozen filters 2026-10-24). Resting limit at the
  -- 5m OB, so the fill IS the planned entry; one target = nearest liquidity >= 1R. realized_r is GROSS R
  -- on planned risk: losses exit at the 5m close beyond the stop, so they are not exactly -1R.
  SELECT 'scalpv2'::text AS pipeline, o.setup_id AS order_id, o.setup_id AS signal_id,
         'us'::text AS market, 'us'::text AS source_market, o.symbol, 'Scalping_OB_OB_V2'::text AS strategy_id, o.run_date,
         o.state, o.direction, o.entry AS entry_price, o.stop AS stoploss, o.tp1,
         NULL::double precision AS tp2, NULL::double precision AS tp3,
         o.fill_price AS filled_price, o.fill_ts AS filled_at,
         NULL::double precision AS risk_probability, NULL::integer AS risk_bin, o.fill_ts AS order_updated_at
  FROM scalping_ob_ob_v2_orders o
  JOIN scalping_ob_ob_v2_runs r ON r.run_id = o.run_id AND r.published
  WHERE o.state = 'FILLED'
  UNION ALL
  -- Scalping_OB_OB_V4 = V2 + planned move < 3% + crowding cap (<=3 earlier same-direction signals today) + 50% off at +2R
  -- (resting limit). realized_r is GROSS R on planned risk and blends the partial with the remainder's exit.
  SELECT 'scalpv4'::text AS pipeline, o.setup_id AS order_id, o.setup_id AS signal_id,
         'us'::text AS market, 'us'::text AS source_market, o.symbol, 'Scalping_OB_OB_V4'::text AS strategy_id, o.run_date,
         o.state, o.direction, o.entry AS entry_price, o.stop AS stoploss, o.tp1,
         NULL::double precision AS tp2, NULL::double precision AS tp3,
         o.fill_price AS filled_price, o.fill_ts AS filled_at,
         NULL::double precision AS risk_probability, NULL::integer AS risk_bin, o.fill_ts AS order_updated_at
  FROM scalping_ob_ob_v4_orders o
  JOIN scalping_ob_ob_v4_runs r ON r.run_id = o.run_id AND r.published
  WHERE o.state = 'FILLED'
  UNION ALL
  -- BPR_OB_V3 (Quiet Open A): 1h BPR x 5m OB, 09:30-10:55, chase <= +0.25%, quiet open < 0.2, move < 3%, no repeats
  -- (ticker, side, date), crowding <= 3, 50% off at +2R. realized_r = GROSS R on planned risk, partial blended.
  SELECT 'bprv3'::text AS pipeline, o.setup_id AS order_id, o.setup_id AS signal_id,
         'us'::text AS market, 'us'::text AS source_market, o.symbol, 'BPR_OB_V3'::text AS strategy_id, o.run_date,
         o.state, o.direction, o.entry AS entry_price, o.stop AS stoploss, o.tp1,
         NULL::double precision AS tp2, NULL::double precision AS tp3,
         o.fill_price AS filled_price, o.fill_ts AS filled_at,
         NULL::double precision AS risk_probability, NULL::integer AS risk_bin, o.fill_ts AS order_updated_at
  FROM scalping_bpr_ob_v3_orders o
  JOIN scalping_bpr_ob_v3_runs r ON r.run_id = o.run_id AND r.published
  WHERE o.state = 'FILLED'
)`;

const BACKTEST_SIGNALS = `(
  SELECT 'original'::text AS pipeline, signal_hash, entry_datetime, strategy_json,
         updated_timestamp AS signal_updated_timestamp
  FROM historical_ict_strategy_met_execution
  UNION ALL
  SELECT 'updated'::text AS pipeline, signal_hash, entry_datetime, strategy_json,
         updated_timestamp AS signal_updated_timestamp
  FROM historical_ict_strategy_met_execution_updated
  UNION ALL
  SELECT 'ts01'::text AS pipeline, o.order_key AS signal_hash,
         COALESCE(d.entry_ts, o.fill_bar_ts) AS entry_datetime, d.strategy_json,
         d.updated_at AS signal_updated_timestamp
  FROM historical_ict_ts01_orders_updated o
  JOIN historical_ict_ts01_daily_validation_updated d
    ON d.engine_version=o.engine_version AND d.cohort=o.cohort AND d.market=o.market
   AND d.ticker=o.ticker AND d.session_date=o.session_date
  WHERE o.engine_version='ts01_tb_r2.2026-08-18' AND o.cohort='primary' AND o.state='FILLED'
  UNION ALL
  -- V2 stores its evidence per candidate rather than as one strategy_json blob.
  -- Assemble the equivalent object here so the Strategy JSON inspector shows the
  -- full decision trail (raid -> MSS -> array -> gates -> targets -> management).
  SELECT 'ts01v2'::text AS pipeline, o.candidate_key AS signal_hash,
         o.fill_bar_ts AS entry_datetime,
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
         ) AS strategy_json,
         o.created_at AS signal_updated_timestamp
  FROM historical_ict_ts01v2_orders o
  JOIN historical_ict_ts01v2_candidates c ON c.candidate_key = o.candidate_key
  WHERE o.engine_version='${TS01V2_ENGINE}' AND o.state='FILLED'
  UNION ALL
  -- S10-V3 already persists its evidence (the BPR pair, its two opposing FVG
  -- legs, the daily gate and the target inefficiencies) inside the order
  -- payload.  Surface that as-is and append the execution geometry plus the
  -- realised scale-out ladder so the inspector shows the full decision trail.
  SELECT 's10v3'::text AS pipeline, o.order_id AS signal_hash,
         to_timestamp((o.payload->>'fill_ts')::bigint) AS entry_datetime,
         (o.payload->'strategy_json') || jsonb_build_object(
           'strategy_id', 'S10-V3',
           'run_id', o.run_id,
           'path', o.path,
           'timeframe', o.timeframe,
           'direction', CASE WHEN (o.payload->>'d')::int = 1 THEN 'BUY' ELSE 'SELL' END,
           'quality', o.payload->'quality',
           'absorption', o.payload->'absorption',
           'execution', jsonb_build_object(
             'entry', o.payload->'entry',
             'initial_stop', o.payload->'initial_stop',
             'final_stop', o.payload->'stop',
             'risk_points', o.payload->'risk',
             'fill_time_precision', o.payload->'fill_time_precision',
             'filled_at', to_char(to_timestamp((o.payload->>'fill_ts')::bigint)
                                    AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS')),
           'target_ladder', jsonb_build_object(
             'prices', o.payload->'targets',
             'sizes', o.payload->'sizes',
             'hits', o.payload->'hits'),
           'exit', jsonb_build_object(
             'reason', o.payload->'reason',
             'price', o.payload->'exit_price',
             'closed_at', to_char(to_timestamp((o.payload->>'exit_ts')::bigint)
                                    AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS'),
             -- Kept for traceability only.  This is the ENGINE's own net R, which
             -- already embeds its cost_bps assumption; the dashboard reports a
             -- gross R and applies its own commission/slippage model instead.
             'engine_net_r', o.payload->'net_r',
             'engine_cost_bps', o.payload->'strategy_json'->'cost_bps'),
           'realised_exits', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'kind', e.kind,
                      'fraction', (e.payload->>'fraction')::double precision,
                      'price', (e.payload->>'price')::double precision,
                      'target', e.payload->'target',
                      'at', to_char(e.event_ts AT TIME ZONE 'America/New_York',
                                    'YYYY-MM-DD HH24:MI:SS'))
                      ORDER BY e.event_ts)
             FROM historical_ict_s10_v3_events_updated e
             WHERE e.run_id = o.run_id AND e.order_id = o.order_id
               AND e.payload->>'fraction' IS NOT NULL), '[]'::jsonb)
         ) AS strategy_json,
         to_timestamp((o.payload->>'exit_ts')::bigint) AS signal_updated_timestamp
  FROM historical_ict_s10_v3_orders_updated o
  WHERE o.run_id='${S10V3_RUN}' AND o.state='CLOSED'
  UNION ALL
  -- S16-V2 evidence: the full causal decision trail (pool -> sweep -> extensions ->
  -- displacement -> MSS -> PD array -> stop -> bucketed targets) plus the fill.
  SELECT 's16v2'::text AS pipeline, st.setup_id AS signal_hash, st.decision_known_at AS entry_datetime,
         st.payload || jsonb_build_object(
           'run_id', st.run_id,
           'order', jsonb_build_object('placed_at', o.placed_at, 'ce', o.ce, 'stop', o.stop,
                                       'fill_ts', o.fill_ts, 'fill_price', o.fill_price,
                                       'fill_method', o.fill_method, 'risk_plan', o.risk_plan,
                                       'fill_through_extreme', o.fill_through_extreme,
                                       'fill_through_stop', o.fill_through_stop,
                                       'score_final', o.score_final)
         ) AS strategy_json,
         st.decision_known_at AS signal_updated_timestamp
  FROM s16v2_setups st
  JOIN s16v2_runs r ON r.run_id = st.run_id AND r.published
  JOIN s16v2_orders o ON o.run_id = st.run_id AND o.setup_id = st.setup_id AND o.state = 'FILLED'
  UNION ALL
  -- S01-V2 evidence: pool -> HTF sweep -> 5m displacement -> MSS/BOS/CHoCH -> FVG/OB ->
  -- trend gate -> rejection -> next-open fill -> bucketed targets.
  SELECT 's01v2'::text AS pipeline, st.setup_id AS signal_hash, st.rejection_ts AS entry_datetime,
         st.payload || jsonb_build_object(
           'run_id', st.run_id,
           'order', jsonb_build_object('rejection_ts', o.rejection_ts, 'e_plan', o.e_plan, 'stop', o.stop,
                                       'fill_ts', o.fill_ts, 'fill_price', o.fill_price,
                                       'fill_minus_eplan', o.fill_minus_eplan, 'risk_plan', o.risk_plan,
                                       'killzone', o.killzone, 'sweep_tf', o.sweep_tf)
         ) AS strategy_json,
         st.rejection_ts AS signal_updated_timestamp
  FROM s01v2_setups st
  JOIN s01v2_runs r ON r.run_id = st.run_id AND r.published
  JOIN s01v2_orders o ON o.run_id = st.run_id AND o.setup_id = st.setup_id AND o.state = 'FILLED'
  UNION ALL
  SELECT 's01v3'::text AS pipeline, st.setup_id AS signal_hash, st.rejection_ts AS entry_datetime,
         st.payload || jsonb_build_object(
           'run_id', st.run_id,
           'order', jsonb_build_object('rejection_ts', o.rejection_ts, 'e_plan', o.e_plan, 'stop', o.stop,
                                       'fill_ts', o.fill_ts, 'fill_price', o.fill_price,
                                       'fill_minus_eplan', o.fill_minus_eplan, 'risk_plan', o.risk_plan,
                                       'killzone', o.killzone, 'sweep_tf', o.sweep_tf)
         ) AS strategy_json,
         st.rejection_ts AS signal_updated_timestamp
  FROM s01v3_setups st
  JOIN s01v3_runs r ON r.run_id = st.run_id AND r.published
  JOIN s01v3_orders o ON o.run_id = st.run_id AND o.setup_id = st.setup_id AND o.state = 'FILLED'
  UNION ALL
  SELECT 'scalpv2'::text AS pipeline, st.setup_id AS signal_hash, st.entry_ts AS entry_datetime,
         st.payload AS strategy_json, st.entry_ts AS signal_updated_timestamp
  FROM scalping_ob_ob_v2_setups st
  JOIN scalping_ob_ob_v2_runs r ON r.run_id = st.run_id AND r.published
  UNION ALL
  SELECT 'scalpv4'::text AS pipeline, st.setup_id AS signal_hash, st.entry_ts AS entry_datetime,
         st.payload AS strategy_json, st.entry_ts AS signal_updated_timestamp
  FROM scalping_ob_ob_v4_setups st
  JOIN scalping_ob_ob_v4_runs r ON r.run_id = st.run_id AND r.published
  UNION ALL
  SELECT 'bprv3'::text AS pipeline, st.setup_id AS signal_hash, st.entry_ts AS entry_datetime,
         st.payload AS strategy_json, st.entry_ts AS signal_updated_timestamp
  FROM scalping_bpr_ob_v3_setups st
  JOIN scalping_bpr_ob_v3_runs r ON r.run_id = st.run_id AND r.published
)`;

// `realized_r` is an OPTIONAL override. The legacy pipelines leave it NULL and
// keep the existing "rr on a win, -1 on a loss" behaviour untouched. V2 supplies
// it because its Ep41 management (trim at 50% of range, breakeven at 75%) makes
// a stopped leg worth something other than -1R on 1,024 of 3,870 legs - assuming
// -1 there would materially overstate its losses.
// Which legs count as closed trades.
//
// A leg resolved at a target or a stop always counts. A leg that ran out of
// time counts ONLY when its pipeline recorded what it was actually worth
// (realized_r) - otherwise there is no honest number to book for it. The two
// canonical S16 TP2 expiries are the documented exception and are scored at
// -1R, matching the published structural-population audit.
//
// This exists because IGS legs that reach the 8h horizon close as
// CLOSED_EXPIRED at a real exit price. Dropping them silently deleted ten
// PROFITABLE TP3 legs worth +25.2R from IGS01V2 and made TP2 look like the
// better target. The realized_r guard keeps every equity strategy's population
// byte-identical, since none of them populate that column.
const CLOSED_LEG =
  `(t.state IN ('CLOSED_TP','CLOSED_SL') OR
    (t.state = 'CLOSED_EXPIRED' AND (
      t.realized_r IS NOT NULL OR
      (UPPER(COALESCE(o.strategy_id,''))='S16' AND LOWER(COALESCE(o.market,''))='us' AND o.pipeline='updated')
    )))`;

const BACKTEST_TARGETS = `(
  -- realized_r is populated only by pipelines whose exits are not worth exactly
  -- -1R (the IGS forex series: close-confirmed stops exit at the breaking bar's
  -- close, and an unresolved leg runs to an 8h horizon). It is NULL for the
  -- equity strategies, which keeps their legacy win=target_rr / loss=-1R
  -- accounting exactly as it was.
  SELECT 'original'::text AS pipeline, order_id::text AS order_id, target_no, target_price, target_rr,
         NULL::double precision AS target_rr_filled, state, close_ts, close_price, close_reason,
         realized_r
  FROM historical_ict_order_target_outcomes
  UNION ALL
  -- realized_r was added to this table for the republished IGS01V2 history and
  -- is NULL on every row that predates it, so the equity strategies keep their
  -- legacy win=target_rr / loss=-1R accounting byte for byte.  It is GROSS R:
  -- applySizing() charges commission and slippage on top, and passing net R
  -- would bill the costs twice.
  SELECT 'updated'::text AS pipeline, order_id::text AS order_id, target_no, target_price, target_rr,
         target_rr_filled, state, close_ts, close_price, close_reason,
         realized_r
  FROM historical_ict_order_target_outcomes_updated
  UNION ALL
  SELECT 'ts01'::text AS pipeline, order_key AS order_id, target_no, target_price, target_rr,
         NULL::double precision AS target_rr_filled,
         state, close_bar_ts AS close_ts, close_price, target_json->>'reason' AS close_reason,
         NULL::double precision AS realized_r
  FROM historical_ict_ts01_target_outcomes_updated
  WHERE engine_version='ts01_tb_r2.2026-08-18' AND cohort='primary'
  UNION ALL
  SELECT 'ts01v2'::text AS pipeline, o.order_key AS order_id,
         (leg->>'no')::int AS target_no,
         (leg->>'price')::double precision AS target_price,
         (leg->>'net_rr')::double precision AS target_rr,
         NULL::double precision AS target_rr_filled,
         -- The dashboard understands two terminal states. Delivery-window and
         -- session-end exits are neither a target nor a stop, so they are
         -- bucketed by the sign of their realised R; close_reason keeps the
         -- true exit type visible.
         CASE
           WHEN leg->>'state' = 'CLOSED_TP' THEN 'CLOSED_TP'
           WHEN leg->>'state' = 'CLOSED_STOP' THEN 'CLOSED_SL'
           WHEN COALESCE((leg->>'realized_r')::double precision, 0) > 0 THEN 'CLOSED_TP'
           ELSE 'CLOSED_SL'
         END AS state,
         (leg->>'close_ts')::timestamptz AS close_ts,
         -- V2 records R, not an exit price. Reconstruct the price from realised R
         -- so notional-based costs and the fixed-quantity mode stay consistent.
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
  -- S10-V3 scales out of ONE managed position (0.55 / 0.25 / 0.20), so its
  -- realised R is a single position-level number rather than three independent
  -- target outcomes.  Each of the three rows therefore carries the planned
  -- price and RR for its own target - so the ladder still reads correctly - but
  -- the same realised R, so switching the target selector can never double
  -- count a partial exit.
  --
  -- That R is GROSS.  The engine's stored net_r already bakes in a 25bps cost
  -- assumption, and applySizing() applies the dashboard's own commission and
  -- slippage on top, so passing net_r through would charge costs twice.  It is
  -- rebuilt here from the exit ladder, whose fractions sum to exactly 1.0 on
  -- every closed order:  R = SUM(fraction * (exit - entry)) * direction / risk.
  SELECT 's10v3'::text AS pipeline, o.order_id, g.i AS target_no,
         (o.payload->'targets'->>(g.i - 1))::double precision AS target_price,
         ((o.payload->'targets'->>(g.i - 1))::double precision
            - (o.payload->>'entry')::double precision)
           * (o.payload->>'d')::double precision
           / NULLIF((o.payload->>'risk')::double precision, 0) AS target_rr,
         NULL::double precision AS target_rr_filled,
         CASE WHEN x.gross_r > 0 THEN 'CLOSED_TP' ELSE 'CLOSED_SL' END AS state,
         x.closed_at AS close_ts,
         -- Size-weighted average exit, so the fixed-quantity sizing mode prices
         -- the scale-out the same way the R column does.
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
  -- S16-V2: TP1/TP2/TP3 are three INDEPENDENT single-target outcomes of the same
  -- entry.  realized_r is GROSS R on the pre-order risk (CE - stop); exits are
  -- executable (resting TP limit, candle-close stop exited at the next bar open,
  -- 10-day MOC), so a loss is not assumed to be -1R.
  SELECT 's16v2'::text AS pipeline, u.setup_id AS order_id, u.target_no, u.target_price,
         u.rr_plan AS target_rr, NULL::double precision AS target_rr_filled,
         u.state, u.exit_ts AS close_ts, u.exit_price AS close_price, u.exit_type AS close_reason,
         u.r_plan AS realized_r
  FROM s16v2_outcomes u
  JOIN s16v2_runs r ON r.run_id = u.run_id AND r.published
  UNION ALL
  -- S01-V2: same independent TP1/TP2/TP3 model as S16-V2; GROSS R on the planned
  -- risk (E_plan - stop), measured from the real fill.
  SELECT 's01v2'::text AS pipeline, u.setup_id AS order_id, u.target_no, u.target_price,
         u.rr_plan AS target_rr, NULL::double precision AS target_rr_filled,
         u.state, u.exit_ts AS close_ts, u.exit_price AS close_price, u.exit_type AS close_reason,
         u.r_plan AS realized_r
  FROM s01v2_outcomes u
  JOIN s01v2_runs r ON r.run_id = u.run_id AND r.published
  UNION ALL
  SELECT 's01v3'::text AS pipeline, u.setup_id AS order_id, u.target_no, u.target_price,
         u.rr_plan AS target_rr, NULL::double precision AS target_rr_filled,
         u.state, u.exit_ts AS close_ts, u.exit_price AS close_price, u.exit_type AS close_reason,
         u.r_plan AS realized_r
  FROM s01v3_outcomes u
  JOIN s01v3_runs r ON r.run_id = u.run_id AND r.published
  UNION ALL
  SELECT 'scalpv2'::text AS pipeline, u.setup_id AS order_id, u.target_no, u.target_price,
         u.rr_plan AS target_rr, NULL::double precision AS target_rr_filled,
         u.state, u.exit_ts AS close_ts, u.exit_price AS close_price, u.exit_type AS close_reason,
         u.r_plan AS realized_r
  FROM scalping_ob_ob_v2_outcomes u
  JOIN scalping_ob_ob_v2_runs r ON r.run_id = u.run_id AND r.published
  UNION ALL
  SELECT 'scalpv4'::text AS pipeline, u.setup_id AS order_id, u.target_no, u.target_price,
         u.rr_plan AS target_rr, NULL::double precision AS target_rr_filled,
         u.state, u.exit_ts AS close_ts, u.exit_price AS close_price, u.exit_type AS close_reason,
         u.r_plan AS realized_r
  FROM scalping_ob_ob_v4_outcomes u
  JOIN scalping_ob_ob_v4_runs r ON r.run_id = u.run_id AND r.published
  UNION ALL
  SELECT 'bprv3'::text AS pipeline, u.setup_id AS order_id, u.target_no, u.target_price,
         u.rr_plan AS target_rr, NULL::double precision AS target_rr_filled,
         u.state, u.exit_ts AS close_ts, u.exit_price AS close_price, u.exit_type AS close_reason,
         u.r_plan AS realized_r
  FROM scalping_bpr_ob_v3_outcomes u
  JOIN scalping_bpr_ob_v3_runs r ON r.run_id = u.run_id AND r.published
)`;

const BUILTIN_STRATEGY_NAMES = new Map<string, string>([
  ["BPR_OB_V3", "BPR x OB V3 - Quiet Open (A): 1h BPR + 5m OB, quiet open < 0.2, no repeats"],
  ["Scalping_OB_OB_V4", "Scalping OB x OB V4 - V2 + move<3% + crowding cap + 50% at +2R"],
  ["Scalping_OB_OB_V2", "Scalping OB x OB V2 - 1h OB + 5m OB, 09:30-12:00, opening-price + quiet/nested"],
  ["IG_Goldhunter_ICT2022_R2", "Gold Hunter ICT 2022 V2"],
  ["IG_Goldhunter_ICT2022_V3", "Gold Hunter ICT 2022 V3"],
  ["IG_Goldhunter_ICT2022", "ICT 2022 — Goldhunter alignment"],
  ["TS01-TB", "ICT 2022 Mentorship (V1)"],
  ["TS01-TB-V2", "ICT 2022 Mentorship V2"],
  ["S16-V2", "S16 V2 — HTF Bias Liquidity Sweep MSS OB/FVG Retest (causal)"],
  ["S01-V3", "S01 V3 — Daily HTF Bias (US backtest)"],
  ["S01-V2", "S01 V2 — Bread & Butter: HTF Sweep → 5m MSS → FVG/OB Rejection (causal)"],
]);

type RawTrade = {
  order_id: string;
  market: string | null;
  symbol: string;
  strategy_id: string | null;
  strategy_name: string | null;
  pipeline: string | null;
  direction: string | null;
  entry_datetime: string | null;
  filled_at: string | null;
  entry_price: string | number | null;
  filled_price: string | number | null;
  stoploss: string | number | null;
  tp1: string | number | null;
  tp2: string | number | null;
  tp3: string | number | null;
  close_ts: string | null;
  close_price: string | number | null;
  target_rr: string | number | null;
  target_rr_filled: string | number | null;
  target_price?: string | number | null;
  realized_r: string | number | null;
  close_reason: string | null;
  state: string;
  risk_probability: string | number | null;
  risk_bin: string | number | null;
  strategy_json: unknown;
  strategy_json_available: boolean;
  strategy_json_keys: string[] | null;
};

type Trade = {
  order_id: string;
  market: string | null;
  symbol: string;
  strategy_id: string | null;
  strategy_name: string | null;
  pipeline: string | null;
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
  /** Price move entry(fill) -> exit in %, signed so + = in the trade's favour. */
  move_pct: number | null;
  planned_move_pct: number | null;
  planned_risk_pct: number | null;
  /** Price of the selected target (Target 1/2/3). */
  target_price: number | null;
  /** Planned reward:risk for the selected target: |target - entry| / |entry - stop|, signed by side. */
  target_ratio: number | null;
  /** How the trade closed: TP, SL, TIME (time/flatten stop or expiry) or OTHER. */
  exit_type: "TP" | "SL" | "TIME" | "OTHER";
  quantity: number | null;
  risk_usd: number | null;
  gross_pnl_usd: number | null;
  transaction_cost_usd: number | null;
  pnl_usd: number | null;
  outcome: "WIN" | "LOSS";
  hold_min: number | null;
  risk_probability: number | null;
  risk_bin: number | null;
  strategy_json?: unknown;
  strategy_json_available: boolean;
  strategy_json_keys: string[];
  ict_sessions: IctSessionId[];
  /** SMT divergence vs the index / correlated peer at signal time (lib/smt-signal). */
  smt_status?: string | null;
  smt_aligned?: boolean | null;
  smt_peer?: string | null;
  smt_group?: string;
  /** ICT weekly profile (lib/weekly-profile): live = known at signal, hindsight = what the week printed (label only). */
  wp_live?: string | null;
  wp_live_aligned?: boolean | null;
  wp_hindsight?: string | null;
  wp_hindsight_aligned?: boolean | null;
  wp_day?: string | null;
  wp_group?: string;
  wp_hindsight_group?: string;
};

const BACKTEST_CSV_KEYS = [
  "entry_datetime", "close_ts", "symbol", "strategy_id", "strategy_name", "direction",
  "filled", "stop", "tp1", "tp2", "tp3", "close_price", "quantity", "risk_usd", "gross_pnl_usd",
  "transaction_cost_usd", "pnl_usd", "r", "move_pct", "planned_move_pct", "planned_risk_pct", "target_price", "target_ratio", "hold_min", "outcome", "risk_probability",
  "risk_bin", "strategy_json_available", "smt_status", "smt_aligned", "smt_peer",
  "wp_day", "wp_live", "wp_live_aligned", "wp_hindsight", "wp_hindsight_aligned",
] as const;

const DEFAULT_BACKTEST_CSV_KEYS = [
  "entry_datetime", "close_ts", "strategy_id", "direction", "filled", "close_price",
  "pnl_usd", "r", "move_pct", "planned_move_pct", "planned_risk_pct", "target_ratio", "hold_min", "outcome", "risk_probability", "risk_bin",
  "strategy_json_available",
] as const;

function backtestCsv(trades: Trade[], rawColumns: string | null) {
  const keys = selectedCsvKeys(rawColumns, BACKTEST_CSV_KEYS, DEFAULT_BACKTEST_CSV_KEYS);
  const columns = [
    ...keys.map((key) => ({ key, value: (trade: Trade) => trade[key as keyof Trade] })),
    { key: "strategy_json", value: (trade: Trade) => trade.strategy_json ?? null },
  ];
  return buildCsv(columns, trades);
}

type SizingMode = "fixed_risk" | "fixed_qty";

type SizingSettings = {
  mode: SizingMode;
  initialCapital: number;
  riskUsd: number;
  quantity: number;
  commissionBps: number;
  slippageBps: number;
};

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Accepts "HH:MM" on a 5-minute grid inside the regular session. Anything else
// (including "NONE") disables the time stop.
function parseCloseTime(v: string | null): string | null {
  const raw = (v || "").trim();
  if (!raw || raw.toUpperCase() === "NONE") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || mm % 5 !== 0) return null;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function targetNo(v: string | null) {
  const n = Number(v || 1);
  return [1, 2, 3].includes(n) ? n : 1;
}

function cleanDate(v: string | null) {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return "";
  return v;
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const csvExport = sp.get("format") === "csv";
  const filtersOnly = sp.get("filters_only") === "true";
  // `symbol` mirrors the strategy contract: comma-separated values support a
  // checkbox multi-select, while an empty list or ALL means no ticker filter.
  const symbolRaw = (sp.get("symbol") || (filtersOnly ? "ALL" : "AAPL")).trim().toUpperCase();
  const symbolList = symbolRaw.split(",").map((value) => value.trim()).filter(Boolean);
  const symbolAll = symbolList.length === 0 || symbolList.includes("ALL");
  const symbol = symbolRaw;
  // `strategy_id` accepts a comma-separated list so several strategies can be
  // compared in one run. "ALL" anywhere in the list means no strategy filter.
  const strategyRaw = (sp.get("strategy_id") || "S16").trim().toUpperCase();
  const strategyList = strategyRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const strategyAll = strategyList.length === 0 || strategyList.includes("ALL");
  const s16Only = !strategyAll && strategyList.length === 1 && strategyList[0] === "S16";
  const strategy = strategyRaw;
  const direction = (sp.get("direction") || "ALL").trim().toUpperCase();
  const target_no = targetNo(sp.get("target_no"));
  const year = (sp.get("year") || "ALL").trim();
  const startDate = cleanDate(sp.get("start_date"));
  const endDate = cleanDate(sp.get("end_date"));
  // Which backtest engine produced the row. S15 (and others) exist in BOTH the
  // original percent-floor pipeline and the rebuilt structural-stop pipeline;
  // blending them averages two different risk models into a number that
  // describes neither, so the desk needs to look at one at a time.
  const buildRaw = (sp.get("build") || "ALL").trim().toLowerCase();
  const requestedBuild = buildRaw === "updated" || buildRaw === "original" ? buildRaw : "ALL";
  // The recommended S16 identity exists only in the updated structural build.
  // Keep the original available as an explicit comparison, but never blend it
  // into the canonical result when callers send the old ALL default.
  const canonicalS16 = s16Only && requestedBuild !== "original";
  const build = canonicalS16 ? "updated" : requestedBuild;
  // Intraday time stop: flatten any position still open at this exchange-local
  // time on its entry day. "NONE" keeps the engine's own exit.
  const closeTime = parseCloseTime(sp.get("close_time"));
  const tradeSort = sp.get("trade_sort") === "entry_datetime" ? "entry_datetime" : "close_ts";
  const tradeOrder = sp.get("trade_order") === "asc" ? "asc" : "desc";
  const selectedIctSessions = parseIctSessionSelection(sp.get("ict_sessions"));
  // Filter metadata is invariant across normal result refreshes.  The client
  // loads it once, then requests only the selected backtest result.
  const includeFilters = sp.get("include_filters") !== "false";
  const sizingMode: SizingMode = sp.get("sizing_mode") === "fixed_qty" ? "fixed_qty" : "fixed_risk";
  const sizing: SizingSettings = {
    mode: sizingMode,
    initialCapital: Math.max(1, Number(sp.get("initial_capital") || 100000) || 100000),
    riskUsd: Math.max(1, Number(sp.get("risk_usd") || 100) || 100),
    quantity: Math.max(1, Number(sp.get("quantity") || 100) || 100),
    commissionBps: Math.max(0, Number(sp.get("commission_bps") || 1) || 0),
    slippageBps: Math.max(0, Number(sp.get("slippage_bps") || 2) || 0),
  };
  const oosPct = Math.min(50, Math.max(10, Number(sp.get("oos_pct") || 30) || 30));
  // Target R:R filter (strict bounds). Blank/absent = no filter.
  const rrBound = (raw: string | null) => {
    if (raw === null || raw.trim() === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const rrMin = rrBound(sp.get("rr_min"));
  const rrMax = rrBound(sp.get("rr_max"));
  // Move % filter (strict bounds, percent): signed move from fill to exit in the
  // trade's direction.  Blank/absent = no filter.
  const moveMin = rrBound(sp.get("move_min"));
  const moveMax = rrBound(sp.get("move_max"));
  const plannedMin = rrBound(sp.get("planned_min"));
  const plannedMax = rrBound(sp.get("planned_max"));
  const riskMin = rrBound(sp.get("risk_min"));
  const riskMax = rrBound(sp.get("risk_max"));
  const smtFilter = parseSmtFilter(sp.get("smt"));
  const weeklyFilter = parseWeeklyFilter(sp.get("wp"));

  // Prefer the REST bridge whenever it is configured (e.g. on Vercel, which
  // reaches the DB through the local REST API). Direct Postgres is only used
  // when no bridge URL is set (e.g. local development).
  const restApiUrl = process.env.CANDLES_REST_API_URL;
  if (restApiUrl) {
    const upstreamUrl = new URL("/api/backtest", restApiUrl);
    for (const [key, value] of sp.entries()) {
      upstreamUrl.searchParams.set(key, value);
    }
    if (!sp.has("strategy_id")) upstreamUrl.searchParams.set("strategy_id", "S16");
    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        headers: process.env.CANDLES_REST_API_TOKEN
          ? { "x-api-key": process.env.CANDLES_REST_API_TOKEN }
          : undefined,
        cache: "no-store",
      });
      if (csvExport) {
        const responseHeaders = new Headers();
        for (const name of ["content-type", "content-disposition", "x-export-row-count"]) {
          const value = upstreamResponse.headers.get(name);
          if (value) responseHeaders.set(name, value);
        }
        responseHeaders.set("cache-control", "no-store");
        return new Response(await upstreamResponse.arrayBuffer(), { status: upstreamResponse.status, headers: responseHeaders });
      }
      const payload = await upstreamResponse.json();
      return NextResponse.json(payload, { status: upstreamResponse.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown REST API error";
      return NextResponse.json({ success: false, error: `REST API unavailable: ${message}` }, { status: 502 });
    }
  }

  const conds = [CLOSED_LEG, "t.target_no = $1"];
  const params: Array<string | number | string[]> = [target_no];
  if (!symbolAll) {
    params.push(symbolList);
    conds.push(`UPPER(o.symbol) = ANY($${params.length}::text[])`);
  }
  if (!strategyAll) {
    params.push(strategyList);
    conds.push(`UPPER(o.strategy_id) = ANY($${params.length}::text[])`);
  }
  if (direction && direction !== "ALL") {
    params.push(direction);
    conds.push(`UPPER(o.direction) = $${params.length}`);
  }
  if (build !== "ALL") {
    params.push(build);
    conds.push(`o.pipeline = $${params.length}`);
  }
  if (canonicalS16) {
    conds.push(`LOWER(COALESCE(o.market,'')) = 'us'`);
    conds.push(`o.order_id IN ${S16_PROPER_ORDER_IDS}`);
  }
  if (year && year !== "ALL") {
    params.push(year);
    conds.push(`EXTRACT(YEAR FROM o.run_date)::text = $${params.length}`);
  }
  if (startDate) {
    params.push(startDate);
    conds.push(`t.close_ts::date >= $${params.length}::date`);
  }
  if (endDate) {
    params.push(endDate);
    conds.push(`t.close_ts::date <= $${params.length}::date`);
  }
  const where = conds.join(" AND ");

  try {
    const pool = getPostgresPool();
    const requestStarted = performance.now();

    const symbolsQ = () => pool.query(
      `SELECT DISTINCT o.symbol FROM ${BACKTEST_ORDERS} o
       JOIN ${BACKTEST_TARGETS} t ON t.order_id=o.order_id AND t.pipeline=o.pipeline
       WHERE ${CLOSED_LEG} ORDER BY o.symbol`,
    );
    const strategiesQ = () => {
      if (!symbolAll) {
        return pool.query(
          `SELECT o.strategy_id, MIN(r.strategy_name) AS strategy_name, MIN(r.strategy_key) AS strategy_key,
                  COUNT(DISTINCT (o.pipeline, o.order_id))::int AS n,
                  ARRAY_AGG(DISTINCT t.target_no ORDER BY t.target_no) AS target_nos,
                  ARRAY_AGG(DISTINCT LOWER(o.market)) FILTER (WHERE o.market IS NOT NULL) AS markets
           FROM ${BACKTEST_ORDERS} o
           JOIN ${BACKTEST_TARGETS} t ON t.order_id=o.order_id AND t.pipeline=o.pipeline
           LEFT JOIN ict_strategy_reference r ON r.strategy_id = o.strategy_id
           WHERE ${CLOSED_LEG} AND UPPER(o.symbol)=ANY($1::text[])
           GROUP BY o.strategy_id ORDER BY n DESC`,
          [symbolList],
        );
      }
      return pool.query(
        `SELECT o.strategy_id, MIN(r.strategy_name) AS strategy_name, MIN(r.strategy_key) AS strategy_key,
                  COUNT(DISTINCT (o.pipeline, o.order_id))::int AS n,
                  ARRAY_AGG(DISTINCT t.target_no ORDER BY t.target_no) AS target_nos,
                  ARRAY_AGG(DISTINCT LOWER(o.market)) FILTER (WHERE o.market IS NOT NULL) AS markets
         FROM ${BACKTEST_ORDERS} o
          JOIN ${BACKTEST_TARGETS} t ON t.order_id=o.order_id AND t.pipeline=o.pipeline
         LEFT JOIN ict_strategy_reference r ON r.strategy_id = o.strategy_id
         WHERE ${CLOSED_LEG}
         GROUP BY o.strategy_id ORDER BY n DESC`,
      );
    };
    const yearsQ = () => {
      if (!symbolAll) {
        return pool.query(
          `SELECT DISTINCT EXTRACT(YEAR FROM o.run_date)::int AS y FROM ${BACKTEST_ORDERS} o
            JOIN ${BACKTEST_TARGETS} t ON t.order_id=o.order_id AND t.pipeline=o.pipeline
           WHERE ${CLOSED_LEG} AND UPPER(o.symbol)=ANY($1::text[]) ORDER BY y DESC`,
          [symbolList],
        );
      }
      return pool.query(
        `SELECT DISTINCT EXTRACT(YEAR FROM o.run_date)::int AS y FROM ${BACKTEST_ORDERS} o
         JOIN ${BACKTEST_TARGETS} t ON t.order_id=o.order_id AND t.pipeline=o.pipeline
         WHERE ${CLOSED_LEG} ORDER BY y DESC`,
      );
    };

    if (filtersOnly) {
      const cacheKey = symbolAll ? "ALL" : JSON.stringify([...symbolList].sort());
      let cached = filterMetadataCache.get(cacheKey);
      if (!cached || cached.expiresAt <= Date.now()) {
        // Materialize the closed-leg population once instead of running three
        // full-history scans concurrently and consuming three pool slots.
        const value = pool.query<{ filters: FilterMetadata }>(`
          WITH closed AS MATERIALIZED (
            SELECT o.pipeline, o.order_id, o.symbol, o.strategy_id,
                   LOWER(o.market) AS market, EXTRACT(YEAR FROM o.run_date)::int AS y,
                   t.target_no
            FROM ${BACKTEST_ORDERS} o
            JOIN ${BACKTEST_TARGETS} t ON t.order_id=o.order_id AND t.pipeline=o.pipeline
            WHERE ${CLOSED_LEG}
          ), selected AS (
            SELECT * FROM closed WHERE $1::text[] IS NULL OR UPPER(symbol)=ANY($1::text[])
          ), strategies AS (
            SELECT o.strategy_id, MIN(r.strategy_name) AS strategy_name,
                   MIN(r.strategy_key) AS strategy_key,
                   COUNT(DISTINCT (o.pipeline, o.order_id))::int AS n,
                   ARRAY_AGG(DISTINCT o.target_no ORDER BY o.target_no) AS target_nos,
                   ARRAY_AGG(DISTINCT o.market ORDER BY o.market)
                     FILTER (WHERE o.market IS NOT NULL) AS markets
            FROM selected o
            LEFT JOIN ict_strategy_reference r ON r.strategy_id=o.strategy_id
            GROUP BY o.strategy_id
            UNION ALL
            SELECT 'S01-V3','S01 V3 — Daily HTF Bias (US backtest)','S01-V3',0,ARRAY[1,2,3],ARRAY['us']
            WHERE EXISTS(SELECT 1 FROM s01v3_runs r WHERE r.published AND r.status='complete')
              AND NOT EXISTS(SELECT 1 FROM selected WHERE strategy_id='S01-V3')
          )
          SELECT jsonb_build_object(
            'symbols', COALESCE((SELECT jsonb_agg(symbol ORDER BY symbol) FROM (SELECT DISTINCT symbol FROM closed) s), '[]'::jsonb),
            'strategies', COALESCE((SELECT jsonb_agg(s ORDER BY n DESC, strategy_id) FROM strategies s), '[]'::jsonb),
            'years', COALESCE((SELECT jsonb_agg(y::text ORDER BY y DESC) FROM (SELECT DISTINCT y FROM selected) s), '[]'::jsonb)
          ) AS filters
        `, [symbolAll ? null : symbolList]).then((result) => result.rows[0].filters);
        cached = { expiresAt: Number.POSITIVE_INFINITY, value };
        if (filterMetadataCache.size >= 32) filterMetadataCache.delete(filterMetadataCache.keys().next().value!);
        filterMetadataCache.set(cacheKey, cached);
        const entry = cached;
        void value.then(() => { entry.expiresAt = Date.now() + 60_000; }, () => {
          if (filterMetadataCache.get(cacheKey) === entry) filterMetadataCache.delete(cacheKey);
        });
      }
      const filters = await cached.value;
      return NextResponse.json({ success: true, source: "postgres", filters }, {
        headers: { "Server-Timing": `db;dur=${(performance.now() - requestStarted).toFixed(1)}` },
      });
    }

    // The historical rebuild can persist more than one signal hash for the
    // same logical trade.  The UI and Titania identify a trade by ticker,
    // strategy and entry datetime, so keep one canonical row for that identity:
    // prefer the corrected pipeline, then its most recently updated evidence.
    // The intraday time stop re-simulates the exit from 5-minute candles: a
    // position still open at the cutoff on its entry day is closed at that
    // bar's close instead of running to the engine's own stop/target. It runs
    // OUTSIDE the dedup so it touches ~10k rows, not the full pre-dedup union.
    // Symbols with no candle coverage keep their original outcome, so nothing
    // silently disappears from the population.
    const tz = "(CASE WHEN d.market = 'india' THEN 'Asia/Kolkata' ELSE 'America/New_York' END)";
    const tradeIdentity = `(CASE
      WHEN o.pipeline IN ('s16v2','s01v2','s01v3','scalpv2','scalpv4','bprv3') OR o.strategy_id IN ('IG_Goldhunter_ICT2022_R2','IG_Goldhunter_ICT2022_V3') THEN o.order_id
      WHEN UPPER(COALESCE(o.strategy_id,''))='S16'
       AND LOWER(COALESCE(o.market,''))='us'
       AND o.pipeline='updated'
      THEN o.order_id
      ELSE COALESCE(s.entry_datetime, o.filled_at)::text
    END)`;
    let tradesSelect = "SELECT * FROM (";
    let tradesTail = ") deduplicated_trades\n       ORDER BY close_ts ASC NULLS LAST, order_id";
    if (closeTime) {
      params.push(closeTime);
      const ctParam = `$${params.length}::time`;
      const eff = `GREATEST((((d.filled_at AT TIME ZONE ${tz})::date + ${ctParam}) AT TIME ZONE ${tz}), d.filled_at)`;
      const stopped = "(hit.hit_ts IS NOT NULL AND hit.hit_ts <= cut.eff)";
      tradesSelect = `SELECT d.order_id, d.market, d.symbol, d.strategy_id, d.direction, d.pipeline,
                d.entry_datetime, d.filled_at, d.entry_price, d.filled_price, d.stoploss, d.tp1, d.tp2, d.tp3,
                d.risk_probability, d.risk_bin, d.target_rr, d.target_rr_filled, d.target_price, d.close_reason,
                d.strategy_json, d.strategy_json_available, d.strategy_json_keys,
                CASE WHEN cut.eff IS NULL THEN d.close_ts
                     WHEN ${stopped} THEN hit.hit_ts ELSE COALESCE(cut.bar_ts, d.close_ts) END AS close_ts,
                CASE WHEN cut.eff IS NULL THEN d.close_price
                     WHEN ${stopped} THEN (CASE WHEN hit.kind='SL' THEN d.stoploss ELSE d.target_price END)
                     ELSE COALESCE(cut.bar_close, d.close_price) END AS close_price,
                CASE WHEN cut.eff IS NULL OR (NOT ${stopped} AND cut.bar_ts IS NULL) THEN d.state
                     WHEN ${stopped} THEN (CASE WHEN hit.kind='SL' THEN 'CLOSED_SL' ELSE 'CLOSED_TP' END)
                     ELSE 'CLOSED_TIME_STOP' END AS state,
                CASE WHEN cut.eff IS NULL OR (NOT ${stopped} AND cut.bar_ts IS NULL) THEN d.realized_r
                     WHEN ${stopped} THEN (CASE WHEN hit.kind='SL' THEN -1.0 ELSE COALESCE(d.target_rr_filled, d.target_rr, 0) END)
                     ELSE (CASE WHEN UPPER(d.direction)='SELL' THEN d.entry_price - cut.bar_close
                                ELSE cut.bar_close - d.entry_price END)
                          / NULLIF(ABS(d.entry_price - d.stoploss), 0) END AS realized_r
         FROM (`;
      tradesTail = `) d
         LEFT JOIN LATERAL (SELECT ${eff} AS eff) cut_t ON TRUE
         LEFT JOIN LATERAL (
           SELECT c.candle_ts AS hit_ts,
                  CASE WHEN (UPPER(d.direction)='BUY'  AND c.low_price  <= d.stoploss)
                         OR (UPPER(d.direction)='SELL' AND c.high_price >= d.stoploss)
                       THEN 'SL' ELSE 'TP' END AS kind
           FROM historical_candles_5m c
           WHERE c.yahoo_symbol = d.symbol AND c.candle_ts >= d.filled_at
             AND c.candle_ts < d.filled_at + interval '60 days'
             AND ( (UPPER(d.direction)='BUY'  AND (c.low_price  <= d.stoploss OR c.high_price >= d.target_price))
                OR (UPPER(d.direction)='SELL' AND (c.high_price >= d.stoploss OR c.low_price  <= d.target_price)) )
           ORDER BY c.candle_ts LIMIT 1) hit ON TRUE
         LEFT JOIN LATERAL (
           SELECT cut_t.eff, c2.candle_ts AS bar_ts, c2.close_price AS bar_close
           FROM historical_candles_5m c2
           WHERE c2.yahoo_symbol = d.symbol AND c2.candle_ts >= d.filled_at AND c2.candle_ts <= cut_t.eff
             AND (c2.candle_ts AT TIME ZONE ${tz})::date = (d.filled_at AT TIME ZONE ${tz})::date
           ORDER BY c2.candle_ts DESC LIMIT 1) cut ON TRUE
       ORDER BY close_ts ASC NULLS LAST, d.order_id`;
    }
    const tradesQ = pool.query(
      `${tradesSelect}
         SELECT DISTINCT ON (
                  UPPER(o.symbol),
                  UPPER(COALESCE(o.strategy_id, '')),
                  ${tradeIdentity}
                )
                o.order_id, o.market, o.symbol, o.strategy_id, o.direction, o.pipeline,
                COALESCE(s.entry_datetime, o.filled_at) AS entry_datetime, o.filled_at,
                o.entry_price, o.filled_price, o.stoploss, o.tp1, o.tp2, o.tp3, o.risk_probability, o.risk_bin,
                t.close_ts, t.close_price, t.target_rr, t.target_rr_filled, t.target_price, t.state, t.close_reason,
                -- The IGS forex series exits a stopped leg at the CLOSE of the bar
                -- that broke the stop, and lets an unresolved leg run to an 8h
                -- horizon. Neither is worth -1R: measured on IGS01V2, stopped legs
                -- average -1.10R and the ten expired TP3 legs average +2.52R.
                -- Falling back to the -1R default understated TP3 by ~32R and made
                -- TP2 look like the best target. Derive the real figure from the
                -- prices we already have. Gated to IGS so no other strategy's
                -- historical accounting shifts under this edit.
                COALESCE(
                  t.realized_r,
                  CASE WHEN UPPER(COALESCE(o.strategy_id, '')) LIKE 'IGS%'
                        AND o.filled_price IS NOT NULL AND o.stoploss IS NOT NULL
                        AND t.close_price IS NOT NULL
                        AND ABS(o.filled_price - o.stoploss) > 0
                       THEN (CASE WHEN UPPER(o.direction) = 'SELL'
                                  THEN o.filled_price - t.close_price
                                  ELSE t.close_price - o.filled_price END)
                            / ABS(o.filled_price - o.stoploss)
                  END
                ) AS realized_r,
                s.strategy_json,
                (s.strategy_json IS NOT NULL) AS strategy_json_available,
                CASE WHEN jsonb_typeof(s.strategy_json) = 'object' THEN
                  ARRAY(SELECT jsonb_object_keys(s.strategy_json) ORDER BY 1)
                ELSE ARRAY[]::text[] END AS strategy_json_keys
         FROM ${BACKTEST_ORDERS} o
         JOIN ${BACKTEST_TARGETS} t ON t.order_id=o.order_id AND t.pipeline=o.pipeline
         LEFT JOIN ${BACKTEST_SIGNALS} s ON s.signal_hash=o.signal_id AND s.pipeline=o.pipeline
         WHERE ${where}
         ORDER BY UPPER(o.symbol), UPPER(COALESCE(o.strategy_id, '')),
                  ${tradeIdentity},
                  CASE WHEN o.pipeline='updated' THEN 0 ELSE 1 END,
                  s.signal_updated_timestamp DESC NULLS LAST,
                  o.order_updated_at DESC NULLS LAST,
                  o.order_id
       ${tradesTail}`,
      params,
    );
    // Keep the display-name lookup out of the execution join.  Joining this
    // small reference table here can make PostgreSQL reverse the primary join
    // and repeatedly scan the large original target-outcomes table.
    const strategyNamesQ = pool.query(
      "SELECT strategy_id, strategy_name FROM ict_strategy_reference WHERE strategy_id IS NOT NULL",
    );
    // The profile panel describes ONE engine, so it only renders when a single
    // strategy is selected.
    const soleStrategy = strategyList.length === 1 ? strategyList[0] : null;
    const strategyProfileQ = soleStrategy === "TS01-TB-V2"
      ? pool.query(
          `WITH s AS (
             SELECT * FROM historical_ict_ts01v2_sessions WHERE engine_version=$1
           ), o AS (
             SELECT * FROM historical_ict_ts01v2_orders WHERE engine_version=$1
           )
           SELECT 'TS01-TB-V2'::text AS strategy_id,
                  'ICT 2022 Mentorship V2'::text AS strategy_name,
                  $1::text AS engine_version,
                  'both_directions_one_per_direction'::text AS cohort,
                  (SELECT COUNT(*)::int FROM s) AS sessions,
                  (SELECT COUNT(*)::int FROM o) AS attempts,
                  (SELECT COUNT(*) FILTER (WHERE state='FILLED')::int FROM o) AS fills,
                  (SELECT COUNT(*) FILTER (WHERE status LIKE 'NO\\_%')::int FROM s) AS excluded_sessions,
                  (SELECT MIN(session_date) FROM s) AS first_session,
                  (SELECT MAX(session_date) FROM s) AS last_session,
                  (SELECT COUNT(*) FILTER (WHERE realized_r IS NOT NULL)::int FROM o) AS fully_resolved_fills,
                  (SELECT COUNT(*) FILTER (WHERE state='FILLED' AND realized_r IS NULL)::int FROM o) AS unresolved_fills,
                  0::int AS unresolved_legs,
                  (SELECT ROUND(SUM(realized_r)::numeric,4) FROM o) AS fully_resolved_net_r,
                  (SELECT ROUND(SUM(realized_r)::numeric,4) FROM o) AS closed_leg_net_r`,
          [TS01V2_ENGINE],
        )
      : soleStrategy === "TS01-TB"
      ? pool.query(
          `WITH daily AS (
             SELECT * FROM historical_ict_ts01_daily_validation_updated
             WHERE engine_version='ts01_tb_r2.2026-08-18' AND cohort='primary'
           ), per_order AS (
             SELECT order_key,
                    COUNT(*) FILTER (WHERE realized_r IS NULL)::int AS unresolved_legs,
                    SUM(COALESCE(realized_r, 0) / 3.0) AS closed_leg_r
             FROM historical_ict_ts01_target_outcomes_updated
             WHERE engine_version='ts01_tb_r2.2026-08-18' AND cohort='primary'
             GROUP BY order_key
           )
           SELECT 'TS01-TB'::text AS strategy_id,
                  'ICT 2022 Mentorship'::text AS strategy_name,
                  'ts01_tb_r2.2026-08-18'::text AS engine_version,
                  'primary'::text AS cohort,
                  COUNT(*)::int AS sessions,
                  COUNT(*) FILTER (WHERE attempted)::int AS attempts,
                  COUNT(*) FILTER (WHERE filled)::int AS fills,
                  COUNT(*) FILTER (WHERE status='EXCLUDED_DATA_QUALITY')::int AS excluded_sessions,
                  MIN(session_date) AS first_session,
                  MAX(session_date) AS last_session,
                  (SELECT COUNT(*) FILTER (WHERE unresolved_legs=0)::int FROM per_order) AS fully_resolved_fills,
                  (SELECT COUNT(*) FILTER (WHERE unresolved_legs>0)::int FROM per_order) AS unresolved_fills,
                  (SELECT COALESCE(SUM(unresolved_legs),0)::int FROM per_order) AS unresolved_legs,
                  (SELECT ROUND(SUM(closed_leg_r)::numeric,4) FROM per_order WHERE unresolved_legs=0) AS fully_resolved_net_r,
                  (SELECT ROUND(SUM(closed_leg_r)::numeric,4) FROM per_order) AS closed_leg_net_r
           FROM daily`,
        )
      : Promise.resolve({ rows: [] as never[] });
    const populationSnapshotQ = canonicalS16
      ? pool.query(`
          SELECT metric_version AS "metricVersion",
                 identity_name AS "identityName",
                 identity_definition AS "identityDefinition",
                 calculated_at AS "calculatedAt",
                 source_row_count AS "sourceRowCount",
                 unique_setups AS "uniqueSetups",
                 fully_resolved AS "fullyResolved",
                 missed_entries AS "missedEntries",
                 open_orders AS "openOrders",
                 status,
                 source_hash AS "sourceHash"
          FROM research_strategy_metric_snapshots
          WHERE strategy_id='S16' AND market='us'
          ORDER BY calculated_at DESC
          LIMIT 1
        `)
      : Promise.resolve({ rows: [] as never[] });

    const emptyRows = { rows: [] as never[] };
    const [symbols, strategies, years, tradesRes, strategyNamesRes, strategyProfileRes, populationSnapshotRes] = await Promise.all([
      includeFilters ? symbolsQ() : Promise.resolve(emptyRows),
      includeFilters ? strategiesQ() : Promise.resolve(emptyRows),
      includeFilters ? yearsQ() : Promise.resolve(emptyRows),
      tradesQ,
      strategyNamesQ,
      strategyProfileQ,
      populationSnapshotQ,
    ]);
    const databaseMs = performance.now() - requestStarted;
    const strategyNames = new Map(
      strategyNamesRes.rows.map((row: { strategy_id: string; strategy_name: string | null }) => [row.strategy_id, row.strategy_name]),
    );

    const unfilteredTrades: Trade[] = (tradesRes.rows as RawTrade[]).map((row) => {
      // Pipelines that record the actual realised R (V2) are believed over the
      // planned target RR. Everything else keeps the original rr / -1 behaviour.
      const explicitR = num(row.realized_r);
      const isWin = explicitR !== null ? explicitR > 0 : row.state === "CLOSED_TP";
      const isCanonicalS16 = row.strategy_id?.toUpperCase() === "S16"
        && row.market?.toLowerCase() === "us"
        && row.pipeline === "updated";
      const rr = isCanonicalS16 ? num(row.target_rr_filled) ?? num(row.target_rr) : num(row.target_rr);
      const filledAt = row.filled_at ? new Date(row.filled_at).getTime() : null;
      const closeTs = row.close_ts ? new Date(row.close_ts).getTime() : null;
      const holdMin = filledAt && closeTs ? Math.round((closeTs - filledAt) / 60000) : null;
      const baseTrade: Trade = {
        order_id: row.order_id,
        market: row.market,
        symbol: row.symbol,
        strategy_id: row.strategy_id,
        strategy_name: row.strategy_id ? strategyNames.get(row.strategy_id) ?? BUILTIN_STRATEGY_NAMES.get(row.strategy_id) ?? null : null,
        pipeline: row.pipeline ?? null,
        direction: row.direction,
        entry_datetime: row.entry_datetime,
        filled_at: row.filled_at,
        close_ts: row.close_ts,
        entry: num(row.entry_price),
        filled: num(row.filled_price),
        stop: num(row.stoploss),
        tp1: num(row.tp1),
        tp2: num(row.tp2),
        tp3: num(row.tp3),
        close_price: num(row.close_price),
        r: explicitR !== null ? explicitR : isWin ? (rr === null ? 0 : rr) : -1,
        move_pct: movePct(row.direction, num(row.filled_price), num(row.close_price)),
        planned_move_pct: movePct(row.direction, num(row.filled_price) ?? num(row.entry_price), num(row.target_price) ?? num(row.tp1)),
        planned_risk_pct: riskPct(num(row.filled_price) ?? num(row.entry_price), num(row.stoploss)),
        target_price: num(row.target_price) ?? num(row.tp1),
        target_ratio: targetRatio(row.direction, num(row.filled_price) ?? num(row.entry_price), num(row.stoploss), num(row.target_price) ?? num(row.tp1)),
        exit_type: exitType(row.state, row.close_reason),
        quantity: null,
        risk_usd: null,
        gross_pnl_usd: null,
        transaction_cost_usd: null,
        pnl_usd: null,
        outcome: isWin ? "WIN" : "LOSS",
        hold_min: holdMin,
        risk_probability: num(row.risk_probability),
        risk_bin: num(row.risk_bin),
        strategy_json: row.strategy_json,
        strategy_json_available: row.strategy_json_available,
        strategy_json_keys: row.strategy_json_keys ?? [],
        ict_sessions: getIctSessionIds(row.filled_at ?? row.entry_datetime, row.market, row.symbol),
      };
      return applySizing(baseTrade, sizing);
    });
    const selectedIctSessionSet = selectedIctSessions === null ? null : new Set(selectedIctSessions);
    const sessionTrades = selectedIctSessionSet === null
      ? unfilteredTrades
      : unfilteredTrades.filter((trade) => passesIctSessionFilter(trade.ict_sessions, selectedIctSessionSet));
    // Target R:R: keep trades whose planned ratio for the selected target is
    // strictly inside (rr_min, rr_max). Trades without a ratio drop out once
    // any bound is set.
    const rrTrades = rrMin === null && rrMax === null
      ? sessionTrades
      : sessionTrades.filter((trade) => trade.target_ratio !== null
        && (rrMin === null || trade.target_ratio > rrMin)
        && (rrMax === null || trade.target_ratio < rrMax));
    const moveTrades = moveMin === null && moveMax === null
      ? rrTrades
      : rrTrades.filter((trade) => trade.move_pct !== null
        && (moveMin === null || trade.move_pct > moveMin)
        && (moveMax === null || trade.move_pct < moveMax));
    // Planned Move %: signed % from fill to the selected target (strict bounds).
    const plannedTrades = plannedMin === null && plannedMax === null
      ? moveTrades
      : moveTrades.filter((trade) => trade.planned_move_pct !== null
        && (plannedMin === null || trade.planned_move_pct > plannedMin)
        && (plannedMax === null || trade.planned_move_pct < plannedMax));
    // Planned Risk %: |fill - stop| / fill in percent (strict bounds).
    const preSmtTrades = riskMin === null && riskMax === null
      ? plannedTrades
      : plannedTrades.filter((trade) => trade.planned_risk_pct !== null
        && (riskMin === null || trade.planned_risk_pct > riskMin)
        && (riskMax === null || trade.planned_risk_pct < riskMax));

    // SMT divergence at signal time: cached per order; the newest uncached
    // trades are computed a batch per request (the rest show as Pending).
    const smtKey = (trade: Trade) => `backtest:${trade.order_id}`;
    let smtResults = new Map<string, SmtResult>();
    if (preSmtTrades.length <= 30000) {
      try {
        const newestFirst = [...preSmtTrades].sort((a, b) => String(b.entry_datetime ?? "").localeCompare(String(a.entry_datetime ?? "")));
        smtResults = await smtForTrades(pool, newestFirst.map((trade) => ({
          key: smtKey(trade), symbol: trade.symbol, market: trade.market,
          signalTs: trade.entry_datetime ?? trade.filled_at, direction: trade.direction,
        })), Math.min(1000, Math.max(0, Number(sp.get("smt_batch") || 60) || 60)));
      } catch {
        /* SMT is advisory; the backtest itself never depends on it */
      }
    }
    for (const trade of preSmtTrades) {
      const smt = smtResults.get(smtKey(trade));
      trade.smt_status = smt?.status ?? null;
      trade.smt_aligned = smt?.aligned ?? null;
      trade.smt_peer = smt?.peer_label ?? null;
      trade.smt_group = smtGroup(smt);
    }
    // ICT weekly profile at signal time (same caching pattern as SMT).
    let wpResults = new Map<string, WeeklyProfileResult>();
    if (preSmtTrades.length <= 30000) {
      try {
        const newestFirst = [...preSmtTrades].sort((a, b) => String(b.entry_datetime ?? "").localeCompare(String(a.entry_datetime ?? "")));
        wpResults = await weeklyProfilesForTrades(pool, newestFirst.map((trade) => ({
          key: smtKey(trade), symbol: trade.symbol, market: trade.market,
          signalTs: trade.entry_datetime ?? trade.filled_at, direction: trade.direction,
        })), Math.min(1000, Math.max(0, Number(sp.get("wp_batch") || 60) || 60)));
      } catch {
        /* weekly profile is advisory; the backtest itself never depends on it */
      }
    }
    for (const trade of preSmtTrades) {
      const wp = wpResults.get(smtKey(trade));
      trade.wp_live = wp ? PROFILE_LABELS[wp.live.profile] : null;
      trade.wp_live_aligned = wp?.live.aligned ?? null;
      trade.wp_hindsight = wp?.hindsight ? PROFILE_LABELS[wp.hindsight.profile] : null;
      trade.wp_hindsight_aligned = wp?.hindsight?.aligned ?? null;
      trade.wp_day = wp?.signal_day ?? null;
      trade.wp_group = weeklyLiveGroup(wp);
      trade.wp_hindsight_group = weeklyHindsightGroup(wp);
    }
    const trades = preSmtTrades.filter((trade) => passesSmtFilter(smtResults.get(smtKey(trade)), smtFilter)
      && passesWeeklyFilter(wpResults.get(smtKey(trade)), weeklyFilter));
    const smtCoverage = { computed: preSmtTrades.filter((trade) => smtResults.has(smtKey(trade))).length, total: preSmtTrades.length };
    const weeklyCoverage = { computed: preSmtTrades.filter((trade) => wpResults.has(smtKey(trade))).length, total: preSmtTrades.length };

    const sortedTrades = [...trades].sort((a, b) => {
      const aValue = a[tradeSort];
      const bValue = b[tradeSort];
      if (!aValue) return bValue ? 1 : a.order_id.localeCompare(b.order_id);
      if (!bValue) return -1;
      const difference = new Date(aValue).getTime() - new Date(bValue).getTime();
      return (tradeOrder === "asc" ? difference : -difference) || a.order_id.localeCompare(b.order_id);
    });
    if (csvExport) {
      const filename = `backtest-trades-${new Date().toISOString().slice(0, 10)}.csv`;
      return csvDownloadResponse(backtestCsv(sortedTrades, sp.get("columns")), filename, sortedTrades.length);
    }

    const summary = computeMetrics(trades, sizing);
    const equity = downsampleEquity(buildEquity(trades, sizing.initialCapital));
    const monthly = buildMonthly(trades);
    const breakdown = buildStrategyBreakdown(trades, sizing.initialCapital);
    const tickerDistribution = buildTickerDistribution(trades);
    const research = buildResearch(trades, sizing, oosPct, selectedIctSessions);
    const computationMs = performance.now() - requestStarted - databaseMs;

    // Sort the COMPLETE filtered population before applying the payload cap.
    // Sorting only the latest slice makes ascending dates appear to start in a
    // recent year even when much older trades exist.
    const MAX_ROWS = 1500;
    const tradesOut = sortedTrades.slice(0, MAX_ROWS).map((trade) => {
      const payloadTrade = { ...trade };
      delete payloadTrade.strategy_json;
      return payloadTrade;
    });

    return NextResponse.json({
      success: true,
      source: "postgres",
      params: {
        symbol,
        strategy,
        direction,
        build,
        close_time: closeTime ?? "NONE",
        target_no,
        year,
        start_date: startDate,
        end_date: endDate,
        trade_sort: tradeSort,
        trade_order: tradeOrder,
        ict_sessions: selectedIctSessions === null ? "ALL" : selectedIctSessions.length ? selectedIctSessions.join(",") : "NONE",
        sizing_mode: sizing.mode,
        initial_capital: sizing.initialCapital,
        risk_usd: sizing.riskUsd,
        quantity: sizing.quantity,
        commission_bps: sizing.commissionBps,
        slippage_bps: sizing.slippageBps,
        oos_pct: oosPct,
        rr_min: rrMin,
        rr_max: rrMax,
      },
      filters: includeFilters ? {
        symbols: symbols.rows.map((r: { symbol: string }) => r.symbol),
        strategies: strategies.rows,
        years: years.rows.map((r: { y: number }) => String(r.y)),
      } : undefined,
      summary,
      equity,
      monthly,
      strategy_breakdown: breakdown,
      ticker_distribution: tickerDistribution,
      strategy_profile: strategyProfileRes.rows[0] ?? undefined,
      population_snapshot: populationSnapshotRes.rows[0] ?? undefined,
      research,
      trades: tradesOut,
      smt_coverage: smtCoverage,
      weekly_profile_coverage: weeklyCoverage,
      total_trades: trades.length,
      returned: tradesOut.length,
    }, {
      headers: {
        "Server-Timing": `db;dur=${databaseMs.toFixed(1)}, compute;dur=${computationMs.toFixed(1)}`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Postgres error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

function round(n: number, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

// Math.min/Math.max with a spread argument passes one stack slot per element, so
// it throws "Maximum call stack size exceeded" once the population passes roughly
// 100k trades (an "ALL strategies" run is ~500k). Fold instead of spreading.
function minOf(values: readonly number[], fallback = 0): number {
  let best = Infinity;
  for (const value of values) if (Number.isFinite(value) && value < best) best = value;
  return best === Infinity ? fallback : best;
}

function maxOf(values: readonly number[], fallback = 0): number {
  let best = -Infinity;
  for (const value of values) if (Number.isFinite(value) && value > best) best = value;
  return best === -Infinity ? fallback : best;
}

// One equity point per trade is fine for a single strategy and ruinous for an
// "ALL" run: it ships a ~500k-point array and the chart draws an SVG rect per
// point. Bucket the series down, keeping each bucket's deepest drawdown and its
// closing point so both the equity line and the drawdown extremes survive.
const EQUITY_MAX_POINTS = 2000;

function downsampleEquity<T extends { dd: number }>(points: T[], maxPoints = EQUITY_MAX_POINTS): T[] {
  if (points.length <= maxPoints) return points;
  const bucketSize = Math.ceil(points.length / Math.floor(maxPoints / 2));
  const out: T[] = [];
  for (let start = 0; start < points.length; start += bucketSize) {
    const end = Math.min(start + bucketSize, points.length);
    let deepest = start;
    for (let i = start + 1; i < end; i += 1) if (points[i].dd < points[deepest].dd) deepest = i;
    const last = end - 1;
    if (deepest !== last) out.push(points[deepest]);
    out.push(points[last]);
  }
  return out;
}

/** Signed % price move from fill to exit; + means the move went the trade's way. */
function riskPct(filled: number | null, stop: number | null): number | null {
  if (filled === null || stop === null || filled === 0) return null;
  return Math.round((Math.abs(filled - stop) / filled) * 100 * 10000) / 10000;
}

function movePct(direction: string | null, filled: number | null, close: number | null): number | null {
  if (filled === null || close === null || filled === 0) return null;
  const side = (direction || "").toUpperCase() === "SELL" ? -1 : 1;
  return Math.round(((close - filled) / filled) * side * 100 * 10000) / 10000;
}

/**
 * Planned ratio for the selected target, using the fill as entry.
 *   BUY : (target - entry) / (entry - stop)
 *   SELL: (entry - target) / (stop - entry)
 * Rounded to 2 dp; null when the stop distance is zero or a price is missing.
 */
function targetRatio(direction: string | null, entry: number | null, stop: number | null, target: number | null): number | null {
  if (entry === null || stop === null || target === null) return null;
  const sell = (direction || "").toUpperCase() === "SELL";
  const reward = sell ? entry - target : target - entry;
  const risk = sell ? stop - entry : entry - stop;
  if (!Number.isFinite(risk) || risk === 0) return null;
  return Math.round((reward / risk) * 100) / 100;
}

function exitType(state: string | null, reason: string | null): "TP" | "SL" | "TIME" | "OTHER" {
  const st = (state || "").toUpperCase();
  const rs = (reason || "").toLowerCase();
  // State first: a close-time flatten rewrites state to CLOSED_TIME_STOP but
  // keeps the original close_reason, so the reason alone would mislabel it.
  if (st.includes("TIME") || st.includes("EXPIRED")) return "TIME";
  if (st === "CLOSED_SL") return "SL";
  if (st === "CLOSED_TP") return "TP";
  if (rs.includes("time") || rs.includes("expir") || rs.includes("eod") || rs.includes("flatten")) return "TIME";
  if (rs.includes("stop")) return "SL";
  if (rs.includes("target") || rs.includes("tp")) return "TP";
  return "OTHER";
}

function signedPricePnl(trade: Pick<Trade, "direction" | "filled" | "close_price">, quantity: number) {
  if (trade.filled === null || trade.close_price === null) return null;
  const side = (trade.direction || "").toUpperCase() === "SELL" ? -1 : 1;
  return (trade.close_price - trade.filled) * side * quantity;
}

function applySizing(trade: Trade, sizing: SizingSettings): Trade {
  const isGoldhunterV2 = ["IG_Goldhunter_ICT2022_R2", "IG_Goldhunter_ICT2022_V3"].includes(trade.strategy_id ?? "");
  const baselineCost = isGoldhunterV2 ? 0.02 : 0;
  const stopDistance = trade.filled !== null && trade.stop !== null ? Math.abs(trade.filled - trade.stop) + baselineCost : null;
  const quantity = sizing.mode === "fixed_qty" ? sizing.quantity : stopDistance && stopDistance > 0 ? sizing.riskUsd / stopDistance : null;
  const riskUsd = sizing.mode === "fixed_qty" && stopDistance && stopDistance > 0 ? stopDistance * sizing.quantity : sizing.riskUsd;
  const pricePnl = quantity !== null ? signedPricePnl(trade, quantity) : null;
  const grossPnlUsd = sizing.mode === "fixed_qty" && pricePnl !== null ? pricePnl - baselineCost * (quantity ?? 0) : trade.r * riskUsd;
  const entryNotional = quantity !== null && trade.filled !== null ? Math.abs(quantity * trade.filled) : 0;
  const exitNotional = quantity !== null && trade.close_price !== null ? Math.abs(quantity * trade.close_price) : entryNotional;
  const transactionCostUsd = (entryNotional + exitNotional) * (sizing.commissionBps + sizing.slippageBps) / 10000;
  const pnlUsd = grossPnlUsd - transactionCostUsd;
  const realizedR = riskUsd > 0 ? pnlUsd / riskUsd : trade.r;

  return {
    ...trade,
    r: isGoldhunterV2 ? realizedR : round(realizedR),
    quantity: quantity === null ? null : round(quantity, 4),
    risk_usd: round(riskUsd),
    gross_pnl_usd: round(grossPnlUsd),
    transaction_cost_usd: round(transactionCostUsd),
    pnl_usd: round(pnlUsd),
  };
}

function computeMetrics(trades: Trade[], sizing: SizingSettings) {
  const n = trades.length;
  if (n === 0) {
    return { total: 0, sizing };
  }
  const rs = trades.map((t) => t.r);
  const pnls = trades.map((t) => t.pnl_usd ?? 0);
  const grossPnls = trades.map((t) => t.gross_pnl_usd ?? 0);
  const transactionCosts = trades.map((t) => t.transaction_cost_usd ?? 0);
  const wins = trades.filter((t) => (t.pnl_usd ?? 0) > 0);
  const losses = trades.filter((t) => (t.pnl_usd ?? 0) < 0);
  const grossProfit = wins.reduce((a, t) => a + t.r, 0);
  const grossLoss = losses.reduce((a, t) => a + t.r, 0); // negative
  const netR = grossProfit + grossLoss;
  const grossProfitUsd = wins.reduce((a, t) => a + (t.pnl_usd ?? 0), 0);
  const grossLossUsd = losses.reduce((a, t) => a + (t.pnl_usd ?? 0), 0);
  const netUsd = pnls.reduce((a, b) => a + b, 0);
  const mean = netR / n;
  const variance = rs.reduce((a, r) => a + (r - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const downside = losses.map((t) => t.r);
  const downsideVariance = downside.length
    ? downside.reduce((a, r) => a + Math.min(0, r - 0) ** 2, 0) / downside.length
    : 0;
  const downsideStd = Math.sqrt(downsideVariance);

  let cum = 0;
  let cumUsd = 0;
  let peak = 0;
  let peakUsd = 0;
  let maxDD = 0;
  let maxDDUsd = 0;
  let ddSquared = 0;
  for (let i = 0; i < rs.length; i += 1) {
    const r = rs[i];
    cum += r;
    if (cum > peak) peak = cum;
    const dd = cum - peak;
    if (dd < maxDD) maxDD = dd;
    ddSquared += dd ** 2;

    cumUsd += pnls[i];
    if (cumUsd > peakUsd) peakUsd = cumUsd;
    const ddUsd = cumUsd - peakUsd;
    if (ddUsd < maxDDUsd) maxDDUsd = ddUsd;
  }

  // Consecutive streaks
  let curW = 0;
  let curL = 0;
  let maxW = 0;
  let maxL = 0;
  for (const r of rs) {
    if (r > 0) {
      curW += 1;
      curL = 0;
      if (curW > maxW) maxW = curW;
    } else {
      curL += 1;
      curW = 0;
      if (curL > maxL) maxL = curL;
    }
  }

  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const holds = trades.map((t) => t.hold_min).filter((v): v is number => v !== null);
  const avgHold = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null;
  const sortedR = [...rs].sort((a, b) => a - b);
  const sortedUsd = [...pnls].sort((a, b) => a - b);
  const varR = sortedR[Math.max(0, Math.floor(sortedR.length * 0.05) - 1)] ?? 0;
  const varUsd = sortedUsd[Math.max(0, Math.floor(sortedUsd.length * 0.05) - 1)] ?? 0;
  const first = trades.find((t) => t.close_ts)?.close_ts;
  const last = [...trades].reverse().find((t) => t.close_ts)?.close_ts;
  const firstMs = first ? new Date(first).getTime() : null;
  const lastMs = last ? new Date(last).getTime() : null;
  const years =
    firstMs !== null && lastMs !== null && lastMs > firstMs
      ? Math.max((lastMs - firstMs) / (365.25 * 24 * 60 * 60 * 1000), 1 / 365)
      : 1;
  const initialCapital = sizing.initialCapital;
  const endingCapital = initialCapital + netUsd;
  const netProfitPct = (netUsd / initialCapital) * 100;
  const cagr = endingCapital > 0 ? ((endingCapital / initialCapital) ** (1 / years) - 1) * 100 : null;
  const annualReturn = netProfitPct / years;
  const maxDdPct = (maxDDUsd / initialCapital) * 100;
  const exposureMinutes = holds.reduce((a, b) => a + b, 0);
  const periodMinutes =
    firstMs !== null && lastMs !== null && lastMs > firstMs ? (lastMs - firstMs) / 60000 : exposureMinutes || 1;
  const exposurePct = Math.min(100, (exposureMinutes / periodMinutes) * 100);
  const ulcerIndex = Math.sqrt(ddSquared / n);
  const longTrades = trades.filter((t) => (t.direction || "").toUpperCase() === "BUY");
  const shortTrades = trades.filter((t) => (t.direction || "").toUpperCase() === "SELL");
  const quantities = trades.map((t) => t.quantity).filter((v): v is number => v !== null);
  const risks = trades.map((t) => t.risk_usd).filter((v): v is number => v !== null);

  // Edge / survival metrics: break-even win rate, Kelly and risk of ruin all
  // derive from the win rate and payoff ratio this population already produced.
  const avgRiskUsd = risks.length ? risks.reduce((a, b) => a + b, 0) / risks.length : sizing.riskUsd;
  const edgeMetrics = computeEdgeMetrics({
    winRatePct: (wins.length / n) * 100,
    avgWinR: avgWin,
    avgLossR: avgLoss,
    riskPerTradeUsd: avgRiskUsd,
    initialCapitalUsd: initialCapital,
    rMultiples: rs,
  });

  return {
    sizing: {
      mode: sizing.mode,
      initial_capital: round(initialCapital),
      risk_usd: round(sizing.riskUsd),
      quantity: round(sizing.quantity, 4),
      commission_bps: round(sizing.commissionBps),
      slippage_bps: round(sizing.slippageBps),
    },
    initial_capital: round(initialCapital),
    ending_capital: round(endingCapital),
    net_profit_pct: round(netProfitPct),
    exposure_pct: round(exposurePct),
    cagr: cagr === null ? null : round(cagr),
    annual_return_pct: round(annualReturn),
    risk_adjusted_return_pct: std !== 0 ? round((mean / std) * 100) : null,
    total: n,
    wins: wins.length,
    losses: losses.length,
    long_trades: longTrades.length,
    short_trades: shortTrades.length,
    win_rate: round((wins.length / n) * 100, 1),
    net_r: round(netR),
    net_usd: round(netUsd),
    gross_pnl_before_costs_usd: round(grossPnls.reduce((a, b) => a + b, 0)),
    transaction_costs_usd: round(transactionCosts.reduce((a, b) => a + b, 0)),
    gross_profit_usd: round(grossProfitUsd),
    gross_loss_usd: round(grossLossUsd),
    gross_profit_r: round(grossProfit),
    gross_loss_r: round(grossLoss),
    profit_factor: grossLoss !== 0 ? round(grossProfit / Math.abs(grossLoss)) : null,
    expectancy_r: round(mean),
    expectancy_usd: round(netUsd / n),
    avg_win_r: round(avgWin),
    avg_loss_r: round(avgLoss),
    // payoff_ratio comes from edgeMetrics: same avg win / |avg loss|, one source.
    ...edgeMetrics,
    largest_win_r: round(maxOf(rs)),
    largest_loss_r: round(minOf(rs)),
    value_at_risk_r: round(varR),
    value_at_risk_usd: round(varUsd),
    best_win_usd: round(maxOf(pnls)),
    worst_loss_usd: round(minOf(pnls)),
    max_consec_wins: maxW,
    max_consec_losses: maxL,
    max_trade_drawdown_r: round(minOf(rs)),
    max_drawdown_r: round(maxDD),
    max_drawdown_usd: round(maxDDUsd),
    max_drawdown_pct: round(maxDdPct),
    recovery_factor: maxDD !== 0 ? round(netR / Math.abs(maxDD)) : null,
    sharpe: std !== 0 ? round(mean / std) : null,
    sortino: downsideStd !== 0 ? round(mean / downsideStd) : null,
    calmar: maxDdPct !== 0 && cagr !== null ? round(cagr / Math.abs(maxDdPct)) : null,
    car_maxdd: maxDD !== 0 && cagr !== null ? round(cagr / Math.abs(maxDdPct || maxDD)) : null,
    rar_maxdd: maxDD !== 0 && std !== 0 ? round((mean / std) / Math.abs(maxDD)) : null,
    ulcer_index: round(ulcerIndex),
    k_ratio: std !== 0 ? round((netR / n) / std) : null,
    avg_hold_min: avgHold === null ? null : Math.round(avgHold),
    risk_usd: round(risks.length ? risks.reduce((a, b) => a + b, 0) / risks.length : sizing.riskUsd),
    avg_quantity: quantities.length ? round(quantities.reduce((a, b) => a + b, 0) / quantities.length, 2) : null,
    min_quantity: quantities.length ? round(minOf(quantities), 2) : null,
    max_quantity: quantities.length ? round(maxOf(quantities), 2) : null,
    group_stats: {
      all: computeGroupStats(trades),
      long: computeGroupStats(longTrades),
      short: computeGroupStats(shortTrades),
    },
  };
}

function computeGroupStats(trades: Trade[]) {
  const n = trades.length;
  if (!n) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      win_rate: 0,
      net_r: 0,
      net_usd: 0,
      avg_r: 0,
      avg_win_r: 0,
      avg_loss_r: 0,
      largest_win_r: 0,
      largest_loss_r: 0,
      profit_factor: null,
      payoff_ratio: null,
      breakeven_win_rate_pct: null,
      win_rate_edge_pct: null,
      kelly_fraction_pct: null,
      half_kelly_fraction_pct: null,
      risk_of_ruin_pct: null,
      risk_of_ruin_simple_pct: null,
      risk_units: null,
    };
  }
  const rs = trades.map((t) => t.r);
  const wins = trades.filter((t) => t.r > 0);
  const losses = trades.filter((t) => t.r < 0);
  const net = rs.reduce((a, b) => a + b, 0);
  const netUsd = trades.reduce((a, t) => a + (t.pnl_usd ?? 0), 0);
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    win_rate: round((wins.length / n) * 100, 1),
    net_r: round(net),
    net_usd: round(netUsd),
    avg_r: round(net / n),
    avg_win_r: wins.length ? round(wins.reduce((a, t) => a + t.r, 0) / wins.length) : 0,
    avg_loss_r: losses.length ? round(losses.reduce((a, t) => a + t.r, 0) / losses.length) : 0,
    largest_win_r: round(maxOf(rs)),
    largest_loss_r: round(minOf(rs)),
    profit_factor: losses.length ? round(wins.reduce((a, t) => a + t.r, 0) / Math.abs(losses.reduce((a, t) => a + t.r, 0))) : null,
    ...computeEdgeMetrics({
      winRatePct: (wins.length / n) * 100,
      avgWinR: wins.length ? wins.reduce((a, t) => a + t.r, 0) / wins.length : 0,
      avgLossR: losses.length ? losses.reduce((a, t) => a + t.r, 0) / losses.length : 0,
      rMultiples: rs,
      fallbackRiskUnits: 100,
    }),
  };
}

function buildEquity(trades: Trade[], initialCapital: number) {
  let cum = 0;
  let cumUsd = 0;
  let peak = 0;
  return trades.map((t, i) => {
    cum += t.r;
    cumUsd += t.pnl_usd ?? 0;
    if (cum > peak) peak = cum;
    return {
      i,
      t: t.close_ts ? Math.floor(new Date(t.close_ts).getTime() / 1000) : i,
      r: round(cum),
      balance: round(initialCapital + cumUsd),
      dd: round(cum - peak),
    };
  });
}

function buildMonthly(trades: Trade[]) {
  const map = new Map<string, { net_r: number; trades: number; wins: number }>();
  for (const t of trades) {
    if (!t.close_ts) continue;
    const d = new Date(t.close_ts);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const m = map.get(key) || { net_r: 0, trades: 0, wins: 0 };
    m.net_r += t.r;
    m.trades += 1;
    if (t.r > 0) m.wins += 1;
    map.set(key, m);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({ month, net_r: round(v.net_r), trades: v.trades, wins: v.wins }));
}

function buildStrategyBreakdown(trades: Trade[], initialCapital: number) {
  const map = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = t.strategy_id || "—";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }
  return [...map.entries()]
    .map(([strategy_id, list]) => {
      const wins = list.filter((t) => t.r > 0);
      const losses = list.filter((t) => t.r < 0);
      const gp = wins.reduce((a, t) => a + t.r, 0);
      const gl = losses.reduce((a, t) => a + t.r, 0);
      const netR = gp + gl;
      const strategyRisks = list.map((t) => t.risk_usd).filter((v): v is number => v !== null);
      const edge = computeEdgeMetrics({
        winRatePct: (wins.length / list.length) * 100,
        avgWinR: wins.length ? gp / wins.length : 0,
        avgLossR: losses.length ? gl / losses.length : 0,
        riskPerTradeUsd: strategyRisks.length
          ? strategyRisks.reduce((a, b) => a + b, 0) / strategyRisks.length
          : null,
        initialCapitalUsd: initialCapital,
        rMultiples: list.map((t) => t.r),
        fallbackRiskUnits: 100,
      });
      return {
        strategy_id,
        trades: list.length,
        win_rate: round((wins.length / list.length) * 100, 1),
        net_r: round(netR),
        expectancy_r: round(netR / list.length),
        profit_factor: gl !== 0 ? round(gp / Math.abs(gl)) : null,
        ...edge,
      };
    })
    .sort((a, b) => b.net_r - a.net_r);
}

function buildTickerDistribution(trades: Trade[]) {
  const groups = new Map<string, { trades: number; wins: number; winR: number; pnlUsd: number }>();
  for (const trade of trades) {
    const ticker = trade.symbol || "Unknown";
    const group = groups.get(ticker) ?? { trades: 0, wins: 0, winR: 0, pnlUsd: 0 };
    group.trades += 1;
    if (trade.r > 0) {
      group.wins += 1;
      group.winR += trade.r;
    }
    group.pnlUsd += trade.pnl_usd ?? 0;
    groups.set(ticker, group);
  }
  return [...groups.entries()]
    .map(([ticker, group]) => ({
      ticker,
      trades: group.trades,
      percentage: trades.length ? round((group.trades / trades.length) * 100, 2) : 0,
      win_rate: group.trades ? round((group.wins / group.trades) * 100, 2) : 0,
      win_r: round(group.winR),
      pnl_usd: round(group.pnlUsd),
    }))
    .sort((a, b) => b.trades - a.trades || a.ticker.localeCompare(b.ticker));
}

function researchStats(trades: Trade[]) {
  const stats = computeGroupStats(trades);
  const pnls = trades.map((trade) => trade.pnl_usd ?? 0);
  const mean = pnls.length ? pnls.reduce((sum, value) => sum + value, 0) / pnls.length : 0;
  const variance = pnls.length
    ? pnls.reduce((sum, value) => sum + (value - mean) ** 2, 0) / pnls.length
    : 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdownUsd = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdownUsd = Math.min(maxDrawdownUsd, equity - peak);
  }
  return {
    ...stats,
    expectancy_usd: round(mean),
    trade_sharpe: variance > 0 ? round(mean / Math.sqrt(variance)) : null,
    max_drawdown_usd: round(maxDrawdownUsd),
  };
}

function attributionRows(trades: Trade[], keyFor: (trade: Trade) => string) {
  const groups = new Map<string, Trade[]>();
  for (const trade of trades) {
    const key = keyFor(trade);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(trade);
  }
  return [...groups.entries()]
    .map(([label, rows]) => ({ label, ...researchStats(rows) }))
    .sort((a, b) => b.net_usd - a.net_usd);
}

function ictSessionAttributionRows(trades: Trade[], selectedSessions: IctSessionId[] | null) {
  const allowed = new Set(selectedSessions ?? ICT_SESSION_DEFINITIONS.map((session) => session.id));
  const groups = new Map<IctSessionId, Trade[]>();
  const outside: Trade[] = [];
  for (const trade of trades) {
    const matching = trade.ict_sessions.filter((session) => allowed.has(session));
    if (!matching.length && selectedSessions === null) outside.push(trade);
    for (const session of matching) {
      const rows = groups.get(session) ?? [];
      rows.push(trade);
      groups.set(session, rows);
    }
  }
  const rows = ICT_SESSION_DEFINITIONS
    .filter((session) => allowed.has(session.id) && groups.has(session.id))
    .map((session) => ({ label: ictSessionDisplayLabel(session.id), ...researchStats(groups.get(session.id)!) }));
  if (outside.length) rows.push({ label: "Outside named ICT windows", ...researchStats(outside) });
  return rows;
}

const HOLD_TIME_BUCKETS = [
  { id: "under_15m", label: "Under 15m", min: 0, max: 15, early: true },
  { id: "15_30m", label: "15–30m", min: 15, max: 30, early: true },
  { id: "30_60m", label: "30–60m", min: 30, max: 60, early: true },
  { id: "1_2h", label: "1–2h", min: 60, max: 120, early: false },
  { id: "2_4h", label: "2–4h", min: 120, max: 240, early: false },
  { id: "4_8h", label: "4–8h", min: 240, max: 480, early: false },
  { id: "8_24h", label: "8–24h", min: 480, max: 1_440, early: false },
  { id: "1_3d", label: "1–3d", min: 1_440, max: 4_320, early: false },
  { id: "3_7d", label: "3–7d", min: 4_320, max: 10_080, early: false },
  { id: "over_7d", label: "7d+", min: 10_080, max: Infinity, early: false },
] as const;

function holdTimePerformanceRows(trades: Trade[]) {
  const totalLosses = trades.filter((trade) => trade.r < 0).length;
  const totalWithHold = trades.filter((trade) => trade.hold_min !== null && trade.hold_min >= 0).length;
  return HOLD_TIME_BUCKETS.map((bucket) => {
    const rows = trades.filter((trade) => trade.hold_min !== null && trade.hold_min >= bucket.min && trade.hold_min < bucket.max);
    const rowStats = researchStats(rows);
    const holds = rows.map((trade) => trade.hold_min).filter((value): value is number => value !== null).sort((a, b) => a - b);
    let equity = 0;
    let peak = 0;
    let maxDrawdownR = 0;
    for (const trade of rows) {
      equity += trade.r;
      peak = Math.max(peak, equity);
      maxDrawdownR = Math.min(maxDrawdownR, equity - peak);
    }
    return {
      bucket_id: bucket.id,
      label: bucket.label,
      early: bucket.early,
      min_minutes: bucket.min,
      max_minutes: Number.isFinite(bucket.max) ? bucket.max : null,
      avg_hold_min: holds.length ? Math.round(holds.reduce((sum, value) => sum + value, 0) / holds.length) : null,
      median_hold_min: holds.length ? Math.round(holds[Math.floor((holds.length - 1) / 2)]) : null,
      trade_share_pct: totalWithHold ? round(100 * rows.length / totalWithHold) : 0,
      loss_rate_pct: rows.length ? round(100 * rowStats.losses / rows.length) : null,
      loss_concentration_pct: totalLosses ? round(100 * rowStats.losses / totalLosses) : null,
      expectancy_r: rowStats.avg_r,
      max_drawdown_r: round(maxDrawdownR),
      ...rowStats,
    };
  }).filter((row) => row.trades > 0);
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
    return state / 4294967296;
  };
}

function monteCarlo(trades: Trade[], initialCapital: number) {
  const simulations = trades.length ? 500 : 0;
  const pnls = trades.map((trade) => trade.pnl_usd ?? 0);
  const random = createSeededRandom(16012026);
  const endingEquities: number[] = [];
  const maxDrawdowns: number[] = [];
  let losingPaths = 0;
  let drawdown20Paths = 0;

  for (let simulation = 0; simulation < simulations; simulation += 1) {
    let equity = initialCapital;
    let peak = initialCapital;
    let maxDrawdown = 0;
    for (let index = 0; index < pnls.length; index += 1) {
      equity += pnls[Math.floor(random() * pnls.length)];
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak - equity);
    }
    endingEquities.push(equity);
    maxDrawdowns.push(maxDrawdown);
    if (equity < initialCapital) losingPaths += 1;
    if (maxDrawdown >= initialCapital * 0.2) drawdown20Paths += 1;
  }

  endingEquities.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => a - b);
  return {
    method: "bootstrap_with_replacement",
    simulations,
    seed: 16012026,
    ending_equity_p05: round(percentile(endingEquities, 0.05)),
    ending_equity_p50: round(percentile(endingEquities, 0.5)),
    ending_equity_p95: round(percentile(endingEquities, 0.95)),
    max_drawdown_p50_usd: round(percentile(maxDrawdowns, 0.5)),
    max_drawdown_p95_usd: round(percentile(maxDrawdowns, 0.95)),
    probability_of_loss_pct: simulations ? round(losingPaths / simulations * 100, 1) : 0,
    probability_of_20pct_drawdown_pct: simulations ? round(drawdown20Paths / simulations * 100, 1) : 0,
  };
}

function buildResearch(trades: Trade[], sizing: SizingSettings, oosPct: number, selectedIctSessions: IctSessionId[] | null) {
  const canonicalS16 = trades.length > 0 && trades.every((trade) => (
    trade.strategy_id?.toUpperCase() === "S16"
    && trade.market?.toLowerCase() === "us"
    && trade.pipeline === "updated"
  ));
  const splitIndex = trades.length
    ? Math.min(trades.length - 1, Math.max(1, Math.floor(trades.length * (1 - oosPct / 100))))
    : 0;
  const inSample = trades.slice(0, splitIndex);
  const outOfSample = trades.slice(splitIndex);
  const inStats = researchStats(inSample);
  const outStats = researchStats(outOfSample);
  const expectancyDegradation = inStats.expectancy_usd !== 0
    ? (1 - outStats.expectancy_usd / inStats.expectancy_usd) * 100
    : null;
  const missing = {
    filled_price: trades.filter((trade) => trade.filled === null).length,
    stoploss: trades.filter((trade) => trade.stop === null).length,
    close_price: trades.filter((trade) => trade.close_price === null).length,
    timestamps: trades.filter((trade) => !trade.filled_at || !trade.close_ts).length,
    quantity: trades.filter((trade) => trade.quantity === null).length,
  };
  const warnings: string[] = [];
  if (trades.length < 100) warnings.push("Sample contains fewer than 100 closed trades.");
  if (outOfSample.length < 30) warnings.push("Out-of-sample segment contains fewer than 30 trades.");
  if (Object.values(missing).some((count) => count > 0)) warnings.push("One or more critical execution fields are missing.");
  if (sizing.commissionBps + sizing.slippageBps === 0) warnings.push("Execution friction is disabled.");
  warnings.push("No spread, partial-fill, market-impact, borrow, tax, or regulatory-fee model is applied.");
  warnings.push("This is a chronological holdout, not parameter-optimized walk-forward validation.");
  if (canonicalS16) {
    warnings.push("S16 rows with an incomplete checklist are excluded; 264 TP2-evaluable rows fail displacement-after-final-sweep ordering.");
    warnings.push("S16 CLOSED_EXPIRED target outcomes are conservatively scored at -1R.");
  }

  const checks = [
    { id: "sample_size", label: "At least 100 closed trades", passed: trades.length >= 100 },
    { id: "oos_sample", label: "At least 30 out-of-sample trades", passed: outOfSample.length >= 30 },
    { id: "costs", label: "Commission and slippage enabled", passed: sizing.commissionBps + sizing.slippageBps > 0 },
    { id: "critical_fields", label: "Critical execution fields complete", passed: Object.values(missing).every((count) => count === 0) },
    { id: "oos_profitability", label: "Out-of-sample expectancy positive", passed: outStats.expectancy_usd > 0 },
    { id: "oos_profit_factor", label: "Out-of-sample profit factor above 1", passed: (outStats.profit_factor ?? 0) > 1 },
  ];
  const passedChecks = checks.filter((check) => check.passed).length;

  return {
    validation: {
      method: "chronological_holdout",
      oos_pct: oosPct,
      split_trade_index: splitIndex,
      split_timestamp: outOfSample[0]?.close_ts ?? null,
      in_sample: inStats,
      out_of_sample: outStats,
      expectancy_degradation_pct: expectancyDegradation === null ? null : round(expectancyDegradation),
    },
    monte_carlo: monteCarlo(trades, sizing.initialCapital),
    attribution: {
      by_year: attributionRows(trades, (trade) => trade.close_ts ? String(new Date(trade.close_ts).getUTCFullYear()) : "Unknown"),
      by_session: ictSessionAttributionRows(trades, selectedIctSessions),
      by_direction: attributionRows(trades, (trade) => (trade.direction || "Unknown").toUpperCase()),
      by_strategy: attributionRows(trades, (trade) => trade.strategy_id || "Unknown"),
      by_smt: attributionRows(trades, (trade) => trade.smt_group || "Pending"),
      by_weekly_profile: attributionRows(trades, (trade) => trade.wp_group || "Pending"),
      by_weekly_profile_hindsight: attributionRows(trades, (trade) => trade.wp_hindsight_group || "Pending"),
      by_weekday: attributionRows(trades, (trade) => trade.wp_day || "Pending"),
    },
    hold_time_performance: holdTimePerformanceRows(trades),
    data_quality: {
      status: warnings.length > 2 ? "REVIEW" : "PASS",
      closed_trades: trades.length,
      first_close_ts: trades.find((trade) => trade.close_ts)?.close_ts ?? null,
      last_close_ts: [...trades].reverse().find((trade) => trade.close_ts)?.close_ts ?? null,
      missing,
      warnings,
    },
    audit: {
      calculation_version: "research-v2",
      generated_at: new Date().toISOString(),
      source: canonicalS16
        ? "audited checklist-complete S16 US updated structural setups"
        : "historical_ict original + isolated updated backtest tables",
      assumptions: [
        `${sizing.mode} sizing`,
        `${round(sizing.commissionBps)} bps commission plus ${round(sizing.slippageBps)} bps slippage on entry and exit notional`,
        canonicalS16
          ? "Checklist-complete closed TP and SL outcomes plus S16 expiries conservatively scored at -1R"
          : "Closed TP and SL outcomes only",
        "Chronological ordering by close timestamp",
        "ICT sessions use entry fill time (entry signal time only when fill time is unavailable), America/New_York DST rules, fixed Asia/Kolkata NSE hours, and inclusive-start/exclusive-end windows",
        "Overlapping ICT windows attribute one trade to every matching selected session",
        "Hold-time buckets are mutually exclusive and use elapsed minutes from fill to close; early buckets cover holds under 60 minutes",
        "Monte Carlo resamples observed net trade P/L with replacement",
      ],
    },
    deployment_gate: {
      status: passedChecks === checks.length ? "RESEARCH_PASSED_REVIEW_REQUIRED" : "NOT_READY",
      passed_checks: passedChecks,
      total_checks: checks.length,
      checks,
      note: "This gate does not approve live capital. Risk, operations, and execution review remain mandatory.",
    },
  };
}
