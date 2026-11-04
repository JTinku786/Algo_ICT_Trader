"""Undo the premature IGS02 relabel in the app.

The DB was reverted: the London sweep-reversal strategy is IGS01V2 again, and
IGS02_Manipulation_MSS_IFVG is now a genuinely different 2m strategy with its
own rows. Leaving the app on IGS02 would (a) mislabel live OANDA sweep-reversal
signals as IGS02 on the Realtime tab and (b) drop the exclusion that keeps the
superseded 552 old-engine rows out of the Backtest population.
"""
import io, os, re

ROOT = r"C:\Users\saite\OneDrive\Documents\Algo_ICT_Trader"
FILES = [
    r"src\lib\realtime-rows-sql.ts", r"src\lib\strategy-status.ts",
    r"src\app\data\strategy-blogs.ts", r"src\app\components\realtime-orders-dashboard.tsx",
    r"src\app\components\backtest-dashboard.tsx", r"src\app\api\realtime-analytics\route.ts",
    r"src\app\api\realtime-analytics\order-chart\route.ts", r"src\app\api\backtest\route.ts",
    r"backend\rest_api.py",
]
RULES = [
    ("IGS02_Manipulation_MSS_IFVG", "IGS01V2_LondonLiqGrab_SweepReversal"),
    ("IGS02_LIVE_STRATEGY_ID", "IGS01V2_LIVE_STRATEGY_ID"),
    ("IGS02_STRATEGY_ID", "IGS01V2_STRATEGY_ID"),
    ('"IGS02 \u00b7 Manipulation \u2192 MSS \u2192 IFVG"', '"IGS01V2 \u00b7 London Sweep Reversal"'),
    ("IGS02_MANIPULATION_MSS_IFVG", "IGS01V2_LONDONLIQGRAB_SWEEPREVERSAL"),
    ("'IGS02',", "'IGS01V2',"),
    ('"IGS02",', '"IGS01V2",'),
]
for rel in FILES:
    p = os.path.join(ROOT, rel)
    if not os.path.exists(p):
        print("MISSING", rel); continue
    before = io.open(p, encoding="utf-8").read()
    text = before
    for a, b in RULES:
        text = text.replace(a, b)
    text = re.sub(r"\bIGS02\b", "IGS01V2", text)
    if text != before:
        io.open(p, "w", encoding="utf-8", newline="").write(text)
        print("REVERTED", rel)
    else:
        print("no-op   ", rel)

# The blog alias value must stay pointing at the igs01v2 blog slug.
bp = os.path.join(ROOT, r"src\app\data\strategy-blogs.ts")
b = io.open(bp, encoding="utf-8").read()
b = b.replace('IGS01V2_LONDONLIQGRAB_SWEEPREVERSAL: "IGS01V2_LondonLiqGrab_SweepReversal"',
              'IGS01V2_LONDONLIQGRAB_SWEEPREVERSAL: "IGS01V2"')
io.open(bp, "w", encoding="utf-8", newline="").write(b)

# Register the NEW IGS02 so the backtest row renders with a readable label.
sp = os.path.join(ROOT, r"src\lib\strategy-status.ts")
s = io.open(sp, encoding="utf-8").read()
if "IGS02_Manipulation_MSS_IFVG" not in s:
    s = s.replace(
        '  IGS01V2_LondonLiqGrab_SweepReversal: "IGS01V2 \u00b7 London Sweep Reversal",',
        '  IGS01V2_LondonLiqGrab_SweepReversal: "IGS01V2 \u00b7 London Sweep Reversal",\n'
        '  IGS02_Manipulation_MSS_IFVG: "IGS02 \u00b7 NY Manipulation \u2192 MSS \u2192 FVG",')
    io.open(sp, "w", encoding="utf-8", newline="").write(s)
    print("REGISTERED IGS02 label in strategy-status.ts")

print("\nremaining IGS02 mentions:")
for rel in FILES:
    p = os.path.join(ROOT, rel)
    for i, line in enumerate(io.open(p, encoding="utf-8").read().splitlines(), 1):
        if "IGS02" in line:
            print("  %s:%d  %s" % (rel, i, line.strip()[:100]))
