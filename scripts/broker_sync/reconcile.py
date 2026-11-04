"""Reconcile broker truth against the algo's own execution audit trail.

The broker tables say what really happened at the exchange. The existing
``realtime_production_broker_order_executions`` table says what the algo believes
it did. Reconciling the two is what lets Account Management show:

  * which orders the algo placed and which the human placed on the same account
  * which algo executions the broker never saw
  * where the algo's recorded fill price disagrees with the broker's

Issues are upserted, and anything not re-observed in this pass is closed out, so
the open-issue list always reflects the current state rather than history.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from psycopg2.extras import RealDictCursor

import normalize as N
import store
from sync_config import AccountSpec


# Relative gap between the algo's recorded fill and the broker's average price
# that is worth a human look. Below this, rounding and partial fills dominate.
PRICE_TOLERANCE = 0.005


def reconcile_account(conn, spec: AccountSpec) -> dict[str, Any]:
    started = datetime.now().astimezone()
    linked = _link_algo_orders(conn, spec)
    manual = _mark_manual_orders(conn, spec)
    issues = _collect_issues(conn, spec)
    written = store.upsert_issues(conn, issues) if issues else 0
    closed = _close_stale_issues(conn, spec, started)
    return {
        "linked_algo_orders": linked,
        "manual_orders": manual,
        "issues_open": written,
        "issues_closed": closed,
    }


def _link_algo_orders(conn, spec: AccountSpec) -> int:
    """Attach broker orders to the algo execution that produced them."""
    total = 0
    with conn.cursor() as cur:
        for column in ("broker_order_id", "exit_broker_order_id"):
            cur.execute(
                f"""
                UPDATE {store.ORDERS_TABLE} o
                   SET source = 'algo',
                       algo_execution_id = e.execution_id,
                       algo_source_order_id = e.source_order_id,
                       updated_at = NOW()
                  FROM {store.EXECUTIONS_TABLE} e
                 WHERE o.broker = %s
                   AND o.broker_account = %s
                   AND LOWER(e.broker) = LOWER(o.broker)
                   AND NULLIF(TRIM(e.{column}), '') IS NOT NULL
                   AND TRIM(e.{column}) = o.broker_order_id
                   AND (o.source IS DISTINCT FROM 'algo'
                        OR o.algo_execution_id IS DISTINCT FROM e.execution_id)
                """,
                (spec.broker, spec.broker_account),
            )
            total += cur.rowcount or 0
    conn.commit()
    return total


def _mark_manual_orders(conn, spec: AccountSpec) -> int:
    """Anything the algo never claimed was placed by hand on the same account."""
    with conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE {store.ORDERS_TABLE}
               SET source = 'manual', updated_at = NOW()
             WHERE broker = %s AND broker_account = %s
               AND algo_execution_id IS NULL
               AND source <> 'manual'
            """,
            (spec.broker, spec.broker_account),
        )
        count = cur.rowcount or 0
    conn.commit()
    return count


def _collect_issues(conn, spec: AccountSpec) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    now = datetime.now().astimezone()
    params = (spec.broker, spec.broker_account)

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        # Coverage floor: never flag executions from before this account's first
        # synced trading day, or every pre-sync execution would look missing.
        cur.execute(
            f"SELECT MIN(trade_date) AS floor_date FROM {store.ORDERS_TABLE} WHERE broker = %s AND broker_account = %s",
            params,
        )
        row = cur.fetchone()
        floor_date = row["floor_date"] if row else None
        if floor_date is None:
            return issues

        # 1. The algo says it placed an order the broker has no record of.
        cur.execute(
            f"""
            SELECT e.execution_id::text, e.broker_order_id, e.option_tradingsymbol,
                   e.status, e.created_at
              FROM {store.EXECUTIONS_TABLE} e
             WHERE LOWER(e.broker) = %s
               AND LOWER(COALESCE(e.broker_account, '')) = LOWER(%s)
               AND e.dry_run = FALSE
               AND NULLIF(TRIM(e.broker_order_id), '') IS NOT NULL
               AND (e.created_at AT TIME ZONE 'Asia/Kolkata')::date >= %s
               AND NOT EXISTS (
                   SELECT 1 FROM {store.ORDERS_TABLE} o
                    WHERE o.broker = e.broker
                      AND o.broker_account = %s
                      AND o.broker_order_id = TRIM(e.broker_order_id)
               )
            """,
            (spec.broker, spec.broker_account, floor_date, spec.broker_account),
        )
        for record in cur.fetchall():
            trade_date = N.trading_date(record["created_at"])
            issues.append(
                _issue(
                    spec, now,
                    issue_type="execution_missing_at_broker",
                    severity="error",
                    key=str(record["execution_id"]),
                    trade_date=trade_date,
                    broker_order_id=record["broker_order_id"],
                    execution_id=record["execution_id"],
                    tradingsymbol=record["option_tradingsymbol"],
                    message=(
                        f"Algo execution {record['execution_id']} recorded broker order "
                        f"{record['broker_order_id']} but the broker order book has no such order."
                    ),
                    details={"execution_status": record["status"]},
                )
            )

        # 2. The broker rejected an order the algo still believes it placed.
        cur.execute(
            f"""
            SELECT o.broker_order_id, o.trade_date, o.tradingsymbol, o.reject_reason,
                   o.algo_execution_id::text AS algo_execution_id, e.status AS execution_status
              FROM {store.ORDERS_TABLE} o
              JOIN {store.EXECUTIONS_TABLE} e ON e.execution_id = o.algo_execution_id
             WHERE o.broker = %s AND o.broker_account = %s
               AND o.status = 'REJECTED'
               AND LOWER(e.status) IN ('placed', 'submitted_pending', 'submitted_unknown')
            """,
            params,
        )
        for record in cur.fetchall():
            issues.append(
                _issue(
                    spec, now,
                    issue_type="broker_rejected_but_execution_open",
                    severity="error",
                    key=str(record["broker_order_id"]),
                    trade_date=record["trade_date"],
                    broker_order_id=record["broker_order_id"],
                    execution_id=record["algo_execution_id"],
                    tradingsymbol=record["tradingsymbol"],
                    message=(
                        f"Broker rejected order {record['broker_order_id']} "
                        f"({record['reject_reason'] or 'no reason given'}) but the algo execution "
                        f"is still marked {record['execution_status']}."
                    ),
                    details={"reject_reason": record["reject_reason"]},
                )
            )

        # 3. Fill price disagreement between the algo's record and the broker's.
        cur.execute(
            f"""
            SELECT o.broker_order_id, o.trade_date, o.tradingsymbol, o.average_price,
                   o.algo_execution_id::text AS algo_execution_id,
                   COALESCE(
                       NULLIF(e.broker_response ->> 'average_traded_price', '')::numeric,
                       NULLIF(e.broker_response ->> 'averageprice', '')::numeric,
                       NULLIF(e.broker_response ->> 'average_price', '')::numeric
                   ) AS execution_price
              FROM {store.ORDERS_TABLE} o
              JOIN {store.EXECUTIONS_TABLE} e ON e.execution_id = o.algo_execution_id
             WHERE o.broker = %s AND o.broker_account = %s
               AND o.status = 'COMPLETE'
               AND o.average_price IS NOT NULL
               AND o.average_price > 0
            """,
            params,
        )
        for record in cur.fetchall():
            recorded = record["execution_price"]
            broker_price = record["average_price"]
            if recorded is None or broker_price in (None, 0):
                continue
            gap = abs(float(recorded) - float(broker_price)) / float(broker_price)
            if gap <= PRICE_TOLERANCE:
                continue
            issues.append(
                _issue(
                    spec, now,
                    issue_type="fill_price_mismatch",
                    severity="warning",
                    key=str(record["broker_order_id"]),
                    trade_date=record["trade_date"],
                    broker_order_id=record["broker_order_id"],
                    execution_id=record["algo_execution_id"],
                    tradingsymbol=record["tradingsymbol"],
                    message=(
                        f"Order {record['broker_order_id']}: algo recorded {float(recorded):.2f}, "
                        f"broker confirmed {float(broker_price):.2f} ({gap * 100:.2f}% apart)."
                    ),
                    details={"algo_price": float(recorded), "broker_price": float(broker_price), "gap_pct": round(gap * 100, 4)},
                )
            )

        # 4. Live exposure on the account that the algo did not open.
        cur.execute(
            f"""
            SELECT p.trade_date, p.tradingsymbol, p.net_quantity, p.product
              FROM {store.POSITIONS_TABLE} p
             WHERE p.broker = %s AND p.broker_account = %s
               AND p.position_type = 'OPEN'
               AND p.trade_date = (
                   SELECT MAX(trade_date) FROM {store.POSITIONS_TABLE}
                    WHERE broker = %s AND broker_account = %s
               )
               AND NOT EXISTS (
                   SELECT 1 FROM {store.ORDERS_TABLE} o
                    WHERE o.broker = p.broker
                      AND o.broker_account = p.broker_account
                      AND o.tradingsymbol = p.tradingsymbol
                      AND o.source = 'algo'
               )
            """,
            (spec.broker, spec.broker_account, spec.broker, spec.broker_account),
        )
        for record in cur.fetchall():
            issues.append(
                _issue(
                    spec, now,
                    issue_type="manual_open_position",
                    severity="info",
                    key=f"{record['trade_date']}:{record['tradingsymbol']}",
                    trade_date=record["trade_date"],
                    tradingsymbol=record["tradingsymbol"],
                    message=(
                        f"Open position {record['tradingsymbol']} "
                        f"({record['net_quantity']} qty, {record['product'] or 'n/a'}) was not opened by the algo."
                    ),
                    details={"net_quantity": float(record["net_quantity"] or 0)},
                )
            )

    return issues


def _issue(
    spec: AccountSpec,
    now: datetime,
    *,
    issue_type: str,
    severity: str,
    key: str,
    message: str,
    trade_date=None,
    broker_order_id=None,
    execution_id=None,
    tradingsymbol=None,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "issue_uid": N.stable_uid(spec.broker, spec.broker_account, issue_type, key),
        "broker": spec.broker,
        "broker_account": spec.broker_account,
        "trade_date": trade_date,
        "issue_type": issue_type,
        "severity": severity,
        "broker_order_id": broker_order_id,
        "execution_id": execution_id,
        "tradingsymbol": tradingsymbol,
        "message": message,
        "details": details or {},
        "resolved": False,
        "last_seen_at": now,
    }


def _close_stale_issues(conn, spec: AccountSpec, started: datetime) -> int:
    """Close issues this pass no longer observes."""
    with conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE {store.ISSUES_TABLE}
               SET resolved = TRUE
             WHERE broker = %s AND broker_account = %s
               AND resolved = FALSE
               AND last_seen_at < %s
            """,
            (spec.broker, spec.broker_account, started),
        )
        count = cur.rowcount or 0
    conn.commit()
    return count
