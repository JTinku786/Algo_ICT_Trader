"""Shared adapter contract and row builders.

An adapter's only job is to log in and hand back rows already shaped like the
broker-truth tables. All cross-broker vocabulary lives in ``normalize``; all
writing lives in ``store``.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

import normalize as N
from sync_config import AccountSpec


class BrokerUnavailable(RuntimeError):
    """Login failed, SDK missing, or the account is not reachable right now."""


class DatasetUnsupported(RuntimeError):
    """This broker has no API for the requested dataset."""


class BrokerAdapter:
    """Base class. Subclasses override ``login`` and the ``fetch_*`` methods."""

    broker = "unknown"

    def __init__(self, spec: AccountSpec) -> None:
        self.spec = spec
        self.client: Any = None
        self.auth_status = "unverified"
        self.token_expires_at: datetime | None = None
        self.login_error: str | None = None
        # Non-fatal trouble from the last fetch: the data we did get is good,
        # but something was incomplete and is worth retrying.
        self.warnings: list[str] = []

    def begin_fetch(self) -> None:
        """Clear per-dataset warnings before a fetch."""
        self.warnings = []

    def warn(self, message: str) -> None:
        self.warnings.append(message)

    # -- lifecycle ---------------------------------------------------------
    def login(self) -> Any:
        raise NotImplementedError

    def ensure_client(self) -> Any:
        if self.client is None:
            try:
                self.client = self.login()
                self.auth_status = "verified"
                self.login_error = None
            except Exception as exc:  # noqa: BLE001 - surfaced on the dashboard
                self.auth_status = "auth_failed"
                self.login_error = str(exc)[:500]
                raise BrokerUnavailable(f"{self.broker} login failed: {exc}") from exc
        return self.client

    def close(self) -> None:
        self.client = None

    # -- datasets ----------------------------------------------------------
    # ``since`` is the watermark: the newest record timestamp already stored.
    # Day-scoped broker endpoints ignore it and simply return today.
    def fetch_orders(self, since: datetime | None) -> list[dict[str, Any]]:
        raise DatasetUnsupported(f"{self.broker} orders")

    def fetch_trades(self, since: datetime | None, *, start: date, end: date) -> list[dict[str, Any]]:
        raise DatasetUnsupported(f"{self.broker} trades")

    def fetch_positions(self, since: datetime | None) -> list[dict[str, Any]]:
        raise DatasetUnsupported(f"{self.broker} positions")

    def fetch_funds(self, since: datetime | None) -> list[dict[str, Any]]:
        raise DatasetUnsupported(f"{self.broker} funds")

    def fetch_ledger(self, since: datetime | None, *, start: date, end: date) -> list[dict[str, Any]]:
        raise DatasetUnsupported(f"{self.broker} ledger")

    # -- row builders ------------------------------------------------------
    def _identity(self) -> dict[str, Any]:
        return {
            "broker": self.spec.broker,
            "broker_account": self.spec.broker_account,
            "broker_client_id": self.spec.broker_client_id,
        }

    def order_row(self, *, broker_order_id: str, raw: dict[str, Any], **fields: Any) -> dict[str, Any]:
        status = fields.get("status") or N.UNKNOWN
        row = {
            **self._identity(),
            "order_uid": N.stable_uid(self.spec.broker, self.spec.broker_account, broker_order_id),
            "broker_order_id": str(broker_order_id),
            "status": status,
            "is_open": status in N.LIVE_STATUSES,
            "raw": raw,
            "source_feed": "broker_api",
            "last_synced_at": datetime.now().astimezone(),
            "updated_at": datetime.now().astimezone(),
        }
        row.update({key: value for key, value in fields.items() if value is not None})
        row["status"] = status
        row["is_open"] = status in N.LIVE_STATUSES
        N.enrich_contract(row, row.get("tradingsymbol"))
        return row

    def trade_row(self, *, trade_key: str, raw: dict[str, Any], **fields: Any) -> dict[str, Any]:
        broker_order_id = fields.get("broker_order_id")
        row = {
            **self._identity(),
            "trade_uid": N.stable_uid(self.spec.broker, self.spec.broker_account, trade_key),
            "order_uid": (
                N.stable_uid(self.spec.broker, self.spec.broker_account, broker_order_id)
                if broker_order_id
                else None
            ),
            "raw": raw,
            "source_feed": "broker_api",
            "last_synced_at": datetime.now().astimezone(),
        }
        row.update({key: value for key, value in fields.items() if value is not None})
        quantity = row.get("quantity")
        price = row.get("price")
        if quantity is not None and price is not None and row.get("trade_value") is None:
            row["trade_value"] = round(float(quantity) * float(price), 6)
        N.enrich_contract(row, row.get("tradingsymbol"))
        return row

    def position_row(self, *, trade_date: date, tradingsymbol: str, product: str | None, raw: dict[str, Any], **fields: Any) -> dict[str, Any]:
        net = fields.get("net_quantity")
        row = {
            **self._identity(),
            "position_uid": N.stable_uid(
                self.spec.broker, self.spec.broker_account, trade_date.isoformat(), tradingsymbol, product or "-"
            ),
            "trade_date": trade_date,
            "tradingsymbol": tradingsymbol,
            "product": product,
            "position_type": "OPEN" if net not in (None, 0) else "CLOSED",
            "snapshot_at": datetime.now().astimezone(),
            "source_feed": "broker_api",
            "raw": raw,
            "last_synced_at": datetime.now().astimezone(),
        }
        row.update({key: value for key, value in fields.items() if value is not None})
        row["position_type"] = "OPEN" if row.get("net_quantity") not in (None, 0) else "CLOSED"
        realized = row.get("realized_pnl")
        unrealized = row.get("unrealized_pnl")
        if row.get("total_pnl") is None and (realized is not None or unrealized is not None):
            row["total_pnl"] = round(float(realized or 0) + float(unrealized or 0), 6)
        N.enrich_contract(row, tradingsymbol)
        return row

    def funds_row(self, *, trade_date: date, raw: dict[str, Any], **fields: Any) -> dict[str, Any]:
        row = {
            **self._identity(),
            "funds_uid": N.stable_uid(self.spec.broker, self.spec.broker_account, trade_date.isoformat()),
            "trade_date": trade_date,
            "snapshot_at": datetime.now().astimezone(),
            "updated_at": datetime.now().astimezone(),
            "raw": raw,
        }
        row.update({key: value for key, value in fields.items() if value is not None})
        return row

    def ledger_row(self, *, entry_key: str, entry_date: date, raw: dict[str, Any], **fields: Any) -> dict[str, Any]:
        debit = fields.get("debit") or 0.0
        credit = fields.get("credit") or 0.0
        row = {
            **self._identity(),
            "ledger_uid": N.stable_uid(self.spec.broker, self.spec.broker_account, entry_key),
            "entry_date": entry_date,
            "net_amount": round(float(credit) - float(debit), 6),
            "raw": raw,
            "last_synced_at": datetime.now().astimezone(),
        }
        row.update({key: value for key, value in fields.items() if value is not None})
        if row.get("category") is None:
            row["category"] = classify_ledger(row.get("narration"), row.get("voucher_type"))
        return row


_CHARGE_HINTS = ("brokerage", "gst", "stt", "stamp", "sebi", "exchange", "transaction charge", "dp charge", "ipft", "clearing", "tax")
_FUNDING_IN = ("payin", "pay in", "receipt", "fund transfer in", "upi", "neft", "imps", "deposit")
_FUNDING_OUT = ("payout", "pay out", "withdraw", "payment")


def classify_ledger(narration: Any, voucher_type: Any) -> str:
    text = f"{narration or ''} {voucher_type or ''}".strip().lower()
    if not text:
        return "other"
    if any(hint in text for hint in _CHARGE_HINTS):
        return "charges"
    if any(hint in text for hint in _FUNDING_OUT):
        return "payout"
    if any(hint in text for hint in _FUNDING_IN):
        return "payin"
    if "settle" in text or "obligation" in text or "margin" in text:
        return "settlement"
    return "other"
