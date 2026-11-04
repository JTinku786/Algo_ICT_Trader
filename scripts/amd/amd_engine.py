"""ICT Power of Three / AMD study (Accumulation -> Manipulation -> Distribution), US equities 2017-2026.

Two families, both strictly causal (every level is built from bars that closed BEFORE the order is live):

STRUCTURAL AMD (1d / 1h / 30m) - joins the Consolidation, Reversal and Expansion studies:
  A  Accumulation  = a Consolidation box: >= min_bars spanning <= h_mult x ATR20(pre-box) with >= 2 swing highs in the
                     top 20% (EQH = buy stops) and >= 2 swing lows in the bottom 20% (EQL = sell stops). Edges freeze.
  M  Manipulation  = the first raid of an edge that RETURNS: a wick beyond that closes back inside, or a close beyond
                     that is reclaimed within 3 bars (2B / Judas). A close beyond that is NOT reclaimed = breakout with no
                     manipulation (logged, no trade). Both edges on one bar = news reset.
                     Expected distribution = opposite the raided side.
  D  Distribution  = after the return, a displacement candle (body >= 0.75 x ATR20, >= 50% of its range) in the expected
                     direction that CLOSES through the most recent confirmed internal swing (MSS - the Reversal tab's
                     rule). Invalidation: a close beyond the sweep extreme ("manipulation failed").
  Entries  MSS_FVG      fresh displacement FVG CE chosen at MSS close, else the gap completed by MSS+1;
                        order goes live AFTER both MSS and FVG complete, works LIMIT_EXP bars from activation.
           MSS_CLOSE    market, next open after the MSS candle.
           RETURN_CLOSE reference model of the AMD Po3 indicator: next open after the return bar, stop 0.4 x ATR past
                        the sweep, target the 1.5 fib extension of the manipulation leg.
  Stop     beyond the liquidity that was taken: sweep extreme -/+ 0.1 x ATR20 (0.4 for RETURN_CLOSE).
  Targets  (frozen at the decision bar, never recomputed)
           CE        accumulation 50%            opp_edge  the opposite accumulation edge = the resting EQH/EQL pool
           ext_pool  nearest UNSWEPT confirmed swing beyond the opposite edge (60-bar look-back) = next draw on liquidity
           fib_1.5   rangeEdge +/- 0.5 x manipulation leg     liq_2R  first liquidity level (CE, opp edge, pools) >= 2R
           2R        fixed reference

SESSION PO3 (30m / 1h) - ICT's daily Power of Three on the regular session:
  Equity session proxy = 09:30 RTH open (NOT ICT's midnight open; no overnight feed). Manipulation =
  price trades >= 0.1 x daily ATR BELOW the open before 11:00 (bullish day) / ABOVE it (bearish day). Trigger = the first bar before
  12:00 that closes back through the open after the Judas extreme formed. Entry next open; stop = Judas extreme
  -/+ 0.1 x daily ATR; targets PDH/PDL (prior-day liquidity), 2R, 3R, EOD (exit at the 16:00 close). Every trade is
  flat by the session close. One trade per day, the first side to trigger.

usage: python amd_engine.py [--tf 1d 1h 30m] [--start 2017-01-01]
"""
import json, os, sys, hashlib, datetime as dt
import numpy as np, pandas as pd

REV_DIR = os.environ.get("REVERSAL_ENGINE_DIR", r"C:\Users\saite\Desktop\ICT_Automation\trend_reversal_2026")
sys.path.insert(0, REV_DIR)
import reversal_engine as rv  # noqa: E402
import amd_data as data

ENGINE_VERSION = 'AMD_CAUSAL_V2'
SOURCE_HASH = hashlib.sha256(open(__file__,'rb').read()).hexdigest()

TF_SPEC = {
    "1d":  dict(min_bars=8,  max_active=30, max_dist=15, max_hold=30, ext_look=60),
    "1h":  dict(min_bars=10, max_active=42, max_dist=21, max_hold=42, ext_look=84),
    "30m": dict(min_bars=12, max_active=52, max_dist=26, max_hold=52, ext_look=117),
}
MIN_RISK = {"1d": 0.5, "1h": 0.25, "30m": 0.2}
EDGE_EPS, TOL_REL, RECL, LIMIT_EXP = 0.2, 1e-5, 3, 10
MSS_BODY, MSS_RATIO, STOP_BUF, REF_BUF, FIB_EXT = 0.75, 0.5, 0.1, 0.4, 1.5
JUDAS_MIN = 0.1         # session Po3: the Judas move must reach >= 0.1 x daily ATR beyond the open
CONFIGS = [
    dict(name="tight", h_mult=2.0, note="Accumulation = tight consolidation (span <= 2.0 x ATR20, EQH + EQL); M = raid that returns; D = MSS displacement"),
    dict(name="standard", h_mult=3.0, note="Accumulation = standard consolidation (span <= 3.0 x ATR20, EQH + EQL); M = raid that returns; D = MSS displacement"),
]
S_TARGETS = ("CE", "opp_edge", "ext_pool", "fib_1.5", "liq_2R", "2R")
P_TARGETS = ("PDH_PDL", "2R", "3R", "EOD")


def sid(*p):
    return hashlib.md5("|".join(map(str, p)).encode()).hexdigest()[:16]


def atr20(h, l, c):
    pc = np.concatenate([[np.nan], c[:-1]])
    tr = np.nanmax(np.vstack([h - l, np.abs(h - pc), np.abs(l - pc)]), axis=0)
    return pd.Series(tr).rolling(20, min_periods=20).mean().values


def swings(h, l):
    n = len(h); ph = np.zeros(n, bool); pl = np.zeros(n, bool)
    if n >= 3:
        ph[1:-1] = (h[1:-1] > h[:-2]) & (h[1:-1] >= h[2:])
        pl[1:-1] = (l[1:-1] < l[:-2]) & (l[1:-1] <= l[2:])
    return ph, pl


def tbucket(ts, tf):
    if tf == "1d": return "daily"
    m = ts.hour * 60 + ts.minute
    return "09:30-10:30" if m < 630 else "10:30-12:00" if m < 720 else "12:00-14:00" if m < 840 else "14:00-16:00"


def sim(o, h, l, c, side, e, entry, stop, tgt, is_limit, hold):
    rv.MAX_HOLD = hold
    return rv.simulate(o, h, l, c, side, e, entry, stop, tgt, "hard", is_limit)


def fvg_level(bottom,top,bull,mode='CE'):
    return (top+.01 if bull else bottom-.01) if mode=='EDGE' else (bottom+top)/2


def fvg_plan(o, h, l, c, bull, ret, mss, atr, opposite, mode='CE'):
    """Choose at the first eligible completed scan, never rank future fills.

    Prefer the latest still-unfilled displacement FVG already known at MSS;
    otherwise allow the three-candle FVG completed by MSS+1. CE entry and
    displacement thresholds are versioned local choices, not universal ICT rules.
    """
    sg = 1 if bull else -1
    for dec in range(mss, min(len(c), mss + 2)):
        if (bull and max(h[ret:dec+1]) >= opposite) or (not bull and min(l[ret:dec+1]) <= opposite):
            return None, 'draw_reached_before_activation'
        candidates = range(dec, max(ret, 1), -1) if dec == mss else [dec]
        for fk in candidates:
            if fk < 2: continue
            gap = l[fk] > h[fk-2] if bull else h[fk] < l[fk-2]
            body = (c[fk-1]-o[fk-1])*sg; width = h[fk-1]-l[fk-1]
            if not gap or body < MSS_BODY*atr or width <= 0 or body < MSS_RATIO*width: continue
            fb,ft = (h[fk-2],l[fk]) if bull else (h[fk],l[fk-2])
            ce = fvg_level(fb,ft,bull,mode)
            # A CE already traded before the order was possible is not a fresh entry.
            touched = (l[fk+1:dec+1] <= ce).any() if bull else (h[fk+1:dec+1] >= ce).any()
            if not touched: return (fk,float(fb),float(ft),dec), 'ready'
    return None, 'no_fresh_displacement_fvg'


def limit_fill(o,h,l,c,bull,ret,decision,level,stop,opposite,sweep=None):
    """Work one frozen order after decision. Prior closes cancel before next bar."""
    for m in range(decision+1,min(len(c),decision+1+LIMIT_EXP)):
        prev=m-1
        if sweep is not None and ((bull and c[prev]<sweep) or (not bull and c[prev]>sweep)):
            return None,'sweep_close_invalidated_before_fill'
        if (bull and l[prev]<=stop) or (not bull and h[prev]>=stop): return None,'stop_breached_before_fill'
        if (bull and h[prev]>=opposite) or (not bull and l[prev]<=opposite): return None,'draw_reached_before_fill'
        # An opening gap through invalidation cancels before any intrabar entry.
        if (bull and o[m]<=stop) or (not bull and o[m]>=stop): return None,'gap_through_stop'
        if (bull and l[m]<=level) or (not bull and h[m]>=level):
            return (m,float(min(o[m],level) if bull else max(o[m],level))),'filled'
    return None,'open_order' if decision+1+LIMIT_EXP>len(c) else 'expired'


# ----------------------------------------------------------------------------------------------------------- structural
def structural(sym, g, cfg, tf, start, bz, run_id):
    spec = TF_SPEC[tf]; MINB, HM, MAXA, MAXD = spec["min_bars"], cfg["h_mult"], spec["max_active"], spec["max_dist"]
    dates = pd.to_datetime(g.d); o, h, l, c = (g[k].values.astype(float) for k in "ohlc"); n = len(g)
    atr = atr20(h, l, c); ph, pl = swings(h, l)
    hi126 = pd.Series(h).rolling(126, min_periods=60).max().shift(1).values
    lo126 = pd.Series(l).rolling(126, min_periods=60).min().shift(1).values
    span = (pd.Series(h).rolling(MINB).max() - pd.Series(l).rolling(MINB).min()).shift(-(MINB - 1)).values
    ref = np.concatenate([[np.nan], atr[:-1]])
    cand = np.where(span <= HM * ref)[0]
    cycles, trades = [], []
    i_next = 0
    for s in cand:
        if s < i_next or s < 21: continue
        R = ref[s]; hi, lo = h[s], l[s]; conf = None
        for j in range(s + 1, n):
            nh, nl = max(hi, h[j]), min(lo, l[j])
            if nh - nl > HM * R: break
            hi, lo = nh, nl
            if j - s + 1 >= MINB and hi > lo:
                H = hi - lo; qs = np.arange(s, j)
                eqh = qs[ph[s:j] & (h[s:j] >= hi - EDGE_EPS * H)]; eql = qs[pl[s:j] & (l[s:j] <= lo + EDGE_EPS * H)]
                if len(eqh) >= 2 and len(eql) >= 2: conf = (j, eqh, eql); break
        if conf is None: continue
        j, eqh, eql = conf
        H = hi - lo; ce = (hi + lo) / 2; tol = TOL_REL * ce; HI, LO = hi + tol, lo - tol
        # ---------------- M: the first raid of an edge that returns inside
        last = min(n - 1, j + MAXA); pend = None; man = None; outcome = None; end = last; brk_dir = None
        k = j + 1
        while k <= last or (pend is not None and k <= n - 1):     # a raid inside the window keeps its 3-bar reclaim allowance
            if pend is None and h[k] > HI and l[k] < LO:
                outcome = "news_reset"; end = k; break
            if pend is not None:
                d_ = pend["side"]; pend["ext"] = max(pend["ext"], h[k]) if d_ == "up" else min(pend["ext"], l[k])
                if (c[k] <= HI) if d_ == "up" else (c[k] >= LO):
                    man = dict(side=d_, t0=pend["t"], ret=k, ext=pend["ext"], kind="2B"); break
                if k - pend["t"] >= RECL:
                    outcome = "breakout_no_manipulation"; brk_dir = d_; end = k; break
                k += 1; continue
            if c[k] > HI or c[k] < LO:
                pend = dict(side="up" if c[k] > HI else "dn", t=k, ext=h[k] if c[k] > HI else l[k])
            elif h[k] > HI or l[k] < LO:
                d_ = "up" if h[k] > HI else "dn"
                man = dict(side=d_, t0=k, ret=k, ext=h[k] if d_ == "up" else l[k], kind="wick"); break
            k += 1
        if man is None and outcome is None:
            outcome = "active" if j + MAXA > n - 1 or (pend is not None and pend["t"] + RECL > n - 1) else "expired"
        # ---------------- D: MSS displacement in the expected direction, before a close beyond the sweep extreme
        mss = None; mss_lvl = None; fvg = None; dist_end = None
        if man is not None:
            bull = man["side"] == "dn"; sg = 1 if bull else -1; X = man["ext"]; r0 = man["ret"]
            dmax = min(n - 1, r0 + MAXD); outcome = "unresolved"; end = dmax
            for k in range(r0, dmax + 1):
                if (bull and c[k] < X) or (not bull and c[k] > X):
                    outcome = "manipulation_failed"; end = k; break
                if mss is None:
                    # most recent internal swing confirmed before bar k (swing q known after q+1 <= k-1), formed inside the cycle
                    mask = ph if bull else pl
                    qs = np.where(mask[s:k - 1])[0]
                    if len(qs):
                        q = s + qs[-1]; lvl = h[q] if bull else l[q]
                        body = (c[k] - o[k]) * sg; rng = h[k] - l[k]
                        crossed = c[k-1] <= lvl < c[k] if bull else c[k-1] >= lvl > c[k]
                        if body >= MSS_BODY * R and rng > 0 and body >= MSS_RATIO * rng and crossed:
                            mss = k; mss_lvl = lvl; mss_swing = q
                if (bull and h[k] >= hi) or (not bull and l[k] <= lo):
                    outcome = "distribution_complete" if mss is not None and mss <= k else "distribution_no_mss"; end = k; break
            if outcome == "unresolved" and r0 + MAXD > n - 1: outcome = "active"
            if mss is not None:
                fvg, fvg_status = fvg_plan(o,h,l,c,bull,r0,mss,R,hi if bull else lo)
                dist_end = end
        i_next = end + 1
        if dates[j] < start: continue
        bias = rv.bias_at(bz, dates[j]); rng126 = hi126[j] - lo126[j]
        pd_pos = float((ce - lo126[j]) / rng126) if np.isfinite(rng126) and rng126 > 0 else None
        cyc_id = sid(run_id, sym, dates[s])
        cyc = dict(run_id=run_id, cycle_id=cyc_id, family="structural", sym=sym, acc_start=dates[s].to_pydatetime(),
                   acc_confirm=dates[j].to_pydatetime(), acc_hi=hi, acc_lo=lo, ce=ce, atr=float(R), acc_bars=int(j - s + 1),
                   eqh=json.dumps([[str(dates[q]), float(h[q])] for q in eqh]), eql=json.dumps([[str(dates[q]), float(l[q])] for q in eql]),
                   htf_bias=bias, pd_pos=pd_pos, outcome=outcome, end_date=dates[end].to_pydatetime(),
                   breakout_dir=brk_dir, manip_side=None, manip_kind=None, pierce_date=None, return_date=None, sweep_extreme=None,
                   sweep_depth_pct=None, manip_time=None, expected_dir=None, with_bias=None, mss_date=None, mss_level=None,
                   mss_swing_date=None, fvg=None, true_open=None, pdh=None, pdl=None, day=None,
                   entry_audit=json.dumps({'MSS_FVG':'no_mss' if mss is None else fvg_status}))
        if man is not None:
            bull = man["side"] == "dn"
            cyc.update(manip_side=man["side"], manip_kind=man["kind"], pierce_date=dates[man["t0"]].to_pydatetime(),
                       return_date=dates[man["ret"]].to_pydatetime(), sweep_extreme=float(man["ext"]),
                       sweep_depth_pct=float(abs(man["ext"] - (hi if man["side"] == "up" else lo)) / H * 100),
                       manip_time=tbucket(dates[man["t0"]], tf), expected_dir="bull" if bull else "bear",
                       with_bias=None if bias == 0 else bool((bias == 1) == bull),
                       mss_date=dates[mss].to_pydatetime() if mss is not None else None, mss_level=mss_lvl,
                       mss_swing_date=dates[mss_swing].to_pydatetime() if mss is not None else None,
                       fvg=json.dumps([str(dates[fvg[0] - 1]), float(fvg[1]), float(fvg[2])]) if fvg else None)
        cycles.append(cyc)
        if man is None: continue
        # ---------------- trades: every level frozen at the decision bar
        bull = man["side"] == "dn"; side = "bull" if bull else "bear"; sg = 1 if bull else -1; X = man["ext"]
        opp = hi if bull else lo

        def pools(dec):
            """unswept confirmed swings beyond the opposite edge, known at the decision bar (swing q needs q+1 <= dec)"""
            out = []
            a = max(2, dec - spec["ext_look"])
            for q in range(a, dec):
                if bull and ph[q] and h[q] > opp and h[q + 1:dec + 1].max() <= h[q]: out.append(float(h[q]))
                if not bull and pl[q] and l[q] < opp and l[q + 1:dec + 1].min() >= l[q]: out.append(float(l[q]))
            return sorted(set(out), reverse=not bull)

        def add(model, dec, e, entry, stop, is_limit, planned_entry=None,entry_fvg=None):
            if e >= n: return
            assert dec < e, 'Order cannot fill on/before its decision candle'
            if model.startswith('MSS'): assert mss is not None and mss <= dec < e
            risk = (entry - stop) * sg
            if risk <= 0: return
            chosen=entry_fvg if entry_fvg is not None else fvg
            basis = entry if planned_entry is None else planned_entry
            planned_risk = (basis-stop)*sg
            if planned_risk <= 0: return
            pl_ = pools(dec)
            ladder = [ce, opp] + pl_
            liq = next((p for p in ladder if (p - basis) * sg >= 2 * planned_risk), None)
            tg = {"CE": ce, "opp_edge": opp, "ext_pool": pl_[0] if pl_ else None,
                  "fib_1.5": (hi + (FIB_EXT - 1) * (hi - X)) if bull else (lo - (FIB_EXT - 1) * (X - lo)),
                  "liq_2R": liq, "2R": basis + sg * 2 * planned_risk}
            for name in S_TARGETS:
                tgt = tg[name]
                if tgt is None or (tgt - entry) * sg <= 0: continue
                out, px, x = sim(o, h, l, c, side, e, entry, stop, tgt, is_limit, spec["max_hold"])
                r = (px - entry) * sg / risk
                mfe = ((h[e:x + 1].max() - entry) if bull else (entry - l[e:x + 1].min())) / risk
                trades.append(dict(run_id=run_id, trade_id=sid(cyc_id, model, name), cycle_id=cyc_id, family="structural", sym=sym,
                                   side=side, model=model, target=name, decision_date=dates[dec].to_pydatetime(),
                                   entry_date=dates[e].to_pydatetime(), exit_date=dates[x].to_pydatetime(), entry=float(entry),
                                   stop=float(stop), tgt=float(tgt), plan_r=float((tgt - entry) * sg / risk), outcome=out, r=float(r),
                                   pct=float((px - entry) * sg / entry * 100), risk_pct=float(risk / entry * 100), bars_held=int(x - e),
                                   risk_ok=bool(risk / entry * 100 >= MIN_RISK[tf]), htf_bias=bias, with_bias=cyc["with_bias"],
                                   cycle_outcome=outcome, mfe_r=float(mfe), pools=json.dumps(pl_[:4]),
                                   planned_entry=float(basis), fvg_formed_at=dates[chosen[0]].to_pydatetime() if is_limit else None,
                                   fvg_evidence=json.dumps([str(dates[chosen[0]-1]),float(chosen[1]),float(chosen[2])]) if is_limit else None,
                                   mss_known_at=data.known_at(dates[mss],tf) if model.startswith('MSS') else None,
                                   fvg_known_at=data.known_at(dates[chosen[0]],tf) if is_limit else None,
                                   decision_known_at=data.known_at(dates[dec],tf),order_active_at=data.open_at(dates[dec+1],tf),
                                   entry_not_before=data.open_at(dates[e],tf),exit_known_at=data.known_at(dates[x],tf)))
        stop_mss = X - sg * STOP_BUF * R
        # RETURN_CLOSE (reference indicator model)
        if man["ret"] + 1 < n:
            add("RETURN_CLOSE", man["ret"], man["ret"] + 1, o[man["ret"] + 1], X - sg * REF_BUF * R, False)
        if mss is not None and mss + 1 < n:
            add("MSS_CLOSE", mss, mss + 1, o[mss + 1], stop_mss, False)
        if mss is not None:
            for mode,model in [('CE','MSS_FVG'),('EDGE','MSS_FVG_EDGE')]:
                selected,status=(fvg,fvg_status) if mode=='CE' else fvg_plan(o,h,l,c,bull,man['ret'],mss,R,opp,'EDGE')
                audit=json.loads(cyc['entry_audit'])
                if selected is None:
                    audit[model]=status;cyc['entry_audit']=json.dumps(audit);continue
                fk, fb, ft, dec = selected; lv = fvg_level(fb,ft,bull,mode)
                fill,status=limit_fill(o,h,l,c,bull,man['ret'],dec,lv,stop_mss,opp,X)
                audit[model]=status;cyc['entry_audit']=json.dumps(audit)
                if fill is not None:
                    m,price=fill
                    add(model,dec,m,price,stop_mss,True,lv,selected)
    return cycles, trades


# --------------------------------------------------------------------------------------------------------- session po3
def session_po3(sym, g, tf, start, daily_sym, bz, run_id):
    dates = pd.to_datetime(g.d); o, h, l, c = (g[k].values.astype(float) for k in "ohlc"); n = len(g)
    day = dates.dt.normalize().values
    dg = daily_sym.sort_values("d").reset_index(drop=True)
    datr = atr20(dg.h.values.astype(float), dg.l.values.astype(float), dg.c.values.astype(float))
    daily_positions={day:i for i,day in enumerate(data.clock('1d'))}
    cycles, trades = [], []
    starts = np.flatnonzero(np.r_[True, day[1:] != day[:-1]])
    ends = np.r_[starts[1:] - 1, n - 1]
    for a, b in zip(starts, ends):
        D = pd.Timestamp(day[a])
        if D < start: continue
        # Today's daily row is not required: only prior completed days may
        # determine the morning input set or ATR/PDH/PDL.
        di = int(np.searchsorted(pd.to_datetime(dg.d).values,np.datetime64(D),side='left'))
        if di < 21 or dates[a].hour * 60 + dates[a].minute != 570: continue        # need a 09:30 first bar
        if 'segment' in dg and dg.segment.iloc[di-21:di].nunique()!=1: continue
        if daily_positions.get(D,-1)-daily_positions.get(pd.Timestamp(dg.d.iloc[di-1]),-100)!=1: continue
        R = datr[di - 1]; pdh, pdl = float(dg.h.iat[di - 1]), float(dg.l.iat[di - 1])
        if not np.isfinite(R) or R <= 0: continue
        O = o[a]; bias = rv.bias_at(bz, D)
        lo_, hi_ = l[a], h[a]; lo_t, hi_t = a, a; trig = None
        for k in range(a, b + 1):
            close = pd.Timestamp(data.known_at(dates[k],tf)).tz_convert('America/New_York')
            mins = close.hour * 60 + close.minute
            if k > a:
                if l[k] < lo_ and mins <= 660: lo_, lo_t = l[k], k
                if h[k] > hi_ and mins <= 660: hi_, hi_t = h[k], k
            if mins >= 720: break
            # bullish Po3: Judas below the open made before 11:00, then a close back above the open
            # (the Judas extreme may print on the trigger bar itself: a wick through the open that closes back = sweep + return)
            if O - lo_ >= JUDAS_MIN * R and c[k] > O and pd.Timestamp(data.known_at(dates[lo_t],tf)).tz_convert('America/New_York').time() <= dt.time(11):
                trig = ("bull", k, lo_, lo_t); break
            if hi_ - O >= JUDAS_MIN * R and c[k] < O and pd.Timestamp(data.known_at(dates[hi_t],tf)).tz_convert('America/New_York').time() <= dt.time(11):
                trig = ("bear", k, hi_, hi_t); break
        cyc_id = sid(run_id, sym, D)
        base = dict(run_id=run_id, cycle_id=cyc_id, family="session", sym=sym, day=D.to_pydatetime(), true_open=float(O), pdh=pdh, pdl=pdl,
                    atr=float(R), htf_bias=bias, acc_start=dates[a].to_pydatetime(), acc_confirm=dates[a].to_pydatetime(),
                    acc_hi=None, acc_lo=None, ce=None, acc_bars=None, eqh=None, eql=None, pd_pos=None, breakout_dir=None,
                    mss_date=None, mss_level=None, mss_swing_date=None, fvg=None, end_date=dates[b].to_pydatetime(), sweep_depth_pct=None,entry_audit='{}')
        # day classification (descriptive only, uses the whole day): did the session close on the expected side of the open?
        if trig is None:
            cycles.append({**base, "outcome": "no_judas", "manip_side": None, "manip_kind": None, "pierce_date": None, "return_date": None,
                           "sweep_extreme": None, "manip_time": None, "expected_dir": None, "with_bias": None})
            continue
        side, k, ext, et = trig; bull = side == "bull"; sg = 1 if bull else -1
        closed_ok = (c[b] > O) if bull else (c[b] < O)
        expected_close=data.schedule().loc[D,'close'].tz_convert('America/New_York').tz_localize(None)
        tail_complete=pd.Timestamp(data.known_at(dates[b],tf)).tz_convert('America/New_York').tz_localize(None)==expected_close
        gapped = not (pdl <= O <= pdh)                       # opened outside yesterday's range: a gap, not a raid
        swept = (not gapped) and ((ext < pdl) if bull else (ext > pdh))
        cyc = {**base, "outcome": ("po3_day_complete" if closed_ok else "po3_day_failed") if tail_complete else 'active', "manip_side": "dn" if bull else "up",
               "manip_kind": "opened_outside_prior_range" if gapped else "swept_PDL" if (bull and swept) else "swept_PDH" if swept else "inside_prior_range",
               "pierce_date": dates[et].to_pydatetime(), "return_date": dates[k].to_pydatetime(), "sweep_extreme": float(ext),
               "sweep_depth_pct": float(abs(O - ext) / R * 100), "manip_time": tbucket(dates[et], tf), "expected_dir": side,
               "with_bias": None if bias == 0 else bool((bias == 1) == bull)}
        cycles.append(cyc)
        e = k + 1
        if e > b: continue
        entry = o[e]; stop = ext - sg * STOP_BUF * R; risk = (entry - stop) * sg
        if risk <= 0: continue
        hold = b - e + 1
        tg = {"PDH_PDL": pdh if bull else pdl, "2R": entry + sg * 2 * risk, "3R": entry + sg * 3 * risk, "EOD": entry + sg * 1e6}
        for name in P_TARGETS:
            tgt = tg[name]
            if (tgt - entry) * sg <= 0: continue
            out, px, x = sim(o, h, l, c, side, e, entry, stop, tgt, False, hold)
            expected_close=data.schedule().loc[D,'close'].tz_convert('America/New_York').tz_localize(None)
            if out=='timeout' and pd.Timestamp(data.known_at(dates[b],tf)).tz_convert('America/New_York').tz_localize(None)<expected_close:
                out='open'  # partial tail/gap: do not invent a session close
            r = (px - entry) * sg / risk
            mfe = ((h[e:x + 1].max() - entry) if bull else (entry - l[e:x + 1].min())) / risk
            trades.append(dict(run_id=run_id, trade_id=sid(cyc_id, "PO3_SESSION", name), cycle_id=cyc_id, family="session", sym=sym,
                               side=side, model="PO3_SESSION", target=name, decision_date=dates[k].to_pydatetime(),
                               entry_date=dates[e].to_pydatetime(), exit_date=dates[x].to_pydatetime(), entry=float(entry), stop=float(stop),
                               tgt=float(tgt) if name != "EOD" else None, plan_r=float((tgt - entry) * sg / risk) if name != "EOD" else None,
                               outcome=out, r=float(r), pct=float((px - entry) * sg / entry * 100), risk_pct=float(risk / entry * 100),
                               bars_held=int(x - e), risk_ok=bool(risk / entry * 100 >= MIN_RISK[tf]), htf_bias=bias,
                               with_bias=cyc["with_bias"], cycle_outcome=cyc["outcome"], mfe_r=float(mfe), pools=None,
                               planned_entry=float(entry),fvg_formed_at=None,mss_known_at=None,fvg_known_at=None,
                               decision_known_at=data.known_at(dates[k],tf),order_active_at=data.open_at(dates[e],tf),
                               entry_not_before=data.open_at(dates[e],tf),exit_known_at=data.known_at(dates[x],tf)))
    return cycles, trades


DDL = """
CREATE TABLE IF NOT EXISTS amd_runs (run_id text PRIMARY KEY, config_name text, family text, timeframe text, period text, params jsonb,
  notes text, data_start date, data_end date, symbols int, created_at timestamptz DEFAULT now(), summary jsonb);
CREATE TABLE IF NOT EXISTS amd_cycles (run_id text, cycle_id text, family text, sym text, day timestamp, acc_start timestamp, acc_confirm timestamp,
  acc_hi double precision, acc_lo double precision, ce double precision, atr double precision, acc_bars int, eqh jsonb, eql jsonb,
  htf_bias int, pd_pos double precision, outcome text, end_date timestamp, breakout_dir text, manip_side text, manip_kind text,
  pierce_date timestamp, return_date timestamp, sweep_extreme double precision, sweep_depth_pct double precision, manip_time text,
  expected_dir text, with_bias boolean, mss_date timestamp, mss_level double precision, mss_swing_date timestamp, fvg jsonb,
  true_open double precision, pdh double precision, pdl double precision, PRIMARY KEY (run_id, cycle_id));
CREATE TABLE IF NOT EXISTS amd_trades (run_id text, trade_id text, cycle_id text, family text, sym text, side text, model text, target text,
  decision_date timestamp, entry_date timestamp, exit_date timestamp, entry double precision, stop double precision, tgt double precision,
  plan_r double precision, outcome text, r double precision, pct double precision, risk_pct double precision, bars_held int, risk_ok boolean,
  htf_bias int, with_bias boolean, cycle_outcome text, mfe_r double precision, pools jsonb, PRIMARY KEY (run_id, trade_id));
CREATE INDEX IF NOT EXISTS amd_trades_run_idx ON amd_trades (run_id, model, target);
CREATE INDEX IF NOT EXISTS amd_cycles_run_idx ON amd_cycles (run_id);
ALTER TABLE amd_cycles ADD COLUMN IF NOT EXISTS entry_audit jsonb;
ALTER TABLE amd_trades ADD COLUMN IF NOT EXISTS planned_entry double precision;
ALTER TABLE amd_trades ADD COLUMN IF NOT EXISTS fvg_evidence jsonb;
ALTER TABLE amd_trades ADD COLUMN IF NOT EXISTS fvg_formed_at timestamp;
ALTER TABLE amd_trades ADD COLUMN IF NOT EXISTS mss_known_at timestamptz;
ALTER TABLE amd_trades ADD COLUMN IF NOT EXISTS fvg_known_at timestamptz;
ALTER TABLE amd_trades ADD COLUMN IF NOT EXISTS decision_known_at timestamptz;
ALTER TABLE amd_trades ADD COLUMN IF NOT EXISTS order_active_at timestamptz;
ALTER TABLE amd_trades ADD COLUMN IF NOT EXISTS entry_not_before timestamptz;
ALTER TABLE amd_trades ADD COLUMN IF NOT EXISTS exit_known_at timestamptz;
"""


def main():
    def _args(flag):
        out = []
        for a_ in sys.argv[sys.argv.index(flag) + 1:]:
            if a_.startswith("--"): break
            out.append(a_)
        return out
    tfs = _args("--tf") if "--tf" in sys.argv else ["1d", "1h", "30m"]
    start = pd.Timestamp(sys.argv[sys.argv.index("--start") + 1]) if "--start" in sys.argv else pd.Timestamp("2017-01-01")
    period = "FULL"
    rv.MARKET = "us"; rv.START = start; rv.LOAD_FROM = str((start - pd.Timedelta(days=550)).date())
    import psycopg2
    con = psycopg2.connect(rv.db_uri())
    with con, con.cursor() as cur:
        cur.execute(DDL)
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    daily_raw,daily_dq=data.load(con,'1d',start)
    for tf in tfs:
        df,dq=(daily_raw,daily_dq) if tf=='1d' else data.load(con,tf,start)
        print(f"\n##### {tf}: bars={len(df)} symbols={df.sym.nunique()} range={df.d.min()}..{df.d.max()}", flush=True)
        jobs = [dict(c_, family="structural") for c_ in CONFIGS]
        if tf != "1d":
            jobs.append(dict(name="session", family="session", h_mult=None,
                             note="Daily Po3 on the regular session: Judas move through the 09:30 open before 11:00, close back through it before 12:00"))
        if '--structural-only' in sys.argv: jobs=[job for job in jobs if job['family']=='structural']
        for cfg in jobs:
            run_id = f"AMD_V2_{period}_{tf}_{cfg['name']}_{stamp}"
            C, T = [], []
            bias_map={}
            for sym,dg in daily_raw.groupby('sym'):
                frame=rv.weekly(dg) if tf=='1d' else dg.set_index('d')
                bias_map[sym]=rv.htf_bias(frame)
            for sym, g in data.groups(df):
                if sym not in bias_map: continue
                bz=bias_map[sym]
                if cfg["family"] == "structural":
                    a_, b_ = structural(sym, g, cfg, tf, start, bz, run_id)
                else:
                    ds = daily_raw[daily_raw.sym == sym][["d", "o", "h", "l", "c", "segment"]]
                    a_, b_ = session_po3(sym, g, tf, start, ds, bz, run_id)
                C += a_; T += b_
            C, T = pd.DataFrame(C), pd.DataFrame(T)
            from amd_validation import validate
            validation=validate(C,T,df,tf)
            if validation['failures']: raise RuntimeError(f"Causal validation failed: {validation['failures'][:10]}")
            summ = {"cycles": int(len(C)), "outcomes": C.outcome.value_counts().to_dict() if len(C) else {}}
            summ['validation']=validation
            summ['eligibility']='historical_research_only'
            summ['entry_audit']=C.entry_audit.map(json.loads).map(lambda x:x.get('MSS_FVG','session')).value_counts().to_dict() if len(C) else {}
            if len(T):
                P = T[T.outcome.isin(["win", "loss", "timeout"]) & T.risk_ok]
                summ["grid"] = [{k: rv.to_py(v) for k, v in r.items()} for r in
                                P.groupby(["model", "target"]).agg(n=("r", "size"), avg_r=("r", "mean")).reset_index().to_dict("records")]
            print(f"== {run_id}: cycles={len(C)} trades={len(T)} outcomes={summ['outcomes']}", flush=True)
            params = dict(timeframe=tf, family=cfg["family"], h_mult=cfg.get("h_mult"), mss_body=MSS_BODY, mss_ratio=MSS_RATIO,
                          stop_buf_atr=STOP_BUF, ref_buf_atr=REF_BUF, fib_ext=FIB_EXT, reclaim=RECL, limit_expiry=LIMIT_EXP,
                          min_risk_pct=MIN_RISK[tf], start=str(start.date()), data_quality=list(dq),
                          engine_version=ENGINE_VERSION,data_version=data.VERSION,causal_validation='full_population_v2',
                          spec_version='amd-local-v2.1',clock='XNYS completed candles; next bar execution proxy',
                          source_hash=SOURCE_HASH,
                          data_hash=hashlib.sha256(pd.util.hash_pandas_object(df[['sym','d',*'ohlc']],index=False).values.tobytes()).hexdigest(),
                          rule_lineage='LOCAL_ADAPTATION; source-literal lesson verification not claimed',
                          bias_source="weekly order flow" if tf == "1d" else "daily order flow", **TF_SPEC[tf])
            with con, con.cursor() as cur:
                cur.execute("INSERT INTO amd_runs (run_id, config_name, family, timeframe, period, params, notes, data_start, data_end, symbols, summary) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                            (run_id, cfg["name"], cfg["family"], tf, period, json.dumps(params), cfg["note"], start.date(), df.d.max().date(),
                             int(df.sym.nunique()), json.dumps(summ, default=str)))
                rv.write_df(cur, "amd_cycles", C); rv.write_df(cur, "amd_trades", T)
            print("   written", flush=True)


if __name__ == "__main__":
    main()
