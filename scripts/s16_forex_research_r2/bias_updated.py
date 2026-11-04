"""Isolated price-scale-safe HTF bias; no changes to the shared reference module."""
import inspect
import math
import types

import pandas as pd

_namespace = None


def _reference():
    global _namespace
    if _namespace is None:
        from config import load_reference_module
        reference = load_reference_module()
        namespace = dict(reference.__dict__)
        # Rebind reference functions to an isolated namespace. Classes and the
        # imported module itself remain unchanged; no global monkey patching.
        for name, function in reference.__dict__.items():
            if inspect.isfunction(function) and function.__globals__ is reference.__dict__:
                copy = types.FunctionType(function.__code__, namespace, function.__name__, function.__defaults__, function.__closure__)
                copy.__kwdefaults__ = function.__kwdefaults__
                namespace[name] = copy

        def finite_float(value, ndigits=None):
            try:
                number = float(value)
            except (TypeError, ValueError):
                return None
            return number if math.isfinite(number) else None

        namespace["safe_float"] = finite_float
        # Inputs are in pips, so the tolerance is two pips or 0.25 ATR.
        # No absolute equity-price floor or price-level fallback remains.
        namespace["execution_tolerance"] = lambda frame, level: max(2.0, .25*(namespace["rolling_atr"](frame) or 0))
        _namespace = namespace
    return _namespace


def reference_bias(frame, tf, pip_size):
    if frame.empty:
        return "mixed"
    ref = _reference()
    normalized = frame.copy()
    normalized[["open", "high", "low", "close"]] /= pip_size
    highs, lows = ref["detect_swings"](tf, normalized, "America/New_York")
    events = ref["detect_structure_events"](tf, normalized, highs, lows, "America/New_York")
    progression = ref["derive_swing_progression"](highs, lows)
    if events:
        latest = max(ref["event_timestamp"](event, "America/New_York") for event in events)
        directions = {event.get("direction") for event in events if ref["event_timestamp"](event,"America/New_York")==latest}
        if {"bullish", "bearish"}.issubset(directions):
            return "mixed"
    return ref["derive_bias"](events, progression, normalized.iloc[-1].to_dict())
