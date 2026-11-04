import asyncio

from backend.titania_assistant.context import assemble_context
from backend.titania_assistant.graph import classify_intent
from backend.titania_assistant.schemas import ChatRequest, ContextEnvelope
from backend.titania_assistant.tab_context import TAB_GUIDES


def test_requested_workspace_tabs_have_approved_guides():
    assert {"backtest", "tradezella", "stonk", "blogs", "monitoring", "live-orders", "deployments"}.issubset(TAB_GUIDES)


def test_backtest_tab_guide_is_server_side_context():
    context = asyncio.run(assemble_context(ContextEnvelope(role="internal", current_tab="backtest"), False, "How do I use this tab?"))
    assert "CURRENT TAB GUIDE" in context.block
    assert any(source.label == "Titania module guide: Backtest" for source in context.sources)


def test_tab_question_is_classified_without_a_model_call():
    state = {"request": ChatRequest(message="How do I use the Trade Journal?", context=ContextEnvelope(role="internal", current_tab="tradezella"))}
    result = asyncio.run(classify_intent(state))
    assert result["intent"] == "platform_help"
    assert not result["needs_platform_data"]
