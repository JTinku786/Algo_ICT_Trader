"""Deterministic recommendation tests: no provider, database, or network needed."""
from datetime import datetime, timedelta, timezone

import pytest

from backend.titania_assistant.recommendations import decide_recommendation
from backend.titania_assistant.schemas import ContextEnvelope, UserProfile


def _row(**overrides):
    base = {
        "ticker": "AAPL", "direction": "BUY", "entry_price": 200.0,
        "stoploss": 198.0, "target_2": 205.0, "strategy_id": "S16",
        "as_of_ts": datetime.now(timezone.utc).isoformat(), "win_rate": 62,
        "profit_factor": 1.7, "sample_size": 100,
    }
    return {**base, **overrides}


def test_ranks_valid_candidate_and_sizes_from_profile():
    context = ContextEnvelope(
        role="external",
        profile=UserProfile(account_size=10_000, risk_tolerance="medium", max_risk_pct=1.0),
    )
    decision = decide_recommendation(context, [_row()])
    assert decision.kind == "recommendation"
    assert decision.candidates[0].symbol == "AAPL"
    assert decision.candidates[0].risk_r == 2.5
    assert decision.risk_amount == 100.0
    assert decision.quantity == 50


@pytest.mark.parametrize("change", [
    {"as_of_ts": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()},
    {"target_2": 199.0},
    {"sample_size": 2},
])
def test_rejects_unusable_candidate(change):
    decision = decide_recommendation(ContextEnvelope(role="internal"), [_row(**change)])
    assert decision.kind == "no_trade"


def test_external_user_without_risk_profile_gets_no_trade():
    decision = decide_recommendation(ContextEnvelope(role="external"), [_row()])
    assert decision.kind == "no_trade"
    assert decision.reasons == ["current_user_risk_profile_incomplete"]


def test_invalid_candidate_produces_a_verified_no_trade_context_for_the_llm():
    decision = decide_recommendation(ContextEnvelope(role="internal"), [_row(target_2=199.0)])
    assert decision.kind == "no_trade"
    assert "candidate_invalid_buy_geometry" in decision.reasons
