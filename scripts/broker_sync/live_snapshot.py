"""Realtime broker snapshot for the Account Management live view.

The website runs on Vercel and has neither the broker credentials nor the
whitelisted IP, so the live view is served by the local REST bridge
(``backend/rest_api.py``), which calls into this module.

Two caches keep this cheap enough to poll:

  * the broker session is reused for ``SESSION_TTL_SECONDS`` — logging in to
    Angel One or Groww costs a TOTP round trip and must not happen per request
  * the snapshot itself is memoised for ``SNAPSHOT_TTL_SECONDS`` so several open
    browser tabs share one broker call

Every snapshot is also written through to the broker-truth tables at most once
per ``PERSIST_INTERVAL_SECONDS``, so the historical view stays current during
the session instead of jumping only at the daily sync.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any

RUNTIME_ROOT = Path(__file__).resolve().parent
if str(RUNTIME_ROOT) not in sys.path:
    sys.path.insert(0, str(RUNTIME_ROOT))

import normalize as N  # noqa: E402
import store  # noqa: E402
from sync_config import AccountSpec, load_accounts  # noqa: E402
from brokers import BrokerUnavailable, build_adapter  # noqa: E402
from brokers.base import DatasetUnsupported  # noqa: E402


LOGGER = logging.getLogger("broker_sync.live")

SESSION_TTL_SECONDS = int(os.getenv("BROKER_LIVE_SESSION_TTL", "1800"))
SNAPSHOT_TTL_SECONDS = int(os.getenv("BROKER_LIVE_SNAPSHOT_TTL", "10"))
PERSIST_INTERVAL_SECONDS = int(os.getenv("BROKER_LIVE_PERSIST_INTERVAL", "300"))

_lock = threading.Lock()
_sessions: dict[str, dict[str, Any]] = {}
_snapshot_cache: dict[str, Any] = {"key": None, "at": 0.0, "payload": None}
_last_persist: dict[str, float] = {}


def _adapter_for(spec: AccountSpec):
    """Reuse a logged-in adapter until its session TTL expires."""
    entry = _sessions.get(spec.key)
    now = time.time()
    if entry and now < entry["expires_at"]:
        return entry["adapter"]
    if entry:
        try:
            entry["adapter"].close()
        except Exception:  # noqa: BLE001
            pass
    adapter = build_adapter(spec)
    adapter.ensure_client()
    _sessions[spec.key] = {"adapter": adapter, "expires_at": now + SESSION_TTL_SECONDS}
    return adapter


def invalidate_sessions() -> None:
    """Drop cached broker sessions; the next call logs in again."""
    with _lock:
        for entry in _sessions.values():
            try:
                entry["adapter"].close()
            except Exception:  # noqa: BLE001
                pass
        _sessions.clear()
        _snapshot_cache.update({"key": None, "at": 0.0, "payload": None})


def _safe(fetch, default):
    try:
        return fetch(), None
    except DatasetUnsupported as exc:
        return default, f"unsupported: {exc}"
    except Exception as exc:  # noqa: BLE001 - a broken dataset must not blank the view
        return default, str(exc)[:300]


def _account_snapshot(spec: AccountSpec, *, persist_conn=None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": f"{spec.broker}:{spec.broker_account}:{spec.environment}",
        "broker": spec.broker,
        "broker_account": spec.broker_account,
        "broker_client_id": spec.broker_client_id,
        "display_name": spec.display_name,
        "customer_key": spec.customer_key,
        "environment": spec.environment,
        "strategies": list(spec.strategies),
        "risk_config": spec.risk_config,
        "auth_status": "unverified",
        "errors": {},
        "positions": [],
        "orders": [],
        "funds": None,
    }

    try:
        adapter = _adapter_for(spec)
    except BrokerUnavailable as exc:
        result["auth_status"] = "auth_failed"
        result["errors"]["login"] = str(exc)[:300]
        return result

    result["auth_status"] = adapter.auth_status
    result["token_expires_at"] = adapter.token_expires_at.isoformat() if adapter.token_expires_at else None

    positions, position_error = _safe(lambda: adapter.fetch_positions(None), [])
    orders, order_error = _safe(lambda: adapter.fetch_orders(None), [])
    funds_rows, funds_error = _safe(lambda: adapter.fetch_funds(None), [])
    for name, error in (("positions", position_error), ("orders", order_error), ("funds", funds_error)):
        if error:
            result["errors"][name] = error

    today = N.today_ist()
    open_positions = [row for row in positions if row.get("position_type") == "OPEN"]
    closed_today = [row for row in positions if row.get("position_type") == "CLOSED"]
    working = [row for row in orders if row.get("is_open")]
    rejected_today = [
        row for row in orders
        if row.get("status") == N.REJECTED and _as_date(row.get("trade_date")) == today
    ]

    result["positions"] = [_public_position(row) for row in positions]
    result["orders"] = [_public_order(row) for row in orders]
    result["funds"] = _public_funds(funds_rows[0]) if funds_rows else None
    result["totals"] = {
        "open_positions": len(open_positions),
        "closed_positions_today": len(closed_today),
        "working_orders": len(working),
        "rejected_today": len(rejected_today),
        "orders_today": sum(1 for row in orders if _as_date(row.get("trade_date")) == today),
        "realized_pnl": _sum(positions, "realized_pnl"),
        "unrealized_pnl": _sum(open_positions, "unrealized_pnl"),
    }
    result["totals"]["total_pnl"] = round(
        (result["totals"]["realized_pnl"] or 0) + (result["totals"]["unrealized_pnl"] or 0), 2
    )

    if persist_conn is not None and _should_persist(spec.key):
        try:
            if positions:
                store.upsert_positions(persist_conn, positions)
            if orders:
                store.upsert_orders(persist_conn, orders)
            if funds_rows:
                store.upsert_funds(persist_conn, funds_rows)
            _last_persist[spec.key] = time.time()
        except Exception as exc:  # noqa: BLE001 - the live view must still render
            result["errors"]["persist"] = str(exc)[:300]
            LOGGER.warning("live snapshot persist failed for %s: %s", spec.key, exc)

    return result


def _should_persist(key: str) -> bool:
    return (time.time() - _last_persist.get(key, 0.0)) >= PERSIST_INTERVAL_SECONDS


def _as_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return N.to_date(value)


def _sum(rows: list[dict[str, Any]], key: str) -> float:
    total = sum(float(row.get(key) or 0) for row in rows)
    return round(total, 2)


def _iso(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def _num(value: Any) -> float | None:
    return None if value is None else float(value)


def _public_position(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "tradingsymbol": row.get("tradingsymbol"),
        "underlying": row.get("underlying"),
        "exchange": row.get("exchange"),
        "segment": row.get("segment"),
        "product": row.get("product"),
        "option_type": row.get("option_type"),
        "strike": _num(row.get("strike")),
        "expiry_date": _iso(row.get("expiry_date")),
        "position_type": row.get("position_type"),
        "net_quantity": _num(row.get("net_quantity")),
        "buy_quantity": _num(row.get("buy_quantity")),
        "sell_quantity": _num(row.get("sell_quantity")),
        "buy_avg_price": _num(row.get("buy_avg_price")),
        "sell_avg_price": _num(row.get("sell_avg_price")),
        "last_price": _num(row.get("last_price")),
        "realized_pnl": _num(row.get("realized_pnl")),
        "unrealized_pnl": _num(row.get("unrealized_pnl")),
        "total_pnl": _num(row.get("total_pnl")),
        "trade_date": _iso(row.get("trade_date")),
    }


def _public_order(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "broker_order_id": row.get("broker_order_id"),
        "tradingsymbol": row.get("tradingsymbol"),
        "underlying": row.get("underlying"),
        "exchange": row.get("exchange"),
        "product": row.get("product"),
        "side": row.get("side"),
        "order_type": row.get("order_type"),
        "status": row.get("status"),
        "status_raw": row.get("status_raw"),
        "is_open": row.get("is_open"),
        "reject_reason": row.get("reject_reason"),
        "quantity": _num(row.get("quantity")),
        "filled_quantity": _num(row.get("filled_quantity")),
        "pending_quantity": _num(row.get("pending_quantity")),
        "price": _num(row.get("price")),
        "trigger_price": _num(row.get("trigger_price")),
        "average_price": _num(row.get("average_price")),
        "order_ts": _iso(row.get("order_ts")),
        "trade_date": _iso(row.get("trade_date")),
        "source": row.get("source", "unknown"),
    }


def _public_funds(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "available_cash": _num(row.get("available_cash")),
        "opening_balance": _num(row.get("opening_balance")),
        "utilised_margin": _num(row.get("utilised_margin")),
        "collateral": _num(row.get("collateral")),
        "withdrawable_balance": _num(row.get("withdrawable_balance")),
        "net_balance": _num(row.get("net_balance")),
        "realized_pnl": _num(row.get("realized_pnl")),
        "unrealized_pnl": _num(row.get("unrealized_pnl")),
        "trade_date": _iso(row.get("trade_date")),
    }


def live_snapshot(
    *,
    brokers: tuple[str, ...] | None = None,
    accounts: tuple[str, ...] | None = None,
    persist: bool = True,
    force: bool = False,
) -> dict[str, Any]:
    """Fetch the current state of every configured broker account."""
    cache_key = f"{brokers}|{accounts}|{persist}"
    with _lock:
        cached = _snapshot_cache
        if (
            not force
            and cached["payload"] is not None
            and cached["key"] == cache_key
            and (time.time() - cached["at"]) < SNAPSHOT_TTL_SECONDS
        ):
            return {**cached["payload"], "cached": True}

        specs = load_accounts(brokers)
        if accounts:
            wanted = {value.lower() for value in accounts}
            specs = [spec for spec in specs if spec.key.lower() in wanted]

        conn = None
        if persist and specs:
            try:
                conn = store.connect()
            except Exception as exc:  # noqa: BLE001 - live view works without the DB
                LOGGER.warning("live snapshot could not open Postgres: %s", exc)

        try:
            results = [_account_snapshot(spec, persist_conn=conn) for spec in specs]
        finally:
            if conn is not None:
                conn.close()

        payload = {
            "generated_at": datetime.now().astimezone().isoformat(),
            "snapshot_ttl_seconds": SNAPSHOT_TTL_SECONDS,
            "accounts": results,
            "summary": {
                "accounts": len(results),
                "reachable": sum(1 for item in results if item["auth_status"] == "verified"),
                "open_positions": sum((item.get("totals") or {}).get("open_positions", 0) for item in results),
                "working_orders": sum((item.get("totals") or {}).get("working_orders", 0) for item in results),
                "rejected_today": sum((item.get("totals") or {}).get("rejected_today", 0) for item in results),
                "realized_pnl": round(sum((item.get("totals") or {}).get("realized_pnl", 0) or 0 for item in results), 2),
                "unrealized_pnl": round(sum((item.get("totals") or {}).get("unrealized_pnl", 0) or 0 for item in results), 2),
                "available_cash": round(
                    sum(((item.get("funds") or {}).get("available_cash") or 0) for item in results), 2
                ),
            },
        }
        payload["summary"]["total_pnl"] = round(
            payload["summary"]["realized_pnl"] + payload["summary"]["unrealized_pnl"], 2
        )
        _snapshot_cache.update({"key": cache_key, "at": time.time(), "payload": payload})
        return {**payload, "cached": False}


def _cli(argv: list[str] | None = None) -> int:
    """Print one snapshot as JSON on stdout.

    This is what the website invokes. Every diagnostic goes to stderr so stdout
    stays parseable, and a failure still emits JSON so the caller never has to
    guess at a non-zero exit.
    """
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Print a live broker snapshot as JSON.")
    parser.add_argument("--brokers", nargs="*", default=None)
    parser.add_argument("--accounts", nargs="*", default=None)
    parser.add_argument("--no-persist", action="store_true", help="Do not write the snapshot to Postgres.")
    parser.add_argument("--force", action="store_true", help="Ignore the in-process snapshot cache.")
    parser.add_argument("--indent", type=int, default=None)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )

    try:
        payload = live_snapshot(
            brokers=tuple(args.brokers) if args.brokers else None,
            accounts=tuple(args.accounts) if args.accounts else None,
            persist=not args.no_persist,
            force=args.force,
        )
        payload["success"] = True
    except Exception as exc:  # noqa: BLE001 - always answer in JSON
        LOGGER.exception("live snapshot failed")
        payload = {
            "success": False,
            "error": f"{type(exc).__name__}: {exc}",
            "generated_at": datetime.now().astimezone().isoformat(),
            "accounts": [],
            "summary": {},
        }

    json.dump(payload, sys.stdout, indent=args.indent, default=str)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0 if payload.get("success") else 1


if __name__ == "__main__":
    raise SystemExit(_cli())
