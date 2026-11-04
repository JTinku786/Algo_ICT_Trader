"""Postgres persistence for the broker-truth sync.

Every write is an idempotent upsert keyed on a deterministic uid, so re-running
a day (or running the sync twice by accident) never duplicates a row.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable, Sequence

import psycopg2
from psycopg2.extras import Json, RealDictCursor, execute_values

from sync_config import AccountSpec, db_config


SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"

ORDERS_TABLE = "realtime_production_broker_orders"
TRADES_TABLE = "realtime_production_broker_trades"
POSITIONS_TABLE = "realtime_production_broker_positions"
FUNDS_TABLE = "realtime_production_broker_funds"
LEDGER_TABLE = "realtime_production_broker_ledger"
WATERMARKS_TABLE = "realtime_production_broker_sync_watermarks"
RUNS_TABLE = "realtime_production_broker_sync_runs"
ISSUES_TABLE = "realtime_production_broker_reconciliation_issues"

EXECUTIONS_TABLE = "realtime_production_broker_order_executions"
CUSTOMERS_TABLE = "realtime_production_customers"
CUSTOMER_ACCOUNTS_TABLE = "realtime_production_customer_broker_accounts"

# Columns the sync owns. Anything not listed keeps its stored value on conflict.
_TABLE_KEYS = {
    ORDERS_TABLE: "order_uid",
    TRADES_TABLE: "trade_uid",
    POSITIONS_TABLE: "position_uid",
    FUNDS_TABLE: "funds_uid",
    LEDGER_TABLE: "ledger_uid",
    ISSUES_TABLE: "issue_uid",
}

# Columns that must never be overwritten by a later sync of the same row.
_PRESERVE_ON_CONFLICT = {"first_seen_at", "created_at"}

# Columns a reconcile pass owns; a plain data sync must not blank them out.
_RECONCILE_OWNED = {"source", "algo_execution_id", "algo_source_order_id"}

# Columns declared NOT NULL DEFAULT '{}'::jsonb. upsert_rows builds its column
# list as the union across the batch, so a row that does not carry one of these
# would otherwise send an explicit NULL and trip the not-null constraint --
# exactly what a Dhan batch does when today's fills have no charges attached but
# the historical ones do.
_JSON_DEFAULT_COLUMNS = {"raw", "charges", "details", "cursor"}


def connect():
    """Open a Postgres connection using the pipeline or website credentials."""
    return psycopg2.connect(**db_config())


def apply_schema(conn) -> None:
    """Create every broker-truth table. Safe to run on every sync."""
    sql = SCHEMA_PATH.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()


def _prepare(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return Json(value)
    return value


def _cell(row: dict[str, Any], column: str) -> Any:
    value = row.get(column)
    if value is None and column in _JSON_DEFAULT_COLUMNS:
        return Json({})
    return _prepare(value)


def safe_rollback(conn) -> None:
    """Clear a failed transaction so later bookkeeping writes can still run.

    Without this, one bad batch poisons the connection and every subsequent
    statement -- including the watermark and run-ledger updates that record why
    the batch failed -- dies with InFailedSqlTransaction.
    """
    try:
        conn.rollback()
    except Exception:  # noqa: BLE001 - nothing useful left to do
        pass


# Provenance ranking. A row reconstructed from the algo's audit trail must
# never overwrite one the broker API actually returned.
FEED_RANK = {"broker_api": 3, "derived_trades": 2, "execution_audit": 1}

# Applied to DO UPDATE when a table carries source_feed: take the incoming row
# only when it is at least as authoritative as the row already stored.
_FEED_GUARD = (
    "COALESCE((SELECT rank FROM (VALUES ('broker_api',3),('derived_trades',2),"
    "('execution_audit',1)) AS r(feed, rank) WHERE r.feed = EXCLUDED.source_feed), 0) >= "
    "COALESCE((SELECT rank FROM (VALUES ('broker_api',3),('derived_trades',2),"
    "('execution_audit',1)) AS r(feed, rank) WHERE r.feed = {table}.source_feed), 0)"
)


def upsert_rows(conn, table: str, rows: Sequence[dict[str, Any]], *, preserve: Iterable[str] = ()) -> int:
    """Bulk upsert ``rows`` into ``table`` on its uid primary key."""
    rows = [row for row in rows if row]
    if not rows:
        return 0
    key = _TABLE_KEYS[table]
    columns: list[str] = []
    for row in rows:
        for column in row:
            if column not in columns:
                columns.append(column)

    skip = _PRESERVE_ON_CONFLICT | set(preserve)
    updates = [column for column in columns if column != key and column not in skip]
    assignments = ", ".join(f"{column} = EXCLUDED.{column}" for column in updates)
    guard = f" WHERE {_FEED_GUARD.format(table=table)}" if "source_feed" in columns else ""
    statement = (
        f"INSERT INTO {table} ({', '.join(columns)}) VALUES %s "
        f"ON CONFLICT ({key}) DO UPDATE SET {assignments}{guard}"
        if updates
        else f"INSERT INTO {table} ({', '.join(columns)}) VALUES %s ON CONFLICT ({key}) DO NOTHING"
    )

    values = [tuple(_cell(row, column) for column in columns) for row in rows]
    try:
        with conn.cursor() as cur:
            execute_values(cur, statement, values, page_size=500)
        conn.commit()
    except Exception:
        safe_rollback(conn)
        raise
    return len(rows)


def upsert_orders(conn, rows: Sequence[dict[str, Any]]) -> int:
    # A data sync refreshes broker facts; it never clears the reconcile columns.
    return upsert_rows(conn, ORDERS_TABLE, rows, preserve=_RECONCILE_OWNED)


def upsert_trades(conn, rows: Sequence[dict[str, Any]]) -> int:
    return upsert_rows(conn, TRADES_TABLE, rows)


def upsert_positions(conn, rows: Sequence[dict[str, Any]]) -> int:
    return upsert_rows(conn, POSITIONS_TABLE, rows)


def upsert_funds(conn, rows: Sequence[dict[str, Any]]) -> int:
    return upsert_rows(conn, FUNDS_TABLE, rows)


def upsert_ledger(conn, rows: Sequence[dict[str, Any]]) -> int:
    return upsert_rows(conn, LEDGER_TABLE, rows)


def upsert_issues(conn, rows: Sequence[dict[str, Any]]) -> int:
    return upsert_rows(conn, ISSUES_TABLE, rows)


# ---------------------------------------------------------- watermarks -----
def get_watermark(conn, broker: str, account: str, dataset: str) -> dict[str, Any] | None:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            f"SELECT * FROM {WATERMARKS_TABLE} WHERE broker = %s AND broker_account = %s AND dataset = %s",
            (broker, account, dataset),
        )
        row = cur.fetchone()
    return dict(row) if row else None


def set_watermark(
    conn,
    broker: str,
    account: str,
    dataset: str,
    *,
    status: str,
    last_record_ts: datetime | None = None,
    last_trade_date: date | None = None,
    rows_added: int = 0,
    error: str | None = None,
    cursor_payload: dict[str, Any] | None = None,
) -> None:
    """Advance the max-update-time marker this dataset resumes from.

    ``last_record_ts`` and ``last_trade_date`` only ever move forward, so a
    partial or out-of-order fetch can never rewind the watermark and cause the
    next run to silently skip days.
    """
    success = status == "success"
    with conn.cursor() as cur:
        cur.execute(
            f"""
            INSERT INTO {WATERMARKS_TABLE}
                (broker, broker_account, dataset, last_record_ts, last_trade_date,
                 last_success_at, last_attempt_at, last_status, last_error, rows_total, cursor)
            VALUES (%s, %s, %s, %s, %s, %s, NOW(), %s, %s, %s, %s)
            ON CONFLICT (broker, broker_account, dataset) DO UPDATE SET
                last_record_ts = GREATEST(
                    COALESCE(EXCLUDED.last_record_ts, {WATERMARKS_TABLE}.last_record_ts),
                    COALESCE({WATERMARKS_TABLE}.last_record_ts, EXCLUDED.last_record_ts)
                ),
                last_trade_date = GREATEST(
                    COALESCE(EXCLUDED.last_trade_date, {WATERMARKS_TABLE}.last_trade_date),
                    COALESCE({WATERMARKS_TABLE}.last_trade_date, EXCLUDED.last_trade_date)
                ),
                last_success_at = COALESCE(EXCLUDED.last_success_at, {WATERMARKS_TABLE}.last_success_at),
                last_attempt_at = NOW(),
                last_status = EXCLUDED.last_status,
                last_error = EXCLUDED.last_error,
                rows_total = {WATERMARKS_TABLE}.rows_total + EXCLUDED.rows_total,
                cursor = EXCLUDED.cursor,
                updated_at = NOW()
            """,
            (
                broker,
                account,
                dataset,
                last_record_ts,
                last_trade_date,
                datetime.now().astimezone() if success else None,
                status,
                error,
                max(0, int(rows_added)),
                Json(cursor_payload or {}),
            ),
        )
    conn.commit()


# ------------------------------------------------------------ run ledger ----
def start_run(conn, broker: str, account: str, dataset: str, *, window_start=None, window_end=None) -> str:
    run_id = str(uuid.uuid4())
    run_key = f"{broker}|{account}|{dataset}|{datetime.now().astimezone().isoformat(timespec='seconds')}|{run_id[:8]}"
    with conn.cursor() as cur:
        cur.execute(
            f"""
            INSERT INTO {RUNS_TABLE}
                (run_id, run_key, broker, broker_account, dataset, status, window_start, window_end)
            VALUES (%s, %s, %s, %s, %s, 'running', %s, %s)
            """,
            (run_id, run_key, broker, account, dataset, window_start, window_end),
        )
    conn.commit()
    return run_id


def finish_run(
    conn,
    run_id: str,
    *,
    status: str,
    rows_fetched: int = 0,
    rows_written: int = 0,
    error: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE {RUNS_TABLE}
               SET finished_at = NOW(),
                   duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at)),
                   status = %s,
                   rows_fetched = %s,
                   rows_written = %s,
                   error = %s,
                   details = %s
             WHERE run_id = %s
            """,
            (status, int(rows_fetched), int(rows_written), (error or None), Json(details or {}), run_id),
        )
    conn.commit()


# ------------------------------------------------------------- registry -----
def register_account(conn, spec: AccountSpec, *, auth_status: str, token_expires_at: datetime | None = None) -> None:
    """Keep the customer / broker-account registry in step with what we synced.

    UUIDs are generated in Python rather than with gen_random_uuid() so this
    works on a Postgres build without pgcrypto, matching how the rest of the
    pipeline mints its ids.

    This is what removes the ``legacy_unlinked`` rows the dashboard used to
    invent from execution history: after one successful sync every live account
    has a real customer record with a verified auth status.
    """
    with conn.cursor() as cur:
        cur.execute(
            f"""
            INSERT INTO {CUSTOMERS_TABLE} (customer_id, customer_key, display_name, active)
            VALUES (%s, %s, %s, TRUE)
            ON CONFLICT (customer_key) DO UPDATE SET
                display_name = EXCLUDED.display_name,
                updated_at = NOW()
            RETURNING customer_id
            """,
            (str(uuid.uuid4()), spec.customer_key, spec.display_name),
        )
        customer_id = cur.fetchone()[0]
        cur.execute(
            f"""
            INSERT INTO {CUSTOMER_ACCOUNTS_TABLE}
                (broker_account_id, customer_id, broker, broker_client_id, account_label,
                 environment, active, strategies, risk_config, auth_status,
                 token_expires_at, last_verified_at)
            VALUES (%s, %s, %s, %s, %s, %s, TRUE, %s, %s, %s, %s, %s)
            ON CONFLICT (broker, broker_client_id, environment) DO UPDATE SET
                customer_id = EXCLUDED.customer_id,
                account_label = EXCLUDED.account_label,
                strategies = EXCLUDED.strategies,
                risk_config = EXCLUDED.risk_config,
                auth_status = EXCLUDED.auth_status,
                token_expires_at = EXCLUDED.token_expires_at,
                last_verified_at = EXCLUDED.last_verified_at,
                updated_at = NOW()
            """,
            (
                str(uuid.uuid4()),
                customer_id,
                spec.broker,
                spec.broker_client_id,
                spec.broker_account,
                spec.environment,
                Json(list(spec.strategies)),
                Json(spec.risk_config),
                auth_status,
                token_expires_at,
                datetime.now().astimezone() if auth_status == "verified" else None,
            ),
        )
    conn.commit()
