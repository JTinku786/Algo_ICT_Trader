"""Configuration for the broker-truth sync.

Deliberately NOT named ``config.py``: ``realtime_execution`` and
``Updated_Notebook`` each ship their own ``config`` module. A same-named
module here wins in ``sys.modules`` and every broker import that does
``from config import TABLES`` then fails.

The broker login code (Angel One SmartConnect, Dhan REST, Groww SDK) lives in
``ICT_Automation/realtime_execution``. This module locates that tree, puts it on
``sys.path`` so the adapters can reuse it, and resolves the Postgres connection
and the list of accounts to sync.

Nothing here reads a secret directly; secrets stay in the broker config modules
and the ignored ``.env`` files they already use.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


PROJECT_ROOT = Path(__file__).resolve().parents[2]
INDIA_TZ = ZoneInfo("Asia/Kolkata")

# Datasets the sync knows how to pull. Order matters: orders and trades are
# fetched before positions so a position row can be corroborated by its fills.
LOGGER = logging.getLogger("broker_sync.config")

DATASETS = ("orders", "trades", "positions", "funds", "ledger")

# Datasets whose failure degrades the run rather than failing it. Only Dhan
# publishes a ledger at all, and it is supporting detail for charges -- losing it
# must not mask, or be mistaken for, a failure to capture the day's trading.
OPTIONAL_DATASETS = ("ledger",)

# How far back a ledger / trade-history backfill will reach on a first run
# (no watermark yet). Brokers cap these windows anyway.
DEFAULT_BACKFILL_DAYS = int(os.getenv("BROKER_SYNC_BACKFILL_DAYS", "90"))

# Maximum window a single range request will ask for. Dhan rejects very wide
# ranges; chunking keeps every request inside the documented limits.
RANGE_CHUNK_DAYS = int(os.getenv("BROKER_SYNC_RANGE_CHUNK_DAYS", "30"))


def _candidate_automation_roots() -> list[Path]:
    explicit = os.getenv("ICT_AUTOMATION_ROOT")
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit))
    candidates += [
        PROJECT_ROOT.parent / "ICT_Automation",
        Path(r"C:\Users\saite\Desktop\ICT_Automation"),
        Path("/mnt/c/Users/saite/Desktop/ICT_Automation"),
        Path.home() / "Desktop" / "ICT_Automation",
        Path.home() / "mnt" / "ICT_Automation",
    ]
    return candidates


def find_automation_root() -> Path:
    for candidate in _candidate_automation_roots():
        try:
            if (candidate / "realtime_execution" / "config.py").exists():
                return candidate.resolve()
        except OSError:
            continue
    raise RuntimeError(
        "Could not locate ICT_Automation. Set ICT_AUTOMATION_ROOT to the folder "
        "that contains realtime_execution/config.py."
    )


_paths_ready = False


def ensure_automation_on_path() -> Path:
    """Put ICT_Automation and realtime_execution on sys.path exactly once."""
    global _paths_ready
    root = find_automation_root()
    if not _paths_ready:
        # Inserted in reverse so the final order is realtime_execution, root,
        # Updated_Notebook -- the same precedence realtime_execution/config.py
        # sets up for itself. Updated_Notebook also ships a config.py and a
        # db.py, and picking those up first breaks the broker modules.
        for entry in (root / "Updated_Notebook", root, root / "realtime_execution"):
            entry_text = str(entry)
            if entry_text in sys.path:
                sys.path.remove(entry_text)
            sys.path.insert(0, entry_text)
        _paths_ready = True
    return root


def db_config() -> dict[str, Any]:
    """Postgres connection kwargs.

    Accepts either the pipeline's PG* variables or the website's POSTGRES_*
    variables so the sync works from cron and from the REST API process.
    """
    host = os.getenv("PGHOST") or os.getenv("POSTGRES_HOST") or "172.26.224.1"
    cfg: dict[str, Any] = {
        "dbname": os.getenv("PGDATABASE") or os.getenv("POSTGRES_DATABASE") or "titania_trading",
        "user": os.getenv("PGUSER") or os.getenv("POSTGRES_USER") or "postgres",
        "password": os.getenv("PGPASSWORD") or os.getenv("POSTGRES_PASSWORD") or "",
        "host": host,
        "port": int(os.getenv("PGPORT") or os.getenv("POSTGRES_PORT") or "5432"),
    }
    sslmode = os.getenv("PGSSLMODE") or os.getenv("POSTGRES_SSLMODE")
    if sslmode:
        cfg["sslmode"] = sslmode
    return cfg


@dataclass(frozen=True)
class AccountSpec:
    """One broker account to sync."""

    broker: str
    broker_account: str
    broker_client_id: str
    customer_key: str
    display_name: str
    environment: str = "live"
    enabled: bool = True
    datasets: tuple[str, ...] = DATASETS
    strategies: tuple[str, ...] = ()
    risk_config: dict[str, Any] = field(default_factory=dict)

    @property
    def key(self) -> str:
        return f"{self.broker}:{self.broker_account}"


def _angel_spec() -> AccountSpec | None:
    try:
        ensure_automation_on_path()
        import angel_one_order_execution as angel  # type: ignore
    except Exception as exc:  # noqa: BLE001
        # Never silent: a broker missing from the sync used to look exactly like
        # a broker with no account configured.
        LOGGER.warning("Angel One account not configured (%s: %s)", type(exc).__name__, exc)
        return None
    client_code = str(getattr(angel, "CLIENT_CODE", "") or "").strip()
    if not client_code:
        return None
    return AccountSpec(
        broker="angel_one",
        broker_account=os.getenv("ANGEL_ACCOUNT_LABEL", client_code),
        broker_client_id=client_code,
        customer_key=os.getenv("ANGEL_CUSTOMER_KEY", "titania_house_angel_one"),
        display_name=os.getenv("ANGEL_CLIENT_NAME", "Titania House Account"),
        strategies=tuple(os.getenv("ANGEL_STRATEGIES", "S03,S16,S-CH08,S-CH10").split(",")),
        risk_config={"max_daily_loss_inr": float(getattr(angel, "MAX_DAILY_LOSS_INR", 0) or 0)},
    )


def _groww_spec() -> AccountSpec | None:
    try:
        ensure_automation_on_path()
        import groww_config as groww  # type: ignore
    except Exception as exc:  # noqa: BLE001
        # Never silent: a broker missing from the sync used to look exactly like
        # a broker with no account configured.
        LOGGER.warning("Groww account not configured (%s: %s)", type(exc).__name__, exc)
        return None
    label = str(getattr(groww, "BROKER_ACCOUNT", "") or "").strip()
    if not label:
        return None
    return AccountSpec(
        broker="groww",
        broker_account=label,
        broker_client_id=label,
        customer_key=os.getenv("GROWW_CUSTOMER_KEY", "naveen"),
        display_name=str(getattr(groww, "CLIENT_NAME", "Naveen")),
        strategies=tuple(getattr(groww, "GROWW_LIVE_STRATEGIES", ()) or ()),
        risk_config={
            "current_capital_inr": float(getattr(groww, "CURRENT_CAPITAL_INR", 0) or 0),
            "max_daily_loss_inr": float(getattr(groww, "MAX_DAILY_LOSS_INR", 0) or 0),
            "max_signals_per_day": int(getattr(groww, "MAX_SIGNALS_PER_DAY", 0) or 0),
            "trailing_start_pct": float(getattr(groww, "TRAILING_START_PCT", 0) or 0),
            "trailing_drawdown_pct": float(getattr(groww, "TRAILING_DRAWDOWN_PCT", 0) or 0),
            "immediate_profit_exit_pct": float(getattr(groww, "IMMEDIATE_PROFIT_EXIT_PCT", 0) or 0),
        },
    )


def _dhan_spec() -> AccountSpec | None:
    try:
        ensure_automation_on_path()
        import dhan_config as dhan  # type: ignore
    except Exception as exc:  # noqa: BLE001
        # Never silent: a broker missing from the sync used to look exactly like
        # a broker with no account configured.
        LOGGER.warning("Dhan account not configured (%s: %s)", type(exc).__name__, exc)
        return None
    label = str(getattr(dhan, "BROKER_ACCOUNT", "") or "").strip()
    client_id = str(getattr(dhan, "CLIENT_ID", "") or "").strip()
    if not label:
        return None
    return AccountSpec(
        broker="dhan",
        broker_account=label,
        broker_client_id=client_id or label,
        customer_key=str(getattr(dhan, "CUSTOMER_KEY", "nishitha_mukka")),
        display_name=str(getattr(dhan, "CLIENT_NAME", "Nishitha Mukka")),
        environment=str(getattr(dhan, "ENVIRONMENT", "live")),
        strategies=tuple(getattr(dhan, "LIVE_STRATEGIES", ()) or ()),
        risk_config={
            "max_daily_loss_inr": float(getattr(dhan, "MAX_DAILY_LOSS_INR", 0) or 0),
            "max_signals_per_day": int(getattr(dhan, "MAX_SIGNALS_PER_DAY", 0) or 0),
            "trailing_start_pct": float(getattr(dhan, "TRAILING_START_PCT", 0) or 0),
            "trailing_drawdown_pct": float(getattr(dhan, "TRAILING_DRAWDOWN_PCT", 0) or 0),
            "immediate_profit_exit_pct": float(getattr(dhan, "IMMEDIATE_PROFIT_EXIT_PCT", 0) or 0),
        },
    )


_BUILDERS = {"angel_one": _angel_spec, "groww": _groww_spec, "dhan": _dhan_spec}

OVERRIDES_PATH = Path(
    os.getenv("BROKER_SYNC_ACCOUNTS_FILE", str(Path(__file__).resolve().parent / "accounts.local.json"))
)


def _apply_overrides(specs: list[AccountSpec]) -> list[AccountSpec]:
    """Merge accounts.local.json on top of the discovered accounts.

    The file is optional and gitignored. Use it to disable an account, rename a
    label, or register a second account for a broker without touching code:

        {"angel_one:J95213": {"enabled": false},
         "groww:Titania_ICT_Algo": {"display_name": "Naveen"}}
    """
    if not OVERRIDES_PATH.exists():
        return specs
    try:
        overrides = json.loads(OVERRIDES_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return specs
    if not isinstance(overrides, dict):
        return specs

    by_key = {spec.key: spec for spec in specs}
    for key, patch in overrides.items():
        if not isinstance(patch, dict):
            continue
        base = by_key.get(key)
        if base is None:
            broker, _, account = str(key).partition(":")
            if not broker or not account:
                continue
            base = AccountSpec(
                broker=broker,
                broker_account=account,
                broker_client_id=str(patch.get("broker_client_id") or account),
                customer_key=str(patch.get("customer_key") or account.lower()),
                display_name=str(patch.get("display_name") or account),
            )
        values = {
            "broker": base.broker,
            "broker_account": patch.get("broker_account", base.broker_account),
            "broker_client_id": patch.get("broker_client_id", base.broker_client_id),
            "customer_key": patch.get("customer_key", base.customer_key),
            "display_name": patch.get("display_name", base.display_name),
            "environment": patch.get("environment", base.environment),
            "enabled": bool(patch.get("enabled", base.enabled)),
            "datasets": tuple(patch.get("datasets", base.datasets)),
            "strategies": tuple(patch.get("strategies", base.strategies)),
            "risk_config": patch.get("risk_config", base.risk_config),
        }
        by_key[f"{values['broker']}:{values['broker_account']}"] = AccountSpec(**values)  # type: ignore[arg-type]
    return list(by_key.values())


def load_accounts(brokers: tuple[str, ...] | None = None) -> list[AccountSpec]:
    """Discover every configured broker account, newest overrides applied."""
    specs: list[AccountSpec] = []
    for name, builder in _BUILDERS.items():
        if brokers and name not in brokers:
            continue
        spec = builder()
        if spec is not None:
            specs.append(spec)
    specs = _apply_overrides(specs)
    if brokers:
        specs = [spec for spec in specs if spec.broker in brokers]
    return [spec for spec in specs if spec.enabled]
