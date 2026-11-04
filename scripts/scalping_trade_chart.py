"""Read a saved backtest trade and its immutable candle/evidence archives."""
import sys as _rs, os as _ro; _rs.path.insert(0, _ro.path.dirname(_ro.path.abspath(__file__))); from reports_dir import REPORTS, SCALPING_BACKTEST  # noqa: E402
import gzip,json,sqlite3,sys,hashlib,bisect
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
from pathlib import Path
ROOT=SCALPING_BACKTEST

def recover_setup(trade,attribute,source,snapshot_path,candles,canonical):
 """Recover a deduplicated attribution from the exact frozen detector inputs.

 The original writer kept one JSON per economic trade. Never relabel that JSON:
 replay only identical engine bytes and snapshot, then reconcile the full entry.
 """
 from scalping_backtest_validation import select_target,audit_candidate
 import scalping_labs_updated as engine
 status=json.loads((source.parent.parent/'status.json').read_text())
 checkpoint=json.loads(source.with_suffix('.json').read_text())
 if canonical.get('backtest',{}).get('fingerprint')!=checkpoint['fingerprint']:
  raise ValueError('Strategy archive and saved entry-window fingerprints differ.')
 scripts=Path(__file__).resolve().parent
 for filename,digest in status['engineHashes'].items():
  if hashlib.sha256((scripts/filename).read_bytes()).hexdigest()!=digest:
   raise ValueError('Selected setup recovery requires the original engine: '+filename)
 if hashlib.sha256(snapshot_path.read_bytes()).hexdigest()!=checkpoint['datasetHash']:
  raise ValueError('Saved candle snapshot fingerprint does not match the backtest.')
 ws,we=checkpoint['start'],checkpoint['end']
 lower,higher,daily=[candles[k] for k in ('lower','higher','daily')]
 ld=[b['day'] for b in lower];hd=[b['day'] for b in higher];dd=[b['day'] for b in daily]
 left=bisect.bisect_left(ld,ws);right=bisect.bisect_right(ld,we)
 high_left=bisect.bisect_left(hd,(datetime.fromisoformat(ws)-timedelta(days=30)).date().isoformat());high_right=bisect.bisect_right(hd,we)
 result=engine.run({**status['config'],'start':ws,'end':we,'lower':lower[max(0,left-250):right],'higher':higher[max(high_left,high_right-600):high_right],'daily':daily[:bisect.bisect_right(dd,we)]})
 for inv in result['investigations']:
  if inv['htf']['id']!=attribute['contextId'] or inv['mss']['label']!=attribute['confirmation']:continue
  for a in inv['arrays']:
   entry=a.get('entry')
   if a['zone']['id']!=attribute['arrayId'] or not entry or entry['at']!=trade['entryAt']:continue
   plan=select_target(entry['plan'],trade['rrBucket'])
   if not plan or audit_candidate(inv,a):continue
   if inv['mss']['direction']!=trade['side'] or entry['knownAt']!=trade['entryKnownAt']:continue
   if any(abs(actual-saved)>1e-8 for actual,saved in [(entry['price'],trade['entry']),(plan['stop'],trade['stop']),(plan['target'],trade['target'])]):continue
   method='Identical engine replay' if status['fingerprint']==checkpoint['fingerprint'] else 'Matching attribution reconstructed with recorded engine from frozen inputs'
   return {**entry['strategy_json'],'plan':plan,'backtest':canonical.get('backtest',{}),'chartRecovery':{'method':method+' from immutable candle snapshot','datasetHash':checkpoint['datasetHash'],'fingerprint':checkpoint['fingerprint'],'replayEngineFingerprint':status['fingerprint'],'entryAndPlanVerified':True}}
 raise ValueError('Selected attribution did not reproduce the saved entry, stop and target.')

def forward_dates(entry,market,daily):
 day=datetime.fromtimestamp(entry/1000,ZoneInfo('America/New_York')).date()
 dates=sorted({b['day'] for b in daily if b.get('day','')>day.isoformat()})
 basis='Saved daily trading sessions'
 if market=='us':
  try:
   import exchange_calendars as calendars
   dates=[d.strftime('%Y-%m-%d') for d in calendars.get_calendar('XNYS').sessions_in_range((day+timedelta(days=1)).isoformat(),(day+timedelta(days=150)).isoformat())]
   basis='NYSE session calendar; scheduled dates may change'
  except (ImportError,ValueError):
   basis='Saved sessions; exchange calendar unavailable'
 return {'basis':basis,'markers':[{'count':count,'day':dates[count-1] if len(dates)>=count else None} for count in (20,40,60)]}
def chart(trade_id,context_id='',array_id='',confirmation=''):
 conn=sqlite3.connect('file:'+str(ROOT/'results.sqlite').replace('\\','/')+'?mode=ro',uri=True);conn.row_factory=sqlite3.Row
 row=conn.execute('SELECT * FROM trades WHERE id=?',(trade_id,)).fetchone()
 if row is None: raise ValueError('Saved trade not found.')
 trade=dict(row);attrs=[dict(a) for a in conn.execute('SELECT * FROM attributions WHERE tradeId=?',(trade_id,))];conn.close()
 source=(ROOT/trade['sourceFile']).resolve()
 if ROOT.resolve() not in source.parents:raise ValueError('Invalid saved source path.')
 evidence=None;canonical=None
 with gzip.open(str(source).replace('.ndjson','.evidence.ndjson.gz'),'rt',encoding='utf-8') as stream:
  for line in stream:
   row=json.loads(line)
   if row.get('id')!=trade_id:continue
   proof=row['strategy_json']
   canonical=proof
   if context_id and proof.get('context',{}).get('id')!=context_id:continue
   if array_id and proof.get('array',{}).get('id')!=array_id:continue
   if confirmation and ':'+confirmation+':' not in proof.get('confirmation',{}).get('id','') and proof.get('confirmation',{}).get('label')!=confirmation:continue
   evidence=proof;break
 manifest=json.loads((ROOT/'manifest.json').read_text())
 paths=list(source.parent.parent.glob('candles-*-'+str(manifest['snapshotAt'])+'.json.gz'))
 if len(paths)!=1:raise ValueError('Saved candle snapshot is unavailable or ambiguous.')
 with gzip.open(paths[0],'rt',encoding='utf-8') as stream: candles=json.load(stream)
 if evidence is None and context_id and canonical:
  attribute=next((a for a in attrs if a['contextId']==context_id and (not array_id or a['arrayId']==array_id) and (not confirmation or a['confirmation']==confirmation)),None)
  if attribute is None:raise ValueError('Selected setup is not a saved attribution of this trade.')
  evidence=recover_setup(trade,attribute,source,paths[0],candles,canonical)
 lower=candles['lower'];higher=candles['higher'];entry=trade['entryAt']
 warning=None
 if evidence is None:warning='Exact saved setup evidence is unavailable for the selected context, array and confirmation. Recorded trade levels and candles are shown without substituting another setup.'
 start=entry-2*86400000
 if evidence:
  start=min(start,evidence['array']['origin'],evidence['confirmation']['origin'],evidence['touch']['t'],evidence['context'].get('origin',start))
 anchor=evidence['touch']['t'] if evidence else entry
 prefix=[b for b in higher if b['t']<anchor]
 high_start=prefix[-60]['t'] if len(prefix)>=60 else (prefix[0]['t'] if prefix else start)
 end=trade['exitKnownAt'] or candles['lower'][-1]['knownAt']
 selected=[b for b in lower if start<=b['t']<=end]
 return {'trade':trade,'attributions':attrs,'evidenceOptions':[{k:a[k] for k in ('contextId','arrayId','confirmation','tf1Kind','tf2Kind')} for a in attrs],'evidence':evidence,'lower':selected,'higher':[b for b in higher if high_start<=b['t']<=end], 'daily':candles['daily'], 'forwardDates':forward_dates(entry,trade.get('market'),candles['daily']), 'snapshotAt':manifest['snapshotAt'],'audit':{k:v for k,v in candles.items() if k.endswith('Audit')},'warning':warning}
if __name__=='__main__':
 try:print(json.dumps(chart(*sys.argv[1:]),allow_nan=False))
 except Exception as e:print(json.dumps({'error':str(e)}));sys.exit(1)
