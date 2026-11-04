#!/usr/bin/env python3
"""Offline self-test for the broker-truth sync.

Runs without Postgres, without broker credentials and without the broker SDKs:
it feeds recorded-shape payloads through the normalisers and the adapter row
builders and asserts the rows that come out. Use it after touching normalize.py
or any adapter, before running the real sync against a live account.

    python selftest.py
"""

from __future__ import annotations

import sys
from datetime import date, datetime
from pathlib import Path

RUNTIME_ROOT = Path(__file__).resolve().parent
if str(RUNTIME_ROOT) not in sys.path:
    sys.path.insert(0, str(RUNTIME_ROOT))

import normalize as N  # noqa: E402
from sync_config import INDIA_TZ, AccountSpec  # noqa: E402
from brokers.angel_one import AngelOneAdapter  # noqa: E402
from brokers.dhan import DhanAdapter  # noqa: E402
from brokers.groww import GrowwAdapter  # noqa: E402


FAILURES: list[str] = []


def check(label: str, actual, expected) -> None:
    if actual != expected:
        FAILURES.append(f"{label}: expected {expected!r}, got {actual!r}")


def spec(broker: str) -> AccountSpec:
    return AccountSpec(
        broker=broker, broker_account="TEST_ACC", broker_client_id="TEST",
        customer_key="test", display_name="Test",
    )


def test_status() -> None:
    check("angel complete", N.normalise_status("complete"), N.COMPLETE)
    check("angel trigger", N.normalise_status("trigger pending"), N.PENDING)
    check("angel rejected", N.normalise_status("rejected"), N.REJECTED)
    check("dhan traded", N.normalise_status("TRADED"), N.COMPLETE)
    check("dhan part", N.normalise_status("PART_TRADED"), N.PARTIAL)
    check("dhan transit", N.normalise_status("TRANSIT"), N.PENDING)
    check("groww executed", N.normalise_status("EXECUTED"), N.COMPLETE)
    check("groww acked", N.normalise_status("ACKED"), N.OPEN)
    check("groww failed", N.normalise_status("FAILED"), N.REJECTED)
    check("unknown", N.normalise_status(""), N.UNKNOWN)
    check("novel reject spelling", N.normalise_status("ORDER_REJECTED_BY_RMS"), N.REJECTED)


def test_side_and_product() -> None:
    check("buy", N.normalise_side("BUY"), "BUY")
    check("sell short", N.normalise_side("S"), "SELL")
    check("angel product", N.normalise_product("CARRYFORWARD"), "NRML")
    check("dhan product", N.normalise_product("MARGIN"), "NRML")
    check("groww product", N.normalise_product("NRML"), "NRML")
    check("intraday", N.normalise_product("MIS"), "MIS")


def test_timestamps() -> None:
    check("iso", N.to_timestamp("2026-08-19T10:30:00").hour, 10)
    check("angel clock", N.to_timestamp("10:15:30", day=date(2026, 8, 19)).date(), date(2026, 8, 19))
    check("dhan style", N.to_timestamp("2026-08-19 15:04:11").minute, 4)
    check("epoch ms", N.to_timestamp(1_755_600_000_000).tzinfo is not None, True)
    check("blank", N.to_timestamp(""), None)
    check("date dd-Mon-yyyy", N.to_date("19-Aug-2026"), date(2026, 8, 19))
    check("date ddMonyy", N.to_date("28AUG25"), date(2025, 8, 28))


def test_option_type() -> None:
    # Regression: Dhan writes CALL/PUT, and "NA" on non-derivative rows. Both
    # used to reach the database verbatim.
    check("angel CE", N.normalise_option_type("CE"), "CE")
    check("dhan CALL", N.normalise_option_type("CALL"), "CE")
    check("dhan PUT", N.normalise_option_type("PUT"), "PE")
    check("dhan NA", N.normalise_option_type("NA"), None)
    check("blank", N.normalise_option_type(""), None)


def test_contract_parsing() -> None:
    option = N.parse_contract("RELIANCE28AUG253000CE")
    check("option underlying", option["underlying"], "RELIANCE")
    check("option type", option["option_type"], "CE")
    check("option strike", option["strike"], 3000.0)
    check("option expiry", option["expiry_date"], date(2025, 8, 28))
    future = N.parse_contract("NIFTY25SEP2025FUT")
    check("future type", future["instrument_type"], "FUT")
    equity = N.parse_contract("SBIN-EQ")
    check("equity underlying", equity["underlying"], "SBIN")
    check("garbage safe", N.parse_contract("")["underlying"], None)

    # Regression: Dhan's own symbol formats used to fall through to the "keep
    # the whole string as the underlying" branch.
    hyphen = N.parse_contract("DRREDDY-Aug2026-1170-CE")
    check("dhan hyphen underlying", hyphen["underlying"], "DRREDDY")
    check("dhan hyphen type", hyphen["option_type"], "CE")
    check("dhan hyphen strike", hyphen["strike"], 1170.0)
    check("dhan hyphen expiry not guessed", hyphen["expiry_date"], None)

    spaced = N.parse_contract("BAJFINANCE 25 AUG 1100 PUT")
    check("dhan spaced underlying", spaced["underlying"], "BAJFINANCE")
    check("dhan spaced type", spaced["option_type"], "PE")
    check("dhan spaced strike", spaced["strike"], 1100.0)

    check("dhan hyphen future", N.parse_contract("DRREDDY-Aug2026-FUT")["instrument_type"], "FUT")

    # An explicit broker value still wins, but is normalised on the way through.
    row = {"option_type": "CALL", "strike": 1170.0}
    N.enrich_contract(row, "DRREDDY-Aug2026-1170-CE")
    check("explicit option type normalised", row["option_type"], "CE")
    check("explicit strike kept", row["strike"], 1170.0)


def test_day_range() -> None:
    windows = list(N.day_range(date(2026, 1, 1), date(2026, 3, 1), 30))
    check("first window start", windows[0][0], date(2026, 1, 1))
    check("first window end", windows[0][1], date(2026, 1, 30))
    check("windows cover end", windows[-1][1], date(2026, 3, 1))
    check("no overlap", windows[1][0], date(2026, 1, 31))


def test_angel_rows() -> None:
    adapter = AngelOneAdapter(spec("angel_one"))
    raw = {
        "orderid": "241219000123456", "uniqueorderid": "abc-123", "status": "complete",
        "orderstatus": "complete", "tradingsymbol": "RELIANCE28AUG253000CE",
        "transactiontype": "BUY", "producttype": "CARRYFORWARD", "ordertype": "MARKET",
        "quantity": "500", "filledshares": "500", "unfilledshares": "0",
        "price": "0", "averageprice": "42.35", "exchange": "NFO",
        "updatetime": "19-Aug-2026 09:31:05", "exchtime": "19-Aug-2026 09:31:04",
        "symboltoken": "54321", "text": "",
    }
    row = adapter.order_row(
        broker_order_id=raw["orderid"], raw=raw,
        trade_date=date(2026, 8, 19),
        status=N.normalise_status(raw["orderstatus"]),
        tradingsymbol=raw["tradingsymbol"],
        side=N.normalise_side(raw["transactiontype"]),
        product=N.normalise_product(raw["producttype"]),
        quantity=N.to_float(raw["quantity"]),
        filled_quantity=N.to_float(raw["filledshares"]),
        average_price=N.to_float(raw["averageprice"]),
    )
    check("angel uid", row["order_uid"], "angel_one|TEST_ACC|241219000123456")
    check("angel status", row["status"], N.COMPLETE)
    check("angel not open", row["is_open"], False)
    check("angel product mapped", row["product"], "NRML")
    check("angel underlying enriched", row["underlying"], "RELIANCE")
    check("angel expiry enriched", row["expiry_date"], date(2025, 8, 28))

    position = adapter.position_row(
        trade_date=date(2026, 8, 19), tradingsymbol="RELIANCE28AUG253000CE", product="NRML",
        raw={}, net_quantity=0.0, buy_quantity=500.0, sell_quantity=500.0,
        realized_pnl=1250.0, unrealized_pnl=0.0,
    )
    check("flat position is closed", position["position_type"], "CLOSED")
    check("total pnl derived", position["total_pnl"], 1250.0)


def test_dhan_rows() -> None:
    adapter = DhanAdapter(spec("dhan"))
    row = adapter.trade_row(
        trade_key="ORD1:TRD1", raw={}, broker_order_id="ORD1", trade_date=date(2026, 8, 19),
        tradingsymbol="NIFTY28AUG2524000CE", side="BUY", quantity=75.0, price=120.5,
        trade_ts=datetime(2026, 8, 19, 9, 45, tzinfo=INDIA_TZ),
    )
    check("dhan trade uid", row["trade_uid"], "dhan|TEST_ACC|ORD1:TRD1")
    check("dhan order uid link", row["order_uid"], "dhan|TEST_ACC|ORD1")
    check("dhan trade value", row["trade_value"], 9037.5)

    ledger = adapter.ledger_row(
        entry_key="2026-08-19:V1:12.5:0:Brokerage charges", entry_date=date(2026, 8, 19), raw={},
        narration="Brokerage and GST charges", debit=12.5, credit=0.0,
    )
    check("ledger net", ledger["net_amount"], -12.5)
    check("ledger category", ledger["category"], "charges")

    payin = adapter.ledger_row(
        entry_key="k2", entry_date=date(2026, 8, 19), raw={},
        narration="UPI Payin received", debit=0.0, credit=5000.0,
    )
    check("payin category", payin["category"], "payin")


def test_groww_rows() -> None:
    adapter = GrowwAdapter(spec("groww"))
    row = adapter.order_row(
        broker_order_id="GMK123", raw={}, trade_date=date(2026, 8, 19),
        status=N.normalise_status("ACKED"), tradingsymbol="TCS28AUG253200PE",
        side="BUY", product=N.normalise_product("NRML"), quantity=175.0, filled_quantity=0.0,
    )
    check("groww open flag", row["is_open"], True)
    check("groww option type", row["option_type"], "PE")

    position = adapter.position_row(
        trade_date=date(2026, 8, 19), tradingsymbol="TCS28AUG253200PE", product="NRML",
        raw={}, net_quantity=175.0, buy_quantity=175.0, sell_quantity=0.0, unrealized_pnl=-450.0,
    )
    check("groww open position", position["position_type"], "OPEN")
    check("groww total pnl", position["total_pnl"], -450.0)


def test_dhan_trade_identity() -> None:
    """Regression: Dhan trade history returns exchangeTradeId "0" for old fills.

    Keying on it collapsed every fill of an order onto one row.
    """
    adapter = DhanAdapter(spec("dhan"))
    base = {
        "orderId": "ORD1", "exchangeTradeId": "0", "transactionType": "BUY",
        "exchangeTime": "2026-08-18 14:11:34", "tradedQuantity": 750, "tradedPrice": 18.7,
    }
    other = {**base, "tradedQuantity": 250, "tradedPrice": 18.9}

    first = adapter._trade_row(base, historical=True)
    second = adapter._trade_row(other, historical=True)
    check("distinct fills stay distinct", first["trade_uid"] != second["trade_uid"], True)
    check("placeholder id not stored", first.get("exchange_trade_id"), None)

    repeat = adapter._trade_row(dict(base), historical=True)
    check("re-fetch is idempotent", repeat["trade_uid"], first["trade_uid"])

    real = adapter._trade_row({**base, "exchangeTradeId": "963791"}, historical=True)
    check("real trade id used", real["trade_uid"], "dhan|TEST_ACC|ORD1:963791")
    check("real trade id stored", real.get("exchange_trade_id"), "963791")


def test_store_json_defaults() -> None:
    """Regression: a NOT NULL jsonb column tripped on rows that lacked it.

    upsert_rows sends the union of columns across a batch, so a fill with no
    charges attached sent NULL for `charges` alongside fills that had them.
    """
    try:
        import store
    except Exception as exc:  # noqa: BLE001 - psycopg2 is not installed everywhere
        print(f"  (skipped store checks: {exc})")
        return
    check("charges kept", store._cell({"charges": {"stt": 1.0}}, "charges").adapted, {"stt": 1.0})
    check("charges defaulted", store._cell({}, "charges").adapted, {})
    check("raw defaulted", store._cell({}, "raw").adapted, {})
    check("ordinary column still null", store._cell({}, "average_price"), None)


def test_stable_uid() -> None:
    short = N.stable_uid("groww", "ACC", "ORDER1")
    check("short uid readable", short, "groww|ACC|ORDER1")
    long_uid = N.stable_uid("dhan", "ACC", "x" * 300)
    check("long uid hashed", len(long_uid) <= 60, True)
    check("long uid stable", long_uid, N.stable_uid("dhan", "ACC", "x" * 300))
    check("blank parts dropped", N.stable_uid("a", None, "", "b"), "a|b")


def main() -> int:
    for test in (
        test_status, test_side_and_product, test_option_type, test_timestamps,
        test_contract_parsing, test_day_range, test_angel_rows, test_dhan_rows,
        test_groww_rows, test_dhan_trade_identity, test_store_json_defaults,
        test_stable_uid,
    ):
        try:
            test()
        except Exception as exc:  # noqa: BLE001
            FAILURES.append(f"{test.__name__} raised {type(exc).__name__}: {exc}")

    if FAILURES:
        print("FAILED")
        for failure in FAILURES:
            print(f"  - {failure}")
        return 1
    print("All broker_sync self-tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
