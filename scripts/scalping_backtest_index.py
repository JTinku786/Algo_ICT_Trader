"""Incremental SQLite research index over completed backtest shards only."""
import sys as _rs, os as _ro; _rs.path.insert(0, _ro.path.dirname(_ro.path.abspath(__file__))); from reports_dir import REPORTS, SCALPING_BACKTEST  # noqa: E402
import sqlite3,json,time,hashlib
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
from scalping_backtest_sqlite import CubeBatch,initialize
NY=ZoneInfo('America/New_York')
DDL='''
CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,size INTEGER,mtime REAL);
CREATE TABLE IF NOT EXISTS trades(id TEXT PRIMARY KEY,symbol TEXT,market TEXT,side TEXT,entryAt INTEGER,entryKnownAt INTEGER,exitAt INTEGER,exitKnownAt INTEGER,entry REAL,stop REAL,target REAL,rrBucket TEXT,plannedRR REAL,result TEXT,r REAL,holdBars INTEGER,ambiguous INTEGER,entryYear INTEGER,entryMonth TEXT,entryDay TEXT,exitDay TEXT,riskBps REAL,tf1Kind TEXT,tf2Kind TEXT,confirmation TEXT,sourceFile TEXT);
CREATE TABLE IF NOT EXISTS attributions(tradeId TEXT,tf1Kind TEXT,tf2Kind TEXT,confirmation TEXT,contextId TEXT,arrayId TEXT,PRIMARY KEY(tradeId,tf1Kind,tf2Kind,confirmation));
CREATE INDEX IF NOT EXISTS trades_filters ON trades(market,rrBucket,entryYear,symbol);
CREATE INDEX IF NOT EXISTS trades_entry ON trades(entryAt DESC);
CREATE INDEX IF NOT EXISTS trades_exit ON trades(exitAt);
CREATE INDEX IF NOT EXISTS attribution_pairs ON attributions(tf1Kind,tf2Kind,confirmation,tradeId);
'''
def ingest(root):
 root=Path(root);manifest_path=root/'summary.json' if (root/'summary.json').exists() else root/'manifest.json';manifest=json.loads(manifest_path.read_text(encoding='utf-8'));files=manifest.get('files') or manifest.get('tradeFiles') or [];db=sqlite3.connect(root/'results.sqlite');db.executescript(DDL);db.execute('PRAGMA journal_mode=WAL');db.execute('PRAGMA synchronous=NORMAL');initialize(db);changed=0
 for item in files:
  file=item['path'] if isinstance(item,dict) else item;p=root/file
  if not p.is_file():continue
  st=p.stat();old=db.execute('SELECT size,mtime FROM files WHERE path=?',(file,)).fetchone()
  if old==(st.st_size,st.st_mtime):continue
  if old:raise RuntimeError('Immutable backtest shard changed: '+file)
  cube=CubeBatch()
  with p.open(encoding='utf-8') as f:
   for line in f:
    if not line.strip():continue
    r=json.loads(line);d=datetime.fromtimestamp(r['entryAt']/1000,NY);ex=datetime.fromtimestamp(r['exitAt']/1000,NY).date().isoformat() if r.get('exitAt') else None;risk=abs(r['entry']-r['stop'])/abs(r['entry'])*10000
    fields=['id','symbol','market','side','entryAt','entryKnownAt','exitAt','exitKnownAt','entry','stop','target','rrBucket','plannedRR','result','r','holdBars','ambiguous'];values=[r.get(k) for k in fields]+[d.year,d.strftime('%Y-%m'),d.date().isoformat(),ex,risk,r['tf1Kind'],r['tf2Kind'],r['confirmation'],file]
    inserted=db.execute('INSERT OR IGNORE INTO trades VALUES ('+','.join('?' for _ in values)+')',values).rowcount==1
    previous=set() if inserted else set(db.execute('SELECT tf1Kind,tf2Kind,confirmation FROM attributions WHERE tradeId=?',(r['id'],)))
    for a in r.get('attributions') or [r]:db.execute('INSERT OR IGNORE INTO attributions VALUES (?,?,?,?,?,?)',(r['id'],a['tf1Kind'],a['tf2Kind'],a['confirmation'],a.get('contextId'),a.get('arrayId')))
    cube.add(r,inserted,previous)
  cube.flush(db);db.execute('INSERT INTO files VALUES (?,?,?)',(file,st.st_size,st.st_mtime));db.commit();changed+=1
 total=db.execute('SELECT COUNT(*) FROM trades').fetchone()[0];indexed=db.execute('SELECT COUNT(*) FROM files').fetchone()[0];db.close();(root/'index-status.json').write_text(json.dumps({'generatedAt':datetime.now(NY).isoformat(),'tradeCount':total,'indexedFiles':indexed,'manifestFiles':len(files),'status':'COMPLETE' if indexed==len(files) else 'BUILDING','database':'results.sqlite','schemaVersion':1,'cubeSchemaVersion':3}),encoding='utf-8');return changed,total
if __name__=='__main__':
 import argparse
 p=argparse.ArgumentParser();p.add_argument('--root',default=str(SCALPING_BACKTEST));p.add_argument('--watch',action='store_true');a=p.parse_args()
 while True:
  root=Path(a.root)
  if (root/'summary.json').exists() or (root/'manifest.json').exists():
   changed,total=ingest(root)
   if changed:print(json.dumps({'newFiles':changed,'tradeCount':total}),flush=True)
   manifest_path=root/'summary.json' if (root/'summary.json').exists() else root/'manifest.json'
   latest=json.loads(manifest_path.read_text(encoding='utf-8'))
   published=json.loads((root/'index-status.json').read_text(encoding='utf-8'))
   final_files=latest.get('files') or latest.get('tradeFiles') or []
   if not a.watch or (latest.get('status') in ['COMPLETE','COMPLETE_WITH_ERRORS','FAILED'] and published['indexedFiles']==len(final_files)):break
  elif not a.watch:raise SystemExit('Run summary not available yet')
  time.sleep(15)
