"""Titania assistant workflow — explicit stateful flow.

Nodes: classify_intent -> scope_check -> assemble_context -> generate -> validate_output -> log.
The same node functions are composed into a LangGraph StateGraph when `langgraph` is
installed (compiled graph exposed as `compiled_graph`), and are also driven directly by
`run_turn` / `run_turn_streaming` so the hot path can stream tokens with zero extra hops.
"""
from __future__ import annotations

import json
import re
import time
from typing import Any, AsyncIterator, Optional, TypedDict

from .config import settings
from .backtest_trade import is_backtest_trade_question
from .context import AssembledContext, assemble_context
from .gateway import GenerationResult, gateway
from .guardrails import (
    REFUSAL_CROSS_USER,
    REFUSAL_INJECTION,
    InputVerdict,
    check_input,
    check_output,
)
from .logging_store import store
from .prompts import CLASSIFIER_PROMPT, build_system_prompt
from .recommendations import decide_recommendation
from .schemas import ChatRequest, ChatResponse, LatencyBreakdown, SourceRef


class TurnState(TypedDict, total=False):
    request: ChatRequest
    input_verdict: InputVerdict
    intent: str
    language: str
    needs_platform_data: bool
    assembled: AssembledContext
    decision: object
    generation: GenerationResult
    response: ChatResponse
    degraded: bool
    t_start: float
    classify_ms: float
    context_ms: float


_RECO_INTENTS = {"recommendation", "comparison"}

# deterministic fast-path classifier (regex first; LLM classifier only when ambiguous)
_RECO_RE = re.compile(
    r"\b(recommend|should i (buy|sell|trade|enter)|best (trade|setup)|top ?3|"
    r"what (trade|setup)|entry|any (good )?(trade|setup)s?)\b",
    re.IGNORECASE,
)
_EDU_RE = re.compile(
    r"\b(what is|explain|how does|define|meaning of|difference between|"
    r"fvg|bos|mss|order block|amd|liquidity sweep|profit factor|sharpe|expectancy|drawdown|win rate|"
    r"hedg(e|ing)|iron condor|iron butterfly|butterfly|straddle|strangle|covered call|protective put|"
    r"collar|credit spread|debit spread|bull call|bear put|breakeven|theta|delta|gamma|vega|implied volatility)\b",
    re.IGNORECASE,
)
_DATA_RE = re.compile(
    r"\b(my (open|current) (trades?|positions?|orders?)|today'?s (signals?|orders?)|summar(y|ize)|"
    r"performance|p&l|pnl|anomal(y|ies)|last (week|7 days))\b",
    re.IGNORECASE,
)
_MARKET_CONTEXT_RE = re.compile(
    r"\b(?:asia|asian|nikkei|hang\s*seng|shanghai|kospi|japan|china|hong\s*kong)\b.*\b(?:market|markets|today|news)\b|"
    r"\b(?:market|markets)\b.*\b(?:asia|asian|nikkei|hang\s*seng|shanghai|kospi|japan|china|hong\s*kong)\b",
    re.IGNORECASE,
)
_TAB_HELP_RE = re.compile(
    r"\b(backtest|trade journal|journal|stonk|ledger|strategy blog|blog|monitoring|live orders?|deployment|"
    r"this (?:tab|page)|current (?:tab|page)|filter|dropdown|where can i find)\b",
    re.IGNORECASE,
)
_NON_LATIN_RE = re.compile(r"[ऀ-ॿఀ-౿]")  # Devanagari / Telugu blocks


async def classify_intent(state: TurnState) -> TurnState:
    t0 = time.perf_counter()
    msg = state["request"].message
    intent, language, needs_data = None, state["request"].session_language or "en", False

    if is_backtest_trade_question(msg, state["request"].context.current_tab):
        intent, needs_data = "backtest_trade", True
    elif _RECO_RE.search(msg):
        intent, needs_data = "recommendation", True
    elif _DATA_RE.search(msg) or _MARKET_CONTEXT_RE.search(msg):
        intent, needs_data = "data_summary", True
    elif _TAB_HELP_RE.search(msg):
        intent = "platform_help"
    elif _EDU_RE.search(msg):
        intent = "education"

    if _NON_LATIN_RE.search(msg):
        language = "te" if re.search(r"[ఀ-౿]", msg) else "hi"

    if intent is None:
        # ambiguous -> one small LLM classifier call (json mode, tiny budget)
        result = await gateway.complete(
            CLASSIFIER_PROMPT, [{"role": "user", "content": msg[:800]}], max_tokens=80, json_mode=True
        )
        try:
            parsed = json.loads(result.text)
            intent = parsed.get("intent", "general")
            language = parsed.get("language", language)
            needs_data = bool(parsed.get("needs_platform_data", False))
        except (json.JSONDecodeError, AttributeError):
            intent = "general"

    state["intent"] = intent or "general"
    state["language"] = language
    state["needs_platform_data"] = needs_data
    state["classify_ms"] = (time.perf_counter() - t0) * 1000
    return state


async def scope_check(state: TurnState) -> TurnState:
    """Deterministic refusal fast path — target < 500 ms (no model call)."""
    verdict = state["input_verdict"]
    req = state["request"]
    refusal: Optional[str] = None
    if verdict.injection_detected:
        refusal = REFUSAL_INJECTION
    elif verdict.cross_user_request:
        refusal = REFUSAL_CROSS_USER
    elif not verdict.ok:
        refusal = settings.unsupported_message
    if refusal:
        state["response"] = ChatResponse(
            answer=refusal,
            intent=state.get("intent", "out_of_scope"),
            confidence=1.0,
            refused=True,
            language=state.get("language", "en"),
        )
    # recommendation eligibility vs data exposure eligibility are separate gates:
    # external users get recommendations only about their own authorized context —
    # enforced by the context envelope (we never attach other users' data).
    _ = req
    return state


async def do_assemble_context(state: TurnState) -> TurnState:
    t0 = time.perf_counter()
    state["assembled"] = await assemble_context(
        state["request"].context, state.get("needs_platform_data", False), state["request"].message
    )
    state["context_ms"] = (time.perf_counter() - t0) * 1000
    return state


async def prepare_recommendation(state: TurnState) -> TurnState:
    """Prepare verified recommendation facts for the LLM; never bypass the LLM."""
    if state.get("intent") != "recommendation":
        return state
    assembled = state.get("assembled", AssembledContext())
    state["decision"] = decide_recommendation(state["request"].context, assembled.candidate_rows)
    return state


async def prepare_verified_data_summary(state: TurnState) -> TurnState:
    """Render narrow database aggregates without an LLM transformation.

    Win-rate numerators and denominators are financial facts.  Once the
    read-only aggregate has been authorized and fetched, routing it through a
    generative model only adds latency and can make a correct answer fail an
    output wording check.
    """
    if state.get("intent") != "data_summary":
        return state
    assembled = state.get("assembled", AssembledContext())
    summary = assembled.recent_performance
    if not summary:
        return state

    market_lines: list[str] = []
    for row in summary["markets"]:
        market = str(row.get("market", "unknown")).upper()
        wins = int(row.get("wins") or 0)
        closed = int(row.get("closed_orders") or 0)
        rate = float(row.get("win_rate_pct") or 0)
        market_lines.append(f"{market}: {rate:.1f}% ({wins}/{closed} closed orders)")

    state["response"] = ChatResponse(
        request_id=state["request"].request_id,
        answer=(
            f"{summary['strategy_id']} trailing {summary['days']}-day win rate: "
            + "; ".join(market_lines)
            + ". Win rate = winning closed orders / all closed orders."
        ),
        intent="data_summary",
        confidence=1.0,
        sources=list(assembled.sources),
        language=state.get("language", "en"),
        latency=LatencyBreakdown(
            classify_ms=round(state.get("classify_ms", 0), 1),
            context_ms=round(state.get("context_ms", 0), 1),
            retrieval_ms=round(assembled.retrieval_ms, 1),
            total_ms=round((time.perf_counter() - state["t_start"]) * 1000, 1),
            lane="deterministic",
            model="local-postgres",
            degraded=state.get("degraded", False),
        ),
    )
    return state


async def prepare_backtest_trade_reference(state: TurnState) -> TurnState:
    """Ask for missing identifiers before any model call or return lookup errors."""
    if state.get("intent") != "backtest_trade":
        return state
    assembled = state.get("assembled", AssembledContext())
    lookup = assembled.backtest_trade_lookup or {"status": "unavailable"}
    status = lookup.get("status")
    answer: str | None = None
    unsupported = False
    if status == "missing":
        missing = lookup.get("missing") or ["ticker", "strategy", "entry datetime"]
        answer = (
            "Please provide the missing trade identifier"
            + ("s" if len(missing) != 1 else "")
            + ": " + ", ".join(missing)
            + ". Use: ticker=AAPL; strategy=S16; entry_datetime=2026-06-03T15:45:00-04:00."
        )
    elif status == "not_found":
        answer = (
            "I could not find an exact backtest trade with that ticker, strategy, and entry datetime. "
            "Please copy all three values from the Trade List and include the timezone shown by the JSON inspector."
        )
        unsupported = True
    elif status == "ambiguous":
        answer = (
            "More than one backtest trade matches that minute. Please provide the full entry datetime "
            "including seconds and timezone from the Trade List JSON inspector."
        )
    elif status == "unavailable":
        answer = "The backtest trade lookup is temporarily unavailable, so I cannot safely analyze its strategy_json."
        unsupported = True
    elif status == "found" and not lookup.get("trade", {}).get("strategy_json"):
        answer = "That trade was found, but it has no persisted strategy_json to analyze."
        unsupported = True

    if answer is not None:
        state["response"] = ChatResponse(
            request_id=state["request"].request_id,
            answer=answer,
            intent="backtest_trade",
            confidence=1.0,
            unsupported=unsupported,
            sources=list(assembled.sources),
            language=state.get("language", "en"),
            latency=LatencyBreakdown(
                classify_ms=round(state.get("classify_ms", 0), 1),
                context_ms=round(state.get("context_ms", 0), 1),
                retrieval_ms=round(assembled.retrieval_ms, 1),
                total_ms=round((time.perf_counter() - state["t_start"]) * 1000, 1),
                lane="deterministic",
                model="local-postgres",
                degraded=state.get("degraded", False),
            ),
        )
    return state


def _confidence(state: TurnState, gen: GenerationResult) -> float:
    """Deterministic confidence heuristic: evidence-backed answers score high;
    platform-data answers without any attached evidence score low."""
    if gen.error:
        return 0.0
    has_evidence = bool(state.get("assembled") and state["assembled"].block)
    if state.get("needs_platform_data") and not has_evidence:
        return 0.3  # would be a guess -> unsupported gate will catch it
    if gen.text.strip() == settings.unsupported_message:
        return 1.0  # correctly declining is a confident answer
    base = 0.85 if has_evidence else 0.75
    return base


def _model_user_message(state: TurnState) -> str:
    """Canonicalize an already-resolved trade timestamp for model clarity only."""
    message = state["request"].message
    if state.get("intent") != "backtest_trade":
        return message
    lookup = state.get("assembled", AssembledContext()).backtest_trade_lookup or {}
    canonical = lookup.get("trade", {}).get("entry_datetime")
    if not canonical:
        return message
    return re.sub(
        r"(?i)(entry_datetime\s*=\s*)[^;\s]+",
        lambda match: match.group(1) + str(canonical),
        message,
        count=1,
    )


def _backtest_trade_prompt(state: TurnState) -> str:
    lookup = state.get("assembled", AssembledContext()).backtest_trade_lookup or {}
    strategy_json = lookup.get("trade", {}).get("strategy_json") or {}
    checklist = strategy_json.get("checklist") if isinstance(strategy_json, dict) else None
    valid_steps = [
        item.get("step") for item in checklist or []
        if isinstance(item, dict) and item.get("step") is not None
    ]
    selected_pool = strategy_json.get("selected_pool") if isinstance(strategy_json, dict) else None
    pool_side = selected_pool.get("pool_side") if isinstance(selected_pool, dict) else None
    exact_constraints = []
    if valid_steps:
        exact_constraints.append(
            f"The only recorded checklist step numbers are {valid_steps}; never cite Checklist 0 or any unrecorded step."
        )
    if pool_side:
        exact_constraints.append(
            f"The recorded selected_pool.pool_side is {pool_side}; name that liquidity side exactly."
        )
    return (
        "\n\nBACKTEST TRADE ANALYSIS: Answer the user's exact question from the attached strategy_json. "
        "The server already resolved the three identifiers to this exact row; ISO timestamps with different "
        "timezone offsets can represent the same instant and must not be described as a mismatch. "
        "Explain the persisted setup evidence, checklist/gates, ICT structure, liquidity, FVG/OB/MSS, "
        "entry and target logic when those fields exist. Distinguish recorded facts from interpretation. "
        "Preserve the exact checklist step numbers recorded in strategy_json. "
        + " ".join(exact_constraints)
        + " If a requested fact is absent, say it is not recorded; never reconstruct or invent it."
    )


async def generate(state: TurnState) -> TurnState:
    req = state["request"]
    degraded = state.get("degraded", False)
    system = build_system_prompt(
        req.mode, req.context, degraded, state.get("assembled", AssembledContext()).block
    )
    if state.get("intent") == "backtest_trade":
        system += _backtest_trade_prompt(state)
    if state.get("decision"):
        system += "\n\nVERIFIED RECOMMENDATION DECISION: " + state["decision"].model_dump_json()
        if state["decision"].kind == "recommendation":
            system += "\nExplain this decision only. Do not alter or add entry, stop, target, quantity, score, or symbol."
        else:
            system += "\nExplain why there is no current trade. Do not recommend a symbol, direction, entry, stop, target, leverage, or quantity."
    history = store.get_session_context(req.session_id, req.context.user_id, limit=20)
    if not history:
        history = [{"role": m.role, "content": m.content} for m in req.history[-8:]]
    messages = history[-20:]
    messages.append({"role": "user", "content": _model_user_message(state)})
    max_tokens = settings.max_output_tokens_degraded if degraded else settings.max_output_tokens
    gen = await gateway.complete(system, messages, max_tokens=max_tokens)
    state["generation"] = gen
    return state


async def validate_output(state: TurnState) -> TurnState:
    t0 = time.perf_counter()
    gen = state["generation"]
    intent = state.get("intent", "general")
    is_reco = intent in _RECO_INTENTS
    confidence = _confidence(state, gen)
    verdict = check_output(gen.text or "", is_recommendation=is_reco, confidence=confidence)
    decision = state.get("decision")
    if decision and decision.kind == "no_trade" and re.search(
        r"(?im)^\s*(?:[-*]\s*)?(?:BUY|SELL|LONG|SHORT)\s+[A-Z][A-Z0-9.=-]{0,12}\b", gen.text or ""
    ):
        # A model may explain a no-trade decision, but it can never override it.
        verdict = check_output(settings.unsupported_message, is_recommendation=False, confidence=1.0)
    assembled = state.get("assembled", AssembledContext())
    sources: list[SourceRef] = list(assembled.sources)
    if not verdict.unsupported and not sources and not state.get("needs_platform_data"):
        sources.append(SourceRef(label="Approved strategy knowledge", kind="approved_doc"))
    state["response"] = ChatResponse(
        request_id=state["request"].request_id,
        answer=verdict.final_text,
        intent=intent,
        confidence=confidence,
        is_recommendation=is_reco,
        unsupported=verdict.unsupported,
        disclaimer=settings.disclaimer if is_reco and not verdict.unsupported else None,
        sources=sources,
        language=state.get("language", "en"),
        decision=decision,
        latency=LatencyBreakdown(
            classify_ms=round(state.get("classify_ms", 0), 1),
            context_ms=round(state.get("context_ms", 0), 1),
            retrieval_ms=round(assembled.retrieval_ms, 1),
            ttft_ms=round(gen.ttft_ms, 1),
            generation_ms=round(gen.generation_ms, 1),
            validation_ms=round((time.perf_counter() - t0) * 1000, 1),
            total_ms=round((time.perf_counter() - state["t_start"]) * 1000, 1),
            lane=gen.lane,
            model=gen.model,
            degraded=state.get("degraded", False),
        ),
    )
    state["response"].latency.validation_ms = round((time.perf_counter() - t0) * 1000, 1)
    return state


async def log_turn(state: TurnState) -> TurnState:
    req = state["request"]
    resp = state.get("response")
    if resp is None:
        return state
    assembled = state.get("assembled", AssembledContext())
    store.log_message(
        user_id=req.context.user_id, role=req.context.role, language=resp.language,
        mode=req.mode, current_tab=req.context.current_tab, intent=resp.intent,
        message=req.message[:2000], answer=resp.answer[:4000], confidence=resp.confidence,
        is_recommendation=resp.is_recommendation, refused=resp.refused,
        unsupported=resp.unsupported, lane=resp.latency.lane, model=resp.latency.model,
        ttft_ms=resp.latency.ttft_ms, total_ms=resp.latency.total_ms,
        guardrail_reasons=(state.get("generation").error or "")[:500] if state.get("generation") else "",
        tool_calls=assembled.tool_calls,
    )
    store.log_audit(
        request_id=req.request_id, user_id=req.context.user_id, event_type="turn_completed",
        decision_json=resp.decision.model_dump() if resp.decision else None,
        sources_json=[source.model_dump() for source in resp.sources], tool_calls=assembled.tool_calls,
        context_version=req.context.context_version,
    )
    if req.session_id:
        store.log_session_message(
            session_id=req.session_id, user_id=req.context.user_id, role="user",
            content=req.message[:2000], request_id=req.request_id,
        )
        store.log_session_message(
            session_id=req.session_id, user_id=req.context.user_id, role="assistant",
            content=resp.answer[:4000], request_id=req.request_id,
        )
    if resp.unsupported or resp.refused:
        store.log_unanswered(
            message=req.message[:2000], user_role=req.context.role, language=resp.language,
            current_tab=req.context.current_tab,
            reason_unanswered=(
                "refused" if resp.refused else
                "model_provider_unavailable" if state.get("generation") and state["generation"].error else
                "low_confidence_or_no_source"
            ),
            missing_source=(
                "model_provider" if state.get("generation") and state["generation"].error else
                "platform_data" if state.get("needs_platform_data") else "unknown"
            ),
            confidence=resp.confidence, doc_gap_suspected=resp.intent in {"education", "platform_help"},
        )
    return state


# ------------------------------------------------------- orchestration ------

async def run_turn(req: ChatRequest, degraded: bool = False) -> ChatResponse:
    state: TurnState = {"request": req, "t_start": time.perf_counter(), "degraded": degraded}
    state["input_verdict"] = check_input(req)
    state = await classify_intent(state) if state["input_verdict"].ok else state
    state.setdefault("intent", "out_of_scope")
    state.setdefault("language", "en")
    state = await scope_check(state)
    if "response" in state:  # refusal fast path
        state["response"].latency.total_ms = round((time.perf_counter() - state["t_start"]) * 1000, 1)
        await log_turn(state)
        return state["response"]
    state = await do_assemble_context(state)
    state = await prepare_backtest_trade_reference(state)
    if "response" in state:
        await log_turn(state)
        return state["response"]
    state = await prepare_verified_data_summary(state)
    if "response" in state:
        await log_turn(state)
        return state["response"]
    state = await prepare_recommendation(state)
    state = await generate(state)
    state = await validate_output(state)
    await log_turn(state)
    return state["response"]


async def run_turn_streaming(req: ChatRequest, degraded: bool = False) -> AsyncIterator[dict]:
    """SSE-friendly: yields {'type': 'delta'|'final', ...} events.
    Streams tokens immediately, then re-validates the full text before the final event;
    if validation fails, a 'replace' event swaps the streamed text for the safe answer."""
    state: TurnState = {"request": req, "t_start": time.perf_counter(), "degraded": degraded}
    state["input_verdict"] = check_input(req)
    if state["input_verdict"].ok:
        state = await classify_intent(state)
    state.setdefault("intent", "out_of_scope")
    state.setdefault("language", "en")
    state = await scope_check(state)
    if "response" in state:
        state["response"].latency.total_ms = round((time.perf_counter() - state["t_start"]) * 1000, 1)
        await log_turn(state)
        yield {"type": "final", "response": state["response"].model_dump()}
        return

    state = await do_assemble_context(state)
    state = await prepare_backtest_trade_reference(state)
    if "response" in state:
        await log_turn(state)
        yield {"type": "final", "response": state["response"].model_dump()}
        return
    state = await prepare_verified_data_summary(state)
    if "response" in state:
        await log_turn(state)
        yield {"type": "final", "response": state["response"].model_dump()}
        return
    state = await prepare_recommendation(state)
    system = build_system_prompt(
        req.mode, req.context, degraded, state.get("assembled", AssembledContext()).block
    )
    if state.get("intent") == "backtest_trade":
        system += _backtest_trade_prompt(state)
    if state.get("decision"):
        system += "\n\nVERIFIED RECOMMENDATION DECISION: " + state["decision"].model_dump_json()
        if state["decision"].kind == "recommendation":
            system += "\nExplain this decision only. Do not alter or add entry, stop, target, quantity, score, or symbol."
        else:
            system += "\nExplain why there is no current trade. Do not recommend a symbol, direction, entry, stop, target, leverage, or quantity."
    history = store.get_session_context(req.session_id, req.context.user_id, limit=20)
    if not history:
        history = [{"role": m.role, "content": m.content} for m in req.history[-8:]]
    messages = history[-20:]
    messages.append({"role": "user", "content": _model_user_message(state)})
    max_tokens = settings.max_output_tokens_degraded if degraded else settings.max_output_tokens
    gen = GenerationResult(text="")
    chunks: list[str] = []
    async for delta in gateway.stream(system, messages, max_tokens=max_tokens, _result=gen):
        chunks.append(delta)
        yield {"type": "delta", "text": delta}
    gen.text = "".join(chunks)
    state["generation"] = gen
    state = await validate_output(state)
    await log_turn(state)
    resp = state["response"]
    if resp.answer.strip() != gen.text.strip():
        yield {"type": "replace", "text": resp.answer}
    yield {"type": "final", "response": resp.model_dump()}


# Optional LangGraph compilation (same nodes, explicit state machine)
compiled_graph = None
try:  # pragma: no cover - depends on optional package
    from langgraph.graph import END, StateGraph

    _g = StateGraph(TurnState)
    _g.add_node("classify_intent", classify_intent)
    _g.add_node("scope_check", scope_check)
    _g.add_node("assemble_context", do_assemble_context)
    _g.add_node("prepare_backtest_trade_reference", prepare_backtest_trade_reference)
    _g.add_node("prepare_verified_data_summary", prepare_verified_data_summary)
    _g.add_node("prepare_recommendation", prepare_recommendation)
    _g.add_node("generate", generate)
    _g.add_node("validate_output", validate_output)
    _g.add_node("log_turn", log_turn)
    _g.set_entry_point("classify_intent")
    _g.add_edge("classify_intent", "scope_check")
    _g.add_conditional_edges(
        "scope_check",
        lambda s: "log_turn" if "response" in s else "assemble_context",
        {"log_turn": "log_turn", "assemble_context": "assemble_context"},
    )
    _g.add_edge("assemble_context", "prepare_backtest_trade_reference")
    _g.add_conditional_edges(
        "prepare_backtest_trade_reference",
        lambda s: "log_turn" if "response" in s else "prepare_verified_data_summary",
        {"log_turn": "log_turn", "prepare_verified_data_summary": "prepare_verified_data_summary"},
    )
    _g.add_conditional_edges(
        "prepare_verified_data_summary",
        lambda s: "log_turn" if "response" in s else "prepare_recommendation",
        {"log_turn": "log_turn", "prepare_recommendation": "prepare_recommendation"},
    )
    _g.add_edge("prepare_recommendation", "generate")
    _g.add_edge("generate", "validate_output")
    _g.add_edge("validate_output", "log_turn")
    _g.add_edge("log_turn", END)
    compiled_graph = _g.compile()
except ImportError:
    pass
