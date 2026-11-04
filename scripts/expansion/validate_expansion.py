"""Independent audit of expansion_engine.py output.

Re-derives every rule from the raw bars with separate, deliberately plain code (only the bar loaders are shared, so both
read the same candles) and checks every sampled leg and trade. Results are printed and saved into
expansion_runs.summary->'validation' for the website.

usage: python validate_expansion.py [--tf 1d 1h 30m] [--sample 1500]
"""
import json, sys, warnings, datetime as dt
import numpy as np, pandas as pd
warnings.filterwarnings("ignore")
import expansion_engine as ee
rv = ee.rv
import psycopg2

EPS = 1e-6


def args(flag, default):
    if flag not in sys.argv: return default
    out = []
    for a in sys.argv[sys.argv.index(flag) + 1:]:
        if a.startswith("--"): break
        out.append(a)
    return out


def atr_at(g, i, n=20):
    rows = g.iloc[i - n + 1:i + 1]
    prev = g.c.shift(1).iloc[i - n + 1:i + 1]
    return pd.concat([rows.h - rows.l, (rows.h - prev).abs(), (rows.l - prev).abs()], axis=1).max(axis=1).mean()


def swing_hi(g, q): return g.h.iat[q] > g.h.iat[q - 1] and g.h.iat[q] >= g.h.iat[q + 1]
def swing_lo(g, q): return g.l.iat[q] < g.l.iat[q - 1] and g.l.iat[q] <= g.l.iat[q + 1]


def replay(g, side, e, entry, stop, tgt, is_limit, max_hold):
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
    con = psycopg2.connect(rv.db_uri())
    runs = pd.read_sql("SELECT DISTINCT ON (timeframe, config_name) run_id, timeframe, config_name, params, data_start FROM expansion_runs "
                       "ORDER BY timeframe, config_name, created_at DESC", con)
    for tf in tfs:
        start = pd.Timestamp(str(runs[runs.timeframe == tf].data_start.iloc[0]))
        rv.MARKET = "us"; rv.START = start; rv.LOAD_FROM = str((start - pd.Timedelta(days=550)).date())
        df = rv.clean(rv.load_db(con) if tf == "1d" else rv.load_intraday(con, tf)[0])
        G = {s: g.reset_index(drop=True) for s, g in df.groupby("sym")}
        IDX = {s: {pd.Timestamp(d): i for i, d in enumerate(g.d)} for s, g in G.items()}
        for _, run in runs[runs.timeframe == tf].iterrows():
            P = run.params if isinstance(run.params, dict) else json.loads(run.params)
            L = pd.read_sql("SELECT * FROM expansion_legs WHERE run_id=%s", con, params=(run.run_id,))
            T = pd.read_sql("SELECT * FROM expansion_trades WHERE run_id=%s", con, params=(run.run_id,))
            Ls = L.sample(min(sample, len(L)), random_state=7)
            lc = {k: [0, 0] for k in ["displacement body >= k x ATR20 and >= 60% of range", "close through a confirmed 3-candle swing",
                                       "broken swing = most recent confirmed swing", "origin = extreme since broken swing",
                                       "extreme = 3-candle swing confirmed on confirm bar", "no close through origin before confirm",
                                       "leg >= min_leg x ATR20", "FVG count re-counted", "EQ / OTE arithmetic", "leg outcome replay"]}
            fails = []

            def ok(d, name, cond, who):
                d[name][0] += int(bool(cond)); d[name][1] += 1
                if not cond and len(fails) < 20: fails.append(f"{name}: {who}")

            for _, x in Ls.iterrows():
                g = G[x.sym]; ix = IDX[x.sym]; bull = x.side == "bull"; who = f"{x.sym} {x.disp_date}"
                t, qb, oi, ei, ci = (ix[pd.Timestamp(v)] for v in (x.disp_date, x.broken_swing_date, x.origin_date, x.ext_date, x.confirm_date))
                R = atr_at(g, t - 1)
                body = (g.c.iat[t] - g.o.iat[t]) * (1 if bull else -1)
                ok(lc, "displacement body >= k x ATR20 and >= 60% of range", body >= P["disp_body"] * R - EPS and body >= 0.6 * (g.h.iat[t] - g.l.iat[t]) - EPS, who)
                sw = swing_hi if bull else swing_lo
                ok(lc, "close through a confirmed 3-candle swing", sw(g, qb) and qb + 1 <= t - 1 and ((g.c.iat[t] > x.broken_level) if bull else (g.c.iat[t] < x.broken_level)), who)
                later = [q for q in range(qb + 1, t - 1) if sw(g, q)]
                ok(lc, "broken swing = most recent confirmed swing", not later, who)
                seg = g.l.iloc[qb:t + 1] if bull else g.h.iloc[qb:t + 1]
                ok(lc, "origin = extreme since broken swing", abs((seg.min() if bull else seg.max()) - x.origin) < EPS, who)
                ext_seg = g.h.iloc[t:ci + 1] if bull else g.l.iloc[t:ci + 1]
                ok(lc, "extreme = 3-candle swing confirmed on confirm bar",
                   abs((ext_seg.max() if bull else ext_seg.min()) - x.ext) < EPS and ((g.h.iat[ei] > g.h.iat[ei - 1] and g.h.iat[ci] <= x.ext) if bull
                                                                                     else (g.l.iat[ei] < g.l.iat[ei - 1] and g.l.iat[ci] >= x.ext))
                   and ci == ei + 1, who)
                cl = g.c.iloc[t + 1:ci + 1]
                ok(lc, "no close through origin before confirm", (cl >= x.origin).all() if bull else (cl <= x.origin).all(), who)
                leg = abs(x.ext - x.origin)
                ok(lc, "leg >= min_leg x ATR20", leg >= P["min_leg"] * R - EPS, who)
                nf = sum(1 for k in range(max(oi + 2, 2), ei + 1) if ((g.l.iat[k] > g.h.iat[k - 2]) if bull else (g.h.iat[k] < g.l.iat[k - 2])))
                ok(lc, "FVG count re-counted", nf == x.fvg_count and nf >= 1, who)
                sg = 1 if bull else -1
                ok(lc, "EQ / OTE arithmetic", abs(x["eq"] - (x.ext - sg * 0.5 * leg)) < 1e-6 and abs(x.ote - (x.ext - sg * 0.705 * leg)) < 1e-6, who)
                # outcome replay: first of (new extreme, close through origin) after the confirm bar within max_wait
                exp = "unresolved"
                for k in range(ci + 1, min(len(g), ci + P["max_wait"] + 1)):
                    if (g.h.iat[k] > x.ext) if bull else (g.l.iat[k] < x.ext):
                        lows = g.l.iloc[ci:k] if bull else g.h.iloc[ci:k]
                        reached = (lows.min() <= x["eq"]) if bull else (lows.max() >= x["eq"])
                        exp = "continued_after_retrace" if reached else "continued_shallow"; break
                    if (g.c.iat[k] < x.origin) if bull else (g.c.iat[k] > x.origin):
                        exp = "failed"; break
                if exp == "unresolved" and ci + P["max_wait"] > len(g) - 1: exp = "active"
                ok(lc, "leg outcome replay", exp == x.outcome, who + f" (expected {exp}, stored {x.outcome})")
            # trades
            tc = {k: [0, 0] for k in ["fill price = level or better, first touch after confirm", "SWEEP_MSS trigger rules", "CHASE entry/stop",
                                       "exit replay matches (outcome, date, R)", "risk_ok flag"]}
            Ts = T[T.outcome.isin(["win", "loss", "timeout"])]
            Ts = Ts.sample(min(sample * 2, len(Ts)), random_state=7)
            legs = L.set_index("leg_id")
            for _, t in Ts.iterrows():
                g = G[t.sym]; ix = IDX[t.sym]; bull = t.side == "bull"; who = f"{t.sym} {t.model} {t.target} {t.entry_date}"
                e = ix[pd.Timestamp(t.entry_date)]
                if t.model in ("OTE_LIMIT", "FVG_CE"):
                    x = legs.loc[t.leg_id]; ci = ix[pd.Timestamp(x.confirm_date)]
                    if t.model == "OTE_LIMIT": lv = x.ote
                    else:
                        f = x.entry_fvg if isinstance(x.entry_fvg, list) else json.loads(x.entry_fvg); lv = (f[1] + f[2]) / 2
                    touch = [k for k in range(ci + 1, e + 1) if ((g.l.iat[k] <= lv) if bull else (g.h.iat[k] >= lv))]
                    ok(tc, "fill price = level or better, first touch after confirm",
                       touch and touch[0] == e and abs(t.entry - (min(g.o.iat[e], lv) if bull else max(g.o.iat[e], lv))) < 1e-6, who)
                elif t.model == "SWEEP_MSS":
                    k = ix[pd.Timestamp(t.trigger_date)]
                    ok(tc, "SWEEP_MSS trigger rules", e == k + 1 and abs(t.entry - g.o.iat[e]) < 1e-6 and abs(t.stop - (g.l.iat[k] if bull else g.h.iat[k])) < 1e-6
                       and ((g.c.iat[k] > g.o.iat[k] and g.l.iat[k] <= t["eq"]) if bull else (g.c.iat[k] < g.o.iat[k] and g.h.iat[k] >= t["eq"])), who)
                else:
                    k = ix[pd.Timestamp(t.trigger_date)]
                    ok(tc, "CHASE entry/stop", e == k + 1 and abs(t.entry - g.o.iat[e]) < 1e-6, who)
                out, px, xx = replay(g, t.side, e, t.entry, t.stop, t.tgt, t.model in ("OTE_LIMIT", "FVG_CE"), P["max_hold"])
                r = (px - t.entry) * (1 if bull else -1) / abs(t.entry - t.stop)
                ok(tc, "exit replay matches (outcome, date, R)", out == t.outcome and g.d.iat[xx] == pd.Timestamp(t.exit_date) and abs(r - t.r) < 1e-6, who)
                ok(tc, "risk_ok flag", t.risk_ok == (abs(t.entry - t.stop) / t.entry * 100 >= P["min_risk_pct"]), who)
            res = dict(checked_legs=len(Ls), total_legs=len(L), checked_trades=len(Ts), total_trades=len(T),
                       leg_checks={k: {"pass": v[0], "n": v[1]} for k, v in lc.items()},
                       trade_checks={k: {"pass": v[0], "n": v[1]} for k, v in tc.items() if v[1]},
                       failures=fails, validated_at=dt.datetime.now().isoformat(timespec="seconds"))
            print(f"\n=== {run.run_id}: {len(Ls)}/{len(L)} legs, {len(Ts)}/{len(T)} closed trades checked")
            for k, v in {**res["leg_checks"], **res["trade_checks"]}.items():
                print(f"   {'OK  ' if v['pass'] == v['n'] else 'FAIL'} {k}: {v['pass']}/{v['n']}")
            for f in fails[:12]: print("     -", f)
            with con, con.cursor() as cur:
                cur.execute("UPDATE expansion_runs SET summary = jsonb_set(coalesce(summary, '{}'::jsonb), '{validation}', %s::jsonb) WHERE run_id=%s",
                            (json.dumps(res, default=str), run.run_id))


if __name__ == "__main__":
    main()
