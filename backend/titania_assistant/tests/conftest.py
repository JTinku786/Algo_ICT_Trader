"""Keep unit tests offline and deterministic even when local tracing is enabled."""
import os

os.environ["LANGSMITH_TRACING"] = "false"
