"""Materialize multi-strategy rejection-trade research from realtime orders.

This job is analytics-only. It reads completed realtime orders and completed
5-minute candles, then writes counterfactual results to ict_rejection_trade_*.
It does not import or call any broker/order-submission code.
"""

from __future__ import annotations

import argparse
import json
import os
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg2
from psycopg2.extras import Json, execute_values


APP_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = APP_ROOT / "scripts" / "ict_rejection_trade_schema.sql"
IGS01V2_STRATEGY_ID = "IGS01V2_LondonLiqGrab_SweepReversal"
DEFAULT_STRATEGIES = (
    "S03",
    "S16",
    "S-CH08",
    "S-CH10",
    IGS01V2_STRATEGY_ID,
)


def load_env() -> None:
    path = APP_ROOT / ".env.local"
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw or raw.lstrip().startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def connect():
    load_env()
    return psycopg2.connect(
        host=os.environ["POSTGRES_HOST"],
        port=os.environ.get("POSTGRES_PORT", "5432"),
        dbname=os.environ["POSTGRES_DATABASE"],
        user=os.environ["POSTGRES_USER"],
        password=os.environ["POSTGRES_PASSWORD"],
        sslmode=os.environ.get("POSTGRES_SSLMODE", "prefer"),
    )


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--strategies",
        default=",".join(DEFAULT_STRATEGIES),
        help="Comma-separated strategy IDs. Defaults to every currently live strategy.",
    )
    parser.add_argument(
        "--strategy",
        help="Backward-compatible single-strategy override.",
    )
    parser.add_argument("--markets", default="india,us,forex")
    parser.add_argument("--date-from", type=date.fromisoformat, default=date(2026, 7, 1))
    parser.add_argument("--date-to", type=date.fromisoformat, default=date.today())
    parser.add_argument("--cost-bps-per-side", type=float, default=5.0)
    return parser.parse_args()


def round_value(value: float | None, digits: int = 8):
    return None if value is None else round(value, digits)


def trigger_volatility(candles, trigger_index, parent_risk, stop, direction):
    trigger = candles[trigger_index]
    start_index = max(0, trigger_index - 13)
    true_ranges = []
    for index in range(start_index, trigger_index + 1):
        candle = candles[index]
        previous_close = candles[index - 1]["close"] if index > 0 else candle["open"]
        true_ranges.append(max(
            candle["high"] - candle["low"],
            abs(candle["high"] - previous_close),
            abs(candle["low"] - previous_close),
        ))

    atr_14 = sum(true_ranges) / len(true_ranges) if true_ranges else None
    candle_range = trigger["high"] - trigger["low"]
    candle_body = abs(trigger["close"] - trigger["open"])
    atr_pct = 100.0 * atr_14 / abs(trigger["close"]) if atr_14 and trigger["close"] else None
    range_atr = candle_range / atr_14 if atr_14 and atr_14 > 1e-9 else None
    penetration = (
        (stop - trigger["close"]) / parent_risk
        if direction == "BUY"
        else (trigger["close"] - stop) / parent_risk
    )
    return candle_range, candle_body, atr_14, atr_pct, range_atr, penetration


def resolve_target(candles, direction, entry, stop, target, risk, rr, cost_bps):
    for candle in candles:
        stop_hit = candle["low"] <= stop if direction == "BUY" else candle["high"] >= stop
        target_hit = candle["high"] >= target if direction == "BUY" else candle["low"] <= target
        if stop_hit and target_hit:
            return ("AMBIGUOUS", None, candle["timestamp"], None, None, None, None)
        if stop_hit or target_hit:
            exit_price = stop if stop_hit else target
            gross_r = -1.0 if stop_hit else rr
            cost_r = ((abs(entry) + abs(exit_price)) * cost_bps / 10_000.0) / risk
            net_r = gross_r - cost_r
            return (
                "LOSS" if stop_hit else "WIN",
                exit_price,
                candle["timestamp"],
                gross_r,
                cost_r,
                net_r,
                -1.0 + net_r,
            )
    return ("OPEN", None, None, None, None, None, None)


def fetch_parents(cur, strategies, markets, date_from, date_to):
    cur.execute(
        """
        SELECT o.order_id::text, lower(s.market) AS market, upper(s.ticker) AS ticker,
               s.strategy_id, upper(s.direction) AS direction,
               COALESCE(o.filled_at, s.entry_datetime) AS filled_at,
               COALESCE(o.filled_price, o.entry_price, s.entry_price)::float8 AS entry_price,
               COALESCE(o.stoploss, s.stoploss)::float8 AS stoploss,
               COALESCE(o.tp1, s.target_1)::float8 AS tp1,
               COALESCE(o.tp2, s.target_2)::float8 AS tp2,
               COALESCE(o.tp3, s.target_3)::float8 AS tp3,
               o.close_ts, o.close_reason, o.close_price::float8 AS close_price
        FROM realtime_production_orders o
        JOIN realtime_production_ict_strategy_met_execution s ON s.signal_hash = o.signal_id
        WHERE upper(s.strategy_id) = ANY(%s::text[])
          AND lower(s.market) = ANY(%s::text[])
          AND s.entry_date BETWEEN %s AND %s
          AND (
            o.state = 'CLOSED_SL'
            OR (
              o.state = 'CLOSED_MANUAL'
              AND lower(COALESCE(o.close_reason, '')) = 'broker_position_already_closed'
              AND o.close_price IS NOT NULL
              AND abs(
                o.close_price::float8 - COALESCE(o.stoploss, s.stoploss)::float8
              ) <= greatest(abs(COALESCE(o.stoploss, s.stoploss)::float8) * 1e-6, 1e-8)
            )
          )
        UNION ALL
        SELECT 'OANDA:' || g.oanda_order_id, 'forex', upper(g.symbol),
               %s, CASE WHEN g.side > 0 THEN 'BUY' ELSE 'SELL' END,
               COALESCE(g.fill_ts, g.entry_ts),
               COALESCE(g.fill_price, g.signal_entry)::float8,
               g.stop::float8, g.tp1::float8, g.tp2::float8, g.tp3::float8,
               g.close_ts, 'hit_stoploss', g.stop::float8
        FROM igs01v2_live_signals g
        WHERE upper(%s) = ANY(%s::text[])
          AND 'forex' = ANY(%s::text[])
          AND g.run_date BETWEEN %s AND %s
          AND upper(COALESCE(g.exit_reason, '')) IN ('STOP', 'SL', 'STOP_LOSS')
          AND g.oanda_order_id IS NOT NULL
        ORDER BY filled_at, order_id
        """,
        (
            [strategy.upper() for strategy in strategies], markets, date_from, date_to,
            IGS01V2_STRATEGY_ID, IGS01V2_STRATEGY_ID,
            [strategy.upper() for strategy in strategies], markets, date_from, date_to,
        ),
    )
    columns = [item.name for item in cur.description]
    return [dict(zip(columns, row)) for row in cur.fetchall()]


def fetch_candles(cur, symbols, date_from, date_to):
    if not symbols:
        return {}
    cur.execute(
        """
        WITH raw AS (
          SELECT upper(COALESCE(yahoo_symbol, base_symbol)) AS ticker, candle_ts,
                 open_price::float8, high_price::float8, low_price::float8,
                 close_price::float8, 1 AS source_priority
          FROM candles_5m
          WHERE upper(COALESCE(yahoo_symbol, base_symbol)) = ANY(%s::text[])
            AND candle_ts >= %s::date
            AND candle_ts < (%s::date + interval '1 day')
          UNION ALL
          SELECT upper(COALESCE(yahoo_symbol, base_symbol)), candle_ts,
                 open_price::float8, high_price::float8, low_price::float8,
                 close_price::float8, 2
          FROM historical_candles_5m
          WHERE upper(COALESCE(yahoo_symbol, base_symbol)) = ANY(%s::text[])
            AND candle_ts >= %s::date
            AND candle_ts < (%s::date + interval '1 day')
          UNION ALL
          SELECT upper(COALESCE(yahoo_symbol, base_symbol)),
                 to_timestamp(floor(extract(epoch FROM candle_ts) / 300) * 300),
                 (array_agg(open_price ORDER BY candle_ts))[1]::float8,
                 max(high_price)::float8, min(low_price)::float8,
                 (array_agg(close_price ORDER BY candle_ts DESC))[1]::float8, 3
          FROM historical_candles_1m
          WHERE upper(COALESCE(yahoo_symbol, base_symbol)) = ANY(%s::text[])
            AND market = 'forex'
            AND candle_ts >= %s::date
            AND candle_ts < (%s::date + interval '1 day')
          GROUP BY 1, 2
        )
        SELECT DISTINCT ON (ticker, candle_ts)
               ticker, candle_ts, open_price, high_price, low_price, close_price
        FROM raw
        ORDER BY ticker, candle_ts, source_priority
        """,
        (
            symbols, date_from, date_to,
            symbols, date_from, date_to,
            symbols, date_from, date_to,
        ),
    )
    grouped = defaultdict(list)
    for ticker, timestamp, open_price, high, low, close in cur.fetchall():
        grouped[ticker].append(
            {"timestamp": timestamp, "open": open_price, "high": high, "low": low, "close": close}
        )
    return grouped


def invalid_order_row(run_id, parent, status, reason):
    return (
        run_id, parent["order_id"], parent["market"], parent["ticker"], parent["strategy_id"],
        parent["direction"], parent["filled_at"], parent["entry_price"], parent["stoploss"],
        parent["tp1"], parent["tp2"], parent["tp3"], parent["close_ts"], parent["close_reason"],
        None, None, None, None, None, None,
        None, None, None, None, None, None,
        None, None, None, None, None, None, None,
        status, reason,
    )


def simulate(run_id, parents, candles_by_ticker, cost_bps):
    order_rows = []
    outcome_rows = []
    eligible = 0

    for parent in parents:
        close_reason = (parent["close_reason"] or "").lower()
        recorded_stop = close_reason == "hit_stoploss"
        reconciled_stop = close_reason == "broker_position_already_closed"
        if not recorded_stop and not reconciled_stop:
            order_rows.append(invalid_order_row(
                run_id, parent, "EXCLUDED_NON_PRICE_STOP", "Parent close was not an underlying price stop",
            ))
            continue

        entry = parent["entry_price"]
        stop = parent["stoploss"]
        targets = [parent["tp1"], parent["tp2"], parent["tp3"]]
        if not entry or not stop or not parent["filled_at"] or abs(entry - stop) <= 1e-9:
            order_rows.append(invalid_order_row(
                run_id, parent, "INVALID_INPUT", "Missing or zero-risk parent geometry",
            ))
            continue

        candles = candles_by_ticker.get(parent["ticker"], [])
        close_at = parent.get("close_ts")
        close_bucket = close_at.replace(
            minute=(close_at.minute // 5) * 5, second=0, microsecond=0,
        ) if close_at else None
        stop_index = None
        for index, candle in enumerate(candles):
            if candle["timestamp"] + timedelta(minutes=5) <= parent["filled_at"]:
                continue
            if close_bucket and candle["timestamp"] > close_bucket:
                break
            touched = candle["low"] <= stop if parent["direction"] == "BUY" else candle["high"] >= stop
            if touched:
                stop_index = index
                break

        if stop_index is None:
            order_rows.append(invalid_order_row(
                run_id, parent, "NO_STOP_CANDLE", "No completed 5-minute stop-touch candle in the run window",
            ))
            continue

        eligible += 1
        trigger = candles[stop_index]
        reverse_direction = "SELL" if parent["direction"] == "BUY" else "BUY"
        reverse_entry = trigger["close"]
        reverse_stop = entry
        valid_geometry = reverse_stop < reverse_entry if reverse_direction == "BUY" else reverse_stop > reverse_entry
        entry_at = trigger["timestamp"] + timedelta(minutes=5)
        if not valid_geometry or abs(reverse_entry - reverse_stop) <= 1e-9:
            row = list(invalid_order_row(
                run_id, parent, "INVALID_GEOMETRY", "Stop-candle close crossed beyond the original entry",
            ))
            row[14:20] = [reverse_direction, trigger["timestamp"], entry_at, reverse_entry, reverse_stop, None]
            order_rows.append(tuple(row))
            continue

        parent_risk = abs(entry - stop)
        volatility = trigger_volatility(
            candles, stop_index, parent_risk, stop, parent["direction"],
        )
        parent_sign = 1 if parent["direction"] == "BUY" else -1
        parent_favorable_candles = [
            candle for candle in candles[:stop_index]
            if candle["timestamp"] >= parent["filled_at"]
        ]
        parent_favorable_extreme_at = parent["filled_at"]
        parent_favorable_extreme_price = entry
        parent_max_favorable_points = 0.0
        if parent_favorable_candles:
            price_key = "high" if parent["direction"] == "BUY" else "low"
            extreme = (
                max(parent_favorable_candles, key=lambda candle: candle[price_key])
                if parent["direction"] == "BUY"
                else min(parent_favorable_candles, key=lambda candle: candle[price_key])
            )
            raw_favorable_points = parent_sign * (extreme[price_key] - entry)
            if raw_favorable_points > 0:
                parent_favorable_extreme_at = extreme["timestamp"]
                parent_favorable_extreme_price = extreme[price_key]
                parent_max_favorable_points = raw_favorable_points

        parent_max_favorable_pct = 100.0 * parent_max_favorable_points / abs(entry)
        parent_max_favorable_r = parent_max_favorable_points / parent_risk
        parent_tp1_distance = abs(parent["tp1"] - entry) if parent["tp1"] is not None else None
        parent_tp1_progress_pct = (
            100.0 * parent_max_favorable_points / parent_tp1_distance
            if parent_tp1_distance and parent_tp1_distance > 1e-9 else None
        )
        parent_tp1_touched = False
        if parent["tp1"] is not None:
            touch_tolerance = max(abs(parent["tp1"]) * 1e-6, 1e-8)
            parent_tp1_touched = (
                parent_favorable_extreme_price >= parent["tp1"] - touch_tolerance
                if parent["direction"] == "BUY"
                else parent_favorable_extreme_price <= parent["tp1"] + touch_tolerance
            )
        if parent_tp1_touched and parent_tp1_progress_pct is not None:
            parent_tp1_progress_pct = max(parent_tp1_progress_pct, 100.0)
        parent_pre_rejection_lesson = (
            "TP1_TOUCHED_BEFORE_REJECTION"
            if parent_tp1_touched
            else "SETUP_FAILED_BEFORE_TP1"
        )

        reverse_risk = abs(reverse_entry - reverse_stop)
        sign = 1 if reverse_direction == "BUY" else -1
        target_specs = []
        for target_no, parent_target in enumerate(targets, 1):
            if parent_target is None:
                continue
            rr = abs(parent_target - entry) / parent_risk
            if rr <= 1e-9:
                continue
            target_specs.append((target_no, rr, reverse_entry + sign * rr * reverse_risk))

        post_entry_candles = candles[stop_index + 1:]
        order_rows.append((
            run_id, parent["order_id"], parent["market"], parent["ticker"], parent["strategy_id"],
            parent["direction"], parent["filled_at"], entry, stop,
            parent["tp1"], parent["tp2"], parent["tp3"], parent["close_ts"], parent["close_reason"],
            reverse_direction, trigger["timestamp"], entry_at, reverse_entry, reverse_stop, reverse_risk,
            *(round_value(value) for value in volatility),
            parent_favorable_extreme_at, round_value(parent_favorable_extreme_price),
            round_value(parent_max_favorable_points), round_value(parent_max_favorable_pct),
            round_value(parent_max_favorable_r), round_value(parent_tp1_progress_pct),
            parent_pre_rejection_lesson,
            "VALID",
            (
                "Recorded hit_stoploss closure"
                if recorded_stop
                else "Candle-confirmed stop touch for broker-position reconciliation"
            ),
        ))

        for target_no, rr, target_price in target_specs:
            outcome = resolve_target(
                post_entry_candles, reverse_direction, reverse_entry, reverse_stop,
                target_price, reverse_risk, rr, cost_bps,
            )
            outcome_rows.append((
                run_id, parent["order_id"], target_no, round_value(rr), round_value(target_price),
                outcome[0], round_value(outcome[1]), outcome[2], round_value(outcome[3]),
                round_value(outcome[4]), round_value(outcome[5]), round_value(outcome[6]),
            ))

    return order_rows, outcome_rows, eligible


def main():
    args = parse_args()
    markets = sorted({item.strip().lower() for item in args.markets.split(",") if item.strip()})
    raw_strategies = args.strategy or args.strategies
    requested = [item.strip() for item in raw_strategies.split(",") if item.strip()]
    canonical = {strategy.upper(): strategy for strategy in DEFAULT_STRATEGIES}
    strategies = list(dict.fromkeys(canonical.get(strategy.upper(), strategy) for strategy in requested))
    if not markets or not strategies or args.date_from > args.date_to:
        raise SystemExit("Strategies, markets, and a valid date range are required")
    if args.cost_bps_per_side < 0:
        raise SystemExit("Cost bps cannot be negative")

    run_id = str(uuid.uuid4())
    run_strategy_id = strategies[0] if len(strategies) == 1 else "LIVE_MULTI"
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(SCHEMA_PATH.read_text(encoding="utf-8"))
            cur.execute(
                """
                INSERT INTO ict_rejection_trade_runs
                  (run_id, source, strategy_id, strategy_ids, markets, date_from, date_to,
                   cost_bps_per_side, status)
                VALUES (%s, 'realtime_orders', %s, %s, %s, %s, %s, %s, 'RUNNING')
                """,
                (
                    run_id, run_strategy_id, strategies, markets,
                    args.date_from, args.date_to, args.cost_bps_per_side,
                ),
            )
        conn.commit()

        with conn.cursor() as cur:
            parents = fetch_parents(cur, strategies, markets, args.date_from, args.date_to)
            candles = fetch_candles(cur, sorted({row["ticker"] for row in parents}), args.date_from, args.date_to)
            order_rows, outcome_rows, eligible = simulate(run_id, parents, candles, args.cost_bps_per_side)

            execute_values(
                cur,
                """
                INSERT INTO ict_rejection_trade_orders (
                  run_id, parent_order_id, market, ticker, strategy_id, parent_direction,
                  parent_filled_at, parent_entry, parent_stop, parent_tp1, parent_tp2, parent_tp3,
                  parent_close_at, parent_close_reason, rejection_direction, stop_touch_candle_at,
                  rejection_entry_at, rejection_entry, rejection_stop, rejection_risk,
                  stop_candle_range, stop_candle_body, stop_candle_atr_14,
                  stop_candle_atr_pct, stop_candle_range_atr, stop_close_penetration_r,
                  parent_favorable_extreme_at, parent_favorable_extreme_price,
                  parent_max_favorable_points, parent_max_favorable_pct,
                  parent_max_favorable_r, parent_tp1_progress_pct,
                  parent_pre_rejection_lesson,
                  analysis_status, status_reason
                ) VALUES %s
                """,
                order_rows,
            )
            if outcome_rows:
                execute_values(
                    cur,
                    """
                    INSERT INTO ict_rejection_trade_target_outcomes (
                      run_id, parent_order_id, target_no, original_rr, target_price, outcome,
                      exit_price, exit_at, gross_r, cost_r, net_r, cycle_net_r
                    ) VALUES %s
                    """,
                    outcome_rows,
                )

            status_counts = defaultdict(int)
            for row in order_rows:
                status_counts[row[33]] += 1
            details = {
                "policy": {
                    "trigger": "first completed 5m parent-stop touch candle",
                    "entry": "trigger candle close, available at candle close",
                    "stop": "parent filled entry",
                    "targets": "parent TP1/TP2/TP3 R multiples",
                    "same_bar_collision": "AMBIGUOUS",
                    "parent_pre_rejection_mfe": "favorable extreme after parent fill and before the parent stop/rejection candle",
                    "reconciled_stop_policy": "broker-position closures qualify only when close equals the parent stop and a completed 5m candle confirms the touch",
                    "volatility": "ATR(14), trigger range/ATR, and stop-close penetration use only candles available at rejection entry",
                },
                "strategy_ids": strategies,
                "status_counts": dict(status_counts),
                "generated_at": datetime.now(timezone.utc).isoformat(),
            }
            cur.execute(
                """
                UPDATE ict_rejection_trade_runs
                SET status='COMPLETED', completed_at=now(), parent_stop_count=%s,
                    eligible_price_stop_count=%s, stored_trade_count=%s, details=%s
                WHERE run_id=%s
                """,
                (len(parents), eligible, len(order_rows), Json(details), run_id),
            )
        conn.commit()
        print(json.dumps({
            "run_id": run_id,
            "strategy_id": run_strategy_id,
            "strategies": strategies,
            "markets": markets,
            "date_from": args.date_from.isoformat(),
            "date_to": args.date_to.isoformat(),
            "parent_stops": len(parents),
            "eligible_price_stops": eligible,
            "stored_trades": len(order_rows),
            "stored_target_outcomes": len(outcome_rows),
        }, indent=2))
    except Exception as exc:
        conn.rollback()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE ict_rejection_trade_runs
                    SET status='FAILED', completed_at=now(), details=%s
                    WHERE run_id=%s
                    """,
                    (Json({"error": str(exc)[:1000]}), run_id),
                )
            conn.commit()
        finally:
            conn.close()
        raise
    else:
        conn.close()


if __name__ == "__main__":
    main()
