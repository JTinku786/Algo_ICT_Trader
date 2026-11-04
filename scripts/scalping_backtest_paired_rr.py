"""Read-only common-entry R:R comparison; never selects a holdout winner.

An eligible cohort requires exactly one economic scenario in each of the five
buckets for the same market/symbol/side/entry time/entry price/stop. Pair cohorts
add identical TF1/TF2/confirmation attribution. Results.sqlite is opened mode=ro;
only the separate JSON report is written. Aggregate rows are bounded by the fixed
five buckets and selected pair dimensions, not by the number of trades.
"""
import sys as _rs, os as _ro; _rs.path.insert(0, _ro.path.dirname(_ro.path.abspath(__file__))); from reports_dir import REPORTS, SCALPING_BACKTEST  # noqa: E402
import json
import sqlite3
import os
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

BUCKETS=('0-1','1-2','2-3','3-4','4+')
DEFAULT_CUTOFF=int(datetime(2024,1,1,tzinfo=ZoneInfo('America/New_York')).timestamp()*1000)
DISCLOSURE=('Ordinary R:R bucket results use different eligible entry cohorts: a setup is absent when no known liquidity target exists inside that bucket. '
            'These totals therefore do not isolate the effect of R:R. The common-entry comparison below requires the same entry and stop to have one target in all five buckets. '
            'Comparable realized returns use only families where all five scenarios have closed. Unresolved families remain explicitly counted; their exclusion can favor faster-resolving setups. '
            'Pair cohorts overlap and must not be added as portfolio returns. Neither holdout rankings nor these paired summaries choose or lock a new strategy.')


def atomic_report(path,report):
    temporary=path.with_name(path.name+f'.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(report,indent=2,allow_nan=False),encoding='utf-8')
    for attempt in range(5):
        try:
            temporary.replace(path);return
        except PermissionError:
            if attempt==4:raise
            time.sleep(.05*(attempt+1))


def source_status(root):
    for name in ['manifest.json','run-status.json']:
        try:
            state=json.loads((root/name).read_text(encoding='utf-8'))
            return {'sourceRunStatus':state.get('status','UNKNOWN'),'snapshotAt':state.get('snapshotAt'),
                    'sourceGeneratedAt':state.get('generatedAt'),'partial':state.get('status')!='COMPLETE'}
        except (OSError,ValueError):pass
    return {'sourceRunStatus':'UNKNOWN','snapshotAt':None,'sourceGeneratedAt':None,'partial':True}


def paired_rr_report(root,cutoff=DEFAULT_CUTOFF,write=True):
    root=Path(root).resolve();dbpath=root/'results.sqlite'
    report={'status':'UNAVAILABLE','generatedAt':datetime.now(ZoneInfo('America/New_York')).isoformat(),
            'policy':DISCLOSURE,'holdoutStart':'2024-01-01','selection':'DESCRIPTIVE_ONLY_NO_HOLDOUT_SELECTION',
            'commonFamilies':[],'bucketResults':[]}
    report.update(source_status(root))
    if not dbpath.exists():
        report['reason']='Results index is not available yet.'
        if write:atomic_report(root/'paired-rr-comparison.json',report)
        return report
    db=sqlite3.connect(dbpath.as_uri()+'?mode=ro',uri=True,timeout=30)
    db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
    placeholders=','.join('?' for _ in BUCKETS)
    fields='market,symbol,side,entryAt,entry,stop'
    for scope in ('MARKET','PAIR'):
        dimensions='market' if scope=='MARKET' else 'market,tf1Kind,tf2Kind,confirmation'
        selected='t.market,t.symbol,t.side,t.entryAt,t.entry,t.stop,t.rrBucket,t.result,t.exitAt,t.r,t.riskBps'
        if scope=='PAIR':selected+=',a.tf1Kind AS cohortTf1,a.tf2Kind AS cohortTf2,a.confirmation AS cohortConfirmation'
        join='' if scope=='MARKET' else ' JOIN attributions a ON a.tradeId=t.id'
        aliases='' if scope=='MARKET' else ',cohortTf1 AS tf1Kind,cohortTf2 AS tf2Kind,cohortConfirmation AS confirmation'
        extra='' if scope=='MARKET' else ',cohortTf1,cohortTf2,cohortConfirmation'
        groups=fields+extra
        returns=','.join(f"SUM(CASE WHEN rrBucket='{bucket}' THEN r ELSE 0 END) AS rr{i}" for i,bucket in enumerate(BUCKETS))
        cte=f'''WITH source AS (SELECT {selected} FROM trades t{join} WHERE t.rrBucket IN ({placeholders})),
          families AS (SELECT {fields}{extra},COUNT(*) AS scenarios,COUNT(DISTINCT rrBucket) AS buckets,
            SUM(CASE WHEN result IN ('WIN','LOSS') THEN 1 ELSE 0 END) AS closed,
            MAX(exitAt) AS lastExit,MAX(riskBps) AS riskBps,{returns} FROM source GROUP BY {groups}),
          common AS (SELECT *,CASE WHEN entryAt>=? THEN 'HOLDOUT' ELSE 'TRAIN' END AS period,
            CASE WHEN closed=5 AND (entryAt>=? OR lastExit<?) THEN 1 ELSE 0 END AS comparable
            FROM families WHERE buckets=5 AND scenarios=5)'''
        params=(*BUCKETS,cutoff,cutoff,cutoff)
        aggregate_dims='market'+aliases
        aggregate_group='market'+extra
        for row in db.execute(cte+f''' SELECT {aggregate_dims},period,COUNT(*) AS commonFamilies,
          SUM(comparable) AS comparableFamilies,SUM(CASE WHEN closed<5 THEN 1 ELSE 0 END) AS unresolvedFamilies,
          SUM(CASE WHEN period='TRAIN' AND closed=5 AND comparable=0 THEN 1 ELSE 0 END) AS boundaryCrossingFamilies
          FROM common GROUP BY {aggregate_group},period''',params):
            keys=['market'] if scope=='MARKET' else ['market','tf1Kind','tf2Kind','confirmation']
            report['commonFamilies'].append({'scope':scope,**dict(zip(keys+['period','eligible','comparableClosed','unresolved','trainingBoundaryExcluded'],row))})
        # Pivot once per economic family, rather than joining the full scenario
        # archive back to its grouped cohort. This keeps SQL transport bounded.
        # Exact-price grouping is intentional; rounded prices merge distinct fills.
        dims='market' if scope=='MARKET' else 'market,cohortTf1,cohortTf2,cohortConfirmation'
        parts=[]
        for i,bucket in enumerate(BUCKETS):
            parts.append(f''' SELECT {dims},period,'{bucket}' AS rrBucket,COUNT(*) AS n,
              SUM(rr{i}) AS netR,AVG(rr{i}) AS meanR,SUM(CASE WHEN rr{i}>0 THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN rr{i}>0 THEN rr{i} ELSE 0 END) AS positiveR,
              -SUM(CASE WHEN rr{i}<0 THEN rr{i} ELSE 0 END) AS negativeR,
              SUM(CASE WHEN riskBps>0 THEN 1.0/riskBps ELSE 0 END) AS oneBpsCostR
              FROM common WHERE comparable=1 GROUP BY {dims},period''')
        query=cte+' UNION ALL '.join(parts)
        for row in db.execute(query,params):
            keys=['market'] if scope=='MARKET' else ['market','tf1Kind','tf2Kind','confirmation']
            item={'scope':scope,**dict(zip(keys+['period','rrBucket','closed','netR','expectancyR','wins','positiveR','negativeR','oneBpsCostR'],row))}
            item['winRate']=item['wins']/item['closed'];item['profitFactor']=item['positiveR']/item['negativeR'] if item['negativeR'] else None
            item['costSensitivityNetR']={str(b):item['netR']-b*item['oneBpsCostR'] for b in [1,2,5]}
            report['bucketResults'].append(item)
    baselines={tuple(item.get(k) for k in ['scope','market','tf1Kind','tf2Kind','confirmation','period']):item for item in report['bucketResults'] if item['rrBucket']=='0-1'}
    for item in report['bucketResults']:
        baseline=baselines[tuple(item.get(k) for k in ['scope','market','tf1Kind','tf2Kind','confirmation','period'])]
        item['pairedMeanDeltaVs0To1']=item['expectancyR']-baseline['expectancyR']
    report['indexedEconomicScenarios']=db.execute('SELECT COUNT(*) FROM trades').fetchone()[0]
    db.close();report['status']='AVAILABLE';report['comparisonAvailable']=bool(report['bucketResults'])
    if not report['comparisonAvailable']:report['reason']='No common entry families with one eligible target in every bucket and comparable closed outcomes are indexed yet.'
    if write:atomic_report(root/'paired-rr-comparison.json',report)
    return report


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--root',default=str(SCALPING_BACKTEST))
    report=paired_rr_report(parser.parse_args().root)
    print(json.dumps({'status':report['status'],'commonCohorts':len(report['commonFamilies']),'bucketSummaries':len(report['bucketResults'])}))
