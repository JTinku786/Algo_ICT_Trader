#!/usr/bin/env python3
"""Rebuild broker history that the broker APIs cannot return.

Angel One and Groww only ever serve today: their order book, trade book and
position book reset at the daily rollover and there is no dated endpoint. Dhan
serves trade history and a ledger, but its order book and position book are also
day scoped. So a live sync alone can only ever accumulate history going forward.

This fills in the past from what is already on disk:

  1. ``realtime_production_broker_order_executions`` and
     ``realtime_production_broker_order_exit_events`` -- the algo's own audit
     trail, which carries the broker's order id and the broker-confirmed fill
     price for every entry and exit it ever placed.
  2. Every fill now in ``realtime_production_broker_trades`` (including Dhan's
     real trade history) run through an average-cost ledger to produce one
     position row per account, per day, per contract.

Nothing invents a number. Rows are stamped with ``source_feed`` so a
reconstructed row can never be mistaken for one the broker API returned, and the
upsert refuses to let a reconstructed row overwrite a live one.

    python backfill_history.py                 # report only, writes nothing
    python backfill_history.py --apply
    python backfill_history.py --apply --since 2026-01-01
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Any

RUNTIME_ROOT = Path(__file__).resolve().parent
if str(RUNTIME_ROOT) not in sys.path:
    sys.path.insert(0, str(RUNTIME_ROOT))

from psycopg2.extras import RealDictCursor  # noqa: E402

import normalize as N  # noqa: E402
import store  # noqa: E402


LOGGER = logging.getLogger("broker_sync.backfill")

AUDIT_FEED = "execution_audit"
DERIVED_FEED = "derived_trades"

# The audit table uses the pipeline's own status vocabulary, not a broker's.
_AUDIT_STATUS = {
    "placed": N.COMPLETE,
    "executed": N.COMPLETE,
    "complete": N.COMPLETE,
    "completed": N.COMPLETE,
    "filled": N.COMPLETE,
    "exited": N.COMPLETE,
    "exit_submitted": N.COMPLETE,
    "submitted_pending": N.PENDING,
    "exit_submitted_unknown": N.UNKNOWN,
    "submitted_unknown": N.UNKNOWN,
    "failed": N.REJECTED,
    "broker_rejected": N.REJECTED,
    "rejected": N.REJECTED,
    "cancelled": N.CANCELLED,
}

# Statuses that mean "we never actually sent this to a broker".
_NON_ORDERS = {"dry_run", "skipped", "suppressed", "blocked", "not_placed", ""}

_PRICE_PATHS = (
    ("average_traded_price",), ("averageprice",), ("averagePrice",),
    ("average_fill_price",), ("filled_price",), ("average_price",),
    ("orderbook_status", "averageprice"), ("orderbook_status", "price"),
    ("status_poll", "average_price"), ("status_poll", "averagePrice"),
    ("status_poll", "average_fill_price"),
)


def _obj(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _price(payload: Any) -> float | None:
    """Broker-confirmed average price, wherever this broker put it."""
    root = _obj(payload)
    for path in _PRICE_PATHS:
        current: Any = root
        for key in path:
            current = _obj(current).get(key)
        value = N.to_float(current)
        if value is not None and value > 0:
            return value
    return None


def _side(order_params: Any, default: str) -> str:
    params = _obj(order_params)
    for key in ("transactiontype", "transaction_type", "transactionType", "side"):
        if params.get(key):
            return N.normalise_side(params[key]) or default
    return default


def _status(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    if text in _NON_ORDERS:
        return None
    return _AUDIT_STATUS.get(text) or N.normalise_status(text)


# --------------------------------------------------------------- loading ----
EXECUTIONS_SQL = f"""
    SELECT execution_id::text, source_order_id::text, broker, broker_account, symbol, underlying,
           option_tradingsymbol, option_symboltoken, option_exchange, option_type, option_strike,
           option_expiry, producttype, quantity, lots, lotsize, order_params, broker_order_id,
           broker_response, status, error, created_at,
           exit_status, exit_reason, exit_broker_order_id, exit_response, exit_price, exit_at
      FROM {store.EXECUTIONS_TABLE}
     WHERE dry_run = FALSE
       AND created_at >= %s
     ORDER BY created_at
"""

EXIT_EVENTS_SQL = """
    SELECT exit_id::text, execution_id::text, source_order_id::text, broker, broker_account,
           symbol, option_tradingsymbol, option_symboltoken, option_exchange, producttype,
           broker_exit_order_id, quantity, order_params, broker_response, status, error,
           exit_reason, created_at
      FROM realtime_production_broker_order_exit_events
     WHERE dry_run = FALSE
       AND created_at >= %s
     ORDER BY created_at
"""

TRADES_SQL = f"""
    SELECT broker, broker_account, broker_client_id, trade_date, tradingsymbol, underlying,
           exchange, segment, security_id, option_type, strike, expiry_date, product,
           side, quantity, price, trade_ts, source_feed
      FROM {store.TRADES_TABLE}
     WHERE trade_date >= %s
     ORDER BY trade_date, trade_ts NULLS LAST
"""


def _identity(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "broker": str(row.get("broker") or "").lower(),
        "broker_account": row.get("broker_account") or "",
        "broker_client_id": None,
    }


def _uid(row: dict[str, Any], *parts: Any) -> str:
    return N.stable_uid(str(row.get("broker") or "").lower(), row.get("broker_account") or "", *parts)


def build_audit_rows(executions: list[dict[str, Any]], exit_events: list[dict[str, Any]]):
    """Turn the algo's audit trail into broker order and fill rows."""
    orders: dict[str, dict[str, Any]] = {}
    trades: dict[str, dict[str, Any]] = {}
    skipped = defaultdict(int)

    def add_order(base: dict[str, Any], *, broker_order_id: str, side: str, status: str,
                  price: float | None, quantity: float | None, when: Any, reject: str | None,
                  execution_id: str | None, source_order_id: str | None, raw: dict[str, Any]) -> None:
        order_ts = N.to_timestamp(when)
        trade_date = N.trading_date(order_ts, when)
        filled = quantity if status == N.COMPLETE else 0.0
        row = {
            **_identity(base),
            "order_uid": _uid(base, broker_order_id),
            "broker_order_id": str(broker_order_id),
            "trade_date": trade_date,
            "status": status,
            "status_raw": str(raw.get("status_raw") or "") or None,
            "is_open": status in N.LIVE_STATUSES,
            "reject_reason": reject,
            "exchange": base.get("option_exchange") or None,
            "tradingsymbol": base.get("option_tradingsymbol") or None,
            "underlying": base.get("underlying") or base.get("symbol") or None,
            "option_type": N.normalise_option_type(base.get("option_type")),
            "strike": N.to_float(base.get("option_strike")),
            "expiry_date": base.get("option_expiry"),
            "security_id": base.get("option_symboltoken") or None,
            "product": N.normalise_product(base.get("producttype")),
            "side": side,
            "quantity": N.to_float(quantity),
            "filled_quantity": N.to_float(filled),
            "average_price": price,
            "order_ts": order_ts,
            "broker_updated_ts": order_ts,
            "source": "algo",
            "source_feed": AUDIT_FEED,
            "algo_execution_id": execution_id,
            "algo_source_order_id": source_order_id,
            "raw": raw,
            "last_synced_at": datetime.now().astimezone(),
            "updated_at": datetime.now().astimezone(),
        }
        N.enrich_contract(row, row.get("tradingsymbol"))
        orders[row["order_uid"]] = row

        # A fill row only exists where the broker actually confirmed a price.
        if status == N.COMPLETE and price is not None and (quantity or 0) > 0:
            trade = {
                **_identity(base),
                "trade_uid": _uid(base, f"{broker_order_id}:audit"),
                "order_uid": row["order_uid"],
                "broker_order_id": str(broker_order_id),
                "trade_date": trade_date,
                "tradingsymbol": row["tradingsymbol"],
                "underlying": row["underlying"],
                "exchange": row["exchange"],
                "security_id": row["security_id"],
                "option_type": row["option_type"],
                "strike": row["strike"],
                "expiry_date": row["expiry_date"],
                "product": row["product"],
                "side": side,
                "quantity": N.to_float(quantity),
                "price": price,
                "trade_value": round(float(quantity) * float(price), 6),
                "trade_ts": order_ts,
                "source_feed": AUDIT_FEED,
                "raw": {"reconstructed_from": "broker_order_executions", "broker_order_id": str(broker_order_id)},
                "last_synced_at": datetime.now().astimezone(),
            }
            trades[trade["trade_uid"]] = trade

    for row in executions:
        entry_id = str(row.get("broker_order_id") or "").strip()
        status = _status(row.get("status"))
        if not entry_id:
            skipped["no_broker_order_id"] += 1
        elif status is None:
            skipped["not_a_real_order"] += 1
        else:
            add_order(
                row, broker_order_id=entry_id,
                side=_side(row.get("order_params"), "BUY"),
                status=status,
                price=_price(row.get("broker_response")),
                quantity=N.to_float(row.get("quantity")),
                when=row.get("created_at"),
                reject=(row.get("error") or None) if status == N.REJECTED else None,
                execution_id=row.get("execution_id"),
                source_order_id=row.get("source_order_id"),
                raw={"reconstructed_from": "broker_order_executions", "status_raw": row.get("status")},
            )

        exit_id = str(row.get("exit_broker_order_id") or "").strip()
        exit_status = _status(row.get("exit_status"))
        if exit_id and exit_status is not None:
            # exit_price alone is not trustworthy on legacy rows -- some hold the
            # underlying's spot price -- so only a broker exit payload counts.
            price = _price(row.get("exit_response"))
            if price is None and _obj(row.get("exit_response")):
                price = N.to_float(row.get("exit_price"))
            add_order(
                row, broker_order_id=exit_id, side="SELL", status=exit_status, price=price,
                quantity=N.to_float(row.get("quantity")),
                when=row.get("exit_at") or row.get("created_at"),
                reject=None, execution_id=row.get("execution_id"),
                source_order_id=row.get("source_order_id"),
                raw={"reconstructed_from": "broker_order_executions.exit", "status_raw": row.get("exit_status"),
                     "exit_reason": row.get("exit_reason")},
            )

    for row in exit_events:
        exit_id = str(row.get("broker_exit_order_id") or "").strip()
        status = _status(row.get("status"))
        if not exit_id or status is None:
            skipped["exit_event_unusable"] += 1
            continue
        base = {**row, "option_expiry": None, "option_strike": None, "option_type": None,
                "underlying": row.get("symbol")}
        add_order(
            base, broker_order_id=exit_id, side="SELL", status=status,
            price=_price(row.get("broker_response")),
            quantity=N.to_float(row.get("quantity")),
            when=row.get("created_at"),
            reject=(row.get("error") or None) if status == N.REJECTED else None,
            execution_id=row.get("execution_id"),
            source_order_id=row.get("source_order_id"),
            raw={"reconstructed_from": "broker_order_exit_events", "status_raw": row.get("status"),
                 "exit_reason": row.get("exit_reason")},
        )

    return list(orders.values()), list(trades.values()), dict(skipped)


# ------------------------------------------------------------- positions ----
def build_positions(trades: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Average-cost ledger over every fill -> one position row per day.

    Options here are bought and later sold, and a position can be carried
    overnight, so realised P&L has to be matched across days rather than netted
    within one. Each sell is realised against the running average cost, and the
    result is attributed to the day the sell happened -- which is what a broker's
    position book shows.
    """
    by_contract: dict[tuple, list[dict[str, Any]]] = defaultdict(list)
    for trade in trades:
        key = (
            str(trade.get("broker") or "").lower(),
            trade.get("broker_account") or "",
            trade.get("tradingsymbol") or "",
            N.normalise_product(trade.get("product")) or "-",
        )
        by_contract[key].append(trade)

    rows: list[dict[str, Any]] = []
    for (broker, account, symbol, product), fills in by_contract.items():
        if not symbol:
            continue
        fills.sort(key=lambda item: (item.get("trade_ts") or datetime.min, str(item.get("side") or "")))

        open_qty = 0.0
        avg_cost = 0.0
        days: dict[date, dict[str, Any]] = {}

        for fill in fills:
            quantity = N.to_float(fill.get("quantity")) or 0.0
            price = N.to_float(fill.get("price"))
            day = fill.get("trade_date")
            if isinstance(day, datetime):
                day = day.date()
            if not day or quantity <= 0 or price is None:
                continue
            bucket = days.setdefault(day, {
                "buy_qty": 0.0, "sell_qty": 0.0, "buy_value": 0.0, "sell_value": 0.0,
                "realized": 0.0, "feeds": set(), "sample": fill,
            })
            bucket["feeds"].add(fill.get("source_feed") or AUDIT_FEED)

            if (fill.get("side") or "").upper() == "SELL":
                matched = min(quantity, open_qty)
                bucket["realized"] += (price - avg_cost) * matched
                open_qty -= matched
                if open_qty <= 0:
                    open_qty = 0.0
                    avg_cost = 0.0
                bucket["sell_qty"] += quantity
                bucket["sell_value"] += quantity * price
            else:
                total = avg_cost * open_qty + price * quantity
                open_qty += quantity
                avg_cost = total / open_qty if open_qty else 0.0
                bucket["buy_qty"] += quantity
                bucket["buy_value"] += quantity * price

            bucket["net_after"] = open_qty

        for day, bucket in sorted(days.items()):
            net = bucket.get("net_after", 0.0)
            sample = bucket["sample"]
            feed = DERIVED_FEED if "broker_api" in bucket["feeds"] else AUDIT_FEED
            rows.append({
                "position_uid": N.stable_uid(broker, account, day.isoformat(), symbol, product),
                "broker": broker,
                "broker_account": account,
                "broker_client_id": sample.get("broker_client_id"),
                "trade_date": day,
                "tradingsymbol": symbol,
                "underlying": sample.get("underlying"),
                "exchange": sample.get("exchange"),
                "segment": sample.get("segment"),
                "security_id": sample.get("security_id"),
                "product": product if product != "-" else None,
                "option_type": N.normalise_option_type(sample.get("option_type")),
                "strike": N.to_float(sample.get("strike")),
                "expiry_date": sample.get("expiry_date"),
                "position_type": "OPEN" if net > 0 else "CLOSED",
                "net_quantity": round(net, 4),
                "buy_quantity": round(bucket["buy_qty"], 4),
                "sell_quantity": round(bucket["sell_qty"], 4),
                "buy_avg_price": round(bucket["buy_value"] / bucket["buy_qty"], 6) if bucket["buy_qty"] else None,
                "sell_avg_price": round(bucket["sell_value"] / bucket["sell_qty"], 6) if bucket["sell_qty"] else None,
                "realized_pnl": round(bucket["realized"], 6),
                "unrealized_pnl": None,
                "total_pnl": round(bucket["realized"], 6),
                "snapshot_at": datetime.now().astimezone(),
                "source_feed": feed,
                "raw": {"reconstructed_from": "average_cost_ledger", "feeds": sorted(bucket["feeds"])},
                "last_synced_at": datetime.now().astimezone(),
            })
    return rows


# ------------------------------------------------------------------ main ----
def _summarise(label: str, rows: list[dict[str, Any]], date_key: str) -> dict[str, Any]:
    by_account: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = f"{row['broker']}/{row['broker_account']}"
        item = by_account.setdefault(key, {"rows": 0, "earliest": None, "latest": None})
        item["rows"] += 1
        day = row.get(date_key)
        if isinstance(day, datetime):
            day = day.date()
        if isinstance(day, date):
            text = day.isoformat()
            if item["earliest"] is None or text < item["earliest"]:
                item["earliest"] = text
            if item["latest"] is None or text > item["latest"]:
                item["latest"] = text
    return {"dataset": label, "total": len(rows), "accounts": by_account}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Rebuild broker history the broker APIs cannot return.")
    parser.add_argument("--apply", action="store_true", help="Write. Without this it only reports.")
    parser.add_argument("--since", default="2000-01-01", help="Earliest date to reconstruct (YYYY-MM-DD).")
    parser.add_argument("--json-out", default=None)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    since = N.to_date(args.since) or date(2000, 1, 1)

    conn = store.connect()
    try:
        store.apply_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(EXECUTIONS_SQL, (since,))
            executions = [dict(row) for row in cur.fetchall()]
            try:
                cur.execute(EXIT_EVENTS_SQL, (since,))
                exit_events = [dict(row) for row in cur.fetchall()]
            except Exception as exc:  # noqa: BLE001 - table is optional
                store.safe_rollback(conn)
                LOGGER.warning("exit-events table unavailable (%s); continuing without it", exc)
                exit_events = []

        LOGGER.info("read %s executions and %s exit events since %s", len(executions), len(exit_events), since)
        orders, trades, skipped = build_audit_rows(executions, exit_events)
        LOGGER.info("reconstructed %s orders and %s fills from the audit trail", len(orders), len(trades))
        if skipped:
            LOGGER.info("skipped: %s", skipped)

        written = {"orders": 0, "trades": 0, "positions": 0}
        if args.apply:
            written["orders"] = store.upsert_orders(conn, orders)
            written["trades"] = store.upsert_trades(conn, trades)

        # Positions come from every fill on record, so Dhan's real trade history
        # produces real historical position rows too.
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(TRADES_SQL, (since,))
            stored_trades = [dict(row) for row in cur.fetchall()]
        all_trades = stored_trades if args.apply else stored_trades + trades
        positions = build_positions(all_trades)
        LOGGER.info("derived %s position rows from %s fills", len(positions), len(all_trades))
        if args.apply:
            written["positions"] = store.upsert_positions(conn, positions)
    finally:
        conn.close()

    payload = {
        "mode": "apply" if args.apply else "report",
        "since": since.isoformat(),
        "read": {"executions": len(executions), "exit_events": len(exit_events)},
        "skipped": skipped,
        "reconstructed": [
            _summarise("orders", orders, "trade_date"),
            _summarise("trades", trades, "trade_date"),
            _summarise("positions", positions, "trade_date"),
        ],
        "written": written if args.apply else None,
        "note": (
            "Reconstructed rows are stamped source_feed='execution_audit' (from the algo's own "
            "records) or 'derived_trades' (from broker-returned fills). Neither can overwrite a "
            "row the broker API returned."
        ),
    }
    text = json.dumps(payload, indent=2, default=str)
    if args.json_out:
        Path(args.json_out).write_text(text, encoding="utf-8")
    print(text)
    if not args.apply:
        print("\nReport only. Re-run with --apply to write these rows.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
