"""Exact, read-only historical trade lookup for strategy_json questions.

The user must identify a trade with ticker, strategy, and entry datetime.  The
lookup is deterministic; the language model only explains the persisted JSON.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor

from .config import settings


_DATETIME_RE = re.compile(
    r"\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)\b",
    re.IGNORECASE,
)
_EXPLICIT_STRATEGY_RE = re.compile(
    r"\bstrategy(?:_id)?\s*(?:is\s+|[:=]\s*)?([A-Z][A-Z0-9_-]{0,48})\b",
    re.IGNORECASE,
)
_STRATEGY_RE = re.compile(
    r"\b(S-ICT-COUNTER-TRADE|S-CH\d{1,3}|S\d{1,2}(?:[_-][A-Z0-9]+)*|A\d{1,3}(?:[_-][A-Z0-9]+)*)\b",
    re.IGNORECASE,
)
_EXPLICIT_TICKER_RE = re.compile(
    r"\b(?:ticker|symbol)\s*(?:is\s+|[:=]\s*)?([A-Z^][A-Z0-9.^=-]{0,19})\b",
    re.IGNORECASE,
)
_DOLLAR_TICKER_RE = re.compile(r"\$([A-Z][A-Z0-9.=-]{0,14})\b")
_TRADE_CUE_RE = re.compile(
    r"\b(strategy[_ ]json|historical\s+trade|backtest\s+trade|this\s+trade|"
    r"trade\s+(?:setup|evidence|checklist|qualification)|setup\s+(?:evidence|checklist)|"
    r"why\s+(?:did|was|is)\s+(?:this\s+)?(?:trade|setup)|confluence)\b",
    re.IGNORECASE,
)
_BARE_TOKEN_RE = re.compile(r"(?<![\w$])([A-Z^][A-Z0-9.^=-]{0,14})(?![\w])")
_RESERVED_TOKENS = {
    "A", "ABOUT", "ANALYZE", "AND", "ANSWER", "BACKTEST", "BASED", "DATE", "DATETIME",
    "ENTRY", "EXIT", "EXPLAIN", "FOR", "FROM", "HOW", "ICT", "IN", "JSON", "OF", "ON",
    "STRATEGY", "THE", "THIS", "TICKER", "TRADE", "USING", "WHAT", "WHY", "WITH",
}


@dataclass(frozen=True)
class BacktestTradeRequest:
    ticker: str | None
    strategy_id: str | None
    entry_datetime: datetime | None
    entry_datetime_text: str | None

    @property
    def missing(self) -> list[str]:
        missing: list[str] = []
        if not self.ticker:
            missing.append("ticker")
        if not self.strategy_id:
            missing.append("strategy")
        if not self.entry_datetime:
            missing.append("entry datetime")
        return missing


def _normalize_strategy(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip().upper()
    if value in _RESERVED_TOKENS:
        return None
    match = re.fullmatch(r"S(\d{1,2})", value)
    return f"S{int(match.group(1)):02d}" if match else value


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _bare_ticker(message: str, strategy_id: str | None) -> str | None:
    for match in _BARE_TOKEN_RE.finditer(message):
        token = match.group(1).upper()
        if token == strategy_id or token in _RESERVED_TOKENS or _STRATEGY_RE.fullmatch(token):
            continue
        if token.startswith("T") and re.fullmatch(r"T\d{2}", token):
            continue
        return token
    return None


def parse_backtest_trade_request(message: str) -> BacktestTradeRequest:
    strategy_match = _EXPLICIT_STRATEGY_RE.search(message) or _STRATEGY_RE.search(message)
    strategy_id = _normalize_strategy(strategy_match.group(1) if strategy_match else None)

    ticker_match = _EXPLICIT_TICKER_RE.search(message) or _DOLLAR_TICKER_RE.search(message)
    ticker = ticker_match.group(1).upper() if ticker_match else _bare_ticker(message, strategy_id)

    datetime_match = _DATETIME_RE.search(message)
    datetime_text = datetime_match.group(1) if datetime_match else None
    return BacktestTradeRequest(
        ticker=ticker,
        strategy_id=strategy_id,
        entry_datetime=_parse_datetime(datetime_text),
        entry_datetime_text=datetime_text,
    )


def is_backtest_trade_question(message: str, current_tab: str | None = None) -> bool:
    request = parse_backtest_trade_request(message)
    has_complete_reference = not request.missing
    in_backtest = current_tab == "backtest" or bool(re.search(r"\bbacktest\b", message, re.IGNORECASE))
    return in_backtest and (bool(_TRADE_CUE_RE.search(message)) or has_complete_reference)


def _db_config() -> dict[str, Any]:
    return {
        "host": settings.postgres_host,
        "port": settings.postgres_port,
        "dbname": settings.postgres_database,
        "user": settings.postgres_user,
        "password": settings.postgres_password,
        "sslmode": settings.postgres_sslmode or "disable",
        "connect_timeout": 4,
    }


def lookup_backtest_trade(request: BacktestTradeRequest) -> dict[str, Any]:
    if request.missing:
        return {"status": "missing", "missing": request.missing}
    if not (settings.postgres_host and settings.postgres_database and settings.postgres_user):
        return {"status": "unavailable", "reason": "postgres_not_configured"}

    sql = """
        WITH signals AS (
            SELECT 'original'::text AS pipeline, signal_hash, market, ticker, strategy_id,
                   direction, entry_datetime, entry_price, stoploss, target_1, target_2,
                   target_3, strategy_json, updated_timestamp
            FROM historical_ict_strategy_met_execution
            UNION ALL
            SELECT 'updated'::text AS pipeline, signal_hash, market, ticker, strategy_id,
                   direction, entry_datetime, entry_price, stoploss, target_1, target_2,
                   target_3, strategy_json, updated_timestamp
            FROM historical_ict_strategy_met_execution_updated
        )
        SELECT pipeline, signal_hash, market, ticker, strategy_id, direction,
               entry_datetime, entry_price, stoploss, target_1, target_2, target_3,
               strategy_json
        FROM signals
        WHERE upper(ticker) = %s
          AND upper(strategy_id) = %s
          AND (
              date_trunc('minute', entry_datetime) = date_trunc('minute', %s::timestamptz)
              OR to_char(entry_datetime, 'YYYY-MM-DD HH24:MI') = %s
              OR to_char(entry_datetime AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') = %s
          )
        ORDER BY CASE WHEN pipeline = 'updated' THEN 0 ELSE 1 END,
                 (strategy_json IS NULL), updated_timestamp DESC NULLS LAST, signal_hash
        LIMIT 1
    """
    minute_text = request.entry_datetime.strftime("%Y-%m-%d %H:%M")
    try:
        with psycopg2.connect(**_db_config()) as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    sql,
                    (
                        request.ticker,
                        request.strategy_id,
                        request.entry_datetime,
                        minute_text,
                        minute_text,
                    ),
                )
                rows = [dict(row) for row in cur.fetchall()]
    except psycopg2.Error:
        return {"status": "unavailable", "reason": "postgres_query_failed"}

    if not rows:
        return {
            "status": "not_found",
            "ticker": request.ticker,
            "strategy_id": request.strategy_id,
            "entry_datetime": request.entry_datetime_text,
        }
    row = rows[0]
    for key, value in tuple(row.items()):
        if isinstance(value, datetime):
            row[key] = value.isoformat()
    return {"status": "found", "trade": row}


def strategy_json_for_prompt(trade: dict[str, Any], question: str, limit: int = 9_000) -> str:
    """Keep exact JSON when it fits; otherwise rank flattened facts for the question."""
    strategy_json = trade.get("strategy_json")
    raw = json.dumps(strategy_json, default=str, ensure_ascii=False, sort_keys=True)
    if len(raw) <= limit:
        return raw

    question_terms = {
        token.lower() for token in re.findall(r"[A-Za-z][A-Za-z0-9_]{2,}", question)
        if token.lower() not in {"the", "this", "that", "trade", "ticker", "strategy", "entry", "datetime"}
    }
    priority_terms = {
        "checklist", "direction", "engine_mode", "entry_method", "entry_price", "execution",
        "historical_backtest", "no_lookahead", "pattern", "primary_target_no", "strategy_name",
        "strategy_version", "target_plan",
    }
    leaves: list[tuple[int, str, Any]] = []

    def walk(value: Any, path: str = "") -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                walk(child, f"{path}.{key}" if path else str(key))
        elif isinstance(value, list):
            for index, child in enumerate(value):
                walk(child, f"{path}[{index}]")
        else:
            path_terms = set(re.findall(r"[a-z0-9]+", path.lower()))
            value_terms = set(re.findall(r"[a-z0-9]+", str(value).lower()))
            score = 10 * len(question_terms & (path_terms | value_terms))
            score += 3 * len(priority_terms & path_terms)
            leaves.append((score, path, value))

    walk(strategy_json)
    leaves.sort(key=lambda item: (-item[0], item[1]))
    selected: list[dict[str, Any]] = []
    used = 160
    for _, path, value in leaves:
        item = {"path": path, "value": value}
        item_size = len(json.dumps(item, default=str, ensure_ascii=False)) + 2
        if used + item_size > limit:
            continue
        selected.append(item)
        used += item_size
    return json.dumps(
        {
            "format": "flattened_strategy_json_key_paths",
            "truncated": True,
            "original_chars": len(raw),
            "fields": selected,
        },
        default=str,
        ensure_ascii=False,
    )
