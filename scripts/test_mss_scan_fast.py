"""Compare every zone/event field against the unchanged completed-prefix scanner."""
import importlib.util
import json
import unittest
from pathlib import Path
import numpy as np
import pandas as pd
from smartmoneyconcepts import smc
import mss_scan_fast as fast

ROOT=Path(__file__).parent
spec=importlib.util.spec_from_file_location('scanner_reference',ROOT/'market-structure-shift.py')
reference=importlib.util.module_from_spec(spec);spec.loader.exec_module(reference)


def generated(seed,n):
    rng=np.random.default_rng(seed);close=np.cumsum(rng.normal(0,.3,n))+100
    open_=np.r_[close[0]-.1,close[:-1]];high=np.maximum(open_,close)+rng.uniform(0,.4,n)
    low=np.minimum(open_,close)-rng.uniform(0,.4,n)
    # Ties and dojis exercise native HighLow high-priority and pruning behavior.
    if seed==2:
        high[10:14]=max(high[10:14]);low[25:29]=min(low[25:29]);close[40:43]=open_[40:43]
    return [{'t':j*300000,'knownAt':(j+1)*300000,'day':'2026-01-01',
             'o':float(open_[j]),'h':float(high[j]),'l':float(low[j]),'c':float(close[j]),'v':float(rng.integers(0,1000))} for j in range(n)]


class FastScannerParity(unittest.TestCase):
    def test_every_prefix_native_swing_pruning(self):
        for seed in [1,2,3]:
            bars=generated(seed,120)
            for end in range(8,len(bars)+1):
                subset=bars[:end];frame=pd.DataFrame([{'open':b['o'],'high':b['h'],'low':b['l'],'close':b['c']} for b in subset])
                native=smc.swing_highs_lows(frame,swing_length=3)
                native.loc[[j for j in range(end) if j<3 or j>end-4],['HighLow','Level']]=np.nan
                signs,levels=fast._swings(frame.high.to_numpy(),frame.low.to_numpy())
                np.testing.assert_array_equal(signs,native.HighLow.to_numpy())
                np.testing.assert_array_equal(levels,native.Level.to_numpy())

    def test_full_random_scanner_close_and_wick(self):
        for seed in [1,2,3]:
            bars=generated(seed,110)
            for close_break in [True,False]:
                self.assertEqual(reference.scan(bars,'5m',close_break),fast.scan(bars,'5m',close_break))

    def test_actual_stored_prefixes_all_payload_fields(self):
        data=json.loads((ROOT/'mss-smoke-input.json').read_text(encoding='utf-8'))
        for end in [8,75,180]:
            for close_break in [True,False]:
                bars=data['lower'][:end]
                self.assertEqual(reference.scan(bars,'5m',close_break),fast.scan(bars,'5m',close_break))


if __name__=='__main__':unittest.main()
