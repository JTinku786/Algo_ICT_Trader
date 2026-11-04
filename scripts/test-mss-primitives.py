"""Exact native-library parity, including prefix timing and float32 boundaries."""
import os
os.environ['SMC_CREDIT'] = '0'
import importlib.util
from pathlib import Path
import numpy as np
import pandas as pd
from smartmoneyconcepts import smc
import mss_primitives as fast

spec = importlib.util.spec_from_file_location('mss', Path(__file__).with_name('market-structure-shift.py'))
mss = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mss)
rng = np.random.default_rng(901)

for style in ('random', 'ties', 'flat', 'forex'):
    scale = .0002 if style == 'forex' else 1
    close = (1.15 if style == 'forex' else 100) + np.cumsum(rng.normal(0, scale, 150))
    open_ = np.r_[close[0], close[:-1]]
    high, low = np.maximum(open_, close) + rng.uniform(0, scale, 150), np.minimum(open_, close) - rng.uniform(0, scale, 150)
    if style == 'ties':
        open_, high, low, close = (np.round(x) for x in (open_, high, low, close))
    if style == 'flat':
        open_[:], high[:], low[:], close[:] = 100, 101, 99, 100
    volume = np.zeros(150) if style in ('flat', 'forex') else rng.integers(0, 100000, 150)
    df = pd.DataFrame(dict(open=open_, high=high, low=low, close=close, volume=volume))
    for n in range(8, len(df)+1):
        prefix = df.iloc[:n]
        swings = smc.swing_highs_lows(prefix, swing_length=3)
        swings.loc[(swings.index < 3) | (swings.index > n-4), ['HighLow', 'Level']] = np.nan
        for name, kwargs in [('liquidity', dict(range_percent=.01)), ('bos_choch', dict(close_break=True)), ('bos_choch', dict(close_break=False)), ('ob', dict(close_mitigation=True))]:
            pd.testing.assert_frame_equal(getattr(smc, name)(prefix, swings, **kwargs), getattr(fast, name)(prefix, swings, **kwargs), check_exact=True)
        a = smc.fvg(prefix, join_consecutive=False).iloc[-2][['FVG', 'Top', 'Bottom']]
        b = smc.fvg(prefix.iloc[-3:].reset_index(drop=True), join_consecutive=False).iloc[1][['FVG', 'Top', 'Bottom']]
        pd.testing.assert_series_equal(a, b, check_exact=True, check_names=False)
    bars = [dict(t=i*60000, knownAt=(i+1)*60000, day='2026-08-27', o=float(r.open), h=float(r.high), l=float(r.low), c=float(r.close), v=float(r.volume)) for i, r in enumerate(df.itertuples())]
    mss.primitives = smc
    native = mss.scan(bars, '1m')
    mss.primitives = fast
    assert native == mss.scan(bars, '1m'), style
    mss.primitives = smc
    native_wick = mss.scan(bars, '1m', close_break=False)
    mss.primitives = fast
    assert native_wick == mss.scan(bars, '1m', close_break=False), style
print('PASS: all columns exactly match native SMC across 572 prefixes; complete scanner parity for random, ties, flat and forex candles')
