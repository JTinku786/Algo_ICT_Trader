import asyncio
import time

from backend.titania_assistant.backtest_trade import (
    is_backtest_trade_question,
    parse_backtest_trade_request,
    strategy_json_for_prompt,
)
from backend.titania_assistant.context import AssembledContext
from backend.titania_assistant.graph import (
    _backtest_trade_prompt,
    _model_user_message,
    classify_intent,
    prepare_backtest_trade_reference,
)
from backend.titania_assistant.schemas import ChatRequest, ContextEnvelope


def test_parses_exact_trade_reference_from_prefill_format():
    request = parse_backtest_trade_request(
        "Analyze strategy_json for ticker=AXP; strategy=S-ICT-COUNTER-TRADE; "
        "entry_datetime=2026-06-03T15:45:00-04:00"
    )
    assert request.ticker == "AXP"
    assert request.strategy_id == "S-ICT-COUNTER-TRADE"
    assert request.entry_datetime is not None
    assert request.missing == []


def test_normalizes_short_strategy_and_reports_missing_values():
    request = parse_backtest_trade_request("Why did strategy S3 qualify?")
    assert request.strategy_id == "S03"
    assert request.missing == ["ticker", "entry datetime"]


def test_backtest_trade_question_is_deterministically_classified():
    state = {
        "request": ChatRequest(
            message="Why did this trade qualify in strategy_json?",
            context=ContextEnvelope(role="internal", current_tab="backtest"),
        )
    }
    result = asyncio.run(classify_intent(state))
    assert result["intent"] == "backtest_trade"
    assert result["needs_platform_data"] is True
    assert is_backtest_trade_question(state["request"].message, "backtest")


def test_missing_trade_identifiers_are_requested_without_a_model_call():
    state = {
        "request": ChatRequest(
            message="Explain this strategy_json trade",
            context=ContextEnvelope(role="internal", current_tab="backtest"),
        ),
        "intent": "backtest_trade",
        "language": "en",
        "t_start": time.perf_counter(),
        "assembled": AssembledContext(
            backtest_trade_lookup={
                "status": "missing",
                "missing": ["ticker", "strategy", "entry datetime"],
            }
        ),
    }
    result = asyncio.run(prepare_backtest_trade_reference(state))
    assert result["response"].latency.lane == "deterministic"
    assert "ticker, strategy, entry datetime" in result["response"].answer


def test_large_strategy_json_is_compacted_to_query_relevant_key_paths():
    trade = {
        "strategy_json": {
            "pattern": {"fvg": {"direction": "bullish", "low": 100, "high": 102}},
            "noise": {f"field_{index}": "x" * 80 for index in range(100)},
        }
    }
    compact = strategy_json_for_prompt(trade, "What does the FVG evidence show?", limit=800)
    assert '"truncated": true' in compact
    assert "pattern.fvg" in compact


def test_model_receives_canonical_timestamp_after_exact_server_resolution():
    state = {
        "request": ChatRequest(
            message="ticker=HD; strategy=S15; entry_datetime=2026-06-03T19:30:00.000Z. Why?",
            context=ContextEnvelope(role="internal", current_tab="backtest"),
        ),
        "intent": "backtest_trade",
        "assembled": AssembledContext(backtest_trade_lookup={
            "status": "found",
            "trade": {"entry_datetime": "2026-06-03T15:30:00-04:00"},
        }),
    }
    normalized = _model_user_message(state)
    assert "entry_datetime=2026-06-03T15:30:00-04:00" in normalized
    assert "19:30:00.000Z" not in normalized


def test_trade_prompt_constrains_checklist_numbers_and_liquidity_side():
    state = {
        "assembled": AssembledContext(backtest_trade_lookup={
            "status": "found",
            "trade": {"strategy_json": {
                "checklist": [{"step": 1}, {"step": 2}, {"step": 3}],
                "selected_pool": {"pool_side": "buyside"},
            }},
        }),
    }
    prompt = _backtest_trade_prompt(state)
    assert "[1, 2, 3]" in prompt
    assert "never cite Checklist 0" in prompt
    assert "selected_pool.pool_side is buyside" in prompt
