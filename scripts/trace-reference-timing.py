import sys as _rs, os as _ro; _rs.path.insert(0, _ro.path.dirname(_ro.path.abspath(__file__))); from reports_dir import REPORTS, SCALPING_BACKTEST  # noqa: E402
import sys,json,importlib.util
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
s=importlib.util.spec_from_file_location('mss',Path(__file__).with_name('market-structure-shift.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
root=(REPORTS/'icy-tea');refs=json.loads((root/'corrected-references.json').read_text(encoding='utf-8'));original={r['index']:r for r in json.loads((root/'audit.json').read_text(encoding='utf-8'))['results']};out=[]
for r in refs:
 old=original[r['index']]
 if r['date']!=old['date']:continue
 key=f"{old['symbol']}-{old['date']}-{old['testedTF1']}-{old['tf2']}-{old['entryKind']}"
 d=json.loads((root/f'evidence-{key}.json').read_text(encoding='utf-8'));bars=d['lower']
 lo,hi=[int(x[:2])*60+int(x[3:]) for x in r['entryWindow']]
 window=[b for b in bars if b['day']==r['date'] and lo<=b['minute']<=hi];result={'index':r['index'],'date':r['date'],'entryWindow':r['entryWindow'],'modes':[]}
 for close in [True,False]:
  zs,events=m.cached_scan(bars,r['tf2'],close);events=events+m.delivery_shifts(bars,zs,r['tf2']) if close else events
  traces=[]
  for a in zs:
   if a['kind'] not in [r['entryKind'],'FVG','OB'] or a['direction']!=r['direction']:continue
   hits=[b for b in window if b['t']>=a['knownAt'] and (a.get('retiredAt') is None or b['t']<a['retiredAt']) and b['h']>=a['low'] and b['l']<=a['high']]
   if r.get('priceBand'):hits=[b for b in hits if r['priceBand'][0]<=min(max(b['o'],a['low']),a['high'])<=r['priceBand'][1]]
   if not hits:continue
   at=hits[0]['t'];before=[e for e in events if e['direction']==r['direction'] and e['knownAt']<=at];after=[e for e in events if e['direction']==r['direction'] and e['knownAt']>at]
   first=next((b for b in bars if b['t']>=a['knownAt'] and (a.get('retiredAt') is None or b['t']<a['retiredAt']) and b['h']>=a['low'] and b['l']<=a['high']),None)
   traces.append({'array':a,'windowRetests':hits,'firstRetest':first,'latestKnownEvents':sorted(before,key=lambda e:e['knownAt'])[-5:],'nextEvents':sorted(after,key=lambda e:e['knownAt'])[:3]})
  result['modes'].append({'mode':'CLOSE_CISD' if close else 'WICK','traces':traces})
 out.append(result);print(r['index'],[len(x['traces']) for x in result['modes']])
 (root/'reference-timing-traces.json').write_text(json.dumps(out,indent=2),encoding='utf-8')
