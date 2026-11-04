"""Titania Assistant configuration. All values env-driven; safe defaults for local dev."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _load_dotenv() -> None:
    """Load ../../.env.local (Next.js env) so Postgres creds are shared without duplication."""
    candidates = [
        Path(__file__).resolve().parents[2] / ".env.local",
        Path(__file__).resolve().parents[1] / ".env",
    ]
    for path in candidates:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            value = value.strip()
            # .env files commonly wrap URLs and secrets in matching quotes.
            # Preserve embedded characters, but remove only the outer pair.
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            os.environ.setdefault(key.strip(), value)


_load_dotenv()


def _env_flag(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


def _env_paths(name: str, defaults: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.getenv(name, "")
    return tuple(p.strip() for p in raw.split(";") if p.strip()) if raw else defaults


@dataclass(frozen=True)
class Settings:
    environment: str = os.getenv("TITANIA_ENV", os.getenv("ENVIRONMENT", "development")).lower()
    assistant_shared_secret: str = os.getenv("TITANIA_ASSISTANT_SHARED_SECRET", "")
    # --- model lanes ---
    openrouter_api_key: str = os.getenv("OPENROUTER_API_KEY", "")
    openrouter_base_url: str = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    # Set this to a model that has been smoke-tested with this OpenRouter account.
    # An empty value avoids masking provider configuration failures with a stale default.
    # OPENROUTER_MODEL is the provider-neutral operational name. The Titania
    # names remain supported for existing deployments.
    openrouter_model: str = os.getenv("OPENROUTER_MODEL", os.getenv("TITANIA_CLOUD_MODEL", ""))
    openrouter_model_premium: str = os.getenv(
        "OPENROUTER_MODEL_PREMIUM", os.getenv("TITANIA_CLOUD_MODEL_PREMIUM", "")
    )
    ollama_base_url: str = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
    ollama_model: str = os.getenv("TITANIA_LOCAL_MODEL", "gemma3:12b")
    ollama_thinking_enabled: bool = _env_flag("TITANIA_OLLAMA_THINKING", False)
    # OpenRouter is the permanent default. Ollama is opt-in; cloud failures
    # must never silently turn into a local-model response.
    model_lane: str = os.getenv("TITANIA_MODEL_LANE", "openrouter")
    openrouter_reasoning_enabled: bool = _env_flag("TITANIA_OPENROUTER_REASONING", False)

    # --- observability (optional, privacy-preserving by default) ---
    langsmith_tracing: bool = _env_flag("LANGSMITH_TRACING", False)
    langsmith_endpoint: str = os.getenv("LANGSMITH_ENDPOINT", "https://api.smith.langchain.com")
    langsmith_api_key: str = os.getenv("LANGSMITH_API_KEY", "")
    langsmith_project: str = os.getenv("LANGSMITH_PROJECT", "ICT_ALGO_TRADER")
    langsmith_capture_content: bool = _env_flag("LANGSMITH_CAPTURE_CONTENT", False)

    # --- generation discipline (low-randomness, recommendation-grade) ---
    temperature: float = float(os.getenv("TITANIA_TEMPERATURE", "0.1"))
    max_output_tokens: int = int(os.getenv("TITANIA_MAX_OUTPUT_TOKENS", "320"))
    max_output_tokens_degraded: int = int(os.getenv("TITANIA_MAX_OUTPUT_TOKENS_DEGRADED", "250"))

    # --- guardrail budgets ---
    max_input_chars: int = int(os.getenv("TITANIA_MAX_INPUT_CHARS", "4000"))
    max_context_chars: int = int(os.getenv("TITANIA_MAX_CONTEXT_CHARS", "12000"))
    max_tool_calls: int = int(os.getenv("TITANIA_MAX_TOOL_CALLS", "3"))
    tool_timeout_s: float = float(os.getenv("TITANIA_TOOL_TIMEOUT_S", "4"))
    internet_context_enabled: bool = _env_flag("TITANIA_INTERNET_CONTEXT_ENABLED", True)
    internet_timeout_s: float = float(os.getenv("TITANIA_INTERNET_TIMEOUT_S", "6"))

    # --- approved-document RAG ---
    rag_enabled: bool = _env_flag("TITANIA_RAG_ENABLED", True)
    rag_db_path: str = os.getenv(
        "TITANIA_RAG_DB_PATH", str(Path(__file__).resolve().parent / "data" / "titania_rag_v2.db")
    )
    rag_roots: tuple[str, ...] = _env_paths(
        "TITANIA_RAG_ROOTS",
        (
            r"C:\Users\saite\OneDrive\Documents\ICT_DataScience",
            r"C:\Users\saite\Desktop\ICT_Automation",
            r"C:\Users\saite\Downloads",
        ),
    )
    rag_top_k: int = int(os.getenv("TITANIA_RAG_TOP_K", "4"))
    rag_max_files: int = int(os.getenv("TITANIA_RAG_MAX_FILES", "5000"))
    rag_download_keywords: tuple[str, ...] = tuple(
        keyword.strip().lower()
        for keyword in os.getenv(
            "TITANIA_RAG_DOWNLOAD_KEYWORDS",
            "ict,smc,strategy,trading,fvg,order block,liquidity,market structure",
        ).split(",")
        if keyword.strip()
    )
    model_timeout_s: float = float(os.getenv("TITANIA_MODEL_TIMEOUT_S", "45"))
    confidence_threshold: float = float(os.getenv("TITANIA_CONFIDENCE_THRESHOLD", "0.7"))
    max_signal_age_minutes: int = int(os.getenv("TITANIA_MAX_SIGNAL_AGE_MINUTES", "60"))
    min_recommendation_score: float = float(os.getenv("TITANIA_MIN_RECOMMENDATION_SCORE", "0.65"))
    min_backtest_samples: int = int(os.getenv("TITANIA_MIN_BACKTEST_SAMPLES", "30"))

    # --- rate limiting (per user, in-process) ---
    rate_limit_per_minute: int = int(os.getenv("TITANIA_RATE_LIMIT_PER_MIN", "20"))
    # heavy-load degrade: if in-flight requests exceed this, switch to short answers
    degrade_inflight_threshold: int = int(os.getenv("TITANIA_DEGRADE_INFLIGHT", "8"))

    # --- data sources (read-only, allowlisted Next.js APIs) ---
    platform_base_url: str = os.getenv("TITANIA_PLATFORM_BASE_URL", "http://localhost:3000")
    allowed_api_paths: tuple[str, ...] = (
        "/api/realtime-analytics",
        "/api/backtest",
        "/api/ml-insights",
        "/api/live",
        "/api/historical-ict",
    )

    # --- logging store ---
    database_url: str = os.getenv("DATABASE_URL", os.getenv("POSTGRES_URL", ""))
    postgres_host: str = os.getenv("POSTGRES_HOST", "")
    postgres_port: str = os.getenv("POSTGRES_PORT", "5432")
    postgres_database: str = os.getenv("POSTGRES_DATABASE", "")
    postgres_user: str = os.getenv("POSTGRES_USER", "")
    postgres_password: str = os.getenv("POSTGRES_PASSWORD", "")
    postgres_sslmode: str = os.getenv("POSTGRES_SSLMODE", "")
    sqlite_fallback_path: str = os.getenv(
        "TITANIA_SQLITE_PATH",
        str(Path(__file__).resolve().parent / "titania_assistant_logs.db"),
    )

    # --- server ---
    host: str = os.getenv("TITANIA_HOST", "127.0.0.1")
    port: int = int(os.getenv("TITANIA_PORT", "8100"))
    cors_origins: tuple[str, ...] = tuple(
        o.strip() for o in os.getenv("TITANIA_CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()
    )

    unsupported_message: str = "not available in current Titania sources."
    disclaimer: str = (
        "This is for educational purpose only. AI can generate wrong answers. "
        "Get advice from financial advisor."
    )

    def postgres_dsn(self) -> str:
        if self.database_url:
            return self.database_url
        if self.postgres_host and self.postgres_database and self.postgres_user:
            ssl = f"?sslmode={self.postgres_sslmode}" if self.postgres_sslmode else ""
            return (
                f"postgresql://{self.postgres_user}:{self.postgres_password}"
                f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_database}{ssl}"
            )
        return ""

    @property
    def require_signed_bff_request(self) -> bool:
        """Production accepts assistant turns only from the authenticated Next.js BFF."""
        return self.environment in {"production", "prod"}


settings = Settings()
