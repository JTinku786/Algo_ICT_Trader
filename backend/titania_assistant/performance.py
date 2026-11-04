"""Read-only, bounded performance aggregates for approved Titania analytics answers."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor

from .config import settings

_RECENT_WIN_RATE = re.compile(
    r"\b(?:last\s*(?:7|seven)\s*days?|7d)\b.*\bwin\s*rate\b|"
    r"\bwin\s*rate\b.*\b(?:last\s*(?:7|seven)\s*days?|7d)\b",
    re.IGNORECASE,
)
_STRATEGY = re.compile(r"\bS\s*-?\s*(\d{1,2})\b", re.IGNORECASE)


@dataclass(frozen=True)
class RecentWinRateRequest:
    strategy_id: str
    days: int = 7


def parse_recent_win_rate_request(message: str) -> RecentWinRateRequest | None:
    """Recognize only the narrow aggregate this service is authorized to expose."""
    if not _RECENT_WIN_RATE.search(message):
        return None
    strategy = _STRATEGY.search(message)
    if not strategy:
        return None
    return RecentWinRateRequest(strategy_id=f"S{int(strategy.group(1)):02d}")


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


def recent_win_rates(request: RecentWinRateRequest) -> list[dict[str, Any]]:
    """Return closed-order state performance by market, using the trailing N*24h.

    An order reaches the aggregate only after close_ts is present. `CLOSED_TP`
    counts as a win, `CLOSED_SL` as a loss, and other closed states are derived
    from realized R. This keeps broker/manual closures visible without inventing
    an outcome for open or signal-only rows.
    """
    if not (settings.postgres_host and settings.postgres_database and settings.postgres_user):
        return []
    sql = """
        WITH closed AS (
            SELECT
                lower(coalesce(s.market, o.source_market, o.market)) AS market,
                o.state,
                o.close_ts,
                CASE WHEN upper(coalesce(o.direction, s.direction)) = 'SELL'
                    THEN coalesce(o.filled_price, o.entry_price, s.entry_price) - o.close_price
                    ELSE o.close_price - coalesce(o.filled_price, o.entry_price, s.entry_price)
                END / NULLIF(
                    abs(coalesce(o.filled_price, o.entry_price, s.entry_price) - coalesce(o.stoploss, s.stoploss)),
                    0
                ) AS realized_r
            FROM realtime_production_orders o
            JOIN realtime_production_ict_strategy_met_execution s ON s.signal_hash = o.signal_id
            WHERE upper(s.strategy_id) = %s
              AND o.close_ts >= now() - make_interval(days => %s)
              AND o.close_ts IS NOT NULL
              AND o.state LIKE 'CLOSED%%'
        )
        SELECT
            market,
            count(*)::int AS closed_orders,
            count(*) FILTER (
                WHERE state = 'CLOSED_TP'
                   OR (state NOT IN ('CLOSED_TP', 'CLOSED_SL') AND realized_r > 0)
            )::int AS wins,
            count(*) FILTER (
                WHERE state = 'CLOSED_SL'
                   OR (state NOT IN ('CLOSED_TP', 'CLOSED_SL') AND realized_r < 0)
            )::int AS losses,
            count(*) FILTER (
                WHERE state NOT IN ('CLOSED_TP', 'CLOSED_SL') AND coalesce(realized_r, 0) = 0
            )::int AS breakeven,
            round(
                100.0 * count(*) FILTER (
                    WHERE state = 'CLOSED_TP'
                       OR (state NOT IN ('CLOSED_TP', 'CLOSED_SL') AND realized_r > 0)
                ) / nullif(count(*), 0),
                1
            ) AS win_rate_pct,
            min(close_ts) AS first_close_ts,
            max(close_ts) AS last_close_ts
        FROM closed
        WHERE market IN ('india', 'us')
        GROUP BY market
        ORDER BY market
    """
    try:
        with psycopg2.connect(**_db_config()) as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(sql, (request.strategy_id, request.days))
                return [dict(row) for row in cur.fetchall()]
    except psycopg2.Error:
        return []
