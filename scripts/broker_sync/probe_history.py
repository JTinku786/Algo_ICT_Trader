#!/usr/bin/env python3
"""Find out how far back each broker will actually go.

Angel One and Groww are believed to be day-scoped and Dhan history-capable, but
"believed" is not good enough when the answer decides whether months of trading
history can be recovered. This logs in to each configured account and asks.

Read-only: it never places, modifies or cancels anything.

    python probe_history.py
    python probe_history.py --brokers groww --years 3
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any

RUNTIME_ROOT = Path(__file__).resolve().parent
if str(RUNTIME_ROOT) not in sys.path:
    sys.path.insert(0, str(RUNTIME_ROOT))

import normalize as N  # noqa: E402
from sync_config import load_accounts  # noqa: E402
from brokers import build_adapter  # noqa: E402


LOGGER = logging.getLogger("broker_sync.probe")

# Method names worth knowing about on an SDK client. Anything matching these
# hints is reported so a history endpoint we did not anticipate still surfaces.
INTERESTING = ("order", "trade", "position", "holding", "history", "statement", "ledger", "margin", "fund", "pnl", "profit")


def _client_methods(client: Any) -> list[str]:
    names = []
    for name in dir(client):
        if name.startswith("_"):
            continue
        if not any(hint in name.lower() for hint in INTERESTING):
            continue
        if callable(getattr(client, name, None)):
            names.append(name)
    return sorted(names)


def probe_angel(adapter, report: dict[str, Any], **_: Any) -> None:
    client = adapter.ensure_client()
    report["sdk_methods"] = _client_methods(client)
    report["findings"].append(
        "SmartAPI exposes orderBook / tradeBook / position only, and all three reset at the "
        "daily rollover. There is no dated endpoint."
    )
    for label, call in (("orderBook", "orderBook"), ("tradeBook", "tradeBook"), ("position", "position")):
        try:
            payload = getattr(client, call)()
            data = (payload or {}).get("data") if isinstance(payload, dict) else payload
            report["today"][label] = len(data) if isinstance(data, list) else (0 if data is None else 1)
        except Exception as exc:  # noqa: BLE001
            report["today"][label] = f"error: {exc}"


def probe_groww(adapter, report: dict[str, Any], **_: Any) -> None:
    client = adapter.ensure_client()
    report["sdk_methods"] = _client_methods(client)

    # If the order list is paginated over history rather than the day, deep
    # pages keep returning rows and the oldest date will be well in the past.
    oldest: str | None = None
    newest: str | None = None
    pages = 0
    seen: set[str] = set()
    try:
        # page_size 25 is what Groww documents; page until a page adds nothing
        # new rather than until a page is short.
        for page in range(200):
            response = client.get_order_list(segment="FNO", page=page, page_size=25)
            rows = response.get("order_list") if isinstance(response, dict) else None
            if not rows:
                break
            fresh = [r for r in rows if str(r.get("groww_order_id") or r.get("order_id") or "") not in seen]
            if not fresh:
                break
            pages += 1
            for row in fresh:
                seen.add(str(row.get("groww_order_id") or row.get("order_id") or ""))
                stamp = N.to_date(row.get("created_at") or row.get("trade_date"))
                if not stamp:
                    continue
                text = stamp.isoformat()
                oldest = text if oldest is None or text < oldest else oldest
                newest = text if newest is None or text > newest else newest
        report["order_list"] = {
            "pages_walked": pages, "unique_orders": len(seen),
            "oldest_row": oldest, "newest_row": newest,
            "spans_days": (oldest != newest) if oldest and newest else False,
        }
    except Exception as exc:  # noqa: BLE001
        report["order_list"] = f"error: {exc}"

    report["findings"].append(
        "spans_days=true means the Groww order list is NOT day-scoped and real history can be pulled. "
        "spans_days=false with oldest_row equal to today means it is day-scoped, like Angel One."
    )
    report["findings"].append(
        "Groww exposes no ledger, statement or dated endpoint of any kind -- only get_order_list, "
        "get_trade_list_for_order (per order), get_positions_for_user and get_holdings_for_user."
    )


def probe_dhan(adapter, report: dict[str, Any], *, years: int) -> None:
    adapter.ensure_client()
    today = N.today_ist()
    start = today - timedelta(days=365 * max(1, years))
    report["findings"].append(f"Asking Dhan for trade history and ledger back to {start.isoformat()}.")

    oldest_trade: str | None = None
    trades = 0
    windows_tried = 0
    windows_failed = 0
    for window_start, window_end in N.day_range(start, today, 30):
        windows_tried += 1
        try:
            payload = adapter._get(f"trades/{window_start.isoformat()}/{window_end.isoformat()}/0")
        except Exception as exc:  # noqa: BLE001
            windows_failed += 1
            report.setdefault("trade_errors", []).append(f"{window_start}: {str(exc)[:120]}")
            continue
        rows = payload if isinstance(payload, list) else (payload or {}).get("data") or []
        if not isinstance(rows, list) or not rows:
            continue
        trades += len(rows)
        for row in rows:
            stamp = N.to_date(row.get("exchangeTime") or row.get("createTime"))
            if stamp and (oldest_trade is None or stamp.isoformat() < oldest_trade):
                oldest_trade = stamp.isoformat()
    report["trade_history"] = {
        "windows_tried": windows_tried, "windows_failed": windows_failed,
        "rows": trades, "oldest_trade": oldest_trade,
    }

    oldest_ledger: str | None = None
    ledger = 0
    for window_start, window_end in N.day_range(start, today, 30):
        try:
            payload = adapter._get(f"ledger?from-date={window_start.isoformat()}&to-date={window_end.isoformat()}")
        except Exception as exc:  # noqa: BLE001
            report.setdefault("ledger_errors", []).append(f"{window_start}: {str(exc)[:120]}")
            continue
        rows = payload if isinstance(payload, list) else (payload or {}).get("data") or []
        if not isinstance(rows, list):
            continue
        ledger += len(rows)
        for row in rows:
            stamp = N.to_date(row.get("voucherdate"))
            if stamp and (oldest_ledger is None or stamp.isoformat() < oldest_ledger):
                oldest_ledger = stamp.isoformat()
    report["ledger"] = {"rows": ledger, "oldest_entry": oldest_ledger}


PROBES = {"angel_one": probe_angel, "groww": probe_groww, "dhan": probe_dhan}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Report how much history each broker will return.")
    parser.add_argument("--brokers", nargs="*", default=None)
    parser.add_argument("--years", type=int, default=2, help="How far back to ask Dhan for.")
    parser.add_argument("--json-out", default=None)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    reports = []
    for spec in load_accounts(tuple(args.brokers) if args.brokers else None):
        report: dict[str, Any] = {
            "broker": spec.broker, "account": spec.broker_account,
            "display_name": spec.display_name, "today": {}, "findings": [],
        }
        LOGGER.info("probing %s ...", spec.key)
        try:
            adapter = build_adapter(spec)
            PROBES[spec.broker](adapter, report, years=args.years)
            adapter.close()
        except Exception as exc:  # noqa: BLE001
            report["error"] = str(exc)[:400]
            LOGGER.error("%s probe failed: %s", spec.key, exc)
        reports.append(report)

    text = json.dumps(reports, indent=2, default=str)
    if args.json_out:
        Path(args.json_out).write_text(text, encoding="utf-8")
    print(text)

    print("\n" + "=" * 72)
    print("SUMMARY")
    print("=" * 72)
    for report in reports:
        print(f"\n{report['broker']} / {report['account']}")
        if report.get("error"):
            print(f"  FAILED: {report['error']}")
            continue
        if report.get("today"):
            print(f"  today: {report['today']}")
        for key in ("order_list", "trade_history", "ledger"):
            if key in report:
                print(f"  {key}: {report[key]}")
        if report.get("sdk_methods"):
            print(f"  SDK methods: {', '.join(report['sdk_methods'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
