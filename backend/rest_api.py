import os
import math
from datetime import date, datetime
from decimal import Decimal

import psycopg2
from flask import Flask, jsonify, request
from psycopg2.extras import RealDictCursor


app = Flask(__name__)

MARKETS = {"us", "india", "forex"}


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


def normalize_backtest_trade(row):
    is_win = row["state"] == "CLOSED_TP"
    rr = num(row["target_rr"])
    filled_at = row["filled_at"]
    close_ts = row["close_ts"]
    hold_min = None
    if filled_at and close_ts:
        hold_min = round((close_ts - filled_at).total_seconds() / 60)
    return {
        "order_id": str(row["order_id"]),
        "symbol": row["symbol"],
        "strategy_id": row["strategy_id"],
        "strategy_name": row.get("strategy_name"),
        "direction": row["direction"],
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
    }


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


def build_strategy_breakdown(trades):
    grouped = {}
    for trade in trades:
        grouped.setdefault(trade["strategy_id"] or "-", []).append(trade)
    rows = []
    for strategy_id, items in grouped.items():
        wins = [t for t in items if t["r"] > 0]
        gross_profit = sum(t["r"] for t in wins)
        gross_loss = sum(t["r"] for t in items if t["r"] < 0)
        net_r = gross_profit + gross_loss
        rows.append({
            "strategy_id": strategy_id,
            "strategy_name": items[0].get("strategy_name"),
            "trades": len(items),
            "win_rate": round2(len(wins) / len(items) * 100, 1),
            "net_r": round2(net_r),
            "expectancy_r": round2(net_r / len(items)),
            "profit_factor": round2(gross_profit / abs(gross_loss)) if gross_loss else None,
        })
    return sorted(rows, key=lambda row: row["net_r"], reverse=True)


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
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def session_label(trade):
    filled_at = parsed_timestamp(trade.get("filled_at"))
    if not filled_at:
        return "Unknown"
    hour = filled_at.hour
    if hour < 7:
        return "Asia 00-07 UTC"
    if hour < 12:
        return "London 07-12 UTC"
    if hour < 21:
        return "New York 12-21 UTC"
    return "Other 21-24 UTC"


def build_research(trades, sizing, oos_pct):
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
            "by_session": attribution_rows(trades, session_label),
            "by_direction": attribution_rows(trades, lambda trade: (trade["direction"] or "Unknown").upper()),
            "by_strategy": attribution_rows(trades, lambda trade: trade["strategy_id"] or "Unknown"),
        },
        "data_quality": {
            "status": "REVIEW" if len(warnings) > 2 else "PASS",
            "closed_trades": len(trades),
            "first_close_ts": serialize_value(min(close_dates)) if close_dates else None,
            "last_close_ts": serialize_value(max(close_dates)) if close_dates else None,
            "missing": missing,
            "warnings": warnings,
        },
        "audit": {
            "calculation_version": "research-v1",
            "generated_at": datetime.utcnow().isoformat() + "Z",
            "source": "historical_ict_orders + historical_ict_order_target_outcomes",
            "assumptions": [
                f'{sizing["mode"]} sizing',
                f'{round2(sizing["commission_bps"])} bps commission plus {round2(sizing["slippage_bps"])} bps slippage on entry and exit notional',
                "Closed TP and SL outcomes only",
                "Chronological ordering by close timestamp",
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


@app.get("/api/backtest")
def backtest():
    if not require_api_token():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    symbol = (request.args.get("symbol") or "AAPL").strip().upper()
    strategy = (request.args.get("strategy_id") or "S16").strip().upper()
    direction = (request.args.get("direction") or "ALL").strip().upper()
    target = target_no(request.args.get("target_no"))
    year = (request.args.get("year") or "ALL").strip()
    start_date = clean_date(request.args.get("start_date"))
    end_date = clean_date(request.args.get("end_date"))
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

    filters = ["t.state IN ('CLOSED_TP','CLOSED_SL')", "t.target_no = %s", "UPPER(o.symbol) = %s"]
    params = [target, symbol]
    if strategy and strategy != "ALL":
        params.append(strategy)
        filters.append(f"UPPER(o.strategy_id) = %s")
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
                    """
                    SELECT o.strategy_id, MIN(r.strategy_name) AS strategy_name, MIN(r.strategy_key) AS strategy_key, COUNT(*)::int AS n
                    FROM historical_ict_orders o
                    JOIN historical_ict_order_target_outcomes t ON t.order_id = o.order_id
                    LEFT JOIN ict_strategy_reference r ON r.strategy_id = o.strategy_id
                    WHERE t.state IN ('CLOSED_TP','CLOSED_SL') AND t.target_no = %s AND UPPER(o.symbol) = %s
                    GROUP BY o.strategy_id
                    ORDER BY n DESC
                    """,
                    [target, symbol],
                )
                strategies = [serialize_row(row) for row in cur.fetchall()]

                cur.execute(
                    """
                    SELECT DISTINCT EXTRACT(YEAR FROM o.run_date)::int AS y
                    FROM historical_ict_orders o
                    JOIN historical_ict_order_target_outcomes t ON t.order_id = o.order_id
                    WHERE t.state IN ('CLOSED_TP','CLOSED_SL') AND UPPER(o.symbol) = %s
                    ORDER BY y DESC
                    """,
                    [symbol],
                )
                years = [str(row["y"]) for row in cur.fetchall()]

                cur.execute(
                    f"""
                    SELECT o.order_id, o.symbol, o.strategy_id, r.strategy_name, o.direction, o.filled_at,
                           o.entry_price, o.filled_price, o.stoploss, o.tp1,
                           t.close_ts, t.close_price, t.target_rr, t.state
                    FROM historical_ict_orders o
                    JOIN historical_ict_order_target_outcomes t ON t.order_id = o.order_id
                    LEFT JOIN ict_strategy_reference r ON r.strategy_id = o.strategy_id
                    WHERE {where}
                    ORDER BY t.close_ts ASC NULLS LAST, o.order_id
                    """,
                    params,
                )
                trades = [apply_sizing(normalize_backtest_trade(row), sizing) for row in cur.fetchall()]
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500

    max_rows = 1500
    trades_out = list(reversed(trades[-max_rows:])) if len(trades) > max_rows else list(reversed(trades))
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
        "strategy_breakdown": build_strategy_breakdown(trades),
        "research": build_research(trades, sizing, oos_pct),
        "trades": trades_out,
        "total_trades": len(trades),
        "returned": len(trades_out),
    })


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
                    SELECT o.order_id, o.symbol, o.market, o.direction,
                           o.entry_price, o.filled_price, o.stoploss, o.tp1, o.tp2, o.tp3,
                           o.filled_at, t.target_no, t.target_price, t.target_rr, t.state,
                           t.close_ts, t.close_price, t.close_reason
                    FROM historical_ict_orders o
                    JOIN historical_ict_order_target_outcomes t ON t.order_id = o.order_id
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

                filled_sec = epoch_seconds(order["filled_at"]) or 0
                close_sec = epoch_seconds(order["close_ts"]) or filled_sec
                span = max(close_sec - filled_sec, 3600)
                table = "historical_candles_5m" if span <= 4 * 86400 else "historical_candles_1h" if span <= 25 * 86400 else "candles_1d"
                pad = max(span * 0.4, 30 * (300 if table.endswith("5m") else 3600 if table.endswith("1h") else 86400))
                from_dt = datetime.fromtimestamp(filled_sec - pad).isoformat()
                to_dt = datetime.fromtimestamp(close_sec + pad).isoformat()

                cur.execute(
                    f"""
                    SELECT candle_ts, open_price, high_price, low_price, close_price
                    FROM {table}
                    WHERE (yahoo_symbol = %s OR base_symbol = %s)
                      AND candle_ts >= %s::timestamptz AND candle_ts <= %s::timestamptz
                    ORDER BY candle_ts ASC
                    LIMIT 1500
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
    })


REALTIME_ROWS_SQL = """
    SELECT
      s.signal_hash, s.market, s.ticker, s.base_symbol, s.company_name,
      s.exchange_timezone, s.direction, s.entry_datetime, s.entry_date,
      s.strategy_id, s.strategy, s.strategy_key, s.entry_price AS signal_entry_price,
      s.stoploss AS signal_stoploss, s.target_1, s.target_2, s.target_3, s.as_of_ts,
      o.order_id, o.state, o.order_type, o.qty, o.entry_price, o.filled_price,
      o.stoploss, o.tp1, o.tp2, o.tp3, o.filled_at, o.close_price, o.close_ts,
      o.close_reason, o.updated_at
    FROM realtime_production_ict_strategy_met_execution s
    LEFT JOIN realtime_production_orders o ON o.signal_id = s.signal_hash
    {where}
    ORDER BY s.entry_datetime DESC NULLS LAST
    LIMIT 10000
"""


@app.get("/api/realtime-analytics/rows")
def realtime_analytics_rows():
    """Raw realtime signal+order rows. The Next.js route performs the timezone-aware
    aggregation on top of these rows, so all analytics logic stays in one place."""
    if not require_api_token():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    market = (request.args.get("market") or "ALL").strip()
    ticker = (request.args.get("ticker") or "ALL").strip().upper()
    strategy = (request.args.get("strategy") or "ALL").strip().upper()
    direction = (request.args.get("direction") or "ALL").strip().upper()
    status = (request.args.get("status") or "ALL").strip().upper()

    conditions = []
    params = []
    if market != "ALL":
        conditions.append("LOWER(s.market) = LOWER(%s)")
        params.append(market)
    if ticker != "ALL":
        conditions.append("UPPER(s.ticker) = UPPER(%s)")
        params.append(ticker)
    if strategy != "ALL":
        conditions.append("UPPER(s.strategy_id) = UPPER(%s)")
        params.append(strategy)
    if direction != "ALL":
        conditions.append("UPPER(s.direction) = UPPER(%s)")
        params.append(direction)
    if status == "OPEN":
        conditions.append("o.state = 'OPEN'")
    if status == "COMPLETED":
        conditions.append("o.state LIKE 'CLOSED%%'")
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    query = REALTIME_ROWS_SQL.format(where=where)

    try:
        with psycopg2.connect(**db_config()) as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(query, params)
                rows = [serialize_row(row) for row in cur.fetchall()]
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500

    return jsonify({"success": True, "rows": rows})


EMPTY_OVERLAYS = {
    "order_blocks": [], "fvgs": [], "liquidity": [], "swings": [], "structure": [], "bias": None,
    "timeframe_5m": {}, "timeframe_15m": {}, "timeframe_30m": {}, "timeframe_1h": {},
    "timeframe_daily": {}, "timeframe_weekly": {},
}


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
            cur.execute(f"SELECT {order_cols} FROM realtime_production_orders o WHERE o.order_id = %s LIMIT 1", [order_id])
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
        cur.close(); conn.close()
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500

    dir_upper = (direction or "").upper()
    risk_points = abs(entry_price - stoploss) if entry_price is not None and stoploss is not None else None
    pnl_points = None
    if entry_price is not None and close_price is not None:
        pnl_points = (entry_price - close_price) if dir_upper == "SELL" else (close_price - entry_price)
    realized_r = round2(pnl_points / risk_points) if risk_points and risk_points > 0 and pnl_points is not None else None
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
        "overlays": EMPTY_OVERLAYS,
        "window": {"from": filled_sec - int(max(raw_span * 0.4, 24 * 300)), "to": close_sec + int(max(raw_span * 0.4, 24 * 300))},
    })


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8765"))
    app.run(host="127.0.0.1", port=port)
