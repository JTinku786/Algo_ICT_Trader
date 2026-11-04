"""Verify the explicit delivery-run candidate independently of native CHOCH."""
import importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('mss',Path(__file__).with_name('market-structure-shift.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def bar(t,o,c,h=None,l=None):
    return dict(t=t,knownAt=t+1,o=o,c=c,h=max(o,c)+.1 if h is None else h,l=min(o,c)-.1 if l is None else l)
bars=[bar(0,100,101),bar(1,101,102),bar(2,102,102,103),bar(3,102,101),bar(4,101,100,102,99),bar(5,100,99)]
swing=dict(kind='BSL',origin=2,knownAt=5)
events=m.delivery_shifts(bars,[swing],'1m')
assert len(events)==1 and events[0]['direction']=='SELL' and events[0]['at']==5
assert events[0]['level']==100 and events[0]['formationStart']==2
assert not m.delivery_shifts(bars[:5],[swing],'1m'), 'Wick/close equal to opening must not confirm'
assert not m.delivery_shifts(bars,[{**swing,'knownAt':7}],'1m'), 'No future swing confirmation'
assert not m.delivery_shifts(bars[:3]+[bar(3,102,101,104)]+bars[4:],[swing],'1m'), 'New extreme invalidates'
assert not m.delivery_shifts([bar(0,101,100)]+bars[1:],[swing],'1m'), 'One directional body insufficient'
mirrored=[{**b,'o':200-b['o'],'c':200-b['c'],'h':200-b['l'],'l':200-b['h']} for b in bars]
events=m.delivery_shifts(mirrored,[{**swing,'kind':'SSL'}],'1m')
assert len(events)==1 and events[0]['direction']=='BUY' and events[0]['at']==5
print('PASS: CISD candidate close-only, neutral bridge, two bodies, confirmed swing, invalidation, both directions')
