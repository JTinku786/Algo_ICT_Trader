"""Allowlisted, read-only external context for current market questions.

This is deliberately not arbitrary browser access. It fetches a fixed market
news query, bounds the result, and passes it to the model as untrusted text.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from urllib.parse import urlencode

import httpx

from .config import settings

_ASIA_MARKET_RE = re.compile(
    r"\b(?:asia|asian|nikkei|hang\s*seng|shanghai|kospi|japan|china|hong\s*kong)\b"
    r".*\b(?:market|markets|today|open|close|news)\b|"
    r"\b(?:market|markets)\b.*\b(?:asia|asian|nikkei|hang\s*seng|shanghai|kospi|japan|china|hong\s*kong)\b",
    re.IGNORECASE,
)


def wants_asia_market_context(message: str) -> bool:
    return bool(_ASIA_MARKET_RE.search(message))


async def fetch_asia_market_headlines() -> list[dict[str, str]]:
    """Fetch up to three current Asia-market headlines from Google News RSS."""
    if not settings.internet_context_enabled:
        return []
    query = urlencode({"q": "Asian markets when:1d", "hl": "en-US", "gl": "US", "ceid": "US:en"})
    url = f"https://news.google.com/rss/search?{query}"
    headers = {"User-Agent": "TitaniaAssistant/1.0 (+market-context)"}
    try:
        async with httpx.AsyncClient(timeout=settings.internet_timeout_s, follow_redirects=True) as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
        root = ET.fromstring(response.content)
        items: list[dict[str, str]] = []
        for item in root.findall("./channel/item")[:3]:
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            published = (item.findtext("pubDate") or "").strip()
            source = (item.findtext("source") or "").strip()
            if title:
                items.append({"title": title[:280], "source": source[:100], "published": published[:80], "url": link})
        return items
    except (httpx.HTTPError, ET.ParseError):
        return []
