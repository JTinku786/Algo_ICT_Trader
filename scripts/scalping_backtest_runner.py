"""Resumable, read-only ticker-parallel Scalping Labs research.

Weekly entry windows reproduce the website's bounded detector history: at most
600 TF1 candles from 30 calendar days and 250 completed TF2 warmup bars. Exits
use the complete subsequently available archive; unresolved orders remain OPEN.
"""
import argparse,json,os,time,hashlib,traceback,bisect,gzip
import multiprocessing
from contextlib import nullcontext
from itertools import islice
from pathlib import Path
from datetime import date,timedelta,datetime,timezone
from concurrent.futures import ProcessPoolExecutor,wait,FIRST_COMPLETED
from scalping_backtest_data import connect,inventory,load,hourly,merge_hourly,merge_daily_us
import scalping_labs_updated as engine
from scalping_backtest_validation import BUCKETS,select_target,evaluate_trade,economic_identity,audit_candidate
from scalping_backtest_compact import ReplayBars,FirstHitIndex

ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'public/reports/scalping-labs/backtest'
HTF=['OB','VALID_FVG','IFVG','BREAKER','BPR','BSL','SSL','SWINGS','PDH','PDL']
LTF=['OB','FVG','VALID_FVG','IFVG','BREAKER','BPR']
VERSION='scalping-backtest-touch5-v1'
_LOAD_LIMIT=None
def initialize_worker(load_limit):
    global _LOAD_LIMIT
    _LOAD_LIMIT=load_limit
HASH_FILES=['scalping_labs_updated.py','market-structure-shift.py','scalping_backtest_validation.py','tf1_touch_window.py','fvg_dealing_range.py','scalping_backtest_data.py','mss_primitives.py','mss_strategy_requirements.py','mss_scan_fast.py','scalping_backtest_compact.py','scalping_backtest_runner.py']
def policy_fingerprint(config,days):
    hashes={p:hashlib.sha256((ROOT/'scripts'/p).read_bytes()).hexdigest() for p in HASH_FILES}
    return hashlib.sha256(json.dumps({'config':config,'engineHashes':hashes,'chunkDays':days},sort_keys=True).encode()).hexdigest(),hashes
def freeze_config(market,symbol,start,end):
    tick=.001 if market=='forex' and 'JPY' in symbol else .01 if market=='us' or 'XAU' in symbol or 'XAG' in symbol else .00001
    return {'symbol':symbol,'tf1':'1h','tf2':'5m','start':start,'end':end,'htfKinds':HTF,'ltfKinds':LTF,'confirmation':'EITHER','arrayScope':'CONTINUATION','carryIn':True,'retestMode':'ALL','pivotStrength':3,'candleOrderBlocks':False,'scalping':{'version':1,'playbooks':['RAID','INVERSION','BREAKER','REACTION','OPENING','CONTINUATION'],'anchor':'CE','stop':'EXTREME','target':'LIQUIDITY','tickSize':tick,'maxAgeBars':200}}
def windows(start,end,days=7):
    current=date.fromisoformat(start);last=date.fromisoformat(end)
    while current<=last:
        final=min(last,current+timedelta(days=days-1));yield current.isoformat(),final.isoformat();current=final+timedelta(days=1)
def replace_atomic(source,destination,attempts=15):
    """Windows readers / OneDrive may briefly deny atomic replacement."""
    for attempt in range(attempts):
        try:return source.replace(destination)
        except OSError as error:
            denied=sharing_denied(error)
            if not denied or attempt==attempts-1:raise
            time.sleep(min(.05*2**attempt,1.0))
def sharing_denied(error):
    return isinstance(error,OSError) and (isinstance(error,PermissionError) or getattr(error,'winerror',None)==5 or ('access is denied' in str(error).lower() or 'permission denied' in str(error).lower()))
def json_write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_name(path.name+f'.tmp.{os.getpid()}.{time.time_ns()}')
    try:
        temp.write_text(json.dumps(value,separators=(',',':'),allow_nan=False),encoding='utf-8');replace_atomic(temp,path)
    finally:
        try:temp.unlink(missing_ok=True)
        except OSError as error:
            if not sharing_denied(error):raise
def ticker_job(job):
    market,symbol,start,end,days,pilot,cutoff=job
    folder=OUT/(market+'_'+symbol.replace('^','').replace('/','_'));(folder/'chunks').mkdir(parents=True,exist_ok=True)
    config={**freeze_config(market,symbol,start,end),'snapshotAt':cutoff}
    fingerprint,hashes=policy_fingerprint(config,days)
    json_write(folder/'status.json',{'market':market,'symbol':symbol,'status':'LOADING','config':config,'fingerprint':fingerprint,'completedChunks':0,'trades':0,'tradeFiles':[],'evidenceFiles':[]})
    with _LOAD_LIMIT if _LOAD_LIMIT is not None else nullcontext():
        began=time.perf_counter();from_date=(date.fromisoformat(start)-timedelta(days=40)).isoformat()
        cache=folder/f'candles-{start}-{end}-{cutoff}.json.gz'
        if cache.exists():
            with gzip.open(cache,'rt',encoding='utf-8') as f:payload=json.load(f)
            lower,higher,daily,la,ha,da=[payload[k] for k in ['lower','higher','daily','lowerAudit','higherAudit','dailyAudit']]
        else:
            conn=connect();lower,la=load(conn,market,symbol,'5m',from_date,end,cutoff)
            higher,ha=load(conn,market,symbol,'1h',from_date,end,cutoff) if market=='forex' else (hourly(lower),{'source':'same completed contiguous 5m archive'})
            if market=='forex':higher,derived_audit=merge_hourly(higher,lower,market);ha['derivation']=derived_audit
            daily,da=load(conn,market,symbol,'1d',(date.fromisoformat(start)-timedelta(days=740)).isoformat(),end,cutoff);conn.close()
            if market=='us':daily,daily_derivation=merge_daily_us(daily,lower);da['derivation']=daily_derivation
            temp=cache.with_suffix('.tmp')
            with gzip.open(temp,'wt',encoding='utf-8',compresslevel=1) as f:json.dump({'lower':lower,'higher':higher,'daily':daily,'lowerAudit':la,'higherAudit':ha,'dailyAudit':da},f,separators=(',',':'))
            replace_atomic(temp,cache)
        dataset_hash=hashlib.sha256(cache.read_bytes()).hexdigest()
        if not lower or not higher:
            result={'market':market,'symbol':symbol,'status':'NO_DATA','lowerCount':len(lower),'higherCount':len(higher)};json_write(folder/'status.json',result);return result
        lower=ReplayBars(lower)
        if 'payload' in locals():del payload
        exits=FirstHitIndex(lower)
    high_days=[b['day'] for b in higher];daily_days=[b['day'] for b in daily]
    compatibility=json.loads((OUT/'performance-compatible-policies.json').read_text(encoding='utf-8')) if (OUT/'performance-compatible-policies.json').exists() else {'policies':[]}
    accepted_policies={p['fingerprint'] for p in compatibility['policies'] if p['config']==config and p.get('chunkDays')==days}
    accepted_policies.add(fingerprint)
    done=[];total=0;errors=[];scan_time=0
    for ws,we in windows(start,end,days):
        checkpoint=folder/'chunks'/(ws+'.json')
        if checkpoint.exists():
            prior=json.loads(checkpoint.read_text(encoding='utf-8'))
            if prior.get('fingerprint') in accepted_policies and prior.get('datasetHash')==dataset_hash and not prior.get('violations'):done.append(prior);total+=prior.get('trades',0);continue
        left=lower.day_index(ws);right=lower.day_index(we,'right')
        if left==right:json_write(checkpoint,{'fingerprint':fingerprint,'start':ws,'end':we,'trades':0,'status':'NO_CANDLES'});continue
        high_left=bisect.bisect_left(high_days,(date.fromisoformat(ws)-timedelta(days=30)).isoformat());high_right=bisect.bisect_right(high_days,we)
        data={**config,'start':ws,'end':we,'lower':lower[max(0,left-250):right],'higher':higher[max(high_left,high_right-600):high_right],'daily':daily[:bisect.bisect_right(daily_days,we)]}
        if not data['higher']:raise RuntimeError(f'No completed native or derived H1 history for {market}:{symbol} {ws}–{we}')
        try:
            now=time.perf_counter();result=engine.run(data);elapsed=time.perf_counter()-now;scan_time+=elapsed
            unique={};violations=[]
            for inv in result['investigations']:
                for a in inv['arrays']:
                    entry=a.get('entry')
                    if not entry:continue
                    failures=audit_candidate(inv,a)
                    if failures:violations.append({'entryAt':entry['at'],'failures':failures});continue
                    for bucket in BUCKETS:
                        plan=select_target(entry['plan'],bucket)
                        if not plan:continue
                        identity=economic_identity(symbol,entry,inv['mss']['direction'],plan['target'])
                        key=hashlib.sha256(json.dumps(identity).encode()).hexdigest();tf1={'FVG':'VALID_FVG','BSL':'SWINGS','SSL':'SWINGS','EQH':'BSL','EQL':'SSL'}.get(inv['htf']['kind'],inv['htf']['kind']);tf2='VALID_FVG' if a['zone']['kind']=='FVG' else a['zone']['kind']
                        attribution={'tf1Kind':tf1,'tf1RawKind':inv['htf']['kind'],'tf2Kind':tf2,'tf2RawKind':a['zone']['kind'],'confirmation':inv['mss']['label'],'contextId':inv['htf']['id'],'arrayId':a['zone']['id']}
                        if key in unique:
                            if attribution not in unique[key]['attributions']:unique[key]['attributions'].append(attribution)
                            continue
                        outcome=exits.evaluate(entry,plan)
                        unique[key]={'id':key,'symbol':symbol,'market':market,'entryAt':entry['at'],'entryKnownAt':entry['knownAt'],'side':inv['mss']['direction'],'tf1Kind':tf1,'tf2Kind':tf2,'confirmation':inv['mss']['label'],'rrBucket':bucket,'plannedRR':plan['rr'],'entry':entry['price'],'stop':plan['stop'],'target':plan['target'],**outcome,'attributions':[attribution],'strategy_json':{**entry['strategy_json'],'plan':plan,'backtest':{'version':VERSION,'windowStart':ws,'windowEnd':we,'fingerprint':fingerprint,'bucket':bucket}}}
            entries=list(unique.values());tradefile=folder/'chunks'/(ws+'.ndjson');evidencefile=folder/'chunks'/(ws+'.evidence.ndjson.gz')
            trade_temp=tradefile.with_suffix('.ndjson.tmp');evidence_temp=evidencefile.with_suffix('.ndjson.tmp')
            with trade_temp.open('w',encoding='utf-8') as t,gzip.open(evidence_temp,'wt',encoding='utf-8',compresslevel=3) as e:
                for record in entries:
                    e.write(json.dumps({'id':record['id'],'strategy_json':record.pop('strategy_json')},separators=(',',':'))+'\n');t.write(json.dumps(record,separators=(',',':'))+'\n')
            replace_atomic(trade_temp,tradefile);replace_atomic(evidence_temp,evidencefile)
            checkpoint_data={'fingerprint':fingerprint,'datasetHash':dataset_hash,'start':ws,'end':we,'trades':len(entries),'status':'COMPLETE','scanSeconds':elapsed,'tradeFile':str(tradefile.relative_to(OUT)).replace('\\','/'),'evidenceFile':str(evidencefile.relative_to(OUT)).replace('\\','/'),'lowerCandles':len(data['lower']),'higherCandles':len(data['higher']),'violations':violations};json_write(checkpoint,checkpoint_data);done.append(checkpoint_data);total+=len(entries)
            if violations:raise RuntimeError(f'{len(violations)} candidate causal-invariant violations in {ws}; first: {violations[0]}')
            json_write(folder/'status.json',{'market':market,'symbol':symbol,'status':'RUNNING','config':config,'fingerprint':fingerprint,'completedChunks':len(done),'lastCompleted':we,'trades':total,'elapsedSeconds':time.perf_counter()-began,'tradeFiles':[d['tradeFile'] for d in done if d.get('tradeFile')],'evidenceFiles':[d['evidenceFile'] for d in done if d.get('evidenceFile')]})
            if pilot:break
        except Exception as ex:
            errors.append({'start':ws,'error':str(ex),'trace':traceback.format_exc()});json_write(checkpoint.with_suffix('.error.json'),errors[-1]);raise
    status={'market':market,'symbol':symbol,'status':'PILOT_COMPLETE' if pilot else 'COMPLETE','config':config,'fingerprint':fingerprint,'engineHashes':hashes,'coverage':{'lowerFirst':lower[0]['day'],'lowerLast':lower[-1]['day'],'higherFirst':higher[0]['day'],'higherLast':higher[-1]['day'],'lowerCount':len(lower),'higherCount':len(higher),'dailyCount':len(daily)},'audit':{'lower':la,'higher':ha,'daily':da},'chunks':len(done),'trades':total,'scanSeconds':scan_time,'elapsedSeconds':time.perf_counter()-began,'errors':errors,'tradeFiles':[d['tradeFile'] for d in done if d.get('tradeFile')],'evidenceFiles':[d['evidenceFile'] for d in done if d.get('evidenceFile')]};json_write(folder/'status.json',status);return status

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--start',default='2017-01-01');ap.add_argument('--end',default='2026-10-09');ap.add_argument('--workers',type=int,default=8);ap.add_argument('--symbols',default='');ap.add_argument('--chunk-days',type=int,default=7);ap.add_argument('--pilot',action='store_true');args=ap.parse_args()
    OUT.mkdir(parents=True,exist_ok=True)
    frozen_inventory=OUT/'coverage-inventory.json';snapshot_path=OUT/'input-snapshot.json'
    existing_snapshot=json.loads(snapshot_path.read_text(encoding='utf-8')) if snapshot_path.exists() else {}
    if frozen_inventory.exists() and existing_snapshot.get('start')==args.start and existing_snapshot.get('end')==args.end:
        cover=json.loads(frozen_inventory.read_text(encoding='utf-8'))
    else:
        conn=connect();cover=inventory(conn);conn.close();json_write(frozen_inventory,cover)
    instruments=sorted({(r['market'],r['symbol']) for r in cover if r['table']=='historical_candles_5m'})
    if args.symbols:instruments=[x for x in instruments if x[1] in args.symbols.split(',')]
    # Interleave independent markets so website progress includes both from the start.
    us=[x for x in instruments if x[0]=='us'];fx=[x for x in instruments if x[0]=='forex'];instruments=[]
    for i in range(max(len(us),len(fx))):
        if i<len(us):instruments.append(us[i])
        if i<len(fx):instruments.append(fx[i])
    snapshot_path=OUT/'input-snapshot.json';snapshot=json.loads(snapshot_path.read_text(encoding='utf-8')) if snapshot_path.exists() else {}
    cutoff=snapshot.get('snapshotAt') if snapshot.get('start')==args.start and snapshot.get('end')==args.end else int(datetime.now(timezone.utc).timestamp()*1000)
    json_write(snapshot_path,{'start':args.start,'end':args.end,'snapshotAt':cutoff,'rule':'Frozen completed-candle cut-off, lossless persisted ticker inputs; resume never loads later live bars.'})
    jobs=[(m,s,args.start,args.end,args.chunk_days,args.pilot,cutoff) for m,s in instruments]
    expected_fingerprints={(m,s):policy_fingerprint({**freeze_config(m,s,args.start,args.end),'snapshotAt':cutoff},args.chunk_days)[0] for m,s in instruments}
    state={'version':VERSION,'status':'RUNNING','snapshotAt':cutoff,'generatedAt':datetime.now(timezone.utc).isoformat(),'selection':{'start':args.start,'end':args.end,'tf1':'1h','tf2':'5m','htfKinds':HTF,'ltfKinds':LTF,'confirmations':['CHOCH','CISD'],'rrBuckets':list(BUCKETS),'close':'UNTIL_STOP_OR_TARGET','workers':min(16,args.workers),'windowPolicy':'Weekly entry windows; 250TF2 warmup; 600TF1 maxwithin30calendardays; independent causal targets; allsubsequent available completedbars for exit; unresolvedremainOPEN'},'counts':{'instruments':len(jobs),'completed':0},'holdoutStart':'2024-01-01','results':[],'errors':[]}
    json_write(OUT/'run-status.json',state)
    load_limit=multiprocessing.Semaphore(min(4,args.workers))
    with ProcessPoolExecutor(max_workers=min(16,args.workers),initializer=initialize_worker,initargs=(load_limit,)) as pool:
        futures={pool.submit(ticker_job,j):j for j in jobs}
        publication_attempts={j:0 for j in jobs}
        pending=set(futures)
        while pending:
            finished,pending=wait(pending,timeout=15,return_when=FIRST_COMPLETED)
            for f in finished:
                job=futures[f]
                try:r=f.result();state['results'].append(r);state['counts']['completed']+=1;print(json.dumps({'symbol':job[1],'status':r['status'],'trades':r.get('trades'),'seconds':r.get('elapsedSeconds')}),flush=True)
                except Exception as ex:
                    if sharing_denied(ex) and publication_attempts[job]<2:
                        publication_attempts[job]+=1;retry=pool.submit(ticker_job,job);futures[retry]=job;pending.add(retry)
                        event={'symbol':job[1],'attempt':publication_attempts[job],'error':str(ex),'at':datetime.now(timezone.utc).isoformat()};state.setdefault('publicationRetries',[]).append(event);print(json.dumps({'publicationRetry':event}),flush=True)
                    else:state['errors'].append({'symbol':job[1],'error':str(ex)});print(json.dumps(state['errors'][-1]),flush=True)
            ticker_states=[]
            for market,symbol in instruments:
                p=OUT/(market+'_'+symbol.replace('^','').replace('/','_'))/'status.json'
                if p.exists():
                    s=json.loads(p.read_text(encoding='utf-8'))
                    if s.get('fingerprint')==expected_fingerprints[(market,symbol)]:ticker_states.append(s)
            state['tickerProgress']=[{k:v for k,v in s.items() if k in ['market','symbol','status','lastCompleted','completedChunks','trades','elapsedSeconds','coverage']} for s in ticker_states]
            state['tradeFiles']=[p for s in ticker_states for p in s.get('tradeFiles',[])];state['evidenceFiles']=[p for s in ticker_states for p in s.get('evidenceFiles',[])];state['counts']['chunks']=sum(s.get('completedChunks',s.get('chunks',0)) for s in ticker_states);state['counts']['trades']=sum(s.get('trades',0) for s in ticker_states)
            state['generatedAt']=datetime.now(timezone.utc).isoformat();json_write(OUT/'manifest.json',state)
            json_write(OUT/'run-status.json',state)
    state['status']='COMPLETE' if not state['errors'] else 'COMPLETE_WITH_ERRORS';json_write(OUT/'run-status.json',state);json_write(OUT/'manifest.json',state)
