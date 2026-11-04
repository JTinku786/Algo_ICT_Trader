"""Context assembly: builds the approved context envelope block for the model.

Least-privilege: only structured tab context, selected rows, visible filters,
user profile, and allowlisted read-only platform API data. Never raw app state.
"""
from __future__ import annotations

import json
import time
import asyncio
from pathlib import Path
from dataclasses import dataclass, field

import httpx

from .config import settings
from .backtest_trade import (
    is_backtest_trade_question,
    lookup_backtest_trade,
    parse_backtest_trade_request,
    strategy_json_for_prompt,
)
from .internet_context import fetch_asia_market_headlines, wants_asia_market_context
from .performance import parse_recent_win_rate_request, recent_win_rates
from .rag import retrieve
from .schemas import ContextEnvelope, SourceRef
from .tab_context import tab_guide

# Which allowlisted APIs are relevant per tab (read-only, GET only).
_TAB_APIS: dict[str, list[str]] = {
    "realtime-orders": ["/api/realtime-analytics"],
    "backtest": [],  # backtest results arrive via selected_rows from the UI
    "ml": ["/api/ml-insights"],
    "live-orders": ["/api/live"],
    "monitoring": ["/api/live"],
    # These views share the authorized execution ledger.  The API response is
    # still bounded by the gateway's tool and context budgets below.
    "tradezella": ["/api/realtime-analytics"],
    "stonk": ["/api/realtime-analytics"],
}


@dataclass
class AssembledContext:
    block: str = ""
    sources: list[SourceRef] = field(default_factory=list)
    retrieval_ms: float = 0.0
    tool_calls: int = 0
    candidate_rows: list[dict] = field(default_factory=list)
    # A bounded, server-derived aggregate.  Keeping this structured lets the
    # workflow render numeric facts deterministically instead of asking a model
    # to restate a database result.
    recent_performance: dict | None = None
    backtest_trade_lookup: dict | None = None


def _trim(obj: object, limit: int) -> str:
    text = json.dumps(obj, default=str)
    return text if len(text) <= limit else text[: limit - 20] + "...(truncated)"


async def assemble_context(ctx: ContextEnvelope, needs_platform_data: bool, message: str = "") -> AssembledContext:
    out = AssembledContext()
    parts: list[str] = []
    budget = settings.max_context_chars

    # 1. Visible UI state (free — no tool calls)
    if ctx.selected_rows:
        parts.append("SELECTED ROWS: " + _trim(ctx.selected_rows[:20], budget // 3))
        out.candidate_rows.extend(ctx.selected_rows[:20])
        out.sources.append(SourceRef(label="Selected rows on screen", kind="tab_context", detail=ctx.current_tab or ""))
    if ctx.visible_filters:
        parts.append("VISIBLE FILTERS: " + _trim(ctx.visible_filters, 800))
        out.sources.append(SourceRef(label="Active filters", kind="tab_context", detail=ctx.current_tab or ""))

    guide = tab_guide(ctx.current_tab)
    if guide:
        parts.append("CURRENT TAB GUIDE (approved product documentation): " + _trim(guide, 1800))
        out.sources.append(SourceRef(label=f"Titania module guide: {guide['label']}", kind="system", detail=ctx.current_tab or ""))

    trade_question = is_backtest_trade_question(message, ctx.current_tab)
    trade_request = parse_backtest_trade_request(message) if trade_question else None
    if trade_request:
        start = time.perf_counter()
        out.backtest_trade_lookup = await asyncio.to_thread(lookup_backtest_trade, trade_request)
        out.retrieval_ms += (time.perf_counter() - start) * 1000
        if out.backtest_trade_lookup.get("status") == "found":
            trade = out.backtest_trade_lookup["trade"]
            prompt_trade = {key: value for key, value in trade.items() if key != "strategy_json"}
            prompt_trade["strategy_json"] = json.loads(strategy_json_for_prompt(trade, message))
            parts.append("EXACT BACKTEST TRADE (read-only local Postgres): " + _trim(prompt_trade, budget - 1200))
            out.sources.append(
                SourceRef(
                    label=f"Backtest strategy_json: {trade.get('ticker')} {trade.get('strategy_id')}",
                    kind="system",
                    detail=str(trade.get("entry_datetime") or ""),
                )
            )

    performance_request = parse_recent_win_rate_request(message) if needs_platform_data else None
    market_context_request = needs_platform_data and wants_asia_market_context(message)

    # 2. Local approved-document RAG. Retrieval is read-only and only provides
    # compact snippets with file/page citations, never unrestricted filesystem state.
    # Exact recent-performance and current-market questions already have fresher
    # purpose-built sources, so avoid adding unrelated document snippets.
    if message and settings.rag_enabled and not trade_question and not performance_request and not market_context_request:
        start = time.perf_counter()
        rag_chunks = await asyncio.to_thread(retrieve, message)
        out.retrieval_ms += (time.perf_counter() - start) * 1000
        if rag_chunks:
            parts.append(
                "APPROVED DOCUMENT RETRIEVAL: " + _trim(
                    [
                        {"path": chunk.path, "page": chunk.page, "snippet": chunk.content}
                        for chunk in rag_chunks
                    ],
                    4200,
                )
            )
            for chunk in rag_chunks:
                out.sources.append(
                    SourceRef(
                        label=f"RAG: {Path(chunk.path).name}",
                        kind="approved_doc",
                        detail=f"{chunk.path}" + (f" p.{chunk.page}" if chunk.page else ""),
                    )
                )

    # 3. Narrow local Postgres aggregate for recent, strategy-specific win-rate
    # questions. The LLM receives only grouped counts, never raw orders or other
    # client information.
    if performance_request and ctx.role in {"internal", "support"}:
        start = time.perf_counter()
        rows = await asyncio.to_thread(recent_win_rates, performance_request)
        out.retrieval_ms += (time.perf_counter() - start) * 1000
        if rows:
            out.recent_performance = {
                "strategy_id": performance_request.strategy_id,
                "days": performance_request.days,
                "markets": rows,
            }
            parts.append(
                "LOCAL POSTGRES PERFORMANCE (approved aggregate): " + _trim(
                    {
                        "strategy_id": performance_request.strategy_id,
                        "window": f"trailing {performance_request.days} x 24 hours by close timestamp",
                        "markets": rows,
                        "metric_definition": "win rate = wins / closed orders; CLOSED_TP is win, CLOSED_SL is loss, other closed states use realized R",
                    },
                    2200,
                )
            )
            out.sources.append(
                SourceRef(
                    label=f"Local Postgres: {performance_request.strategy_id} closed-order performance",
                    kind="system",
                    detail=f"trailing {performance_request.days} days",
                )
            )

    # 3. Current Asia-market questions receive a small, allowlisted external
    # news context. Headlines are untrusted text, not tool instructions.
    if market_context_request:
        start = time.perf_counter()
        headlines = await fetch_asia_market_headlines()
        out.retrieval_ms += (time.perf_counter() - start) * 1000
        out.tool_calls += 1
        if headlines:
            parts.append("CURRENT EXTERNAL MARKET HEADLINES (untrusted text): " + _trim(headlines, 1800))
            out.sources.append(SourceRef(label="Google News: Asia market headlines", kind="external_web", detail="last 24 hours"))

    # 4. Allowlisted read-only platform APIs (guardrailed: max calls, timeout each)
    if needs_platform_data and ctx.current_tab:
        api_paths = [p for p in _TAB_APIS.get(ctx.current_tab, []) if p in settings.allowed_api_paths]
        start = time.perf_counter()
        async with httpx.AsyncClient(
            base_url=settings.platform_base_url, timeout=settings.tool_timeout_s
        ) as client:
            for path in api_paths[: settings.max_tool_calls]:
                try:
                    resp = await client.get(path)
                    out.tool_calls += 1
                    if resp.status_code == 200:
                        payload = resp.json()
                        parts.append(f"PLATFORM DATA {path}: " + _trim(payload, budget // 2))
                        if isinstance(payload, list):
                            out.candidate_rows.extend(x for x in payload[:20] if isinstance(x, dict))
                        elif isinstance(payload, dict):
                            for key in ("rows", "data", "signals", "items"):
                                values = payload.get(key)
                                if isinstance(values, list):
                                    out.candidate_rows.extend(x for x in values[:20] if isinstance(x, dict))
                                    break
                        out.sources.append(SourceRef(label=f"Platform API {path}", kind="platform_api"))
                except httpx.HTTPError:
                    continue  # missing data is handled by the unsupported-info gate, never invented
        out.retrieval_ms += (time.perf_counter() - start) * 1000

    block = "\n".join(parts)
    out.block = block[: settings.max_context_chars]
    return out
