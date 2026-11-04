"""Groww Trade API adapter.

Reuses ``realtime_execution/groww_config.py`` for the TOTP login and the cached
access token, so the sync never mints a second session unnecessarily.

Groww's REST surface is day scoped and segment scoped: order list, positions and
margin are all fetched per segment (FNO and CASH) for the current session. There
is no ledger endpoint, and trade-level fills are only reachable per order, so
this adapter asks for fills on the orders that actually traded and falls back to
the order's own average fill price when the SDK build has no trade endpoint.
"""

from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Any

import normalize as N
from sync_config import ensure_automation_on_path

from .base import BrokerAdapter, DatasetUnsupported


LOGGER = logging.getLogger("broker_sync.groww")

SEGMENTS = ("FNO", "CASH")
# Groww documents page_size as defaulting to 25 and does not promise to honour a
# larger value, so never treat a short page as the end of the list.
PAGE_SIZE = 25
MAX_PAGES = 200


def _unwrap(payload: Any, *keys: str) -> Any:
    """Groww nests results under a payload envelope on some SDK versions."""
    if not isinstance(payload, dict):
        return payload
    for key in keys:
        if isinstance(payload.get(key), (list, dict)):
            return payload[key]
    nested = payload.get("payload")
    if isinstance(nested, dict):
        for key in keys:
            if isinstance(nested.get(key), (list, dict)):
                return nested[key]
        return nested
    return payload


def _rows(payload: Any, *keys: str) -> list[dict[str, Any]]:
    value = _unwrap(payload, *keys)
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    return []


class GrowwAdapter(BrokerAdapter):
    broker = "groww"

    def login(self) -> Any:
        ensure_automation_on_path()
        import groww_config  # type: ignore

        client = groww_config.login_groww()
        # TOTP-minted Groww tokens do not publish an expiry; the config module
        # re-mints on its own TTL, so leave token_expires_at unset rather than
        # showing the dashboard a number we cannot prove.
        self.token_expires_at = None
        return client

    def _call(self, name: str, **kwargs: Any) -> Any:
        client = self.ensure_client()
        method = getattr(client, name, None)
        if method is None:
            raise DatasetUnsupported(f"Groww SDK has no {name}()")
        return method(**kwargs)

    # ------------------------------------------------------------ orders ---
    def fetch_orders(self, since: datetime | None) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        errors: list[str] = []
        for segment in SEGMENTS:
            try:
                rows.extend(self._orders_for_segment(segment))
            except Exception as exc:  # noqa: BLE001 - one segment must not hide the other
                errors.append(f"{segment}: {exc}")
        if errors and not rows:
            raise RuntimeError("; ".join(errors))
        if errors:
            self.login_error = "; ".join(errors)[:300]
        return rows

    def _orders_for_segment(self, segment: str) -> list[dict[str, Any]]:
        """Page until the list is exhausted.

        Stops on an empty page, or on a page that adds no new order id -- some
        APIs clamp an out-of-range page index and re-serve the last one forever.
        A short page is NOT an end signal, because Groww may return fewer rows
        than requested.
        """
        collected: list[dict[str, Any]] = []
        seen: set[str] = set()
        for page in range(MAX_PAGES):
            response = self._call("get_order_list", segment=segment, page=page, page_size=PAGE_SIZE)
            page_rows = _rows(response, "order_list", "orders")
            if not page_rows:
                break
            fresh = [
                row for row in page_rows
                if str(row.get("groww_order_id") or row.get("order_id") or "") not in seen
            ]
            if not fresh:
                break
            for row in fresh:
                identifier = str(row.get("groww_order_id") or row.get("order_id") or "")
                if identifier:
                    seen.add(identifier)
            collected.extend(fresh)
        else:
            LOGGER.warning(
                "Groww %s order list hit the %s page cap; there may be more history.",
                segment, MAX_PAGES,
            )

        rows: list[dict[str, Any]] = []
        for raw in collected:
            order_id = N.first_text(raw, "groww_order_id", "order_id", "orderId")
            if not order_id:
                continue
            order_ts = N.to_timestamp(N.first(raw, "created_at", "exchange_time", "order_timestamp"))
            status = N.normalise_status(N.first(raw, "order_status", "status"))
            quantity = N.first_float(raw, "quantity")
            filled = N.first_float(raw, "filled_quantity")
            remaining = N.first_float(raw, "remaining_quantity")
            if remaining is None and quantity is not None and filled is not None:
                remaining = quantity - filled
            rows.append(
                self.order_row(
                    broker_order_id=order_id,
                    raw={**raw, "_segment": segment},
                    exchange_order_id=N.first_text(raw, "exchange_order_id", "order_reference_id"),
                    trade_date=N.trading_date(order_ts, N.first(raw, "trade_date", "created_at")),
                    status=status,
                    status_raw=N.first_text(raw, "order_status"),
                    reject_reason=N.first_text(raw, "remark", "rejection_reason") if status == N.REJECTED else None,
                    exchange=N.first_text(raw, "exchange"),
                    segment=segment,
                    tradingsymbol=N.first_text(raw, "trading_symbol", "tradingsymbol"),
                    security_id=N.first_text(raw, "symbol_isin", "isin"),
                    product=N.normalise_product(N.first(raw, "product")),
                    order_type=N.first_text(raw, "order_type"),
                    side=N.normalise_side(N.first(raw, "transaction_type")),
                    validity=N.first_text(raw, "validity"),
                    quantity=quantity,
                    filled_quantity=filled,
                    pending_quantity=remaining,
                    price=N.first_float(raw, "price"),
                    trigger_price=N.first_float(raw, "trigger_price"),
                    average_price=N.first_float(raw, "average_fill_price", "average_price"),
                    order_ts=order_ts,
                    exchange_ts=N.to_timestamp(N.first(raw, "exchange_time")),
                    broker_updated_ts=N.to_timestamp(N.first(raw, "updated_at", "exchange_time", "created_at")),
                )
            )
        return rows

    # ------------------------------------------------------------ trades ---
    def fetch_trades(self, since: datetime | None, *, start: date, end: date) -> list[dict[str, Any]]:
        """Fills for orders that actually traded today.

        Groww has no account-wide trade book, so this walks the orders that
        reported a fill. When the installed SDK exposes a per-order trade list we
        use the real fills; otherwise we record one derived fill from the order's
        own broker-confirmed average price and flag it in ``raw`` so nothing
        downstream mistakes it for an exchange trade record.
        """
        rows: list[dict[str, Any]] = []
        for order in self.fetch_orders(since):
            filled = order.get("filled_quantity") or 0
            if not filled or order.get("status") not in {N.COMPLETE, N.PARTIAL}:
                continue
            order_id = order["broker_order_id"]
            segment = (order.get("raw") or {}).get("_segment") or "FNO"
            fills = self._order_fills(order_id, segment)
            if fills:
                for index, raw in enumerate(fills):
                    trade_ts = N.to_timestamp(N.first(raw, "trade_time", "exchange_time", "created_at"))
                    trade_id = N.first_text(raw, "trade_id", "exchange_trade_id") or f"fill{index}"
                    rows.append(
                        self.trade_row(
                            trade_key=f"{order_id}:{trade_id}",
                            raw={**raw, "_segment": segment},
                            broker_order_id=order_id,
                            broker_trade_id=N.first_text(raw, "trade_id"),
                            exchange_trade_id=N.first_text(raw, "exchange_trade_id"),
                            trade_date=N.trading_date(trade_ts, order.get("trade_date")),
                            tradingsymbol=order.get("tradingsymbol"),
                            exchange=order.get("exchange"),
                            segment=segment,
                            security_id=order.get("security_id"),
                            product=order.get("product"),
                            order_type=order.get("order_type"),
                            side=order.get("side"),
                            quantity=N.first_float(raw, "quantity", "traded_quantity"),
                            price=N.first_float(raw, "price", "traded_price"),
                            trade_ts=trade_ts or order.get("order_ts"),
                        )
                    )
                continue

            rows.append(
                self.trade_row(
                    trade_key=f"{order_id}:derived",
                    raw={"_derived_from": "order_average_fill_price", "_segment": segment, "order": order.get("raw", {})},
                    broker_order_id=order_id,
                    trade_date=order.get("trade_date"),
                    tradingsymbol=order.get("tradingsymbol"),
                    exchange=order.get("exchange"),
                    segment=segment,
                    security_id=order.get("security_id"),
                    product=order.get("product"),
                    order_type=order.get("order_type"),
                    side=order.get("side"),
                    quantity=filled,
                    price=order.get("average_price"),
                    trade_ts=order.get("broker_updated_ts") or order.get("order_ts"),
                )
            )
        return rows

    def _order_fills(self, order_id: str, segment: str) -> list[dict[str, Any]]:
        client = self.ensure_client()
        for name in ("get_trade_list_for_order", "get_trades_for_order", "get_trade_list"):
            method = getattr(client, name, None)
            if method is None:
                continue
            for kwargs in ({"segment": segment, "groww_order_id": order_id}, {"groww_order_id": order_id}):
                try:
                    return _rows(method(**kwargs), "trade_list", "trades")
                except TypeError:
                    continue
                except Exception:
                    return []
        return []

    # --------------------------------------------------------- positions ---
    def fetch_positions(self, since: datetime | None) -> list[dict[str, Any]]:
        today = N.today_ist()
        rows: list[dict[str, Any]] = []
        errors: list[str] = []
        for segment in SEGMENTS:
            try:
                payload = self._call("get_positions_for_user", segment=segment)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{segment}: {exc}")
                continue
            for raw in _rows(payload, "positions"):
                symbol = N.first_text(raw, "trading_symbol", "tradingsymbol")
                if not symbol:
                    continue
                # Groww credits a buy into the position and debits a sell out of it.
                buy_qty = N.first_float(raw, "credit_quantity") or 0.0
                sell_qty = N.first_float(raw, "debit_quantity") or 0.0
                carry_buy = N.first_float(raw, "carry_forward_credit_quantity") or 0.0
                carry_sell = N.first_float(raw, "carry_forward_debit_quantity") or 0.0
                net_qty = N.first_float(raw, "quantity", "net_quantity")
                if net_qty is None:
                    net_qty = (buy_qty + carry_buy) - (sell_qty + carry_sell)
                rows.append(
                    self.position_row(
                        trade_date=today,
                        tradingsymbol=symbol,
                        product=N.normalise_product(N.first(raw, "product")),
                        raw={**raw, "_segment": segment},
                        exchange=N.first_text(raw, "exchange"),
                        segment=segment,
                        security_id=N.first_text(raw, "symbol_isin", "isin"),
                        net_quantity=net_qty,
                        buy_quantity=buy_qty + carry_buy,
                        sell_quantity=sell_qty + carry_sell,
                        buy_avg_price=N.first_float(raw, "credit_price", "carry_forward_credit_price"),
                        sell_avg_price=N.first_float(raw, "debit_price", "carry_forward_debit_price"),
                        average_price=N.first_float(raw, "net_price"),
                        realized_pnl=N.first_float(raw, "realised_pnl", "realized_pnl"),
                        unrealized_pnl=N.first_float(raw, "unrealised_pnl", "unrealized_pnl"),
                    )
                )
        if errors and not rows:
            raise RuntimeError("; ".join(errors))
        if errors:
            self.login_error = "; ".join(errors)[:300]
        return rows

    # ------------------------------------------------------------- funds ---
    def fetch_funds(self, since: datetime | None) -> list[dict[str, Any]]:
        payload = self._call("get_available_margin_details")
        raw = _unwrap(payload, "margin_details", "margins")
        if not isinstance(raw, dict) or not raw:
            return []
        return [
            self.funds_row(
                trade_date=N.today_ist(),
                raw=raw,
                available_cash=N.first_float(raw, "clear_cash", "available_cash", "net_available_margin"),
                net_balance=N.first_float(raw, "net_margin_available", "clear_cash", "available_cash"),
                utilised_margin=N.first_float(raw, "net_margin_used", "used_margin", "margin_used"),
                collateral=N.first_float(raw, "collateral_available", "collateral_used"),
                withdrawable_balance=N.first_float(raw, "withdrawable_balance", "clear_cash"),
            )
        ]

    # ------------------------------------------------------------ ledger ---
    def fetch_ledger(self, since: datetime | None, *, start: date, end: date) -> list[dict[str, Any]]:
        raise DatasetUnsupported(
            "The Groww Trade API exposes no ledger or funds-statement endpoint. "
            "Charges for this account have to come from the Groww contract note."
        )
