"""Approved, non-sensitive guidance for each Titania workspace tab.

This is deliberately product documentation, not a scrape of browser state.  It
lets the assistant explain a page immediately while live quantitative facts
continue to come only from narrowly allowlisted, read-only services.
"""
from __future__ import annotations

from typing import Any


TAB_GUIDES: dict[str, dict[str, Any]] = {
    "backtest": {
        "label": "Backtest",
        "purpose": "Review persisted historical outcomes and research metrics; it does not place trades.",
        "capabilities": ["filter by market, symbol, strategy, direction, target, and date", "inspect equity, drawdown, monthly results, and strategy breakdown", "open a closed order chart", "inspect persisted strategy_json and ask Titania about one exact trade"],
        "data_boundary": "Use visible filters or approved historical aggregates for performance facts. A strategy_json question must identify the ticker, strategy, and entry datetime. Do not present a backtest as a live signal.",
    },
    "tradezella": {
        "label": "Trade Journal",
        "purpose": "Review backtest and authorized realtime executions in a journal/calendar workflow.",
        "capabilities": ["filter executions", "review daily outcomes", "record personal review notes"],
        "data_boundary": "Journal notes remain user-scoped; never expose another user's notes or account activity.",
    },
    "stonk": {
        "label": "Stonk Ledger",
        "purpose": "Provide a ledger-style view of authorized historical and realtime execution outcomes.",
        "capabilities": ["compare sources", "inspect realized outcomes", "group activity by symbol or strategy"],
        "data_boundary": "Only authorized, persisted execution data may be summarized.",
    },
    "blogs": {
        "label": "Strategy Blogs",
        "purpose": "Browse approved ICT/SMC strategy and concept documentation.",
        "capabilities": ["search strategy codes and concepts", "open linked strategy articles", "learn ICT terminology"],
        "data_boundary": "Documentation explains methodology; it is not a current trade recommendation.",
    },
    "monitoring": {
        "label": "Monitoring",
        "purpose": "Review operational status, order monitoring, and anomaly workflows.",
        "capabilities": ["inspect open-order and alert context when a live source is attached", "explain monitoring controls", "identify what needs human review"],
        "data_boundary": "Displayed placeholder status cards are not operational evidence. Current status requires an approved live source.",
    },
    "live-orders": {
        "label": "Live Orders",
        "purpose": "Read authorized open orders, recent order activity, events, and alert delivery status.",
        "capabilities": ["summarize open orders", "explain order states", "surface operational anomalies"],
        "data_boundary": "Read-only by default. Never reveal order-security details or any other user's orders.",
    },
    "deployments": {
        "label": "Deployments",
        "purpose": "Explain strategy deployment environments and their review gates.",
        "capabilities": ["describe configured deployment cards", "explain readiness and review gates", "guide an authorized operator to the next review step"],
        "data_boundary": "Titania cannot deploy, start, stop, or modify a strategy from chat. Current deployment state needs a server-backed source.",
    },
}


def tab_guide(tab: str | None) -> dict[str, Any] | None:
    return TAB_GUIDES.get((tab or "").strip().lower())
