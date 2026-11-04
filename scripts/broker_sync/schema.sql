-- Broker-truth schema for Account Management.
--
-- These tables hold exactly what Angel One / Dhan / Groww returned, per account,
-- per trading day. They are deliberately separate from
-- realtime_production_broker_order_executions (the algo's own audit trail) so
-- that manual trades, broker-side rejections and broker-confirmed fills are all
-- representable. A reconcile pass links the two.
--
-- Every table is keyed on a deterministic text uid so re-running a day's sync is
-- idempotent.

CREATE TABLE IF NOT EXISTS realtime_production_broker_orders (
    order_uid              TEXT PRIMARY KEY,
    broker                 TEXT NOT NULL,
    broker_account         TEXT NOT NULL,
    broker_client_id       TEXT,
    broker_order_id        TEXT NOT NULL,
    exchange_order_id      TEXT,
    parent_order_id        TEXT,
    trade_date             DATE NOT NULL,
    status                 TEXT NOT NULL,
    status_raw             TEXT,
    is_open                BOOLEAN NOT NULL DEFAULT FALSE,
    reject_reason          TEXT,
    exchange               TEXT,
    segment                TEXT,
    tradingsymbol          TEXT,
    underlying             TEXT,
    instrument_type        TEXT,
    option_type            TEXT,
    strike                 NUMERIC(18,6),
    expiry_date            DATE,
    security_id            TEXT,
    product                TEXT,
    order_type             TEXT,
    side                   TEXT,
    validity               TEXT,
    quantity               NUMERIC(18,4),
    filled_quantity        NUMERIC(18,4),
    pending_quantity       NUMERIC(18,4),
    cancelled_quantity     NUMERIC(18,4),
    price                  NUMERIC(18,6),
    trigger_price          NUMERIC(18,6),
    average_price          NUMERIC(18,6),
    order_ts               TIMESTAMPTZ,
    exchange_ts            TIMESTAMPTZ,
    broker_updated_ts      TIMESTAMPTZ,
    source                 TEXT NOT NULL DEFAULT 'unknown',
    source_feed            TEXT NOT NULL DEFAULT 'broker_api',
    algo_execution_id      UUID,
    algo_source_order_id   UUID,
    raw                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broker_orders_account_date
    ON realtime_production_broker_orders (broker, broker_account, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_broker_orders_status
    ON realtime_production_broker_orders (status, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_broker_orders_open
    ON realtime_production_broker_orders (is_open, broker, broker_account);
CREATE INDEX IF NOT EXISTS idx_broker_orders_broker_order_id
    ON realtime_production_broker_orders (broker, broker_order_id);
CREATE INDEX IF NOT EXISTS idx_broker_orders_symbol
    ON realtime_production_broker_orders (tradingsymbol, trade_date DESC);


CREATE TABLE IF NOT EXISTS realtime_production_broker_trades (
    trade_uid              TEXT PRIMARY KEY,
    broker                 TEXT NOT NULL,
    broker_account         TEXT NOT NULL,
    broker_client_id       TEXT,
    order_uid              TEXT,
    broker_order_id        TEXT,
    broker_trade_id        TEXT,
    exchange_trade_id      TEXT,
    trade_date             DATE NOT NULL,
    tradingsymbol          TEXT,
    underlying             TEXT,
    exchange               TEXT,
    segment                TEXT,
    security_id            TEXT,
    instrument_type        TEXT,
    option_type            TEXT,
    strike                 NUMERIC(18,6),
    expiry_date            DATE,
    product                TEXT,
    order_type             TEXT,
    side                   TEXT,
    quantity               NUMERIC(18,4),
    price                  NUMERIC(18,6),
    trade_value            NUMERIC(20,6),
    trade_ts               TIMESTAMPTZ,
    brokerage              NUMERIC(18,6),
    taxes                  NUMERIC(18,6),
    charges_total          NUMERIC(18,6),
    charges                JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_feed            TEXT NOT NULL DEFAULT 'broker_api',
    raw                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broker_trades_account_date
    ON realtime_production_broker_trades (broker, broker_account, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_broker_trades_order
    ON realtime_production_broker_trades (broker, broker_order_id);
CREATE INDEX IF NOT EXISTS idx_broker_trades_symbol
    ON realtime_production_broker_trades (tradingsymbol, trade_ts DESC);


CREATE TABLE IF NOT EXISTS realtime_production_broker_positions (
    position_uid           TEXT PRIMARY KEY,
    broker                 TEXT NOT NULL,
    broker_account         TEXT NOT NULL,
    broker_client_id       TEXT,
    trade_date             DATE NOT NULL,
    tradingsymbol          TEXT NOT NULL,
    underlying             TEXT,
    exchange               TEXT,
    segment                TEXT,
    security_id            TEXT,
    product                TEXT,
    instrument_type        TEXT,
    option_type            TEXT,
    strike                 NUMERIC(18,6),
    expiry_date            DATE,
    position_type          TEXT NOT NULL DEFAULT 'OPEN',
    net_quantity           NUMERIC(18,4),
    buy_quantity           NUMERIC(18,4),
    sell_quantity          NUMERIC(18,4),
    buy_avg_price          NUMERIC(18,6),
    sell_avg_price         NUMERIC(18,6),
    average_price          NUMERIC(18,6),
    last_price             NUMERIC(18,6),
    close_price            NUMERIC(18,6),
    realized_pnl           NUMERIC(20,6),
    unrealized_pnl         NUMERIC(20,6),
    total_pnl              NUMERIC(20,6),
    multiplier             NUMERIC(18,6),
    lotsize                INTEGER,
    snapshot_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_feed            TEXT NOT NULL DEFAULT 'broker_api',
    raw                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broker_positions_account_date
    ON realtime_production_broker_positions (broker, broker_account, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_broker_positions_open
    ON realtime_production_broker_positions (position_type, broker, broker_account, trade_date DESC);


CREATE TABLE IF NOT EXISTS realtime_production_broker_funds (
    funds_uid              TEXT PRIMARY KEY,
    broker                 TEXT NOT NULL,
    broker_account         TEXT NOT NULL,
    broker_client_id       TEXT,
    trade_date             DATE NOT NULL,
    available_cash         NUMERIC(20,6),
    opening_balance        NUMERIC(20,6),
    utilised_margin        NUMERIC(20,6),
    collateral             NUMERIC(20,6),
    withdrawable_balance   NUMERIC(20,6),
    net_balance            NUMERIC(20,6),
    realized_pnl           NUMERIC(20,6),
    unrealized_pnl         NUMERIC(20,6),
    snapshot_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broker_funds_account_date
    ON realtime_production_broker_funds (broker, broker_account, trade_date DESC);


CREATE TABLE IF NOT EXISTS realtime_production_broker_ledger (
    ledger_uid             TEXT PRIMARY KEY,
    broker                 TEXT NOT NULL,
    broker_account         TEXT NOT NULL,
    broker_client_id       TEXT,
    entry_date             DATE NOT NULL,
    posting_ts             TIMESTAMPTZ,
    voucher_number         TEXT,
    voucher_type           TEXT,
    narration              TEXT,
    exchange               TEXT,
    debit                  NUMERIC(20,6),
    credit                 NUMERIC(20,6),
    net_amount             NUMERIC(20,6),
    running_balance        NUMERIC(20,6),
    category               TEXT,
    raw                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broker_ledger_account_date
    ON realtime_production_broker_ledger (broker, broker_account, entry_date DESC);


CREATE TABLE IF NOT EXISTS realtime_production_broker_sync_watermarks (
    broker                 TEXT NOT NULL,
    broker_account         TEXT NOT NULL,
    dataset                TEXT NOT NULL,
    last_record_ts         TIMESTAMPTZ,
    last_trade_date        DATE,
    last_success_at        TIMESTAMPTZ,
    last_attempt_at        TIMESTAMPTZ,
    last_status            TEXT,
    last_error             TEXT,
    rows_total             BIGINT NOT NULL DEFAULT 0,
    cursor                 JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (broker, broker_account, dataset)
);


CREATE TABLE IF NOT EXISTS realtime_production_broker_sync_runs (
    run_id                 UUID PRIMARY KEY,
    run_key                TEXT NOT NULL UNIQUE,
    broker                 TEXT NOT NULL,
    broker_account         TEXT NOT NULL,
    dataset                TEXT NOT NULL,
    started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at            TIMESTAMPTZ,
    duration_seconds       NUMERIC(12,3),
    status                 TEXT NOT NULL,
    rows_fetched           INTEGER NOT NULL DEFAULT 0,
    rows_written           INTEGER NOT NULL DEFAULT 0,
    window_start           TIMESTAMPTZ,
    window_end             TIMESTAMPTZ,
    error                  TEXT,
    details                JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_broker_sync_runs_recent
    ON realtime_production_broker_sync_runs (broker, broker_account, dataset, started_at DESC);


CREATE TABLE IF NOT EXISTS realtime_production_broker_reconciliation_issues (
    issue_uid              TEXT PRIMARY KEY,
    broker                 TEXT NOT NULL,
    broker_account         TEXT NOT NULL,
    trade_date             DATE,
    issue_type             TEXT NOT NULL,
    severity               TEXT NOT NULL DEFAULT 'warning',
    broker_order_id        TEXT,
    execution_id           UUID,
    tradingsymbol          TEXT,
    message                TEXT NOT NULL,
    details                JSONB NOT NULL DEFAULT '{}'::jsonb,
    resolved               BOOLEAN NOT NULL DEFAULT FALSE,
    first_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broker_recon_open
    ON realtime_production_broker_reconciliation_issues (resolved, broker, broker_account, trade_date DESC);


-- Migrations for tables created before a column existed. CREATE TABLE IF NOT
-- EXISTS is a no-op on an existing table, so every added column needs this.
ALTER TABLE realtime_production_broker_orders
    ADD COLUMN IF NOT EXISTS source_feed TEXT NOT NULL DEFAULT 'broker_api';
ALTER TABLE realtime_production_broker_trades
    ADD COLUMN IF NOT EXISTS source_feed TEXT NOT NULL DEFAULT 'broker_api';
ALTER TABLE realtime_production_broker_positions
    ADD COLUMN IF NOT EXISTS source_feed TEXT NOT NULL DEFAULT 'broker_api';

CREATE INDEX IF NOT EXISTS idx_broker_orders_feed
    ON realtime_production_broker_orders (source_feed, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_broker_positions_feed
    ON realtime_production_broker_positions (source_feed, trade_date DESC);
