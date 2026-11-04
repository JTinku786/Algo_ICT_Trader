import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from scalping_backtest_paired_rr import paired_rr_report,BUCKETS,DEFAULT_CUTOFF


class CommonEntryComparisonTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.root=Path(self.folder.name)
        self.database=self.root/'results.sqlite';self.db=sqlite3.connect(self.database)
        self.db.executescript('''CREATE TABLE trades(id TEXT PRIMARY KEY,symbol TEXT,market TEXT,side TEXT,entryAt INTEGER,
          entry REAL,stop REAL,rrBucket TEXT,result TEXT,exitAt INTEGER,r REAL,riskBps REAL,
          tf1Kind TEXT,tf2Kind TEXT,confirmation TEXT);
          CREATE TABLE attributions(tradeId TEXT,tf1Kind TEXT,tf2Kind TEXT,confirmation TEXT);''')

    def tearDown(self):
        self.db.close();self.folder.cleanup()

    def family(self,name,entry_at,indices=range(5),opened=None,crossing=False,pair=('OB','FVG','CHOCH')):
        for i in indices:
            identity=f'{name}-{i}';closed=i!=opened;exit_at=entry_at+1000
            if crossing and i==4:exit_at=DEFAULT_CUTOFF+1000
            self.db.execute('INSERT INTO trades VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (identity,'AAPL','us','BUY',entry_at,100,99,BUCKETS[i],'WIN' if closed else 'OPEN',exit_at if closed else None,i+.5 if closed else None,100,*pair))
            self.db.execute('INSERT INTO attributions VALUES (?,?,?,?)',(identity,*pair))

    def test_same_entry_cohort_closed_intersection_and_training_clock(self):
        self.family('training',DEFAULT_CUTOFF-10000)
        self.family('missing-bucket',DEFAULT_CUTOFF-20000,range(4))
        self.family('cross-boundary',DEFAULT_CUTOFF-30000,crossing=True)
        self.family('open-holdout',DEFAULT_CUTOFF+10000,opened=4)
        self.family('closed-holdout',DEFAULT_CUTOFF+20000)
        self.db.commit();before=hashlib.sha256(self.database.read_bytes()).hexdigest()
        report=paired_rr_report(self.root,write=False)
        market={r['period']:r for r in report['commonFamilies'] if r['scope']=='MARKET'}
        self.assertEqual((market['TRAIN']['eligible'],market['TRAIN']['comparableClosed'],market['TRAIN']['trainingBoundaryExcluded']),(2,1,1))
        self.assertEqual((market['HOLDOUT']['eligible'],market['HOLDOUT']['comparableClosed'],market['HOLDOUT']['unresolved']),(2,1,1))
        train=[r for r in report['bucketResults'] if r['scope']=='MARKET' and r['period']=='TRAIN']
        self.assertEqual(len(train),5);self.assertTrue(all(r['closed']==1 for r in train))
        high=next(r for r in train if r['rrBucket']=='4+')
        self.assertEqual(high['pairedMeanDeltaVs0To1'],4)
        self.assertAlmostEqual(high['costSensitivityNetR']['2'],4.48)
        self.assertEqual(before,hashlib.sha256(self.database.read_bytes()).hexdigest())
        self.assertEqual(report['selection'],'DESCRIPTIVE_ONLY_NO_HOLDOUT_SELECTION')

    def test_pair_requires_identical_attribution_across_all_buckets(self):
        self.family('same-pair',DEFAULT_CUTOFF-10000)
        self.family('partial-pair',DEFAULT_CUTOFF-20000)
        self.db.execute("DELETE FROM attributions WHERE tradeId='partial-pair-4'")
        self.db.execute("INSERT INTO attributions VALUES ('partial-pair-4','OB','BPR','CISD')")
        self.db.commit();report=paired_rr_report(self.root,write=False)
        market=next(r for r in report['commonFamilies'] if r['scope']=='MARKET')
        pair=next(r for r in report['commonFamilies'] if r['scope']=='PAIR')
        self.assertEqual((market['eligible'],pair['eligible']),(2,1))

    def test_duplicate_scenario_in_one_bucket_is_not_arbitrarily_chosen(self):
        self.family('one',DEFAULT_CUTOFF-10000)
        self.db.execute("INSERT INTO trades SELECT 'duplicate',symbol,market,side,entryAt,entry,stop,rrBucket,result,exitAt,r,riskBps,tf1Kind,tf2Kind,confirmation FROM trades WHERE id='one-0'")
        self.db.execute("INSERT INTO attributions VALUES ('duplicate','OB','FVG','CHOCH')")
        self.db.commit();report=paired_rr_report(self.root,write=False)
        self.assertFalse(report['comparisonAvailable']);self.assertEqual(report['bucketResults'],[])

    def test_publication_labels_partial_snapshot_and_writes_atomically(self):
        self.family('one',DEFAULT_CUTOFF-10000);self.db.commit()
        (self.root/'manifest.json').write_text(json.dumps({'status':'RUNNING','snapshotAt':123}),encoding='utf-8')
        report=paired_rr_report(self.root)
        published=json.loads((self.root/'paired-rr-comparison.json').read_text(encoding='utf-8'))
        self.assertEqual(report,published)
        self.assertEqual((published['sourceRunStatus'],published['partial'],published['snapshotAt']),('RUNNING',True,123))
        self.assertEqual(list(self.root.glob('*.tmp')),[])


if __name__=='__main__':unittest.main()
