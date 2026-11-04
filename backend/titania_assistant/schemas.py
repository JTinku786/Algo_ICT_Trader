"""Pydantic schemas: approved context envelope in, validated structured answer out."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

Role = Literal["external", "internal", "support"]
Mode = Literal["standard", "strict"]


class UserProfile(BaseModel):
    """Personalization features. Only what recommendation ranking needs — least privilege."""
    account_size: Optional[float] = None
    risk_tolerance: Optional[Literal["low", "medium", "high"]] = None
    preferred_markets: list[str] = Field(default_factory=list)
    watchlist: list[str] = Field(default_factory=list)
    max_risk_pct: Optional[float] = Field(default=None, ge=0.01, le=5.0)


class ContextEnvelope(BaseModel):
    """The ONLY application state the model may see. Never raw app state."""
    user_id: str = "anonymous"
    role: Role = "external"
    current_tab: Optional[str] = None
    selected_rows: list[dict[str, Any]] = Field(default_factory=list)
    visible_filters: dict[str, Any] = Field(default_factory=dict)
    profile: UserProfile = Field(default_factory=UserProfile)
    # Set only by the server-side context resolver. It allows audit/replay without
    # passing unrestricted app state to the model.
    context_version: str = "titania-context.v1"


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    message: str
    mode: Mode = "standard"
    history: list[ChatMessage] = Field(default_factory=list, max_length=20)
    context: ContextEnvelope = Field(default_factory=ContextEnvelope)
    stream: bool = True
    request_id: Optional[str] = None
    session_id: Optional[str] = Field(default=None, min_length=8, max_length=128)
    session_language: Optional[str] = Field(default=None, min_length=2, max_length=8)


class SourceRef(BaseModel):
    label: str
    kind: Literal["tab_context", "platform_api", "approved_doc", "system", "external_web"]
    detail: str = ""


class LatencyBreakdown(BaseModel):
    classify_ms: float = 0
    context_ms: float = 0
    retrieval_ms: float = 0
    ttft_ms: float = 0
    generation_ms: float = 0
    validation_ms: float = 0
    total_ms: float = 0
    lane: str = ""
    model: str = ""
    degraded: bool = False


class RecommendationCandidate(BaseModel):
    symbol: str
    direction: Literal["BUY", "SELL"]
    strategy_id: Optional[str] = None
    entry: float
    stop_loss: float
    take_profit: float
    risk_r: float
    score: float = Field(ge=0, le=1)
    win_rate: Optional[float] = None
    profit_factor: Optional[float] = None
    sample_size: Optional[int] = None
    as_of: str
    source_label: str


class RecommendationDecision(BaseModel):
    kind: Literal["recommendation", "no_trade"]
    candidates: list[RecommendationCandidate] = Field(default_factory=list, max_length=3)
    reasons: list[str] = Field(default_factory=list, max_length=6)
    account_risk_pct: Optional[float] = None
    risk_amount: Optional[float] = None
    quantity: Optional[int] = None


class ChatResponse(BaseModel):
    request_id: Optional[str] = None
    answer: str
    intent: str = "general"
    confidence: float = 0.0
    is_recommendation: bool = False
    refused: bool = False
    unsupported: bool = False
    disclaimer: Optional[str] = None
    sources: list[SourceRef] = Field(default_factory=list)
    language: str = "en"
    decision: Optional[RecommendationDecision] = None
    latency: LatencyBreakdown = Field(default_factory=LatencyBreakdown)
