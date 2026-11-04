"""Dhan v2 REST adapter.

Reuses ``realtime_execution/dhan_api.py`` for the IPv4-pinned transport and the
automatic access-token refresh, so this sync inherits the same token handling
the live order lane already relies on.

Unlike Angel One and Groww, Dhan does expose history:
  * ``GET /trades/{from-date}/{to-date}/{page}`` — trade history with charges
  * ``GET /ledger?from-date&to-date``            — ledger / funds movement
Those two are fetched from the watermark forward; everything else is day scoped.
"""

from __future__ import annotations

import os
import time
from datetime import date, datetime, timedelta
from typing import Any

import normalize as N
from sync_config import RANGE_CHUNK_DAYS, ensure_automation_on_path

from .base import BrokerAdapter


MAX_HISTORY_PAGES = 50
# Dhan meters its statement endpoints; a 90-day backfill is a burst from one run.
HISTORY_REQUEST_DELAY_SECONDS = float(os.getenv("DHAN_HISTORY_DELAY_SECONDS", "0.5"))


def _list(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        for key in ("data", "orders", "trades", "positions"):
            nested = payload.get(key)
            if isinstance(nested, list):
                return [row for row in nested if isinstance(row, dict)]
        # A single-object response (fundlimit) is still one row.
        if payload and not payload.get("errorType"):
            return [payload]
    return []


def _history_end(end: date) -> date:
    """Clamp a history window to the last completed day.

    Dhan's dated endpoints answer about days that are done. Today's activity
    comes from the day-scoped /trades and /positions instead, so including today
    in a range adds nothing and makes the request fail.
    """
    today = N.today_ist()
    return min(end, today - timedelta(days=1))


class DhanAdapter(BrokerAdapter):
    broker = "dhan"

    def __init__(self, spec) -> None:
        super().__init__(spec)
        self._api = None

    def login(self) -> Any:
        ensure_automation_on_path()
        import dhan_api  # type: ignore

        # Mints or refreshes the access token if it is close to expiry.
        expiry = dhan_api.ensure_fresh_access_token()
        self.token_expires_at = expiry
        self._api = dhan_api
        return dhan_api

    def _get(self, path: str, *, retries: int = 1) -> Any:
        api = self.ensure_client()
        last: tuple[int, Any] = (0, None)
        for attempt in range(retries + 1):
            status, response = api.request_json("GET", path)
            if 200 <= status < 300:
                return response
            last = (status, response)
            # Retry server-side failures only. A 4xx is our fault and will not
            # get better by asking again.
            if status < 500 or attempt == retries:
                break
            time.sleep(2)
        status, response = last
        message = response.get("errorMessage") if isinstance(response, dict) else response
        raise RuntimeError(f"Dhan GET /{path} failed: HTTP {status}: {message or '(no message)'}")

    # ------------------------------------------------------------ orders ---
    def fetch_orders(self, since: datetime | None) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for raw in _list(self._get("orders")):
            order_id = N.first_text(raw, "orderId", "orderid")
            if not order_id:
                continue
            order_ts = N.to_timestamp(N.first(raw, "createTime", "exchangeTime", "updateTime"))
            status = N.normalise_status(N.first(raw, "orderStatus", "status"))
            quantity = N.first_float(raw, "quantity")
            remaining = N.first_float(raw, "remainingQuantity")
            filled = N.first_float(raw, "filledQty", "filled_qty")
            if filled is None and quantity is not None and remaining is not None:
                filled = quantity - remaining
            rows.append(
                self.order_row(
                    broker_order_id=order_id,
                    raw=raw,
                    exchange_order_id=N.first_text(raw, "exchangeOrderId"),
                    trade_date=N.trading_date(order_ts, N.first(raw, "createTime", "exchangeTime")),
                    status=status,
                    status_raw=N.first_text(raw, "orderStatus"),
                    reject_reason=N.first_text(raw, "omsErrorDescription", "omsErrorCode") if status == N.REJECTED else None,
                    exchange=_exchange_from_segment(N.first_text(raw, "exchangeSegment")),
                    segment=N.first_text(raw, "exchangeSegment"),
                    tradingsymbol=N.first_text(raw, "tradingSymbol", "customSymbol"),
                    option_type=N.normalise_option_type(N.first(raw, "drvOptionType")),
                    strike=N.first_float(raw, "drvStrikePrice"),
                    expiry_date=N.to_date(N.first(raw, "drvExpiryDate")),
                    security_id=N.first_text(raw, "securityId"),
                    product=N.normalise_product(N.first(raw, "productType")),
                    order_type=N.first_text(raw, "orderType"),
                    side=N.normalise_side(N.first(raw, "transactionType")),
                    validity=N.first_text(raw, "validity"),
                    quantity=quantity,
                    filled_quantity=filled,
                    pending_quantity=remaining,
                    price=N.first_float(raw, "price"),
                    trigger_price=N.first_float(raw, "triggerPrice"),
                    average_price=N.first_float(raw, "averageTradedPrice"),
                    order_ts=order_ts,
                    exchange_ts=N.to_timestamp(N.first(raw, "exchangeTime")),
                    broker_updated_ts=N.to_timestamp(N.first(raw, "updateTime")),
                )
            )
        return rows

    # ------------------------------------------------------------ trades ---
    def fetch_trades(self, since: datetime | None, *, start: date, end: date) -> list[dict[str, Any]]:
        # The day trade book IS the dataset -- if this fails, the day was not
        # captured and that is a real failure.
        rows = [self._trade_row(raw, historical=False) for raw in _list(self._get("trades"))]
        rows = [row for row in rows if row]

        # Trade history covers the gap since the watermark, including days the
        # daily job may have missed (machine off, token expired, holiday shift).
        seen = {row["trade_uid"] for row in rows}
        window_errors: list[str] = []
        windows = 0
        history_end = _history_end(end)
        for window_start, window_end in (
            N.day_range(start, history_end, RANGE_CHUNK_DAYS) if start <= history_end else []
        ):
            windows += 1
            time.sleep(HISTORY_REQUEST_DELAY_SECONDS)
            for page in range(MAX_HISTORY_PAGES):
                path = f"trades/{window_start.isoformat()}/{window_end.isoformat()}/{page}"
                try:
                    payload = self._get(path)
                except RuntimeError as exc:
                    # An empty window answers 4xx on some Dhan builds, so a
                    # single failure is not fatal -- but every window failing is,
                    # and must not look like "no trades in this period".
                    if page == 0:
                        window_errors.append(f"{window_start}..{window_end}: {exc}")
                    break
                page_rows = _list(payload)
                if not page_rows:
                    break
                for raw in page_rows:
                    row = self._trade_row(raw, historical=True)
                    if row and row["trade_uid"] not in seen:
                        seen.add(row["trade_uid"])
                        rows.append(row)
                if len(page_rows) < 100:
                    break
        # Backfilling older days is a bonus on top of that. Losing it leaves a
        # gap that the next run re-requests -- the watermark only advances over
        # rows actually retrieved -- so it degrades the run rather than failing
        # it. Dhan's statement endpoints appear to go down during its overnight
        # batch window, which would otherwise fail every night-time retry slot.
        if window_errors:
            self.warn(
                f"trade history incomplete for {len(window_errors)}/{windows} window(s); "
                f"the gap will be re-requested on the next run -> " + "; ".join(window_errors[:2])
            )
        return rows

    def _trade_row(self, raw: dict[str, Any], *, historical: bool) -> dict[str, Any] | None:
        order_id = N.first_text(raw, "orderId")
        reported_id = N.first_text(raw, "exchangeTradeId", "tradeId")
        # Dhan's trade history returns exchangeTradeId "0" for older fills, so
        # every fill on the same order would collapse onto one row. Fall back to
        # a fingerprint of the fill itself: still deterministic, so a re-fetch
        # updates the same row rather than adding a duplicate.
        trade_id = reported_id if reported_id not in (None, "", "0") else None
        trade_ts = N.to_timestamp(N.first(raw, "exchangeTime", "createTime", "updateTime"))
        if not order_id and not trade_id:
            return None
        fingerprint = trade_id or ":".join(
            str(part or "")
            for part in (
                trade_ts.isoformat() if trade_ts else "nots",
                N.first(raw, "transactionType"),
                N.first(raw, "tradedQuantity", "quantity"),
                N.first(raw, "tradedPrice", "price"),
            )
        )
        charges = {
            key: N.to_float(raw.get(key))
            for key in ("sebiTax", "stt", "brokerageCharges", "serviceTax", "exchangeTransactionCharges", "stampDuty")
            if raw.get(key) is not None
        }
        taxes = sum(value for key, value in charges.items() if key != "brokerageCharges" and value)
        brokerage = charges.get("brokerageCharges")
        return self.trade_row(
            trade_key=f"{order_id or 'noorder'}:{fingerprint}",
            raw=raw,
            broker_order_id=order_id,
            broker_trade_id=N.first_text(raw, "tradeId"),
            exchange_trade_id=trade_id,
            trade_date=N.trading_date(trade_ts, N.first(raw, "exchangeTime", "createTime")),
            tradingsymbol=N.first_text(raw, "tradingSymbol", "customSymbol"),
            exchange=_exchange_from_segment(N.first_text(raw, "exchangeSegment")),
            segment=N.first_text(raw, "exchangeSegment"),
            security_id=N.first_text(raw, "securityId"),
            instrument_type=N.first_text(raw, "instrument"),
            option_type=N.normalise_option_type(N.first(raw, "drvOptionType")),
            strike=N.first_float(raw, "drvStrikePrice"),
            expiry_date=N.to_date(N.first(raw, "drvExpiryDate")),
            product=N.normalise_product(N.first(raw, "productType")),
            order_type=N.first_text(raw, "orderType"),
            side=N.normalise_side(N.first(raw, "transactionType")),
            quantity=N.first_float(raw, "tradedQuantity", "quantity"),
            price=N.first_float(raw, "tradedPrice", "price"),
            trade_ts=trade_ts,
            brokerage=brokerage,
            taxes=round(taxes, 6) if historical and taxes else None,
            charges_total=round(sum(value for value in charges.values() if value), 6) if charges else None,
            charges=charges or None,
        )

    # --------------------------------------------------------- positions ---
    def fetch_positions(self, since: datetime | None) -> list[dict[str, Any]]:
        today = N.today_ist()
        rows: list[dict[str, Any]] = []
        for raw in _list(self._get("positions")):
            symbol = N.first_text(raw, "tradingSymbol")
            if not symbol:
                continue
            net_qty = N.first_float(raw, "netQty")
            row = self.position_row(
                trade_date=today,
                tradingsymbol=symbol,
                product=N.normalise_product(N.first(raw, "productType")),
                raw=raw,
                exchange=_exchange_from_segment(N.first_text(raw, "exchangeSegment")),
                segment=N.first_text(raw, "exchangeSegment"),
                security_id=N.first_text(raw, "securityId"),
                option_type=N.normalise_option_type(N.first(raw, "drvOptionType")),
                strike=N.first_float(raw, "drvStrikePrice"),
                expiry_date=N.to_date(N.first(raw, "drvExpiryDate")),
                net_quantity=net_qty,
                buy_quantity=N.first_float(raw, "buyQty"),
                sell_quantity=N.first_float(raw, "sellQty"),
                buy_avg_price=N.first_float(raw, "buyAvg"),
                sell_avg_price=N.first_float(raw, "sellAvg"),
                average_price=N.first_float(raw, "costPrice"),
                realized_pnl=N.first_float(raw, "realizedProfit"),
                unrealized_pnl=N.first_float(raw, "unrealizedProfit"),
                multiplier=N.first_float(raw, "multiplier"),
            )
            # Dhan states this outright, so trust it over the net-quantity guess.
            declared = str(N.first(raw, "positionType") or "").upper()
            if declared == "CLOSED":
                row["position_type"] = "CLOSED"
            elif declared in {"LONG", "SHORT"}:
                row["position_type"] = "OPEN"
            rows.append(row)
        return rows

    # ------------------------------------------------------------- funds ---
    def fetch_funds(self, since: datetime | None) -> list[dict[str, Any]]:
        payload = _list(self._get("fundlimit"))
        if not payload:
            return []
        raw = payload[0]
        return [
            self.funds_row(
                trade_date=N.today_ist(),
                raw=raw,
                # "availabelBalance" is Dhan's own spelling; both are accepted.
                available_cash=N.first_float(raw, "availabelBalance", "availableBalance"),
                opening_balance=N.first_float(raw, "sodLimit"),
                utilised_margin=N.first_float(raw, "utilizedAmount", "utilisedAmount"),
                collateral=N.first_float(raw, "collateralAmount"),
                withdrawable_balance=N.first_float(raw, "withdrawableBalance"),
                net_balance=N.first_float(raw, "availabelBalance", "availableBalance"),
            )
        ]

    # ------------------------------------------------------------ ledger ---
    def fetch_ledger(self, since: datetime | None, *, start: date, end: date) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        seen: set[str] = set()
        window_errors: list[str] = []
        windows = 0
        history_end = _history_end(end)
        for window_start, window_end in (
            N.day_range(start, history_end, RANGE_CHUNK_DAYS) if start <= history_end else []
        ):
            windows += 1
            time.sleep(HISTORY_REQUEST_DELAY_SECONDS)
            path = f"ledger?from-date={window_start.isoformat()}&to-date={window_end.isoformat()}"
            try:
                payload = self._get(path)
            except RuntimeError as exc:
                window_errors.append(f"{window_start}..{window_end}: {exc}")
                continue
            for raw in _list(payload):
                entry_date = N.to_date(N.first(raw, "voucherdate", "voucherDate"))
                if not entry_date:
                    continue
                voucher = N.first_text(raw, "vouchernumber", "voucherNumber") or ""
                narration = N.first_text(raw, "narration", "voucherdesc") or ""
                debit = N.first_float(raw, "debit") or 0.0
                credit = N.first_float(raw, "credit") or 0.0
                entry_key = f"{entry_date.isoformat()}:{voucher}:{debit}:{credit}:{narration[:80]}"
                uid = N.stable_uid(self.spec.broker, self.spec.broker_account, entry_key)
                if uid in seen:
                    continue
                seen.add(uid)
                rows.append(
                    self.ledger_row(
                        entry_key=entry_key,
                        entry_date=entry_date,
                        raw=raw,
                        posting_ts=N.to_timestamp(N.first(raw, "voucherdate")),
                        voucher_number=voucher or None,
                        voucher_type=N.first_text(raw, "voucherdesc", "voucherType"),
                        narration=narration or None,
                        exchange=N.first_text(raw, "exchange"),
                        debit=debit,
                        credit=credit,
                        running_balance=N.first_float(raw, "runbal", "runningBalance"),
                    )
                )
        # An empty ledger is a legitimate answer; an unreachable one is not, and
        # the two must never look the same on the dashboard.
        # An empty ledger is a legitimate answer; an unreachable one is not, and
        # the two must never look the same on the dashboard.
        if window_errors and len(window_errors) == windows:
            raise RuntimeError("Dhan ledger unavailable -> " + "; ".join(window_errors[:3]))
        if window_errors:
            self.warn(f"ledger incomplete for {len(window_errors)}/{windows} window(s) -> " + "; ".join(window_errors[:2]))
        return rows


_SEGMENT_EXCHANGE = {
    "NSE_EQ": "NSE", "NSE_FNO": "NFO", "NSE_CURRENCY": "CDS",
    "BSE_EQ": "BSE", "BSE_FNO": "BFO", "BSE_CURRENCY": "BCD",
    "MCX_COMM": "MCX", "IDX_I": "IDX",
}


def _exchange_from_segment(segment: str | None) -> str | None:
    if not segment:
        return None
    return _SEGMENT_EXCHANGE.get(segment.strip().upper(), segment.strip().upper())
