CREATE TABLE IF NOT EXISTS ict_rejection_trade_runs (
  run_id uuid PRIMARY KEY,
  source text NOT NULL CHECK (source = 'realtime_orders'),
  strategy_id text NOT NULL,
  strategy_ids text[] NOT NULL DEFAULT '{}'::text[],
  markets text[] NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  candle_timeframe text NOT NULL DEFAULT '5m',
  cost_bps_per_side double precision NOT NULL DEFAULT 5,
  status text NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  parent_stop_count integer NOT NULL DEFAULT 0,
  eligible_price_stop_count integer NOT NULL DEFAULT 0,
  stored_trade_count integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE ict_rejection_trade_runs
  ADD COLUMN IF NOT EXISTS strategy_ids text[] NOT NULL DEFAULT '{}'::text[];

UPDATE ict_rejection_trade_runs
SET strategy_ids = ARRAY[strategy_id]
WHERE cardinality(strategy_ids) = 0;

CREATE INDEX IF NOT EXISTS ict_rejection_trade_runs_lookup_idx
  ON ict_rejection_trade_runs (strategy_id, status, completed_at DESC);

CREATE INDEX IF NOT EXISTS ict_rejection_trade_runs_strategy_ids_idx
  ON ict_rejection_trade_runs USING gin (strategy_ids);

CREATE TABLE IF NOT EXISTS ict_rejection_trade_orders (
  run_id uuid NOT NULL REFERENCES ict_rejection_trade_runs(run_id) ON DELETE CASCADE,
  parent_order_id text NOT NULL,
  market text NOT NULL,
  ticker text NOT NULL,
  strategy_id text NOT NULL,
  parent_direction text NOT NULL CHECK (parent_direction IN ('BUY', 'SELL')),
  parent_filled_at timestamptz NOT NULL,
  parent_entry double precision NOT NULL,
  parent_stop double precision NOT NULL,
  parent_tp1 double precision,
  parent_tp2 double precision,
  parent_tp3 double precision,
  parent_close_at timestamptz,
  parent_close_reason text,
  rejection_direction text CHECK (rejection_direction IN ('BUY', 'SELL')),
  stop_touch_candle_at timestamptz,
  rejection_entry_at timestamptz,
  rejection_entry double precision,
  rejection_stop double precision,
  rejection_risk double precision,
  stop_candle_range double precision,
  stop_candle_body double precision,
  stop_candle_atr_14 double precision,
  stop_candle_atr_pct double precision,
  stop_candle_range_atr double precision,
  stop_close_penetration_r double precision,
  parent_favorable_extreme_at timestamptz,
  parent_favorable_extreme_price double precision,
  parent_max_favorable_points double precision,
  parent_max_favorable_pct double precision,
  parent_max_favorable_r double precision,
  parent_tp1_progress_pct double precision,
  parent_pre_rejection_lesson text,
  analysis_status text NOT NULL CHECK (
    analysis_status IN (
      'VALID', 'EXCLUDED_NON_PRICE_STOP', 'INVALID_INPUT',
      'INVALID_GEOMETRY', 'NO_STOP_CANDLE'
    )
  ),
  status_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, parent_order_id)
);

ALTER TABLE ict_rejection_trade_orders
  ADD COLUMN IF NOT EXISTS stop_candle_range double precision,
  ADD COLUMN IF NOT EXISTS stop_candle_body double precision,
  ADD COLUMN IF NOT EXISTS stop_candle_atr_14 double precision,
  ADD COLUMN IF NOT EXISTS stop_candle_atr_pct double precision,
  ADD COLUMN IF NOT EXISTS stop_candle_range_atr double precision,
  ADD COLUMN IF NOT EXISTS stop_close_penetration_r double precision,
  ADD COLUMN IF NOT EXISTS parent_favorable_extreme_at timestamptz,
  ADD COLUMN IF NOT EXISTS parent_favorable_extreme_price double precision,
  ADD COLUMN IF NOT EXISTS parent_max_favorable_points double precision,
  ADD COLUMN IF NOT EXISTS parent_max_favorable_pct double precision,
  ADD COLUMN IF NOT EXISTS parent_max_favorable_r double precision,
  ADD COLUMN IF NOT EXISTS parent_tp1_progress_pct double precision,
  ADD COLUMN IF NOT EXISTS parent_pre_rejection_lesson text;

CREATE INDEX IF NOT EXISTS ict_rejection_trade_orders_filter_idx
  ON ict_rejection_trade_orders (run_id, market, ticker, parent_filled_at DESC);

CREATE INDEX IF NOT EXISTS ict_rejection_trade_orders_strategy_idx
  ON ict_rejection_trade_orders (run_id, strategy_id, parent_filled_at DESC);

CREATE TABLE IF NOT EXISTS ict_rejection_trade_target_outcomes (
  run_id uuid NOT NULL,
  parent_order_id text NOT NULL,
  target_no smallint NOT NULL CHECK (target_no BETWEEN 1 AND 3),
  original_rr double precision NOT NULL,
  target_price double precision NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('WIN', 'LOSS', 'AMBIGUOUS', 'OPEN')),
  exit_price double precision,
  exit_at timestamptz,
  gross_r double precision,
  cost_r double precision,
  net_r double precision,
  cycle_net_r double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, parent_order_id, target_no),
  FOREIGN KEY (run_id, parent_order_id)
    REFERENCES ict_rejection_trade_orders(run_id, parent_order_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ict_rejection_trade_outcomes_summary_idx
  ON ict_rejection_trade_target_outcomes (run_id, target_no, outcome);

COMMENT ON TABLE ict_rejection_trade_runs IS
  'Immutable batch runs for research-only rejection trade analysis.';
COMMENT ON TABLE ict_rejection_trade_orders IS
  'One stored counterfactual rejection entry per stopped parent order.';
COMMENT ON TABLE ict_rejection_trade_target_outcomes IS
  'Independent TP1/TP2/TP3 outcomes using each parent target R multiple.';
