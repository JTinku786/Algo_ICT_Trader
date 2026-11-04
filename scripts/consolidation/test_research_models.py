import unittest
import numpy as np
from research_models import exit_loop,last_pivot

def bar(t,o,h,l,c):return dict(t=t,knownAt=t+300000,o=o,h=h,l=l,c=c,price_epsilon=0.0001)
class ResearchContracts(unittest.TestCase):
 def test_close_stop_uses_full_close_loss(self):
  r=exit_loop([bar(0,100,100,95,96)],0,1,100,99,102,'CLOSE5',[False]);self.assertEqual(r['r'],-4)
 def test_target_before_closing_stop(self):
  r=exit_loop([bar(0,100,103,97,98)],0,1,100,99,102,'CLOSE5',[False]);self.assertEqual(r['r'],2)
 def test_hard_stop_priority(self):
  r=exit_loop([bar(0,100,103,97,98)],0,1,100,99,102,'HARD5',[False]);self.assertEqual(r['r'],-1)
 def test_hard_gap_full_loss(self):
  r=exit_loop([bar(0,100,101,99.5,100),bar(300000,97,98,96,97)],0,1,100,99,102,'HARD5',[False,False]);self.assertEqual(r['r'],-3)
 def test_missing_path_does_not_score_later_target(self):
  r=exit_loop([bar(0,100,101,99.5,100),bar(600000,100,103,100,102)],0,1,100,99,102,'CLOSE5',[False,True]);self.assertEqual(r['outcome'],'unverified')
 def test_fill_bar_exit_is_ambiguous(self):
  r=exit_loop([bar(0,101,103,99.5,100),bar(300000,100,103,100,102)],0,1,100,99,102,'CLOSE5',[False,False],True);self.assertEqual(r['outcome'],'unverified')
 def test_source_discontinuity(self):
  r=exit_loop([bar(0,100,101,99.5,100),bar(300000,150,151,149,150)],0,1,100,99,102,'CLOSE5',[False,False]);self.assertEqual(r['outcome'],'unverified')
 def test_fill_bar_stop_without_target_is_known_loss(self):
  r=exit_loop([bar(0,101,101,98,98)],0,1,100,99,102,'CLOSE5',[False],True);self.assertEqual(r['r'],-2)
 def test_limit_filled_at_open_can_hit_target_in_same_bar(self):
  r=exit_loop([bar(0,100,103,99.5,102)],0,1,100,99,102,'CLOSE5',[False],True);self.assertEqual(r['r'],2)
 def test_confirmed_pivot_only(self):
  b=[bar(i*300000,10,h,1,5) for i,h in enumerate([9,12,10,11,20])];self.assertEqual(last_pivot(b,3,1),12);b[4]['h']=1000;self.assertEqual(last_pivot(b,3,1),12)
if __name__=='__main__':unittest.main()
