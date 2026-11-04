import random,unittest,time
from scalping_backtest_compact import ReplayBars,FirstHitIndex
from scalping_backtest_validation import evaluate_trade

def fixture(count,seed=41):
    rnd=random.Random(seed);price=100;out=[]
    for i in range(count):
        o=price;c=o+rnd.uniform(-2,2);h=max(o,c)+rnd.random();l=min(o,c)-rnd.random();price=c
        out.append({'t':i*300000,'knownAt':(i+1)*300000,'day':'2020-01-02','minute':i%1440,'o':o,'h':h,'l':l,'c':c,'v':rnd.randint(0,100)})
    return out
class CompactTests(unittest.TestCase):
    def test_exact_dictionary_roundtrip_and_slices(self):
        bars=fixture(101);compact=ReplayBars(bars);self.assertEqual(compact[:],bars);self.assertEqual(compact[10:30],bars[10:30]);self.assertEqual(compact[-1],bars[-1])
    def test_day_and_clock_boundaries(self):
        bars=fixture(3);bars[2]['day']='2020-01-03';c=ReplayBars(bars)
        self.assertEqual(c.day_index('2020-01-02'),0);self.assertEqual(c.day_index('2020-01-02','right'),2);self.assertEqual(c.clock_index(300000),2)
    def test_oracle_random_both_directions_and_thresholds(self):
        bars=fixture(3000);c=ReplayBars(bars);index=FirstHitIndex(c);rnd=random.Random(53)
        for _ in range(1500):
            i=rnd.randrange(len(bars));sign=rnd.choice([1,-1]);price=bars[i]['c'];risk=rnd.uniform(.001,30);reward=rnd.uniform(.001,60)
            entry={'at':bars[i]['t']};plan={'entry':price,'stop':price-sign*risk,'target':price+sign*reward,'direction':'BUY' if sign==1 else 'SELL'}
            self.assertEqual(index.evaluate(entry,plan),evaluate_trade(entry,plan,bars))
    def test_exact_stop_first_ambiguity_and_skip_entry(self):
        bars=fixture(3);bars[0].update(l=0,h=200);bars[1].update(l=90,h=110);c=ReplayBars(bars);x=FirstHitIndex(c)
        p={'entry':100,'stop':95,'target':105,'direction':'BUY'};r=x.evaluate({'at':0},p)
        self.assertEqual(r['exitAt'],300000);self.assertTrue(r['ambiguous']);self.assertEqual(r['r'],-1)
    def test_no_future_remains_open(self):
        bars=fixture(10);c=ReplayBars(bars);x=FirstHitIndex(c);p={'entry':100,'stop':-999,'target':999,'direction':'BUY'}
        self.assertEqual(x.evaluate({'at':bars[-1]['t']},p)['result'],'OPEN')
    def test_bytes_bounded(self):
        c=ReplayBars(fixture(10000));x=FirstHitIndex(c);self.assertLess(c.bytes+x.bytes,130*len(c))
if __name__=='__main__':unittest.main()
