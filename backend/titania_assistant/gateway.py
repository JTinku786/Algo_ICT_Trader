"""Model gateway: OpenRouter cloud lane (default) + Ollama local lane, with fallback,
streaming, latency telemetry (TTFT / TTFT-final), timeouts, and low-randomness defaults.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import AsyncIterator, Optional

import httpx

from .config import settings


logger = logging.getLogger(__name__)


@dataclass
class GenerationResult:
    text: str
    lane: str = ""
    model: str = ""
    ttft_ms: float = 0.0
    generation_ms: float = 0.0
    error: Optional[str] = None
    chunks: list[str] = field(default_factory=list)


class ModelGateway:
    """Single entry point for all inference. Routes by lane config with auto-fallback."""

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(settings.model_timeout_s, connect=5.0))

    async def aclose(self) -> None:
        await self._client.aclose()

    # ------------------------------------------------------------- public --

    async def complete(
        self,
        system: str,
        messages: list[dict],
        *,
        max_tokens: Optional[int] = None,
        json_mode: bool = False,
    ) -> GenerationResult:
        """Non-streaming completion (used by classifier and validation paths)."""
        chunks: list[str] = []
        result = GenerationResult(text="")
        async for part in self.stream(system, messages, max_tokens=max_tokens, json_mode=json_mode, _result=result):
            chunks.append(part)
        result.text = "".join(chunks)
        return result

    async def stream(
        self,
        system: str,
        messages: list[dict],
        *,
        max_tokens: Optional[int] = None,
        json_mode: bool = False,
        _result: Optional[GenerationResult] = None,
    ) -> AsyncIterator[str]:
        """Streaming generation. Yields text deltas; records telemetry on _result."""
        result = _result or GenerationResult(text="")
        max_tokens = max_tokens or settings.max_output_tokens
        lanes = self._lane_order()
        last_error = None
        for lane in lanes:
            try:
                start = time.perf_counter()
                first = True
                if lane == "openrouter":
                    agen = self._stream_openrouter(system, messages, max_tokens, json_mode)
                else:
                    agen = self._stream_ollama(system, messages, max_tokens, json_mode)
                async for delta in agen:
                    if first:
                        result.ttft_ms = (time.perf_counter() - start) * 1000
                        result.lane = lane
                        result.model = settings.openrouter_model if lane == "openrouter" else settings.ollama_model
                        first = False
                    yield delta
                result.generation_ms = (time.perf_counter() - start) * 1000
                return
            except Exception as exc:  # noqa: BLE001 — lane fallback by design
                last_error = f"{lane}: {exc}"
                # Provider diagnostics are retained in server logs/audits only;
                # customer-facing replies continue through output guardrails.
                logger.warning("Titania model lane failed: %s", last_error)
                continue
        result.error = last_error or "no_lane_available"

    # ------------------------------------------------------------- lanes --

    def _lane_order(self) -> list[str]:
        lane = settings.model_lane
        if lane == "openrouter":
            return ["openrouter"]
        if lane == "ollama":
            return ["ollama"]
        order = []
        if settings.openrouter_api_key:
            order.append("openrouter")
        order.append("ollama")
        return order

    async def _stream_openrouter(
        self, system: str, messages: list[dict], max_tokens: int, json_mode: bool
    ) -> AsyncIterator[str]:
        if not settings.openrouter_api_key:
            raise RuntimeError("OPENROUTER_API_KEY not set")
        if not settings.openrouter_model:
            raise RuntimeError("OPENROUTER_MODEL not set")
        payload = {
            "model": settings.openrouter_model,
            "messages": [{"role": "system", "content": system}, *messages],
            "temperature": settings.temperature,
            "max_tokens": max_tokens,
            "stream": True,
            "reasoning": {"enabled": settings.openrouter_reasoning_enabled},
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        headers = {
            "Authorization": f"Bearer {settings.openrouter_api_key}",
            "HTTP-Referer": settings.platform_base_url,
            "X-Title": "Titania Assistant",
        }
        async with self._client.stream(
            "POST", f"{settings.openrouter_base_url}/chat/completions", json=payload, headers=headers
        ) as resp:
            if resp.is_error:
                # httpx's default error text omits OpenRouter's provider/privacy
                # policy explanation. Keep it bounded and internal.
                detail = (await resp.aread()).decode("utf-8", errors="replace").replace("\n", " ")[:500]
                raise RuntimeError(f"OpenRouter HTTP {resp.status_code}: {detail}")
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = line[6:]
                if data == "[DONE]":
                    break
                try:
                    delta = json.loads(data)["choices"][0]["delta"].get("content") or ""
                except (KeyError, IndexError, json.JSONDecodeError):
                    continue
                if delta:
                    yield delta

    async def _stream_ollama(
        self, system: str, messages: list[dict], max_tokens: int, json_mode: bool
    ) -> AsyncIterator[str]:
        payload = {
            "model": settings.ollama_model,
            "messages": [{"role": "system", "content": system}, *messages],
            "stream": True,
            "think": settings.ollama_thinking_enabled,
            "options": {"temperature": settings.temperature, "num_predict": max_tokens},
        }
        if json_mode:
            payload["format"] = "json"
        async with self._client.stream("POST", f"{settings.ollama_base_url}/api/chat", json=payload) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.strip():
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("done"):
                    break
                delta = (obj.get("message") or {}).get("content") or ""
                if delta:
                    yield delta


gateway = ModelGateway()
