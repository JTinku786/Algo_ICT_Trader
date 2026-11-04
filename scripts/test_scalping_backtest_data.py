"""Source rollup oracles: full sessions, holes, native priority and causal close."""
import unittest
from scalping_backtest_data import hourly,merge_hourly,merge_daily_us
def bars(start,number):
    return [{'t':100000+i*300000,'day':'2020-01-02','minute':start+i*5,'o':1+i,'h':2+i,'l':i,'c':1.5+i,'v':1,'knownAt':100000+(i+1)*300000} for i in range(number)]
class RollupTests(unittest.TestCase):
    def test_forex_midnight_grid(self):
        b=bars(0,24);h=hourly(b,'forex');self.assertEqual(len(h),2);self.assertEqual(h[0]['knownAt'],b[11]['knownAt']);self.assertEqual(h[0]['h'],13)
    def test_hole_is_excluded(self):
        b=bars(0,24);del b[2];self.assertEqual(len(hourly(b,'forex')),1)
    def test_no_future_or_nonconsecutive_close(self):
        b=bars(0,12);b[-1]['knownAt']+=300000;self.assertEqual(hourly(b,'forex'),[])
    def test_us_grid_and_session_tail(self):
        b=bars(570,78);h=hourly(b,'us');self.assertEqual(len(h),7);self.assertEqual(h[-1]['minute'],930);self.assertEqual(h[-1]['knownAt'],b[-1]['knownAt'])
    def test_native_precedence_records_difference(self):
        b=bars(0,24);n=hourly(b,'forex')[0];n={**n,'h':100};h,a=merge_hourly([n],b,'forex');self.assertEqual(len(h),2);self.assertEqual(h[0]['h'],100);self.assertEqual(a['derivedInserted'],1);self.assertEqual(a['nativeDerivedDifferentOHLC'],1)
    def test_daily_full_session_only_and_native_priority(self):
        b=bars(570,78);d,a=merge_daily_us([],b);self.assertEqual(len(d),1);self.assertEqual(d[0]['knownAt'],b[-1]['knownAt']);self.assertEqual(a['derivedInserted'],1)
        self.assertEqual(merge_daily_us([],b[:-1])[0],[])
        native={**d[0],'h':999};d,a=merge_daily_us([native],b);self.assertEqual(d[0]['h'],999);self.assertEqual(a['derivedInserted'],0)
if __name__=='__main__':unittest.main()
