"""Independent audit of consolidation_engine.py output.

Re-derives every rule from the raw bars with a separate, deliberately plain implementation (no code shared with the
engine except the bar loaders, so both read the same candles) and checks each stored box and trade against it.
Results are printed and saved into consolidation_runs.summary->'validation' so the website can show them.

usage: python validate_consolidation.py [--tf 1d 1h 30m] [--sample 1500]
"""
import json, sys, random, warnings, datetime as dt
import numpy as np, pandas as pd
warnings.filterwarnings("ignore")
import consolidation_engine as ce_mod
rv = ce_mod.rv
import psycopg2

EPS = 1e-6


def args(flag, default):
    if flag not in sys.argv: return default
    out = []
    for a in sys.argv[sys.argv.index(flag) + 1:]:
        if a.startswith("--"): break
        out.append(a)
    return out


def atr20_before(g, i, n=20):
    """plain ATR: mean true range of the n bars ending at bar i (inclusive)"""
    rows = g.iloc[i - n + 1:i + 1]
    prev = g.c.shift(1).iloc[i - n + 1:i + 1]
    tr = pd.concat([rows.h - rows.l, (rows.h - prev).abs(), (rows.l - prev).abs()], axis=1).max(axis=1)
    return tr.mean()


def is_swing_high(g, q):
    return g.h.iat[q] > g.h.iat[q - 1] and g.h.iat[q] >= g.h.iat[q + 1]


def is_swing_low(g, q):
    return g.l.iat[q] < g.l.iat[q - 1] and g.l.iat[q] <= g.l.iat[q + 1]


def replay(g, side, e, entry, stop, tgt, is_limit, max_hold):
    """bar-by-bar exit: stop checked before target; a gap through a level fills at the open; no target on a limit's fill bar"""
    n = len(g)
    for j in range(e, min(e + max_hold, n)):
        o, h, l = g.o.iat[j], g.h.iat[j], g.l.iat[j]
        first = j == e
        if side == "bull":
            if l <= stop: return "loss", (o if (not first and o < stop) else stop), j
            if first and is_limit: continue
            if h >= tgt: return "win", (o if (not first and o > tgt) else tgt), j
        else:
            if h >= stop: return "loss", (o if (not first and o > stop) else stop), j
            if first and is_limit: continue
            if l <= tgt: return "win", (o if (not first and o < tgt) else tgt), j
    j = min(e + max_hold, n) - 1
    return ("open" if e + max_hold > n else "timeout"), g.c.iat[j], j


def main():
    tfs = args("--tf", ["1d", "1h", "30m"])
    sample = int(args("--sample", ["1500"])[0])
    random.seed(7)
    con = psycopg2.connect(rv.db_uri())
    runs = pd.read_sql("SELECT DISTINCT ON (timeframe, config_name) run_id, timeframe, config_name, params, data_start FROM consolidation_runs "
                       "ORDER BY timeframe, config_name, created_at DESC", con)
    for tf in tfs:
        start = pd.Timestamp(str(runs[runs.timeframe == tf].data_start.iloc[0]))
        rv.MARKET = "us"; rv.START = start; rv.LOAD_FROM = str((start - pd.Timedelta(days=550)).date())
        df = rv.load_db(con) if tf == "1d" else rv.load_intraday(con, tf)[0]
        df = rv.clean(df)
        G = {s: g.reset_index(drop=True) for s, g in df.groupby("sym")}
        IDX = {s: {pd.Timestamp(d): i for i, d in enumerate(g.d)} for s, g in G.items()}
        for _, run in runs[runs.timeframe == tf].iterrows():
            P = run.params if isinstance(run.params, dict) else json.loads(run.params)
            hm, minb, recl, maxa, mh = P["h_mult"], P["min_bars"], P["reclaim"], P["max_active"], P["max_hold"]
            B = pd.read_sql("SELECT * FROM consolidation_boxes WHERE run_id=%s", con, params=(run.run_id,))
            T = pd.read_sql("SELECT * FROM consolidation_trades WHERE run_id=%s", con, params=(run.run_id,))
            Bs = B.sample(min(sample, len(B)), random_state=7)
            checks = {k: [0, 0] for k in ["bars>=min", "edges=wick hi/lo", "span<=h_mult*ATR20(pre-box)", "EQH>=2 swings", "EQL>=2 swings",
                                           "confirmed at first qualifying bar", "first event after confirm", "break held reclaim window",
                                           "fate consistent", "time order"]}
            fails = []

            def ok(name, cond, box):
                checks[name][0] += int(bool(cond)); checks[name][1] += 1
                if not cond and len(fails) < 15: fails.append(f"{name}: {box.sym} {box.start_date}")

            for _, b in Bs.iterrows():
                g = G[b.sym]; ix = IDX[b.sym]
                s, j = ix[pd.Timestamp(b.start_date)], ix[pd.Timestamp(b.confirm_date)]
                hi, lo = g.h.iloc[s:j + 1].max(), g.l.iloc[s:j + 1].min()
                H = hi - lo
                ok("bars>=min", j - s + 1 >= minb, b)
                ok("edges=wick hi/lo", abs(hi - b.box_hi) < EPS and abs(lo - b.box_lo) < EPS, b)
                ok("span<=h_mult*ATR20(pre-box)", H <= hm * atr20_before(g, s - 1) + EPS, b)
                eqh = [q for q in range(s, j) if is_swing_high(g, q) and g.h.iat[q] >= hi - 0.2 * H]
                eql = [q for q in range(s, j) if is_swing_low(g, q) and g.l.iat[q] <= lo + 0.2 * H]
                ok("EQH>=2 swings", len(eqh) >= 2, b)
                ok("EQL>=2 swings", len(eql) >= 2, b)
                # the engine confirms at the FIRST bar where all rules hold -> no earlier bar may already satisfy them
                earlier = False
                for jj in range(s + minb - 1, j):
                    h2, l2 = g.h.iloc[s:jj + 1].max(), g.l.iloc[s:jj + 1].min(); H2 = h2 - l2
                    if H2 <= 0: continue
                    a = sum(1 for q in range(s, jj) if is_swing_high(g, q) and g.h.iat[q] >= h2 - 0.2 * H2)
                    z = sum(1 for q in range(s, jj) if is_swing_low(g, q) and g.l.iat[q] <= l2 + 0.2 * H2)
                    if a >= 2 and z >= 2: earlier = True; break
                ok("confirmed at first qualifying bar", not earlier, b)
                # first bar after confirm that leaves the box (wick) must be the stored sweep or break bar
                tol = 1e-5 * (hi + lo) / 2       # same float-noise tolerance the engine uses
                k = j + 1; first = None
                while k < len(g) and k <= j + maxa:
                    if g.h.iat[k] > hi + tol or g.l.iat[k] < lo - tol: first = k; break
                    k += 1
                stored = [pd.Timestamp(x) for x in (b.sweep_date, b.break_date) if x is not None and not pd.isna(x)]
                if first is None:
                    ok("first event after confirm", not stored, b)
                else:
                    good = bool(stored) and min(stored) == g.d.iat[first]
                    # a close beyond on one of the last bars of the data is still inside its reclaim window: undecided
                    closed_out = g.c.iat[first] > hi + tol or g.c.iat[first] < lo - tol
                    if not stored and closed_out and first + recl >= len(g) and b.fate == "active": good = True
                    ok("first event after confirm", good, b)
                    if not good and len(fails) < 15:
                        fails[-1] += f" (box {hi:.4f}/{lo:.4f}, confirm {g.d.iat[j]}, first bar outside {g.d.iat[first]} h={g.h.iat[first]:.4f} l={g.l.iat[first]:.4f} c={g.c.iat[first]:.4f}; stored {[str(x) for x in stored]}; bars after confirm {[str(x) for x in g.d.iloc[j+1:j+4]]})"
                if b.break_date is not None and not pd.isna(b.break_date):
                    t = ix[pd.Timestamp(b.break_date)]
                    up = b.break_dir == "up"
                    cl = g.c.iloc[t:t + recl + 1].values
                    ok("break held reclaim window", (cl > hi + tol).all() if up else (cl < lo - tol).all(), b)
                fate_exp = ("unresolved_or_active" if b.break_dir is None else
                            "direct_breakout" if b.sweep_side is None else
                            "manipulation_then_expansion" if b.sweep_side != b.break_dir else "sweep_then_break_same_side")
                ok("fate consistent", b.fate == fate_exp or (fate_exp == "unresolved_or_active" and b.fate in ("unresolved", "active")), b)
                order = [pd.Timestamp(b.start_date), pd.Timestamp(b.confirm_date)] + sorted(stored)
                ok("time order", order == sorted(order) and pd.Timestamp(b.confirm_date) < (min(stored) if stored else pd.Timestamp.max), b)
            # trades
            tchk = {k: [0, 0] for k in ["entry = next open after trigger (market) / at-or-better CE (limit)", "stop beyond box edge / CE",
                                         "exit replay matches (outcome, date, R)", "risk_ok flag", "no entry before trigger"]}
            Ts = T[T.outcome.isin(["win", "loss", "timeout"])]
            Ts = Ts.sample(min(sample * 2, len(Ts)), random_state=7)
            tfails = []

            def tok(name, cond, t):
                tchk[name][0] += int(bool(cond)); tchk[name][1] += 1
                if not cond and len(tfails) < 15: tfails.append(f"{name}: {t.sym} {t.model} {t.target} {t.entry_date}")

            for _, t in Ts.iterrows():
                g = G[t.sym]; ix = IDX[t.sym]
                e, tr = ix[pd.Timestamp(t.entry_date)], ix[pd.Timestamp(t.trigger_date)]
                lim = t.model == "BREAK_CE_LIMIT"
                if lim:
                    tok("entry = next open after trigger (market) / at-or-better CE (limit)",
                        (t.entry <= t.ce + EPS) if t.side == "bull" else (t.entry >= t.ce - EPS), t)
                else:
                    tok("entry = next open after trigger (market) / at-or-better CE (limit)", e == tr + 1 and abs(g.o.iat[e] - t.entry) < EPS, t)
                if t.model == "SWEEP_FADE":
                    tok("stop beyond box edge / CE", t.stop > t.box_hi - EPS if t.side == "bear" else t.stop < t.box_lo + EPS, t)
                elif t.model == "BREAK_NEXT_OPEN":
                    tok("stop beyond box edge / CE", abs(t.stop - t.ce) < EPS, t)
                else:
                    tok("stop beyond box edge / CE", abs(t.stop - (t.box_lo if t.side == "bull" else t.box_hi)) < EPS, t)
                out, px, x = replay(g, t.side, e, t.entry, t.stop, t.tgt, lim, mh)
                r = (px - t.entry) * (1 if t.side == "bull" else -1) / abs(t.entry - t.stop)
                tok("exit replay matches (outcome, date, R)", out == t.outcome and g.d.iat[x] == pd.Timestamp(t.exit_date) and abs(r - t.r) < 1e-6, t)
                tok("risk_ok flag", t.risk_ok == (abs(t.entry - t.stop) / t.entry * 100 >= P["min_risk_pct"]), t)
                tok("no entry before trigger", e > tr, t)
            res = dict(checked_boxes=len(Bs), total_boxes=len(B), checked_trades=len(Ts), total_trades=len(T),
                       box_checks={k: {"pass": v[0], "n": v[1]} for k, v in checks.items()},
                       trade_checks={k: {"pass": v[0], "n": v[1]} for k, v in tchk.items()},
                       failures=fails + tfails, validated_at=dt.datetime.now().isoformat(timespec="seconds"))
            print(f"\n=== {run.run_id}: {len(Bs)}/{len(B)} boxes, {len(Ts)}/{len(T)} closed trades checked")
            for k, v in {**res["box_checks"], **res["trade_checks"]}.items():
                print(f"   {'OK  ' if v['pass'] == v['n'] else 'FAIL'} {k}: {v['pass']}/{v['n']}")
            for f in res["failures"][:10]: print("     -", f)
            with con, con.cursor() as cur:
                cur.execute("UPDATE consolidation_runs SET summary = jsonb_set(coalesce(summary, '{}'::jsonb), '{validation}', %s::jsonb) WHERE run_id=%s",
                            (json.dumps(res, default=str), run.run_id))


if __name__ == "__main__":
    main()
