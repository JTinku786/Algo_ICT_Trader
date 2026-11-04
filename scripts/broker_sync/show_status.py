#!/usr/bin/env python3
"""Print what the broker-truth tables currently hold.

Run it after a sync to confirm rows actually landed, and any time you want to
know how fresh each account is without opening the website.

    python show_status.py
"""

from __future__ import annotations

import sys
from pathlib import Path

RUNTIME_ROOT = Path(__file__).resolve().parent
if str(RUNTIME_ROOT) not in sys.path:
    sys.path.insert(0, str(RUNTIME_ROOT))

from psycopg2.extras import RealDictCursor  # noqa: E402

import store  # noqa: E402


COUNT_TABLES = (
    ("orders", store.ORDERS_TABLE),
    ("trades", store.TRADES_TABLE),
    ("positions", store.POSITIONS_TABLE),
    ("funds", store.FUNDS_TABLE),
    ("ledger", store.LEDGER_TABLE),
)


def main() -> int:
    conn = store.connect()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT relname FROM pg_class WHERE relkind = 'r' AND relname LIKE 'realtime_production_broker_%'"
            )
            present = {row["relname"] for row in cur.fetchall()}
            if store.ORDERS_TABLE not in present:
                print("Broker-truth tables do not exist yet.")
                print("Run:  python sync_broker_accounts.py --schema-only")
                return 1

            print("ROW COUNTS")
            print("-" * 72)
            for label, table in COUNT_TABLES:
                cur.execute(f"SELECT COUNT(*)::bigint AS rows FROM {table}")
                total = cur.fetchone()["rows"]
                cur.execute(f"SELECT COUNT(DISTINCT (broker, broker_account))::int AS accounts FROM {table}")
                accounts = cur.fetchone()["accounts"]
                print(f"  {label:<10} {total:>10,} rows across {accounts} account(s)")

            print()
            print("FRESHNESS (max update time per dataset; rows = cumulative since first sync)")
            print("-" * 72)
            cur.execute(
                f"""
                SELECT broker, broker_account, dataset, last_trade_date, last_status,
                       last_success_at, rows_total, last_error
                  FROM {store.WATERMARKS_TABLE}
                 ORDER BY broker, broker_account, dataset
                """
            )
            rows = cur.fetchall()
            if not rows:
                print("  No sync has run yet.")
            for row in rows:
                account = f"{row['broker']}/{row['broker_account']}"
                if len(account) > 36:
                    account = account[:35] + "\u2026"
                print(
                    f"  {account:<36} {row['dataset']:<10} through {str(row['last_trade_date'] or '-'):<12}"
                    f" {row['last_status']:<12} {row['rows_total']:>8,} rows"
                )
                if row["last_error"]:
                    print(f"      ! {row['last_error'][:120]}")

            print()
            print("OPEN RECONCILIATION ISSUES")
            print("-" * 72)
            cur.execute(
                f"""
                SELECT severity, issue_type, COUNT(*)::int AS count
                  FROM {store.ISSUES_TABLE}
                 WHERE resolved = FALSE
                 GROUP BY severity, issue_type
                 ORDER BY count DESC
                """
            )
            issues = cur.fetchall()
            if not issues:
                print("  None. Broker records and algo records agree.")
            for row in issues:
                print(f"  {row['severity']:<9} {row['issue_type']:<38} {row['count']:>5}")

            print()
            print("LATEST DAY PER ACCOUNT")
            print("-" * 72)
            cur.execute(
                f"""
                SELECT broker, broker_account, MAX(trade_date) AS latest,
                       COUNT(*) FILTER (WHERE position_type = 'OPEN' AND trade_date = (
                           SELECT MAX(trade_date) FROM {store.POSITIONS_TABLE} p2
                            WHERE p2.broker = p.broker AND p2.broker_account = p.broker_account
                       ))::int AS open_positions
                  FROM {store.POSITIONS_TABLE} p
                 GROUP BY broker, broker_account
                 ORDER BY broker, broker_account
                """
            )
            for row in cur.fetchall():
                label = f"{row['broker']}/{row['broker_account']}"
                print(
                    f"  {label:<36} latest {row['latest']}"
                    f"  ·  {row['open_positions']} open position(s)"
                )
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
