"""Per-broker adapters for the broker-truth sync."""

from __future__ import annotations

from sync_config import AccountSpec

from .base import BrokerAdapter, BrokerUnavailable


def build_adapter(spec: AccountSpec) -> BrokerAdapter:
    """Return the adapter that knows how to talk to ``spec``'s broker."""
    if spec.broker == "angel_one":
        from .angel_one import AngelOneAdapter

        return AngelOneAdapter(spec)
    if spec.broker == "dhan":
        from .dhan import DhanAdapter

        return DhanAdapter(spec)
    if spec.broker == "groww":
        from .groww import GrowwAdapter

        return GrowwAdapter(spec)
    raise BrokerUnavailable(f"No adapter for broker {spec.broker!r}")


__all__ = ["BrokerAdapter", "BrokerUnavailable", "build_adapter"]
