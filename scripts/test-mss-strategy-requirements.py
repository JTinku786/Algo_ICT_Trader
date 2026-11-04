import copy
from mss_strategy_requirements import evaluate,price_bars

filters={'version':1,'playbook':'CUSTOM','required':[],'direction':'ALL','entryPrice':'EDGE','minRR':0,'maxRR':None,'session':'ANY'}
start=1782964800000
bars=[{'t':start+i*60000,'knownAt':start+(i+1)*60000,'o':100,'h':102,'l':99,'c':101,'day':'2026-07-02','minute':i} for i in range(25)]
event={'direction':'BUY','at':bars[21]['t'],'knownAt':bars[21]['knownAt'],'formationStart':bars[20]['t']}
context={'knownAt':start-60000,'kind':'FVG','low':99,'high':102}
zone={'id':'f','kind':'FVG','tf':'1m','direction':'BUY','low':99,'high':101,'origin':start,'knownAt':start,'retiredAt':None}
entry={'at':bars[23]['t'],'knownAt':bars[23]['knownAt'],'price':100,'candle':bars[23],'plan':{'stop':99,'stopAt':start,'target':104,'targetSource':{'knownAt':start},'rr':4,'sweepSources':[]}}
assert evaluate(entry,event,bars[0],context,zone,bars,[zone],filters)['eligible']
assert not evaluate(entry,event,bars[0],context,zone,bars,[zone],{**filters,'required':['SMT']})['eligible']
assert not evaluate(entry,event,bars[0],context,zone,bars,[zone],{**filters,'required':['SWEEP']})['eligible']
assert not evaluate(entry,event,bars[0],context,zone,bars,[zone],{**filters,'maxRR':4})['eligible'], 'upper R bound excluded'
assert evaluate(entry,event,bars[0],context,zone,bars,[zone],{**filters,'minRR':4})['eligible'], 'lower R bound included'
assert not evaluate(entry,event,bars[0],context,zone,bars,[zone],{**filters,'direction':'SELL'})['eligible']
assert not evaluate(entry,{**event,'knownAt':entry['at']+1},bars[0],context,zone,bars,[zone],filters)['eligible'], 'future shift rejected'
breaker={**zone,'id':'b','kind':'BREAKER','low':99.5,'high':100.5}
assert evaluate(entry,event,bars[0],context,zone,bars,[zone,breaker],{**filters,'required':['UNICORN']})['eligible']
assert not evaluate(entry,event,bars[0],context,zone,bars,[zone,{**breaker,'knownAt':entry['at']+1}],{**filters,'required':['UNICORN']})['eligible'], 'future overlap cannot qualify'
assert not evaluate(entry,event,bars[0],context,zone,bars,[zone,{**breaker,'low':100.1}],{**filters,'required':['UNICORN']})['eligible'], 'selecting both types is not overlap'
visit=[{**b,'l':100.5} for b in bars[:2]]+[bars[2]]
assert price_bars(visit,zone,start,None,'FIRST','EDGE')[0]['at']==bars[0]['t']
assert price_bars(visit,zone,start,None,'FIRST','CE')[0]['at']==bars[2]['t'], 'CE waits for midpoint; does not reject edge first visit and miss later CE'
assert not price_bars(visit,{**zone,'retiredAt':bars[2]['t']},start,None,'ALL','CE')
before=copy.deepcopy(entry)
evaluate(entry,event,bars[0],context,zone,bars,[zone],filters)
assert entry==before,'evaluator is pure'
ote_entry={**entry,'price':99.9}
assert evaluate(ote_entry,event,bars[0],context,zone,bars,[zone],{**filters,'required':['OTE']})['eligible'], '70 percent formation retracement passes'
assert not evaluate({**entry,'price':101},event,bars[0],context,zone,bars,[zone],{**filters,'required':['OTE']})['eligible'], '33 percent retracement does not pass OTE'
assert not evaluate(entry,event,bars[0],context,zone,bars[1:],[zone],{**filters,'required':['NY_OPEN']})['eligible'], 'missing midnight opening remains unverified'
assert not evaluate(entry,event,bars[0],context,zone,bars,[zone],{**filters,'session':'LONDON'})['eligible'], '00:23 New York is outside London window'
print('PASS: optional native-compatible filters, AND/unknown fail-closed, RR bounds, future-event and future-overlap rejection, actual overlap, CE later retest, retirement, pure evaluation')
