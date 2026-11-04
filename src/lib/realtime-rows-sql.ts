// One projection of every live signal source the Realtime Orders tab reads.
//
// The equity/NSE engines write realtime_production_ict_strategy_met_execution
// + realtime_production_orders. IGS01V2 (forex, OANDA) runs on its own engine
// and writes igs01v2_live_signals, so without this UNION it never reaches the
// dashboard. Both branches expose the same columns, so the aggregation in
// /api/realtime-analytics stays untouched.
//
// Keep backend/rest_api.py REALTIME_ROWS_SQL in sync with this text.
export const IGS01V2_LIVE_STRATEGY_ID = "IGS01V2_LondonLiqGrab_SweepReversal";

export const REALTIME_ROWS_SOURCE = `(
  SELECT s.signal_hash, s.market, s.ticker, s.base_symbol, s.company_name,
         s.exchange_timezone, s.direction, s.entry_datetime, s.entry_date,
         s.strategy_id, s.strategy, s.strategy_key, s.entry_price AS signal_entry_price,
         s.stoploss AS signal_stoploss, s.target_1, s.target_2, s.target_3, s.as_of_ts,
         s.strategy_json,
         o.order_id::text AS order_id, o.state, o.order_type, o.qty, o.entry_price, o.filled_price,
         o.stoploss, o.tp1, o.tp2, o.tp3, o.filled_at, o.close_price, o.close_ts,
         o.close_reason, o.updated_at, o.risk_probability, o.risk_bin,
         NULL::double precision AS live_realized_r
  FROM realtime_production_ict_strategy_met_execution s
  LEFT JOIN realtime_production_orders o ON o.signal_id = s.signal_hash
  UNION ALL
  -- IGS01V2 live (OANDA). A signal only becomes an order once OANDA accepted
  -- it; non-tradeable (low risk-bin) signals stay visible as signal-only rows.
  SELECT g.signal_id, 'forex', g.symbol, REPLACE(g.symbol, '^', ''), NULL::text, 'America/New_York',
         CASE WHEN g.side > 0 THEN 'BUY' ELSE 'SELL' END, g.entry_ts, g.run_date,
         '${IGS01V2_LIVE_STRATEGY_ID}', 'London Killzone Sweep Reversal (V2, no IFVG)', 'IGS01V2',
         g.signal_entry, g.stop, g.tp1, g.tp2, g.tp3, g.created_at,
         jsonb_build_object('source', 'igs01v2_live_signals', 'broker', 'OANDA', 'tradeable', g.tradeable, 'skip_reason', g.skip_reason,
           'oanda_order_id', g.oanda_order_id, 'oanda_state', g.oanda_state, 'fill_state', g.fill_state, 'exit_reason', g.exit_reason,
           'units', g.units, 'risk_pips', g.risk_pips, 'realized_pl', g.realized_pl, 'realized_r', g.realized_r,
           'ml_score', jsonb_build_object('prob', g.probability, 'bin', g.risk_bin, 'model_version', g.model_version),
           'features', g.features),
         CASE WHEN g.oanda_order_id IS NOT NULL THEN 'OANDA:' || g.oanda_order_id END,
         CASE
           WHEN g.oanda_order_id IS NULL THEN NULL
           WHEN UPPER(COALESCE(g.fill_state, g.oanda_state, '')) = 'CLOSED' THEN
             CASE WHEN UPPER(COALESCE(g.exit_reason, '')) IN ('TARGET', 'TP', 'TAKE_PROFIT') THEN 'CLOSED_TP'
                  WHEN UPPER(COALESCE(g.exit_reason, '')) IN ('STOP', 'SL', 'STOP_LOSS') THEN 'CLOSED_SL'
                  ELSE 'CLOSED_' || COALESCE(NULLIF(UPPER(g.exit_reason), ''), 'OTHER') END
           WHEN UPPER(COALESCE(g.fill_state, g.oanda_state, '')) IN ('FILLED', 'OPEN', 'TRADE_OPEN') THEN 'OPEN'
           WHEN UPPER(COALESCE(g.fill_state, g.oanda_state, '')) IN ('EXPIRED', 'CANCELLED', 'CANCELED', 'REJECTED')
             THEN UPPER(COALESCE(g.fill_state, g.oanda_state))
           ELSE 'PENDING'
         END,
         'LIMIT', ABS(g.units)::numeric, g.signal_entry, g.fill_price, g.stop, g.tp1, g.tp2, g.tp3,
         g.fill_ts, g.close_price, g.close_ts, g.exit_reason, COALESCE(g.reconciled_at, g.created_at),
         g.probability, g.risk_bin,
         -- OANDA's realized R is measured against the planned risk; recomputing
         -- it from the fill price would disagree with the broker record.
         CASE WHEN g.close_ts IS NOT NULL THEN g.realized_r END
  FROM igs01v2_live_signals g
  UNION ALL
  -- Isolated MSS paper lane: historical backfills are labelled, never broker orders.
  SELECT m.signal_hash,m.market,m.ticker,REPLACE(m.ticker,'^',''),
         'MSS reversal · ' || m.source_mode,'America/New_York',m.direction,m.entry_datetime,m.entry_date,
         'MSS-REVERSAL-D1-M5-CLOSE','MSS reversal · Daily/5m close CHOCH','MSS_REVERSAL',
         m.entry_price,m.stoploss,m.tp1,NULL::double precision,NULL::double precision,m.observed_at,
         m.strategy_json,m.order_id::text,m.state,'PAPER_LIMIT',1::numeric,m.entry_price,m.entry_price,
         m.stoploss,m.tp1,NULL::double precision,NULL::double precision,m.entry_datetime,
         m.close_price,m.close_ts,m.close_reason,m.updated_at,NULL::double precision,NULL::integer,m.realized_r
  FROM realtime_production_mss_reversal_orders m
  WHERE NOT(m.strategy_json ? 'superseded_by_completed_backfill')
  UNION ALL
  SELECT k.signal_hash,k.market,k.ticker,REPLACE(k.ticker,'^',''),
         'k1_reclaim3 · ' || k.source_mode,'America/New_York',k.direction,k.entry_datetime,(k.entry_datetime AT TIME ZONE 'America/New_York')::date,
         'REV-k1_reclaim3-OTE62-2R-TOUCH-' || k.timeframe,'k1_reclaim3 · OTE 62% limit · 2R · 5m close SL','REVERSAL_K1',
         k.entry_price,k.stoploss,k.tp1,NULL::double precision,NULL::double precision,k.observed_at,
         -- A later order on the same ICT liquidity event (same sweep extreme) is a DUPLICATE_SETUP,
         -- not a trade: shown in the feed, excluded from performance (view owns the rule).
         k.strategy_json || jsonb_build_object('setup_key',k.setup_key,'duplicate_of',k.duplicate_of,'duplicate_of_timeframe',k.duplicate_of_timeframe,'raw_state',k.state),
         k.order_id::text,CASE WHEN k.duplicate_of IS NOT NULL THEN 'DUPLICATE_SETUP' ELSE k.state END,'PAPER_LIMIT',1::numeric,k.entry_price,k.entry_price,
         k.stoploss,k.tp1,NULL::double precision,NULL::double precision,k.entry_datetime,
         k.close_price,k.close_ts,CASE WHEN k.duplicate_of IS NOT NULL THEN NULL WHEN k.state='CLOSED_SL' THEN 'STOP' WHEN k.state='CLOSED_TP' THEN 'TARGET' END,k.updated_at,NULL::double precision,NULL::integer,
         CASE WHEN k.duplicate_of IS NULL THEN k.realized_r END
  FROM realtime_production_reversal_k1_setups k
  UNION ALL
  -- Scalping_OB_OB_V4 PAPER lane (no broker orders): realized_r blends the 50% partial at +2R with the remainder's exit.
  SELECT v.signal_hash,v.market,v.ticker,v.ticker,
         'Scalping OB x OB V4 - ' || v.source_mode,'America/New_York',v.direction,v.entry_datetime,(v.entry_datetime AT TIME ZONE 'America/New_York')::date,
         'Scalping_OB_OB_V4','Scalping OB x OB V4 - 1h OB x 5m OB - 50% at +2R - 5m close SL','SCALPING_OB_OB_V4',
         v.entry_price,v.stoploss,v.tp1,NULL::double precision,NULL::double precision,v.observed_at,
         v.strategy_json || jsonb_build_object('partial_price',v.partial_price,'partial_at',v.partial_at,'planned_rr',v.planned_rr,'risk_bps',v.risk_bps,'execution_mode',v.execution_mode,
           'execution_status',v.execution_status,'armed_at',v.armed_at,'drift_r',v.drift_r,
           'atm_option',CASE WHEN ol.order_id IS NULL THEN NULL ELSE jsonb_build_object('occ_symbol',ol.occ_symbol,'type',ol.option_type,'expiration',ol.expiration,
             'strike',ol.strike,'entry_price',ol.entry_option_price,'entry_bid',ol.entry_bid,'entry_ask',ol.entry_ask,'partial_price',ol.partial_option_price,
             'exit_price',ol.exit_option_price,'return_pct',ol.option_return_pct,'price_source',ol.price_source,
             'entry_mark',ol.entry_mark,'days_to_expiry',ol.days_to_expiry,'contract_multiplier',ol.contract_multiplier,'premium_per_contract',ol.premium_per_contract,
             'underlying_at_entry',ol.underlying_at_entry,'entry_bar',ol.entry_bar,'entry_quote',ol.entry_quote,'same_bar_round_trip',ol.same_bar_round_trip) END),
         v.order_id::text,v.state,'PAPER_LIMIT',1::numeric,v.entry_price,v.entry_price,
         v.stoploss,v.tp1,NULL::double precision,NULL::double precision,v.entry_datetime,
         v.close_price,v.close_ts,CASE v.close_reason WHEN 'STOP_CLOSE' THEN 'STOP' WHEN 'TARGET' THEN 'TARGET' END,v.updated_at,NULL::double precision,NULL::integer,
         v.realized_r
  FROM realtime_production_scalping_ob_ob_v4_orders v
  LEFT JOIN realtime_production_scalping_ob_ob_v4_option_legs ol ON ol.order_id = v.order_id
  UNION ALL
  -- BPR_OB_V3 (Quiet Open A) PAPER lane (no broker orders): realized_r blends the 50% partial at +2R with the remainder's exit.
  SELECT v.signal_hash,v.market,v.ticker,v.ticker,
         'BPR x OB V3 - ' || v.source_mode,'America/New_York',v.direction,v.entry_datetime,(v.entry_datetime AT TIME ZONE 'America/New_York')::date,
         'BPR_OB_V3','BPR x OB V3 - 1h BPR x 5m OB - quiet open < 0.2 - 50% at +2R - 5m close SL','BPR_OB_V3',
         v.entry_price,v.stoploss,v.tp1,NULL::double precision,NULL::double precision,v.observed_at,
         v.strategy_json || jsonb_build_object('partial_price',v.partial_price,'partial_at',v.partial_at,'planned_rr',v.planned_rr,'risk_bps',v.risk_bps,'execution_mode',v.execution_mode,
           'execution_status',v.execution_status,'armed_at',v.armed_at,'drift_r',v.drift_r,
           'atm_option',CASE WHEN ol.order_id IS NULL THEN NULL ELSE jsonb_build_object('occ_symbol',ol.occ_symbol,'type',ol.option_type,'expiration',ol.expiration,
             'strike',ol.strike,'entry_price',ol.entry_option_price,'entry_bid',ol.entry_bid,'entry_ask',ol.entry_ask,'partial_price',ol.partial_option_price,
             'exit_price',ol.exit_option_price,'return_pct',ol.option_return_pct,'price_source',ol.price_source,
             'entry_mark',ol.entry_mark,'days_to_expiry',ol.days_to_expiry,'contract_multiplier',ol.contract_multiplier,'premium_per_contract',ol.premium_per_contract,
             'underlying_at_entry',ol.underlying_at_entry,'entry_bar',ol.entry_bar,'entry_quote',ol.entry_quote,'same_bar_round_trip',ol.same_bar_round_trip) END),
         v.order_id::text,v.state,'PAPER_LIMIT',1::numeric,v.entry_price,v.entry_price,
         v.stoploss,v.tp1,NULL::double precision,NULL::double precision,v.entry_datetime,
         v.close_price,v.close_ts,CASE v.close_reason WHEN 'STOP_CLOSE' THEN 'STOP' WHEN 'TARGET' THEN 'TARGET' END,v.updated_at,NULL::double precision,NULL::integer,
         v.realized_r
  FROM realtime_production_bpr_ob_v3_orders v
  LEFT JOIN realtime_production_bpr_ob_v3_option_legs ol ON ol.order_id = v.order_id
  UNION ALL
  -- IFVG_OB_V1 PAPER lane (no broker orders): realized_r blends the 50% partial at +2R with the remainder's exit.
  SELECT v.signal_hash,v.market,v.ticker,v.ticker,
         'IFVG x OB V1 - ' || v.source_mode,'America/New_York',v.direction,v.entry_datetime,(v.entry_datetime AT TIME ZONE 'America/New_York')::date,
         'IFVG_OB_V1','IFVG x OB V1 - 1h IFVG x 5m OB - quiet open < 0.2 - R:R >= 1.5 - hold to target - 5m close SL','IFVG_OB_V1',
         v.entry_price,v.stoploss,v.tp1,NULL::double precision,NULL::double precision,v.observed_at,
         v.strategy_json || jsonb_build_object('partial_price',v.partial_price,'partial_at',v.partial_at,'planned_rr',v.planned_rr,'risk_bps',v.risk_bps,'execution_mode',v.execution_mode,
           'execution_status',v.execution_status,'armed_at',v.armed_at,'drift_r',v.drift_r,
           'atm_option',CASE WHEN ol.order_id IS NULL THEN NULL ELSE jsonb_build_object('occ_symbol',ol.occ_symbol,'type',ol.option_type,'expiration',ol.expiration,
             'strike',ol.strike,'entry_price',ol.entry_option_price,'entry_bid',ol.entry_bid,'entry_ask',ol.entry_ask,'partial_price',ol.partial_option_price,
             'exit_price',ol.exit_option_price,'return_pct',ol.option_return_pct,'price_source',ol.price_source,
             'entry_mark',ol.entry_mark,'days_to_expiry',ol.days_to_expiry,'contract_multiplier',ol.contract_multiplier,'premium_per_contract',ol.premium_per_contract,
             'underlying_at_entry',ol.underlying_at_entry,'entry_bar',ol.entry_bar,'entry_quote',ol.entry_quote,'same_bar_round_trip',ol.same_bar_round_trip) END),
         v.order_id::text,v.state,'PAPER_LIMIT',1::numeric,v.entry_price,v.entry_price,
         v.stoploss,v.tp1,NULL::double precision,NULL::double precision,v.entry_datetime,
         v.close_price,v.close_ts,CASE v.close_reason WHEN 'STOP_CLOSE' THEN 'STOP' WHEN 'TARGET' THEN 'TARGET' END,v.updated_at,NULL::double precision,NULL::integer,
         v.realized_r
  FROM realtime_production_ifvg_ob_v1_orders v
  LEFT JOIN realtime_production_ifvg_ob_v1_option_legs ol ON ol.order_id = v.order_id
)`;

// Account Management > OANDA forex (CEO view): only rows that were actually
// executed on the OANDA account. IGS01V2 rows already are OANDA records
// (order_id = 'OANDA:<order id>'); Reversal k1 realtime rows carry the paper
// setup's prices, so the broker's own fill / exit / R from
// reversal_k1_live_orders ride along as oanda_* columns and replace them in
// /api/realtime-analytics. Keep backend/rest_api.py OANDA_EXECUTED_ROWS_SOURCE in sync.
export const OANDA_EXECUTED_ROWS_SOURCE = `(
  SELECT r.*, k.fill_price AS oanda_fill_price, k.fill_ts AS oanda_fill_ts, k.close_price AS oanda_close_price,
         k.close_ts AS oanda_close_ts, k.realized_r AS oanda_realized_r, k.status AS oanda_status
  FROM ${REALTIME_ROWS_SOURCE} r
  LEFT JOIN reversal_k1_live_orders k
    ON r.strategy_key = 'REVERSAL_K1' AND k.k1_order_id::text = r.order_id AND k.oanda_trade_id IS NOT NULL
  WHERE (r.strategy_key = 'IGS01V2'
         AND r.order_id IN (SELECT 'OANDA:' || open_order_id FROM oanda_account_trades WHERE open_order_id IS NOT NULL))
     OR k.oanda_trade_id IS NOT NULL
)`;
