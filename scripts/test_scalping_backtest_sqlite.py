import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from datetime import datetime, timezone
from scalping_backtest_index import ingest

def stamp(value):
    return int(datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp() * 1000)

def row(identifier='1', **overrides):
    value = dict(id=identifier, symbol='AAPL', market='us', side='BUY', entryAt=stamp('2023-12-01T10:00:00'), entryKnownAt=stamp('2023-12-01T10:05:00'), exitAt=stamp('2023-12-01T10:10:00'), entry=100, stop=99, target=101.5, rrBucket='1-2', plannedRR=1.5, result='WIN', r=1.5, tf1Kind='OB', tf2Kind='VALID_FVG', confirmation='CHOCH')
    value.update(overrides)
    return value

class FilterCubes(unittest.TestCase):
    def test_incremental_dedup_attribution_and_costs(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            first = row()
            opened = row('2', result='OPEN', exitAt=None, r=None, rrBucket='2-3')
            (root / 'a.ndjson').write_text('\n'.join(json.dumps(r) for r in (first, opened)), encoding='utf-8')
            (root / 'summary.json').write_text(json.dumps({'status': 'RUNNING', 'files': ['a.ndjson']}), encoding='utf-8')
            self.assertEqual(ingest(root), (1, 2))
            self.assertEqual(ingest(root), (0, 2))
            duplicate = {**first, 'attributions': [{'tf1Kind': 'OB', 'tf2Kind': 'VALID_FVG', 'confirmation': 'CHOCH'}, {'tf1Kind': 'BPR', 'tf2Kind': 'OB', 'confirmation': 'CISD'}]}
            (root / 'b.ndjson').write_text(json.dumps(duplicate), encoding='utf-8')
            (root / 'summary.json').write_text(json.dumps({'status': 'COMPLETE', 'files': ['a.ndjson', 'b.ndjson']}), encoding='utf-8')
            self.assertEqual(ingest(root), (1, 2))
            duplicate['attributions'].append({'tf1Kind': 'OB', 'tf2Kind': 'VALID_FVG', 'confirmation': 'CISD'})
            (root / 'c.ndjson').write_text(json.dumps(duplicate), encoding='utf-8')
            (root / 'summary.json').write_text(json.dumps({'status': 'COMPLETE', 'files': ['a.ndjson', 'b.ndjson', 'c.ndjson']}), encoding='utf-8')
            self.assertEqual(ingest(root), (1, 2))
            db = sqlite3.connect(root / 'results.sqlite')
            main = [json.loads(r[0]) for r in db.execute('SELECT metrics FROM scenario_stats')]
            self.assertEqual(sum(r['scenarios'] for r in main), 2)
            self.assertEqual(sum(r['closed'] for r in main), 1)
            self.assertEqual(sum(r['open'] for r in main), 1)
            self.assertEqual(sum(r['grossR'] for r in main), 1.5)
            self.assertAlmostEqual(sum(r['costs']['2']['grossR'] for r in main), 1.48)
            moved = db.execute("SELECT metrics FROM scenario_stats WHERE confirmationSet='CHOCH,CISD'").fetchone()
            self.assertEqual(json.loads(moved[0])['scenarios'], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM pair_stats WHERE period='ALL'").fetchone()[0], 4)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM pair_period_stats').fetchone()[0], 4)
            self.assertEqual(db.execute("SELECT value FROM cube_metadata WHERE key='schemaVersion'").fetchone()[0], '3')
            union = json.loads(db.execute("SELECT metrics FROM pair_union_stats WHERE tf1Kind='OB' AND tf2Kind='VALID_FVG' AND rrBucket='1-2'").fetchone()[0])
            self.assertEqual(union['closed'], 1, 'Both confirmations for the same economic entry / pair must count once in heatmap')
            before = {table: db.execute('SELECT * FROM ' + table).fetchall() for table in ('scenario_stats', 'pair_stats', 'pair_period_stats')}
            db.execute('DELETE FROM pair_union_stats'); db.execute("UPDATE cube_metadata SET value='2' WHERE key='schemaVersion'"); db.commit(); db.close()
            self.assertEqual(ingest(root), (0, 2))
            db = sqlite3.connect(root / 'results.sqlite')
            after = {table: db.execute('SELECT * FROM ' + table).fetchall() for table in ('scenario_stats', 'pair_stats', 'pair_period_stats')}
            self.assertEqual(before, after, 'Version 2 upgrade must leave existing totals byte-for-byte unchanged')
            union = json.loads(db.execute("SELECT metrics FROM pair_union_stats WHERE tf1Kind='OB' AND tf2Kind='VALID_FVG' AND rrBucket='1-2'").fetchone()[0])
            self.assertEqual(union['closed'], 1)
            db.close()

    def test_new_york_year_and_known_training_exit(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            # Jan 1 03:00 UTC is still Dec 31 in New York.
            old = row(entryAt=stamp('2024-01-01T03:00:00'), exitAt=stamp('2024-01-01T04:00:00'))
            across = row('2', entryAt=stamp('2024-01-01T03:00:00'), exitAt=stamp('2024-01-01T06:00:00'))
            later = row('3', entryAt=stamp('2024-01-01T06:00:00'), exitAt=stamp('2024-01-01T07:00:00'))
            (root / 'a.ndjson').write_text('\n'.join(json.dumps(r) for r in (old, across, later)), encoding='utf-8')
            (root / 'summary.json').write_text(json.dumps({'files': ['a.ndjson']}), encoding='utf-8')
            ingest(root); db = sqlite3.connect(root / 'results.sqlite')
            years = dict(db.execute('SELECT id,entryYear FROM trades'))
            self.assertEqual(years, {'1': 2023, '2': 2023, '3': 2024})
            train = sum(json.loads(r[0])['closed'] for r in db.execute("SELECT metrics FROM pair_stats WHERE period='TRAIN'"))
            holdout = sum(json.loads(r[0])['closed'] for r in db.execute("SELECT metrics FROM pair_stats WHERE period='HOLDOUT'"))
            self.assertEqual(train, 1); self.assertEqual(holdout, 1)
            db.close()

if __name__ == '__main__':
    unittest.main()
