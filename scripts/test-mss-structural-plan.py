"""Causal structural target/stop checks; run with python scripts/test-mss-structural-plan.py."""
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("mss", Path(__file__).with_name("market-structure-shift.py"))
mss = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mss)
bars = [dict(t=10, l=98, h=105, c=101, day="2026-01-01"), dict(t=20, l=100, h=103, c=102, day="2026-01-01")]
def zone(kind, price, known=1, retired=None):
    return dict(id=kind+str(price), kind=kind, tf="5m", low=price, high=price, knownAt=known, origin=0, retiredAt=retired, status="SWEPT", lastTouch=999)
def plan(direction, zones):
    return mss.structural_plan(dict(at=30, price=102, candle=dict(day="2026-01-01")), dict(direction=direction, at=20), dict(t=10), bars, zones, [])
p = plan("BUY", [zone("SSL",99), zone("BSL",110), zone("BSL",112), zone("BSL",104,40), zone("BSL",103,1,25)])
assert p["state"] == "READY" and p["stop"] == 98 and p["target"] == 110 and p["rr"] == 2
assert "status" not in p["targetSource"] and "lastTouch" not in p["targetSource"]
assert [z["low"] for z in p["targetCandidates"]] == [110, 112]
assert all("status" not in z and z["knownAt"] <= 30 for z in p["targetCandidates"])
p = plan("SELL", [zone("BSL",104), zone("SSL",96)])
assert p["state"] == "READY" and p["stop"] == 105 and p["target"] == 96 and p["rr"] == 2
assert plan("BUY", [zone("BSL",110)])["state"] == "NO_CONFIRMED_SWEEP"
assert plan("BUY", [zone("SSL",99)])["state"] == "NO_TARGET"
print("PASS: structural plans, causal targets, source-only provenance, unavailable plans")
