"""ICT expansion study (Daily / 1H / 30m), US equities (29 Dow + SPY + QQQ).

Sources
  ICT Mentorship (Sept): Expansion = price moves quickly from a level of equilibrium; it reveals the intended repricing.
      Retracement = price moves back inside the recently created range to reprice to levels not efficiently traded
      (fair value gaps / liquidity voids).
  Range Expansion Strategy guide: an impulse must push and CLOSE violently through a previous high/low; only buy in
      bullish impulses at a discount (< 0.5 of the leg), sell in bearish ones at a premium; sweep + rejection at the
      discount/premium triggers the entry; stop at the sweep low/high; target from the higher timeframe.
  ICT four phases: do not enter during the expansion; enter on the retracement into the FVG / OB it left behind.
  OTE: fib from the leg's origin to its swing extreme; 62-79% retracement, 70.5% preferred; stop beyond the origin.

Rules (all causal - every level is known when it is used)
  ATR        : 20-bar simple ATR taken on the bar BEFORE the displacement candle.
  Swings     : 3-candle swings (high above the bar before it and >= the bar after); a swing at q is known after q+1.
  Displacement (bar t, bullish; bearish mirrored):
      body = close - open >= disp_body x ATR20, body >= 60% of the candle range,
      and the close is above the most recent confirmed swing high (structure break / BOS).
  Leg origin : lowest low between the broken swing high and the displacement bar (the swing the impulse left from).
  Leg end    : the leg runs while price prints higher highs; it ends at the first confirmed 3-candle swing high after t.
               Leg = origin low -> swing high. It must span >= min_leg x ATR20 and contain >= 1 bullish FVG.
  Equilibrium: 50% of the leg. Discount < 50% (longs), premium > 50% (shorts). OTE band 62-79%, 70.5% sweet spot.
  Window     : orders work for max_wait bars after the leg is confirmed. A new high above the leg (continuation) or a
               close below the origin (failure) ends the leg; unfilled orders are cancelled.

Trade models
  OTE_LIMIT  : limit at the 70.5% retracement. Stop = leg origin.
  FVG_CE     : limit at the CE (50%) of the leg's highest FVG that sits in discount (FVG CE <= equilibrium). Stop = origin.
  SWEEP_MSS  : the Range Expansion guide. Once price trades into discount, a candle sweeps a swing low formed during the
               pullback and CLOSES back above it with a bullish body (rejection / change in state of delivery).
               Market entry at the next open. Stop = the sweep low.
  CHASE      : baseline the references warn against - market entry at the open after EVERY displacement candle
               (whether or not a valid leg follows), stop at the origin known at that moment, 2R / 3R targets.
  Targets    : leg high (external range liquidity), -0.27 and -0.62 fib extensions of the leg, 2R, 3R.

usage: python expansion_engine.py [--tf 1d 1h 30m] [--start 2017-01-01] [--configs standard strong]
Writes expansion_runs / expansion_legs / expansion_trades. Bars, cleaning, HTF order flow and the bar simulator are
imported from trend_reversal_2026/reversal_engine.py so all three studies read identical candles.
"""
import json, os, sys, hashlib, datetime as dt
import numpy as np, pandas as pd

REV_DIR = os.environ.get("REVERSAL_ENGINE_DIR", r"C:\Users\saite\Desktop\ICT_Automation\trend_reversal_2026")
sys.path.insert(0, REV_DIR)
import reversal_engine as rv  # noqa: E402

TF_SPEC = {
    "1d":  dict(max_leg=20, max_wait=20, max_hold=40, swing_look=60),
    "1h":  dict(max_leg=28, max_wait=28, max_hold=56, swing_look=84),
    "30m": dict(max_leg=39, max_wait=39, max_hold=78, swing_look=117),
}
MIN_RISK = {"1d": 0.5, "1h": 0.25, "30m": 0.2}
BODY_RATIO = 0.6
OTE = 0.705
CONFIGS = [
    dict(name="standard", disp_body=1.0, min_leg=2.0,
         note="Displacement body >= 1.0 x ATR20 (>= 60% of its range) closing through a swing; leg >= 2 x ATR20 with an FVG"),
    dict(name="strong", disp_body=1.5, min_leg=3.0,
         note="Strong displacement: body >= 1.5 x ATR20 closing through a swing; leg >= 3 x ATR20 with an FVG"),
]
TARGETS = ("leg_high", "ext_27", "ext_62", "2R", "3R")


def sid(*parts):
    return hashlib.md5("|".join(map(str, parts)).encode()).hexdigest()[:16]


def atr20(h, l, c):
    pc = np.concatenate([[np.nan], c[:-1]])
    tr = np.nanmax(np.vstack([h - l, np.abs(h - pc), np.abs(l - pc)]), axis=0)
    return pd.Series(tr).rolling(20, min_periods=20).mean().values


def killzone(ts, tf):
    if tf == "1d": return "daily"
    m = ts.hour * 60 + ts.minute
    if m < 600: return "NY open 09:30-10:00"
    if m < 660: return "NY AM 10:00-11:00"
    if m < 810: return "lunch 11:00-13:30"
    return "NY PM 13:30-16:00"


def run_sym(sym, g, cfg, tf, start, bz, run_id):
    spec = TF_SPEC[tf]
    g = g.reset_index(drop=True)
    dates = pd.to_datetime(g.d)
    o, h, l, c = (g[k].values.astype(float) for k in "ohlc")
    n = len(g)
    atr = atr20(h, l, c)
    ph = np.zeros(n, bool); pl = np.zeros(n, bool)
    ph[1:-1] = (h[1:-1] > h[:-2]) & (h[1:-1] >= h[2:])
    pl[1:-1] = (l[1:-1] < l[:-2]) & (l[1:-1] <= l[2:])
    legs, trades, chase = [], [], []
    t = 22; busy_until = 0
    while t < n - 2:
        if t <= busy_until: t += 1; continue
        R = atr[t - 1]
        if not np.isfinite(R) or R <= 0: t += 1; continue
        rng = h[t] - l[t]
        side = None
        for sd in ("bull", "bear"):
            body = (c[t] - o[t]) if sd == "bull" else (o[t] - c[t])
            if body < cfg["disp_body"] * R or rng <= 0 or body < BODY_RATIO * rng: continue
            # most recent swing confirmed before bar t (swing at q is known once q+1 has closed, q+1 <= t-1)
            mask = ph if sd == "bull" else pl
            qs = np.where(mask[max(0, t - spec["swing_look"]):t - 1])[0]
            if not len(qs): continue
            q = qs[-1] + max(0, t - spec["swing_look"])
            lvl = h[q] if sd == "bull" else l[q]
            if (sd == "bull" and c[t] > lvl) or (sd == "bear" and c[t] < lvl):
                side = sd; qb = q; brk_lvl = lvl; break
        if side is None: t += 1; continue
        bull = side == "bull"
        if dates[t] >= start and t + 1 < n:
            chase.append((t, side, qb))
        # origin: the extreme the impulse left from, between the broken swing and the displacement candle
        seg = l[qb:t + 1] if bull else h[qb:t + 1]
        oi = qb + (int(np.argmin(seg)) if bull else int(np.argmax(seg)))
        origin = l[oi] if bull else h[oi]
        # leg end: first confirmed 3-candle swing in the impulse direction after t (needs bar q+1 to close)
        ext_i = t; ext = h[t] if bull else l[t]; conf = None
        for m in range(t + 1, min(n, t + spec["max_leg"] + 1)):
            if (bull and c[m] < origin) or (not bull and c[m] > origin): break           # failed before forming a leg
            if (bull and h[m] > ext) or (not bull and l[m] < ext):
                ext, ext_i = (h[m], m) if bull else (l[m], m)
                continue
            # bar m did not extend -> the extreme bar ext_i is a swing (higher than the bar before it, m is not higher)
            prev = h[ext_i - 1] if bull else l[ext_i - 1]
            if (bull and ext > prev) or (not bull and ext < prev):
                conf = m; break
        if conf is None: t += 1; continue
        leg = abs(ext - origin)
        if leg < cfg["min_leg"] * R: t += 1; continue
        # FVGs created inside the leg (origin -> extreme), in the impulse direction
        fvgs = []
        for k in range(max(oi + 2, 2), ext_i + 1):
            if bull and l[k] > h[k - 2]: fvgs.append((k - 1, h[k - 2], l[k]))
            if not bull and h[k] < l[k - 2]: fvgs.append((k - 1, h[k], l[k - 2]))
        if not fvgs: t += 1; continue
        sg = 1 if bull else -1
        eq = ext - sg * 0.5 * leg
        lvl_ote = ext - sg * OTE * leg
        # an FVG must still be open when the leg is confirmed to be an entry array
        def still_open(f):
            _, lo_, hi_ = f
            seg2 = l[f[0] + 2:conf + 1] if bull else h[f[0] + 2:conf + 1]
            return not len(seg2) or (seg2.min() > lo_ if bull else seg2.max() < hi_)
        disc = [f for f in fvgs if ((f[1] + f[2]) / 2 <= eq if bull else (f[1] + f[2]) / 2 >= eq) and still_open(f)]
        entry_fvg = (max(disc, key=lambda f: f[2]) if bull else min(disc, key=lambda f: f[1])) if disc else None

        # ---------- retracement phase: follow the leg for max_wait bars after confirmation
        last = min(n - 1, conf + spec["max_wait"])
        deepest = ext; outcome = "unresolved"; end = last
        touched_eq = touched_ote = False
        fills = {}                               # model -> (bar, price, stop, trigger_bar)
        pb_swings = []                           # confirmed pullback swing lows (bull) / highs (bear) after the extreme
        sweep_ready = False
        for k in range(conf, last + 1):
            if k > conf:
                # continuation: the leg's extreme is taken -> leg over (orders not filled are cancelled)
                if (bull and h[k] > ext) or (not bull and l[k] < ext):
                    outcome = "continued_after_retrace" if touched_eq else "continued_shallow"; end = k
                    # a limit can still fill on this bar before the new extreme only if the bar opened through it
                    break
                # failure: close through the origin
                if (bull and c[k] < origin) or (not bull and c[k] > origin):
                    for mdl, lv in (("OTE_LIMIT", lvl_ote), ("FVG_CE", (entry_fvg[1] + entry_fvg[2]) / 2 if entry_fvg else None)):
                        if lv is not None and mdl not in fills and ((bull and l[k] <= lv) or (not bull and h[k] >= lv)):
                            fills[mdl] = (k, min(o[k], lv) if bull else max(o[k], lv), origin, conf)
                    outcome = "failed"; end = k; break
            deepest = min(deepest, l[k]) if bull else max(deepest, h[k])
            if (bull and l[k] <= eq) or (not bull and h[k] >= eq): touched_eq = True
            if (bull and l[k] <= lvl_ote) or (not bull and h[k] >= lvl_ote): touched_ote = True
            if k == conf: continue                       # orders go live on the bar after the leg is known
            # limit orders
            for mdl, lv in (("OTE_LIMIT", lvl_ote), ("FVG_CE", (entry_fvg[1] + entry_fvg[2]) / 2 if entry_fvg else None)):
                if lv is None or mdl in fills: continue
                if (bull and l[k] <= lv) or (not bull and h[k] >= lv):
                    fills[mdl] = (k, min(o[k], lv) if bull else max(o[k], lv), origin, conf)
            # SWEEP_MSS: track pullback swings (confirmed at k: swing at k-1)
            q = k - 1
            if q > ext_i and ((bull and pl[q]) or (not bull and ph[q])):
                pb_swings.append(l[q] if bull else h[q])
            if touched_eq and "SWEEP_MSS" not in fills and pb_swings:
                sw = min(pb_swings) if bull else max(pb_swings)
                if bull and l[k] < sw and l[k] <= eq and c[k] > sw and c[k] > o[k] and k + 1 < n:
                    fills["SWEEP_MSS"] = (k + 1, o[k + 1], l[k], k)
                if not bull and h[k] > sw and h[k] >= eq and c[k] < sw and c[k] < o[k] and k + 1 < n:
                    fills["SWEEP_MSS"] = (k + 1, o[k + 1], h[k], k)
        if outcome == "unresolved" and conf + spec["max_wait"] > n - 1: outcome = "active"   # data ends inside the window
        retr = abs(ext - deepest) / leg
        busy_until = end
        if dates[t] < start:
            t = end + 1; continue
        bias = rv.bias_at(bz, dates[t])
        leg_id = sid(run_id, sym, dates[t], side)
        before = l[max(0, oi - 20):oi] if bull else h[max(0, oi - 20):oi]
        origin_sweep = bool(len(before) and ((bull and origin < before.min()) or (not bull and origin > before.max())))
        legs.append(dict(
            run_id=run_id, leg_id=leg_id, sym=sym, side=side, origin_date=dates[oi].to_pydatetime(), disp_date=dates[t].to_pydatetime(),
            ext_date=dates[ext_i].to_pydatetime(), confirm_date=dates[conf].to_pydatetime(), end_date=dates[end].to_pydatetime(),
            broken_swing_date=dates[qb].to_pydatetime(), broken_level=float(brk_lvl), origin=float(origin), ext=float(ext),
            eq=float(eq), ote=float(lvl_ote), leg_atr=float(leg / R), leg_pct=float(leg / origin * 100),
            disp_body_atr=float(abs(c[t] - o[t]) / R), disp_bars=int(ext_i - oi + 1), fvg_count=len(fvgs),
            fvgs=json.dumps([[str(dates[f[0]]), float(f[1]), float(f[2])] for f in fvgs]),
            entry_fvg=json.dumps([str(dates[entry_fvg[0]]), float(entry_fvg[1]), float(entry_fvg[2])]) if entry_fvg else None,
            origin_sweep=origin_sweep, htf_bias=bias, killzone=killzone(dates[t], tf),
            outcome=outcome, retrace_pct=float(retr * 100), touched_eq=touched_eq, touched_ote=touched_ote))
        # ---------- trades
        def add(model, tgt_name, e_idx, entry, stop, tgt, trig, is_limit):
            risk = abs(entry - stop)
            if risk <= 0 or not np.isfinite(tgt): return
            if (bull and (tgt <= entry or stop >= entry)) or (not bull and (tgt >= entry or stop <= entry)): return
            rv.MAX_HOLD = spec["max_hold"]
            out, px, x = rv.simulate(o, h, l, c, side, e_idx, entry, stop, tgt, "hard", is_limit)
            r = (px - entry) * sg / risk
            mfe = (h[e_idx:x + 1].max() - entry) / risk if bull else (entry - l[e_idx:x + 1].min()) / risk
            trades.append(dict(
                run_id=run_id, trade_id=sid(leg_id, model, tgt_name), leg_id=leg_id, sym=sym, side=side, model=model, target=tgt_name,
                trigger_date=dates[trig].to_pydatetime(), entry_date=dates[e_idx].to_pydatetime(), exit_date=dates[x].to_pydatetime(),
                entry=float(entry), stop=float(stop), tgt=float(tgt), plan_r=float(abs(tgt - entry) / risk), outcome=out, r=float(r),
                pct=float((px - entry) * sg / entry * 100), risk_pct=float(risk / entry * 100), bars_held=int(x - e_idx),
                risk_ok=bool(risk / entry * 100 >= MIN_RISK[tf]), htf_bias=bias,
                with_bias=None if bias == 0 else bool((bias == 1) == bull), leg_outcome=outcome, mfe_r=float(mfe),
                origin=float(origin), ext=float(ext), eq=float(eq)))

        def targets(entry, stop):
            risk = abs(entry - stop)
            return dict(leg_high=ext, ext_27=ext + sg * 0.27 * leg, ext_62=ext + sg * 0.62 * leg,
                        **{"2R": entry + sg * 2 * risk, "3R": entry + sg * 3 * risk})
        for mdl, (e_idx, entry, stop, trig) in fills.items():
            if e_idx >= n: continue
            tg = targets(entry, stop)
            for name in TARGETS:
                add(mdl, name, e_idx, entry, stop, tg[name], trig, mdl != "SWEEP_MSS")
        t = end + 1
    # CHASE baseline: every displacement candle that was checked (whatever its leg did later), next open, stop at the
    # origin known at that moment (lowest low between the broken swing and the displacement candle)
    for t, side, qb in chase:
        bull = side == "bull"; sg = 1 if bull else -1
        seg = l[qb:t + 1] if bull else h[qb:t + 1]
        origin = float(seg.min() if bull else seg.max())
        e_idx = t + 1; entry = o[e_idx]; risk = abs(entry - origin)
        if risk <= 0 or (bull and origin >= entry) or (not bull and origin <= entry): continue
        bias = rv.bias_at(bz, dates[t])
        for name, m in (("2R", 2), ("3R", 3)):
            tgt = entry + sg * m * risk
            rv.MAX_HOLD = spec["max_hold"]
            out, px, x = rv.simulate(o, h, l, c, side, e_idx, entry, origin, tgt, "hard", False)
            mfe = (h[e_idx:x + 1].max() - entry) / risk if bull else (entry - l[e_idx:x + 1].min()) / risk
            trades.append(dict(
                run_id=run_id, trade_id=sid(run_id, sym, dates[t], side, "CHASE", name), leg_id=sid(run_id, sym, dates[t], side), sym=sym,
                side=side, model="CHASE", target=name, trigger_date=dates[t].to_pydatetime(), entry_date=dates[e_idx].to_pydatetime(),
                exit_date=dates[x].to_pydatetime(), entry=float(entry), stop=origin, tgt=float(tgt), plan_r=float(m), outcome=out,
                r=float((px - entry) * sg / risk), pct=float((px - entry) * sg / entry * 100), risk_pct=float(risk / entry * 100),
                bars_held=int(x - e_idx), risk_ok=bool(risk / entry * 100 >= MIN_RISK[tf]), htf_bias=bias,
                with_bias=None if bias == 0 else bool((bias == 1) == bull), leg_outcome=None, mfe_r=float(mfe),
                origin=origin, ext=None, eq=None))
    return legs, trades


def run_config(df, cfg, tf, start, daily=None):
    L, T = [], []
    for sym, g in df.groupby("sym"):
        g = g.reset_index(drop=True)
        if tf == "1d":
            bz = rv.htf_bias(rv.weekly(g))
        else:
            dg = daily[daily.sym == sym].rename(columns={"do": "o", "dh": "h", "dl": "l", "dc": "c"})[["d", "o", "h", "l", "c"]].sort_values("d")
            bz = rv.htf_bias(dg.set_index("d"))
        a, b = run_sym(sym, g, cfg, tf, start, bz, cfg["run_id"])
        L += a; T += b
    return pd.DataFrame(L), pd.DataFrame(T)


DDL = """
CREATE TABLE IF NOT EXISTS expansion_runs (
  run_id text PRIMARY KEY, config_name text, timeframe text, period text, params jsonb, notes text,
  data_start date, data_end date, symbols int, created_at timestamptz DEFAULT now(), summary jsonb);
CREATE TABLE IF NOT EXISTS expansion_legs (
  run_id text, leg_id text, sym text, side text, origin_date timestamp, disp_date timestamp, ext_date timestamp, confirm_date timestamp,
  end_date timestamp, broken_swing_date timestamp, broken_level double precision, origin double precision, ext double precision,
  eq double precision, ote double precision, leg_atr double precision, leg_pct double precision, disp_body_atr double precision,
  disp_bars int, fvg_count int, fvgs jsonb, entry_fvg jsonb, origin_sweep boolean, htf_bias int, killzone text, outcome text,
  retrace_pct double precision, touched_eq boolean, touched_ote boolean, PRIMARY KEY (run_id, leg_id));
CREATE TABLE IF NOT EXISTS expansion_trades (
  run_id text, trade_id text, leg_id text, sym text, side text, model text, target text, trigger_date timestamp, entry_date timestamp,
  exit_date timestamp, entry double precision, stop double precision, tgt double precision, plan_r double precision, outcome text,
  r double precision, pct double precision, risk_pct double precision, bars_held int, risk_ok boolean, htf_bias int, with_bias boolean,
  leg_outcome text, mfe_r double precision, origin double precision, ext double precision, eq double precision, PRIMARY KEY (run_id, trade_id));
CREATE INDEX IF NOT EXISTS expansion_trades_run_idx ON expansion_trades (run_id, model, target);
CREATE INDEX IF NOT EXISTS expansion_legs_run_idx ON expansion_legs (run_id);
"""


def summarize(L, T):
    out = {"legs": int(len(L))}
    if len(L):
        out["outcomes"] = L.outcome.value_counts().to_dict()
        out["touched_eq_pct"] = float(L.touched_eq.mean() * 100)
    if len(T):
        P = T[T.outcome.isin(["win", "loss", "timeout"]) & T.risk_ok]
        g = P.groupby(["model", "target"]).agg(n=("r", "size"), avg_r=("r", "mean")).reset_index()
        out["grid"] = [{k: rv.to_py(v) for k, v in r.items()} for r in g.to_dict("records")]
    return out


def main():
    def _args(flag):
        out = []
        for a in sys.argv[sys.argv.index(flag) + 1:]:
            if a.startswith("--"): break
            out.append(a)
        return out
    tfs = _args("--tf") if "--tf" in sys.argv else ["1d", "1h", "30m"]
    only = _args("--configs") if "--configs" in sys.argv else None
    start = pd.Timestamp(sys.argv[sys.argv.index("--start") + 1]) if "--start" in sys.argv else pd.Timestamp("2017-01-01")
    period = "2026" if start.year == 2026 else "FULL"
    rv.MARKET = "us"; rv.START = start; rv.LOAD_FROM = str((start - pd.Timedelta(days=550)).date())
    import psycopg2
    con = psycopg2.connect(rv.db_uri())
    with con, con.cursor() as cur:
        cur.execute(DDL)
    stamp = dt.datetime.now().strftime("%Y%m%d")
    for tf in tfs:
        rv.DQ.clear()
        daily = None
        if tf == "1d":
            df = rv.load_db(con)
        else:
            df, daily = rv.load_intraday(con, tf)
        df = rv.clean(df)
        print(f"\n##### {tf}: bars={len(df)} symbols={df.sym.nunique()} range={df.d.min()}..{df.d.max()}", flush=True)
        for cfg in CONFIGS:
            if only and cfg["name"] not in only: continue
            cfg = dict(cfg, run_id=f"EXP_{period}_{tf}_{cfg['name']}_{stamp}")
            t0 = dt.datetime.now()
            L, T = run_config(df, cfg, tf, start, daily)
            summ = summarize(L, T)
            print(f"== {cfg['run_id']}: legs={len(L)} trades={len(T)} outcomes={summ.get('outcomes')} "
                  f"touched50%={summ.get('touched_eq_pct')} ({(dt.datetime.now() - t0).seconds}s)", flush=True)
            params = dict(timeframe=tf, disp_body=cfg["disp_body"], body_ratio=BODY_RATIO, min_leg=cfg["min_leg"], ote=OTE,
                          min_risk_pct=MIN_RISK[tf], start=str(start.date()), data_quality=list(rv.DQ),
                          bias_source="weekly order flow" if tf == "1d" else "daily order flow", **TF_SPEC[tf])
            with con, con.cursor() as cur:
                for tb in ("expansion_trades", "expansion_legs", "expansion_runs"):
                    cur.execute(f"DELETE FROM {tb} WHERE run_id=%s", (cfg["run_id"],))
                cur.execute("INSERT INTO expansion_runs (run_id, config_name, timeframe, period, params, notes, data_start, data_end, symbols, summary) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                            (cfg["run_id"], cfg["name"], tf, period, json.dumps(params), cfg["note"], start.date(), df.d.max().date(),
                             int(df.sym.nunique()), json.dumps(summ, default=str)))
                rv.write_df(cur, "expansion_legs", L)
                rv.write_df(cur, "expansion_trades", T)
            print("   written", flush=True)


if __name__ == "__main__":
    main()
