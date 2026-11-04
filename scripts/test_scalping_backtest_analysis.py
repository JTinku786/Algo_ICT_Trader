import unittest,json,tempfile
from pathlib import Path
from scalping_backtest_analysis import stats,realized,analyze,stamp
class Test(unittest.TestCase):
 def row(self,i=0,**kw):
  return dict(id=str(i),symbol='AAPL',market='us',side='BUY',entryAt=stamp(2023)+i*300000,exitAt=stamp(2023)+i*300000+300000,entry=100,stop=99,target=102,rrBucket='1-2',plannedRR=2,result='WIN',r=2,tf1Kind='OB',tf2Kind='FVG',confirmation='CHOCH',**kw)
 def test_open_excluded_and_cost(self):
  row=self.row();opened={**row,'result':'OPEN','r':10,'exitAt':None};s=stats([row,opened]);self.assertEqual(s['closed'],1);self.assertEqual(s['open'],1);self.assertEqual(s['netR'],2);self.assertAlmostEqual(realized(row,2),1.98)
 def test_selection_cannot_use_holdout_profit(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);rows=[self.row(i) for i in range(30)]
   # Candidate B is weaker in training but would win a full-history ranking.
   for i in range(30):rows.append({**self.row(i+30),'tf1Kind':'IFVG','target':101,'r':1})
   rows+=[{**self.row(100+i),'entryAt':stamp(2024)+i*300000,'exitAt':stamp(2024)+i*300000+300000,'tf1Kind':'IFVG','target':120,'r':20} for i in range(35)]
   rows+=[{**self.row(200+i),'entryAt':stamp(2024)+i*300000,'exitAt':stamp(2024)+i*300000+300000,'result':'LOSS','r':-1} for i in range(35)]
   (root/'summary.json').write_text(json.dumps({'status':'COMPLETE','files':['trades.ndjson']}));(root/'trades.ndjson').write_text('\n'.join(json.dumps(r) for r in rows));r=analyze(root);choice=r['recommendationsByMarket'][0];self.assertEqual(choice['choice']['tf1Kind'],'OB');self.assertEqual(choice['verdict'],'NOT_CONFIRMED_IN_HOLDOUT')
if __name__=='__main__':unittest.main()
