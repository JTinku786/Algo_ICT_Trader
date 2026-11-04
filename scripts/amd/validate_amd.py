"""Independent audit of amd_engine.py output - re-derives every AMD rule from raw bars with separate plain code and
checks the no-lookahead contract on every sampled trade. Results go to amd_runs.summary->'validation'.

usage: python validate_amd.py [--tf 1d 1h 30m] [--sample 1500]
"""
import json, sys, warnings, datetime as dt
import numpy as np, pandas as pd
warnings.filterwarnings("ignore")
import amd_engine as ae
rv = ae.rv
import psycopg2

EPS = 1e-6


def args(flag, default):
    if flag not in sys.argv: return default
    out = []
    for a in sys.argv[sys.argv.index(flag) + 1:]:
        if a.startswith("--"): break
        out.append(a)
    return out


def atr_at(H, L, C, i, n=20):
    pc = np.r_[np.nan, C[:-1]]
    tr = np.nanmax(np.vstack([H - L, np.abs(H - pc), np.abs(L - pc)]), axis=0)
    return tr[i - n + 1:i + 1].mean()


def swing_hi(h, q): return h[q] > h[q - 1] and h[q] >= h[q + 1]
def swing_lo(l, q): return l[q] < l[q - 1] and l[q] <= l[q + 1]


def replay(o, h, l, c, side, e, entry, stop, tgt, is_limit, hold):
    n = len(c)
    for j in range(e, min(e + hold, n)):
        first = j == e
        if side == "bull":
            if l[j] <= stop: return "loss", (o[j] if (not first and o[j] < stop) else stop), j
            if first and is_limit: continue
            if h[j] >= tgt: return "win", (o[j] if (not first and o[j] > tgt) else tgt), j
        else:
            if h[j] >= stop: return "loss", (o[j] if (not first and o[j] > stop) else stop), j
            if first and is_limit: continue
            if l[j] <= tgt: return "win", (o[j] if (not first and o[j] < tgt) else tgt), j
    j = min(e + hold, n) - 1
    return ("open" if e + hold > n else "timeout"), c[j], j


class Book:
    def __init__(self): self.d = {}; self.fails = []
    def ok(self, name, cond, who):
        p = self.d.setdefault(name, [0, 0]); p[0] += int(bool(cond)); p[1] += 1
        if not cond and len(self.fails) < 25: self.fails.append(f"{name}: {who}")
    def out(self): return {k: {"pass": v[0], "n": v[1]} for k, v in self.d.items()}


def check_structural(run, P, G, IDX, sample):
    con = run["con"]; spec = ae.TF_SPEC[P["timeframe"]]
    C = pd.read_sql("SELECT * FROM amd_cycles WHERE run_id=%s", con, params=(run["run_id"],))
    T = pd.read_sql("SELECT * FROM amd_trades WHERE run_id=%s", con, params=(run["run_id"],))
    cb, tb = Book(), Book()
    Cs = C.sample(min(sample, len(C)), random_state=7)
    for _, x in Cs.iterrows():
        g = G[x.sym]; ix = IDX[x.sym]; o, h, l, c = g["o"], g["h"], g["l"], g["c"]; who = f"{x.sym} {x.acc_start}"
        s, j = ix[pd.Timestamp(x.acc_start)], ix[pd.Timestamp(x.acc_confirm)]
        hi, lo = h[s:j + 1].max(), l[s:j + 1].min(); H = hi - lo; R = atr_at(h, l, c, s - 1)
        cb.ok("A: accumulation edges = wick hi/lo, >= min bars", abs(hi - x.acc_hi) < EPS and abs(lo - x.acc_lo) < EPS and j - s + 1 >= spec["min_bars"], who)
        cb.ok("A: span <= h_mult x ATR20 (pre-box)", H <= P["h_mult"] * R + EPS, who)
        eqh = [q for q in range(s, j) if swing_hi(h, q) and h[q] >= hi - 0.2 * H]
        eql = [q for q in range(s, j) if swing_lo(l, q) and l[q] <= lo + 0.2 * H]
        cb.ok("A: >= 2 EQH swings and >= 2 EQL swings", len(eqh) >= 2 and len(eql) >= 2, who)
        # ---- M replay
        tol = 1e-5 * (hi + lo) / 2; HI, LO = hi + tol, lo - tol
        exp_kind = None; exp_out = None; k = j + 1; last = min(len(c) - 1, j + spec["max_active"])
        while k <= last:
            up, dn = h[k] > HI, l[k] < LO
            if up and dn: exp_out = "news_reset"; break
            if c[k] > HI or c[k] < LO:
                side = "up" if c[k] > HI else "dn"; t0 = k; ext = h[k] if side == "up" else l[k]; ret = None
                for m in range(k + 1, min(len(c), k + 4)):
                    ext = max(ext, h[m]) if side == "up" else min(ext, l[m])
                    if (c[m] <= HI) if side == "up" else (c[m] >= LO): ret = m; break
                if ret is None: exp_out = "active" if k + 3 > len(c) - 1 else "breakout_no_manipulation"   # reclaim window not over yet
                else: exp_kind = ("2B", side, t0, ret, ext)
                break
            if up or dn:
                side = "up" if up else "dn"; exp_kind = ("wick", side, k, k, h[k] if up else l[k]); break
            k += 1
        if exp_kind is None and exp_out is None:
            cb.ok("M: first edge event replay", x.outcome in ("expired", "active"), who + f" stored {x.outcome}")
        elif exp_out is not None:
            cb.ok("M: first edge event replay", x.outcome == exp_out, who + f" expected {exp_out} stored {x.outcome}")
        else:
            kind, side, t0, ret, ext = exp_kind
            cb.ok("M: first edge event replay", x.manip_kind == kind and x.manip_side == side and pd.Timestamp(x.pierce_date) == g["d"][t0]
                  and pd.Timestamp(x.return_date) == g["d"][ret] and abs(x.sweep_extreme - ext) < EPS, who)
            # ---- D replay: MSS before a close beyond the sweep extreme
            bull = side == "dn"; X = ext; mss = None; out = "unresolved"
            for k in range(ret + 1, min(len(c) - 1, ret + spec["max_dist"]) + 1):
                if (bull and c[k] < X) or (not bull and c[k] > X): out = "manipulation_failed"; break
                if mss is None:
                    qs = [q for q in range(s, k - 1) if (swing_hi(h, q) if bull else swing_lo(l, q))]
                    if qs:
                        lvl = h[qs[-1]] if bull else l[qs[-1]]; body = (c[k] - o[k]) * (1 if bull else -1); rg = h[k] - l[k]
                        if body >= 0.75 * R and rg > 0 and body >= 0.5 * rg and ((c[k] > lvl) if bull else (c[k] < lvl)): mss = k
                if (bull and h[k] >= hi) or (not bull and l[k] <= lo):
                    out = "distribution_complete" if mss is not None else "distribution_no_mss"; break
            if out == "unresolved" and ret + spec["max_dist"] > len(c) - 1: out = "active"
            no_mss = pd.isna(x.mss_date)
            cb.ok("D: MSS + outcome replay", out == x.outcome and ((mss is None and no_mss) or
                  (mss is not None and not no_mss and g["d"][mss] == pd.Timestamp(x.mss_date))),
                  who + f" expected {out}/{None if mss is None else g['d'][mss]} stored {x.outcome}/{None if no_mss else x.mss_date}")
    # ---- trades
    cyc = C.set_index("cycle_id")
    Ts = T[T.outcome.isin(["win", "loss", "timeout"])]
    Ts = Ts.sample(min(sample * 2, len(Ts)), random_state=7)
    for _, t in Ts.iterrows():
        g = G[t.sym]; ix = IDX[t.sym]; o, h, l, c = g["o"], g["h"], g["l"], g["c"]; x = cyc.loc[t.cycle_id]
        who = f"{t.sym} {t.model} {t.target} {t.entry_date}"; bull = t.side == "bull"; sg = 1 if bull else -1
        e, dec = ix[pd.Timestamp(t.entry_date)], ix[pd.Timestamp(t.decision_date)]
        s = ix[pd.Timestamp(x.acc_start)]; R = atr_at(h, l, c, s - 1); X = x.sweep_extreme
        tb.ok("no lookahead: decision bar closes before the fill bar", dec < e, who)
        if t.model == "RETURN_CLOSE":
            tb.ok("entry / decision rule", dec == ix[pd.Timestamp(x.return_date)] and e == dec + 1 and abs(t.entry - o[e]) < EPS, who)
            tb.ok("stop beyond the swept liquidity (+ buffer)", abs(t.stop - (X - sg * 0.4 * R)) < 1e-6, who)
        elif t.model == "MSS_CLOSE":
            tb.ok("entry / decision rule", dec == ix[pd.Timestamp(x.mss_date)] and e == dec + 1 and abs(t.entry - o[e]) < EPS, who)
            tb.ok("stop beyond the swept liquidity (+ buffer)", abs(t.stop - (X - sg * 0.1 * R)) < 1e-6, who)
        else:
            f = x.fvg if isinstance(x.fvg, list) else json.loads(x.fvg); lv = (f[1] + f[2]) / 2
            mss = ix[pd.Timestamp(x.mss_date)]
            touch = [k for k in range(dec + 1, e + 1) if ((l[k] <= lv) if bull else (h[k] >= lv))]
            tb.ok("entry / decision rule", dec <= mss + 1 and g["d"][dec - 1] == pd.Timestamp(f[0]) and touch and touch[0] == e
                  and abs(t.entry - (min(o[e], lv) if bull else max(o[e], lv))) < 1e-6, who)
            tb.ok("stop beyond the swept liquidity (+ buffer)", abs(t.stop - (X - sg * 0.1 * R)) < 1e-6, who)
        # targets rebuilt from bars <= decision only
        opp = x.acc_hi if bull else x.acc_lo; risk = (t.entry - t.stop) * sg
        pools = []
        for q in range(max(2, dec - ae.TF_SPEC[P["timeframe"]]["ext_look"]), dec):
            if bull and swing_hi(h, q) and h[q] > opp and h[q + 1:dec + 1].max() <= h[q]: pools.append(h[q])
            if not bull and swing_lo(l, q) and l[q] < opp and l[q + 1:dec + 1].min() >= l[q]: pools.append(l[q])
        pools = sorted(set(pools), reverse=not bull)
        exp = {"CE": x.ce, "opp_edge": opp, "ext_pool": pools[0] if pools else None,
               "fib_1.5": (x.acc_hi + 0.5 * (x.acc_hi - X)) if bull else (x.acc_lo - 0.5 * (X - x.acc_lo)),
               "liq_2R": next((p for p in [x.ce, opp] + pools if (p - t.entry) * sg >= 2 * risk), None), "2R": t.entry + sg * 2 * risk}[t.target]
        tb.ok("target = liquidity level known at the decision bar", exp is not None and abs(exp - t.tgt) < 1e-6, who)
        out, px, xx = replay(o, h, l, c, t.side, e, t.entry, t.stop, t.tgt, t.model == "MSS_FVG", ae.TF_SPEC[P["timeframe"]]["max_hold"])
        r = (px - t.entry) * sg / risk
        tb.ok("exit replay matches (outcome, date, R)", out == t.outcome and g["d"][xx] == pd.Timestamp(t.exit_date) and abs(r - t.r) < 1e-6, who)
    return cb, tb, len(Cs), len(C), len(Ts), len(T)


def check_session(run, P, G, IDX, DG, sample):
    con = run["con"]
    C = pd.read_sql("SELECT * FROM amd_cycles WHERE run_id=%s AND outcome <> 'no_judas'", con, params=(run["run_id"],))
    T = pd.read_sql("SELECT * FROM amd_trades WHERE run_id=%s", con, params=(run["run_id"],))
    cb, tb = Book(), Book()
    Cs = C.sample(min(sample, len(C)), random_state=7)
    mins = lambda ts: ts.hour * 60 + ts.minute
    for _, x in Cs.iterrows():
        g = G[x.sym]; ix = IDX[x.sym]; o, h, l, c, d = g["o"], g["h"], g["l"], g["c"], g["d"]; who = f"{x.sym} {x.day}"
        a = ix[pd.Timestamp(x.acc_start)]; D = pd.Timestamp(x.day)
        b = a
        while b + 1 < len(d) and d[b + 1].normalize() == D: b += 1
        dd = DG[x.sym]; di = dd.index.get_loc(D)
        pdh, pdl = dd.h.iloc[di - 1], dd.l.iloc[di - 1]
        H_, L_, C_ = dd.h.values.astype(float), dd.l.values.astype(float), dd.c.values.astype(float)
        R = atr_at(H_, L_, C_, di - 1)
        cb.ok("true open = 09:30 open; PDH/PDL = prior session", mins(d[a]) == 570 and abs(x.true_open - o[a]) < EPS and abs(x.pdh - pdh) < EPS and abs(x.pdl - pdl) < EPS, who)
        O = o[a]; lo_, hi_, lt, ht = l[a], h[a], a, a; trig = None
        for k in range(a, b + 1):
            if k > a and mins(d[k]) < 660:
                if l[k] < lo_: lo_, lt = l[k], k
                if h[k] > hi_: hi_, ht = h[k], k
            if mins(d[k]) >= 720: break
            if O - lo_ >= 0.1 * R and c[k] > O and mins(d[lt]) < 660: trig = ("bull", k, lo_, lt); break
            if hi_ - O >= 0.1 * R and c[k] < O and mins(d[ht]) < 660: trig = ("bear", k, hi_, ht); break
        cb.ok("Judas (>= 0.1 x ATR through the open before 11:00) + close back before 12:00 replay", trig is not None and x.expected_dir == trig[0]
              and pd.Timestamp(x.return_date) == d[trig[1]] and abs(x.sweep_extreme - trig[2]) < EPS and pd.Timestamp(x.pierce_date) == d[trig[3]], who)
        if trig is not None:
            gap = not (pdl <= O <= pdh); bull_ = trig[0] == "bull"
            kind = "opened_outside_prior_range" if gap else ("swept_PDL" if trig[2] < pdl else "inside_prior_range") if bull_ else ("swept_PDH" if trig[2] > pdh else "inside_prior_range")
            cb.ok("raid label: PDH/PDL taken by the Judas (gap days separate)", x.manip_kind == kind, who + f" expected {kind} stored {x.manip_kind}")
    cyc = C.set_index("cycle_id")
    Ts = T[T.outcome.isin(["win", "loss", "timeout"])]
    Ts = Ts.sample(min(sample * 2, len(Ts)), random_state=7)
    for _, t in Ts.iterrows():
        g = G[t.sym]; ix = IDX[t.sym]; o, h, l, c, d = g["o"], g["h"], g["l"], g["c"], g["d"]; x = cyc.loc[t.cycle_id]
        who = f"{t.sym} {t.target} {t.entry_date}"; bull = t.side == "bull"; sg = 1 if bull else -1
        e, dec = ix[pd.Timestamp(t.entry_date)], ix[pd.Timestamp(t.decision_date)]
        tb.ok("no lookahead: decision bar closes before the fill bar", dec < e and e == dec + 1 and abs(t.entry - o[e]) < EPS, who)
        tb.ok("stop beyond the Judas extreme (+ 0.1 x ATR)", abs(t.stop - (x.sweep_extreme - sg * 0.1 * x.atr)) < 1e-6, who)
        b = e
        while b + 1 < len(d) and d[b + 1].normalize() == d[e].normalize(): b += 1
        tb.ok("flat by the session close (same-day exit)", pd.Timestamp(t.exit_date).normalize() == d[e].normalize(), who)
        risk = (t.entry - t.stop) * sg
        tgt = {"PDH_PDL": x.pdh if bull else x.pdl, "2R": t.entry + sg * 2 * risk, "3R": t.entry + sg * 3 * risk, "EOD": t.entry + sg * 1e6}[t.target]
        out, px, xx = replay(o, h, l, c, t.side, e, t.entry, t.stop, tgt, False, b - e + 1)
        r = (px - t.entry) * sg / risk
        tb.ok("exit replay matches (outcome, date, R)", out == t.outcome and d[xx] == pd.Timestamp(t.exit_date) and abs(r - t.r) < 1e-6, who)
        tb.ok("risk_ok flag", t.risk_ok == (risk / t.entry * 100 >= P["min_risk_pct"]), who)
    return cb, tb, len(Cs), len(C), len(Ts), len(T)


def main():
    tfs = args("--tf", ["1d", "1h", "30m"]); sample = int(args("--sample", ["1500"])[0])
    con = psycopg2.connect(rv.db_uri())
    runs = pd.read_sql("SELECT DISTINCT ON (timeframe, config_name) run_id, timeframe, config_name, family, params, data_start FROM amd_runs "
                       "ORDER BY timeframe, config_name, created_at DESC", con)
    for tf in tfs:
        start = pd.Timestamp(str(runs[runs.timeframe == tf].data_start.iloc[0]))
        new_runs=runs[(runs.timeframe==tf)&runs.run_id.str.startswith('AMD_V2_')]
        if len(new_runs):
            import amd_data
            from amd_validation import validate
            frame,_=amd_data.load(con,tf,start)
            for run in new_runs.itertuples():
                C=pd.read_sql('SELECT * FROM amd_cycles WHERE run_id=%s',con,params=(run.run_id,))
                T=pd.read_sql('SELECT * FROM amd_trades WHERE run_id=%s',con,params=(run.run_id,))
                res=validate(C,T,frame,tf)
                print(run.run_id,json.dumps(res,default=str),flush=True)
                if res['failures']: raise RuntimeError(f"Causal validation failed for {run.run_id}")
                with con,con.cursor() as cur:
                    cur.execute("UPDATE amd_runs SET summary=jsonb_set(summary,'{validation}',%s::jsonb) WHERE run_id=%s",(json.dumps(res),run.run_id))
            # Never put repaired V1 inputs through the V2 audit or recertify V1.
            continue
        rv.MARKET = "us"; rv.START = start; rv.LOAD_FROM = str((start - pd.Timedelta(days=550)).date())
        df = rv.clean(rv.load_db(con) if tf == "1d" else rv.load_intraday(con, tf)[0])
        G, IDX = {}, {}
        for s_, g in df.groupby("sym"):
            g = g.reset_index(drop=True)
            G[s_] = {"o": g.o.values.astype(float), "h": g.h.values.astype(float), "l": g.l.values.astype(float), "c": g.c.values.astype(float), "d": list(pd.to_datetime(g.d))}
            IDX[s_] = {d: i for i, d in enumerate(G[s_]["d"])}
        DG = None
        if tf != "1d":
            dc = rv.clean(rv.load_db(con))
            DG = {s_: g.assign(d=pd.to_datetime(g.d)).set_index("d").sort_index() for s_, g in dc.groupby("sym")}
        for _, run in runs[runs.timeframe == tf].iterrows():
            P = run.params if isinstance(run.params, dict) else json.loads(run.params)
            ctx = {"con": con, "run_id": run.run_id}
            if run.family == "structural": cb, tb, nc, NC, nt, NT = check_structural(ctx, P, G, IDX, sample)
            else: cb, tb, nc, NC, nt, NT = check_session(ctx, P, G, IDX, DG, sample)
            res = dict(checked_cycles=nc, total_cycles=NC, checked_trades=nt, total_trades=NT, cycle_checks=cb.out(), trade_checks=tb.out(),
                       failures=cb.fails + tb.fails, validated_at=dt.datetime.now().isoformat(timespec="seconds"))
            print(f"\n=== {run.run_id}: {nc}/{NC} cycles, {nt}/{NT} closed trades checked")
            for k, v in {**res["cycle_checks"], **res["trade_checks"]}.items():
                print(f"   {'OK  ' if v['pass'] == v['n'] else 'FAIL'} {k}: {v['pass']}/{v['n']}")
            for f in res["failures"][:12]: print("     -", f)
            with con, con.cursor() as cur:
                cur.execute("UPDATE amd_runs SET summary = jsonb_set(coalesce(summary, '{}'::jsonb), '{validation}', %s::jsonb) WHERE run_id=%s",
                            (json.dumps(res, default=str), run.run_id))


if __name__ == "__main__":
    main()
