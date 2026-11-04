"""Per-message logging + unanswered-question store.

Primary: Postgres (shared with the platform). Fallback: local SQLite so the
assistant keeps its audit trail even when Postgres is unreachable.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Optional

from .config import settings

_DDL_PG = """
CREATE TABLE IF NOT EXISTS titania_assistant_messages (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id TEXT, role TEXT, language TEXT, mode TEXT, current_tab TEXT,
    intent TEXT, message TEXT, answer TEXT,
    confidence DOUBLE PRECISION, is_recommendation BOOLEAN,
    refused BOOLEAN, unsupported BOOLEAN,
    lane TEXT, model TEXT,
    ttft_ms DOUBLE PRECISION, total_ms DOUBLE PRECISION,
    guardrail_reasons TEXT, tool_calls INT
);
CREATE TABLE IF NOT EXISTS titania_unanswered_questions (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    message TEXT, user_role TEXT, language TEXT, current_tab TEXT,
    reason_unanswered TEXT, missing_source TEXT,
    confidence DOUBLE PRECISION, doc_gap_suspected BOOLEAN
);
CREATE TABLE IF NOT EXISTS titania_assistant_audits (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_id TEXT, user_id TEXT, event_type TEXT NOT NULL,
    decision_json TEXT, sources_json TEXT, tool_calls INT,
    context_version TEXT
);
CREATE TABLE IF NOT EXISTS titania_assistant_session_messages (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    session_id TEXT NOT NULL, user_id TEXT NOT NULL,
    role TEXT NOT NULL, content TEXT NOT NULL,
    request_id TEXT
);
"""

_DDL_SQLITE = _DDL_PG.replace("BIGSERIAL PRIMARY KEY", "INTEGER PRIMARY KEY AUTOINCREMENT").replace(
    "TIMESTAMPTZ NOT NULL DEFAULT now()", "TEXT"
).replace("DOUBLE PRECISION", "REAL").replace("BOOLEAN", "INTEGER")


class LogStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pg_conn = None
        self._sqlite: Optional[sqlite3.Connection] = None
        self._backend = "none"
        self._init()

    def _init(self) -> None:
        dsn = settings.postgres_dsn()
        if dsn:
            try:
                import psycopg2  # type: ignore

                self._pg_conn = psycopg2.connect(dsn, connect_timeout=5)
                self._pg_conn.autocommit = True
                with self._pg_conn.cursor() as cur:
                    cur.execute(_DDL_PG)
                self._backend = "postgres"
                return
            except Exception:
                self._pg_conn = None
        # SQLite fallback
        self._sqlite = sqlite3.connect(settings.sqlite_fallback_path, check_same_thread=False)
        self._sqlite.executescript(_DDL_SQLITE)
        self._sqlite.commit()
        self._backend = "sqlite"

    @property
    def backend(self) -> str:
        return self._backend

    # ------------------------------------------------------------ writes --

    def log_message(self, **row: Any) -> None:
        cols = [
            "user_id", "role", "language", "mode", "current_tab", "intent",
            "message", "answer", "confidence", "is_recommendation", "refused",
            "unsupported", "lane", "model", "ttft_ms", "total_ms",
            "guardrail_reasons", "tool_calls",
        ]
        values = [self._coerce(row.get(c)) for c in cols]
        self._insert("titania_assistant_messages", cols, values)

    def log_unanswered(self, **row: Any) -> None:
        cols = [
            "message", "user_role", "language", "current_tab", "reason_unanswered",
            "missing_source", "confidence", "doc_gap_suspected",
        ]
        values = [self._coerce(row.get(c)) for c in cols]
        self._insert("titania_unanswered_questions", cols, values)

    def log_audit(self, **row: Any) -> None:
        cols = ["request_id", "user_id", "event_type", "decision_json", "sources_json", "tool_calls", "context_version"]
        self._insert("titania_assistant_audits", cols, [self._coerce(row.get(c)) for c in cols])

    def log_session_message(self, **row: Any) -> None:
        cols = ["session_id", "user_id", "role", "content", "request_id"]
        self._insert("titania_assistant_session_messages", cols, [self._coerce(row.get(c)) for c in cols])

    def get_session_context(self, session_id: str | None, user_id: str, limit: int = 20) -> list[dict[str, str]]:
        """Return only this user's bounded, content-only prior turns.

        Provider reasoning artifacts and raw context envelopes are intentionally
        excluded from conversational memory.
        """
        if not session_id:
            return []
        with self._lock:
            try:
                if self._backend == "postgres" and self._pg_conn is not None:
                    with self._pg_conn.cursor() as cur:
                        cur.execute(
                            "SELECT role, content FROM titania_assistant_session_messages "
                            "WHERE session_id=%s AND user_id=%s ORDER BY id DESC LIMIT %s",
                            (session_id, user_id, limit),
                        )
                        return [{"role": role, "content": content} for role, content in reversed(cur.fetchall())]
                if self._sqlite is not None:
                    rows = self._sqlite.execute(
                        "SELECT role, content FROM titania_assistant_session_messages "
                        "WHERE session_id=? AND user_id=? ORDER BY id DESC LIMIT ?",
                        (session_id, user_id, limit),
                    ).fetchall()
                    return [{"role": role, "content": content} for role, content in reversed(rows)]
            except Exception:
                return []
        return []

    # ----------------------------------------------------------- helpers --

    @staticmethod
    def _coerce(v: Any) -> Any:
        if isinstance(v, (dict, list)):
            return json.dumps(v, default=str)
        return v

    def _insert(self, table: str, cols: list[str], values: list[Any]) -> None:
        with self._lock:
            try:
                if self._backend == "postgres" and self._pg_conn is not None:
                    ph = ",".join(["%s"] * len(cols))
                    with self._pg_conn.cursor() as cur:
                        cur.execute(f"INSERT INTO {table} ({','.join(cols)}) VALUES ({ph})", values)
                    return
            except Exception:
                self._backend = "sqlite"  # degrade permanently for this process
                if self._sqlite is None:
                    self._sqlite = sqlite3.connect(settings.sqlite_fallback_path, check_same_thread=False)
                    self._sqlite.executescript(_DDL_SQLITE)
            if self._sqlite is not None:
                ph = ",".join(["?"] * (len(cols) + 1))
                self._sqlite.execute(
                    f"INSERT INTO {table} (ts,{','.join(cols)}) VALUES ({ph})",
                    [datetime.now(timezone.utc).isoformat(), *values],
                )
                self._sqlite.commit()


store = LogStore()
