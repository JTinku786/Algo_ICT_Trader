import unittest
from fvg_dealing_range import DealingRanges

def pivots(values):
    return [{'id':str(i),'kind':kind,'origin':i*10,'knownAt':i*10+3,'low':value,'high':value} for i,(kind,value) in enumerate(values)]

class RangeTests(unittest.TestCase):
    def test_both_user_examples_keep_outer_87_to_95(self):
        for first,second in [(87,90),(88,87)]:
            index=DealingRanges(pivots([('BSL',90),('SSL',first),('BSL',92),('SSL',second),('BSL',95)]),[],'1h')
            r=index.range_at(50,'BUY');self.assertEqual((r['low'],r['high'],r['equilibrium']),(87,95,91))
            self.assertTrue(index.qualify({'direction':'BUY','low':89,'high':90},50)['valid'])
            self.assertFalse(index.qualify({'direction':'BUY','low':92,'high':93},50)['valid'])
            self.assertTrue(index.qualify({'direction':'BUY','low':90,'high':92},50)['valid'])
            self.assertFalse(index.qualify({'direction':'BUY','low':80,'high':81},50)['valid'])

    def test_bearish_mirror_uses_highest_intervening_high(self):
        index=DealingRanges(pivots([('SSL',90),('BSL',93),('SSL',88),('BSL',90),('SSL',85)]),[],'5m')
        r=index.range_at(50,'SELL');self.assertEqual((r['low'],r['high'],r['equilibrium']),(85,93,89))
        self.assertTrue(index.qualify({'direction':'SELL','low':90,'high':91},50)['valid'])
        self.assertFalse(index.qualify({'direction':'SELL','low':86,'high':87},50)['valid'])

    def test_unconfirmed_future_high_never_changes_previous_range(self):
        known=pivots([('BSL',90),('SSL',87),('BSL',92),('SSL',90)])
        full=known+pivots([('BSL',95)])
        full[-1].update(id='future',origin=40,knownAt=43)
        a=DealingRanges(known,[],'1h').range_at(42,'BUY')
        b=DealingRanges(full,[],'1h').range_at(42,'BUY')
        self.assertEqual(a,b);self.assertEqual(b['high'],92)
        self.assertEqual(DealingRanges(full,[],'1h').range_at(43,'BUY')['high'],95)

    def test_non_extending_high_restarts_chain(self):
        index=DealingRanges(pivots([('BSL',100),('SSL',80),('BSL',90),('SSL',87),('BSL',92),('SSL',90),('BSL',95)]),[],'1h')
        r=index.range_at(70,'BUY');self.assertEqual((r['low'],r['high']),(87,95))
        self.assertEqual(r['chainStart'],20)

    def test_breach_waits_for_completed_bar_and_missing_range_fails_closed(self):
        swings=pivots([('BSL',90),('SSL',87),('BSL',95)])
        index=DealingRanges(swings,[{'t':30,'knownAt':40,'h':96,'l':90}],'1h')
        self.assertEqual(index.range_at(39,'BUY')['state'],'ACTIVE')
        self.assertEqual(index.range_at(40,'BUY')['state'],'BROKEN')
        self.assertFalse(index.qualify({'direction':'BUY','low':89,'high':90},40)['valid'])
        self.assertIsNone(DealingRanges(swings[:2],[],'1h').range_at(50,'BUY'))

if __name__=='__main__':unittest.main()
