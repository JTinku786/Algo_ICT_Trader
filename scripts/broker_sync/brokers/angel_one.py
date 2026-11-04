"""Angel One SmartAPI adapter.

Reuses ``realtime_execution/angel_one_order_execution.py`` for credentials and
the TOTP login, so there is exactly one place where the Angel One secret lives.

SmartAPI's order book, trade book and position book are all *day scoped* — there
is no historical endpoint. That is why this sync has to run daily: each run
captures a day that can never be re-fetched later. The watermark therefore
records which trading days we already hold, and a gap is reported rather than
silently backfilled.
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import normalize as N
from sync_config import INDIA_TZ, ensure_automation_on_path

from .base import BrokerAdapter, DatasetUnsupported

LOGGER = logging.getLogger("broker_sync.angel_one")


def _rows(response: Any) -> list[dict[str, Any]]:
    """Unwrap SmartAPI's {"status": bool, "data": [...]} envelope."""
    if response is None:
        return []
    if isinstance(response, list):
        return [row for row in response if isinstance(row, dict)]
    if not isinstance(response, dict):
        return []
    if response.get("status") is False:
        message = response.get("message") or response.get("errorcode") or response
        raise RuntimeError(f"Angel One request failed: {message}")
    data = response.get("data")
    if data is None:
        return []
    if isinstance(data, dict):
        for key in ("positions", "net", "orders", "trades", "data"):
            nested = data.get(key)
            if isinstance(nested, list):
                return [row for row in nested if isinstance(row, dict)]
        return [data]
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    return []


class AngelOneAdapter(BrokerAdapter):
    broker = "angel_one"

    def login(self) -> Any:
        """Reuse a cached SmartAPI session when one is still good.

        A full login costs a TOTP round trip, and the live view spawns a fresh
        process on every refresh, so without this every click would re-authenticate
        against Angel One. The JWT stays valid until the 05:00 IST rollover, and
        SmartConnect can be rehydrated from it via setAccessToken.
        """
        ensure_automation_on_path()
        import angel_one_order_execution as angel  # type: ignore

        credentials = angel.AngelCredentials.from_script_config()

        cached = _read_session_cache(credentials.client_code)
        if cached:
            smart_api = _restore_session(credentials, cached)
            if smart_api is not None:
                self.token_expires_at = N.to_timestamp(cached.get("expiry"))
                return smart_api

        smart_api, login_response = angel.login_angel_one(credentials)
        data = (login_response or {}).get("data") or {}
        _write_session_cache(credentials.client_code, data)
        self.token_expires_at = N.to_timestamp(data.get("expiry")) if data.get("expiry") else None
        return smart_api

    def close(self) -> None:
        client = self.client
        self.client = None
        if client is None:
            return
        try:
            ensure_automation_on_path()
            import angel_one_order_execution as angel  # type: ignore

            client.terminateSession(angel.CLIENT_CODE)
        except Exception:
            pass

    # ------------------------------------------------------------ orders ---
    def fetch_orders(self, since: datetime | None) -> list[dict[str, Any]]:
        client = self.ensure_client()
        rows: list[dict[str, Any]] = []
        for raw in _rows(client.orderBook()):
            order_id = N.first_text(raw, "orderid", "orderId", "uniqueorderid")
            if not order_id:
                continue
            order_ts = N.to_timestamp(N.first(raw, "updatetime", "exchtime", "exchorderupdatetime"))
            trade_date = N.trading_date(order_ts, N.first(raw, "exchtime", "updatetime"))
            filled = N.first_float(raw, "filledshares", "filledQuantity")
            quantity = N.first_float(raw, "quantity", "qty")
            status = N.normalise_status(N.first(raw, "orderstatus", "status"))
            reject = N.first_text(raw, "text", "rejectionreason") if status == N.REJECTED else None
            rows.append(
                self.order_row(
                    broker_order_id=order_id,
                    raw=raw,
                    exchange_order_id=N.first_text(raw, "uniqueorderid", "exchangeorderid"),
                    parent_order_id=N.first_text(raw, "parentorderid"),
                    trade_date=trade_date,
                    status=status,
                    status_raw=N.first_text(raw, "orderstatus", "status"),
                    reject_reason=reject,
                    exchange=N.first_text(raw, "exchange"),
                    segment=N.first_text(raw, "exchange"),
                    tradingsymbol=N.first_text(raw, "tradingsymbol"),
                    instrument_type=N.first_text(raw, "instrumenttype"),
                    option_type=N.normalise_option_type(N.first(raw, "optiontype")),
                    strike=N.first_float(raw, "strikeprice"),
                    expiry_date=N.to_date(N.first(raw, "expirydate")),
                    security_id=N.first_text(raw, "symboltoken"),
                    product=N.normalise_product(N.first(raw, "producttype")),
                    order_type=N.first_text(raw, "ordertype"),
                    side=N.normalise_side(N.first(raw, "transactiontype")),
                    validity=N.first_text(raw, "duration"),
                    quantity=quantity,
                    filled_quantity=filled,
                    pending_quantity=N.first_float(raw, "unfilledshares"),
                    cancelled_quantity=N.first_float(raw, "cancelsize"),
                    price=N.first_float(raw, "price"),
                    trigger_price=N.first_float(raw, "triggerprice"),
                    average_price=N.first_float(raw, "averageprice"),
                    order_ts=order_ts,
                    exchange_ts=N.to_timestamp(N.first(raw, "exchtime")),
                    broker_updated_ts=N.to_timestamp(N.first(raw, "updatetime", "exchorderupdatetime")),
                )
            )
        return rows

    # ------------------------------------------------------------ trades ---
    def fetch_trades(self, since: datetime | None, *, start: date, end: date) -> list[dict[str, Any]]:
        # SmartAPI only exposes today's trade book; start/end are advisory.
        client = self.ensure_client()
        rows: list[dict[str, Any]] = []
        for raw in _rows(client.tradeBook()):
            order_id = N.first_text(raw, "orderid", "orderId")
            fill_id = N.first_text(raw, "fillid", "tradeid") or ""
            fill_time = N.to_timestamp(N.first(raw, "filltime", "tradetime"))
            trade_date = N.trading_date(fill_time)
            trade_key = f"{order_id or 'noorder'}:{fill_id or fill_time or len(rows)}"
            rows.append(
                self.trade_row(
                    trade_key=trade_key,
                    raw=raw,
                    broker_order_id=order_id,
                    broker_trade_id=fill_id or None,
                    trade_date=trade_date,
                    tradingsymbol=N.first_text(raw, "tradingsymbol"),
                    exchange=N.first_text(raw, "exchange"),
                    segment=N.first_text(raw, "exchange"),
                    security_id=N.first_text(raw, "symboltoken"),
                    instrument_type=N.first_text(raw, "instrumenttype"),
                    option_type=N.normalise_option_type(N.first(raw, "optiontype")),
                    strike=N.first_float(raw, "strikeprice"),
                    expiry_date=N.to_date(N.first(raw, "expirydate")),
                    product=N.normalise_product(N.first(raw, "producttype")),
                    side=N.normalise_side(N.first(raw, "transactiontype")),
                    quantity=N.first_float(raw, "fillsize", "quantity"),
                    price=N.first_float(raw, "fillprice", "price"),
                    trade_value=N.first_float(raw, "tradevalue"),
                    trade_ts=fill_time,
                )
            )
        return rows

    # --------------------------------------------------------- positions ---
    def fetch_positions(self, since: datetime | None) -> list[dict[str, Any]]:
        client = self.ensure_client()
        today = N.today_ist()
        rows: list[dict[str, Any]] = []
        for raw in _rows(client.position()):
            symbol = N.first_text(raw, "tradingsymbol", "symbolname")
            if not symbol:
                continue
            # Day leg + overnight leg. first() returns the first *non-empty*
            # value and Angel One sends "0" as a string, so asking for
            # buyqty-then-totalbuyqty always picked the day leg and silently
            # dropped the carry-forward quantity.
            buy_qty = _total_quantity(raw, "totalbuyqty", "buyqty", "cfbuyqty")
            sell_qty = _total_quantity(raw, "totalsellqty", "sellqty", "cfsellqty")
            net_qty = N.first_float(raw, "netqty")
            if net_qty is None:
                net_qty = buy_qty - sell_qty
            rows.append(
                self.position_row(
                    trade_date=today,
                    tradingsymbol=symbol,
                    product=N.normalise_product(N.first(raw, "producttype")),
                    raw=raw,
                    exchange=N.first_text(raw, "exchange"),
                    segment=N.first_text(raw, "exchange"),
                    security_id=N.first_text(raw, "symboltoken"),
                    instrument_type=N.first_text(raw, "instrumenttype"),
                    option_type=N.normalise_option_type(N.first(raw, "optiontype")),
                    strike=N.first_float(raw, "strikeprice"),
                    expiry_date=N.to_date(N.first(raw, "expirydate")),
                    net_quantity=net_qty,
                    buy_quantity=buy_qty,
                    sell_quantity=sell_qty,
                    buy_avg_price=_blended_price(raw, "totalbuyavgprice", "buyavgprice", "cfbuyavgprice"),
                    sell_avg_price=_blended_price(raw, "totalsellavgprice", "sellavgprice", "cfsellavgprice"),
                    average_price=N.first_float(raw, "avgnetprice", "netprice"),
                    last_price=N.first_float(raw, "ltp", "lastprice", "close"),
                    close_price=N.first_float(raw, "close", "closeprice"),
                    realized_pnl=N.first_float(raw, "realised", "realized", "realisedpnl"),
                    unrealized_pnl=N.first_float(raw, "unrealised", "unrealized", "unrealisedpnl"),
                    multiplier=N.first_float(raw, "multiplier"),
                    lotsize=N.first_int(raw, "lotsize", "boardlotsize"),
                )
            )
        return rows

    # ------------------------------------------------------------- funds ---
    def fetch_funds(self, since: datetime | None) -> list[dict[str, Any]]:
        client = self.ensure_client()
        payload = _rows(client.rmsLimit())
        if not payload:
            return []
        raw = payload[0]
        return [
            self.funds_row(
                trade_date=N.today_ist(),
                raw=raw,
                available_cash=N.first_float(raw, "availablecash", "availableCash"),
                net_balance=N.first_float(raw, "net"),
                utilised_margin=N.first_float(raw, "utiliseddebits", "utilisedDebits"),
                collateral=N.first_float(raw, "collateral"),
                withdrawable_balance=N.first_float(raw, "availablelimitmargin", "availableintradaypayin"),
                realized_pnl=N.first_float(raw, "m2mrealized", "m2mRealized"),
                unrealized_pnl=N.first_float(raw, "m2munrealized", "m2mUnrealized"),
            )
        ]

    # ------------------------------------------------------------ ledger ---
    def fetch_ledger(self, since: datetime | None, *, start: date, end: date) -> list[dict[str, Any]]:
        raise DatasetUnsupported(
            "Angel One SmartAPI has no ledger endpoint. Charges are available per trade "
            "in the contract note only; the sync records this dataset as unsupported "
            "rather than reporting a false zero."
        )


def _total_quantity(raw: dict[str, Any], total_key: str, day_key: str, carry_key: str) -> float:
    """Position quantity across the day and carry-forward legs."""
    total = N.to_float(raw.get(total_key))
    if total is not None:
        return total
    return (N.to_float(raw.get(day_key)) or 0.0) + (N.to_float(raw.get(carry_key)) or 0.0)


def _blended_price(raw: dict[str, Any], total_key: str, day_key: str, carry_key: str) -> float | None:
    """Average price across both legs, preferring Angel One's own blended value.

    A leg with no quantity contributes no price, so an overnight-only position
    reports the overnight average rather than a meaningless zero.
    """
    total = N.to_float(raw.get(total_key))
    if total not in (None, 0.0):
        return total
    day_price = N.to_float(raw.get(day_key))
    carry_price = N.to_float(raw.get(carry_key))
    prefix = day_key.replace("avgprice", "")
    day_qty = N.to_float(raw.get(f"{prefix}qty")) or 0.0
    carry_qty = N.to_float(raw.get(carry_key.replace("avgprice", "qty"))) or 0.0
    quantity = day_qty + carry_qty
    if quantity <= 0:
        return day_price if day_price not in (None, 0.0) else carry_price
    weighted = (day_price or 0.0) * day_qty + (carry_price or 0.0) * carry_qty
    return round(weighted / quantity, 6)


# ---------------------------------------------------------------- session ----
# SmartAPI has no refresh-without-TOTP flow that survives a process restart, so
# the issued JWT is cached on disk (0600) and rehydrated. Angel One expires it at
# the 05:00 IST rollover; the cache is treated as stale well before that and is
# always probed with a real authenticated call before being trusted.
SESSION_CACHE_PATH = Path(
    os.getenv("ANGEL_SESSION_CACHE_PATH", str(Path(__file__).resolve().parents[1] / "logs" / "state" / "angel_session.json"))
)
SESSION_TTL_SECONDS = int(os.getenv("ANGEL_SESSION_TTL_SECONDS", str(6 * 3600)))


def _read_session_cache(client_code: str) -> dict[str, Any] | None:
    try:
        payload = json.loads(SESSION_CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if payload.get("client_code") != client_code:
        return None
    if (time.time() - float(payload.get("minted_at") or 0)) > SESSION_TTL_SECONDS:
        return None
    # An IST session cannot outlive the 05:00 rollover on the day after it was minted.
    minted = datetime.fromtimestamp(float(payload.get("minted_at") or 0), tz=INDIA_TZ)
    rollover = minted.replace(hour=5, minute=0, second=0, microsecond=0)
    if minted.hour >= 5:
        rollover += timedelta(days=1)
    if datetime.now(tz=INDIA_TZ) >= rollover:
        return None
    return payload if payload.get("jwtToken") else None


def _write_session_cache(client_code: str, data: dict[str, Any]) -> None:
    if not data.get("jwtToken"):
        return
    try:
        SESSION_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        SESSION_CACHE_PATH.write_text(
            json.dumps({
                "client_code": client_code,
                "minted_at": time.time(),
                "jwtToken": data.get("jwtToken"),
                "refreshToken": data.get("refreshToken"),
                "feedToken": data.get("feedToken"),
                "expiry": data.get("expiry"),
            }),
            encoding="utf-8",
        )
        os.chmod(SESSION_CACHE_PATH, 0o600)
    except OSError as exc:  # a failed cache write only costs a re-login
        LOGGER.warning("Angel One: could not persist the session cache: %s", exc)


def _restore_session(credentials, cached: dict[str, Any]):
    """Rebuild a SmartConnect client from a cached JWT, or None if it is stale."""
    try:
        ensure_automation_on_path()
        import angel_one_order_execution as angel  # type: ignore

        smart_connect = angel.load_smart_connect_class()
        smart_api = smart_connect(api_key=credentials.api_key)
        smart_api.setAccessToken(cached["jwtToken"])
        if cached.get("refreshToken"):
            smart_api.setRefreshToken(cached["refreshToken"])
        if cached.get("feedToken"):
            smart_api.setFeedToken(cached["feedToken"])
        smart_api.setUserId(credentials.client_code)
        # Cheap authenticated probe: a rejected token must fail here, not later
        # in the middle of a fetch.
        probe = smart_api.rmsLimit()
        if isinstance(probe, dict) and probe.get("status") is False:
            raise RuntimeError(probe.get("message") or "cached session rejected")
        return smart_api
    except Exception as exc:  # noqa: BLE001 - fall through to a full login
        LOGGER.info("Angel One: cached session rejected (%s); logging in again.", exc)
        return None
