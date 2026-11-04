import importlib.util
from pathlib import Path
s=importlib.util.spec_from_file_location('mss',Path(__file__).with_name('market-structure-shift.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def gap(id,d,lo,hi,known):return dict(id=id,kind='FVG',direction=d,low=lo,high=hi,knownAt=known,origin=known-3,originDay='2026-08-03',raw={'middleIndex':2})
old=gap('a','BUY',100,104,10);new=gap('b','SELL',102,106,20)
bars=[dict(t=19,knownAt=20,h=107,l=101,c=105),dict(t=20,knownAt=21,h=104,l=103,c=103),dict(t=21,knownAt=22,h=106,l=103,c=105)]
z=m.balanced_ranges([new,old],bars,'1m')[0]
assert (z['low'],z['high'],z['direction'],z['knownAt'])==(102,104,'SELL',20)
assert z['raw']['sourceIds']==['a','b'] and z['touches']==2 and z['retiredAt']==22
assert not m.balanced_ranges([old,gap('same','BUY',102,106,20)],[],'1m')
assert not m.balanced_ranges([old,gap('edge','SELL',104,106,20)],[],'1m')
assert not m.balanced_ranges([old,gap('simultaneous','SELL',102,106,10)],[],'1m')
assert m.balanced_ranges([gap('x','SELL',100,104,10),gap('y','BUY',102,106,20)],[],'1m')[0]['direction']=='BUY'
print('PASS: BPR overlap, both source timing, direction, retirement, no edge/same-direction/simultaneous pairs')

# Preserve both overlaps when a newer narrow gap also intersects the reversal gap.
older=gap('wide','BUY',1.15362,1.15367,10)
recent=gap('narrow','BUY',1.15370,1.15371,15)
bear=gap('bear','SELL',1.15363,1.15372,20)
z=m.balanced_ranges([older,recent,bear],[],'1m')
assert {(a['low'],a['high']) for a in z}=={(1.15363,1.15367),(1.15370,1.15371)}
assert len({a['id'] for a in z})==2
print('PASS: earlier August 3 overlap retained alongside newest overlap')

assert not m.balanced_ranges([{**old,'retiredAt':new['origin']-1},new],[],'1m'), 'Gap invalidated before opposing leg cannot create a new BPR'
assert m.balanced_ranges([{**old,'retiredAt':new['knownAt']},new],[],'1m'), 'Opposing leg may invalidate earlier gap during BPR formation'
print('PASS: stale source excluded; displacement invalidation allowed')
