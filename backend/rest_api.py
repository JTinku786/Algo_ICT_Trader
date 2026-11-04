import os
import math
import json
import sys
import csv
import io
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

import psycopg2
from flask import Flask, Response, jsonify, request
from psycopg2.extras import RealDictCursor


app = Flask(__name__)

MARKETS = {"us", "india", "forex"}

ICT_SESSION_DEFINITIONS = [
    {"id": "asian_range", "label": "Asian Range · 19:00–00:00 ET", "clock": "NEW_YORK", "start": 19 * 60, "end": 0},
    {"id": "asian_killzone", "label": "Asian Killzone · 20:00–00:00 ET", "clock": "NEW_YORK", "start": 20 * 60, "end": 0},
    {"id": "ny_midnight_open", "label": "NY Midnight Open · 00:00 ET", "clock": "NEW_YORK", "start": 0, "end": 1, "marker": True},
    {"id": "macro_london_midnight", "label": "Macro 1: London Midnight · 02:33–03:00 ET", "clock": "NEW_YORK", "start": 2 * 60 + 33, "end": 3 * 60},
    {"id": "london_open_killzone", "label": "London Open Killzone · 02:00–05:00 ET", "clock": "NEW_YORK", "start": 2 * 60, "end": 5 * 60},
    {"id": "london_silver_bullet", "label": "London Silver Bullet · 03:00–04:00 ET", "clock": "NEW_YORK", "start": 3 * 60, "end": 4 * 60},
    {"id": "macro_london_am", "label": "Macro 2: London AM · 04:03–04:30 ET", "clock": "NEW_YORK", "start": 4 * 60 + 3, "end": 4 * 60 + 30},
    {"id": "london_lunch", "label": "London Lunch (Dead Zone) · 05:00–07:00 ET", "clock": "NEW_YORK", "start": 5 * 60, "end": 7 * 60},
    {"id": "new_york_open_killzone", "label": "New York Open Killzone · 07:00–10:00 ET", "clock": "NEW_YORK", "start": 7 * 60, "end": 10 * 60},
    {"id": "macro_ny_pre_market", "label": "Macro 3: NY Pre-Market · 08:30–09:15 ET", "clock": "NEW_YORK", "start": 8 * 60 + 30, "end": 9 * 60 + 15},
    {"id": "nse_india_market", "label": "NSE India Market · 09:15–15:30 IST", "clock": "INDIA", "start": 9 * 60 + 15, "end": 15 * 60 + 30, "market": "INDIA"},
    {"id": "ny_am_session", "label": "NY AM Session · 09:30–12:00 ET", "clock": "NEW_YORK", "start": 9 * 60 + 30, "end": 12 * 60},
    {"id": "opening_range_equities", "label": "Opening Range (Equities) · 09:30–10:30 ET", "clock": "NEW_YORK", "start": 9 * 60 + 30, "end": 10 * 60 + 30},
    {"id": "macro_ny_opening_drive", "label": "Macro 4: NY Opening Drive · 09:50–10:10 ET", "clock": "NEW_YORK", "start": 9 * 60 + 50, "end": 10 * 60 + 10},
    {"id": "am_silver_bullet", "label": "AM Silver Bullet · 10:00–11:00 ET", "clock": "NEW_YORK", "start": 10 * 60, "end": 11 * 60},
    {"id": "macro_ny_mid_morning", "label": "Macro 5: NY Mid-Morning · 10:50–11:10 ET", "clock": "NEW_YORK", "start": 10 * 60 + 50, "end": 11 * 60 + 10},
    {"id": "london_close_killzone", "label": "London Close Killzone · 10:00–12:00 ET", "clock": "NEW_YORK", "start": 10 * 60, "end": 12 * 60},
    {"id": "macro_london_close_lunch", "label": "Macro 6: London Close / Lunch · 11:50–12:10 ET", "clock": "NEW_YORK", "start": 11 * 60 + 50, "end": 12 * 60 + 10},
    {"id": "new_york_lunch", "label": "New York Lunch · 12:00–13:30 ET", "clock": "NEW_YORK", "start": 12 * 60, "end": 13 * 60 + 30},
    {"id": "new_york_pm_session", "label": "New York PM Session · 13:30–16:00 ET", "clock": "NEW_YORK", "start": 13 * 60 + 30, "end": 16 * 60},
    {"id": "macro_pm_true_drive", "label": "Macro 6b: PM True Drive · 13:50–14:10 ET", "clock": "NEW_YORK", "start": 13 * 60 + 50, "end": 14 * 60 + 10},
    {"id": "pm_silver_bullet", "label": "PM Silver Bullet · 14:00–15:00 ET", "clock": "NEW_YORK", "start": 14 * 60, "end": 15 * 60},
    {"id": "cbdr", "label": "CBDR (True 6-Hour Block) · 14:00–20:00 ET", "clock": "NEW_YORK", "start": 14 * 60, "end": 20 * 60},
    {"id": "macro_ny_late_pm", "label": "Macro 7: NY Late PM · 15:15–15:45 ET", "clock": "NEW_YORK", "start": 15 * 60 + 15, "end": 15 * 60 + 45},
    {"id": "power_hour_equities", "label": "Power Hour (Equities) · 15:00–16:00 ET", "clock": "NEW_YORK", "start": 15 * 60, "end": 16 * 60},
    {"id": "ny_close", "label": "NY Close (Algorithmic Cutoff) · 16:00 ET", "clock": "NEW_YORK", "start": 16 * 60, "end": 16 * 60 + 1, "marker": True},
]
ICT_SESSION_IDS = [session["id"] for session in ICT_SESSION_DEFINITIONS]
ICT_SESSION_ID_SET = set(ICT_SESSION_IDS)
NEW_YORK_TIMEZONE = ZoneInfo("America/New_York")
INDIA_TIMEZONE = ZoneInfo("Asia/Kolkata")


def db_config():
    return {
        "dbname": os.getenv("POSTGRES_DATABASE", "titania_trading"),
        "user": os.getenv("POSTGRES_USER", "postgres"),
        "password": os.getenv("POSTGRES_PASSWORD", ""),
        "host": os.getenv("POSTGRES_HOST", "172.26.224.1"),
        "port": int(os.getenv("POSTGRES_PORT", "5432")),
        "sslmode": os.getenv("POSTGRES_SSLMODE", "disable"),
    }


def require_api_token():
    expected = os.getenv("ALGO_API_TOKEN", "")
    if not expected:
        return True
    supplied = request.headers.get("x-api-key", "")
    return supplied == expected


def serialize_value(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def serialize_row(row):
    return {key: serialize_value(value) for key, value in row.items()}


def normalize_limit(value):
    try:
        limit = int(value or 100)
    except (TypeError, ValueError):
        limit = 100
    return min(max(limit, 1), 500)


def num(value):
    if value is None:
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def round2(value, digits=2):
    if value is None:
        return None
    return round(float(value), digits)


def target_no(value):
    try:
        n = int(value or 1)
    except (TypeError, ValueError):
        n = 1
    return n if n in {1, 2, 3} else 1


def clean_date(value):
    if not value:
        return ""
    value = str(value).strip()
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return ""
    return value


def epoch_seconds(value):
    if value is None:
        return None
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return int(value.timestamp())


def normalize_backtest_trade(row, include_strategy_json=False):
    is_win = row["state"] == "CLOSED_TP"
    rr = num(row["target_rr"])
    filled_at = row["filled_at"]
    close_ts = row["close_ts"]
    hold_min = None
    if filled_at and close_ts:
        hold_min = round((close_ts - filled_at).total_seconds() / 60)
    entry_datetime = row.get("entry_datetime") or filled_at
    market = row.get("market")
    symbol = row["symbol"]
    trade = {
        "order_id": str(row["order_id"]),
        "market": market,
        "symbol": symbol,
        "strategy_id": row["strategy_id"],
        "strategy_name": row.get("strategy_name"),
        "direction": row["direction"],
        "entry_datetime": serialize_value(entry_datetime),
        "filled_at": serialize_value(filled_at),
        "close_ts": serialize_value(close_ts),
        "entry": num(row["entry_price"]),
        "filled": num(row["filled_price"]),
        "stop": num(row["stoploss"]),
        "tp1": num(row["tp1"]),
        "close_price": num(row["close_price"]),
        "r": round2(rr if is_win and rr is not None else -1),
        "quantity": None,
        "risk_usd": None,
        "gross_pnl_usd": None,
        "transaction_cost_usd": None,
        "pnl_usd": None,
        "outcome": "WIN" if is_win else "LOSS",
        "hold_min": hold_min,
        "risk_probability": num(row.get("risk_probability")),
        "risk_bin": num(row.get("risk_bin")),
        "strategy_json_available": bool(row.get("strategy_json_available")),
        "strategy_json_keys": row.get("strategy_json_keys") or [],
        "ict_sessions": ict_session_ids(entry_datetime, market, symbol),
    }
    if include_strategy_json:
        trade["strategy_json"] = row.get("strategy_json")
    return trade


BACKTEST_CSV_KEYS = [
    "entry_datetime", "close_ts", "symbol", "strategy_id", "strategy_name", "direction",
    "filled", "stop", "tp1", "close_price", "quantity", "risk_usd", "gross_pnl_usd",
    "transaction_cost_usd", "pnl_usd", "r", "hold_min", "outcome", "risk_probability",
    "risk_bin", "strategy_json_available",
]
DEFAULT_BACKTEST_CSV_KEYS = [
    "entry_datetime", "close_ts", "strategy_id", "direction", "filled", "close_price",
    "pnl_usd", "r", "hold_min", "outcome", "risk_probability", "risk_bin",
    "strategy_json_available",
]


def backtest_csv_response(trades):
    requested = [value.strip() for value in (request.args.get("columns") or "").split(",") if value.strip() in BACKTEST_CSV_KEYS]
    columns = list(dict.fromkeys(requested)) if requested else DEFAULT_BACKTEST_CSV_KEYS.copy()
    columns.append("strategy_json")
    output = io.StringIO(newline="")
    output.write("\ufeff")
    writer = csv.writer(output, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
    writer.writerow(columns)
    for trade in trades:
        values = []
        for column in columns:
            value = trade.get(column)
            if column == "strategy_json" and value is not None and not isinstance(value, str):
                value = json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=str)
            values.append("" if value is None else value)
        writer.writerow(values)
    filename = f"backtest-trades-{datetime.now(timezone.utc).date().isoformat()}.csv"
    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
            "X-Export-Row-Count": str(len(trades)),
        },
    )


def signed_price_pnl(trade, quantity):
    if trade["filled"] is None or trade["close_price"] is None:
        return None
    side = -1 if (trade["direction"] or "").upper() == "SELL" else 1
    return (trade["close_price"] - trade["filled"]) * side * quantity


def apply_sizing(trade, sizing):
    stop_distance = abs(trade["filled"] - trade["stop"]) if trade["filled"] is not None and trade["stop"] is not None else None
    if sizing["mode"] == "fixed_qty":
        quantity = sizing["quantity"]
        risk_usd = stop_distance * quantity if stop_distance and stop_distance > 0 else sizing["risk_usd"]
    else:
        risk_usd = sizing["risk_usd"]
        quantity = risk_usd / stop_distance if stop_distance and stop_distance > 0 else None

    price_pnl = signed_price_pnl(trade, quantity) if quantity is not None else None
    gross_pnl_usd = price_pnl if sizing["mode"] == "fixed_qty" and price_pnl is not None else trade["r"] * risk_usd
    entry_notional = abs(quantity * trade["filled"]) if quantity is not None and trade["filled"] is not None else 0
    exit_notional = abs(quantity * trade["close_price"]) if quantity is not None and trade["close_price"] is not None else entry_notional
    transaction_cost_usd = (entry_notional + exit_notional) * (
        sizing["commission_bps"] + sizing["slippage_bps"]
    ) / 10000
    pnl_usd = gross_pnl_usd - transaction_cost_usd
    trade["quantity"] = round2(quantity, 4) if quantity is not None else None
    trade["risk_usd"] = round2(risk_usd)
    trade["gross_pnl_usd"] = round2(gross_pnl_usd)
    trade["transaction_cost_usd"] = round2(transaction_cost_usd)
    trade["pnl_usd"] = round2(pnl_usd)
    trade["r"] = round2(pnl_usd / risk_usd) if risk_usd else trade["r"]
    return trade


EDGE_METRIC_KEYS = (
    "payoff_ratio",
    "breakeven_win_rate_pct",
    "win_rate_edge_pct",
    "kelly_fraction_pct",
    "half_kelly_fraction_pct",
    "risk_of_ruin_pct",
    "risk_of_ruin_simple_pct",
    "risk_units",
)


def compute_edge_metrics(win_rate_pct, avg_win_r, avg_loss_r, risk_per_trade_usd=None,
                         initial_capital_usd=None, r_multiples=None, fallback_risk_units=None):
    """Break-even win rate, Kelly and risk of ruin.

    Mirrors src/lib/edge-metrics.ts exactly - the Next.js route and this bridge
    must return the same numbers for the same population.

        payoff ratio       b = avg win / |avg loss|
        break-even WR      p(BE) = 1 / (1 + b)
        Kelly (simplified) f* = p - (1 - p) / b
        risk of ruin       [(1 - p) / p] ^ N          (equal +-1 payoffs)

    The equal-payoff risk of ruin only converges above a 50% win rate, so a
    payoff-aware variant is reported alongside it, using the edge scaled by the
    typical trade size: z = expectancy / sqrt(mean(R^2)).
    """
    empty = dict.fromkeys(EDGE_METRIC_KEYS)
    if win_rate_pct is None:
        return empty
    p = win_rate_pct / 100
    avg_win = abs(avg_win_r or 0)
    avg_loss = abs(avg_loss_r or 0)
    b = avg_win / avg_loss if avg_win > 0 and avg_loss > 0 else None

    if initial_capital_usd and risk_per_trade_usd and initial_capital_usd > 0 and risk_per_trade_usd > 0:
        risk_units = max(1, int(initial_capital_usd // risk_per_trade_usd))
    else:
        risk_units = fallback_risk_units

    breakeven = 100 / (1 + b) if b is not None else None
    kelly = (p - (1 - p) / b) * 100 if b else None

    simple_ror = None
    if risk_units is not None:
        simple_ror = min(100, ((1 - p) / p) ** risk_units * 100) if p > 0.5 else 100

    ror = None
    rs = [value for value in (r_multiples or []) if value is not None]
    if risk_units is not None:
        if rs:
            expectancy = sum(rs) / len(rs)
            rms = math.sqrt(sum(value ** 2 for value in rs) / len(rs))
        elif b is not None:
            expectancy = p * avg_win - (1 - p) * avg_loss
            rms = math.sqrt(p * avg_win ** 2 + (1 - p) * avg_loss ** 2)
        else:
            expectancy = rms = None
        if expectancy is not None and rms:
            if expectancy <= 0:
                ror = 100
            else:
                z = min(0.999999, expectancy / rms)
                ror = min(100, ((1 - z) / (1 + z)) ** risk_units * 100)

    return {
        "payoff_ratio": round2(b) if b is not None else None,
        "breakeven_win_rate_pct": round2(breakeven, 1) if breakeven is not None else None,
        "win_rate_edge_pct": round2(win_rate_pct - breakeven, 1) if breakeven is not None else None,
        "kelly_fraction_pct": round2(kelly) if kelly is not None else None,
        "half_kelly_fraction_pct": round2(kelly / 2) if kelly is not None else None,
        "risk_of_ruin_pct": round2(max(0, min(100, ror))) if ror is not None else None,
        "risk_of_ruin_simple_pct": round2(max(0, min(100, simple_ror))) if simple_ror is not None else None,
        "risk_units": risk_units,
    }


def group_stats(trades):
    if not trades:
        return {
            "trades": 0,
            "wins": 0,
            "losses": 0,
            "win_rate": 0,
            "net_r": 0,
            "avg_r": 0,
            "avg_win_r": 0,
            "avg_loss_r": 0,
            "largest_win_r": 0,
            "largest_loss_r": 0,
            "net_usd": 0,
            "profit_factor": None,
            **dict.fromkeys(EDGE_METRIC_KEYS),
        }
    rs = [t["r"] for t in trades]
    wins = [t for t in trades if t["r"] > 0]
    losses = [t for t in trades if t["r"] < 0]
    net_r = sum(rs)
    net_usd = sum(t["pnl_usd"] or 0 for t in trades)
    return {
        "trades": len(trades),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": round2(len(wins) / len(trades) * 100, 1),
        "net_r": round2(net_r),
        "net_usd": round2(net_usd),
        "avg_r": round2(net_r / len(trades)),
        "avg_win_r": round2(sum(t["r"] for t in wins) / len(wins)) if wins else 0,
        "avg_loss_r": round2(sum(t["r"] for t in losses) / len(losses)) if losses else 0,
        "largest_win_r": round2(max(rs)),
        "largest_loss_r": round2(min(rs)),
        "profit_factor": round2(sum(t["r"] for t in wins) / abs(sum(t["r"] for t in losses))) if losses else None,
        **compute_edge_metrics(
            len(wins) / len(trades) * 100,
            sum(t["r"] for t in wins) / len(wins) if wins else 0,
            sum(t["r"] for t in losses) / len(losses) if losses else 0,
            r_multiples=rs,
            fallback_risk_units=100,
        ),
    }


def compute_metrics(trades, sizing):
    n = len(trades)
    if not n:
        return {"total": 0, "sizing": sizing}
    rs = [t["r"] for t in trades]
    pnls = [t["pnl_usd"] or 0 for t in trades]
    gross_pnls = [t["gross_pnl_usd"] or 0 for t in trades]
    transaction_costs = [t["transaction_cost_usd"] or 0 for t in trades]
    wins = [t for t in trades if (t["pnl_usd"] or 0) > 0]
    losses = [t for t in trades if (t["pnl_usd"] or 0) < 0]
    gross_profit = sum(t["r"] for t in wins)
    gross_loss = sum(t["r"] for t in losses)
    net_r = gross_profit + gross_loss
    gross_profit_usd = sum(t["pnl_usd"] or 0 for t in wins)
    gross_loss_usd = sum(t["pnl_usd"] or 0 for t in losses)
    net_usd = sum(pnls)
    mean = net_r / n
    variance = sum((r - mean) ** 2 for r in rs) / n
    std = math.sqrt(variance)
    downside = [t["r"] for t in losses]
    downside_std = math.sqrt(sum(min(0, r) ** 2 for r in downside) / len(downside)) if downside else 0

    cum = 0
    cum_usd = 0
    peak = 0
    peak_usd = 0
    max_dd = 0
    max_dd_usd = 0
    dd_squared = 0
    for i, r in enumerate(rs):
        cum += r
        peak = max(peak, cum)
        dd = cum - peak
        max_dd = min(max_dd, dd)
        dd_squared += dd ** 2
        cum_usd += pnls[i]
        peak_usd = max(peak_usd, cum_usd)
        max_dd_usd = min(max_dd_usd, cum_usd - peak_usd)

    cur_w = cur_l = max_w = max_l = 0
    for r in rs:
        if r > 0:
            cur_w += 1
            cur_l = 0
            max_w = max(max_w, cur_w)
        else:
            cur_l += 1
            cur_w = 0
            max_l = max(max_l, cur_l)

    holds = [t["hold_min"] for t in trades if t["hold_min"] is not None]
    avg_hold = round(sum(holds) / len(holds)) if holds else None
    sorted_r = sorted(rs)
    sorted_usd = sorted(pnls)
    var_r = sorted_r[max(0, int(len(sorted_r) * 0.05) - 1)]
    var_usd = sorted_usd[max(0, int(len(sorted_usd) * 0.05) - 1)]
    dated = [t for t in trades if t["close_ts"]]
    first = datetime.fromisoformat(dated[0]["close_ts"]) if dated else None
    last = datetime.fromisoformat(dated[-1]["close_ts"]) if dated else None
    years = max((last - first).total_seconds() / (365.25 * 86400), 1 / 365) if first and last and last > first else 1
    initial_capital = sizing["initial_capital"]
    ending_capital = initial_capital + net_usd
    net_profit_pct = net_usd / initial_capital * 100
    cagr = ((ending_capital / initial_capital) ** (1 / years) - 1) * 100 if ending_capital > 0 else None
    max_dd_pct = max_dd_usd / initial_capital * 100
    exposure_minutes = sum(holds)
    period_minutes = max((last - first).total_seconds() / 60, 1) if first and last and last > first else max(exposure_minutes, 1)
    exposure_pct = min(100, exposure_minutes / period_minutes * 100)
    avg_win = gross_profit / len(wins) if wins else 0
    avg_loss = gross_loss / len(losses) if losses else 0
    long_trades = [t for t in trades if (t["direction"] or "").upper() == "BUY"]
    short_trades = [t for t in trades if (t["direction"] or "").upper() == "SELL"]
    quantities = [t["quantity"] for t in trades if t["quantity"] is not None]
    risks = [t["risk_usd"] for t in trades if t["risk_usd"] is not None]

    return {
        "sizing": {
            "mode": sizing["mode"],
            "initial_capital": round2(initial_capital),
            "risk_usd": round2(sizing["risk_usd"]),
            "quantity": round2(sizing["quantity"], 4),
            "commission_bps": round2(sizing["commission_bps"]),
            "slippage_bps": round2(sizing["slippage_bps"]),
        },
        "initial_capital": round2(initial_capital),
        "ending_capital": round2(ending_capital),
        "net_profit_pct": round2(net_profit_pct),
        "exposure_pct": round2(exposure_pct),
        "cagr": round2(cagr) if cagr is not None else None,
        "annual_return_pct": round2(net_profit_pct / years),
        "risk_adjusted_return_pct": round2(mean / std * 100) if std else None,
        "total": n,
        "wins": len(wins),
        "losses": len(losses),
        "long_trades": len(long_trades),
        "short_trades": len(short_trades),
        "win_rate": round2(len(wins) / n * 100, 1),
        "net_r": round2(net_r),
        "net_usd": round2(net_usd),
        "gross_pnl_before_costs_usd": round2(sum(gross_pnls)),
        "transaction_costs_usd": round2(sum(transaction_costs)),
        "gross_profit_usd": round2(gross_profit_usd),
        "gross_loss_usd": round2(gross_loss_usd),
        "gross_profit_r": round2(gross_profit),
        "gross_loss_r": round2(gross_loss),
        "profit_factor": round2(gross_profit / abs(gross_loss)) if gross_loss else None,
        "expectancy_r": round2(mean),
        "expectancy_usd": round2(net_usd / n),
        "avg_win_r": round2(avg_win),
        "avg_loss_r": round2(avg_loss),
        "payoff_ratio": round2(avg_win / abs(avg_loss)) if avg_loss else None,
        **compute_edge_metrics(
            len(wins) / n * 100,
            avg_win,
            avg_loss,
            risk_per_trade_usd=(sum(risks) / len(risks)) if risks else sizing["risk_usd"],
            initial_capital_usd=initial_capital,
            r_multiples=rs,
        ),
        "largest_win_r": round2(max(rs)),
        "largest_loss_r": round2(min(rs)),
        "value_at_risk_r": round2(var_r),
        "value_at_risk_usd": round2(var_usd),
        "best_win_usd": round2(max(pnls)),
        "worst_loss_usd": round2(min(pnls)),
        "max_consec_wins": max_w,
        "max_consec_losses": max_l,
        "max_trade_drawdown_r": round2(min(rs)),
        "max_drawdown_r": round2(max_dd),
        "max_drawdown_usd": round2(max_dd_usd),
        "max_drawdown_pct": round2(max_dd_pct),
        "recovery_factor": round2(net_r / abs(max_dd)) if max_dd else None,
        "sharpe": round2(mean / std) if std else None,
        "sortino": round2(mean / downside_std) if downside_std else None,
        "calmar": round2(cagr / abs(max_dd_pct)) if cagr is not None and max_dd_pct else None,
        "car_maxdd": round2(cagr / abs(max_dd_pct or max_dd)) if cagr is not None and max_dd else None,
        "rar_maxdd": round2((mean / std) / abs(max_dd)) if std and max_dd else None,
        "ulcer_index": round2(math.sqrt(dd_squared / n)),
        "k_ratio": round2(mean / std) if std else None,
        "avg_hold_min": avg_hold,
        "risk_usd": round2(sum(risks) / len(risks)) if risks else sizing["risk_usd"],
        "avg_quantity": round2(sum(quantities) / len(quantities), 2) if quantities else None,
        "min_quantity": round2(min(quantities), 2) if quantities else None,
        "max_quantity": round2(max(quantities), 2) if quantities else None,
        "group_stats": {
            "all": group_stats(trades),
            "long": group_stats(long_trades),
            "short": group_stats(short_trades),
        },
    }


def build_equity(trades, initial_capital):
    cum = 0
    cum_usd = 0
    peak = 0
    points = []
    for index, trade in enumerate(trades):
        cum += trade["r"]
        cum_usd += trade["pnl_usd"] or 0
        peak = max(peak, cum)
        points.append({
            "i": index,
            "t": epoch_seconds(trade["close_ts"]) if trade["close_ts"] else index,
            "r": round2(cum),
            "balance": round2(initial_capital + cum_usd),
            "dd": round2(cum - peak),
        })
    return points


def build_monthly(trades):
    monthly = {}
    for trade in trades:
        if not trade["close_ts"]:
            continue
        dt = datetime.fromisoformat(trade["close_ts"])
        key = f"{dt.year}-{dt.month:02d}"
        item = monthly.setdefault(key, {"net_r": 0, "trades": 0, "wins": 0})
        item["net_r"] += trade["r"]
        item["trades"] += 1
        if trade["r"] > 0:
            item["wins"] += 1
    return [
        {"month": key, "net_r": round2(value["net_r"]), "trades": value["trades"], "wins": value["wins"]}
        for key, value in sorted(monthly.items())
    ]


def build_strategy_breakdown(trades, initial_capital=None):
    grouped = {}
    for trade in trades:
        grouped.setdefault(trade["strategy_id"] or "-", []).append(trade)
    rows = []
    for strategy_id, items in grouped.items():
        wins = [t for t in items if t["r"] > 0]
        losses = [t for t in items if t["r"] < 0]
        gross_profit = sum(t["r"] for t in wins)
        gross_loss = sum(t["r"] for t in losses)
        net_r = gross_profit + gross_loss
        strategy_risks = [t["risk_usd"] for t in items if t.get("risk_usd") is not None]
        rows.append({
            "strategy_id": strategy_id,
            "strategy_name": items[0].get("strategy_name"),
            "trades": len(items),
            "win_rate": round2(len(wins) / len(items) * 100, 1),
            "net_r": round2(net_r),
            "expectancy_r": round2(net_r / len(items)),
            "profit_factor": round2(gross_profit / abs(gross_loss)) if gross_loss else None,
            **compute_edge_metrics(
                len(wins) / len(items) * 100,
                gross_profit / len(wins) if wins else 0,
                gross_loss / len(losses) if losses else 0,
                risk_per_trade_usd=(sum(strategy_risks) / len(strategy_risks)) if strategy_risks else None,
                initial_capital_usd=initial_capital,
                r_multiples=[t["r"] for t in items],
                fallback_risk_units=100,
            ),
        })
    return sorted(rows, key=lambda row: row["net_r"], reverse=True)


def build_ticker_distribution(trades):
    groups = {}
    for trade in trades:
        ticker = trade.get("symbol") or "Unknown"
        group = groups.setdefault(ticker, {"trades": 0, "wins": 0, "win_r": 0, "pnl_usd": 0})
        group["trades"] += 1
        if trade["r"] > 0:
            group["wins"] += 1
            group["win_r"] += trade["r"]
        group["pnl_usd"] += trade.get("pnl_usd") or 0
    total = len(trades)
    rows = [
        {
            "ticker": ticker,
            "trades": group["trades"],
            "percentage": round2(group["trades"] / total * 100, 2) if total else 0,
            "win_rate": round2(group["wins"] / group["trades"] * 100, 2) if group["trades"] else 0,
            "win_r": round2(group["win_r"]),
            "pnl_usd": round2(group["pnl_usd"]),
        }
        for ticker, group in groups.items()
    ]
    return sorted(rows, key=lambda row: (-row["trades"], row["ticker"]))


def sort_backtest_trades(trades, field, order):
    dated = []
    missing = []
    for trade in trades:
        value = trade.get(field)
        try:
            parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            dated.append((parsed.timestamp(), trade))
        except (TypeError, ValueError):
            missing.append(trade)
    dated.sort(key=lambda item: (item[0], item[1].get("order_id") or ""), reverse=order == "desc")
    return [trade for _, trade in dated] + missing


def research_stats(trades):
    stats = group_stats(trades)
    pnls = [trade["pnl_usd"] or 0 for trade in trades]
    mean = sum(pnls) / len(pnls) if pnls else 0
    variance = sum((value - mean) ** 2 for value in pnls) / len(pnls) if pnls else 0
    equity = peak = 0
    max_drawdown_usd = 0
    for pnl in pnls:
        equity += pnl
        peak = max(peak, equity)
        max_drawdown_usd = min(max_drawdown_usd, equity - peak)
    stats.update({
        "expectancy_usd": round2(mean),
        "trade_sharpe": round2(mean / math.sqrt(variance)) if variance else None,
        "max_drawdown_usd": round2(max_drawdown_usd),
    })
    return stats


def attribution_rows(trades, key_for):
    groups = {}
    for trade in trades:
        groups.setdefault(key_for(trade), []).append(trade)
    rows = [{"label": label, **research_stats(items)} for label, items in groups.items()]
    return sorted(rows, key=lambda row: row.get("net_usd", 0), reverse=True)


def percentile(sorted_values, probability):
    if not sorted_values:
        return 0
    index = min(len(sorted_values) - 1, max(0, math.floor((len(sorted_values) - 1) * probability)))
    return sorted_values[index]


def monte_carlo(trades, initial_capital):
    simulations = 500 if trades else 0
    pnls = [trade["pnl_usd"] or 0 for trade in trades]
    state = 16012026

    def seeded_random():
        nonlocal state
        state = (1664525 * state + 1013904223) & 0xFFFFFFFF
        return state / 4294967296

    ending_equities = []
    max_drawdowns = []
    losing_paths = 0
    drawdown_20_paths = 0
    for _ in range(simulations):
        equity = initial_capital
        peak = initial_capital
        max_drawdown = 0
        for _ in pnls:
            equity += pnls[math.floor(seeded_random() * len(pnls))]
            peak = max(peak, equity)
            max_drawdown = max(max_drawdown, peak - equity)
        ending_equities.append(equity)
        max_drawdowns.append(max_drawdown)
        losing_paths += int(equity < initial_capital)
        drawdown_20_paths += int(max_drawdown >= initial_capital * 0.2)

    ending_equities.sort()
    max_drawdowns.sort()
    return {
        "method": "bootstrap_with_replacement",
        "simulations": simulations,
        "seed": 16012026,
        "ending_equity_p05": round2(percentile(ending_equities, 0.05)),
        "ending_equity_p50": round2(percentile(ending_equities, 0.5)),
        "ending_equity_p95": round2(percentile(ending_equities, 0.95)),
        "max_drawdown_p50_usd": round2(percentile(max_drawdowns, 0.5)),
        "max_drawdown_p95_usd": round2(percentile(max_drawdowns, 0.95)),
        "probability_of_loss_pct": round2(losing_paths / simulations * 100, 1) if simulations else 0,
        "probability_of_20pct_drawdown_pct": round2(drawdown_20_paths / simulations * 100, 1) if simulations else 0,
    }


def parsed_timestamp(value):
    if not value:
        return None
    parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def parse_ict_session_selection(raw):
    if not raw or str(raw).strip().upper() == "ALL":
        return None
    if str(raw).strip().upper() == "NONE":
        return []
    return [
        value
        for value in (part.strip().lower() for part in str(raw).split(","))
        if value in ICT_SESSION_ID_SET
    ]


def _is_india_market(market, symbol):
    normalized_market = str(market or "").upper()
    normalized_symbol = str(symbol or "").upper()
    return (
        normalized_market == "INDIA"
        or normalized_symbol in {"NIFTY50", "BANKNIFTY"}
        or normalized_symbol.endswith((".NS", ".BO"))
        or normalized_symbol.startswith(("NSE:", "BSE:"))
    )


def _inside_ict_window(minute, session):
    if session.get("marker"):
        return minute == session["start"]
    if session["end"] > session["start"]:
        return session["start"] <= minute < session["end"]
    return minute >= session["start"] or minute < session["end"]


def ict_session_ids(timestamp, market=None, symbol=None):
    parsed = parsed_timestamp(timestamp)
    if not parsed:
        return []
    ny_time = parsed.astimezone(NEW_YORK_TIMEZONE)
    ny_minute = ny_time.hour * 60 + ny_time.minute
    india_minute = None
    if _is_india_market(market, symbol):
        india_time = parsed.astimezone(INDIA_TIMEZONE)
        india_minute = india_time.hour * 60 + india_time.minute
    matches = []
    for session in ICT_SESSION_DEFINITIONS:
        if session.get("market") == "INDIA" and india_minute is None:
            continue
        minute = india_minute if session["clock"] == "INDIA" else ny_minute
        if minute is not None and _inside_ict_window(minute, session):
            matches.append(session["id"])
    return matches


def filter_trades_by_ict_sessions(trades, selected_sessions):
    if selected_sessions is None:
        return trades
    selected = set(selected_sessions)
    return [trade for trade in trades if any(session in selected for session in trade.get("ict_sessions", []))]


def ict_session_attribution_rows(trades, selected_sessions):
    allowed = set(ICT_SESSION_IDS if selected_sessions is None else selected_sessions)
    groups = {session_id: [] for session_id in allowed}
    outside = []
    for trade in trades:
        matching = [session for session in trade.get("ict_sessions", []) if session in allowed]
        if not matching and selected_sessions is None:
            outside.append(trade)
        for session in matching:
            groups.setdefault(session, []).append(trade)
    rows = [
        {"label": session["label"], **research_stats(groups[session["id"]])}
        for session in ICT_SESSION_DEFINITIONS
        if session["id"] in allowed and groups.get(session["id"])
    ]
    if outside:
        rows.append({"label": "Outside named ICT windows", **research_stats(outside)})
    return rows


HOLD_TIME_BUCKETS = [
    {"id": "under_15m", "label": "Under 15m", "min": 0, "max": 15, "early": True},
    {"id": "15_30m", "label": "15–30m", "min": 15, "max": 30, "early": True},
    {"id": "30_60m", "label": "30–60m", "min": 30, "max": 60, "early": True},
    {"id": "1_2h", "label": "1–2h", "min": 60, "max": 120, "early": False},
    {"id": "2_4h", "label": "2–4h", "min": 120, "max": 240, "early": False},
    {"id": "4_8h", "label": "4–8h", "min": 240, "max": 480, "early": False},
    {"id": "8_24h", "label": "8–24h", "min": 480, "max": 1440, "early": False},
    {"id": "1_3d", "label": "1–3d", "min": 1440, "max": 4320, "early": False},
    {"id": "3_7d", "label": "3–7d", "min": 4320, "max": 10080, "early": False},
    {"id": "over_7d", "label": "7d+", "min": 10080, "max": math.inf, "early": False},
]


def hold_time_performance_rows(trades):
    total_losses = sum(trade["r"] < 0 for trade in trades)
    total_with_hold = sum(trade.get("hold_min") is not None and trade["hold_min"] >= 0 for trade in trades)
    result = []
    for bucket in HOLD_TIME_BUCKETS:
        rows = [
            trade for trade in trades
            if trade.get("hold_min") is not None and bucket["min"] <= trade["hold_min"] < bucket["max"]
        ]
        if not rows:
            continue
        row_stats = research_stats(rows)
        holds = sorted(trade["hold_min"] for trade in rows)
        equity = peak = max_drawdown_r = 0
        for trade in rows:
            equity += trade["r"]
            peak = max(peak, equity)
            max_drawdown_r = min(max_drawdown_r, equity - peak)
        result.append({
            "bucket_id": bucket["id"],
            "label": bucket["label"],
            "early": bucket["early"],
            "min_minutes": bucket["min"],
            "max_minutes": bucket["max"] if math.isfinite(bucket["max"]) else None,
            "avg_hold_min": round(sum(holds) / len(holds)),
            "median_hold_min": round(holds[(len(holds) - 1) // 2]),
            "trade_share_pct": round2(100 * len(rows) / total_with_hold) if total_with_hold else 0,
            "loss_rate_pct": round2(100 * row_stats["losses"] / len(rows)),
            "loss_concentration_pct": round2(100 * row_stats["losses"] / total_losses) if total_losses else None,
            "expectancy_r": row_stats["avg_r"],
            "max_drawdown_r": round2(max_drawdown_r),
            **row_stats,
        })
    return result


def build_research(trades, sizing, oos_pct, selected_ict_sessions=None):
    split_index = min(len(trades) - 1, max(1, math.floor(len(trades) * (1 - oos_pct / 100)))) if trades else 0
    in_sample = trades[:split_index]
    out_of_sample = trades[split_index:]
    in_stats = research_stats(in_sample)
    out_stats = research_stats(out_of_sample)
    expectancy_degradation = (
        (1 - out_stats["expectancy_usd"] / in_stats["expectancy_usd"]) * 100
        if in_stats["expectancy_usd"] else None
    )
    missing = {
        "filled_price": sum(trade["filled"] is None for trade in trades),
        "stoploss": sum(trade["stop"] is None for trade in trades),
        "close_price": sum(trade["close_price"] is None for trade in trades),
        "timestamps": sum(not trade["filled_at"] or not trade["close_ts"] for trade in trades),
        "quantity": sum(trade["quantity"] is None for trade in trades),
    }
    warnings = []
    if len(trades) < 100:
        warnings.append("Sample contains fewer than 100 closed trades.")
    if len(out_of_sample) < 30:
        warnings.append("Out-of-sample segment contains fewer than 30 trades.")
    if any(missing.values()):
        warnings.append("One or more critical execution fields are missing.")
    if sizing["commission_bps"] + sizing["slippage_bps"] == 0:
        warnings.append("Execution friction is disabled.")
    warnings.extend([
        "No spread, partial-fill, market-impact, borrow, tax, or regulatory-fee model is applied.",
        "This is a chronological holdout, not parameter-optimized walk-forward validation.",
    ])
    checks = [
        {"id": "sample_size", "label": "At least 100 closed trades", "passed": len(trades) >= 100},
        {"id": "oos_sample", "label": "At least 30 out-of-sample trades", "passed": len(out_of_sample) >= 30},
        {"id": "costs", "label": "Commission and slippage enabled", "passed": sizing["commission_bps"] + sizing["slippage_bps"] > 0},
        {"id": "critical_fields", "label": "Critical execution fields complete", "passed": not any(missing.values())},
        {"id": "oos_profitability", "label": "Out-of-sample expectancy positive", "passed": out_stats["expectancy_usd"] > 0},
        {"id": "oos_profit_factor", "label": "Out-of-sample profit factor above 1", "passed": (out_stats["profit_factor"] or 0) > 1},
    ]
    passed_checks = sum(check["passed"] for check in checks)
    close_dates = [parsed_timestamp(trade["close_ts"]) for trade in trades if trade["close_ts"]]

    return {
        "validation": {
            "method": "chronological_holdout",
            "oos_pct": oos_pct,
            "split_trade_index": split_index,
            "split_timestamp": out_of_sample[0]["close_ts"] if out_of_sample else None,
            "in_sample": in_stats,
            "out_of_sample": out_stats,
            "expectancy_degradation_pct": round2(expectancy_degradation) if expectancy_degradation is not None else None,
        },
        "monte_carlo": monte_carlo(trades, sizing["initial_capital"]),
        "attribution": {
            "by_year": attribution_rows(trades, lambda trade: str(parsed_timestamp(trade["close_ts"]).year) if trade["close_ts"] else "Unknown"),
            "by_session": ict_session_attribution_rows(trades, selected_ict_sessions),
            "by_direction": attribution_rows(trades, lambda trade: (trade["direction"] or "Unknown").upper()),
            "by_strategy": attribution_rows(trades, lambda trade: trade["strategy_id"] or "Unknown"),
        },
        "hold_time_performance": hold_time_performance_rows(trades),
        "data_quality": {
            "status": "REVIEW" if len(warnings) > 2 else "PASS",
            "closed_trades": len(trades),
            "first_close_ts": serialize_value(min(close_dates)) if close_dates else None,
            "last_close_ts": serialize_value(max(close_dates)) if close_dates else None,
            "missing": missing,
            "warnings": warnings,
        },
        "audit": {
            "calculation_version": "research-v2",
            "generated_at": datetime.utcnow().isoformat() + "Z",
            "source": "historical_ict_orders + historical_ict_order_target_outcomes",
            "assumptions": [
                f'{sizing["mode"]} sizing',
                f'{round2(sizing["commission_bps"])} bps commission plus {round2(sizing["slippage_bps"])} bps slippage on entry and exit notional',
                "Closed TP and SL outcomes only",
                "Chronological ordering by close timestamp",
                "ICT sessions use entry fill time (entry signal time only when fill time is unavailable), America/New_York DST rules, fixed Asia/Kolkata NSE hours, and inclusive-start/exclusive-end windows",
                "Overlapping ICT windows attribute one trade to every matching selected session",
                "Hold-time buckets are mutually exclusive and use elapsed minutes from fill to close; early buckets cover holds under 60 minutes",
                "Monte Carlo resamples observed net trade P/L with replacement",
            ],
        },
        "deployment_gate": {
            "status": "RESEARCH_PASSED_REVIEW_REQUIRED" if passed_checks == len(checks) else "NOT_READY",
            "passed_checks": passed_checks,
            "total_checks": len(checks),
            "checks": checks,
            "note": "This gate does not approve live capital. Risk, operations, and execution review remain mandatory.",
        },
    }


@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "algo-ict-rest-api"})


@app.get("/api/candles/5m")
def candles_5m():
    if not require_api_token():
        return jsonify({"error": "Unauthorized"}), 401

    market = (request.args.get("market") or "us").strip().lower()
    if market not in MARKETS:
        market = "us"

    tickers = [
        ticker.strip()
        for ticker in (request.args.get("tickers") or "").split(",")
        if ticker.strip()
    ][:25]
    limit = normalize_limit(request.args.get("limit"))

    params = [market]
    filters = ["market = %s"]
    if tickers:
        params.append(tickers)
        filters.append("yahoo_symbol = ANY(%s)")
    params.append(limit)

    query = f"""
        SELECT
          yahoo_symbol,
          base_symbol,
          company_name,
          market,
          exchange_timezone,
          candle_ts,
          open_price,
          high_price,
          low_price,
          close_price,
          volume,
          source,
          fetched_at,
          updated_at
        FROM candles_5m
        WHERE {" AND ".join(filters)}
        ORDER BY candle_ts DESC
        LIMIT %s
    """

    try:
        with psycopg2.connect(**db_config()) as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(query, params)
                rows = [serialize_row(row) for row in cur.fetchall()]
    except Exception as exc:
        return jsonify({
            "table": "candles_5m",
            "market": market,
            "tickers": tickers,
            "limit": limit,
            "error": str(exc),
        }), 500

    return jsonify({
        "table": "candles_5m",
        "market": market,
        "tickers": tickers,
        "limit": limit,
        "rowCount": len(rows),
        "rows": rows,
    })


def _backtest_filter_metadata(_target, symbols=None):
    selected_symbols = symbols if isinstance(symbols, list) else [
        value.strip().upper() for value in str(symbols or "ALL").split(",")
        if value.strip() and value.strip().upper() != "ALL"
    ]
    symbol_filter = " AND UPPER(o.symbol)=ANY(%s)" if selected_symbols else ""
    symbol_params = [selected_symbols] if symbol_filter else []
    with psycopg2.connect(**db_config()) as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                WITH orders AS (
                  SELECT order_id::text AS order_id, symbol, strategy_id, run_date FROM historical_ict_orders
                  UNION ALL SELECT order_id::text, symbol, strategy_id, run_date FROM historical_ict_orders_updated
                  UNION ALL SELECT order_key, ticker, strategy_id, session_date
                  FROM historical_ict_ts01_orders_updated
                  WHERE engine_version='ts01_tb_r2.2026-08-18' AND cohort='primary' AND state='FILLED'
                ), targets AS (
                  SELECT order_id::text AS order_id, target_no, state FROM historical_ict_order_target_outcomes
                  UNION ALL SELECT order_id::text, target_no, state FROM historical_ict_order_target_outcomes_updated
                  UNION ALL SELECT order_key, target_no, state FROM historical_ict_ts01_target_outcomes_updated
                  WHERE engine_version='ts01_tb_r2.2026-08-18' AND cohort='primary'
                )
                SELECT DISTINCT o.symbol FROM orders o JOIN targets t USING(order_id)
                WHERE t.state IN ('CLOSED_TP','CLOSED_SL') ORDER BY o.symbol
                """
            )
            symbols = [row["symbol"] for row in cur.fetchall()]
            cur.execute(
                f"""
                WITH orders AS (
                  SELECT order_id::text AS order_id, symbol, strategy_id FROM historical_ict_orders
                  UNION ALL SELECT order_id::text, symbol, strategy_id FROM historical_ict_orders_updated
                  UNION ALL SELECT order_key, ticker, strategy_id FROM historical_ict_ts01_orders_updated
                  WHERE engine_version='ts01_tb_r2.2026-08-18' AND cohort='primary' AND state='FILLED'
                ), targets AS (
                  SELECT order_id::text AS order_id, target_no, state FROM historical_ict_order_target_outcomes
                  UNION ALL SELECT order_id::text, target_no, state FROM historical_ict_order_target_outcomes_updated
                  UNION ALL SELECT order_key, target_no, state FROM historical_ict_ts01_target_outcomes_updated
                  WHERE engine_version='ts01_tb_r2.2026-08-18' AND cohort='primary'
                )
                SELECT o.strategy_id,
                       CASE WHEN o.strategy_id='TS01-TB' THEN 'ICT 2022 Mentorship' ELSE MIN(r.strategy_name) END AS strategy_name,
                       MIN(r.strategy_key) AS strategy_key,
                       COUNT(DISTINCT o.order_id)::int AS n,
                       ARRAY_AGG(DISTINCT t.target_no ORDER BY t.target_no) AS target_nos
                FROM orders o JOIN targets t USING(order_id)
                LEFT JOIN ict_strategy_reference r ON r.strategy_id=o.strategy_id
                WHERE t.state IN ('CLOSED_TP','CLOSED_SL'){symbol_filter}
                GROUP BY o.strategy_id ORDER BY n DESC
                """,
                symbol_params,
            )
            strategies = [serialize_row(row) for row in cur.fetchall()]
            cur.execute(
                f"""
                WITH orders AS (
                  SELECT order_id::text AS order_id, symbol, run_date FROM historical_ict_orders
                  UNION ALL SELECT order_id::text, symbol, run_date FROM historical_ict_orders_updated
                  UNION ALL SELECT order_key, ticker, session_date FROM historical_ict_ts01_orders_updated
                  WHERE engine_version='ts01_tb_r2.2026-08-18' AND cohort='primary' AND state='FILLED'
                ), targets AS (
                  SELECT order_id::text AS order_id, state FROM historical_ict_order_target_outcomes
                  UNION ALL SELECT order_id::text, state FROM historical_ict_order_target_outcomes_updated
                  UNION ALL SELECT order_key, state FROM historical_ict_ts01_target_outcomes_updated
                  WHERE engine_version='ts01_tb_r2.2026-08-18' AND cohort='primary'
                )
                SELECT DISTINCT EXTRACT(YEAR FROM o.run_date)::int AS y
                FROM orders o JOIN targets t USING(order_id)
                WHERE t.state IN ('CLOSED_TP','CLOSED_SL'){" AND UPPER(o.symbol)=%s" if symbol_filter else ""}
                ORDER BY y DESC
                """,
                [selected_symbols] if symbol_filter else [],
            )
            years = [str(row["y"]) for row in cur.fetchall()]
    return {"symbols": symbols, "strategies": strategies, "years": years}


def _ts01_backtest_payload(symbols, direction, target, year, start_date, end_date, sizing, oos_pct, trade_sort, trade_order, selected_ict_sessions, include_strategy_json=False):
    filters = ["t.engine_version='ts01_tb_r2.2026-08-18'", "t.cohort='primary'", "t.state IN ('CLOSED_TP','CLOSED_SL')", "t.target_no=%s"]
    params = [target]
    if symbols:
        params.append(symbols)
        filters.append("UPPER(o.ticker)=ANY(%s)")
    if direction and direction != "ALL":
        params.append(direction)
        filters.append("UPPER(o.direction)=%s")
    if year and year != "ALL":
        params.append(year)
        filters.append("EXTRACT(YEAR FROM o.session_date)::text=%s")
    if start_date:
        params.append(start_date)
        filters.append("t.close_bar_ts::date >= %s::date")
    if end_date:
        params.append(end_date)
        filters.append("t.close_bar_ts::date <= %s::date")
    with psycopg2.connect(**db_config()) as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                f"""
                SELECT o.order_key AS order_id, o.market, o.ticker AS symbol, o.strategy_id,
                       'ICT 2022 Mentorship'::text AS strategy_name, o.direction,
                       COALESCE(d.entry_ts,o.fill_bar_ts) AS entry_datetime, o.fill_bar_ts AS filled_at,
                       o.theoretical_entry AS entry_price, o.filled_price, o.stop_exec AS stoploss,
                       NULLIF(o.order_json #>> '{{geometry,targets,0,target_exit_price}}','')::double precision AS tp1,
                       t.close_bar_ts AS close_ts, t.close_price, t.target_rr, t.state,
                       d.strategy_json,
                       TRUE AS strategy_json_available,
                       ARRAY(SELECT jsonb_object_keys(d.strategy_json) ORDER BY 1) AS strategy_json_keys
                FROM historical_ict_ts01_orders_updated o
                JOIN historical_ict_ts01_target_outcomes_updated t ON t.order_key=o.order_key
                  AND t.engine_version=o.engine_version AND t.cohort=o.cohort
                JOIN historical_ict_ts01_daily_validation_updated d ON d.engine_version=o.engine_version
                  AND d.cohort=o.cohort AND d.market=o.market AND d.ticker=o.ticker AND d.session_date=o.session_date
                WHERE {' AND '.join(filters)}
                ORDER BY t.close_bar_ts ASC, o.order_key
                """,
                params,
            )
            trades = [apply_sizing(normalize_backtest_trade(row, include_strategy_json), sizing) for row in cur.fetchall()]
            trades = filter_trades_by_ict_sessions(trades, selected_ict_sessions)
            cur.execute(
                """
                WITH daily AS (
                  SELECT * FROM historical_ict_ts01_daily_validation_updated
                  WHERE engine_version='ts01_tb_r2.2026-08-18' AND cohort='primary'
                ), per_order AS (
                  SELECT order_key, COUNT(*) FILTER (WHERE realized_r IS NULL)::int AS unresolved_legs,
                         SUM(COALESCE(realized_r,0)/3.0) AS closed_leg_r
                  FROM historical_ict_ts01_target_outcomes_updated
                  WHERE engine_version='ts01_tb_r2.2026-08-18' AND cohort='primary' GROUP BY order_key
                )
                SELECT 'TS01-TB'::text AS strategy_id, 'ICT 2022 Mentorship'::text AS strategy_name,
                       'ts01_tb_r2.2026-08-18'::text AS engine_version, 'primary'::text AS cohort,
                       COUNT(*)::int AS sessions, COUNT(*) FILTER(WHERE attempted)::int AS attempts,
                       COUNT(*) FILTER(WHERE filled)::int AS fills,
                       COUNT(*) FILTER(WHERE status='EXCLUDED_DATA_QUALITY')::int AS excluded_sessions,
                       MIN(session_date) AS first_session, MAX(session_date) AS last_session,
                       (SELECT COUNT(*) FILTER(WHERE unresolved_legs=0)::int FROM per_order) AS fully_resolved_fills,
                       (SELECT COUNT(*) FILTER(WHERE unresolved_legs>0)::int FROM per_order) AS unresolved_fills,
                       (SELECT COALESCE(SUM(unresolved_legs),0)::int FROM per_order) AS unresolved_legs,
                       (SELECT ROUND(SUM(closed_leg_r)::numeric,4) FROM per_order WHERE unresolved_legs=0) AS fully_resolved_net_r,
                       (SELECT ROUND(SUM(closed_leg_r)::numeric,4) FROM per_order) AS closed_leg_net_r
                FROM daily
                """
            )
            profile = serialize_row(cur.fetchone())
    max_rows = 1500
    sorted_trades = sort_backtest_trades(trades, trade_sort, trade_order)
    trades_out = sorted_trades if include_strategy_json else sorted_trades[:max_rows]
    return {
        "success": True, "source": "postgres", "summary": compute_metrics(trades, sizing),
        "equity": build_equity(trades, sizing["initial_capital"]), "monthly": build_monthly(trades),
        "strategy_breakdown": build_strategy_breakdown(trades, sizing["initial_capital"]),
        "ticker_distribution": build_ticker_distribution(trades), "strategy_profile": profile,
        "research": build_research(trades, sizing, oos_pct, selected_ict_sessions), "trades": trades_out,
        "total_trades": len(trades), "returned": len(trades_out),
    }


@app.get("/api/backtest")
def backtest():
    if not require_api_token():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    filters_only = request.args.get("filters_only") == "true"
    symbol = (request.args.get("symbol") or ("ALL" if filters_only else "AAPL")).strip().upper()
    selected_symbols = [value.strip() for value in symbol.split(",") if value.strip() and value.strip() != "ALL"]
    strategy = (request.args.get("strategy_id") or "S16").strip().upper()
    selected_strategies = [value.strip() for value in strategy.split(",") if value.strip() and value.strip() != "ALL"]
    direction = (request.args.get("direction") or "ALL").strip().upper()
    target = target_no(request.args.get("target_no"))
    year = (request.args.get("year") or "ALL").strip()
    start_date = clean_date(request.args.get("start_date"))
    end_date = clean_date(request.args.get("end_date"))
    trade_sort = "entry_datetime" if request.args.get("trade_sort") == "entry_datetime" else "close_ts"
    trade_order = "asc" if request.args.get("trade_order") == "asc" else "desc"
    csv_export = request.args.get("format") == "csv"
    selected_ict_sessions = parse_ict_session_selection(request.args.get("ict_sessions"))
    sizing_mode = "fixed_qty" if request.args.get("sizing_mode") == "fixed_qty" else "fixed_risk"
    try:
        risk_usd = max(1, float(request.args.get("risk_usd") or 100))
    except ValueError:
        risk_usd = 100
    try:
        initial_capital = max(1, float(request.args.get("initial_capital") or 100000))
    except ValueError:
        initial_capital = 100000
    try:
        quantity = max(1, float(request.args.get("quantity") or 100))
    except ValueError:
        quantity = 100
    try:
        commission_bps = max(0, float(request.args.get("commission_bps") or 1))
    except ValueError:
        commission_bps = 1
    try:
        slippage_bps = max(0, float(request.args.get("slippage_bps") or 2))
    except ValueError:
        slippage_bps = 2
    try:
        oos_pct = min(50, max(10, float(request.args.get("oos_pct") or 30)))
    except ValueError:
        oos_pct = 30
    sizing = {
        "mode": sizing_mode,
        "initial_capital": initial_capital,
        "risk_usd": risk_usd,
        "quantity": quantity,
        "commission_bps": commission_bps,
        "slippage_bps": slippage_bps,
    }

    if filters_only:
        try:
            return jsonify({"success": True, "source": "postgres", "filters": _backtest_filter_metadata(target, selected_symbols)})
        except Exception as exc:
            return jsonify({"success": False, "error": str(exc)}), 500

    if selected_strategies == ["TS01-TB"]:
        try:
            payload = _ts01_backtest_payload(selected_symbols, direction, target, year, start_date, end_date, sizing, oos_pct, trade_sort, trade_order, selected_ict_sessions, csv_export)
            if csv_export:
                return backtest_csv_response(payload["trades"])
            payload["params"] = {"symbol": symbol, "strategy": strategy, "direction": direction, "target_no": target,
                                 "year": year, "start_date": start_date, "end_date": end_date, "sizing_mode": sizing_mode,
                                 "trade_sort": trade_sort, "trade_order": trade_order,
                                 "ict_sessions": "ALL" if selected_ict_sessions is None else ",".join(selected_ict_sessions) if selected_ict_sessions else "NONE",
                                 "initial_capital": initial_capital, "risk_usd": risk_usd, "quantity": quantity,
                                 "commission_bps": commission_bps, "slippage_bps": slippage_bps, "oos_pct": oos_pct}
            if request.args.get("include_filters") != "false":
                payload["filters"] = _backtest_filter_metadata(target, selected_symbols)
            return jsonify(payload)
        except Exception as exc:
            return jsonify({"success": False, "error": str(exc)}), 500

    filters = ["t.state IN ('CLOSED_TP','CLOSED_SL')", "t.target_no = %s"]
    params = [target]
    if selected_symbols:
        params.append(selected_symbols)
        filters.append("UPPER(o.symbol) = ANY(%s)")
    if selected_strategies:
        params.append(selected_strategies)
        filters.append("UPPER(o.strategy_id) = ANY(%s)")
    if direction and direction != "ALL":
        params.append(direction)
        filters.append(f"UPPER(o.direction) = %s")
    if year and year != "ALL":
        params.append(year)
        filters.append(f"EXTRACT(YEAR FROM o.run_date)::text = %s")
    if start_date:
        params.append(start_date)
        filters.append("t.close_ts::date >= %s::date")
    if end_date:
        params.append(end_date)
        filters.append("t.close_ts::date <= %s::date")
    where = " AND ".join(filters)

    try:
        with psycopg2.connect(**db_config()) as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT DISTINCT o.symbol
                    FROM historical_ict_orders o
                    JOIN historical_ict_order_target_outcomes t ON t.order_id = o.order_id
                    WHERE t.state IN ('CLOSED_TP','CLOSED_SL')
                    ORDER BY o.symbol
                    """
                )
                symbols = [row["symbol"] for row in cur.fetchall()]

                cur.execute(
                    f"""
                    SELECT o.strategy_id, MIN(r.strategy_name) AS strategy_name, MIN(r.strategy_key) AS strategy_key, COUNT(*)::int AS n
                    FROM historical_ict_orders o
                    JOIN historical_ict_order_target_outcomes t ON t.order_id = o.order_id
                    LEFT JOIN ict_strategy_reference r ON r.strategy_id = o.strategy_id
                    WHERE t.state IN ('CLOSED_TP','CLOSED_SL') AND t.target_no = %s
                    {"AND UPPER(o.symbol) = ANY(%s)" if selected_symbols else ""}
                    GROUP BY o.strategy_id
                    ORDER BY n DESC
                    """,
                    [target, selected_symbols] if selected_symbols else [target],
                )
                strategies = [serialize_row(row) for row in cur.fetchall()]

                cur.execute(
                    f"""
                    SELECT DISTINCT EXTRACT(YEAR FROM o.run_date)::int AS y
                    FROM historical_ict_orders o
                    JOIN historical_ict_order_target_outcomes t ON t.order_id = o.order_id
                    WHERE t.state IN ('CLOSED_TP','CLOSED_SL')
                    {"AND UPPER(o.symbol) = ANY(%s)" if selected_symbols else ""}
                    ORDER BY y DESC
                    """,
                    [selected_symbols] if selected_symbols else [],
                )
                years = [str(row["y"]) for row in cur.fetchall()]

                cur.execute(
                    f"""
                    SELECT o.order_id, o.market, o.symbol, o.strategy_id, r.strategy_name, o.direction,
                           COALESCE(s.entry_datetime, o.filled_at) AS entry_datetime, o.filled_at,
                           o.entry_price, o.filled_price, o.stoploss, o.tp1,
                           o.risk_probability, o.risk_bin,
                           t.close_ts, t.close_price, t.target_rr, t.state,
                           s.strategy_json,
                           (s.strategy_json IS NOT NULL) AS strategy_json_available,
                           CASE WHEN jsonb_typeof(s.strategy_json) = 'object' THEN
                             ARRAY(SELECT jsonb_object_keys(s.strategy_json) ORDER BY 1)
                           ELSE ARRAY[]::text[] END AS strategy_json_keys
                    FROM historical_ict_orders o
                    JOIN historical_ict_order_target_outcomes t ON t.order_id = o.order_id
                    LEFT JOIN ict_strategy_reference r ON r.strategy_id = o.strategy_id
                    LEFT JOIN historical_ict_strategy_met_execution s ON s.signal_hash = o.signal_id
                    WHERE {where}
                    ORDER BY t.close_ts ASC NULLS LAST, o.order_id
                    """,
                    params,
                )
                trades = [apply_sizing(normalize_backtest_trade(row, csv_export), sizing) for row in cur.fetchall()]
                trades = filter_trades_by_ict_sessions(trades, selected_ict_sessions)
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500

    sorted_trades = sort_backtest_trades(trades, trade_sort, trade_order)
    if csv_export:
        return backtest_csv_response(sorted_trades)
    max_rows = 1500
    trades_out = sorted_trades[:max_rows]
    return jsonify({
        "success": True,
        "source": "postgres",
        "params": {
            "symbol": symbol,
            "strategy": strategy,
            "direction": direction,
            "target_no": target,
            "year": year,
            "start_date": start_date,
            "end_date": end_date,
            "trade_sort": trade_sort,
            "trade_order": trade_order,
            "ict_sessions": "ALL" if selected_ict_sessions is None else ",".join(selected_ict_sessions) if selected_ict_sessions else "NONE",
            "sizing_mode": sizing_mode,
            "initial_capital": initial_capital,
            "risk_usd": risk_usd,
            "quantity": quantity,
            "commission_bps": commission_bps,
            "slippage_bps": slippage_bps,
            "oos_pct": oos_pct,
        },
        "filters": {"symbols": symbols, "strategies": strategies, "years": years},
        "summary": compute_metrics(trades, sizing),
        "equity": build_equity(trades, initial_capital),
        "monthly": build_monthly(trades),
        "strategy_breakdown": build_strategy_breakdown(trades, sizing["initial_capital"]),
        "ticker_distribution": build_ticker_distribution(trades),
        "research": build_research(trades, sizing, oos_pct, selected_ict_sessions),
        "trades": trades_out,
        "total_trades": len(trades),
        "returned": len(trades_out),
    })


@app.get("/api/backtest/trade-context")
def backtest_trade_context():
    if not require_api_token():
        return jsonify({"success": False, "error": "Unauthorized"}), 401
    order_id = (request.args.get("order_id") or "").strip()
    if not order_id or len(order_id) > 64:
        return jsonify({"success": False, "error": "valid order_id required"}), 400
    try:
        with psycopg2.connect(**db_config()) as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    WITH orders AS (
                        SELECT 'original'::text AS pipeline, order_id::text AS order_id, signal_id, symbol, strategy_id FROM historical_ict_orders
                        UNION ALL
                        SELECT 'updated'::text AS pipeline, order_id::text AS order_id, signal_id, symbol, strategy_id FROM historical_ict_orders_updated
                        UNION ALL
                        SELECT 'ts01'::text AS pipeline, order_key, order_key, ticker, strategy_id
                        FROM historical_ict_ts01_orders_updated
                        WHERE engine_version='ts01_tb_r2.2026-08-18' AND cohort='primary' AND state='FILLED'
                    ), signals AS (
                        SELECT 'original'::text AS pipeline, signal_hash, ticker, strategy_id,
                               entry_datetime, strategy_json
                        FROM historical_ict_strategy_met_execution
                        UNION ALL
                        SELECT 'updated'::text AS pipeline, signal_hash, ticker, strategy_id,
                               entry_datetime, strategy_json
                        FROM historical_ict_strategy_met_execution_updated
                        UNION ALL
                        SELECT 'ts01'::text AS pipeline, o.order_key, o.ticker, o.strategy_id,
                               COALESCE(d.entry_ts,o.fill_bar_ts), d.strategy_json
                        FROM historical_ict_ts01_orders_updated o
                        JOIN historical_ict_ts01_daily_validation_updated d ON d.engine_version=o.engine_version
                          AND d.cohort=o.cohort AND d.market=o.market AND d.ticker=o.ticker AND d.session_date=o.session_date
                        WHERE o.engine_version='ts01_tb_r2.2026-08-18' AND o.cohort='primary' AND o.state='FILLED'
                    )
                    SELECT o.order_id, COALESCE(s.ticker, o.symbol) AS ticker,
                           COALESCE(s.strategy_id, o.strategy_id) AS strategy_id,
                           s.entry_datetime, s.pipeline, s.strategy_json
                    FROM orders o
                    LEFT JOIN signals s ON s.signal_hash=o.signal_id AND s.pipeline=o.pipeline
                    WHERE o.order_id=%s
                    LIMIT 1
                    """,
                    [order_id],
                )
                row = cur.fetchone()
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500
    if not row:
        return jsonify({"success": False, "error": "trade not found"}), 404
    return jsonify({"success": True, "trade": serialize_row(row)})


@app.get("/api/backtest/order-chart")
def backtest_order_chart():
    if not require_api_token():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    order_id = (request.args.get("order_id") or "").strip()
    target = target_no(request.args.get("target_no"))
    if not order_id:
        return jsonify({"success": False, "error": "order_id required"}), 400

    try:
        with psycopg2.connect(**db_config()) as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT o.pipeline, o.order_id, o.signal_id, o.symbol, o.market, o.direction,
                           o.entry_price, o.filled_price, o.stoploss, o.tp1, o.tp2, o.tp3,
                           o.filled_at, t.target_no, t.target_price, t.target_rr, t.state,
                           t.close_ts, t.close_price, t.close_reason
                    FROM (
                        SELECT 'original'::text AS pipeline, order_id::text AS order_id, signal_id, symbol, market, direction, entry_price, filled_price,
                               stoploss, tp1, tp2, tp3, filled_at
                        FROM historical_ict_orders
                        UNION ALL
                        SELECT 'updated'::text AS pipeline, order_id::text AS order_id, signal_id, symbol, market, direction, entry_price, filled_price,
                               stoploss, tp1, tp2, tp3, filled_at
                        FROM historical_ict_orders_updated
                        UNION ALL
                        SELECT 'ts01'::text, order_key, order_key, ticker, market, direction, theoretical_entry, filled_price,
                               stop_exec,
                               NULLIF(order_json #>> '{geometry,targets,0,target_exit_price}','')::double precision,
                               NULLIF(order_json #>> '{geometry,targets,1,target_exit_price}','')::double precision,
                               NULLIF(order_json #>> '{geometry,targets,2,target_exit_price}','')::double precision,
                               fill_bar_ts
                        FROM historical_ict_ts01_orders_updated
                        WHERE engine_version='ts01_tb_r2.2026-08-18' AND cohort='primary' AND state='FILLED'
                    ) o
                    JOIN (
                        SELECT 'original'::text AS pipeline, order_id::text AS order_id, target_no, target_price, target_rr, state, close_ts, close_price, close_reason
                        FROM historical_ict_order_target_outcomes
                        UNION ALL
                        SELECT 'updated'::text AS pipeline, order_id::text AS order_id, target_no, target_price, target_rr, state, close_ts, close_price, close_reason
                        FROM historical_ict_order_target_outcomes_updated
                        UNION ALL
                        SELECT 'ts01'::text, order_key, target_no, target_price, target_rr, state,
                               close_bar_ts, close_price, target_json->>'reason'
                        FROM historical_ict_ts01_target_outcomes_updated
                        WHERE engine_version='ts01_tb_r2.2026-08-18' AND cohort='primary'
                    ) t ON t.order_id = o.order_id AND t.pipeline = o.pipeline
                    WHERE o.order_id = %s AND t.target_no = %s
                    LIMIT 1
                    """,
                    [order_id, target],
                )
                order = cur.fetchone()
                if not order:
                    return jsonify({"success": False, "error": "order not found"}), 404

                # Older-candle window fetch (lazy pan-left): return only candles.
                try:
                    _from_ts = float(request.args.get("from_ts")) if request.args.get("from_ts") else None
                except (TypeError, ValueError):
                    _from_ts = None
                try:
                    _to_ts = float(request.args.get("to_ts")) if request.args.get("to_ts") else None
                except (TypeError, ValueError):
                    _to_ts = None
                if _from_ts and _to_ts and _from_ts > 0 and _to_ts > _from_ts:
                    _from_dt = datetime.fromtimestamp(_from_ts).isoformat()
                    _to_dt = datetime.fromtimestamp(_to_ts).isoformat()
                    cur.execute(
                        """
                        SELECT candle_ts, open_price, high_price, low_price, close_price
                        FROM historical_candles_5m
                        WHERE (yahoo_symbol = %s OR base_symbol = %s)
                          AND candle_ts >= %s::timestamptz AND candle_ts <= %s::timestamptz
                        ORDER BY candle_ts ASC LIMIT 3000
                        """,
                        [order["symbol"], order["symbol"], _from_dt, _to_dt],
                    )
                    older = [
                        {"time": epoch_seconds(r["candle_ts"]), "open": num(r["open_price"]), "high": num(r["high_price"]), "low": num(r["low_price"]), "close": num(r["close_price"])}
                        for r in cur.fetchall()
                    ]
                    older = [r for r in older if r["time"] is not None and r["open"] is not None]
                    return jsonify({"success": True, "candles": older, "window": {"from": _from_ts, "to": _to_ts}, "timeframe": "5m"})

                signal = None
                if order.get("signal_id"):
                    cur.execute(
                        """
                        SELECT strategy_json, direction, strategy_id
                        FROM (
                            SELECT 'original'::text AS pipeline, signal_hash, strategy_json, direction, strategy_id FROM historical_ict_strategy_met_execution
                            UNION ALL
                            SELECT 'updated'::text AS pipeline, signal_hash, strategy_json, direction, strategy_id FROM historical_ict_strategy_met_execution_updated
                            UNION ALL
                            SELECT 'ts01'::text, o.order_key, d.strategy_json, o.direction, o.strategy_id
                            FROM historical_ict_ts01_orders_updated o
                            JOIN historical_ict_ts01_daily_validation_updated d ON d.engine_version=o.engine_version
                              AND d.cohort=o.cohort AND d.market=o.market AND d.ticker=o.ticker AND d.session_date=o.session_date
                            WHERE o.engine_version='ts01_tb_r2.2026-08-18' AND o.cohort='primary' AND o.state='FILLED'
                        ) signals
                        WHERE signal_hash = %s AND pipeline = %s
                        LIMIT 1
                        """,
                        [order["signal_id"], order["pipeline"]],
                    )
                    signal = cur.fetchone()
                strategy_json = signal.get("strategy_json") if signal and isinstance(signal.get("strategy_json"), dict) else {}
                is_s10v2 = str((signal or {}).get("strategy_id") or strategy_json.get("strategy_id") or "").upper() == "S10-V2"
                s10_evidence = _s10v2_chart_overlays(strategy_json, (signal or {}).get("direction")) if is_s10v2 else None

                filled_sec = epoch_seconds(order["filled_at"]) or 0
                close_sec = epoch_seconds(order["close_ts"]) or filled_sec
                span = max(close_sec - filled_sec, 3600)
                table = "historical_candles_5m" if span <= 4 * 86400 else "historical_candles_1h" if span <= 25 * 86400 else "candles_1d"
                pad = max(span * 0.4, 45 * 86400) if order["pipeline"] == "ts01" else max(span * 0.4, 30 * (300 if table.endswith("5m") else 3600 if table.endswith("1h") else 86400))
                evidence_from = filled_sec - pad
                if s10_evidence and s10_evidence.get("earliest_time") is not None:
                    evidence_from = s10_evidence["earliest_time"] - s10_evidence["timeframe_seconds"]
                from_dt = datetime.fromtimestamp(min(filled_sec - pad, evidence_from)).isoformat()
                to_dt = datetime.fromtimestamp(close_sec + pad).isoformat()

                cur.execute(
                    f"""
                    SELECT candle_ts, open_price, high_price, low_price, close_price
                    FROM {table}
                    WHERE (yahoo_symbol = %s OR base_symbol = %s)
                      AND candle_ts >= %s::timestamptz AND candle_ts <= %s::timestamptz
                    ORDER BY candle_ts ASC
                    LIMIT {8000 if order["pipeline"] == "ts01" else 1500}
                    """,
                    [order["symbol"], order["symbol"], from_dt, to_dt],
                )
                candles = [
                    {
                        "time": epoch_seconds(row["candle_ts"]),
                        "open": num(row["open_price"]),
                        "high": num(row["high_price"]),
                        "low": num(row["low_price"]),
                        "close": num(row["close_price"]),
                    }
                    for row in cur.fetchall()
                ]
                candles = [row for row in candles if row["time"] is not None and row["open"] is not None]

                overlays = json.loads(json.dumps(EMPTY_OVERLAYS))
                overlays["timeframe_5m"] = {}
                if signal:
                    if s10_evidence:
                        overlays = s10_evidence["overlays"]
                    if order["pipeline"] == "ts01":
                        overlays = _ts01_chart_overlays(strategy_json, signal.get("direction"))
                    pattern = strategy_json.get("pattern") if isinstance(strategy_json.get("pattern"), dict) else {}
                    ipda_range = pattern.get("ipda_range") if isinstance(pattern.get("ipda_range"), dict) else {}
                    values = {name: num(ipda_range.get(name)) for name in ("low", "q25", "eq50", "q75", "high")}
                    if all(value is not None for value in values.values()):
                        overlays["ipda"] = {
                            **values,
                            "start_time": epoch_seconds(ipda_range.get("start_ts")),
                            "end_time": epoch_seconds(ipda_range.get("end_ts")),
                            "sessions": num(ipda_range.get("sessions")) or 20,
                            "selected_level": pattern.get("ipda_level_name"),
                        }
                    fvg = pattern.get("fvg") if isinstance(pattern.get("fvg"), dict) else {}
                    fvg_time = epoch_seconds(fvg.get("formation_ts"))
                    fvg_low, fvg_high = num(fvg.get("zone_low")), num(fvg.get("zone_high"))
                    if fvg_time is not None and fvg_low is not None and fvg_high is not None:
                        overlays["timeframe_5m"]["fvgs"] = [{
                            "kind": "fvg", "top": fvg_high, "bottom": fvg_low, "time": fvg_time,
                            "direction": fvg.get("direction") or signal.get("direction"), "broken": False,
                            "mitigated": False, "filled": False, "label": "VIRGIN FVG · FIRST TOUCH",
                        }]
                    mss = pattern.get("mss") if isinstance(pattern.get("mss"), dict) else {}
                    mss_time = epoch_seconds(mss.get("break_ts"))
                    mss_price = num(mss.get("break_close"))
                    if mss_time is not None and mss_price is not None:
                        overlays["timeframe_5m"]["structure"] = [{
                            "kind": "mss", "top": mss_price, "bottom": mss_price, "time": mss_time,
                            "direction": mss.get("direction") or signal.get("direction"), "broken": False,
                            "mitigated": False, "filled": False, "label": "MSS · CLOSE CONFIRMED",
                        }]
                    swing = pattern.get("previous_confirmed_swing_stop") if isinstance(pattern.get("previous_confirmed_swing_stop"), dict) else {}
                    swing_time = epoch_seconds(swing.get("confirmation_ts") or swing.get("pivot_ts"))
                    swing_price = num(swing.get("price"))
                    if swing_time is not None and swing_price is not None:
                        overlays["timeframe_5m"]["swings"] = [{
                            "kind": "swing", "level": swing_price, "time": swing_time,
                            "side": swing.get("kind"), "direction": signal.get("direction"),
                            "label": f"{str(swing.get('timeframe') or 'STRUCTURAL').upper()} STOP SWING",
                        }]
                    sweep = pattern.get("liquidity_extreme") if isinstance(pattern.get("liquidity_extreme"), dict) else {}
                    sweep_time = epoch_seconds(sweep.get("source_ts"))
                    sweep_price = num(sweep.get("price"))
                    if sweep_time is not None and sweep_price is not None:
                        overlays["timeframe_5m"]["liquidity"] = [{
                            "kind": "liquidity", "level": sweep_price, "time": sweep_time,
                            "side": None, "direction": signal.get("direction"),
                            "label": "LIQUIDITY SWEEP",
                        }]
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500

    is_win = order["state"] == "CLOSED_TP"
    rr = num(order["target_rr"])
    return jsonify({
        "success": True,
        "order": {
            "order_id": str(order["order_id"]),
            "symbol": order["symbol"],
            "market": order["market"],
            "direction": order["direction"],
            "entry_price": num(order["entry_price"]),
            "filled_price": num(order["filled_price"]),
            "stoploss": num(order["stoploss"]),
            "tp1": num(order["tp1"]),
            "tp2": num(order["tp2"]),
            "tp3": num(order["tp3"]),
            "filled_at": serialize_value(order["filled_at"]),
            "close_ts": serialize_value(order["close_ts"]),
            "close_price": num(order["close_price"]),
            "close_reason": order["close_reason"],
            "target_no": order["target_no"],
            "target_price": num(order["target_price"]),
            "realized_r": rr if is_win and rr is not None else -1,
            "outcome": "WIN" if is_win else "LOSS",
        },
        "timeframe": table,
        "markers": {
            "entry": {"time": filled_sec, "price": num(order["filled_price"]) or num(order["entry_price"])},
            "exit": {"time": close_sec, "price": num(order["close_price"]), "outcome": "WIN" if is_win else "LOSS"},
        },
        "candles": candles,
        "overlays": overlays,
    })


# Keep in sync with src/lib/realtime-rows-sql.ts (includes the IGS01V2 OANDA
# live signals, which live in their own table).
REALTIME_ROWS_SOURCE = """(
  SELECT s.signal_hash, s.market, s.ticker, s.base_symbol, s.company_name,
         s.exchange_timezone, s.direction, s.entry_datetime, s.entry_date,
         s.strategy_id, s.strategy, s.strategy_key, s.entry_price AS signal_entry_price,
         s.stoploss AS signal_stoploss, s.target_1, s.target_2, s.target_3, s.as_of_ts,
         s.strategy_json,
         o.order_id::text AS order_id, o.state, o.order_type, o.qty, o.entry_price, o.filled_price,
         o.stoploss, o.tp1, o.tp2, o.tp3, o.filled_at, o.close_price, o.close_ts,
         o.close_reason, o.updated_at, o.risk_probability, o.risk_bin,
         NULL::double precision AS live_realized_r
  FROM realtime_production_ict_strategy_met_execution s
  LEFT JOIN realtime_production_orders o ON o.signal_id = s.signal_hash
  UNION ALL
  -- IGS01V2 live (OANDA). A signal only becomes an order once OANDA accepted
  -- it; non-tradeable (low risk-bin) signals stay visible as signal-only rows.
  SELECT g.signal_id, 'forex', g.symbol, REPLACE(g.symbol, '^', ''), NULL::text, 'America/New_York',
         CASE WHEN g.side > 0 THEN 'BUY' ELSE 'SELL' END, g.entry_ts, g.run_date,
         'IGS01V2_LondonLiqGrab_SweepReversal', 'London Killzone Sweep Reversal (V2, no IFVG)', 'IGS01V2',
         g.signal_entry, g.stop, g.tp1, g.tp2, g.tp3, g.created_at,
         jsonb_build_object('source', 'igs01v2_live_signals', 'broker', 'OANDA', 'tradeable', g.tradeable, 'skip_reason', g.skip_reason,
           'oanda_order_id', g.oanda_order_id, 'oanda_state', g.oanda_state, 'fill_state', g.fill_state, 'exit_reason', g.exit_reason,
           'units', g.units, 'risk_pips', g.risk_pips, 'realized_pl', g.realized_pl, 'realized_r', g.realized_r,
           'ml_score', jsonb_build_object('prob', g.probability, 'bin', g.risk_bin, 'model_version', g.model_version),
           'features', g.features),
         CASE WHEN g.oanda_order_id IS NOT NULL THEN 'OANDA:' || g.oanda_order_id END,
         CASE
           WHEN g.oanda_order_id IS NULL THEN NULL
           WHEN UPPER(COALESCE(g.fill_state, g.oanda_state, '')) = 'CLOSED' THEN
             CASE WHEN UPPER(COALESCE(g.exit_reason, '')) IN ('TARGET', 'TP', 'TAKE_PROFIT') THEN 'CLOSED_TP'
                  WHEN UPPER(COALESCE(g.exit_reason, '')) IN ('STOP', 'SL', 'STOP_LOSS') THEN 'CLOSED_SL'
                  ELSE 'CLOSED_' || COALESCE(NULLIF(UPPER(g.exit_reason), ''), 'OTHER') END
           WHEN UPPER(COALESCE(g.fill_state, g.oanda_state, '')) IN ('FILLED', 'OPEN', 'TRADE_OPEN') THEN 'OPEN'
           WHEN UPPER(COALESCE(g.fill_state, g.oanda_state, '')) IN ('EXPIRED', 'CANCELLED', 'CANCELED', 'REJECTED')
             THEN UPPER(COALESCE(g.fill_state, g.oanda_state))
           ELSE 'PENDING'
         END,
         'LIMIT', ABS(g.units)::numeric, g.signal_entry, g.fill_price, g.stop, g.tp1, g.tp2, g.tp3,
         g.fill_ts, g.close_price, g.close_ts, g.exit_reason, COALESCE(g.reconciled_at, g.created_at),
         g.probability, g.risk_bin,
         -- OANDA's realized R is measured against the planned risk; recomputing
         -- it from the fill price would disagree with the broker record.
         CASE WHEN g.close_ts IS NOT NULL THEN g.realized_r END
  FROM igs01v2_live_signals g
  UNION ALL
  -- Isolated MSS paper lane: historical backfills are labelled, never broker orders.
  SELECT m.signal_hash,m.market,m.ticker,REPLACE(m.ticker,'^',''),
         'MSS reversal · ' || m.source_mode,'America/New_York',m.direction,m.entry_datetime,m.entry_date,
         'MSS-REVERSAL-D1-M5-CLOSE','MSS reversal · Daily/5m close CHOCH','MSS_REVERSAL',
         m.entry_price,m.stoploss,m.tp1,NULL::double precision,NULL::double precision,m.observed_at,
         m.strategy_json,m.order_id::text,m.state,'PAPER_LIMIT',1::numeric,m.entry_price,m.entry_price,
         m.stoploss,m.tp1,NULL::double precision,NULL::double precision,m.entry_datetime,
         m.close_price,m.close_ts,m.close_reason,m.updated_at,NULL::double precision,NULL::integer,m.realized_r
  FROM realtime_production_mss_reversal_orders m
  WHERE NOT(m.strategy_json ? 'superseded_by_completed_backfill')
  UNION ALL
  SELECT k.signal_hash,k.market,k.ticker,REPLACE(k.ticker,'^',''),
         'k1_reclaim3 · ' || k.source_mode,'America/New_York',k.direction,k.entry_datetime,(k.entry_datetime AT TIME ZONE 'America/New_York')::date,
         'REV-k1_reclaim3-OTE62-2R-TOUCH-' || k.timeframe,'k1_reclaim3 · OTE 62% limit · 2R · Touch','REVERSAL_K1',
         k.entry_price,k.stoploss,k.tp1,NULL::double precision,NULL::double precision,k.observed_at,
         -- Same rule as src/lib/realtime-rows-sql.ts: later orders on the same ICT liquidity event are DUPLICATE_SETUP.
         k.strategy_json || jsonb_build_object('setup_key',k.setup_key,'duplicate_of',k.duplicate_of,'duplicate_of_timeframe',k.duplicate_of_timeframe,'raw_state',k.state),
         k.order_id::text,CASE WHEN k.duplicate_of IS NOT NULL THEN 'DUPLICATE_SETUP' ELSE k.state END,'PAPER_LIMIT',1::numeric,k.entry_price,k.entry_price,
         k.stoploss,k.tp1,NULL::double precision,NULL::double precision,k.entry_datetime,
         k.close_price,k.close_ts,CASE WHEN k.duplicate_of IS NOT NULL THEN NULL WHEN k.state='CLOSED_SL' THEN 'STOP' WHEN k.state='CLOSED_TP' THEN 'TARGET' END,k.updated_at,NULL::double precision,NULL::integer,
         CASE WHEN k.duplicate_of IS NULL THEN k.realized_r END
  FROM realtime_production_reversal_k1_setups k
  UNION ALL
  -- Scalping_OB_OB_V4 PAPER lane (no broker orders): realized_r blends the 50% partial at +2R with the remainder's exit.
  SELECT v.signal_hash,v.market,v.ticker,v.ticker,
         'Scalping OB x OB V4 - ' || v.source_mode,'America/New_York',v.direction,v.entry_datetime,(v.entry_datetime AT TIME ZONE 'America/New_York')::date,
         'Scalping_OB_OB_V4','Scalping OB x OB V4 - 1h OB x 5m OB - 50% at +2R - 5m close SL','SCALPING_OB_OB_V4',
         v.entry_price,v.stoploss,v.tp1,NULL::double precision,NULL::double precision,v.observed_at,
         v.strategy_json || jsonb_build_object('partial_price',v.partial_price,'partial_at',v.partial_at,'planned_rr',v.planned_rr,'risk_bps',v.risk_bps,'execution_mode',v.execution_mode,
           'execution_status',v.execution_status,'armed_at',v.armed_at,'drift_r',v.drift_r,
           'atm_option',CASE WHEN ol.order_id IS NULL THEN NULL ELSE jsonb_build_object('occ_symbol',ol.occ_symbol,'type',ol.option_type,'expiration',ol.expiration,
             'strike',ol.strike,'entry_price',ol.entry_option_price,'entry_bid',ol.entry_bid,'entry_ask',ol.entry_ask,'partial_price',ol.partial_option_price,
             'exit_price',ol.exit_option_price,'return_pct',ol.option_return_pct,'price_source',ol.price_source,
             'entry_mark',ol.entry_mark,'days_to_expiry',ol.days_to_expiry,'contract_multiplier',ol.contract_multiplier,'premium_per_contract',ol.premium_per_contract,
             'underlying_at_entry',ol.underlying_at_entry,'entry_bar',ol.entry_bar,'entry_quote',ol.entry_quote,'same_bar_round_trip',ol.same_bar_round_trip) END),
         v.order_id::text,v.state,'PAPER_LIMIT',1::numeric,v.entry_price,v.entry_price,
         v.stoploss,v.tp1,NULL::double precision,NULL::double precision,v.entry_datetime,
         v.close_price,v.close_ts,CASE v.close_reason WHEN 'STOP_CLOSE' THEN 'STOP' WHEN 'TARGET' THEN 'TARGET' END,v.updated_at,NULL::double precision,NULL::integer,
         v.realized_r
  FROM realtime_production_scalping_ob_ob_v4_orders v
  LEFT JOIN realtime_production_scalping_ob_ob_v4_option_legs ol ON ol.order_id = v.order_id
  UNION ALL
  -- BPR_OB_V3 (Quiet Open A) PAPER lane (no broker orders): realized_r blends the 50% partial at +2R with the remainder's exit.
  SELECT v.signal_hash,v.market,v.ticker,v.ticker,
         'BPR x OB V3 - ' || v.source_mode,'America/New_York',v.direction,v.entry_datetime,(v.entry_datetime AT TIME ZONE 'America/New_York')::date,
         'BPR_OB_V3','BPR x OB V3 - 1h BPR x 5m OB - quiet open < 0.2 - 50% at +2R - 5m close SL','BPR_OB_V3',
         v.entry_price,v.stoploss,v.tp1,NULL::double precision,NULL::double precision,v.observed_at,
         v.strategy_json || jsonb_build_object('partial_price',v.partial_price,'partial_at',v.partial_at,'planned_rr',v.planned_rr,'risk_bps',v.risk_bps,'execution_mode',v.execution_mode,
           'execution_status',v.execution_status,'armed_at',v.armed_at,'drift_r',v.drift_r,
           'atm_option',CASE WHEN ol.order_id IS NULL THEN NULL ELSE jsonb_build_object('occ_symbol',ol.occ_symbol,'type',ol.option_type,'expiration',ol.expiration,
             'strike',ol.strike,'entry_price',ol.entry_option_price,'entry_bid',ol.entry_bid,'entry_ask',ol.entry_ask,'partial_price',ol.partial_option_price,
             'exit_price',ol.exit_option_price,'return_pct',ol.option_return_pct,'price_source',ol.price_source,
             'entry_mark',ol.entry_mark,'days_to_expiry',ol.days_to_expiry,'contract_multiplier',ol.contract_multiplier,'premium_per_contract',ol.premium_per_contract,
             'underlying_at_entry',ol.underlying_at_entry,'entry_bar',ol.entry_bar,'entry_quote',ol.entry_quote,'same_bar_round_trip',ol.same_bar_round_trip) END),
         v.order_id::text,v.state,'PAPER_LIMIT',1::numeric,v.entry_price,v.entry_price,
         v.stoploss,v.tp1,NULL::double precision,NULL::double precision,v.entry_datetime,
         v.close_price,v.close_ts,CASE v.close_reason WHEN 'STOP_CLOSE' THEN 'STOP' WHEN 'TARGET' THEN 'TARGET' END,v.updated_at,NULL::double precision,NULL::integer,
         v.realized_r
  FROM realtime_production_bpr_ob_v3_orders v
  LEFT JOIN realtime_production_bpr_ob_v3_option_legs ol ON ol.order_id = v.order_id
  UNION ALL
  -- IFVG_OB_V1 PAPER lane (no broker orders): realized_r blends the 50% partial at +2R with the remainder's exit.
  SELECT v.signal_hash,v.market,v.ticker,v.ticker,
         'IFVG x OB V1 - ' || v.source_mode,'America/New_York',v.direction,v.entry_datetime,(v.entry_datetime AT TIME ZONE 'America/New_York')::date,
         'IFVG_OB_V1','IFVG x OB V1 - 1h IFVG x 5m OB - quiet open < 0.2 - R:R >= 1.5 - hold to target - 5m close SL','IFVG_OB_V1',
         v.entry_price,v.stoploss,v.tp1,NULL::double precision,NULL::double precision,v.observed_at,
         v.strategy_json || jsonb_build_object('partial_price',v.partial_price,'partial_at',v.partial_at,'planned_rr',v.planned_rr,'risk_bps',v.risk_bps,'execution_mode',v.execution_mode,
           'execution_status',v.execution_status,'armed_at',v.armed_at,'drift_r',v.drift_r,
           'atm_option',CASE WHEN ol.order_id IS NULL THEN NULL ELSE jsonb_build_object('occ_symbol',ol.occ_symbol,'type',ol.option_type,'expiration',ol.expiration,
             'strike',ol.strike,'entry_price',ol.entry_option_price,'entry_bid',ol.entry_bid,'entry_ask',ol.entry_ask,'partial_price',ol.partial_option_price,
             'exit_price',ol.exit_option_price,'return_pct',ol.option_return_pct,'price_source',ol.price_source,
             'entry_mark',ol.entry_mark,'days_to_expiry',ol.days_to_expiry,'contract_multiplier',ol.contract_multiplier,'premium_per_contract',ol.premium_per_contract,
             'underlying_at_entry',ol.underlying_at_entry,'entry_bar',ol.entry_bar,'entry_quote',ol.entry_quote,'same_bar_round_trip',ol.same_bar_round_trip) END),
         v.order_id::text,v.state,'PAPER_LIMIT',1::numeric,v.entry_price,v.entry_price,
         v.stoploss,v.tp1,NULL::double precision,NULL::double precision,v.entry_datetime,
         v.close_price,v.close_ts,CASE v.close_reason WHEN 'STOP_CLOSE' THEN 'STOP' WHEN 'TARGET' THEN 'TARGET' END,v.updated_at,NULL::double precision,NULL::integer,
         v.realized_r
  FROM realtime_production_ifvg_ob_v1_orders v
  LEFT JOIN realtime_production_ifvg_ob_v1_option_legs ol ON ol.order_id = v.order_id
)"""

REALTIME_ROWS_SQL = "SELECT r.* FROM " + REALTIME_ROWS_SOURCE + """ r
    {where}
    ORDER BY r.entry_datetime DESC NULLS LAST
    {limit}
"""

# Keep in sync with OANDA_EXECUTED_ROWS_SOURCE in src/lib/realtime-rows-sql.ts:
# rows actually executed on the OANDA account (Account Management > OANDA forex).
OANDA_EXECUTED_ROWS_SOURCE = """(
  SELECT r.*, k.fill_price AS oanda_fill_price, k.fill_ts AS oanda_fill_ts, k.close_price AS oanda_close_price,
         k.close_ts AS oanda_close_ts, k.realized_r AS oanda_realized_r, k.status AS oanda_status
  FROM """ + REALTIME_ROWS_SOURCE + """ r
  LEFT JOIN reversal_k1_live_orders k
    ON r.strategy_key = 'REVERSAL_K1' AND k.k1_order_id::text = r.order_id AND k.oanda_trade_id IS NOT NULL
  WHERE (r.strategy_key = 'IGS01V2'
         AND r.order_id IN (SELECT 'OANDA:' || open_order_id FROM oanda_account_trades WHERE open_order_id IS NOT NULL))
     OR k.oanda_trade_id IS NOT NULL
)"""
OANDA_ROWS_SQL = "SELECT r.* FROM " + OANDA_EXECUTED_ROWS_SOURCE + """ r
    {where}
    ORDER BY r.entry_datetime DESC NULLS LAST
    {limit}
"""


@app.get("/api/realtime-analytics/rows")
def realtime_analytics_rows():
    """Raw realtime signal+order rows. The Next.js route performs the timezone-aware
    aggregation on top of these rows, so all analytics logic stays in one place."""
    if not require_api_token():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    market = (request.args.get("market") or "ALL").strip()
    tickers = [value.strip().upper() for value in (request.args.get("ticker") or "ALL").split(",") if value.strip() and value.strip().upper() != "ALL"]
    strategies = [value.strip().upper() for value in (request.args.get("strategy") or "ALL").split(",") if value.strip() and value.strip().upper() != "ALL"]
    direction = (request.args.get("direction") or "ALL").strip().upper()
    status = (request.args.get("status") or "ALL").strip().upper()

    conditions = []
    params = []
    if market != "ALL":
        conditions.append("LOWER(r.market) = LOWER(%s)")
        params.append(market)
    if tickers:
        conditions.append("UPPER(r.ticker) = ANY(%s)")
        params.append(tickers)
    if strategies:
        conditions.append("UPPER(r.strategy_id) = ANY(%s)")
        params.append(strategies)
    if direction != "ALL":
        conditions.append("UPPER(r.direction) = UPPER(%s)")
        params.append(direction)
    if status == "OPEN":
        conditions.append("(r.state = 'OPEN' OR r.state LIKE '%%PENDING%%')")
    if status == "COMPLETED":
        conditions.append("r.state LIKE 'CLOSED%%'")
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    date_from = (request.args.get("date_from") or "").strip()
    date_to = (request.args.get("date_to") or "").strip()
    source_mode = (request.args.get("source_mode") or "ALL").strip().upper()
    if source_mode in ("REALTIME", "BACKFILL"):
        conditions.append("r.strategy_json->>'source_mode' = %s")
        params.append(source_mode)
    local_date = "(COALESCE(r.filled_at,r.entry_datetime) AT TIME ZONE COALESCE(NULLIF(r.exchange_timezone,''),CASE WHEN LOWER(r.market)='india' THEN 'Asia/Kolkata' ELSE 'America/New_York' END))::date"
    for value,op in [(date_from,">="),(date_to,"<=")]:
        if value:
            try:
                datetime.strptime(value,"%Y-%m-%d")
            except ValueError:
                return jsonify({"success":False,"error":"Choose valid dates."}),400
            conditions.append(local_date+" "+op+" %s::date")
            params.append(value)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    rows_sql = OANDA_ROWS_SQL if (request.args.get("broker") or "").strip().upper() == "OANDA" else REALTIME_ROWS_SQL
    query = rows_sql.format(where=where,limit="" if date_from and date_to else "LIMIT 10000")

    try:
        with psycopg2.connect(**db_config()) as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(query, params)
                rows = [serialize_row(row) for row in cur.fetchall()]
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500

    return jsonify({"success": True, "rows": rows})


ACCOUNT_REGISTRY_SQL = """
        SELECT
          c.customer_id::text, c.customer_key, c.display_name, c.active AS customer_active,
          a.broker_account_id::text, a.broker, a.broker_client_id, a.account_label,
          a.environment, a.active, a.strategies, a.risk_config, a.auth_status,
          a.token_expires_at, a.last_verified_at, a.created_at, a.updated_at,
          TRUE AS linked_customer
        FROM realtime_production_customers c
        JOIN realtime_production_customer_broker_accounts a ON a.customer_id = c.customer_id
        UNION ALL
        SELECT
          NULL, LOWER(e.broker || '_' || e.broker_account),
          CASE WHEN e.broker_account = 'Titania_ICT_Algo' THEN 'Naveen' ELSE e.broker_account END,
          TRUE, NULL, e.broker, NULL, e.broker_account, 'live', TRUE,
          '[]'::jsonb, '{}'::jsonb, 'legacy_unlinked', NULL, NULL,
          MIN(e.created_at), MAX(e.updated_at), FALSE
        FROM realtime_production_broker_order_executions e
        WHERE NULLIF(TRIM(e.broker_account), '') IS NOT NULL
          AND NOT EXISTS (
          SELECT 1 FROM realtime_production_customer_broker_accounts a
          WHERE LOWER(a.broker) = LOWER(e.broker)
            AND LOWER(a.account_label) = LOWER(e.broker_account)
        )
        GROUP BY e.broker, e.broker_account

"""


@app.get("/api/account-management/rows")
def account_management_rows():
    """Read-only customer, broker-account and execution rows for the dashboard.

    Calculations remain in the Next.js route so direct Postgres and REST-bridge
    deployments share one account/P&L contract.
    """
    if not require_api_token():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    accounts_sql = ACCOUNT_REGISTRY_SQL
    executions_sql = """
        SELECT
          execution_id::text, source_order_id::text, broker, broker_account,
          source_market, underlying, direction, option_type, option_tradingsymbol,
          quantity, lots, lotsize, status, error, dry_run, broker_response,
          exit_status, exit_reason, exit_price, exit_at, exit_response,
          created_at, updated_at
        FROM realtime_production_broker_order_executions
        ORDER BY created_at DESC
        LIMIT 10000
    """
    try:
        with psycopg2.connect(**db_config()) as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(accounts_sql)
                accounts = [serialize_row(row) for row in cur.fetchall()]
                cur.execute(executions_sql)
                executions = [serialize_row(row) for row in cur.fetchall()]
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500

    return jsonify({"success": True, "accounts": accounts, "executions": executions})


EMPTY_OVERLAYS = {
    "order_blocks": [], "fvgs": [], "liquidity": [], "swings": [], "structure": [], "ipda": None, "bias": None,
    "strategy_timeframe": None,
    "timeframe_5m": {}, "timeframe_15m": {}, "timeframe_30m": {}, "timeframe_1h": {},
    "timeframe_daily": {}, "timeframe_weekly": {},
}


def _obj(value):
    return value if isinstance(value, dict) else {}


def _text(value):
    return value.strip() if isinstance(value, str) and value.strip() else None


def _strategy_timeframe(value):
    normalized = str(value or "").strip().lower().replace(" ", "").replace("minute", "m").replace("hour", "h")
    mapping = {
        "5m": ("5m", "timeframe_5m", 300), "5min": ("5m", "timeframe_5m", 300),
        "15m": ("15m", "timeframe_15m", 900), "15min": ("15m", "timeframe_15m", 900),
        "30m": ("30m", "timeframe_30m", 1800), "30min": ("30m", "timeframe_30m", 1800),
        "1h": ("1h", "timeframe_1h", 3600), "60m": ("1h", "timeframe_1h", 3600),
        "60min": ("1h", "timeframe_1h", 3600),
        "1d": ("1D", "timeframe_daily", 86400), "daily": ("1D", "timeframe_daily", 86400),
        "day": ("1D", "timeframe_daily", 86400),
        "1w": ("1W", "timeframe_weekly", 604800), "weekly": ("1W", "timeframe_weekly", 604800),
        "week": ("1W", "timeframe_weekly", 604800),
    }
    return mapping.get(normalized)


def _s10v2_chart_overlays(strategy_json, fallback_direction):
    root = _obj(strategy_json)
    bpr, bullish, bearish = _obj(root.get("bpr")), _obj(root.get("bullish_fvg")), _obj(root.get("bearish_fvg"))
    dol, pd, tags = _obj(root.get("dol")), _obj(root.get("pd_location")), _obj(root.get("tags"))
    timeframe = _strategy_timeframe(root.get("identification_timeframe") or bpr.get("timeframe") or tags.get("timeframe"))
    if not timeframe:
        return None
    tf_key, bucket_key, tf_seconds = timeframe
    direction = _text(root.get("direction")) or _text(fallback_direction)
    pair_time = epoch_seconds(bpr.get("pair_ts")) if bpr.get("pair_ts") else None
    result = json.loads(json.dumps(EMPTY_OVERLAYS))
    bucket = {"order_blocks": [], "fvgs": [], "structure": [], "liquidity": [], "swings": []}
    result[bucket_key] = bucket
    evidence_times = []

    def add_zone(source, label, zone_direction, kind="fvg"):
        top, bottom = num(source.get("top")), num(source.get("bottom"))
        timestamp = source.get("formed_ts") or source.get("pair_ts")
        time = epoch_seconds(timestamp) if timestamp else None
        if top is None or bottom is None or time is None:
            return
        evidence_times.append(time)
        zone = {"kind": kind, "top": top, "bottom": bottom, "time": time, "direction": zone_direction,
                "broken": False, "mitigated": False, "filled": False, "label": label}
        bucket["order_blocks" if kind == "bpr" else "fvgs"].append(zone)

    add_zone(bullish, "S10-V2 BULLISH FVG LEG", "BUY")
    add_zone(bearish, "S10-V2 BEARISH FVG LEG", "SELL")
    ce = num(bpr.get("ce"))
    add_zone(bpr, f"S10-V2 BPR{' · CE ' + format(ce, '.2f') if ce is not None else ''}", direction, "bpr")

    dol_level = num(dol.get("level"))
    if dol_level is not None and pair_time is not None:
        evidence_times.append(pair_time)
        bucket["liquidity"].append({
            "kind": "liquidity", "level": dol_level, "time": pair_time, "side": _text(dol.get("side")),
            "direction": direction,
            "label": f"DRAW ON LIQUIDITY · {(_text(dol.get('side')) or 'DOL').upper()} · {(_text(dol.get('method')) or 'PERSISTED').upper()}",
        })

    low, eq50, high = num(pd.get("ipda20_low")), num(pd.get("ipda20_eq")), num(pd.get("ipda20_high"))
    if low is not None and eq50 is not None and high is not None:
        result["ipda"] = {"low": low, "q25": low + (high - low) * .25, "eq50": eq50,
                          "q75": low + (high - low) * .75, "high": high, "start_time": None,
                          "end_time": pair_time, "sessions": 20, "selected_level": _text(pd.get("half"))}
    result["strategy_timeframe"] = tf_key
    result["bias"] = {"weekly": None, "daily": _text(tags.get("daily_bias")), "one_hour": None}
    result["order_blocks"], result["fvgs"] = bucket["order_blocks"], bucket["fvgs"]
    result["liquidity"], result["swings"], result["structure"] = bucket["liquidity"], bucket["swings"], bucket["structure"]
    return {"overlays": result, "earliest_time": min(evidence_times) if evidence_times else pair_time,
            "timeframe_seconds": tf_seconds}


def _ts01_chart_overlays(strategy_json, fallback_direction):
    root = _obj(strategy_json)
    candidates = [_obj(value) for value in root.get("candidates", [])] if isinstance(root.get("candidates"), list) else []
    selected = _text(root.get("selected_attempt"))
    candidate = next((value for value in candidates if _text(value.get("candidate_key")) == selected), candidates[0] if candidates else {})
    direction = _text(candidate.get("direction")) or _text(root.get("direction")) or _text(fallback_direction)
    result = dict(EMPTY_OVERLAYS)
    empty_tf = lambda: {"order_blocks": [], "fvgs": [], "structure": [], "liquidity": [], "swings": []}
    result["timeframe_5m"] = empty_tf()
    result["timeframe_15m"] = empty_tf()
    result["timeframe_daily"] = empty_tf()
    result["timeframe_weekly"] = empty_tf()
    result["bias"] = {"weekly": None, "daily": direction, "one_hour": None}

    fvg = _obj(candidate.get("fvg"))
    fvg_time, fvg_low, fvg_high = epoch_seconds(fvg.get("created_bar_ts")), num(fvg.get("low")), num(fvg.get("high"))
    if fvg_time is not None and fvg_low is not None and fvg_high is not None:
        result["timeframe_5m"]["fvgs"].append({"kind": "fvg", "top": fvg_high, "bottom": fvg_low, "time": fvg_time, "direction": direction, "broken": False, "mitigated": False, "filled": False, "label": "TS01 5M FVG · CE ENTRY"})
    gates = [_obj(value) for value in candidate.get("gates", [])] if isinstance(candidate.get("gates"), list) else []
    mss = next((value for value in gates if _text(value.get("name")) == "MSS_CLOSE"), {})
    evidence = _obj(mss.get("evidence"))
    mss_price = num(evidence.get("close")) if num(evidence.get("close")) is not None else num(evidence.get("swing_price"))
    mss_time = epoch_seconds(candidate.get("mss_bar_ts"))
    if mss_time is not None and mss_price is not None:
        result["timeframe_5m"]["structure"].append({"kind": "mss", "top": mss_price, "bottom": mss_price, "time": mss_time, "direction": direction, "broken": False, "mitigated": False, "filled": False, "label": "TS01 MSS · CLOSE CONFIRMED"})
    raid = _obj(candidate.get("raid_pool"))
    raid_time = epoch_seconds(candidate.get("raid_bar_ts") or raid.get("first_tap_ts") or raid.get("formed_at"))
    raid_price = num(raid.get("price"))
    if raid_time is not None and raid_price is not None:
        level = {"kind": "liquidity", "level": raid_price, "time": raid_time, "side": raid.get("side"), "direction": direction, "label": f"RAID · {raid.get('pool_type') or 'LIQUIDITY'}"}
        raid_tf = str(raid.get("timeframe") or "5m").lower()
        bucket = "timeframe_15m" if "15" in raid_tf else "timeframe_daily" if "1d" in raid_tf or "daily" in raid_tf else "timeframe_weekly" if "1w" in raid_tf or "week" in raid_tf else "timeframe_5m"
        result[bucket]["liquidity"].append(level)
    confirmation = _obj(candidate.get("confirmation_swing"))
    swing_time = epoch_seconds(confirmation.get("pivot_ts") or confirmation.get("known_at"))
    swing_price = num(confirmation.get("price"))
    if swing_time is not None and swing_price is not None:
        result["timeframe_5m"]["swings"].append({"kind": "swing", "level": swing_price, "time": swing_time, "side": confirmation.get("side"), "direction": direction, "label": "PRE-RAID CONFIRMED SWING"})

    htf = _obj(root.get("htf_context"))
    direction_event = _obj(htf.get("direction_event"))
    daily_fvg = _obj(direction_event.get("fvg"))
    daily_time = epoch_seconds(direction_event.get("event_bar_ts") or daily_fvg.get("created_bar_ts"))
    daily_low, daily_high = num(daily_fvg.get("low")), num(daily_fvg.get("high"))
    if daily_time is not None and daily_low is not None and daily_high is not None:
        result["timeframe_daily"]["fvgs"].append({"kind": "fvg", "top": daily_high, "bottom": daily_low, "time": daily_time, "direction": direction, "broken": False, "mitigated": False, "filled": False, "label": "D1 DIRECTION FVG"})
    broken_price = num(direction_event.get("broken_swing_price"))
    if daily_time is not None and broken_price is not None:
        result["timeframe_daily"]["structure"].append({"kind": "structure", "top": broken_price, "bottom": broken_price, "time": daily_time, "direction": direction, "broken": True, "mitigated": False, "filled": False, "label": "D1 CONFIRMED SWING BREAK"})
    dealing_range = _obj(htf.get("dealing_range"))
    for label, price, side in (("D1 RANGE HIGH", num(dealing_range.get("high")), "BSL"), ("D1 RANGE LOW", num(dealing_range.get("low")), "SSL")):
        if daily_time is not None and price is not None:
            result["timeframe_daily"]["swings"].append({"kind": "swing", "level": price, "time": daily_time, "side": side, "direction": direction, "label": label})
    objective = _obj(htf.get("objective"))
    objective_time = epoch_seconds(objective.get("formed_at") or objective.get("known_at"))
    objective_price = num(objective.get("price"))
    if objective_time is not None and objective_price is not None:
        level = {"kind": "liquidity", "level": objective_price, "time": objective_time, "side": objective.get("side"), "direction": direction, "label": f"HTF DRAW · {objective.get('pool_type') or 'LIQUIDITY'}"}
        objective_tf = str(objective.get("timeframe") or "1d").lower()
        result["timeframe_weekly" if "1w" in objective_tf or "week" in objective_tf else "timeframe_daily"]["liquidity"].append(level)
    result["fvgs"] = result["timeframe_5m"]["fvgs"]
    result["liquidity"] = result["timeframe_5m"]["liquidity"]
    result["swings"] = result["timeframe_5m"]["swings"]
    result["structure"] = result["timeframe_5m"]["structure"]
    return result


def _map_zone(value, fallback):
    row = _obj(value)
    level = num(row.get("level"))
    top = num(row.get("top"))
    bottom = num(row.get("bottom"))
    if (top is None or bottom is None) and level is not None:
        top = bottom = level
    timestamp = row.get("formed_datetime_et") or row.get("start_datetime_et") or row.get("bar_timestamp_et") or row.get("event_datetime_et")
    try:
        time = epoch_seconds(timestamp) if timestamp else None
    except (TypeError, ValueError):
        time = None
    if top is None or bottom is None or time is None:
        return None
    return {"kind": row.get("zone_type") or row.get("event_type") or fallback, "top": top, "bottom": bottom,
            "time": time, "direction": row.get("direction"), "broken": bool(row.get("broken")),
            "mitigated": bool(row.get("mitigated")), "filled": bool(row.get("fully_filled")),
            "label": row.get("summary") or ""}


def _map_level(value, kind):
    row = _obj(value)
    level = num(row.get("level"))
    timestamp = row.get("bar_timestamp_et") or row.get("formed_datetime_et") or row.get("event_datetime_et")
    try:
        time = epoch_seconds(timestamp) if timestamp else None
    except (TypeError, ValueError):
        time = None
    if level is None:
        return None
    return {"kind": kind, "level": level, "time": time, "side": row.get("side"), "direction": row.get("direction"),
            "label": row.get("ict_label") or row.get("liquidity_label") or row.get("event_type") or kind}


def _column_items(column, keys):
    source = _obj(column)
    for key in keys:
        values = source.get(key)
        if isinstance(values, list):
            return values
    return []


def _v5_ipda_evidence(strategy_json, direction):
    if isinstance(strategy_json, str):
        try:
            strategy_json = json.loads(strategy_json)
        except ValueError:
            strategy_json = {}
    pattern = _obj(_obj(strategy_json).get("pattern"))
    rng, fvg, mss = _obj(pattern.get("ipda_range")), _obj(pattern.get("fvg")), _obj(pattern.get("mss"))
    stop, sweep = _obj(pattern.get("previous_confirmed_swing_stop")), _obj(pattern.get("liquidity_extreme"))
    values = {key: num(rng.get(key)) for key in ("low", "q25", "eq50", "q75", "high")}
    ipda = None
    if all(value is not None for value in values.values()):
        ipda = {**values, "start_time": epoch_seconds(rng.get("start_ts")) if rng.get("start_ts") else None,
                "end_time": epoch_seconds(rng.get("end_ts")) if rng.get("end_ts") else None,
                "sessions": num(rng.get("sessions")) or 20, "selected_level": pattern.get("ipda_level_name")}
    def ts(value):
        try:
            return epoch_seconds(value) if value else None
        except (TypeError, ValueError):
            return None
    fvg_time, fvg_low, fvg_high = ts(fvg.get("formation_ts")), num(fvg.get("zone_low")), num(fvg.get("zone_high"))
    fvg_overlay = {"kind": "fvg", "top": fvg_high, "bottom": fvg_low, "time": fvg_time, "direction": fvg.get("direction") or direction,
                   "broken": False, "mitigated": False, "filled": False, "label": "VIRGIN FVG · FIRST TOUCH"} if None not in (fvg_time, fvg_low, fvg_high) else None
    mss_time, mss_price = ts(mss.get("break_ts")), num(mss.get("break_close")) or num(_obj(mss.get("pivot")).get("price"))
    mss_overlay = {"kind": "mss", "top": mss_price, "bottom": mss_price, "time": mss_time, "direction": mss.get("direction") or direction,
                   "broken": False, "mitigated": False, "filled": False, "label": "MSS · CLOSE CONFIRMED"} if None not in (mss_time, mss_price) else None
    swing_time, swing_price = ts(stop.get("confirmation_ts") or stop.get("pivot_ts")), num(stop.get("price"))
    swing_overlay = {"kind": "swing", "level": swing_price, "time": swing_time, "side": stop.get("kind"), "direction": direction,
                     "label": f"{str(stop.get('timeframe') or 'STRUCTURAL').upper()} STOP SWING"} if None not in (swing_time, swing_price) else None
    sweep_time, sweep_price = ts(sweep.get("source_ts")), num(sweep.get("price"))
    sweep_overlay = {"kind": "liquidity", "level": sweep_price, "time": sweep_time, "side": None, "direction": direction,
                     "label": "LIQUIDITY SWEEP"} if None not in (sweep_time, sweep_price) else None
    return ipda, fvg_overlay, mss_overlay, swing_overlay, sweep_overlay


def _fetch_realtime_candles(cur, symbol, base, from_iso, to_iso):
    cmap = {}
    for table in ("candles_5m", "historical_candles_5m"):
        try:
            cur.execute(
                f"""
                SELECT candle_ts, open_price, high_price, low_price, close_price, volume
                FROM {table}
                WHERE (yahoo_symbol = %s OR base_symbol = %s OR yahoo_symbol = %s OR base_symbol = %s)
                  AND candle_ts >= %s::timestamptz AND candle_ts <= %s::timestamptz
                ORDER BY candle_ts ASC LIMIT 3000
                """,
                [symbol, base, symbol, base, from_iso, to_iso],
            )
            for row in cur.fetchall():
                t = epoch_seconds(row["candle_ts"])
                op = num(row["open_price"])
                if t is None or op is None or t in cmap:
                    continue
                cmap[t] = {
                    "time": t, "open": op, "high": num(row["high_price"]),
                    "low": num(row["low_price"]), "close": num(row["close_price"]), "volume": num(row["volume"]),
                }
        except Exception:
            continue
    return [cmap[t] for t in sorted(cmap.keys())]


@app.get("/api/realtime-analytics/order-chart")
def realtime_order_chart():
    if not require_api_token():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    order_id = (request.args.get("order_id") or "").strip()
    signal_hash = (request.args.get("signal_hash") or "").strip()
    target = target_no(request.args.get("target_no"))
    try:
        from_ts_v = float(request.args.get("from_ts")) if request.args.get("from_ts") else None
    except (TypeError, ValueError):
        from_ts_v = None
    try:
        to_ts_v = float(request.args.get("to_ts")) if request.args.get("to_ts") else None
    except (TypeError, ValueError):
        to_ts_v = None
    candles_only = bool(from_ts_v and to_ts_v and from_ts_v > 0 and to_ts_v > from_ts_v)

    if not order_id and not signal_hash:
        return jsonify({"success": False, "error": "order_id or signal_hash required"}), 400

    order_cols = (
        "o.order_id, o.signal_id, o.symbol, o.market, o.direction, o.entry_price, o.filled_price, "
        "o.stoploss, o.tp1, o.tp2, o.tp3, o.qty, o.filled_at, o.close_price, o.close_ts, o.close_reason, o.state"
    )
    try:
        conn = psycopg2.connect(**db_config())
        conn.autocommit = True
        cur = conn.cursor(cursor_factory=RealDictCursor)

        order = None
        if order_id:
            cur.execute(f"SELECT {order_cols} FROM realtime_production_orders o WHERE o.order_id::text = %s LIMIT 1", [order_id])
            order = cur.fetchone()
        if not order and signal_hash:
            cur.execute(f"SELECT {order_cols} FROM realtime_production_orders o WHERE o.signal_id = %s ORDER BY o.updated_at DESC NULLS LAST LIMIT 1", [signal_hash])
            order = cur.fetchone()

        sig_id = (order["signal_id"] if order else None) or signal_hash
        sig = None
        if sig_id:
            try:
                cur.execute(
                    """
                    SELECT signal_hash, market, ticker, base_symbol, direction, entry_datetime,
                           entry_price, stoploss, target_1, target_2, target_3
                    FROM realtime_production_ict_strategy_met_execution WHERE signal_hash = %s LIMIT 1
                    """,
                    [sig_id],
                )
                sig = cur.fetchone()
            except Exception:
                sig = None

        if not order and not sig:
            # Dedicated lanes use the same normalized source as the trade list.
            igs_key = order_id or signal_hash
            cur.execute(
                """
                SELECT r.* FROM """ + REALTIME_ROWS_SOURCE + """ r
                WHERE r.strategy_key IN ('IGS01V2','MSS_REVERSAL','REVERSAL_K1','SCALPING_OB_OB_V4','BPR_OB_V3') AND (r.order_id = %s OR r.signal_hash = %s)
                LIMIT 1
                """,
                [igs_key, igs_key],
            )
            igs = cur.fetchone()
            if igs:
                order = dict(igs, symbol=igs["ticker"], signal_id=igs["signal_hash"]) if igs.get("order_id") else None
                sig = {
                    "signal_hash": igs["signal_hash"], "market": igs["market"], "ticker": igs["ticker"],
                    "base_symbol": igs["base_symbol"], "direction": igs["direction"], "entry_datetime": igs["entry_datetime"],
                    "entry_price": igs["signal_entry_price"], "stoploss": igs["signal_stoploss"],
                    "target_1": igs["target_1"], "target_2": igs["target_2"], "target_3": igs["target_3"],
                }

        if not order and not sig:
            cur.close(); conn.close()
            return jsonify({"success": False, "error": "order or signal not found"}), 404

        symbol = (order["symbol"] if order else None) or (sig["ticker"] if sig else None) or (sig["base_symbol"] if sig else None) or ""
        base = (sig["base_symbol"] if sig else None) or symbol
        market = (order["market"] if order else None) or (sig["market"] if sig else None) or ""
        direction = (order["direction"] if order else None) or (sig["direction"] if sig else None)

        entry_price = num(order["filled_price"]) if order else None
        if entry_price is None and order:
            entry_price = num(order["entry_price"])
        if entry_price is None and sig:
            entry_price = num(sig["entry_price"])
        stoploss = (num(order["stoploss"]) if order else None)
        if stoploss is None and sig:
            stoploss = num(sig["stoploss"])
        tp1 = (num(order["tp1"]) if order else None) or (num(sig["target_1"]) if sig else None)
        tp2 = (num(order["tp2"]) if order else None) or (num(sig["target_2"]) if sig else None)
        tp3 = (num(order["tp3"]) if order else None) or (num(sig["target_3"]) if sig else None)
        close_price = num(order["close_price"]) if order else None
        state = (order["state"] if order else None) or "SIGNAL_ONLY"
        filled_at = (order["filled_at"] if order else None) or (sig["entry_datetime"] if sig else None)
        close_ts = order["close_ts"] if order else None

        filled_sec = epoch_seconds(filled_at) or 0
        close_sec = epoch_seconds(close_ts) or int(datetime.now().timestamp())

        if candles_only:
            from_iso = datetime.fromtimestamp(from_ts_v).isoformat()
            to_iso = datetime.fromtimestamp(to_ts_v).isoformat()
            candles = _fetch_realtime_candles(cur, symbol, base, from_iso, to_iso)
            cur.close(); conn.close()
            return jsonify({"success": True, "candles": candles, "window": {"from": from_ts_v, "to": to_ts_v}, "timeframe": "5m"})

        raw_span = max(close_sec - filled_sec, 3600)
        pad = max(raw_span * 0.4, 24 * 300)
        from_iso = datetime.fromtimestamp(filled_sec - pad).isoformat()
        to_iso = datetime.fromtimestamp(close_sec + pad).isoformat()
        candles = _fetch_realtime_candles(cur, symbol, base, from_iso, to_iso)

        # Keep REST-backed charts feature-parallel with the local Next route:
        # all persisted timeframe overlays plus V5's explicit IPDA/MSS/FVG proof.
        overlays = json.loads(json.dumps(EMPTY_OVERLAYS))
        if sig_id:
            try:
                cur.execute(
                    """
                    SELECT strategy_json,
                           five_min_relevant_order_block AS ob_5m, five_min_relevant_fvg AS fvg_5m,
                           five_min_relevant_liquidity_levels AS liq_5m, five_min_relevant_swings AS sw_5m,
                           five_min_relevant_bos_mss_choch AS bos_5m,
                           fifteen_min_relevant_order_block AS ob_15m, fifteen_min_relevant_fvg AS fvg_15m,
                           fifteen_min_relevant_liquidity_levels AS liq_15m, fifteen_min_relevant_swings AS sw_15m,
                           fifteen_min_relevant_bos_mss_choch AS bos_15m,
                           thirty_min_relevant_order_block AS ob_30m, thirty_min_relevant_fvg AS fvg_30m,
                           thirty_min_relevant_liquidity_levels AS liq_30m, thirty_min_relevant_swings AS sw_30m,
                           thirty_min_relevant_bos_mss_choch AS bos_30m,
                           one_hour_relevant_order_block AS ob_1h, one_hour_relevant_fvg AS fvg_1h,
                           one_hour_relevant_liquidity_levels AS liq_1h, one_hour_relevant_swings AS sw_1h,
                           one_hour_relevant_bos_mss_choch AS bos_1h,
                           daily_relevant_order_block AS ob_d, daily_relevant_fvg AS fvg_d,
                           daily_relevant_liquidity_levels AS liq_d, daily_relevant_swings AS sw_d,
                           daily_relevant_bos_mss_choch AS bos_d
                    FROM realtime_production_ict_strategy_met_execution
                    WHERE signal_hash = %s LIMIT 1
                    """,
                    [sig_id],
                )
                signal_row = cur.fetchone()
                if signal_row:
                    def before_entry(item):
                        return item and (item.get("time") is None or item["time"] <= filled_sec + 300)
                    def zones(column, kind):
                        return [mapped for mapped in (_map_zone(item, kind) for item in _column_items(column, [f"recent_10_{kind}s", "recent_10_bos_mss_choch", "recent_10_fvgs", "recent_10_order_blocks"])) if before_entry(mapped)]
                    def levels(column, kind):
                        source = _obj(column)
                        items = []
                        for key in ("recent_10_buyside_liquidity_levels", "recent_10_sellside_liquidity_levels", "recent_10_swing_highs", "recent_10_swing_lows"):
                            values = source.get(key)
                            if isinstance(values, list):
                                items.extend(values)
                        return [mapped for mapped in (_map_level(item, kind) for item in items) if before_entry(mapped)]
                    for key, ob, fvg, liq, sw, bos in (
                        ("timeframe_5m", signal_row["ob_5m"], signal_row["fvg_5m"], signal_row["liq_5m"], signal_row["sw_5m"], signal_row["bos_5m"]),
                        ("timeframe_15m", signal_row["ob_15m"], signal_row["fvg_15m"], signal_row["liq_15m"], signal_row["sw_15m"], signal_row["bos_15m"]),
                        ("timeframe_30m", signal_row["ob_30m"], signal_row["fvg_30m"], signal_row["liq_30m"], signal_row["sw_30m"], signal_row["bos_30m"]),
                        ("timeframe_1h", signal_row["ob_1h"], signal_row["fvg_1h"], signal_row["liq_1h"], signal_row["sw_1h"], signal_row["bos_1h"]),
                        ("timeframe_daily", signal_row["ob_d"], signal_row["fvg_d"], signal_row["liq_d"], signal_row["sw_d"], signal_row["bos_d"]),
                    ):
                        overlays[key] = {"order_blocks": zones(ob, "order_block"), "fvgs": zones(fvg, "fvg"), "liquidity": levels(liq, "liquidity"), "swings": levels(sw, "swing"), "structure": zones(bos, "structure")}
                    ipda, fvg, mss, swing, sweep = _v5_ipda_evidence(signal_row.get("strategy_json"), direction)
                    overlays["ipda"] = ipda
                    for name, item in (("fvgs", fvg), ("structure", mss), ("swings", swing), ("liquidity", sweep)):
                        if item:
                            overlays["timeframe_5m"].setdefault(name, []).append(item)
            except Exception:
                pass
        cur.close(); conn.close()
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500

    dir_upper = (direction or "").upper()
    risk_points = abs(entry_price - stoploss) if entry_price is not None and stoploss is not None else None
    pnl_points = None
    if entry_price is not None and close_price is not None:
        pnl_points = (entry_price - close_price) if dir_upper == "SELL" else (close_price - entry_price)
    realized_r = round2(pnl_points / risk_points) if risk_points and risk_points > 0 and pnl_points is not None else None
    if order and num(order.get("live_realized_r")) is not None:
        realized_r = round2(num(order.get("live_realized_r")))
    upper = state.upper()
    if upper == "CLOSED_TP":
        outcome = "WIN"
    elif upper == "CLOSED_SL":
        outcome = "LOSS"
    elif upper.startswith("CLOSED"):
        outcome = "UNKNOWN" if realized_r is None else ("WIN" if realized_r > 0 else "LOSS")
    elif upper == "OPEN":
        outcome = "OPEN"
    else:
        outcome = "SIGNAL_ONLY"

    return jsonify({
        "success": True,
        "order": {
            "order_id": str(order["order_id"]) if order and order["order_id"] else sig_id,
            "symbol": symbol, "market": market, "direction": direction,
            "entry_price": (num(order["entry_price"]) if order else None) or (num(sig["entry_price"]) if sig else None),
            "filled_price": entry_price, "stoploss": stoploss, "tp1": tp1, "tp2": tp2, "tp3": tp3,
            "filled_at": serialize_value(filled_at), "close_ts": serialize_value(close_ts),
            "close_price": close_price, "close_reason": (order["close_reason"] if order else None),
            "target_no": target, "realized_r": realized_r, "outcome": outcome,
        },
        "timeframe": "5m",
        "markers": {
            "entry": {"time": filled_sec, "price": entry_price},
            "exit": {"time": close_sec, "price": close_price, "outcome": outcome},
        },
        "candles": candles,
        "overlays": overlays,
        "window": {"from": filled_sec - int(max(raw_span * 0.4, 24 * 300)), "to": close_sec + int(max(raw_span * 0.4, 24 * 300))},
    })


_SIMILAR_BIAS = [
    ("five_min_bias", "5m bias", 4), ("fifteen_min_bias", "15m bias", 4),
    ("thirty_min_bias", "30m bias", 3), ("one_hour_bias", "1h bias", 3),
    ("daily_bias", "daily bias", 2), ("weekly_bias", "weekly bias", 1),
]
_SIMILAR_ICT = [
    ("five_min_relevant_order_block", "5m order blocks", 5), ("five_min_relevant_fvg", "5m FVG", 5),
    ("five_min_relevant_liquidity_levels", "5m liquidity", 4), ("five_min_relevant_swings", "5m swings", 3), ("five_min_relevant_bos_mss_choch", "5m structure", 5),
    ("fifteen_min_relevant_order_block", "15m order blocks", 4), ("fifteen_min_relevant_fvg", "15m FVG", 4),
    ("fifteen_min_relevant_liquidity_levels", "15m liquidity", 3), ("fifteen_min_relevant_swings", "15m swings", 2), ("fifteen_min_relevant_bos_mss_choch", "15m structure", 4),
    ("thirty_min_relevant_order_block", "30m order blocks", 3), ("thirty_min_relevant_fvg", "30m FVG", 3),
    ("thirty_min_relevant_liquidity_levels", "30m liquidity", 2), ("thirty_min_relevant_swings", "30m swings", 2), ("thirty_min_relevant_bos_mss_choch", "30m structure", 3),
    ("one_hour_relevant_order_block", "1h order blocks", 2), ("one_hour_relevant_fvg", "1h FVG", 2),
    ("one_hour_relevant_liquidity_levels", "1h liquidity", 2), ("one_hour_relevant_swings", "1h swings", 1), ("one_hour_relevant_bos_mss_choch", "1h structure", 2),
    ("daily_relevant_order_block", "daily order blocks", 1), ("daily_relevant_fvg", "daily FVG", 1),
    ("daily_relevant_liquidity_levels", "daily liquidity", 1), ("daily_relevant_swings", "daily swings", 1), ("daily_relevant_bos_mss_choch", "daily structure", 1),
]
_SIMILAR_COLUMNS = ["signal_hash", "market", "ticker", "direction", "entry_datetime", "strategy_id"] + [item[0] for item in _SIMILAR_BIAS + _SIMILAR_ICT]
_SIMILAR_TERMS = {"order_block", "fvg", "ifvg", "liquidity", "swing", "bos", "mss", "choch", "breaker", "bull", "bullish", "bear", "bearish", "buy", "sell", "high", "low"}


def _similar_fields(prefix=""):
    return ", ".join(prefix + column for column in _SIMILAR_COLUMNS)


def _similar_tokens(value):
    found = set()
    def visit(item):
        if isinstance(item, str):
            text = item.lower().replace("-", "_").replace(" ", "_")
            for term in _SIMILAR_TERMS:
                if term in text:
                    found.add(term)
        elif isinstance(item, list):
            for child in item[:20]: visit(child)
        elif isinstance(item, dict):
            for key, child in item.items():
                visit(str(key)); visit(child)
    visit(value)
    return found


def _similar_has_evidence(value):
    return bool(value) if isinstance(value, (dict, list)) else False


def _similar_overlap(left, right):
    if not left or not right:
        return 1 if not left and not right else 0
    return len(left & right) / len(left | right)


def _similar_score(current, candidate):
    earned, possible, matches = 0.0, 0.0, []
    def add(weight, value, label):
        nonlocal earned, possible
        possible += weight; earned += weight * value
        if value >= 0.999: matches.append(label)
    add(8, int(str(current.get("direction") or "").lower() == str(candidate.get("direction") or "").lower()), "direction")
    add(4, int(str(current.get("market") or "").lower() == str(candidate.get("market") or "").lower()), "market")
    for key, label, weight in _SIMILAR_BIAS:
        left, right = str(current.get(key) or "").strip().lower(), str(candidate.get(key) or "").strip().lower()
        if left and right: add(weight, int(left == right), label)
    for key, label, weight in _SIMILAR_ICT:
        left, right = current.get(key), candidate.get(key)
        if not _similar_has_evidence(left) and not _similar_has_evidence(right): continue
        token_score = _similar_overlap(_similar_tokens(left), _similar_tokens(right))
        presence_score = 0.5 if _similar_has_evidence(left) == _similar_has_evidence(right) else 0
        add(weight, max(token_score, presence_score), label)
    return round(100 * earned / possible) if possible else 0, matches[:6]


def _similar_realized_r(row):
    reason = str(row.get("close_reason") or "").lower()
    if reason == "target_hit": return num(row.get("target_rr_filled")) or num(row.get("target_rr"))
    if reason == "stoploss_hit": return -1
    entry, stop, close = num(row.get("filled_price")) or num(row.get("order_entry_price")), num(row.get("stoploss")), num(row.get("close_price"))
    if entry is None or stop is None or close is None or entry == stop: return None
    return (entry - close if str(row.get("direction") or "").upper() == "SELL" else close - entry) / abs(entry - stop)


@app.get("/api/similar-trades")
def similar_trades():
    """Bridge contract for the chart's deterministic similar-trade feature."""
    if not require_api_token():
        return jsonify({"success": False, "error": "Unauthorized"}), 401
    source = "backtest" if request.args.get("source") == "backtest" else "realtime"
    identifier_param = "signal_hash" if request.args.get("identifier_param") == "signal_hash" else "order_id"
    identifier = (request.args.get("identifier") or "").strip()
    if not identifier:
        return jsonify({"success": False, "error": "identifier required"}), 400
    try:
        with psycopg2.connect(**db_config()) as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                if source == "realtime":
                    if identifier_param == "signal_hash":
                        cur.execute(f"SELECT {_similar_fields()} FROM realtime_production_ict_strategy_met_execution WHERE signal_hash=%s LIMIT 1", [identifier])
                    else:
                        cur.execute(f"SELECT {_similar_fields('s.')} FROM realtime_production_orders o JOIN realtime_production_ict_strategy_met_execution s ON s.signal_hash=o.signal_id WHERE o.order_id=%s LIMIT 1", [identifier])
                elif identifier_param == "signal_hash":
                    cur.execute(f"SELECT {_similar_fields()} FROM historical_ict_strategy_met_execution_updated WHERE signal_hash=%s LIMIT 1", [identifier])
                else:
                    cur.execute(f"SELECT {_similar_fields('s.')} FROM historical_ict_orders_updated o JOIN historical_ict_strategy_met_execution_updated s ON s.signal_hash=o.signal_id WHERE o.order_id=%s LIMIT 1", [identifier])
                current = cur.fetchone()
                if not current:
                    return jsonify({"success": False, "error": "Current setup was not found"}), 404
                cur.execute(f"""
                    SELECT {_similar_fields('s.')}, o.order_id, o.entry_price AS order_entry_price, o.filled_price, o.stoploss,
                           t.close_ts, t.close_price, t.close_reason, t.target_rr, t.target_rr_filled
                    FROM historical_ict_strategy_met_execution_updated s
                    JOIN historical_ict_orders_updated o ON o.signal_id=s.signal_hash
                    JOIN historical_ict_order_target_outcomes_updated t ON t.order_id=o.order_id AND t.target_no=1
                    WHERE UPPER(s.strategy_id)=UPPER(%s) AND s.signal_hash<>%s
                      AND t.state<>'OPEN' AND t.close_reason IS NOT NULL AND t.close_reason<>'missed_entry'
                    ORDER BY s.entry_datetime DESC NULLS LAST LIMIT 30
                """, [current["strategy_id"], current["signal_hash"]])
                matches = []
                for row in cur.fetchall():
                    score, features = _similar_score(current, row)
                    r = _similar_realized_r(row)
                    matches.append({"order_id": str(row["order_id"]), "signal_hash": str(row["signal_hash"]), "symbol": str(row["ticker"]), "market": str(row["market"]), "direction": str(row["direction"]), "strategy_id": str(row["strategy_id"]), "entry_datetime": serialize_value(row["entry_datetime"]), "close_ts": serialize_value(row["close_ts"]), "close_reason": str(row["close_reason"]), "realized_r": round2(r), "similarity_score": score, "matched_features": features})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500
    matches.sort(key=lambda item: (item["similarity_score"], item["entry_datetime"] or ""), reverse=True)
    closed = [item for item in matches if item["realized_r"] is not None]
    wins = [item for item in closed if item["realized_r"] > 0]
    average_r = sum(item["realized_r"] for item in closed) / len(closed) if closed else None
    common = {}
    for item in matches[:5]:
        for feature in item["matched_features"]: common[feature] = common.get(feature, 0) + 1
    summary = {"sample_size": len(matches), "closed_count": len(closed), "win_rate_pct": round2(100 * len(wins) / len(closed), 1) if closed else None, "average_realized_r": round2(average_r), "average_similarity_pct": round(sum(item["similarity_score"] for item in matches) / len(matches)) if matches else None, "strongest_matches": [item[0] for item in sorted(common.items(), key=lambda item: -item[1])[:3]], "evidence_readout": f"{len(wins)}/{len(closed)} closed reference trades finished positive; average realized outcome was {'not computable' if average_r is None else f'{average_r:+.2f}R'}." if closed else "No closed reference outcomes were available in the newest comparable sample."}
    return jsonify({"success": True, "calculation_version": "similar-trades-v1", "current": {"signal_hash": current["signal_hash"], "market": current["market"], "ticker": current["ticker"], "strategy_id": current["strategy_id"], "direction": current["direction"], "entry_datetime": serialize_value(current["entry_datetime"])}, "methodology": "Exact strategy match; newest 30 completed updated-pipeline trades; deterministic comparison of direction, market, multi-timeframe bias, and persisted ICT order-block/FVG/liquidity/swing/structure evidence. The model, when requested, explains this fixed evidence only.", "summary": summary, "trades": matches})


# ---------------------------------------------------------------------------
# Account Management: broker-truth history and realtime broker snapshot.
#
# The historical view reads the realtime_production_broker_* tables written by
# scripts/broker_sync/sync_broker_accounts.py. The live view calls the brokers
# directly through scripts/broker_sync/live_snapshot.py — Vercel cannot do that
# itself because the credentials and the whitelisted IP live on this machine.
# ---------------------------------------------------------------------------

BROKER_SYNC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "broker_sync")

BROKER_HISTORY_TABLES = (
    "realtime_production_broker_orders",
    "realtime_production_broker_trades",
    "realtime_production_broker_positions",
    "realtime_production_broker_funds",
    "realtime_production_broker_ledger",
    "realtime_production_broker_sync_watermarks",
    "realtime_production_broker_reconciliation_issues",
)

BROKER_POSITIONS_SQL = """
    SELECT broker, broker_account, trade_date, tradingsymbol, underlying, exchange, segment,
           product, instrument_type, option_type, strike, expiry_date, position_type,
           net_quantity, buy_quantity, sell_quantity, buy_avg_price, sell_avg_price,
           average_price, last_price, close_price, realized_pnl, unrealized_pnl, total_pnl,
           lotsize, snapshot_at, source_feed
      FROM realtime_production_broker_positions
     WHERE trade_date BETWEEN %s AND %s
     ORDER BY trade_date DESC, tradingsymbol
     LIMIT 20000
"""

BROKER_ORDERS_SQL = """
    SELECT order_uid, broker, broker_account, broker_order_id, exchange_order_id, trade_date,
           status, status_raw, is_open, reject_reason, exchange, segment, tradingsymbol,
           underlying, instrument_type, option_type, strike, expiry_date, product, order_type,
           side, quantity, filled_quantity, pending_quantity, price, trigger_price,
           average_price, order_ts, exchange_ts, broker_updated_ts, source,
           algo_execution_id::text, algo_source_order_id::text, source_feed
      FROM realtime_production_broker_orders
     WHERE trade_date BETWEEN %s AND %s
     ORDER BY COALESCE(order_ts, broker_updated_ts) DESC NULLS LAST, trade_date DESC
     LIMIT 20000
"""

BROKER_TRADES_SQL = """
    SELECT trade_uid, broker, broker_account, broker_order_id, broker_trade_id, trade_date,
           tradingsymbol, underlying, exchange, segment, option_type, strike, expiry_date,
           product, side, quantity, price, trade_value, trade_ts, brokerage, taxes, charges_total,
           source_feed
      FROM realtime_production_broker_trades
     WHERE trade_date BETWEEN %s AND %s
     ORDER BY trade_ts DESC NULLS LAST
     LIMIT 20000
"""

BROKER_FUNDS_SQL = """
    SELECT DISTINCT ON (broker, broker_account)
           broker, broker_account, trade_date, available_cash, opening_balance, utilised_margin,
           collateral, withdrawable_balance, net_balance, realized_pnl, unrealized_pnl, snapshot_at
      FROM realtime_production_broker_funds
     WHERE trade_date <= %s
     ORDER BY broker, broker_account, trade_date DESC
"""

BROKER_LEDGER_SQL = """
    SELECT broker, broker_account, entry_date, category, voucher_type, narration,
           debit, credit, net_amount, running_balance
      FROM realtime_production_broker_ledger
     WHERE entry_date BETWEEN %s AND %s
     ORDER BY entry_date DESC
     LIMIT 20000
"""

BROKER_SYNC_SQL = """
    SELECT broker, broker_account, dataset, last_record_ts, last_trade_date, last_success_at,
           last_attempt_at, last_status, last_error, rows_total
      FROM realtime_production_broker_sync_watermarks
     ORDER BY broker, broker_account, dataset
"""

BROKER_ISSUES_SQL = """
    SELECT issue_uid, broker, broker_account, trade_date, issue_type, severity,
           broker_order_id, execution_id::text, tradingsymbol, message, details,
           first_seen_at, last_seen_at
      FROM realtime_production_broker_reconciliation_issues
     WHERE resolved = FALSE
     ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, last_seen_at DESC
     LIMIT 500
"""


def _broker_schema_ready(cur):
    cur.execute(
        "SELECT COUNT(*)::int AS present FROM pg_class WHERE relname = ANY(%s) AND relkind = 'r'",
        (list(BROKER_HISTORY_TABLES),),
    )
    row = cur.fetchone()
    present = (row or {}).get("present", 0)
    return present == len(BROKER_HISTORY_TABLES)


@app.get("/api/account-management/history/rows")
def account_management_history_rows():
    """Broker-confirmed history for the Account Management historical view.

    Returns raw rows only; the Next.js route owns the aggregation so the direct
    Postgres and REST-bridge deployments share one contract, matching how
    /api/account-management/rows already works.
    """
    if not require_api_token():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    today = date.today()
    to_date = request.args.get("to") or today.isoformat()
    from_date = request.args.get("from") or (today - timedelta(days=90)).isoformat()

    try:
        with psycopg2.connect(**db_config()) as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                if not _broker_schema_ready(cur):
                    return jsonify({
                        "success": True,
                        "schema_ready": False,
                        "message": (
                            "Broker-truth tables are not created yet. Run "
                            "scripts/broker_sync/sync_broker_accounts.py --schema-only once."
                        ),
                        "accounts": [], "positions": [], "orders": [], "trades": [],
                        "funds": [], "ledger": [], "sync_status": [], "issues": [],
                    })

                cur.execute(ACCOUNT_REGISTRY_SQL)
                accounts = [serialize_row(row) for row in cur.fetchall()]
                cur.execute(BROKER_POSITIONS_SQL, (from_date, to_date))
                positions = [serialize_row(row) for row in cur.fetchall()]
                cur.execute(BROKER_ORDERS_SQL, (from_date, to_date))
                orders = [serialize_row(row) for row in cur.fetchall()]
                cur.execute(BROKER_TRADES_SQL, (from_date, to_date))
                trades = [serialize_row(row) for row in cur.fetchall()]
                cur.execute(BROKER_FUNDS_SQL, (to_date,))
                funds = [serialize_row(row) for row in cur.fetchall()]
                cur.execute(BROKER_LEDGER_SQL, (from_date, to_date))
                ledger = [serialize_row(row) for row in cur.fetchall()]
                cur.execute(BROKER_SYNC_SQL)
                sync_status = [serialize_row(row) for row in cur.fetchall()]
                cur.execute(BROKER_ISSUES_SQL)
                issues = [serialize_row(row) for row in cur.fetchall()]
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500

    return jsonify({
        "success": True,
        "schema_ready": True,
        "range": {"from": from_date, "to": to_date},
        "accounts": accounts,
        "positions": positions,
        "orders": orders,
        "trades": trades,
        "funds": funds,
        "ledger": ledger,
        "sync_status": sync_status,
        "issues": issues,
    })


@app.get("/api/account-management/oanda/rows")
def account_management_oanda_rows():
    """OANDA broker-truth rows (scripts/broker_sync/oanda_sync.py) for the Account Management OANDA view.

    Raw rows only; the Next.js route /api/account-management/oanda owns the aggregation.
    """
    if not require_api_token():
        return jsonify({"success": False, "error": "Unauthorized"}), 401
    try:
        with psycopg2.connect(**db_config()) as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("SELECT to_regclass('public.oanda_account_trades') IS NOT NULL AS ok")
                if not cur.fetchone()["ok"]:
                    return jsonify({"success": True, "schema_ready": False, "trades": [], "transfers": [], "snapshot": None})
                cur.execute(
                    "SELECT account_id, trade_id::text, environment, instrument, local_symbol, side, units, state, "
                    "open_ts, open_price, open_order_id::text, open_order_type, close_ts, close_price, close_reason, "
                    "realized_pl, financing, half_spread_cost, unrealized_pl, take_profit, stop_loss, client_tag, "
                    "strategy_id, strategy_detail, strategy_source, synced_at FROM oanda_account_trades ORDER BY open_ts DESC"
                )
                trades = [serialize_row(row) for row in cur.fetchall()]
                cur.execute(
                    "SELECT account_id, transaction_id::text, transfer_ts, amount, funding_reason, account_balance "
                    "FROM oanda_account_transfers ORDER BY transfer_ts"
                )
                transfers = [serialize_row(row) for row in cur.fetchall()]
                cur.execute(
                    "SELECT snapshot_at, account_id, environment, currency, balance, nav, pl, unrealized_pl, financing, "
                    "commission, open_trade_count, last_transaction_id::text, created_time "
                    "FROM oanda_account_snapshots ORDER BY snapshot_at DESC LIMIT 1"
                )
                snapshot = cur.fetchone()
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500
    return jsonify({"success": True, "schema_ready": True, "trades": trades, "transfers": transfers,
                    "snapshot": serialize_row(snapshot) if snapshot else None})


def _load_live_snapshot_module():
    if BROKER_SYNC_DIR not in sys.path:
        sys.path.insert(0, BROKER_SYNC_DIR)
    import live_snapshot  # noqa: PLC0415 - imported lazily so Flask boots without broker SDKs

    return live_snapshot


@app.get("/api/broker-live/snapshot")
def broker_live_snapshot():
    """Fetch open positions, working/rejected orders and funds straight from the brokers."""
    if not require_api_token():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    brokers = tuple(value for value in request.args.getlist("broker") if value and value.lower() != "all")
    accounts = tuple(value for value in request.args.getlist("account") if value and value.upper() != "ALL")
    persist = (request.args.get("persist") or "1").strip().lower() not in {"0", "false", "no"}
    force = (request.args.get("force") or "0").strip().lower() in {"1", "true", "yes"}

    try:
        module = _load_live_snapshot_module()
        payload = module.live_snapshot(
            brokers=brokers or None,
            accounts=accounts or None,
            persist=persist,
            force=force,
        )
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500

    return jsonify({"success": True, **payload})


@app.post("/api/broker-live/reset-sessions")
def broker_live_reset_sessions():
    """Drop cached broker sessions so the next snapshot logs in again."""
    if not require_api_token():
        return jsonify({"success": False, "error": "Unauthorized"}), 401
    try:
        _load_live_snapshot_module().invalidate_sessions()
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500
    return jsonify({"success": True})


# ---------------------------------------------------------------------------
# Read-only SQL proxy for the Vercel deployment.
# src/lib/db.ts sends node-pg style queries ($1, $2 ...) here when PG_PROXY_URL
# is set, so every PG-backed route works on Vercel without exposing port 5432.
# Every statement runs inside a READ ONLY transaction with a statement timeout.
# ---------------------------------------------------------------------------
import re as _re

_PG_PARAM = _re.compile(r"\$(\d+)")
_TXN_NOOP = _re.compile(r"^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SET\s+LOCAL)\b", _re.I)
# OIDs node-pg returns as strings (int8, numeric) and as Date (date, timestamp, timestamptz)
_STRING_OIDS = {20, 1700}
_DATE_OIDS = {1082, 1114, 1184}


import threading as _threading

_PROXY_POOL = None
_PROXY_POOL_LOCK = _threading.Lock()


def _proxy_pool():
    """Reused read-only connections (saves a new Postgres login per query).
    Max 16 = waitress threads, so a request never finds the pool exhausted."""
    global _PROXY_POOL
    with _PROXY_POOL_LOCK:
        if _PROXY_POOL is not None:
            return _PROXY_POOL
        from psycopg2.pool import ThreadedConnectionPool

        class _ReadOnlyPool(ThreadedConnectionPool):
            def _connect(self, key=None):
                conn = super()._connect(key)
                conn.set_session(readonly=True)
                return conn

        _PROXY_POOL = _ReadOnlyPool(1, 16, **db_config())
        return _PROXY_POOL


def _proxy_value(value, oid):
    if value is None:
        return None
    if oid in _STRING_OIDS:
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, timedelta):
        return value.total_seconds()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (bytes, memoryview)):
        return bytes(value).hex()
    return value


@app.post("/api/sql/query")
def sql_proxy_query():
    if not os.getenv("ALGO_API_TOKEN") or not require_api_token():
        return jsonify({"error": "Unauthorized"}), 401
    body = request.get_json(silent=True) or {}
    if isinstance(body.get("b64"), str):
        # zrok's public frontend blocks some SQL patterns, so the client base64-encodes the payload.
        import base64
        try:
            body = json.loads(base64.b64decode(body["b64"]).decode("utf-8"))
        except Exception:
            return jsonify({"error": "Bad payload"}), 400
    text = body.get("text") or ""
    values = body.get("values") or []
    if not isinstance(text, str) or not text.strip():
        return jsonify({"error": "Missing query text"}), 400
    if _TXN_NOOP.match(text):
        return jsonify({"rows": [], "fields": [], "rowCount": 0, "command": "NOOP"})
    sql = _PG_PARAM.sub(lambda m: "%(p" + m.group(1) + ")s", text.replace("%", "%%"))
    params = {f"p{i + 1}": v for i, v in enumerate(values)}
    conn = None
    broken = False
    try:
        conn = _proxy_pool().getconn()
        with conn.cursor() as cur:
            cur.execute("SET LOCAL statement_timeout = '60s'")
            cur.execute(sql, params)
            if cur.description is None:
                return jsonify({"rows": [], "fields": [], "rowCount": cur.rowcount, "command": "OK"})
            cols = [(d.name, d.type_code) for d in cur.description]
            rows = [
                {name: _proxy_value(val, oid) for (name, oid), val in zip(cols, rec)}
                for rec in cur.fetchall()
            ]
        return Response(
            json.dumps({
                "rows": rows,
                "fields": [{"name": n, "dataTypeID": o} for n, o in cols],
                "rowCount": len(rows),
                "command": "SELECT",
            }, default=str),
            mimetype="application/json",
        )
    except psycopg2.Error as exc:
        broken = isinstance(exc, (psycopg2.OperationalError, psycopg2.InterfaceError))
        return jsonify({"error": str(exc).strip(), "code": exc.pgcode}), 400
    finally:
        if conn is not None:
            try:
                if not conn.closed:
                    conn.rollback()
            except Exception:
                broken = True
            _proxy_pool().putconn(conn, close=broken or bool(conn.closed))


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8765"))
    app.run(host="127.0.0.1", port=port)
