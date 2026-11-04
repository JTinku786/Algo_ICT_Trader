import sys
from pathlib import Path
import unittest
import numpy as np
import pandas as pd
sys.path.insert(0,str(Path(__file__).parent))
import amd_engine as ae
import amd_data as data

class CausalTests(unittest.TestCase):
    def arrays(self):
        o=np.array([100,100,100,103,104,104,106,106,108,108.],float)
        h=np.array([101,101,105,104,105,107,108,109,110,110.],float)
        l=np.array([99,99,99,103,103,104,106,105,107,107.],float)
        c=np.array([100,100,104,104,104,106,107,108,109,109.],float)
        return o,h,l,c

    def test_old_fvg_never_backdates_activation_before_mss(self):
        o,h,l,c=self.arrays()
        plan,status=ae.fvg_plan(o,h,l,c,True,1,5,1,200)
        self.assertEqual(status,'ready'); self.assertEqual(plan[0],3); self.assertEqual(plan[3],5)
        # A touch before MSS would disqualify the old CE instead of creating a trade.
        l[4]=102
        replacement,status=ae.fvg_plan(o,h,l,c,True,1,5,1,200)
        self.assertNotEqual(replacement[0] if replacement else None,3)

    def test_fresh_mss_plus_one_gap_is_recovered_after_old_gap_was_used(self):
        o,h,l,c=self.arrays(); l[4]=101.5; l[5]=103; o[5]=103
        plan,status=ae.fvg_plan(o,h,l,c,True,1,5,1,200)
        self.assertEqual(status,'ready'); self.assertEqual(plan[0],6); self.assertEqual(plan[3],6)

    def test_fill_search_starts_after_combined_confirmation(self):
        o,h,l,c=self.arrays(); l[4]=101; l[7]=102
        fill,status=ae.limit_fill(o,h,l,c,True,1,5,102,98,200)
        self.assertEqual(status,'filled'); self.assertEqual(fill[0],7)

    def test_cancel_before_fill_when_draw_already_reached(self):
        o,h,l,c=self.arrays(); h[5]=201; l[6]=102
        fill,status=ae.limit_fill(o,h,l,c,True,1,5,102,98,200)
        self.assertIsNone(fill); self.assertEqual(status,'draw_reached_before_fill')

    def test_close_through_sweep_cancels_even_inside_stop_buffer(self):
        o,h,l,c=self.arrays(); l[5]=98.8; c[5]=98.9; l[6]=102
        fill,status=ae.limit_fill(o,h,l,c,True,1,5,102,98,200,sweep=99)
        self.assertIsNone(fill); self.assertEqual(status,'sweep_close_invalidated_before_fill')

    def test_future_prices_do_not_change_an_already_known_plan(self):
        o,h,l,c=self.arrays()
        before=ae.fvg_plan(o[:6],h[:6],l[:6],c[:6],True,1,5,1,200)
        h[6:]=1000; l[6:]=1; c[6:]=500
        after=ae.fvg_plan(o,h,l,c,True,1,5,1,200)
        self.assertEqual(before,after)

    def test_raw_input_prefix_is_not_repaired_from_future_prices(self):
        g=pd.DataFrame({'sym':['X']*4,'d':pd.to_datetime(['2026-10-09 09:30','2026-10-09 10:00','2026-10-09 11:00','2026-10-09 11:30']),'o':[100]*4,'h':[101,102,105,110],'l':[99]*4,'c':[100]*4})
        prefix=data.finish(g.iloc[:2],'30m',[])
        full=data.finish(g,'30m',[])
        pd.testing.assert_frame_equal(prefix,full.iloc[:2].reset_index(drop=True))
        self.assertNotEqual(full.segment.iloc[1],full.segment.iloc[2])
        self.assertEqual(len(full),4)  # missing 10:30 stays absent

    def test_invalid_ohlc_is_quarantined_not_repaired(self):
        g=pd.DataFrame({'sym':['X'],'d':pd.to_datetime(['2026-10-09 09:30']),'o':[100.],'h':[99.],'l':[98.],'c':[100.]})
        self.assertEqual(len(data.finish(g,'30m',[])),0)

    def test_exchange_calendar_early_close(self):
        close=pd.Timestamp(data.known_at(pd.Timestamp('2025-11-28 12:30'),'1h')).tz_convert('America/New_York')
        self.assertEqual((close.hour,close.minute),(13,0))

    def test_hourly_1130_is_known_at_1230_not_1130(self):
        close=pd.Timestamp(data.known_at(pd.Timestamp('2026-10-09 11:30'),'1h')).tz_convert('America/New_York')
        self.assertEqual((close.hour,close.minute),(12,30))

    def test_mirrored_bearish_plan_obeys_same_clock(self):
        o,h,l,c=self.arrays()
        bull=ae.fvg_plan(o,h,l,c,True,1,5,1,200)[0]
        bear=ae.fvg_plan(300-o,300-l,300-h,300-c,False,1,5,1,100)[0]
        self.assertEqual(bull[0],bear[0]); self.assertEqual(bull[3],bear[3])

    def test_shallow_return_fills_edge_without_reaching_ce(self):
        o,h,l,c=self.arrays(); o[6]=106; l[6]=104; l[7:]=104
        edge,status=ae.limit_fill(o,h,l,c,True,1,5,104.01,98,200,sweep=99)
        ce,other=ae.limit_fill(o,h,l,c,True,1,5,102,98,200,sweep=99)
        self.assertEqual(status,'filled');self.assertEqual(edge[0],6);self.assertIsNone(ce)
        self.assertEqual(ae.fvg_level(101,104,True,'EDGE'),104.01)
        self.assertEqual(ae.fvg_level(101,104,False,'EDGE'),100.99)

    def test_session_does_not_require_or_read_todays_daily_bar(self):
        day=pd.Timestamp('2026-10-09')
        prior=[d for d in data.clock('1d') if d<day][-25:]
        daily=pd.DataFrame({'d':prior,'o':100.,'h':101.,'l':99.,'c':100.,'segment':1})
        dates=pd.date_range(day+pd.Timedelta(hours=9,minutes=30),periods=13,freq='30min')
        g=pd.DataFrame({'d':dates,'o':100.3,'h':101.,'l':100.,'c':100.5})
        g.loc[0,['o','h','l','c']]=[100.,100.5,99.,100.3]
        bias=(np.array([],dtype='datetime64[ns]'),np.array([],dtype=int))
        _,before=ae.session_po3('X',g,'30m',day,daily,bias,'test')
        today=pd.DataFrame({'d':[day],'o':[1.],'h':[10000.],'l':[.01],'c':[9999.],'segment':[1]})
        _,after=ae.session_po3('X',g,'30m',day,pd.concat([daily,today]),bias,'test')
        self.assertTrue(before)
        self.assertEqual(before,after)

if __name__=='__main__': unittest.main()
