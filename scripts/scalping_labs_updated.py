"""Scalping Labs v1: read-only causal research over shared, cached SMC primitives.

No database writes, orders, reference-date injection or source-specific exceptions.
Derived blocks are explicit local interpretations; native SMC payloads stay intact.
"""
import importlib.util
import json
import hashlib
import os
import sys
from bisect import bisect_left,bisect_right
from tf1_touch_window import TF1TouchWindow
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

os.environ['SMC_CREDIT'] = '0'
spec = importlib.util.spec_from_file_location('mss_engine', Path(__file__).with_name('market-structure-shift.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
from mss_strategy_requirements import evaluate
from fvg_dealing_range import AutoFibRanges

VERSION = 'scalping-labs-v1'
ARRAYS = {'OB','BREAKER','FVG','IFVG','BPR','MITIGATION','PROPULSION'}
CONTEXTS = ARRAYS | {'WICK','REJECTION','GAP','NYOPEN'}

def active(z, at):
    return z['knownAt'] <= at and (z.get('retiredAt') is None or at < z['retiredAt'])

def context_live(z, at):
    # Sweeping a liquidity line is the trigger, not invalidation of the reversal
    # story. Array close-through invalidation remains enforced. Age and reversal
    # breach still bound the resulting entries in retests().
    return z['knownAt']<=at and (z['kind'] in {'BSL','SSL','EQH','EQL'} or active(z,at))

def context_bar_live(z, bar):
    # A previous-day high/low belongs only to the session for which yesterday
    # was selected. A recent touch must not carry an obsolete daily source.
    return (z.get('sessionDay') is None or z['sessionDay']==bar['day']) and context_live(z,bar['t'])

def retest_cache_key(z,event,context,settings,mode):
    # Swept liquidity lines retain their reversal story, while close-through of
    # an array ends its story. Equal retirement clocks are not equal lifetimes.
    liquidity_story=context['kind'] in {'BSL','SSL','EQH','EQL'}
    return (z['id'],event['id'],event['formationStart'],context.get('retiredAt'),
            context.get('sessionDay'),liquidity_story,settings['anchor'],settings['maxAgeBars'],mode)

def derived(kind, sign, low, high, source, at, tf, bars, lineage=None):
    retired = next((b['knownAt'] for b in bars if b['t'] >= at and
                    (b['c'] < low if sign == 1 else b['c'] > high)), None)
    return {'id':f'{tf}:{kind}:{source["t"]}:{at}:{sign}', 'kind':kind,'tf':tf,
            'direction':'BUY' if sign == 1 else 'SELL','low':low,'high':high,
            'origin':source['t'],'originDay':source['day'],'knownAt':at,
            'retiredAt':retired,'status':'ACTIVE','touches':0,'lastTouch':None,
            'description':f'{kind} · Scalping Labs local interpretation, not native SMC',
            'lineage':lineage,'raw':{'source':'SCALPING_LABS_INTERPRETATION','sourceCandle':source}}

def displacement_ranges(zones, bars, tf):
    """Causal union of consecutive same-direction FVGs in one displacement.

    Each growing range is a separate known-at version. Superseded versions expire
    at the next version's activation; the native individual gaps remain intact.
    """
    gaps=sorted((z for z in zones if z['kind']=='FVG'),key=lambda z:z['knownAt'])
    out=[];run=[];previous=None
    for z in gaps:
        middle=(z.get('raw') or {}).get('middleIndex')
        prior=(run[-1].get('raw') or {}).get('middleIndex') if run else None
        if not run or middle is None or prior is None or middle!=prior+1 or z['direction']!=run[-1]['direction']:
            run=[z];previous=None;continue
        run.append(z)
        sign=1 if z['direction']=='BUY' else -1
        source=next(b for b in bars if b['t']==run[0]['origin'])
        merged=derived('FVG',sign,min(x['low'] for x in run),max(x['high'] for x in run),source,z['knownAt'],tf,bars)
        merged['id']=f'{tf}:DISPLACEMENT_FVG:{source["t"]}:{z["knownAt"]}:{sign}'
        merged['description']='FVG · consecutive displacement gap range'
        merged['raw']={'source':'consecutive_displacement_fvg_union','sourceIds':[x['id'] for x in run],'sourceKnownAt':[x['knownAt'] for x in run],'middleIndex':middle}
        if previous:previous['retiredAt']=min(previous['retiredAt'] or z['knownAt'],z['knownAt'])
        out.append(merged);previous=merged
    return out

def enrich(zones, bars, tf, extra_context=False):
    by_time = {b['t']:b for b in bars}
    out = list(zones) + displacement_ranges(zones,bars,tf) + base.balanced_ranges(zones,bars,tf)
    # Retired native OB -> failed delivery / mitigation candidate. Keep its source range.
    # A separate breaker still retains native source lineage; never overwrite it.
    for z in zones:
        if z['kind'] != 'OB': continue
        source = by_time.get(z['origin'])
        if not source: continue
        sign = 1 if z['direction']=='BUY' else -1
        if z.get('retiredAt'):
            out.append(derived('MITIGATION',-sign,z['low'],z['high'],source,z['retiredAt'],tf,bars,z['id']))
        # Propulsion interpretation: valid OB revisit followed by a later advancing
        # directional close beyond the source high/low, known only on that close.
        hit = next((i for i,b in enumerate(bars) if active(z,b['t']) and b['l']<=z['high'] and b['h']>=z['low']),None)
        if hit is not None:
            confirm = next((b for b in bars[hit+1:] if active(z,b['t']) and
                            sign*(b['c']-b['o'])>0 and sign*(b['c']-(source['h'] if sign==1 else source['l']))>0),None)
            if confirm: out.append(derived('PROPULSION',sign,z['low'],z['high'],source,confirm['knownAt'],tf,bars,z['id']))
    if extra_context:
        # HTF wick/rejection anchors come from confirmed structural pivots,
        # not every historical candle wick. Availability includes pivot confirmation.
        for pivot in zones:
            if pivot['kind'] not in {'BSL','SSL'}:continue
            b=by_time.get(pivot['origin'])
            if not b:continue
            body_low,body_high=sorted([b['o'],b['c']])
            sign=1 if pivot['kind']=='SSL' else -1
            low,high=(b['l'],body_low) if sign==1 else (body_high,b['h'])
            if high<=low:continue
            at=max(b['knownAt'],pivot['knownAt'])
            out.append(derived('REJECTION',sign,low,high,b,at,tf,bars,pivot['id']))
            ce=(low+high)/2
            out.append(derived('WICK',sign,ce,ce,b,at,tf,bars,pivot['id']))
    return out

def opening_context(bars, daily):
    out=[]; ny=ZoneInfo('America/New_York')
    for b in bars:
        local=datetime.fromtimestamp(b['t']/1000,ny)
        if local.hour==0 and local.minute==0:
            for sign in [1,-1]:out.append(derived('NYOPEN',sign,b['o'],b['o'],b,b['knownAt'],'1d',bars))
        if local.weekday()==0:
            earlier=[x for x in bars if x['t']<b['t'] and datetime.fromtimestamp(x['t']/1000,ny).isocalendar()[:2]==local.isocalendar()[:2]]
            if earlier:continue
            previous=next((d for d in reversed(daily) if d['knownAt']<=b['t']),None)
            if previous and previous['c']!=b['o']:
                low,high=sorted([previous['c'],b['o']])
                for sign in [1,-1]:out.append(derived('GAP',sign,low,high,b,b['knownAt'],'1w',bars, str(previous['t'])))
    return out

def anchor_price(z, bars, policy):
    if policy=='EDGE':return z['high'] if z['direction']=='BUY' else z['low']
    if policy not in {'OB_OPEN','BODY_MT'} or z['kind'] not in {'OB','BREAKER','MITIGATION','PROPULSION'}:return (z['low']+z['high'])/2
    source=next((b for b in bars if b['t']==z['origin']),None)
    if policy=='OB_OPEN' and z['kind'] in {'OB','BREAKER','MITIGATION','PROPULSION'} and source:return source['o']
    if policy=='BODY_MT' and z['kind'] in {'OB','BREAKER','MITIGATION','PROPULSION'} and source:return (source['o']+source['c'])/2
    if policy=='EDGE':return z['high'] if z['direction']=='BUY' else z['low']
    return (z['low']+z['high'])/2

class BarIndex:
    """Exact timestamp slices and suffix extrema over the same sorted candles."""
    def __init__(self,bars):
        self.bars=bars;self.times=[b['t'] for b in bars];self.by_time={b['t']:b for b in bars}
        self.known_times=[b['knownAt'] for b in bars]
        self.positions={b['t']:i for i,b in enumerate(bars)}
        ny=ZoneInfo('America/New_York');self.local={};self.midnights={}
        for b in bars:
            local=datetime.fromtimestamp(b['t']/1000,ny);self.local[b['t']]=local
            if local.hour==0 and local.minute==0:self.midnights.setdefault(local.date(),b)
        self.high_suffix=[float('-inf')]*(len(bars)+1);self.low_suffix=[float('inf')]*(len(bars)+1)
        for i in range(len(bars)-1,-1,-1):
            self.high_suffix[i]=max(bars[i]['h'],self.high_suffix[i+1])
            self.low_suffix[i]=min(bars[i]['l'],self.low_suffix[i+1])

    def between(self,start,end):
        return self.bars[bisect_left(self.times,start):bisect_right(self.times,end)]

    def midnight_before(self,at):
        local=self.local.get(at)
        if local is None:local=datetime.fromtimestamp(at/1000,ZoneInfo('America/New_York'))
        bar=self.midnights.get(local.date())
        return bar if bar and bar['knownAt']<=at else None

    def previous_bodies(self,at,count):
        end=bisect_right(self.known_times,at)
        return [abs(b['c']-b['o']) for b in self.bars[max(0,end-count):end]]

    def entry(self,b,price,sign):
        later=self.positions[b['t']]+1
        high=self.high_suffix[later];low=self.low_suffix[later]
        return {'at':b['t'],'knownAt':b['knownAt'],'price':price,'candle':b,
                'mfe':max(0,high-price if sign==1 else price-low),
                'mae':max(0,price-low if sign==1 else high-price),
                'lastClose':self.bars[-1]['c'] if later<len(self.bars) else b['c']}

def retests(bars,z,event,context,settings,scope,mode,index=None):
    ready=max(event['knownAt'],z['knownAt']);sign=1 if event['direction']=='BUY' else -1
    # The investigation touch is used below for the actual structural plan; this
    # expiry uses only the event's own reversal leg, available at confirmation.
    formation=index.between(event['formationStart'],event['at']) if index else [b for b in bars if event['formationStart']<=b['t']<=event['at']]
    if not formation:formation=index.between(context['knownAt'],event['at']) if index else [b for b in bars if context['knownAt']<=b['t']<=event['at']]
    extreme=min(b['l'] for b in formation) if sign==1 else max(b['h'] for b in formation)
    price=anchor_price(z,bars,settings['anchor']);inside=False;out=[];age=0
    for b in bars[bisect_left(index.times,event['knownAt']):] if index else bars:
        # The shift owns the setup lifetime. A later array must not reset it.
        if b['t']<event['knownAt']:continue
        age+=1
        if age>settings['maxAgeBars'] or not context_bar_live(context,b) or (b['t']>=ready and not active(z,b['t'])):break
        # Breach candle is ambiguous with an entry touch; conservatively withhold.
        if (b['l']<extreme if sign==1 else b['h']>extreme):break
        if b['t']<ready:continue
        hit=b['l']<=price<=b['h']
        if hit and (mode=='CANDLES' or not inside):
            if index:out.append(index.entry(b,price,sign))
            else:
                later=[x for x in bars if x['t']>b['t']]
                out.append({'at':b['t'],'knownAt':b['knownAt'],'price':price,'candle':b,
                            'mfe':max([0]+[sign*((x['h'] if sign==1 else x['l'])-price) for x in later]),
                            'mae':max([0]+[-sign*((x['l'] if sign==1 else x['h'])-price) for x in later]),
                            'lastClose':later[-1]['c'] if later else b['c']})
            if mode=='FIRST':break
        inside=hit
    return out

def plan(entry,event,touch,z,bars,zones,htf,daily,settings):
    # Risk belongs to this reversal leg, not an earlier warmup context visit.
    reversal=next((b for b in bars if b['t']==event['formationStart']),touch)
    p=base.structural_plan(entry,event,reversal,bars,zones,daily)
    sign=1 if event['direction']=='BUY' else -1
    if settings['stop']=='ARRAY':p['stop']=z['low'] if sign==1 else z['high'];p['stopAt']=z['origin']
    elif settings['stop']=='OB_MT':p['stop']=anchor_price(z,bars,'BODY_MT');p['stopAt']=z['origin']
    p['stop']-=sign*settings['tickSize']
    targets=p['targetCandidates']
    if settings['target']=='HTF_ARRAY':
        targets=[]
        for target in htf:
            price=target['low'] if sign==1 else target['high']
            if target['kind'] in ARRAYS and target['direction']!=event['direction'] and active(target,entry['at']) and sign*(price-entry['price'])>0:
                targets.append({'id':target['id'],'kind':target['kind'],'tf':target['tf'],'low':price,'origin':target['origin'],'knownAt':target['knownAt']})
        targets.sort(key=lambda target:sign*(target['low']-entry['price']))
    risk=sign*(entry['price']-p['stop']);target=targets[0] if targets else None
    p.update(targetCandidates=targets,targetSource=target,target=target['low'] if target else None,
             rr=sign*(target['low']-entry['price'])/risk if target and risk>0 else None,
             state='INVALID_STOP' if risk<=0 else 'NO_TARGET' if not target else 'READY',
             rule=f"Scalping Labs {settings['stop']} stop + {settings['tickSize']} configured tick; {settings['target']} target; sweep optional only for reaction preset.")
    return p

def tags(entry,event,context,z,bars,index=None):
    available=[];p=entry['plan'];ny=ZoneInfo('America/New_York')
    if p.get('sweepSources'):available.append('RAID')
    if z['kind'] in {'IFVG','MITIGATION'} or event['label']=='IFVG_FAILURE':available.append('INVERSION')
    if z['kind'] in {'BREAKER','BPR'}:available.append('BREAKER')
    if context['kind'] in CONTEXTS:available.append('REACTION')
    local=datetime.fromtimestamp(entry['at']/1000,ny)
    midnight=index.midnight_before(entry['at']) if index else next((b for b in bars if b['knownAt']<=entry['at'] and (d:=datetime.fromtimestamp(b['t']/1000,ny)).date()==local.date() and d.hour==0 and d.minute==0),None)
    sign=1 if event['direction']=='BUY' else -1
    if context['kind'] in {'GAP','NYOPEN'} or midnight and sign*(midnight['o']-entry['price'])>=0:available.append('OPENING')
    if z['knownAt']>event['knownAt']:available.append('CONTINUATION')
    return available


def run(data):
    settings=data['scalping'];bars=data['lower'];daily=data['daily'];tf=data['tf2']
    bar_index=BarIndex(bars)
    bar_times=[b['t'] for b in bars]
    day_at={b['t']:b['day'] for b in bars}
    htf,_=base.cached_scan(data['higher'],data['tf1'])
    ltf,events=base.cached_scan(bars,tf,data.get('confirmation')!='WICK')
    htf=enrich(htf,data['higher'],data['tf1'],True)+opening_context(bars,daily)
    ltf=enrich(ltf,bars,tf)
    if data.get('candleOrderBlocks'):ltf+=base.candle_delivery_blocks(bars,tf)
    if data.get('candleOrderBlocks'):htf+=base.candle_delivery_blocks(data['higher'],data['tf1'])
    confirmation=data.get('confirmation','CHOCH')
    if confirmation in {'CISD','EITHER'}:events+=base.delivery_shifts(bars,ltf,tf)
    if confirmation in {'LOCAL','LOCAL_WICK'}:
        pivots=base.confirmed_local_pivots(bars,tf,data.get('pivotStrength',3))
        events=base.local_swing_shifts(bars,pivots,tf,confirmation=='LOCAL')
    labels={'LOCAL_SHIFT'} if confirmation in {'LOCAL','LOCAL_WICK'} else {'CISD'} if confirmation=='CISD' else {'CHOCH','CISD'} if confirmation=='EITHER' else {'CHOCH'}
    if confirmation=='IFVG_FAILURE':
        labels={'IFVG_FAILURE'};events=[]
        for z in ltf:
            if z['kind']!='IFVG':continue
            candle=next((b for b in bars if b['knownAt']==z['knownAt']),None)
            if candle:events.append({'id':z['id']+':failure','label':'IFVG_FAILURE','direction':z['direction'],'origin':z['origin'],'formationStart':z['origin'],'at':candle['t'],'knownAt':z['knownAt'],'level':z['high'] if z['direction']=='BUY' else z['low'],'raw':{'sourceArray':z['lineage'],'interpretation':'Completed-close FVG failure'}})
    if confirmation in {'WICK','LOCAL_WICK'}:events=[{**e,'breakMode':'wick'} for e in events]
    eligible_events=[e for e in events if e['label'] in labels and (data.get('carryIn') or data['start']<=day_at[e['at']]) and day_at[e['at']]<=data['end']]
    directional_events={side:[e for e in eligible_events if e['direction']==side] for side in ['BUY','SELL']}
    high_ranges=AutoFibRanges(data['higher'],data['tf1'])
    low_ranges=AutoFibRanges(bars,tf)
    valid_high='VALID_FVG' in data['htfKinds'];valid_low='VALID_FVG' in data['ltfKinds']
    liquidity_zones=[z for z in htf+ltf if z['kind'] in {'BSL','SSL','EQH','EQL'}]
    checklist_zones=[z for z in ltf if z['kind'] in {'BREAKER','FVG','BSL','SSL'}]
    contexts=[z for z in htf if (z['kind']=='FVG' and 'VALID_FVG' in data['htfKinds']) or z['kind'] in data['htfKinds'] or {'EQH':'BSL','EQL':'SSL'}.get(z['kind']) in data['htfKinds'] or z['kind'] in {'BSL','SSL'} and 'SWINGS' in data['htfKinds']]
    for day in sorted({b['day'] for b in bars if data['start']<=b['day']<=data['end']}):
        previous=next((d for d in reversed(daily) if d['day']<day and d['knownAt']<=next(b['t'] for b in bars if b['day']==day)),None)
        if not previous:continue
        for kind,price,sign in [('PDH',previous['h'],-1),('PDL',previous['l'],1)]:
            if kind in data['htfKinds']:
                context=derived(kind,sign,price,price,previous,previous['knownAt'],'1d',[b for b in bars if b['day']==day])
                context.update(id=context['id']+':session:'+day,sessionDay=day)
                contexts.append(context)
    fvg_audit={'TF1':{},'TF2':{}}
    out=[];reasons={};scope=data.get('arrayScope','EXISTING');seen=set();entry_cache={};plan_cache={}
    for context in contexts:
        touches=[];context_hits=[];inside=False
        for b in bars:
            hit=(data.get('carryIn') or b['day']>=data['start']) and b['day']<=data['end'] and (context.get('sessionDay') is None or context['sessionDay']==b['day']) and active(context,b['t']) and b['h']>=context['low'] and b['l']<=context['high']
            if hit and valid_high and context['kind']=='FVG':
                proof=high_ranges.qualify(context,b['t'])
                fvg_audit['TF1'][proof['reason']]=fvg_audit['TF1'].get(proof['reason'],0)+1
                hit=proof['valid']
            if hit:context_hits.append(b)
            if hit and not inside:touches.append(b)
            inside=hit
        touch_window=TF1TouchWindow(data['higher'],context_hits,data['tf1'])
        # Prefer the latest context visit for each shift; preserve the actual touch.
        for touch in reversed(touches):
            touch_position=bisect_left(bar_times,touch['t'])
            shifts=[e for e in directional_events[context['direction']] if e['at']>touch['t'] and context_live(context,e['knownAt']) and (context.get('sessionDay') is None or context['sessionDay']==day_at[e['at']]) and touch_window.proof(e['knownAt'])['valid'] and (e['label']!='CISD' or e['formationStart']>=touch['t']) and bisect_right(bar_times,e['at'])-touch_position<=settings['maxAgeBars']]
            for source_event in shifts or [None]:
                identity=(context['id'],source_event['id'] if source_event else touch['t'])
                if identity in seen:continue
                seen.add(identity)
                candidates=[];event=source_event;eligible_count=0;awaiting_count=0;held_count=0;held_reasons={}
                if event:
                    leg=bars[touch_position:bisect_right(bar_times,event['at'])]
                    extreme=min(leg,key=lambda b:b['l']) if event['direction']=='BUY' else max(leg,key=lambda b:b['h'])
                    event={**event,'formationStart':max(touch['t'],event.get('formationStart',extreme['t']))}
                    for z in ltf:
                        if (z['kind'] not in data['ltfKinds'] and not (z['kind']=='FVG' and valid_low)) or z['direction']!=event['direction'] or not base.eligible_array(z,event,bars,scope):continue
                        eligible_count+=1
                        entry_key=retest_cache_key(z,event,context,settings,data.get('retestMode','FIRST'))
                        if entry_key not in entry_cache:entry_cache[entry_key]=retests(bars,z,event,context,settings,scope,data.get('retestMode','FIRST'),bar_index)
                        entries=[dict(x) for x in entry_cache[entry_key]]
                        # Recheck lifetimes at consumption too: a cache entry is
                        # never authorization to use a retired array/context.
                        entries=[entry for entry in entries if data['start']<=entry['candle']['day']<=data['end'] and context_bar_live(context,entry['candle']) and active(z,entry['at'])]
                        for entry in entries or [None]:
                            candidate={'zone':z,'entry':entry,'firstRetestBeforeConfirmation':None}
                            if entry:
                                plan_key=(event['id'],touch['t'],entry['at'],entry['price'],z['id'] if settings['stop']!='EXTREME' else None)
                                if plan_key not in plan_cache:plan_cache[plan_key]=plan(entry,event,touch,z,bars,liquidity_zones,htf,daily,settings)
                                entry['plan']=dict(plan_cache[plan_key])
                                matched=tags(entry,event,context,z,bars,bar_index)
                                entry['playbooks']=matched
                                filters=data.get('strategyFilters') or {'version':1,'playbook':'CUSTOM','required':[],'direction':'ALL','entryPrice':'CE','minRR':0,'maxRR':None,'session':'ANY'}
                                checklist=evaluate(entry,event,touch,context,z,bars,checklist_zones,filters,index=bar_index)
                                checklist['playbook']='SCALPING_LABS';checklist['selection']['scalping']=settings
                                at_shift=touch_window.proof(event['knownAt'])
                                at_entry=touch_window.proof(entry['at'],event['knownAt'])
                                freshness={'valid':at_shift['valid'] and at_entry['valid'],'shift':at_shift,'entry':at_entry}
                                checklist['checks'].append({'id':'TF1_TOUCH_FRESHNESS','step':'TF1 touch within latest five candles at shift and entry','required':True,'verdict':'PASS' if freshness['valid'] else 'FAIL','evidence':freshness,'source':'TF1_FIVE_CANDLE_WINDOW'})
                                if not freshness['valid']:checklist['blockers'].append('TF1_TOUCH_FRESHNESS')
                                for enabled,level,index,clock,name in [(valid_high,context,high_ranges,entry['at'],'TF1'),(valid_low,z,low_ranges,entry['at'],'TF2')]:
                                    if enabled and level['kind']=='FVG':
                                        proof=index.qualify(level,clock)
                                        fvg_audit[name][proof['reason']]=fvg_audit[name].get(proof['reason'],0)+1
                                        check_id='VALID_FVG_'+name
                                        checklist['checks'].append({'id':check_id,'step':name+' FVG in directional half of confirmed swing range','required':True,'verdict':'PASS' if proof['valid'] else 'FAIL','evidence':proof,'source':'AUTO_FIB_RETRACEMENT_DEALING_RANGE'})
                                        if not proof['valid']:checklist['blockers'].append(check_id)

                                selected=[tag for tag in matched if tag in settings['playbooks']]
                                continuation_only=matched==['CONTINUATION'] or z['knownAt']>event['knownAt'] and 'CONTINUATION' not in settings['playbooks']
                                if not selected or continuation_only:checklist['blockers'].append('PLAYBOOK')
                                if entry['plan']['state']!='READY':checklist['blockers'].append(entry['plan']['state'])
                                checklist['checks'].append({'id':'PLAYBOOK','step':'Selected source-derived playbook','required':True,'verdict':'PASS' if selected and not continuation_only else 'FAIL','evidence':{'available':matched,'selected':selected,'arrayKnownAt':z['knownAt'],'confirmation':event['knownAt']},'source':'SCALPING_LABS_PROPOSAL'})
                                checklist['eligible']=not checklist['blockers'];entry['checklist']=checklist
                                freeze=lambda zone:{**zone,'retiredAt':zone.get('retiredAt') if zone.get('retiredAt') is not None and zone['retiredAt']<=entry['at'] else None}
                                entry['signal_key']=hashlib.sha256(f"{VERSION}:tf1-touch5-v1{':auto-fib-v1' if valid_high or valid_low else ''}:{data.get('symbol','')}:{data['tf1']}:{tf}:{event['direction']}:{z['id']}:{entry['at']}:{settings['anchor']}".encode()).hexdigest()
                                entry['strategy_json']={'signal_key':entry['signal_key'],'version':VERSION,'context':freeze(context),'touch':touch,'confirmation':event,'array':freeze(z),'plan':entry['plan'],'settings':settings,'playbooks':selected,'entryAt':entry['at'],'tf1TouchFreshness':freshness,'validFvg':{c['id']:c['evidence'] for c in checklist['checks'] if c['id'].startswith('VALID_FVG_')},'knownAt':max([context['knownAt'],event['knownAt'],z['knownAt']]+[c['evidence']['range']['knownAt'] for c in checklist['checks'] if c['id'].startswith('VALID_FVG_') and c['evidence'].get('range')])}
                                if not checklist['eligible']:candidate['rejectedEntry']=entry;candidate['entry']=None
                            if entry is None:
                                awaiting_count+=1
                                if awaiting_count<=3:candidates.append(candidate)
                            elif candidate['entry'] is not None:candidates.append(candidate)
                            else:
                                held_count+=1
                                blocker=','.join(entry['checklist']['blockers'])
                                held_reasons[blocker]=held_reasons.get(blocker,0)+1
                                if held_reasons[blocker]<=3:candidates.append(candidate)
                state='NO_MSS' if not event else 'NO_FORMATION_ARRAY' if not candidates else 'RETEST_ENTRY' if any(c['entry'] for c in candidates) else 'FILTERED_OUT' if any(c.get('rejectedEntry') for c in candidates) else 'AWAITING_RETEST'
                reasons[state]=reasons.get(state,0)+1
                out.append({'id':VERSION+':'+context['id']+':'+(event['id'] if event else str(touch['t'])),'htf':context,'touch':touch,'mss':event,'arrays':candidates,'state':state,'diagnostics':{'eligibleArrays':eligible_count,'awaitingRetest':awaiting_count,'heldEntries':held_count,'heldReasons':held_reasons,'diagnosticSamplesPerReason':3}})
    # Shared analytics de-duplicates array/time entries in response order. Choose
    # the latest causal shift/context as the representative, never an old story.
    out.sort(key=lambda i:((i.get('mss') or {}).get('knownAt',0),i['touch']['t']),reverse=True)
    return {'provider':'smartmoneyconcepts + explicit Scalping Labs interpretations','version':VERSION,'rules':'Completed-prefix context → selected delivery → later anchor touch; configured structural stop and known opposing target. No hardcoded reference trades.','confirmationRule':confirmation,'tf1TouchRule':{'candles':5,'checkAt':['SHIFT_CONFIRMATION','ENTRY'],'tf':data['tf1'],'currentCandleEvidence':'COMPLETED_TF2_ONLY','postShiftTouchRefresh':False},'higherZones':htf,'investigations':out,'diagnostics':reasons,'scalping':settings,'validFvgAudit':fvg_audit,'fvgRanges':{'tf1':high_ranges.timeline()}}

def object_graph(value):
    """Lossless content-interned wire format: shared evidence is emitted once."""
    nodes=[]; identities={}; content={}
    def encode(v):
        if not isinstance(v,(dict,list)):return v
        identity=id(v)
        if identity in identities:return {'$':identities[identity]}
        node=['o',{k:encode(x) for k,x in v.items()}] if isinstance(v,dict) else ['a',[encode(x) for x in v]]
        key=json.dumps(node,sort_keys=True,separators=(',',':'),allow_nan=False)
        index=content.get(key)
        if index is None:
            index=len(nodes);nodes.append(node);content[key]=index
        identities[identity]=index
        return {'$':index}
    root=encode(value)
    return {'encoding':'scalping-object-graph-v1','nodes':nodes,'root':root}

if __name__=='__main__':
    result=run(json.load(sys.stdin))
    if os.environ.get('SCALPING_GRAPH')=='1':result=object_graph(result)
    print(json.dumps(result,allow_nan=False,separators=(',',':')))
