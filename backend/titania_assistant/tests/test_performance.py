from backend.titania_assistant.performance import parse_recent_win_rate_request
from backend.titania_assistant.context import AssembledContext
from backend.titania_assistant.schemas import ChatRequest, ContextEnvelope


def test_parses_s03_recent_win_rate_question():
    request = parse_recent_win_rate_request("tell me last 7 days win rate for S03 by India and US markets")
    assert request is not None
    assert request.strategy_id == "S03"
    assert request.days == 7


def test_does_not_treat_general_metric_education_as_database_query():
    assert parse_recent_win_rate_request("What is win rate?") is None


def test_verified_recent_win_rate_renders_without_a_model_call():
    import asyncio
    from backend.titania_assistant.graph import prepare_verified_data_summary

    state = {
        "request": ChatRequest(message="last 7 days S03 win rate", context=ContextEnvelope(role="internal")),
        "intent": "data_summary",
        "language": "en",
        "t_start": __import__("time").perf_counter(),
        "assembled": AssembledContext(
            recent_performance={
                "strategy_id": "S03",
                "days": 7,
                "markets": [
                    {"market": "india", "wins": 3, "closed_orders": 5, "win_rate_pct": 60.0},
                    {"market": "us", "wins": 1, "closed_orders": 4, "win_rate_pct": 25.0},
                ],
            }
        ),
    }
    result = asyncio.run(prepare_verified_data_summary(state))
    assert result["response"].answer.startswith("S03 trailing 7-day win rate: INDIA: 60.0% (3/5")
    assert result["response"].latency.lane == "deterministic"
