"""Publish the India (NSE) Scalping Labs TF1 x TF2 grid into the Scalping Labs backtest viewer (results.sqlite), market='india'.

Source : C:\\Users\\saite\\Downloads\\sl_research\\india_grid_norepeat.pkl (50 NSE stocks, 2017-2026, built by scalping_india_grid.py)
Rules  : one trade per (tf1, tf2, symbol, side, IST day) - first entry, nearest target; desk exits (5m close stop, wick target,
         fill-candle rule, candle-shape resolution of same-candle fill+target). r is gross; the viewer applies 1/2/5 bp costs.
Writes : <backtest root>/india_<SYMBOL>/chunks/all.ndjson and indexes ONLY those files (does not touch US/forex shards).
Undo   : python scalping_india_publish.py --remove
"""
import sys, os, json, hashlib, sqlite3, argparse
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reports_dir import SCALPING_BACKTEST
from scalping_backtest_sqlite import CubeBatch, initialize
from scalping_backtest_index import DDL
NY = ZoneInfo('America/New_York'); SRC = r'C:\Users\saite\Downloads\sl_research\india_grid_norepeat.pkl'

def bucket(rr): return '0-1' if rr < 1 else '1-2' if rr < 2 else '2-3' if rr < 3 else '3-4' if rr < 4 else '4+'

def write_shards(root):
    import pandas as pd
    A = pd.read_pickle(SRC); files = []
    for sym, g in A.groupby('symbol'):
        name = sym.replace('.NS', ''); rel = f'india_{name}/chunks/all.ndjson'; p = root / rel; p.parent.mkdir(parents=True, exist_ok=True)
        with p.open('w', encoding='utf-8') as f:
            for r in g.sort_values('entryAt').itertuples():
                tid = hashlib.sha256(f'india|{name}|{int(r.entryAt)}|{r.tf1}|{r.tf2}|{r.side}|{r.entry:.4f}|{r.stop:.4f}|{r.target:.4f}'.encode()).hexdigest()
                rec = {'id': tid, 'symbol': name, 'market': 'india', 'entryAt': int(r.entryAt), 'entryKnownAt': int(r.entryAt) + 300000, 'side': r.side,
                       'tf1Kind': r.tf1, 'tf2Kind': r.tf2, 'confirmation': r.confirmation, 'rrBucket': bucket(r.rr), 'plannedRR': float(r.rr),
                       'entry': float(r.entry), 'stop': float(r.stop), 'target': float(r.target), 'outcome': r.result, 'r': float(r.r_res),
                       'exitAt': int(r.exitAt), 'exitKnownAt': int(r.exitAt) + 300000, 'ambiguous': r.same_order is not None, 'holdBars': int(r.bars or 0),
                       'result': 'WIN' if r.r_res > 0 else 'LOSS', 'attributions': [{'tf1Kind': r.tf1, 'tf2Kind': r.tf2, 'confirmation': r.confirmation}]}
                f.write(json.dumps(rec) + '\n')
        files.append(rel)
    return files

def ingest(root, files):
    db = sqlite3.connect(root / 'results.sqlite'); db.executescript(DDL); db.execute('PRAGMA journal_mode=WAL'); db.execute('PRAGMA synchronous=NORMAL'); initialize(db)
    for file in files:
        p = root / file; st = p.stat()
        if db.execute('SELECT 1 FROM files WHERE path=?', (file,)).fetchone(): print('already indexed', file); continue
        cube = CubeBatch()
        with p.open(encoding='utf-8') as f:
            for line in f:
                r = json.loads(line); d = datetime.fromtimestamp(r['entryAt'] / 1000, NY); ex = datetime.fromtimestamp(r['exitAt'] / 1000, NY).date().isoformat()
                risk = abs(r['entry'] - r['stop']) / abs(r['entry']) * 10000
                fields = ['id', 'symbol', 'market', 'side', 'entryAt', 'entryKnownAt', 'exitAt', 'exitKnownAt', 'entry', 'stop', 'target', 'rrBucket', 'plannedRR', 'result', 'r', 'holdBars', 'ambiguous']
                values = [r.get(k) for k in fields] + [d.year, d.strftime('%Y-%m'), d.date().isoformat(), ex, risk, r['tf1Kind'], r['tf2Kind'], r['confirmation'], file]
                inserted = db.execute('INSERT OR IGNORE INTO trades VALUES (' + ','.join('?' for _ in values) + ')', values).rowcount == 1
                previous = set() if inserted else set(db.execute('SELECT tf1Kind,tf2Kind,confirmation FROM attributions WHERE tradeId=?', (r['id'],)))
                for a in r['attributions']: db.execute('INSERT OR IGNORE INTO attributions VALUES (?,?,?,?,?,?)', (r['id'], a['tf1Kind'], a['tf2Kind'], a['confirmation'], None, None))
                cube.add(r, inserted, previous)
        cube.flush(db); db.execute('INSERT INTO files VALUES (?,?,?)', (file, st.st_size, st.st_mtime)); db.commit(); print('indexed', file, flush=True)
    print('india trades in index:', db.execute("SELECT COUNT(*) FROM trades WHERE market='india'").fetchone()[0]); db.close()

def remove(root):
    db = sqlite3.connect(root / 'results.sqlite')
    for t in ['scenario_stats', 'pair_stats', 'pair_period_stats', 'pair_union_stats']: db.execute(f"DELETE FROM {t} WHERE market='india'")
    db.execute("DELETE FROM attributions WHERE tradeId IN (SELECT id FROM trades WHERE market='india')"); db.execute("DELETE FROM trades WHERE market='india'")
    db.execute("DELETE FROM files WHERE path LIKE 'india_%'"); db.commit(); db.close(); print('india removed')

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--remove', action='store_true'); a = ap.parse_args(); root = Path(SCALPING_BACKTEST)
    if a.remove: remove(root)
    else: ingest(root, write_shards(root))
