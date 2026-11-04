"""Optional LangSmith tracing for Titania request-level observability.

The default trace payload is metadata-only: customer text and protected trading
context stay out of LangSmith unless an operator explicitly opts in.
"""
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from .config import settings

logger = logging.getLogger(__name__)


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="ignore")).hexdigest()[:16]


@dataclass(frozen=True)
class TurnTrace:
    run_id: UUID


class LangSmithObserver:
    """Best-effort tracing; observability must never delay or break a turn."""

    def __init__(self) -> None:
        self._client: Any = None
        if not (settings.langsmith_tracing and settings.langsmith_api_key):
            return
        try:
            from langsmith import Client

            self._client = Client(api_url=settings.langsmith_endpoint, api_key=settings.langsmith_api_key)
        except Exception as exc:  # noqa: BLE001
            logger.warning("LangSmith is disabled: %s", exc)

    @property
    def enabled(self) -> bool:
        return self._client is not None

    def start_turn(self, req: Any, *, degraded: bool) -> TurnTrace | None:
        if not self._client:
            return None
        run_id = uuid4()
        try:
            inputs: dict[str, Any] = {
                "request_id": req.request_id,
                "message_sha256": _digest(req.message),
                "message_chars": len(req.message),
                "mode": req.mode,
                "stream": req.stream,
                "role": req.context.role,
                "current_tab": req.context.current_tab,
                "history_count": len(req.history),
                "degraded": degraded,
            }
            if settings.langsmith_capture_content:
                inputs["message"] = req.message
            self._client.create_run(
                id=run_id,
                project_name=settings.langsmith_project,
                name="titania_assistant_turn",
                run_type="chain",
                inputs=inputs,
                start_time=datetime.now(timezone.utc),
                tags=["titania", "stream" if req.stream else "non_stream"],
            )
            return TurnTrace(run_id=run_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("LangSmith start trace failed: %s", exc)
            return None

    def finish_turn(self, trace: TurnTrace | None, response: Any) -> None:
        if not (self._client and trace):
            return
        try:
            outputs: dict[str, Any] = {
                "intent": response.intent,
                "confidence": response.confidence,
                "unsupported": response.unsupported,
                "refused": response.refused,
                "answer_sha256": _digest(response.answer),
                "answer_chars": len(response.answer),
                "lane": response.latency.lane,
                "model": response.latency.model,
                "total_ms": response.latency.total_ms,
                "ttft_ms": response.latency.ttft_ms,
            }
            if settings.langsmith_capture_content:
                outputs["answer"] = response.answer
            self._client.update_run(
                trace.run_id,
                outputs=outputs,
                end_time=datetime.now(timezone.utc),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("LangSmith finish trace failed: %s", exc)

    def fail_turn(self, trace: TurnTrace | None, error: Exception) -> None:
        if not (self._client and trace):
            return
        try:
            self._client.update_run(
                trace.run_id,
                error=f"{type(error).__name__}: {str(error)[:500]}",
                end_time=datetime.now(timezone.utc),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("LangSmith error trace failed: %s", exc)

    def close(self) -> None:
        if not self._client:
            return
        try:
            self._client.close(timeout=2)
        except Exception as exc:  # noqa: BLE001
            logger.warning("LangSmith shutdown failed: %s", exc)


observer = LangSmithObserver()
