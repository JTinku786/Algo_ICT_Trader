"""Isolated FX research adapter. Never changes the frozen or live S16 module."""
import contextvars
import hashlib
from pathlib import Path
import sys
import types

import numpy as np

ENGINE = Path(r"C:\Users\saite\Desktop\ICT_Automation\Backtesting_ICT_2017\s16_strategy.py")
EXPECTED_SHA = "77c1b6d1621ac68f2cda1b0b19853a786ded98ef72e56c04bb3ce6c831de79ed"
assert hashlib.sha256(ENGINE.read_bytes()).hexdigest() == EXPECTED_SHA, "Frozen detector changed"
_core = types.ModuleType("_isolated_s16_fx_r1")
_core.__file__ = str(ENGINE)
sys.modules[_core.__name__] = _core
_source = ENGINE.read_text(encoding="utf-8")
# Fixed decimal rounding is not invariant when the quote unit changes.
_old = 'key = str(round(item["price"], 4))'
assert _source.count(_old) == 1
_source = _source.replace(_old, 'key = str(round(item["price"] / _quote_tick()))')
_old_pool = 'key = str(round(price, 4))'
assert _source.count(_old_pool) == 1
_source = _source.replace(_old_pool, 'key = str(round(price / _quote_tick()))')
exec(compile(_source, str(ENGINE), "exec"), _core.__dict__)
_pip = contextvars.ContextVar("research_pip", default=None)
_core._quote_tick = lambda: _pip.get() / 10
BUFFER_PIPS = 2.0
PAIRS = {"AUDJPY", "AUDUSD", "CHFJPY", "EURGBP", "EURJPY", "EURUSD", "GBPJPY", "GBPUSD", "NZDUSD", "USDCAD", "USDCHF", "USDJPY"}


def pip_size(symbol):
    pair = symbol.lstrip("^")
    if pair not in PAIRS:
        raise ValueError(f"No FX instrument contract: {symbol}; metals require a separate contract")
    return .01 if pair.endswith("JPY") else .0001


def price_buffer(_price):
    pip = _pip.get()
    if pip is None:
        raise RuntimeError("Instrument pip context must be explicit")
    return BUFFER_PIPS * pip


def reclaimed_sweep(frame_5m, pool, direction, as_of_ts, sweep_buffer):
    result = _core.SweepResult(checked=True, pool_id=pool.pool_id, pool_side=pool.pool_side)
    if frame_5m is None or frame_5m.empty or pool.price is None:
        result.reason = "no_5m_data_or_pool_price"
        return result
    end = frame_5m.index.searchsorted(as_of_ts, side="right")
    ts = _core._ts(pool.created_at)
    start = frame_5m.index.searchsorted(ts, side="right") if ts is not None else 0
    if start >= end:
        result.reason = "no_candles_after_pool"
        return result
    buy = direction == "BUY"
    extremes = frame_5m["low" if buy else "high"].to_numpy(dtype=float)
    closes = frame_5m["close"].to_numpy(dtype=float)
    level = float(pool.price)
    wick = extremes[start:end] < level-sweep_buffer if buy else extremes[start:end] > level+sweep_buffer
    reclaim = closes[start:end] > level if buy else closes[start:end] < level
    candidates = np.flatnonzero(wick & reclaim)
    if not len(candidates):
        result.reason = "no_completed_same_bar_reclaimed_sweep"
        return result
    index = start + int(candidates[0])
    result.passed = result.wick_through = result.close_back_inside = True
    result.sweep_ts = _core.compact_ts(frame_5m.index[index])
    result.sweep_price = round(float(extremes[index]), 6)
    result.reason = "ssl_same_bar_reclaim" if buy else "bsl_same_bar_reclaim"
    return result


_core.price_buffer = price_buffer
_core.detect_5m_sweep = reclaimed_sweep


def build_s16_signal(*, pip_override=None, **kwargs):
    token = _pip.set(pip_override or pip_size(kwargs["symbol"]))
    try:
        row = _core.build_s16_signal(**kwargs)
        if row:
            row["strategy_id"] = "S16-FX-R1"
            row["strategy_json"]["research_revision"] = {
                "id": "S16-FX-R1", "classification": "LOCAL_ADAPTATION",
                "buffer_pips": BUFFER_PIPS, "pip_size": _pip.get(),
                "reclaim": "same completed sweep candle closes strictly inside pool",
                "target_dedup_tick": _pip.get()/10,
                "source_engine_sha256": EXPECTED_SHA,
            }
        return row
    finally:
        _pip.reset(token)


def __getattr__(name):
    return getattr(_core, name)
