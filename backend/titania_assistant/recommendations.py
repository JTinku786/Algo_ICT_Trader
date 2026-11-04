"""Deterministic recommendation eligibility, sizing, and ranking.

The LLM explains a decision; it never creates the numeric trade plan.  This module
only accepts explicitly supplied, source-backed candidate rows and rejects stale or
incomplete evidence before a model call happens.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable

from .config import settings
from .schemas import ContextEnvelope, RecommendationCandidate, RecommendationDecision


def _first(row: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            return value
    return None


def _number(row: dict[str, Any], *keys: str) -> float | None:
    value = _first(row, *keys)
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _normalise_direction(value: Any) -> str | None:
    upper = str(value or "").upper()
    if upper in {"BUY", "LONG"}:
        return "BUY"
    if upper in {"SELL", "SHORT"}:
        return "SELL"
    return None


def _as_of(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def _fresh(value: Any) -> bool:
    as_of = _as_of(value)
    if as_of is None:
        return False
    age = (datetime.now(timezone.utc) - as_of).total_seconds() / 60
    return 0 <= age <= settings.max_signal_age_minutes


def _metric(value: float | None, default: float) -> float:
    if value is None:
        return default
    return max(0.0, min(1.0, value))


def _candidate(row: dict[str, Any]) -> tuple[RecommendationCandidate | None, str | None]:
    symbol = _first(row, "symbol", "ticker", "base_symbol")
    direction = _normalise_direction(_first(row, "direction", "side", "signal_side"))
    entry = _number(row, "entry", "entry_price", "planned_entry_price", "fill_price")
    stop = _number(row, "stop_loss", "stoploss", "stop_price")
    target = _number(row, "take_profit", "target_2", "target2", "tp2", "target_1", "target1", "tp1")
    as_of = _first(row, "as_of_ts", "signal_ts", "generated_at", "created_at")
    if not all([symbol, direction, entry, stop, target]) or entry == stop:
        return None, "candidate_missing_execution_plan"
    if not _fresh(as_of):
        return None, "candidate_stale_or_missing_timestamp"
    if direction == "BUY" and not (stop < entry < target):
        return None, "candidate_invalid_buy_geometry"
    if direction == "SELL" and not (target < entry < stop):
        return None, "candidate_invalid_sell_geometry"
    risk_r = abs(target - entry) / abs(entry - stop)
    if risk_r < 1.0:
        return None, "candidate_rr_below_one"
    raw_wr = _number(row, "win_rate", "winrate", "wr")
    win_rate = raw_wr / 100 if raw_wr is not None and raw_wr > 1 else raw_wr
    pf = _number(row, "profit_factor", "pf")
    samples = _number(row, "sample_size", "trades", "closed_trades", "n")
    sample_size = int(samples) if samples is not None else None
    if sample_size is not None and sample_size < settings.min_backtest_samples:
        return None, "candidate_insufficient_backtest_sample"
    # The score is deterministic, bounded, and conservative where a metric is absent.
    wr_score = _metric(win_rate, 0.45)
    rr_score = min(risk_r / 3, 1.0)
    pf_score = min((pf or 1.0) / 2, 1.0)
    sample_score = min((sample_size or settings.min_backtest_samples) / 100, 1.0)
    score = round(0.35 * wr_score + 0.30 * rr_score + 0.20 * pf_score + 0.15 * sample_score, 4)
    return RecommendationCandidate(
        symbol=str(symbol), direction=direction, strategy_id=_first(row, "strategy_id", "strategy", "strategy_key"),
        entry=entry, stop_loss=stop, take_profit=target, risk_r=round(risk_r, 2), score=score,
        win_rate=win_rate, profit_factor=pf, sample_size=sample_size, as_of=str(as_of),
        source_label=str(_first(row, "source_label", "source", "strategy") or "Visible Titania signal"),
    ), None


def decide_recommendation(ctx: ContextEnvelope, rows: Iterable[dict[str, Any]]) -> RecommendationDecision:
    candidates: list[RecommendationCandidate] = []
    reasons: list[str] = []
    for row in rows:
        candidate, reason = _candidate(row)
        if candidate is not None:
            candidates.append(candidate)
        elif reason and reason not in reasons:
            reasons.append(reason)
    candidates.sort(key=lambda c: (c.score, c.win_rate or 0, c.risk_r, c.profit_factor or 0), reverse=True)
    candidates = [c for c in candidates if c.score >= settings.min_recommendation_score][:3]
    if not candidates:
        return RecommendationDecision(kind="no_trade", reasons=reasons or ["no_authorized_high_confidence_setup"])

    # External recommendations must be personalized. Internal users can see a
    # research ranking but intentionally receive no size unless a profile exists.
    profile = ctx.profile
    if ctx.role == "external" and (not profile.account_size or not profile.risk_tolerance):
        return RecommendationDecision(kind="no_trade", reasons=["current_user_risk_profile_incomplete"])
    risk_pct = profile.max_risk_pct
    if risk_pct is None and profile.risk_tolerance:
        risk_pct = {"low": 0.5, "medium": 1.0, "high": 1.5}[profile.risk_tolerance]
    primary = candidates[0]
    risk_amount = profile.account_size * risk_pct / 100 if profile.account_size and risk_pct else None
    quantity = int(risk_amount / abs(primary.entry - primary.stop_loss)) if risk_amount else None
    return RecommendationDecision(
        kind="recommendation", candidates=candidates, account_risk_pct=risk_pct,
        risk_amount=round(risk_amount, 2) if risk_amount else None, quantity=quantity,
    )
