"""ICT consolidation study (Daily / 1H / 30m), US equities (29 Dow + SPY + QQQ).

ICT Mentorship (Sept, "What is Consolidation?"): price moves inside a clear trading range and shows no willingness
to move significantly higher or lower. Market makers let orders build on BOTH sides of the market -> expect a new
expansion near term. Look for the impulse swing away from the equilibrium = the halfway point of the range (CE).
ICT Mentorship (Oct, Market Maker Trap: False Breakouts): at some measure of equilibrium the market moves into a
trading range, breakout traders bracket it with orders, market makers run price above the range to neutralise the
buy stops (primary bearish markets) or below it to neutralise the sell stops (primary bullish markets).

Rules (all causal; a box is only used from the close of the bar that confirms it):
  ATR       : 20-bar simple average true range, taken from the bar BEFORE the box starts (compression is measured
              against the energy that came in, not against the box's own shrinking ATR).
  Box       : >= MIN_BARS consecutive bars whose total high-low span <= h_mult x ATR20.
  Two-sided : >= 2 confirmed 3-candle swing highs in the upper 20% of the box (relative equal highs = buy-side
              liquidity) AND >= 2 confirmed 3-candle swing lows in the lower 20% (relative equal lows = sell-side liquidity).
  Freeze    : the box edges (wick high / wick low) freeze at the confirming bar; CE = 50%.
  Sweep     : a wick beyond an edge that closes back inside, or a body close beyond that closes back inside within
              `reclaim` bars (2B / false breakout) = stop run on that side.
  Break     : a body close beyond an edge that is NOT reclaimed within `reclaim` bars = expansion out of the range.
  Fate      : manipulation_then_expansion (sweep one side, break the other) / direct_breakout (no sweep first) /
              sweep_then_break_same_side (the sweep was the real move) / unresolved (no break within max_active bars) /
              active (the data ends before the box's active window does - still live).

Trade models (bar-level fills, hard stop, stop checked before target on the same bar):
  SWEEP_FADE      : after the first sweep, next open, fade back into the box. Stop = sweep extreme.
                    Targets CE / opposite edge / 1R / 2R / 3R / measured move (opposite edge +/- 1 box height).
  BREAK_CE_LIMIT  : ICT alternate path - after a body-close break, limit at the CE (working LIMIT_EXP bars).
                    Stop = opposite edge. Targets 1R / 2R / 3R / measured move (broken edge +/- 1 box height).
  BREAK_NEXT_OPEN : retail breakout baseline - next open in the break direction, stop at CE. Targets 1R/2R/3R/measured.

usage: python consolidation_engine.py [--tf 1d 1h 30m] [--start 2017-01-01] [--configs standard tight]
Writes consolidation_runs / consolidation_boxes / consolidation_trades. Data loaders, cleaning, weekly/daily
order flow and the bar simulator are imported from trend_reversal_2026/reversal_engine.py so both studies read
identical bars.
"""
import json, os, sys, hashlib, datetime as dt
import numpy as np, pandas as pd

REV_DIR = os.environ.get("REVERSAL_ENGINE_DIR", r"C:\Users\saite\Desktop\ICT_Automation\trend_reversal_2026")
sys.path.insert(0, REV_DIR)
import reversal_engine as rv  # noqa: E402

TF_SPEC = {
    "1d":  dict(min_bars=8,  max_active=30, atr_n=20, fwd=20, max_hold=40),
    "1h":  dict(min_bars=10, max_active=42, atr_n=20, fwd=28, max_hold=56),
    "30m": dict(min_bars=12, max_active=52, atr_n=20, fwd=39, max_hold=78),
}
MIN_RISK = {"1d": 0.5, "1h": 0.25, "30m": 0.2}
LIMIT_EXP = 10
EDGE_EPS = 0.2          # upper / lower 20% of the box = an edge test
TOL_REL = 1e-5          # a wick/close must clear the edge by > 0.001% of price (float noise, not a trade-through)
CONFIGS = [
    dict(name="standard", h_mult=3.0, min_touch=2, reclaim=3,
         note="Box span <= 3.0 x ATR20, >= 2 swing highs in the top 20% (EQH) and >= 2 swing lows in the bottom 20% (EQL), 2B reclaim within 3 bars"),
    dict(name="tight", h_mult=2.0, min_touch=2, reclaim=3,
         note="Tight compression: box span <= 2.0 x ATR20, >= 2 EQH swings + >= 2 EQL swings, 2B reclaim within 3 bars"),
]
FADE_TARGETS = ("CE", "opp_edge", "1R", "2R", "3R", "measured")
BREAK_TARGETS = ("1R", "2R", "3R", "measured")


def sid(*parts):
    return hashlib.md5("|".join(map(str, parts)).encode()).hexdigest()[:16]


def episodes(mask):
    """number of separate runs of True (consecutive bars at an edge count as one test)"""
    if not len(mask): return 0
    m = mask.astype(np.int8)
    return int(m[0] + (np.diff(m) == 1).sum())


def atr_arrays(h, l, c, n):
    pc = np.concatenate([[np.nan], c[:-1]])
    tr = np.nanmax(np.vstack([h - l, np.abs(h - pc), np.abs(l - pc)]), axis=0)
    s = pd.Series(tr)
    return s.rolling(n, min_periods=n).mean().values, s.rolling(7, min_periods=7).mean().values, s.rolling(21, min_periods=21).mean().values


def simulate(o, h, l, c, side, e_idx, entry, stop, tgt, is_limit, max_hold):
    rv.MAX_HOLD = max_hold
    return rv.simulate(o, h, l, c, side, e_idx, entry, stop, tgt, "hard", is_limit)


def mfe_r(h, l, side, e_idx, x_idx, entry, risk):
    if risk <= 0 or x_idx < e_idx: return None
    if side == "bull": return float((h[e_idx:x_idx + 1].max() - entry) / risk)
    return float((entry - l[e_idx:x_idx + 1].min()) / risk)


def run_sym(sym, g, cfg, tf, start, bz, run_id):
    spec = TF_SPEC[tf]
    MINB, HM, RECL, MAXA = spec["min_bars"], cfg["h_mult"], cfg["reclaim"], spec["max_active"]
    g = g.reset_index(drop=True)
    dates = pd.to_datetime(g.d)
    o, h, l, c = (g[k].values.astype(float) for k in "ohlc")
    n = len(g)
    atr, atr7, atr21 = atr_arrays(h, l, c, spec["atr_n"])
    # 3-candle swing points (reference: "a candle flanked by a lower high to its left and right"); a swing at q is
    # only known once bar q+1 has closed
    ph = np.zeros(n, bool); pl = np.zeros(n, bool)
    if n >= 3:
        ph[1:-1] = (h[1:-1] > h[:-2]) & (h[1:-1] >= h[2:])
        pl[1:-1] = (l[1:-1] < l[:-2]) & (l[1:-1] <= l[2:])
    hi126 = pd.Series(h).rolling(126, min_periods=60).max().shift(1).values
    lo126 = pd.Series(l).rolling(126, min_periods=60).min().shift(1).values
    # vectorised pre-filter: the first MINB bars from s must already fit inside h_mult x ATR(s-1)
    span = (pd.Series(h).rolling(MINB).max() - pd.Series(l).rolling(MINB).min()).shift(-(MINB - 1)).values
    ref = np.concatenate([[np.nan], atr[:-1]])
    cand = np.where(span <= HM * ref)[0]
    boxes, trades = [], []
    i_next = 0
    for s in cand:
        if s < i_next or s < spec["atr_n"] + 1: continue
        R = ref[s]
        hi, lo = h[s], l[s]
        conf = None
        for j in range(s + 1, n):
            nh, nl = max(hi, h[j]), min(lo, l[j])
            if nh - nl > HM * R: break
            hi, lo = nh, nl
            if j - s + 1 >= MINB:
                H = hi - lo
                if H <= 0: continue
                # relative equal highs / lows: confirmed swing highs in the top 20% and swing lows in the bottom 20%
                qs = np.arange(s, j)                       # swing at q needs bar q+1 <= j
                eqh = qs[ph[s:j] & (h[s:j] >= hi - EDGE_EPS * H)]
                eql = qs[pl[s:j] & (l[s:j] <= lo + EDGE_EPS * H)]
                if len(eqh) >= cfg["min_touch"] and len(eql) >= cfg["min_touch"]:
                    conf = (j, len(eqh), len(eql), eqh, eql); break
        if conf is None: continue
        j, top, bot, eqh, eql = conf
        H = hi - lo; ce = (hi + lo) / 2
        # ---------- follow the frozen box
        first_sweep = None          # dict(side, t, trigger, ext, kind)
        pend = None                 # body close beyond: dict(dir, t, ext)
        brk = None                  # dict(dir, t, known)
        last = min(n - 1, j + MAXA)
        k = j + 1
        sweep_ext = {"up": hi, "dn": lo}
        tol = TOL_REL * ce                   # a pierce must exceed float noise (vendor prices carry float32 artefacts)
        HI, LO = hi + tol, lo - tol
        while k <= last:
            if pend is not None:
                d_ = pend["dir"]
                pend["ext"] = max(pend["ext"], h[k]) if d_ == "up" else min(pend["ext"], l[k])
                back = c[k] <= HI if d_ == "up" else c[k] >= LO
                if back:   # 2B: the break failed -> a sweep of that side
                    if first_sweep is None:
                        first_sweep = dict(side=d_, t=pend["t"], trigger=k, ext=pend["ext"], kind="2B")
                    pend = None
                elif k - pend["t"] >= RECL:
                    brk = dict(dir=d_, t=pend["t"], known=k); break
                k += 1; continue
            up_w, dn_w = h[k] > HI, l[k] < LO
            if c[k] > HI or c[k] < LO:
                d_ = "up" if c[k] > HI else "dn"
                pend = dict(dir=d_, t=k, ext=h[k] if d_ == "up" else l[k])
                if RECL == 0: brk = dict(dir=d_, t=k, known=k); break
            elif (up_w or dn_w) and first_sweep is None:
                d_ = "up" if (up_w and not dn_w) or (up_w and dn_w and h[k] - hi >= lo - l[k]) else "dn"
                first_sweep = dict(side=d_, t=k, trigger=k, ext=h[k] if d_ == "up" else l[k], kind="wick")
            k += 1
        if pend is not None and brk is None and pend["t"] + RECL > last and pend["t"] + RECL < n:
            # break pending at the window edge: settle it with the bars that follow
            kk = pend["t"] + 1; ok = True
            while kk <= pend["t"] + RECL:
                if (c[kk] <= HI) if pend["dir"] == "up" else (c[kk] >= LO): ok = False; break
                kk += 1
            if ok: brk = dict(dir=pend["dir"], t=pend["t"], known=pend["t"] + RECL)
            elif first_sweep is None:   # reclaimed just after the window -> it was a 2B stop run
                ext = h[pend["t"]:kk + 1].max() if pend["dir"] == "up" else l[pend["t"]:kk + 1].min()
                first_sweep = dict(side=pend["dir"], t=pend["t"], trigger=kk, ext=ext, kind="2B")
        if brk is None:
            fate = "active" if j + MAXA > n - 1 else "unresolved"; end = last   # 'active' = data ends inside the window
        elif first_sweep is None:
            fate = "direct_breakout"; end = brk["t"]
        elif first_sweep["side"] != brk["dir"]:
            fate = "manipulation_then_expansion"; end = brk["t"]
        else:
            fate = "sweep_then_break_same_side"; end = brk["t"]
        exp_mfe = exp_mae = None
        if brk is not None:
            f_end = min(n - 1, brk["t"] + spec["fwd"])
            seg_h, seg_l = h[brk["t"] + 1:f_end + 1], l[brk["t"] + 1:f_end + 1]
            if len(seg_h):
                if brk["dir"] == "up":
                    exp_mfe = (seg_h.max() - hi) / H; exp_mae = (hi - seg_l.min()) / H
                else:
                    exp_mfe = (lo - seg_l.min()) / H; exp_mae = (seg_h.max() - lo) / H
        i_next = (brk["known"] if brk else last) + 1
        if dates[j] < start: continue
        bias = rv.bias_at(bz, dates[j])          # HTF order flow known when the box is confirmed
        rng = hi126[j] - lo126[j]
        pd_pos = float((ce - lo126[j]) / rng) if rng and rng > 0 and np.isfinite(rng) else None
        box_id = sid(run_id, sym, dates[s])
        dwell = int(end - j)
        boxes.append(dict(
            run_id=run_id, box_id=box_id, sym=sym, start_date=dates[s].to_pydatetime(), confirm_date=dates[j].to_pydatetime(),
            end_date=dates[end].to_pydatetime(), box_hi=hi, box_lo=lo, ce=ce, height_pct=H / ce * 100, height_atr=H / R,
            bars=int(j - s + 1), dwell_bars=dwell, top_tests=top, bot_tests=bot,
            ce_crosses=int((np.diff(np.sign(c[s:j + 1] - ce)) != 0).sum()),
            eqh=json.dumps([[str(dates[q]), float(h[q])] for q in eqh]), eql=json.dumps([[str(dates[q]), float(l[q])] for q in eql]),
            atr_ratio=float(atr7[j] / atr21[j]) if atr21[j] else None, pd_pos=pd_pos, htf_bias=bias,
            sweep_side=first_sweep["side"] if first_sweep else None, sweep_kind=first_sweep["kind"] if first_sweep else None,
            sweep_date=dates[first_sweep["t"]].to_pydatetime() if first_sweep else None,
            sweep_extreme=first_sweep["ext"] if first_sweep else None,
            sweep_depth_pct=(abs(first_sweep["ext"] - (hi if first_sweep["side"] == "up" else lo)) / H * 100) if first_sweep else None,
            break_dir=brk["dir"] if brk else None, break_date=dates[brk["t"]].to_pydatetime() if brk else None,
            fate=fate, exp_mfe_h=exp_mfe, exp_mae_h=exp_mae,
            expanded_1h=bool(exp_mfe is not None and exp_mfe >= 1.0)))

        def add_trade(model, side, trig, e_idx, entry, stop, tgt_name, tgt, is_limit, extra=None):
            risk = abs(entry - stop)
            if risk <= 0 or not all(np.isfinite(x) and x > 0 for x in (entry, stop, tgt)): return
            if (side == "bull" and stop >= entry) or (side == "bear" and stop <= entry): return
            if (side == "bull" and tgt <= entry) or (side == "bear" and tgt >= entry): return
            out, px, x = simulate(o, h, l, c, side, e_idx, entry, stop, tgt, is_limit, spec["max_hold"])
            sg = 1 if side == "bull" else -1
            r = (px - entry) * sg / risk
            trades.append(dict(
                run_id=run_id, trade_id=sid(box_id, model, tgt_name), box_id=box_id, sym=sym, side=side, model=model, target=tgt_name,
                trigger_date=dates[trig].to_pydatetime(), entry_date=dates[e_idx].to_pydatetime(), exit_date=dates[x].to_pydatetime(),
                entry=entry, stop=stop, tgt=tgt, plan_r=abs(tgt - entry) / risk, outcome=out, r=float(r),
                pct=float((px - entry) * sg / entry * 100), risk_pct=float(risk / entry * 100), bars_held=int(x - e_idx),
                risk_ok=bool(risk / entry * 100 >= MIN_RISK[tf]), htf_bias=bias, pd_pos=pd_pos, fate=fate,
                box_hi=hi, box_lo=lo, ce=ce, mfe_r=mfe_r(h, l, side, e_idx, x, entry, risk),
                with_bias=None if bias == 0 else bool((bias == 1) == (side == "bull")), **(extra or {})))

        # SWEEP_FADE: first sweep -> next open, fade into the box
        if first_sweep is not None and first_sweep["trigger"] + 1 < n:
            fs = first_sweep; e = fs["trigger"] + 1
            # the fade is only taken if the sweep's trigger bar comes before any confirmed break
            if brk is None or fs["trigger"] < brk["known"] or fs["kind"] == "2B":
                side = "bear" if fs["side"] == "up" else "bull"
                ext = max(fs["ext"], h[fs["t"]:fs["trigger"] + 1].max()) if side == "bear" else min(fs["ext"], l[fs["t"]:fs["trigger"] + 1].min())
                entry, stop = o[e], ext
                inside = lo < entry < hi
                if inside:
                    risk = abs(entry - stop)
                    sg = 1 if side == "bull" else -1
                    tg = dict(CE=ce, opp_edge=lo if side == "bear" else hi, measured=(lo - H) if side == "bear" else (hi + H),
                              **{f"{m}R": entry + sg * m * risk for m in (1, 2, 3)})
                    for name in FADE_TARGETS:
                        add_trade("SWEEP_FADE", side, fs["trigger"], e, entry, stop, name, tg[name], False,
                                  dict(sweep_kind=fs["kind"]))
        # break models
        if brk is not None and brk["known"] + 1 < n:
            side = "bull" if brk["dir"] == "up" else "bear"; sg = 1 if side == "bull" else -1
            edge = hi if side == "bull" else lo
            # retail baseline: next open after the break is CONFIRMED (reclaim window passed)
            e = brk["known"] + 1
            entry, stop = o[e], ce
            if (entry - stop) * sg > 0:
                risk = abs(entry - stop)
                tg = dict(measured=edge + sg * H, **{f"{m}R": entry + sg * m * risk for m in (1, 2, 3)})
                for name in BREAK_TARGETS:
                    add_trade("BREAK_NEXT_OPEN", side, brk["known"], e, entry, stop, name, tg[name], False, dict(sweep_kind=None))
            # ICT alternate path: limit at CE after the break, stop beyond the opposite edge
            stop = lo if side == "bull" else hi
            fill = None
            for m in range(brk["known"] + 1, min(n, brk["known"] + 1 + LIMIT_EXP)):
                if (side == "bull" and c[m - 1] < stop) or (side == "bear" and c[m - 1] > stop): break   # setup invalidated
                if (side == "bull" and l[m] <= ce) or (side == "bear" and h[m] >= ce):
                    px = min(o[m], ce) if side == "bull" else max(o[m], ce)
                    fill = (m, px); break
            if fill:
                m, entry = fill
                if (entry - stop) * sg > 0:
                    risk = abs(entry - stop)
                    tg = dict(measured=edge + sg * H, **{f"{x}R": entry + sg * x * risk for x in (1, 2, 3)})
                    for name in BREAK_TARGETS:
                        add_trade("BREAK_CE_LIMIT", side, brk["known"], m, entry, stop, name, tg[name], True, dict(sweep_kind=None))
    return boxes, trades


def run_config(df, cfg, tf, start, daily=None):
    run_id = cfg["run_id"]
    B, T = [], []
    for sym, g in df.groupby("sym"):
        g = g.reset_index(drop=True)
        if tf == "1d":
            bz = rv.htf_bias(rv.weekly(g))
        else:
            dg = daily[daily.sym == sym].rename(columns={"do": "o", "dh": "h", "dl": "l", "dc": "c"})[["d", "o", "h", "l", "c"]].sort_values("d")
            bz = rv.htf_bias(dg.set_index("d"))
        b, t = run_sym(sym, g, cfg, tf, start, bz, run_id)
        B += b; T += t
    return pd.DataFrame(B), pd.DataFrame(T)


DDL = """
CREATE TABLE IF NOT EXISTS consolidation_runs (
  run_id text PRIMARY KEY, config_name text, timeframe text, period text, params jsonb, notes text,
  data_start date, data_end date, symbols int, created_at timestamptz DEFAULT now(), summary jsonb);
CREATE TABLE IF NOT EXISTS consolidation_boxes (
  run_id text, box_id text, sym text, start_date timestamp, confirm_date timestamp, end_date timestamp,
  box_hi double precision, box_lo double precision, ce double precision, height_pct double precision, height_atr double precision,
  bars int, dwell_bars int, top_tests int, bot_tests int, ce_crosses int, eqh jsonb, eql jsonb, atr_ratio double precision, pd_pos double precision,
  htf_bias int, sweep_side text, sweep_kind text, sweep_date timestamp, sweep_extreme double precision, sweep_depth_pct double precision,
  break_dir text, break_date timestamp, fate text, exp_mfe_h double precision, exp_mae_h double precision, expanded_1h boolean,
  PRIMARY KEY (run_id, box_id));
CREATE TABLE IF NOT EXISTS consolidation_trades (
  run_id text, trade_id text, box_id text, sym text, side text, model text, target text,
  trigger_date timestamp, entry_date timestamp, exit_date timestamp, entry double precision, stop double precision, tgt double precision,
  plan_r double precision, outcome text, r double precision, pct double precision, risk_pct double precision, bars_held int,
  risk_ok boolean, htf_bias int, pd_pos double precision, fate text, box_hi double precision, box_lo double precision, ce double precision,
  mfe_r double precision, with_bias boolean, sweep_kind text, PRIMARY KEY (run_id, trade_id));
CREATE INDEX IF NOT EXISTS consolidation_trades_run_idx ON consolidation_trades (run_id, model, target);
CREATE INDEX IF NOT EXISTS consolidation_boxes_run_idx ON consolidation_boxes (run_id);
ALTER TABLE consolidation_boxes ADD COLUMN IF NOT EXISTS eqh jsonb;
ALTER TABLE consolidation_boxes ADD COLUMN IF NOT EXISTS eql jsonb;
"""


def summarize(B, T):
    out = {"boxes": int(len(B))}
    if len(B):
        out["fates"] = B.fate.value_counts().to_dict()
        rb = B[B.break_dir.notna()]
        out["expanded_1h_pct"] = float(rb.expanded_1h.mean() * 100) if len(rb) else None
    if len(T):
        P = T[T.outcome.isin(["win", "loss", "timeout"]) & T.risk_ok]
        g = P.groupby(["model", "target"]).agg(n=("r", "size"), wins=("outcome", lambda x: int((x == "win").sum())), avg_r=("r", "mean")).reset_index()
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
            cfg = dict(cfg, run_id=f"CONS_{period}_{tf}_{cfg['name']}_{stamp}")
            t0 = dt.datetime.now()
            B, T = run_config(df, cfg, tf, start, daily)
            summ = summarize(B, T)
            print(f"== {cfg['run_id']}: boxes={len(B)} trades={len(T)} fates={summ.get('fates')} "
                  f"expanded>=1H={summ.get('expanded_1h_pct')} ({(dt.datetime.now() - t0).seconds}s)", flush=True)
            spec = TF_SPEC[tf]
            params = dict(timeframe=tf, h_mult=cfg["h_mult"], min_touch=cfg["min_touch"], reclaim=cfg["reclaim"], edge_eps=EDGE_EPS,
                          limit_expiry=LIMIT_EXP, min_risk_pct=MIN_RISK[tf], start=str(start.date()), data_quality=list(rv.DQ),
                          bias_source="weekly order flow" if tf == "1d" else "daily order flow", **spec)
            with con, con.cursor() as cur:
                cur.execute("DELETE FROM consolidation_trades WHERE run_id=%s", (cfg["run_id"],))
                cur.execute("DELETE FROM consolidation_boxes WHERE run_id=%s", (cfg["run_id"],))
                cur.execute("DELETE FROM consolidation_runs WHERE run_id=%s", (cfg["run_id"],))
                cur.execute("INSERT INTO consolidation_runs (run_id, config_name, timeframe, period, params, notes, data_start, data_end, symbols, summary) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                            (cfg["run_id"], cfg["name"], tf, period, json.dumps(params), cfg["note"], start.date(), df.d.max().date(),
                             int(df.sym.nunique()), json.dumps(summ, default=str)))
                rv.write_df(cur, "consolidation_boxes", B)
                rv.write_df(cur, "consolidation_trades", T)
            print("   written", flush=True)


if __name__ == "__main__":
    main()
