from backend.titania_assistant.evals.generate_regression_cases import iter_cases


def test_regression_corpus_contract():
    cases = list(iter_cases())
    assert len(cases) == 10_000
    assert len({case["id"] for case in cases}) == 10_000
    assert {"recent_performance", "prompt_injection", "protected_data", "multilingual", "internet_context", "rag_retrieval", "platform_support"}.issubset(
        {case["category"] for case in cases}
    )
    platform_cases = [case for case in cases if case["category"] == "platform_support"]
    assert len(platform_cases) == 1_000
    assert set(platform_cases[0]["expected"]["tabs"]) == {"backtest", "tradezella", "stonk", "blogs", "monitoring", "live-orders", "deployments"}
