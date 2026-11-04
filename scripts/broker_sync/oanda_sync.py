#!/usr/bin/env python3
"""OANDA broker-truth sync for the Account Management page (read-only).

Pulls the OANDA account itself -- not the algo's log -- into Postgres:

  oanda_account_snapshots   balance / NAV / P&L at each sync
  oanda_account_transfers   every TRANSFER_FUNDS (the 100K CLIENT_FUNDING, any top-ups)
  oanda_account_trades      one row per OANDA trade, open or closed, with the
                            strategy that placed it

Strategy attribution, in order (first match wins):
  1. reversal_k1_live_orders.oanda_trade_id / oanda_order_id   -> REVERSAL_K1
  2. igs01v2_live_signals.oanda_order_id                       -> IGS01V2
  3. the order's clientExtensions tag (e.g. REV_K1)
  4. UNATTRIBUTED (a manual trade or an engine that does not log its order id)

Only GET requests are made; this script cannot place, modify or close orders.

    python oanda_sync.py            # sync and print a summary
    python oanda_sync.py --dry-run  # fetch and summarise, write nothing

Credentials come from OANDA_API_TOKEN / OANDA_ACCOUNT_ID / OANDA_ENV (process
environment, then the Windows user environment). The token is never printed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

RUNTIME_ROOT = Path(__file__).resolve().parent
if str(RUNTIME_ROOT) not in sys.path:
    sys.path.insert(0, str(RUNTIME_ROOT))

from psycopg2.extras import Json, execute_values  # noqa: E402

import store  # noqa: E402

HOSTS = {"practice": "https://api-fxpractice.oanda.com", "live": "https://api-fxtrade.oanda.com"}
TO_LOCAL = {
    "EUR_USD": "^EURUSD", "GBP_USD": "^GBPUSD", "AUD_USD": "^AUDUSD", "NZD_USD": "^NZDUSD",
    "USD_CAD": "^USDCAD", "USD_CHF": "^USDCHF", "EUR_GBP": "^EURGBP", "USD_JPY": "^USDJPY",
    "EUR_JPY": "^EURJPY", "GBP_JPY": "^GBPJPY", "AUD_JPY": "^AUDJPY", "CHF_JPY": "^CHFJPY",
    "XAU_USD": "^XAUUSD", "XAG_USD": "^XAGUSD",
}
TAG_STRATEGY = {"REV_K1": "REVERSAL_K1", "IGS01V2": "IGS01V2_LondonLiqGrab_SweepReversal"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS oanda_account_snapshots (
  snapshot_at timestamptz PRIMARY KEY, account_id text NOT NULL, environment text NOT NULL,
  currency text, balance numeric, nav numeric, pl numeric, unrealized_pl numeric,
  financing numeric, commission numeric, open_trade_count int, last_transaction_id bigint,
  created_time timestamptz, raw jsonb);
CREATE TABLE IF NOT EXISTS oanda_account_transfers (
  account_id text NOT NULL, transaction_id bigint NOT NULL, transfer_ts timestamptz NOT NULL,
  amount numeric NOT NULL, funding_reason text, account_balance numeric, raw jsonb,
  PRIMARY KEY (account_id, transaction_id));
CREATE TABLE IF NOT EXISTS oanda_account_trades (
  account_id text NOT NULL, trade_id bigint NOT NULL, environment text NOT NULL,
  instrument text NOT NULL, local_symbol text, side text NOT NULL, units numeric NOT NULL,
  state text NOT NULL, open_ts timestamptz NOT NULL, open_price numeric, open_order_id bigint,
  open_order_type text, close_ts timestamptz, close_price numeric, close_reason text,
  realized_pl numeric, financing numeric, half_spread_cost numeric, unrealized_pl numeric,
  take_profit numeric, stop_loss numeric, client_tag text, client_comment text,
  strategy_id text NOT NULL, strategy_detail text, strategy_source text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(), raw jsonb,
  PRIMARY KEY (account_id, trade_id));
CREATE INDEX IF NOT EXISTS oanda_account_trades_open_ts ON oanda_account_trades (open_ts);
"""


def _user_env(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if value:
        return value
    try:  # Windows: setx writes HKCU\\Environment, which an already-running shell may not have.
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            return str(winreg.QueryValueEx(key, name)[0]).strip()
    except Exception:  # noqa: BLE001
        return ""


class Oanda:
    def __init__(self) -> None:
        self.token = _user_env("OANDA_API_TOKEN")
        self.account = _user_env("OANDA_ACCOUNT_ID")
        self.env = _user_env("OANDA_ENV").lower()
        if not self.token or not self.account or self.env not in HOSTS:
            raise SystemExit("OANDA_API_TOKEN, OANDA_ACCOUNT_ID and OANDA_ENV (practice|live) must be set.")
        self.host = HOSTS[self.env]

    def get(self, path: str) -> dict:
        req = urllib.request.Request(
            self.host + path,
            headers={"Authorization": f"Bearer {self.token}", "Accept-Datetime-Format": "RFC3339"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)

    def summary(self) -> dict:
        return self.get(f"/v3/accounts/{self.account}/summary")["account"]

    def transactions(self, last_id: int) -> list[dict]:
        out: list[dict] = []
        start = 1
        while start <= last_id:
            end = min(start + 999, last_id)
            out += self.get(f"/v3/accounts/{self.account}/transactions/idrange?from={start}&to={end}")["transactions"]
            start = end + 1
        return out

    def trades(self) -> list[dict]:
        out: list[dict] = []
        before = None
        while True:
            q = "state=ALL&count=500" + (f"&beforeID={before}" if before else "")
            page = self.get(f"/v3/accounts/{self.account}/trades?{q}")["trades"]
            out += page
            if len(page) < 500:
                return out
            before = min(int(t["id"]) for t in page)


def num(v):
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def ts(v):
    """OANDA RFC3339 with nanoseconds ('...:48.454670313Z') -> aware UTC datetime."""
    if not v:
        return None
    body = v.rstrip("Z")
    if "." in body:
        head, frac = body.split(".", 1)
        body = f"{head}.{frac[:6]}"
    return datetime.fromisoformat(body).replace(tzinfo=timezone.utc)


def attribution(conn) -> tuple[dict, dict, dict]:
    by_trade, by_order_k1, by_order_igs = {}, {}, {}
    with conn.cursor() as cur:
        cur.execute("""SELECT oanda_trade_id, oanda_order_id, timeframe, setup_key FROM reversal_k1_live_orders
                       WHERE oanda_trade_id IS NOT NULL OR oanda_order_id IS NOT NULL""")
        for trade_id, order_id, tf, setup in cur.fetchall():
            detail = f"k1_reclaim3 · {tf or '?'}" + (f" · {setup}" if setup else "")
            if trade_id:
                by_trade[str(trade_id)] = detail
            if order_id:
                by_order_k1[str(order_id)] = detail
        cur.execute("""SELECT oanda_order_id, model_version, signal_id FROM igs01v2_live_signals
                       WHERE oanda_order_id IS NOT NULL""")
        for order_id, model, signal_id in cur.fetchall():
            by_order_igs[str(order_id)] = f"London liquidity grab · model {model or '-'} · signal {signal_id}"
    return by_trade, by_order_k1, by_order_igs


def build_rows(api: Oanda, trades: list[dict], txs: list[dict], attr) -> list[dict]:
    by_trade, by_order_k1, by_order_igs = attr
    tx_by_id = {t["id"]: t for t in txs}
    rows = []
    for t in trades:
        fill = tx_by_id.get(t["id"], {})  # the opening ORDER_FILL has the trade's id
        order_id = fill.get("orderID")
        order = tx_by_id.get(order_id, {}) if order_id else {}
        ce = t.get("clientExtensions") or order.get("tradeClientExtensions") or order.get("clientExtensions") or {}
        tag = ce.get("tag")
        if t["id"] in by_trade or (order_id and order_id in by_order_k1):
            strategy, detail, source = "REVERSAL_K1", by_trade.get(t["id"]) or by_order_k1.get(order_id), "reversal_k1_live_orders"
        elif order_id and order_id in by_order_igs:
            strategy, detail, source = "IGS01V2_LondonLiqGrab_SweepReversal", by_order_igs[order_id], "igs01v2_live_signals"
        elif tag in TAG_STRATEGY:
            strategy, detail, source = TAG_STRATEGY[tag], ce.get("comment"), "oanda_client_tag"
        else:
            strategy, detail, source = "UNATTRIBUTED", ce.get("comment") or "no engine record: manual or test order", "none"
        if "smoke" in str(ce.get("id") or "").lower():
            detail = f"smoke test order ({ce.get('id')})"
        closing = [tx_by_id.get(i, {}) for i in t.get("closingTransactionIDs", [])]
        close_reason = closing[-1].get("reason") if closing else None
        units = num(t.get("initialUnits")) or 0.0
        half_spread = sum(num(c.get("halfSpreadCost")) or 0.0 for c in [fill, *closing])
        rows.append({
            "account_id": api.account, "trade_id": int(t["id"]), "environment": api.env,
            "instrument": t["instrument"], "local_symbol": TO_LOCAL.get(t["instrument"], t["instrument"]),
            "side": "BUY" if units > 0 else "SELL", "units": abs(units), "state": t["state"],
            "open_ts": ts(t.get("openTime")), "open_price": num(t.get("price")),
            "open_order_id": int(order_id) if order_id else None, "open_order_type": order.get("type") or fill.get("reason"),
            "close_ts": ts(t.get("closeTime")), "close_price": num(t.get("averageClosePrice")), "close_reason": close_reason,
            "realized_pl": num(t.get("realizedPL")), "financing": num(t.get("financing")),
            "half_spread_cost": round(half_spread, 4), "unrealized_pl": num(t.get("unrealizedPL")),
            "take_profit": num((t.get("takeProfitOrder") or {}).get("price")),
            "stop_loss": num((t.get("stopLossOrder") or {}).get("price")),
            "client_tag": tag, "client_comment": ce.get("comment"),
            "strategy_id": strategy, "strategy_detail": detail, "strategy_source": source, "raw": t,
        })
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    api = Oanda()
    summary = api.summary()
    txs = api.transactions(int(summary["lastTransactionID"]))
    trades = api.trades()
    conn = store.connect()
    try:
        rows = build_rows(api, trades, txs, attribution(conn))
        transfers = [t for t in txs if t["type"] == "TRANSFER_FUNDS"]
        by_strategy = defaultdict(lambda: [0, 0.0])
        for r in rows:
            by_strategy[r["strategy_id"]][0] += 1
            by_strategy[r["strategy_id"]][1] += (r["realized_pl"] or 0) + (r["financing"] or 0)
        print(f"OANDA {api.env} account {api.account}: {len(rows)} trades, {len(transfers)} transfers, "
              f"balance {summary['balance']} NAV {summary['NAV']}")
        for k, (n, pl) in sorted(by_strategy.items()):
            print(f"  {k:<40} trades={n:<4} realized+financing={pl:,.2f}")
        if args.dry_run:
            return
        with conn.cursor() as cur:
            cur.execute(SCHEMA)
            cur.execute(
                """INSERT INTO oanda_account_snapshots VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (snapshot_at) DO NOTHING""",
                (datetime.now(timezone.utc), api.account, api.env, summary.get("currency"), num(summary.get("balance")),
                 num(summary.get("NAV")), num(summary.get("pl")), num(summary.get("unrealizedPL")),
                 num(summary.get("financing")), num(summary.get("commission")), int(summary.get("openTradeCount") or 0),
                 int(summary["lastTransactionID"]), ts(summary.get("createdTime")), Json(summary)))
            execute_values(cur, """INSERT INTO oanda_account_transfers VALUES %s
                ON CONFLICT (account_id, transaction_id) DO UPDATE SET amount=EXCLUDED.amount,
                  funding_reason=EXCLUDED.funding_reason, account_balance=EXCLUDED.account_balance, raw=EXCLUDED.raw""",
                [(api.account, int(t["id"]), ts(t["time"]), num(t.get("amount")), t.get("fundingReason"),
                  num(t.get("accountBalance")), Json(t)) for t in transfers])
            cols = [c for c in rows[0].keys()] if rows else []
            if rows:
                updates = ",".join(f"{c}=EXCLUDED.{c}" for c in cols if c not in ("account_id", "trade_id"))
                execute_values(cur, f"""INSERT INTO oanda_account_trades ({",".join(cols)}) VALUES %s
                    ON CONFLICT (account_id, trade_id) DO UPDATE SET {updates}, synced_at=now()""",
                    [tuple(Json(r[c]) if c == "raw" else r[c] for c in cols) for r in rows])
        conn.commit()
        print("written")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
