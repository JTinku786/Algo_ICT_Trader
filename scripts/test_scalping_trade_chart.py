"""Ensure chart evidence belongs to the selected historical attribution."""
import gzip
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
import scalping_trade_chart as reader


class SavedChartEvidenceTests(unittest.TestCase):
    def test_forward_calendar_skips_weekends_and_holidays(self):
        from datetime import datetime
        from zoneinfo import ZoneInfo
        entry = int(datetime(2026, 10, 9, 12, tzinfo=ZoneInfo('America/New_York')).timestamp()*1000)
        result = reader.forward_dates(entry, 'us', [])
        self.assertIn('NYSE', result['basis'])
        self.assertEqual([m['count'] for m in result['markers']], [20,40,60])
        self.assertTrue(all(m['day'] for m in result['markers']))
        self.assertTrue(all(datetime.fromisoformat(m['day']).weekday()<5 for m in result['markers']))
        self.assertEqual(result['markers'][0]['day'], '2026-11-06')

    def test_missing_calendar_dates_are_explicit(self):
        self.assertTrue(all(m['day'] is None for m in reader.forward_dates(1000, 'india', [])['markers']))

    def test_exact_confirmation_and_missing_context(self):
        with tempfile.TemporaryDirectory(prefix='scalping-chart-') as temporary:
            root = Path(temporary)
            source = root / 'us_AXP' / 'chunks' / '2026-10-04.ndjson'
            source.parent.mkdir(parents=True)
            original_root = reader.ROOT
            reader.ROOT = root
            try:
                with closing(sqlite3.connect(root / 'results.sqlite')) as db:
                    db.execute('CREATE TABLE trades(id TEXT, sourceFile TEXT, entryAt INTEGER, exitAt INTEGER, exitKnownAt INTEGER, side TEXT)')
                    db.execute('INSERT INTO trades VALUES(?,?,?,?,?,?)', ('fixture', 'us_AXP/chunks/2026-10-04.ndjson', 1000, 2000, 2300, 'BUY'))
                    db.execute('CREATE TABLE attributions(tradeId TEXT, contextId TEXT, arrayId TEXT, confirmation TEXT,tf1Kind TEXT,tf2Kind TEXT)')
                    db.executemany('INSERT INTO attributions VALUES(?,?,?,?,?,?)', [('fixture', 'context', 'array', 'CHOCH','PDL','OB'), ('fixture', 'context', 'array', 'CISD','PDL','OB')])
                    db.commit()
                with gzip.open(str(source).replace('.ndjson', '.evidence.ndjson.gz'), 'wt') as stream:
                    for confirmation in ('CHOCH', 'CISD'):
                        proof = {'context': {'id': 'context'}, 'array': {'id': 'array', 'origin': 500}, 'touch': {'t': 600}, 'confirmation': {'id': f'5m:{confirmation}:700', 'label': confirmation, 'origin': 700}}
                        stream.write(json.dumps({'id': 'fixture', 'strategy_json': proof}) + '\n')
                (root / 'manifest.json').write_text(json.dumps({'snapshotAt': 1234}))
                with gzip.open(source.parent.parent / 'candles-fixture-1234.json.gz', 'wt') as stream:
                    json.dump({'lower': [{'t': 1000,'knownAt':1300}], 'higher': [{'t': 1000}], 'daily': []}, stream)
                exact = reader.chart('fixture', 'context', 'array', 'CISD')
                self.assertEqual(exact['evidence']['confirmation']['label'], 'CISD')
                self.assertIsNone(exact['warning'])
                # The default must load archived evidence, regardless of which
                # aggregated attribution happens to sort first in the viewer.
                default = reader.chart('fixture')
                self.assertIsNotNone(default['evidence'])
                self.assertEqual(default['evidenceOptions'][0]['confirmation'], default['evidence']['confirmation']['label'])
                for context,array,confirmation in [('other-context','array','CISD'),('context','other-array','CISD'),('context','array','UNKNOWN')]:
                    with self.assertRaisesRegex(ValueError,'not a saved attribution'):
                        reader.chart('fixture',context,array,confirmation)
            finally:
                reader.ROOT = original_root

    def test_deduplicated_pdl_recovery_matches_saved_trade(self):
        if not (reader.ROOT/'us_AXP/chunks/2026-09-27.json').exists():
            self.skipTest('Historical integration snapshot unavailable')
        result=reader.chart('f9b8baa66ff8025a6b4954dcb37aa87a5391a3df68dc434b22617c4cd771eca1','1d:PDL:1790654400000:1790712000000:1:session:2026-09-30','5m:OB:1790778300000:1','CHOCH')
        proof=result['evidence'];trade=result['trade']
        self.assertEqual(proof['context']['kind'],'PDL')
        self.assertEqual(proof['context']['low'],proof['context']['raw']['sourceCandle']['l'])
        self.assertTrue(proof['chartRecovery']['entryAndPlanVerified'])
        self.assertEqual(proof['plan']['stop'],trade['stop'])
        self.assertEqual(proof['plan']['target'],trade['target'])
        self.assertGreaterEqual(len([b for b in result['higher'] if b['t']<proof['touch']['t']]),60)
        self.assertEqual(next(b for b in result['lower'] if b['t']==trade['exitAt'])['knownAt'],trade['exitKnownAt'])


if __name__ == '__main__':
    unittest.main()
