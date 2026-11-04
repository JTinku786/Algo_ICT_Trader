#!/usr/bin/env python3
"""Daily broker-truth sync for Angel One, Dhan and Groww.

Pulls what each broker actually holds — orders (including rejected ones with the
reject reason), fills, open and closed positions, funds and, where the broker
offers it, the ledger — into the ``realtime_production_broker_*`` tables that the
Account Management page reads.

Each broker/account/dataset carries its own watermark, so every run resumes from
the maximum update time already stored and never re-pulls a window it holds.

Typical use:

    python sync_broker_accounts.py                     # all accounts, all datasets
    python sync_broker_accounts.py --brokers groww     # one broker
    python sync_broker_accounts.py --datasets orders trades
    python sync_broker_accounts.py --dry-run           # fetch and report, write nothing
    python sync_broker_accounts.py --backfill-days 180 # widen the first-run window

Exit code is 0 when every enabled dataset succeeded or was legitimately
unsupported, and 1 when at least one dataset failed — so cron can alert on it.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import traceback
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

RUNTIME_ROOT = Path(__file__).resolve().parent
if str(RUNTIME_ROOT) not in sys.path:
    sys.path.insert(0, str(RUNTIME_ROOT))

import normalize as N  # noqa: E402
import store  # noqa: E402
from sync_config import DATASETS, DEFAULT_BACKFILL_DAYS, OPTIONAL_DATASETS, AccountSpec, load_accounts  # noqa: E402
from brokers import BrokerUnavailable, build_adapter  # noqa: E402
from brokers.base import DatasetUnsupported  # noqa: E402
from reconcile import reconcile_account  # noqa: E402


LOGGER = logging.getLogger("broker_sync")

# Which table each dataset writes to, and which column carries its record time.
_WRITERS = {
    "orders": (store.upsert_orders, ("broker_updated_ts", "order_ts"), "trade_date"),
    "trades": (store.upsert_trades, ("trade_ts",), "trade_date"),
    "positions": (store.upsert_positions, ("snapshot_at",), "trade_date"),
    "funds": (store.upsert_funds, ("snapshot_at",), "trade_date"),
    "ledger": (store.upsert_ledger, ("posting_ts",), "entry_date"),
}

# Datasets that accept a date range. The rest are day scoped at the broker.
_RANGED = {"trades", "ledger"}


def _max_value(rows: list[dict[str, Any]], keys: tuple[str, ...]):
    best = None
    for row in rows:
        for key in keys:
            value = row.get(key)
            if value is None:
                continue
            if best is None or value > best:
                best = value
            break
    return best


def _window(watermark: dict[str, Any] | None, backfill_days: int, today: date) -> tuple[date, date]:
    """Date range to request for a ranged dataset.

    Starts one day before the last stored trading date so a day that was still
    settling when we last looked gets refreshed rather than frozen half-written.
    """
    last_date = (watermark or {}).get("last_trade_date")
    if isinstance(last_date, datetime):
        last_date = last_date.date()
    if isinstance(last_date, date):
        start = max(last_date - timedelta(days=1), today - timedelta(days=max(backfill_days, 1)))
    else:
        start = today - timedelta(days=max(backfill_days, 1))
    return min(start, today), today


def sync_account(
    conn,
    spec: AccountSpec,
    *,
    datasets: tuple[str, ...],
    backfill_days: int,
    dry_run: bool,
    reconcile: bool,
) -> dict[str, Any]:
    today = N.today_ist()
    result: dict[str, Any] = {
        "broker": spec.broker,
        "account": spec.broker_account,
        "display_name": spec.display_name,
        "auth_status": "unverified",
        "datasets": {},
        "errors": [],
    }

    adapter = build_adapter(spec)
    try:
        adapter.ensure_client()
    except BrokerUnavailable as exc:
        result["auth_status"] = "auth_failed"
        result["errors"].append(str(exc))
        LOGGER.error("%s: %s", spec.key, exc)
        if not dry_run:
            store.register_account(conn, spec, auth_status="auth_failed")
            for dataset in datasets:
                store.set_watermark(
                    conn, spec.broker, spec.broker_account, dataset,
                    status="auth_failed", error=str(exc)[:500],
                )
        return result

    result["auth_status"] = adapter.auth_status
    result["token_expires_at"] = adapter.token_expires_at.isoformat() if adapter.token_expires_at else None
    if not dry_run:
        store.register_account(
            conn, spec, auth_status=adapter.auth_status, token_expires_at=adapter.token_expires_at
        )

    try:
        for dataset in datasets:
            if dataset not in spec.datasets:
                continue
            result["datasets"][dataset] = _sync_dataset(
                conn, adapter, spec, dataset,
                backfill_days=backfill_days, dry_run=dry_run, today=today,
            )
    finally:
        adapter.close()

    if reconcile and not dry_run:
        try:
            result["reconciliation"] = reconcile_account(conn, spec)
        except Exception as exc:  # noqa: BLE001 - reconcile must not lose synced data
            result["errors"].append(f"reconcile: {exc}")
            LOGGER.exception("%s: reconcile failed", spec.key)

    return result


def _sync_dataset(
    conn,
    adapter,
    spec: AccountSpec,
    dataset: str,
    *,
    backfill_days: int,
    dry_run: bool,
    today: date,
) -> dict[str, Any]:
    watermark = None if dry_run else store.get_watermark(conn, spec.broker, spec.broker_account, dataset)
    since = (watermark or {}).get("last_record_ts")
    start, end = _window(watermark, backfill_days, today)

    run_id = None
    if not dry_run:
        run_id = store.start_run(
            conn, spec.broker, spec.broker_account, dataset,
            window_start=datetime.combine(start, datetime.min.time()).astimezone() if dataset in _RANGED else None,
            window_end=datetime.combine(end, datetime.max.time()).astimezone() if dataset in _RANGED else None,
        )

    summary: dict[str, Any] = {"status": "success", "fetched": 0, "written": 0}
    if dataset in _RANGED:
        summary["window"] = [start.isoformat(), end.isoformat()]

    try:
        adapter.begin_fetch()
        if dataset == "orders":
            rows = adapter.fetch_orders(since)
        elif dataset == "trades":
            rows = adapter.fetch_trades(since, start=start, end=end)
        elif dataset == "positions":
            rows = adapter.fetch_positions(since)
        elif dataset == "funds":
            rows = adapter.fetch_funds(since)
        elif dataset == "ledger":
            rows = adapter.fetch_ledger(since, start=start, end=end)
        else:
            raise DatasetUnsupported(dataset)

        summary["fetched"] = len(rows)
        # Incomplete but usable: keep the rows, flag the run.
        if adapter.warnings:
            summary["status"] = "degraded"
            summary["warnings"] = list(adapter.warnings)
        writer, ts_keys, date_key = _WRITERS[dataset]

        if dry_run:
            summary["written"] = 0
            summary["sample"] = _sample(rows)
        else:
            summary["written"] = writer(conn, rows)
            last_ts = _max_value(rows, ts_keys)
            last_day = _max_value(rows, (date_key,))
            store.set_watermark(
                conn, spec.broker, spec.broker_account, dataset,
                status=summary["status"],
                error="; ".join(adapter.warnings)[:500] if adapter.warnings else None,
                last_record_ts=last_ts,
                last_trade_date=last_day if isinstance(last_day, date) else None,
                rows_added=summary["written"],
                cursor_payload={"window_start": start.isoformat(), "window_end": end.isoformat()},
            )
            store.finish_run(
                conn, run_id, status=summary["status"],
                rows_fetched=summary["fetched"], rows_written=summary["written"],
                error="; ".join(adapter.warnings)[:500] if adapter.warnings else None,
            )
        if adapter.warnings:
            LOGGER.warning("%s %s: %s rows (degraded: %s)", spec.key, dataset, summary["fetched"], adapter.warnings[0])
        else:
            LOGGER.info("%s %s: %s rows", spec.key, dataset, summary["fetched"])

    except DatasetUnsupported as exc:
        # Not a failure: this broker genuinely has no such API. Recorded so the
        # dashboard can say "no ledger for Angel One" instead of showing zero.
        summary = {"status": "unsupported", "fetched": 0, "written": 0, "reason": str(exc)}
        LOGGER.info("%s %s: unsupported (%s)", spec.key, dataset, exc)
        if not dry_run:
            store.set_watermark(
                conn, spec.broker, spec.broker_account, dataset,
                status="unsupported", error=str(exc)[:500],
            )
            store.finish_run(conn, run_id, status="unsupported", error=str(exc)[:500])

    except Exception as exc:  # noqa: BLE001 - one dataset must not kill the run
        summary = {"status": "failed", "fetched": 0, "written": 0, "error": str(exc)[:500]}
        LOGGER.error("%s %s failed: %s", spec.key, dataset, exc)
        LOGGER.debug("%s", traceback.format_exc())
        if not dry_run:
            # A failed statement leaves the connection in an aborted
            # transaction; clear it before trying to record the failure.
            store.safe_rollback(conn)
            try:
                store.set_watermark(
                    conn, spec.broker, spec.broker_account, dataset,
                    status="failed", error=str(exc)[:500],
                )
                store.finish_run(conn, run_id, status="failed", error=str(exc)[:500])
            except Exception as bookkeeping_error:  # noqa: BLE001
                store.safe_rollback(conn)
                LOGGER.error("%s %s: could not record the failure: %s", spec.key, dataset, bookkeeping_error)

    return summary


def _sample(rows: list[dict[str, Any]], limit: int = 3) -> list[dict[str, Any]]:
    """A few rows with the raw payload stripped, for --dry-run inspection."""
    out = []
    for row in rows[:limit]:
        out.append({key: _jsonable(value) for key, value in row.items() if key != "raw"})
    return out


def _jsonable(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sync broker truth into Postgres.")
    parser.add_argument("--brokers", nargs="*", default=None, help="Limit to these brokers (angel_one dhan groww).")
    parser.add_argument("--accounts", nargs="*", default=None, help="Limit to these broker:account keys.")
    parser.add_argument("--datasets", nargs="*", default=list(DATASETS), choices=list(DATASETS))
    parser.add_argument("--backfill-days", type=int, default=DEFAULT_BACKFILL_DAYS)
    parser.add_argument("--dry-run", action="store_true", help="Fetch and report without writing.")
    parser.add_argument("--no-reconcile", action="store_true", help="Skip the algo/manual reconcile pass.")
    parser.add_argument("--schema-only", action="store_true", help="Create the tables and exit.")
    parser.add_argument("--json-out", default=None, help="Write the run summary to this path.")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    started = datetime.now().astimezone()
    conn = store.connect()
    try:
        store.apply_schema(conn)
        if args.schema_only:
            LOGGER.info("Schema applied.")
            return 0

        specs = load_accounts(tuple(args.brokers) if args.brokers else None)
        if args.accounts:
            wanted = {value.lower() for value in args.accounts}
            specs = [spec for spec in specs if spec.key.lower() in wanted]
        if not specs:
            LOGGER.error("No broker accounts resolved. Check ICT_AUTOMATION_ROOT and the broker configs.")
            return 1

        results = [
            sync_account(
                conn, spec,
                datasets=tuple(args.datasets),
                backfill_days=args.backfill_days,
                dry_run=args.dry_run,
                reconcile=not args.no_reconcile,
            )
            for spec in specs
        ]
    finally:
        conn.close()

    failed_datasets = [
        (item, name)
        for item in results
        for name, summary in item["datasets"].items()
        if summary.get("status") == "failed"
    ]
    # A required dataset failing means the day was not captured. An optional one
    # failing means the run is degraded but the trading record is intact.
    failures = [
        f"{item['broker']}:{item['account']}:{name}"
        for item, name in failed_datasets
        if name not in OPTIONAL_DATASETS
    ]
    degraded = [
        f"{item['broker']}:{item['account']}:{name}"
        for item, name in failed_datasets
        if name in OPTIONAL_DATASETS
    ]
    degraded += [
        f"{item['broker']}:{item['account']}:{name}"
        for item in results
        for name, summary in item["datasets"].items()
        if summary.get("status") == "degraded"
    ]
    failures += [f"{item['broker']}:{item['account']}:login" for item in results if item["auth_status"] == "auth_failed"]

    payload = {
        "started_at": started.isoformat(),
        "finished_at": datetime.now().astimezone().isoformat(),
        "dry_run": args.dry_run,
        "accounts": results,
        "failures": failures,
        "degraded": degraded,
        "ok": not failures,
    }
    text = json.dumps(_jsonable(payload), indent=2)
    if args.json_out:
        Path(args.json_out).write_text(text, encoding="utf-8")
    print(text)
    if degraded and not failures:
        LOGGER.warning("completed with degraded optional datasets: %s", ", ".join(degraded))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
