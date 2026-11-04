import sys,importlib.util
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
s=importlib.util.spec_from_file_location('mss',Path(__file__).with_name('market-structure-shift.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
bars=[{'t':i,'knownAt':i+1,'o':100,'h':105,'l':95,'c':100,'day':'2026-06-03'} for i in range(10)]
z=[{'id':'high','kind':'BSL','origin':1,'knownAt':3,'low':104,'high':104},{'id':'low','kind':'SSL','origin':4,'knownAt':7,'low':95,'high':95}]
bars[5]['c']=105;bars[7]['c']=106
x=m.local_swing_shifts(bars,z,'1m');assert len(x)==1 and x[0]['at']==7 and x[0]['knownAt']==8 and x[0]['level']==104
assert x[0]['raw']['reversalKnownAt']<=x[0]['knownAt'] and x[0]['raw']['opposingKnownAt']<=x[0]['knownAt']
bars[6]['l']=94;assert not m.local_swing_shifts(bars,z,'1m')
assert not m.local_swing_shifts(bars,[z[1]],'1m')
a={'origin':8,'knownAt':10};e={'at':7,'knownAt':8,'formationStart':4}
assert m.eligible_array(a,e,bars,'CONTINUATION') and not m.eligible_array(a,e,bars,'FORMATION') and not m.eligible_array(a,e,bars,'EXISTING')
print('PASS: local pivots known before confirmation, no backdated early break, new extreme cancellation, no missing opposing pivot, continuation scope isolated')

# Separate visits: overlapping consecutive bars remain one entry; leaving then returning is new.
zone={'low':99,'high':101,'retiredAt':None}
visit=[{'t':i,'knownAt':i+1,'o':100,'h':h,'l':l,'c':100,'day':'2026-06-03','minute':i} for i,(h,l) in enumerate([(102,100),(102,100),(105,103),(102,100),(102,100)])]
assert [x['at'] for x in m.retest_episodes(visit,zone,0,'BUY')]==[0,3]
assert [x['at'] for x in m.retest_episodes(visit,zone,0,'BUY',3)]==[0]
assert [x['at'] for x in m.retest_episodes(visit,{**zone,'retiredAt':3},0,'BUY')]==[0]
# Candle-delivery block cannot exist before the second advancing directional close.
b=[{'t':0,'knownAt':1,'day':'d','o':104,'h':105,'l':99,'c':100},{'t':1,'knownAt':2,'day':'d','o':100,'h':106,'l':100,'c':105},{'t':2,'knownAt':3,'day':'d','o':105,'h':108,'l':104,'c':107},{'t':3,'knownAt':4,'day':'d','o':107,'h':107,'l':98,'c':98}]
assert not m.candle_delivery_blocks(b[:2],'1h')
block=m.candle_delivery_blocks(b,'1h')[0];assert block['origin']==0 and block['knownAt']==3 and block['low']==99 and block['high']==105 and block['retiredAt']==4
assert not m.candle_delivery_blocks([{**b[0],'c':104},b[1],b[2]],'1h')
# Local wick mode confirms only after pivot availability and leaves close mode separate.
bars=[{'t':i,'knownAt':i+1,'o':100,'h':105,'l':95,'c':100,'day':'d'} for i in range(10)]
assert not m.local_swing_shifts(bars,z,'1m',True)
assert m.local_swing_shifts(bars,z,'1m',False)[0]['knownAt']>=z[1]['knownAt']
pivots=m.confirmed_local_pivots([{'t':i,'knownAt':i+1,'h':h,'l':h-2} for i,h in enumerate([1,3,1,4,1])],'1m',1)
assert all(p['knownAt']>p['origin'] for p in pivots)
print('PASS: distinct retest episodes, retirement/cap, candle OB activation/retirement, local wick separation and causal fixed pivots')

assert [x['at'] for x in m.retest_episodes(visit,zone,0,'BUY',every_candle=True)]==[0,1,3,4]
print('PASS: every retest candle explicitly separated from distinct visits')
