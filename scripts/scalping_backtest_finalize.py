"""Complete report publication after detector and atomic index both finish."""
import sys as _rs, os as _ro; _rs.path.insert(0, _ro.path.dirname(_ro.path.abspath(__file__))); from reports_dir import REPORTS, SCALPING_BACKTEST  # noqa: E402
import json,time,csv,traceback
from pathlib import Path
from datetime import datetime,timezone
from scalping_backtest_analysis import analyze
from scalping_backtest_paired_rr import paired_rr_report
ROOT=SCALPING_BACKTEST
while True:
 try:
  m=json.loads((ROOT/'manifest.json').read_text(encoding='utf-8'));idx=json.loads((ROOT/'index-status.json').read_text(encoding='utf-8')) if (ROOT/'index-status.json').exists() else {}
  complete=m.get('status') in ('COMPLETE','COMPLETE_WITH_ERRORS')
  indexed=idx.get('indexedFiles')==len(m.get('tradeFiles',[]))
  if complete and indexed:
   report=analyze(ROOT)
   paired=paired_rr_report(ROOT)
   ranks=sorted(report['rankings'],key=lambda r:r['trainCostSensitivity']['2']['netR'],reverse=True)
   with (ROOT/'combinations.csv').open('w',encoding='utf-8',newline='') as f:
    names=['market','TF1','TF2','confirmation','RRbucket','trainClosed','trainGrossR','train2bpsR','holdoutClosed','holdoutGrossR','holdout2bpsR','allClosed','allGrossR','open'];w=csv.writer(f);w.writerow(names)
    for r in ranks:w.writerow([r['market'],r['tf1Kind'],r['tf2Kind'],r['confirmation'],r['rrBucket'],r['train']['closed'],r['train']['netR'],r['trainCostSensitivity']['2']['netR'],r['holdout']['closed'],r['holdout']['netR'],r['holdoutCostSensitivity']['2']['netR'],r['all']['closed'],r['all']['netR'],r['all']['open']])
   lines=['# Scalping Labs historical backtest','','Status: '+m['status'],f"Requested January 1, 2017 through October 9, 2026; frozen snapshot {m.get('snapshotAt')}. 45 available instruments (31 US, including SPY and QQQ, and 14 forex); TF1 1 hour / TF2 5 minutes; close CHOCH + CISD; all five R:R scenarios. This is a current-symbol universe, not point-in-time index constituents (survivorship limit).",'',report['selectionPolicy'],'',report['costPolicy'],'','## Market evaluation choices','']
   for r in report['recommendationsByMarket']:
    c=r['choice'];lines+=[f"{r['market']}: {r['verdict']}"]
    if c:lines+=[f"TF1 {c['tf1Kind']} / TF2 {c['tf2Kind']} / {c['confirmation']} / R:R {c['rrBucket']}; training at assumed 2 bps cost {c['trainCostSensitivity']['2']['netR']:.2f}R; holdout at assumed 2 bps cost {c['holdoutCostSensitivity']['2']['netR']:.2f}R ({c['holdout']['closed']} closed)."]
   lines+=['','## Coverage and execution','',f"Completed tickers {m['counts']['completed']} of {m['counts']['instruments']}; weekly chunks {m['counts']['chunks']}; economic bucket scenarios {report['uniqueEconomicScenarios']}. Errors: {len(m.get('errors',[]))}. Unresolved entries remain OPEN; no artificial end exit. Separate bucket scenarios and level-attribution groups overlap and do not constitute an additive portfolio.",'','Eligible entries differ between buckets because a qualifying existing liquidity target must be available. These conditional bucket totals alone cannot establish which R:R is best for the same entries.','', 'Missing native forex 1-hour timestamps are supplemented by strict consecutive complete 5-minute rollups; native OHLC takes precedence. Input sources, invalid/conflicting exclusions, dataset hashes and execution hashes are retained per ticker and chunk. Bounded detector replay state uses 250 TF2 warmup bars and up to 600 TF1 bars from 30 calendar days; no interpolation. PDH/PDL contexts are scoped to their own session. Price bars alone cannot establish executable quotes or intrabar order.','']
   lines+=['## Common-entry R:R comparison','',paired['policy'],'']
   for cohort in paired['commonFamilies']:
    if cohort['scope']=='MARKET':lines.append(f"{cohort['market']} / {cohort['period']}: {cohort['eligible']} common entry families; {cohort['comparableClosed']} comparable closed; {cohort['unresolved']} unresolved; {cohort['trainingBoundaryExcluded']} cross-boundary training exclusions.")
   lines+=['','See paired-rr-comparison.json for all five bucket outcomes on identical entries and stops. These are descriptive comparisons; holdout performance does not select a new setting.','']
   (ROOT/'report.md').write_text('\n'.join(lines),encoding='utf-8');(ROOT/'publication-status.json').write_text(json.dumps({'status':'PUBLISHED' if m['status']=='COMPLETE' else 'PUBLISHED_WITH_ERRORS','generatedAt':datetime.now(timezone.utc).isoformat(),'economicScenarios':report['uniqueEconomicScenarios'],'rankingGroups':len(ranks),'pairedRRStatus':paired['status']},indent=2),encoding='utf-8');print(json.dumps({'published':True,'status':m['status'],'scenarios':report['uniqueEconomicScenarios']}),flush=True);break
 except FileNotFoundError:pass
 except Exception as e:
  (ROOT/'publication-error.json').write_text(json.dumps({'error':str(e),'trace':traceback.format_exc(),'at':datetime.now(timezone.utc).isoformat()}),encoding='utf-8');print('Publication error: '+str(e),flush=True)
 time.sleep(30)
