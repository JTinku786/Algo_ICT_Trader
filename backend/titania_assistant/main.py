"""Titania Assistant API — FastAPI app.

Run:  uvicorn backend.titania_assistant.main:app --port 8100
  or: python -m backend.titania_assistant.main
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from datetime import datetime, timezone
from collections import defaultdict, deque
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .config import settings
from .gateway import gateway
from .graph import run_turn, run_turn_streaming
from .logging_store import store
from .observability import observer
from .schemas import ChatRequest, ChatResponse

app = FastAPI(title="Titania Assistant", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# --- operational guardrails: per-user rate limit + load-degrade -------------
_hits: dict[str, deque] = defaultdict(deque)
_inflight = 0


def _rate_limited(user_id: str) -> bool:
    now = time.monotonic()
    q = _hits[user_id]
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= settings.rate_limit_per_minute:
        return True
    q.append(now)
    return False


def _verify_bff_signature(request: Request, raw_body: bytes) -> None:
    """Production turns must be issued by the Next.js BFF, not a browser client."""
    if not settings.require_signed_bff_request:
        return
    if not settings.assistant_shared_secret:
        raise HTTPException(503, "Assistant service signing is not configured.")
    timestamp = request.headers.get("x-titania-timestamp", "")
    signature = request.headers.get("x-titania-signature", "")
    try:
        age = abs((datetime.now(timezone.utc).timestamp()) - float(timestamp))
    except ValueError:
        age = 10_000
    payload = timestamp.encode() + b"." + raw_body
    expected = hmac.new(settings.assistant_shared_secret.encode(), payload, hashlib.sha256).hexdigest()
    if age > 300 or not signature or not hmac.compare_digest(signature, expected):
        raise HTTPException(403, "Assistant request is not authorized.")


@app.get("/assistant/health")
async def health() -> dict:
    return {
        "status": "ok",
        "log_backend": store.backend,
        "lanes": {
            "openrouter_key_configured": bool(settings.openrouter_api_key),
            "openrouter_model_configured": bool(settings.openrouter_model),
        },
        "model_lane": settings.model_lane,
        "langsmith": {
            "tracing_enabled": observer.enabled,
            "project": settings.langsmith_project if observer.enabled else None,
            "capture_content": settings.langsmith_capture_content if observer.enabled else False,
        },
        "inflight": _inflight,
    }


@app.post("/assistant/chat", response_model=ChatResponse)
async def chat(req: ChatRequest, request: Request):
    global _inflight
    _verify_bff_signature(request, await request.body())
    req = req.model_copy(update={"request_id": req.request_id or str(uuid4())})
    if _rate_limited(req.context.user_id):
        raise HTTPException(429, "Rate limit exceeded. Please slow down.")
    degraded = _inflight >= settings.degrade_inflight_threshold

    if not req.stream:
        _inflight += 1
        trace = observer.start_turn(req, degraded=degraded)
        try:
            response = await run_turn(req, degraded=degraded)
            observer.finish_turn(trace, response)
            return response
        except Exception as exc:
            observer.fail_turn(trace, exc)
            raise
        finally:
            _inflight -= 1

    async def sse():
        global _inflight
        _inflight += 1
        trace = observer.start_turn(req, degraded=degraded)
        try:
            async for event in run_turn_streaming(req, degraded=degraded):
                if event.get("type") == "final" and event.get("response"):
                    observer.finish_turn(trace, ChatResponse.model_validate(event["response"]))
                yield f"data: {json.dumps(event)}\n\n"
                if await request.is_disconnected():
                    break
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — surface as SSE error event
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)[:300]})}\n\n"
        finally:
            _inflight -= 1
        yield "data: [DONE]\n\n"

    return StreamingResponse(sse(), media_type="text/event-stream")


@app.post("/assistant/v1/chat", response_model=ChatResponse)
async def chat_v1(req: ChatRequest, request: Request):
    """Versioned alias retained alongside the original endpoint for compatibility."""
    return await chat(req, request)


@app.on_event("shutdown")
async def shutdown() -> None:
    await gateway.aclose()
    observer.close()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port)
