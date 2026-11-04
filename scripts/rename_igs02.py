"""One-shot rename IGS01V2_LondonLiqGrab_SweepReversal -> IGS02_Manipulation_MSS_IFVG.

Protected on purpose, do NOT let a blanket replace touch these:
  * lowercase table names  igs01v2_live_signals / _backtest_legs / _features /
    _struct / _backtest_progress  -- the DB tables were deliberately NOT renamed
  * the blog slug "igs01v2" in strategy-blogs.ts -- renaming it breaks blog URLs
Only uppercase IGS01V2 tokens are rewritten, plus the two identifier names.
"""
import io, os, re, sys

ROOT = r"C:\Users\saite\OneDrive\Documents\Algo_ICT_Trader"
OLD_ID = "IGS01V2_LondonLiqGrab_SweepReversal"
NEW_ID = "IGS02_Manipulation_MSS_IFVG"

FILES = [
    r"src\lib\realtime-rows-sql.ts",
    r"src\lib\strategy-status.ts",
    r"src\app\data\strategy-blogs.ts",
    r"src\app\components\realtime-orders-dashboard.tsx",
    r"src\app\components\backtest-dashboard.tsx",
    r"src\app\api\realtime-analytics\route.ts",
    r"src\app\api\realtime-analytics\order-chart\route.ts",
    r"src\app\api\backtest\route.ts",
    r"backend\rest_api.py",
]

# Applied in order. (pattern, replacement, is_regex)
COMMON = [
    (OLD_ID, NEW_ID, False),
    ("IGS01V2_LIVE_STRATEGY_ID", "IGS02_LIVE_STRATEGY_ID", False),
    ("IGS01V2_STRATEGY_ID", "IGS02_STRATEGY_ID", False),
]

PER_FILE = {
    # Keep the blog slug: only the alias KEY moves to the new id.
    r"src\app\data\strategy-blogs.ts": [
        ('IGS01V2_LONDONLIQGRAB_SWEEPREVERSAL: "IGS01V2",',
         'IGS02_MANIPULATION_MSS_IFVG: "IGS01V2",  // blog slug stays igs01v2',
         False),
    ],
    r"src\lib\strategy-status.ts": [
        ('"IGS01V2 \u00b7 London Sweep Reversal"',
         '"IGS02 \u00b7 Manipulation \u2192 MSS \u2192 IFVG"', False),
    ],
    r"src\lib\realtime-rows-sql.ts": [
        # strategy_key is a short code, not a table name.
        ("'IGS01V2',", "'IGS02',", False),
    ],
    r"backend\rest_api.py": [
        ("'IGS01V2',", "'IGS02',", False),
        ('"IGS01V2",', '"IGS02",', False),
    ],
}

# Anything still saying IGS01V2 in UPPERCASE after the rules above is prose in a
# comment. Rewrite it, but never the lowercase table names or the blog slug.
TAIL = [(r"\bIGS01V2\b", "IGS02", True)]

changed, report = [], []
for rel in FILES:
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        report.append("MISSING  " + rel)
        continue
    with io.open(path, encoding="utf-8") as fh:
        before = fh.read()
    text = before
    for pat, rep, is_re in COMMON + PER_FILE.get(rel, []) + TAIL:
        text = re.sub(pat, rep, text) if is_re else text.replace(pat, rep)

    # Guard: the protected lowercase names must survive untouched.
    for guard in ("igs01v2_live_signals", "igs01v2_backtest_legs", "igs01v2_features",
                  "igs01v2_struct", "igs01v2_backtest_progress"):
        if before.count(guard) != text.count(guard):
            print("ABORT: %s changed count of %s" % (rel, guard))
            sys.exit(1)

    if text != before:
        with io.open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        n = len(re.findall(r"IGS01V2|" + re.escape(OLD_ID), before))
        changed.append(rel)
        report.append("PATCHED  %-56s %d refs" % (rel, n))
    else:
        report.append("no-op    " + rel)

print("\n".join(report))
print("\nfiles changed: %d" % len(changed))

# Prove nothing uppercase is left, and the protected names still are.
leftover = []
for rel in FILES:
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        continue
    with io.open(path, encoding="utf-8") as fh:
        body = fh.read()
    for i, line in enumerate(body.splitlines(), 1):
        if "IGS01V2" in line:
            leftover.append("%s:%d  %s" % (rel, i, line.strip()[:110]))
print("\nremaining IGS01V2 mentions (lowercase table/slug refs are expected):")
print("\n".join(leftover) if leftover else "  (none)")
