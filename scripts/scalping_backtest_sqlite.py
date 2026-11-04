"""Incremental filter cubes for the read-only Scalping Labs result viewer.

Call CubeBatch.add inside the same SQLite transaction as raw trade ingestion,
then CubeBatch.flush before committing that immutable shard. Economic records
count once; each distinct attribution contributes once to its own pair cell.
"""
import json
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

NY = ZoneInfo('America/New_York')
CUTOFF = int(datetime(2024, 1, 1, tzinfo=NY).timestamp() * 1000)
DDL = '''
CREATE TABLE IF NOT EXISTS scenario_stats(market TEXT NOT NULL,symbol TEXT NOT NULL,entryYear INTEGER NOT NULL,exitMonth TEXT NOT NULL,rrBucket TEXT NOT NULL,side TEXT NOT NULL,confirmationSet TEXT NOT NULL,metrics TEXT NOT NULL,PRIMARY KEY(market,symbol,entryYear,exitMonth,rrBucket,side,confirmationSet));
CREATE TABLE IF NOT EXISTS pair_stats(market TEXT NOT NULL,symbol TEXT NOT NULL,entryYear INTEGER NOT NULL,rrBucket TEXT NOT NULL,side TEXT NOT NULL,tf1Kind TEXT NOT NULL,tf2Kind TEXT NOT NULL,confirmation TEXT NOT NULL,period TEXT NOT NULL,metrics TEXT NOT NULL,PRIMARY KEY(market,symbol,entryYear,rrBucket,side,tf1Kind,tf2Kind,confirmation,period));
CREATE INDEX IF NOT EXISTS scenario_stats_filters ON scenario_stats(market,symbol,entryYear,rrBucket);
CREATE INDEX IF NOT EXISTS pair_stats_filters ON pair_stats(market,symbol,entryYear,rrBucket,confirmation);
CREATE TABLE IF NOT EXISTS pair_period_stats(market TEXT NOT NULL,symbol TEXT NOT NULL,entryYear INTEGER NOT NULL,exitMonth TEXT NOT NULL,rrBucket TEXT NOT NULL,side TEXT NOT NULL,tf1Kind TEXT NOT NULL,tf2Kind TEXT NOT NULL,confirmation TEXT NOT NULL,metrics TEXT NOT NULL,PRIMARY KEY(market,symbol,entryYear,exitMonth,rrBucket,side,tf1Kind,tf2Kind,confirmation));
CREATE INDEX IF NOT EXISTS pair_period_filters ON pair_period_stats(market,symbol,entryYear,rrBucket,confirmation);
CREATE TABLE IF NOT EXISTS pair_union_stats(market TEXT NOT NULL,symbol TEXT NOT NULL,entryYear INTEGER NOT NULL,rrBucket TEXT NOT NULL,side TEXT NOT NULL,tf1Kind TEXT NOT NULL,tf2Kind TEXT NOT NULL,metrics TEXT NOT NULL,PRIMARY KEY(market,symbol,entryYear,rrBucket,side,tf1Kind,tf2Kind));
CREATE INDEX IF NOT EXISTS pair_union_filters ON pair_union_stats(market,symbol,entryYear,rrBucket);
CREATE TABLE IF NOT EXISTS cube_metadata(key TEXT PRIMARY KEY,value TEXT);
'''
FIELDS = ('scenarios', 'closed', 'open', 'wins', 'losses', 'grossR', 'positiveR', 'negativeR', 'rr')

def blank():
    return dict.fromkeys(FIELDS, 0)

def contribution(record):
    result = blank(); result['scenarios'] = 1; result['rr'] = record.get('plannedRR', 0) or 0
    closed = record.get('result') in ('WIN', 'LOSS') and record.get('exitAt') is not None and record.get('r') is not None
    if not closed:
        result['open'] = 1
    else:
        result['closed'] = 1; result['grossR'] = record['r']; result['wins'] = int(record['r'] > 0); result['losses'] = int(record['r'] < 0)
        result['positiveR'] = max(0, record['r']); result['negativeR'] = max(0, -record['r'])
    risk = abs(record['entry'] - record['stop'])
    result['costs'] = {}
    for bps in (1, 2, 5):
        cost = blank()
        if closed and risk:
            value = record['r'] - abs(record['entry']) * bps / 10000 / risk
            cost.update(scenarios=1, closed=1, wins=int(value > 0), losses=int(value < 0), grossR=value, positiveR=max(0, value), negativeR=max(0, -value), rr=result['rr'])
        elif not closed:
            cost.update(scenarios=1, open=1, rr=result['rr'])
        result['costs'][str(bps)] = cost
    return result

def merge(destination, source, sign=1):
    for field in FIELDS:
        destination[field] = destination.get(field, 0) + sign * source.get(field, 0)
    for bps, stats in source.get('costs', {}).items():
        costs = destination.setdefault('costs', {})
        merge(costs.setdefault(bps, blank()), stats, sign)
    return destination

class CubeBatch:
    def __init__(self):
        self.scenarios = {}; self.pairs = {}; self.periods = {}; self.union = {}

    @staticmethod
    def attributes(record):
        return {(a['tf1Kind'], a['tf2Kind'], a['confirmation']) for a in record.get('attributions') or [record]}

    def add(self, record, is_new=True, previous_attributes=None, new_attributes=None):
        previous_attributes = previous_attributes or set()
        new_attributes = new_attributes if new_attributes is not None else self.attributes(record) - previous_attributes
        attributes = previous_attributes | new_attributes
        at = datetime.fromtimestamp(record['entryAt'] / 1000, NY)
        exit_month = datetime.fromtimestamp(record['exitAt'] / 1000, NY).strftime('%Y-%m') if record.get('exitAt') else ''
        # New York calendar grouping matches the viewer and causal holdout boundary.
        stats = contribution(record)
        base = (record['market'], record['symbol'], at.year, exit_month, record['rrBucket'], record['side'])
        confirmation_set = ','.join(sorted({a[2] for a in attributes}))
        old_set = ','.join(sorted({a[2] for a in previous_attributes}))
        if is_new or confirmation_set != old_set:
            if not is_new:
                merge(self.scenarios.setdefault(base + (old_set,), blank()), stats, -1)
            merge(self.scenarios.setdefault(base + (confirmation_set,), blank()), stats)
        for tf1, tf2, confirmation in new_attributes:
            key = (record['market'], record['symbol'], at.year, record['rrBucket'], record['side'], tf1, tf2, confirmation)
            merge(self.pairs.setdefault(key + ('ALL',), blank()), stats)
            period_key = (record['market'], record['symbol'], at.year, exit_month, record['rrBucket'], record['side'], tf1, tf2, confirmation)
            merge(self.periods.setdefault(period_key, blank()), stats)
            if record['entryAt'] >= CUTOFF:
                merge(self.pairs.setdefault(key + ('HOLDOUT',), blank()), stats)
            elif record.get('exitAt') is not None and record['exitAt'] < CUTOFF:
                merge(self.pairs.setdefault(key + ('TRAIN',), blank()), stats)
        self.add_union(record, attributes, previous_attributes, stats)

    def add_union(self, record, attributes, previous_attributes=None, stats=None):
        previous_pairs = {(a[0], a[1]) for a in previous_attributes or set()}
        new_pairs = {(a[0], a[1]) for a in attributes} - previous_pairs
        year = datetime.fromtimestamp(record['entryAt'] / 1000, NY).year
        for tf1, tf2 in new_pairs:
            key = (record['market'], record['symbol'], year, record['rrBucket'], record['side'], tf1, tf2)
            merge(self.union.setdefault(key, blank()), stats if stats is not None else contribution(record))

    def flush(self, database):
        for table, values, columns in [('scenario_stats', self.scenarios, ('market', 'symbol', 'entryYear', 'exitMonth', 'rrBucket', 'side', 'confirmationSet')), ('pair_stats', self.pairs, ('market', 'symbol', 'entryYear', 'rrBucket', 'side', 'tf1Kind', 'tf2Kind', 'confirmation', 'period')), ('pair_period_stats', self.periods, ('market', 'symbol', 'entryYear', 'exitMonth', 'rrBucket', 'side', 'tf1Kind', 'tf2Kind', 'confirmation')), ('pair_union_stats', self.union, ('market', 'symbol', 'entryYear', 'rrBucket', 'side', 'tf1Kind', 'tf2Kind'))]:
            where = ' AND '.join(column + '=?' for column in columns)
            for key, addition in values.items():
                old = database.execute('SELECT metrics FROM ' + table + ' WHERE ' + where, key).fetchone()
                merged = merge(json.loads(old[0]) if old else blank(), addition)
                metrics = json.dumps(merged, separators=(',', ':'), allow_nan=False)
                if old:
                    database.execute('UPDATE ' + table + ' SET metrics=? WHERE ' + where, (metrics,) + key)
                else:
                    database.execute('INSERT INTO ' + table + ' VALUES (' + ','.join('?' for _ in range(len(key) + 1)) + ')', key + (metrics,))
        database.execute("INSERT OR REPLACE INTO cube_metadata VALUES ('schemaVersion','3')")

def initialize(database):
    database.executescript(DDL)
    indexed = database.execute("SELECT value FROM cube_metadata WHERE key='schemaVersion'").fetchone()
    if (indexed and indexed[0] == '3') or not database.execute('SELECT 1 FROM trades LIMIT 1').fetchone():
        return
    union_only = indexed and indexed[0] == '2'
    for table in ('pair_union_stats',) if union_only else ('scenario_stats', 'pair_stats', 'pair_period_stats', 'pair_union_stats'):
        database.execute('DELETE FROM ' + table)
    # Version 2 -> 3 populates only the new union; existing totals never replay.
    database.row_factory = __import__('sqlite3').Row
    batch = CubeBatch()
    for value in database.execute('SELECT * FROM trades'):
        record = dict(value)
        record['attributions'] = [dict(a) for a in database.execute('SELECT tf1Kind,tf2Kind,confirmation FROM attributions WHERE tradeId=?', (record['id'],))]
        if union_only:
            batch.add_union(record, batch.attributes(record))
        else:
            batch.add(record)
    batch.flush(database)
    database.row_factory = None
    database.commit()
