"""Optional causal research requirements; never relabel local rules as native SMC."""
from datetime import datetime
from zoneinfo import ZoneInfo
from statistics import median

def price_bars(bars, zone, ready, end_at, mode, entry_mode):
    """CE eligibility is evaluated before choosing visits, not on edge-only results."""
    midpoint=(zone['low']+zone['high'])/2
    out=[];inside=False
    for b in bars:
        eligible=b['t']>=ready and (end_at is None or b['t']<end_at) and (zone.get('retiredAt') is None or b['t']<zone['retiredAt'])
        hit=eligible and (b['l']<=midpoint<=b['h'] if entry_mode=='CE' else b['h']>=zone['low'] and b['l']<=zone['high'])
        if hit and (mode=='CANDLES' or not inside):
            price=midpoint if entry_mode=='CE' else min(max(b['o'],zone['low']),zone['high'])
            sign=1 if zone['direction']=='BUY' else -1
            later=[x for x in bars if x['t']>b['t']]
            out.append({'at':b['t'],'knownAt':b['knownAt'],'price':price,'candle':b,'mfe':max([0]+[sign*((x['h'] if sign==1 else x['l'])-price) for x in later]),'mae':max([0]+[-sign*((x['l'] if sign==1 else x['h'])-price) for x in later]),'lastClose':later[-1]['c'] if later else b['c']})
            if mode=='FIRST':break
        inside=hit
    return out

def evaluate(entry, event, touch, context, array, bars, zones, filters, index=None):
    evidence=[]
    def check(key, label, passed, details, source='LOCAL_ADAPTATION'):
        evidence.append({'id':key,'step':label,'required':key in filters['required'],'verdict':'UNVERIFIED' if passed is None else 'PASS' if passed else 'FAIL','evidence':details,'source':source})
    sign=1 if event['direction']=='BUY' else -1
    plan=entry['plan']
    check('CAUSAL','Activation and confirmation precede entry',context['knownAt']<=touch['t'] and event['knownAt']<=entry['at'] and array['knownAt']<=entry['at'],{'htfKnownAt':context['knownAt'],'touchAt':touch['t'],'shiftKnownAt':event['knownAt'],'arrayKnownAt':array['knownAt'],'entryAt':entry['at']},'ENGINE_CONTRACT')
    check('SWEEP','Liquidity sweep and reclaim',bool(plan.get('sweepSources')),{'sources':plan.get('sweepSources',[]),'extremeAt':plan['stopAt'],'extremePrice':plan['stop']})
    b=index.by_time.get(event['at']) if index else next((b for b in bars if b['t']==event['at']),None)
    preceding=index.previous_bodies(event['at'],20) if index else [abs(x['c']-x['o']) for x in bars if x['knownAt']<=event['at']][-20:]
    body=abs(b['c']-b['o']) if b else 0;span=b['h']-b['l'] if b else 0;baseline=median(preceding) if preceding else 0
    displacement=None if not b or len(preceding)<20 or baseline<=0 or span<=0 else sign*(b['c']-b['o'])>0 and body/span>=.6 and body>=1.5*baseline
    check('DISPLACEMENT','Shift candle displacement',displacement,{'body':body,'range':span,'bodyFraction':body/span if span else None,'priorMedianBody':baseline,'bars':len(preceding),'requiredBodyFraction':.6,'requiredMedianMultiple':1.5,'at':event['at']})
    leg=index.between(event['formationStart'],event['at']) if index else [x for x in bars if event['formationStart']<=x['t']<=event['at']]
    midpoint=(min(x['l'] for x in leg)+max(x['h'] for x in leg))/2 if leg else None
    check('PD_RANGE','TF2 formation premium / discount',None if midpoint is None else sign*(midpoint-entry['price'])>=0,{'midpoint':midpoint,'entry':entry['price'],'from':event['formationStart'],'through':event['at'],'rangeTF':array['tf']})
    range_low=min((x['l'] for x in leg),default=None);range_high=max((x['h'] for x in leg),default=None)
    retracement=None if range_low is None or range_high<=range_low else ((range_high-entry['price']) if sign==1 else (entry['price']-range_low))/(range_high-range_low)
    check('OTE','TF2 formation 62-79 percent retracement',None if retracement is None else .62<=retracement<=.79,{'low':range_low,'high':range_high,'retracement':retracement,'entry':entry['price'],'from':event['formationStart'],'through':event['at'],'rangeTF':array['tf']})
    others=[z for z in zones if z['kind'] in ['BREAKER','FVG'] and z['direction']==event['direction'] and z['knownAt']<=entry['at'] and (z.get('retiredAt') is None or z['retiredAt']>entry['at'])]
    pairs=[{'breaker':array['id'] if array['kind']=='BREAKER' else other['id'],'fvg':array['id'] if array['kind']=='FVG' else other['id'],'low':max(array['low'],other['low']),'high':min(array['high'],other['high']),'knownAt':max(array['knownAt'],other['knownAt'])} for other in others if array['kind'] in ['BREAKER','FVG'] and other['kind']!=array['kind'] and max(array['low'],other['low'])<=entry['price']<=min(array['high'],other['high'])]
    check('UNICORN','Selected entry in breaker / FVG overlap',bool(pairs),{'overlaps':pairs[:10]})
    kind='BSL' if sign==-1 else 'SSL'
    pivots=sorted([z for z in zones if z['kind']==kind and z['knownAt']<=event['knownAt'] and z['origin']<=event['at']],key=lambda x:x['origin'])[-3:]
    drives=len(pivots)==3 and all((pivots[i]['low']>pivots[i-1]['low'] if sign==-1 else pivots[i]['low']<pivots[i-1]['low']) for i in [1,2])
    check('THREE_DRIVES','Three confirmed progressively extended pivots',drives,{'pivots':[{'id':z['id'],'origin':z['origin'],'knownAt':z['knownAt'],'price':z['low']} for z in pivots]})
    ce=(context['low']+context['high'])/2
    check('HTF_CE','Selected TF1 imbalance midpoint reached',context['kind'] in ['FVG','IFVG'] and touch['l']<=ce<=touch['h'],{'kind':context['kind'],'midpoint':ce,'touch':touch})
    local=datetime.fromtimestamp(entry['at']/1000,ZoneInfo('America/New_York'))
    midnight=index.midnight_before(entry['at']) if index else next((x for x in bars if (t:=datetime.fromtimestamp(x['t']/1000,ZoneInfo('America/New_York'))).date()==local.date() and t.hour==0 and t.minute==0 and x['knownAt']<=entry['at']),None)
    check('NY_OPEN','Favourable side of NY midnight opening',None if not midnight else sign*(midnight['o']-entry['price'])>=0,{'opening':midnight,'entry':entry['price'],'timezone':'America/New_York'})
    check('TARGET','Existing unswept opposing liquidity target',plan.get('target') is not None and plan.get('targetSource',{}).get('knownAt',float('inf'))<=entry['at'],{'target':plan.get('target'),'source':plan.get('targetSource'),'rr':plan.get('rr')},'ENGINE_CONTRACT')
    check('SMT','Synchronized intermarket divergence',None,{'reason':'No synchronized comparison instrument or selected pivot pair in this request.'})
    check('NEWS','News calendar clearance',None,{'reason':'No event calendar or exclusion interval in this request.'})
    minute=local.hour*60+local.minute
    windows={'LONDON':(60,300),'NEW_YORK':(420,600),'LONDON_LUNCH':(300,420)}
    session=filters['session'];window=windows.get(session)
    direction_ok=filters['direction']=='ALL' or event['direction']==filters['direction']
    session_ok=not window or window[0]<=minute<window[1]
    rr=plan.get('rr');rr_active=filters['minRR']>0 or filters['maxRR'] is not None
    rr_ok=not rr_active or rr is not None and rr>=filters['minRR'] and (filters['maxRR'] is None or rr<filters['maxRR'])
    blockers=[x['id'] for x in evidence if (x['required'] or x['id']=='CAUSAL') and x['verdict']!='PASS']
    if not direction_ok:blockers.append('DIRECTION')
    if not session_ok:blockers.append('SESSION')
    if not rr_ok:blockers.append('RR')
    return {'version':1,'playbook':filters['playbook'],'eligible':not blockers,'blockers':blockers,'checks':evidence,'selection':filters,'sessionEvidence':{'timezone':'America/New_York','minute':minute,'window':window,'pass':session_ok},'rrEvidence':{'rr':rr,'minimumInclusive':filters['minRR'],'maximumExclusive':filters['maxRR'],'pass':rr_ok}}
