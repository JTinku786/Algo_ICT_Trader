#!/usr/bin/env python3
"""Keep the SMT comparison indices current in historical_candles_5m.

SMT divergence (Realtime + Backtest) pairs US stocks with SPY. The Barchart
archive stops on 2026-08-12, so this tops it up from Yahoo (5m, last ~60 days,
regular session). Rows go to the ARCHIVE table only -- never candles_5m -- so
no live scanner starts treating the index as a tradeable symbol. Existing rows
(Barchart) are never overwritten.

    python smt_index_backfill.py            # SPY
    python smt_index_backfill.py SPY QQQ    # explicit symbols
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "broker_sync"))
import yfinance as yf  # noqa: E402
from psycopg2.extras import execute_values  # noqa: E402

import store  # noqa: E402

SOURCE = "yahoo_smt_index"


def main(symbols: list[str]) -> None:
    conn = store.connect()
    now = datetime.now(timezone.utc)
    try:
        for symbol in symbols:
            frame = yf.download(symbol, period="60d", interval="5m", prepost=False, progress=False, auto_adjust=False, multi_level_index=False)
            if frame.empty:
                print(f"{symbol}: no data from Yahoo")
                continue
            frame = frame.tz_convert("UTC") if frame.index.tz is not None else frame.tz_localize("UTC")
            rows = [
                (symbol, symbol, symbol, "us", "America/New_York", ts.to_pydatetime(),
                 float(r["Open"]), float(r["High"]), float(r["Low"]), float(r["Close"]), int(r.get("Volume") or 0),
                 SOURCE, now, now)
                for ts, r in frame.iterrows()
                if ts.to_pydatetime() <= now.replace(second=0, microsecond=0)  # skip the still-forming bar
            ]
            with conn.cursor() as cur:
                before = cur.execute("SELECT count(*) FROM historical_candles_5m WHERE yahoo_symbol=%s", (symbol,)) or cur.fetchone()[0]
                execute_values(cur, """INSERT INTO historical_candles_5m
                    (yahoo_symbol, base_symbol, company_name, market, exchange_timezone, candle_ts,
                     open_price, high_price, low_price, close_price, volume, source, fetched_at, updated_at)
                    VALUES %s ON CONFLICT (yahoo_symbol, candle_ts) DO NOTHING""", rows)
                cur.execute("SELECT count(*), max(candle_ts) FROM historical_candles_5m WHERE yahoo_symbol=%s", (symbol,))
                after, last = cur.fetchone()
            conn.commit()
            print(f"{symbol}: fetched {len(rows)} bars, inserted {after - before}, archive now ends {last}")
    finally:
        conn.close()


if __name__ == "__main__":
    main([s.upper() for s in sys.argv[1:]] or ["SPY"])
