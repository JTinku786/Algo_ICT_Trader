"""Read-only, completed-prefix SMC investigation; no strategy tables or orders written."""

import os, sys, json, importlib.metadata, hashlib, tempfile, time, inspect

from pathlib import Path

os.environ['SMC_CREDIT']='0'

import pandas as pd

from smartmoneyconcepts import smc

import mss_primitives
from tf1_touch_window import TF1TouchWindow

# Kernels are pinned to the package implementation they were parity-tested against.
primitives = mss_primitives if importlib.metadata.version('smartmoneyconcepts') == '0.0.24' else smc



def scan(bars, tf, close_break=True):

    if len(bars)<8:return [],[]

    df=pd.DataFrame([{'open':b['o'],'high':b['h'],'low':b['l'],'close':b['c'],'volume':b.get('v',0)} for b in bars])

    zones={};events={};swings={};ob_crossed=set()

    def zone(kind,sign,lo,hi,origin,at,raw=None,lineage=None):

        key=f'{tf}:{kind}:{bars[origin]["t"]}:{sign}'

        if key not in zones:

            zones[key]={'id':key,'kind':kind,'tf':tf,'direction':'BUY' if sign==1 else 'SELL','low':float(lo),'high':float(hi),'origin':bars[origin]['t'],'originDay':bars[origin]['day'],'knownAt':bars[at]['knownAt'],'touches':0,'lastTouch':None,'status':'ACTIVE','description':f'{kind} · smartmoneyconcepts completed-prefix evidence' if kind not in ['IFVG','BREAKER'] else f'{kind} · close-through of source array','raw':raw,'lineage':lineage,'retiredAt':None}

        return key

    for i in range(7,len(bars)):

        prefix=df.iloc[:i+1].reset_index(drop=True)

        raw_sw=smc.swing_highs_lows(prefix,swing_length=3)

        # Package endpoint swings are synthetic; only retain pivots with all 3 right candles.

        raw_sw.loc[[j for j in range(len(prefix)) if j<3 or j>i-3],['HighLow','Level']]=float('nan')

        new_swing=False

        for row in raw_sw.dropna(subset=['HighLow']).itertuples():
            j=row.Index

            key=(j,int(row.HighLow))

            if key not in swings:

                new_swing=True

                swings[key]={'index':j,'known':i}

                zone('BSL' if row.HighLow==1 else 'SSL',-int(row.HighLow),row.Level,row.Level,j,i,{'source':'confirmed_swing','HighLow':int(row.HighLow)})

        pools=primitives.liquidity(prefix,raw_sw,range_percent=0.01)

        for row in pools.dropna(subset=['Liquidity']).itertuples():
            j=row.Index

            if pd.notna(row.Swept) and row.Swept>0:continue

            zone('EQH' if row.Liquidity==1 else 'EQL',-int(row.Liquidity),row.Level,row.Level,int(j),i,{'source':'package_liquidity','Liquidity':int(row.Liquidity),'End':int(row.End)})

        structure=primitives.bos_choch(prefix,raw_sw,close_break=close_break)

        for row in structure.dropna(subset=['BrokenIndex']).itertuples():
            j=row.Index

            broken_index=int(row.BrokenIndex)
            # Wick breaks can first become observable after their broken candle,
            # once the fourth supporting swing confirms. Do not discard them or
            # backdate their availability. Preserve the existing close mode.
            if (broken_index!=i if close_break else broken_index>i) or (pd.isna(row.CHOCH) and pd.isna(row.BOS)):continue

            sign=int(row.CHOCH) if pd.notna(row.CHOCH) else int(row.BOS)

            label='CHOCH' if pd.notna(row.CHOCH) else 'BOS'

            key=f'{tf}:{label}:{bars[j]["t"]}:{bars[broken_index]["t"]}:{sign}'

            events.setdefault(key,{'id':key,'label':label,'direction':'BUY' if sign==1 else 'SELL','origin':bars[j]['t'],'at':bars[broken_index]['t'],'knownAt':bars[i]['knownAt'],'level':float(row.Level),'raw':{'BOS':None if pd.isna(row.BOS) else int(row.BOS),'CHOCH':None if pd.isna(row.CHOCH) else int(row.CHOCH),'BrokenIndex':broken_index,'originIndex':int(j)}})

        # The package creates OBs only when price crosses the latest swing. A newly

        # confirmed swing can also make a historical OB first observable on this prefix.

        ob_trigger=new_swing

        for side in [1,-1]:

            eligible=raw_sw[(raw_sw.HighLow==side)&(raw_sw.index<i)]

            if eligible.empty:continue

            j=int(eligible.index[-1]);key=(side,j)

            crossed=bars[i]['c']>bars[j]['h'] if side==1 else bars[i]['c']<bars[j]['l']

            if crossed and key not in ob_crossed:ob_trigger=True;ob_crossed.add(key)

        if ob_trigger:

            obs=primitives.ob(prefix,raw_sw,close_mitigation=True)

            for row in obs.dropna(subset=['OB']).itertuples():
                j=row.Index

                zone('OB',int(row.OB),row.Bottom,row.Top,int(j),i,{'OB':int(row.OB),'Top':float(row.Top),'Bottom':float(row.Bottom),'OBVolume':float(row.OBVolume)})

        # The newly confirmed FVG bounds depend on these three candles only;
        # older FVG mitigation output is not consumed by this scanner.
        fvgs=smc.fvg(prefix.iloc[-3:].reset_index(drop=True),join_consecutive=False)

        j=i-1;row=fvgs.iloc[1]

        if pd.notna(row.FVG):zone('FVG',int(row.FVG),row.Bottom,row.Top,j-1,i,{'FVG':int(row.FVG),'middleIndex':j,'Top':float(row.Top),'Bottom':float(row.Bottom)})

        b=bars[i]

        for z in list(zones.values()):

            if z['retiredAt'] is not None or z['knownAt']>=b['knownAt']:continue

            line=z['kind'] in ['BSL','SSL','EQH','EQL']

            hit=(b['h']>=z['high'] if z['direction']=='SELL' else b['l']<=z['low']) if line else b['h']>=z['low'] and b['l']<=z['high']

            if hit:z['touches']+=1;z['lastTouch']=b['t'];z['status']='TOUCHED'

            invalid=hit if line else b['c']<z['low'] if z['direction']=='BUY' else b['c']>z['high']

            if invalid:

                z['retiredAt']=b['knownAt'];z['status']='SWEPT'

                if z['kind'] in ['OB','FVG']:

                    kind='BREAKER' if z['kind']=='OB' else 'IFVG'

                    # Keep original box anchor; activation occurs only on the close-through.

                    origin=next(j for j,x in enumerate(bars) if x['t']==z['origin'])

                    zone(kind,-1 if z['direction']=='BUY' else 1,z['low'],z['high'],origin,i,lineage=z['id'])

    return list(zones.values()),list(events.values())



def cached_scan(bars,tf,close_break=True):

    # Cache only deterministic library primitives; checkbox/context matching is rerun.

    import mss_scan_fast
    fast=importlib.metadata.version('smartmoneyconcepts')=='0.0.24'
    digest=hashlib.sha256(b'scan-cache-v3'+inspect.getsource(scan).encode()+Path(mss_primitives.__file__).read_bytes()+Path(mss_scan_fast.__file__).read_bytes()+importlib.metadata.version('smartmoneyconcepts').encode()+json.dumps([tf,bars,close_break],sort_keys=True).encode()).hexdigest()

    root=Path(tempfile.gettempdir())/'algo-ict-mss-cache'

    root.mkdir(exist_ok=True)

    target=root/(digest+'.json')

    try:return json.loads(target.read_text())

    except (OSError,ValueError):pass

    result=mss_scan_fast.scan(bars,tf,close_break) if fast else scan(bars,tf,close_break)

    target.write_text(json.dumps(result,allow_nan=False))

    return result



def structural_plan(entry,event,touch,bars,zones,daily):

    sign=1 if event['direction']=='BUY' else -1

    leg=[b for b in bars if touch['t']<=b['t']<=event['at']]

    extreme=min(leg,key=lambda b:b['l']) if sign==1 else max(leg,key=lambda b:b['h'])

    stop=extreme['l'] if sign==1 else extreme['h']

    sweep_kind=['SSL','EQL'] if sign==1 else ['BSL','EQH']

    swept=[z for z in zones if z['kind'] in sweep_kind and z['knownAt']<=extreme['t'] and (z.get('retiredAt') is None or z['retiredAt']>touch['t']) and (extreme['l']<z['low'] if sign==1 else extreme['h']>z['high']) and any((b['c']>z['low'] if sign==1 else b['c']<z['high']) for b in leg if b['t']>=extreme['t'])]

    kinds=['BSL','EQH'] if sign==1 else ['SSL','EQL']

    targets=[z for z in zones if z['kind'] in kinds and z['knownAt']<=entry['at'] and (z.get('retiredAt') is None or z['retiredAt']>entry['at']) and sign*(z['low']-entry['price'])>0]

    previous=next((b for b in reversed(daily) if b['knownAt']<=entry['at'] and b['day']<entry['candle']['day']),None)

    if previous:

        price=previous['h'] if sign==1 else previous['l']

        already=any((b['h']>=price if sign==1 else b['l']<=price) for b in bars if b['day']==entry['candle']['day'] and b['t']<entry['at'])

        if not already and sign*(price-entry['price'])>0:targets.append({'id':'PDH' if sign==1 else 'PDL','kind':'PDH' if sign==1 else 'PDL','tf':'1d','low':price,'knownAt':previous['knownAt'],'origin':previous['t']})

    target=min(targets,key=lambda z:sign*(z['low']-entry['price'])) if targets else None

    risk=sign*(entry['price']-stop)

    state='INVALID_STOP' if risk<=0 else 'NO_CONFIRMED_SWEEP' if not swept else 'NO_TARGET' if not target else 'READY'

    return {'state':state,'direction':event['direction'],'entry':entry['price'],'stop':stop,'stopAt':extreme['t'],'sweepSources':[{'id':z['id'],'kind':z['kind'],'tf':z['tf'],'level':z['low'],'knownAt':z['knownAt']} for z in swept],'targetCandidates':[{k:z[k] for k in ['id','kind','tf','low','origin','knownAt'] if k in z} for z in sorted(targets,key=lambda z:sign*(z['low']-entry['price']))],'target':target['low'] if target else None,'targetSource':{k:target[k] for k in ['id','kind','tf','low','origin','knownAt'] if k in target} if target else None,'rr':sign*(target['low']-entry['price'])/risk if target and risk>0 else None,'knownAt':entry['at'],'rule':'Stop at observed sweep extreme, no synthetic buffer. Nearest unswept opposing TF1/TF2 liquidity or previous-day level known before entry. No target fabricated; confirmed sweep required.'}


def delivery_shifts(bars, zones, tf):
    """Explicit CISD candidate rule, separate from native SMC CHOCH.

    A 3-right confirmed reversal swing anchors a preceding run of at least two
    same-direction bodies (neutral bodies can bridge it). Confirm on the first
    completed close beyond the first directional body's open, no earlier than
    swing confirmation. A new reversal extreme invalidates the candidate.
    """
    positions = {b['t']: i for i, b in enumerate(bars)}
    out = []
    for swing in zones:
        if swing['kind'] not in ['BSL', 'SSL']:
            continue
        p = positions[swing['origin']]
        sign = 1 if swing['kind'] == 'BSL' else -1
        end = p
        # A reversal wick may be on the first opposite/neutral body.
        while end >= 0 and bars[end]['c'] == bars[end]['o']:
            end -= 1
        if end >= 0 and sign * (bars[end]['c']-bars[end]['o']) < 0:
            if end != p:
                continue
            end -= 1
            while end >= 0 and bars[end]['c'] == bars[end]['o']:
                end -= 1
        if end < 0 or sign * (bars[end]['c']-bars[end]['o']) <= 0:
            continue
        start = end
        while start > 0 and sign * (bars[start-1]['c'] - bars[start-1]['o']) >= 0:
            start -= 1
        directional = [i for i in range(start, end+1) if sign * (bars[i]['c']-bars[i]['o']) > 0]
        if len(directional) < 2:
            continue
        start = directional[0]
        level = bars[start]['o']
        for i in range(p+1, len(bars)):
            b = bars[i]
            if (sign == 1 and b['h'] > bars[p]['h']) or (sign == -1 and b['l'] < bars[p]['l']):
                break
            if b['knownAt'] >= swing['knownAt'] and sign * (b['c']-level) < 0:
                out.append({'id':f'{tf}:CISD:{bars[p]["t"]}:{b["t"]}:{-sign}',
                    'label':'CISD','direction':'SELL' if sign == 1 else 'BUY',
                    'origin':bars[start]['t'],'formationStart':bars[p]['t'],
                    'at':b['t'],'knownAt':b['knownAt'],'level':float(level),
                    'raw':{'source':'delivery_run_open_candidate','deliveryStart':bars[start]['t'],
                        'reversalAt':bars[p]['t'],'swingKnownAt':swing['knownAt'],
                        'directionalBodies':len(directional),'rule':'Two or more directional bodies; close through delivery-run open after confirmed reversal swing. Separate from native SMC CHOCH.'}})
                break
    return out



def balanced_ranges(zones,bars,tf):
    """Derived overlap of opposing native FVGs, directed by the later FVG."""
    gaps=sorted((z for z in zones if z['kind']=='FVG'),key=lambda z:(z['knownAt'],z['origin']))
    prior=[];out=[]
    for newer in gaps:
        overlaps=[z for z in reversed(prior) if z['direction']!=newer['direction'] and z['knownAt']<newer['knownAt'] and (z.get('retiredAt') is None or z['retiredAt']>=newer['origin']) and min(z['high'],newer['high'])>max(z['low'],newer['low'])]
        prior.append(newer)
        # A newer tiny gap must not suppress an earlier overlapping BISI/SIBI.
        for older in overlaps:
            lo=max(older['low'],newer['low']);hi=min(older['high'],newer['high'])
            z={'id':f'{tf}:BPR:{older["id"]}:{newer["id"]}','kind':'BPR','tf':tf,'direction':newer['direction'],'low':lo,'high':hi,'origin':newer['origin'],'originDay':newer['originDay'],'knownAt':newer['knownAt'],'retiredAt':None,'status':'ACTIVE','touches':0,'lastTouch':None,'description':'BPR candidate · overlap of opposing native FVGs; direction of later gap','raw':{'source':'opposing_fvg_overlap','sourceIds':[older['id'],newer['id']],'sourceKnownAt':[older['knownAt'],newer['knownAt']],'middleIndex':(newer.get('raw') or {}).get('middleIndex')},'lineage':newer['id']}
            for b in bars:
                if b['t']<z['knownAt']:continue
                if b['h']>=lo and b['l']<=hi:z['touches']+=1;z['lastTouch']=b['t'];z['status']='TOUCHED'
                if (b['c']<lo if z['direction']=='BUY' else b['c']>hi):
                    z['retiredAt']=b['knownAt'];z['status']='SWEPT';break
            out.append(z)
    return out

def confirmed_local_pivots(bars,tf,strength):
    """Fixed-width causal pivots for the explicitly selected local adaptation."""
    out=[]
    for i in range(strength,len(bars)-strength):
        b=bars[i];left=bars[i-strength:i];right=bars[i+1:i+strength+1]
        for kind,hit,level in [('BSL',b['h']>max(x['h'] for x in left) and b['h']>=max(x['h'] for x in right),b['h']),('SSL',b['l']<min(x['l'] for x in left) and b['l']<=min(x['l'] for x in right),b['l'])]:
            if hit:out.append({'id':f'{tf}:LOCAL_PIVOT:{strength}:{kind}:{b["t"]}','kind':kind,'origin':b['t'],'knownAt':bars[i+strength]['knownAt'],'low':level,'high':level,'raw':{'source':'fixed_width_local_pivot','strength':strength}})
    return out


def candle_delivery_blocks(bars,tf):
    """Optional candle OB interpretation, separate from native volume/structure OB.

    Last opposite candle followed by two directional closes: second close advances
    beyond first and beyond the source open. Full source wick range, known only
    at the second close. No four-pivot structural classification is implied.
    """
    out=[]
    for i in range(2,len(bars)):
        source,first,last=bars[i-2:i+1]
        sign=1 if source['c']<source['o'] else -1 if source['c']>source['o'] else 0
        if not sign or sign*(first['c']-first['o'])<=0 or sign*(last['c']-last['o'])<=0 or sign*(last['c']-first['c'])<=0 or sign*(last['c']-source['o'])<=0:continue
        retired=next((b['knownAt'] for b in bars[i+1:] if b['c']<source['l']),None) if sign==1 else next((b['knownAt'] for b in bars[i+1:] if b['c']>source['h']),None)
        out.append({'id':f'{tf}:CANDLE_OB:{source["t"]}:{sign}','kind':'OB','tf':tf,'direction':'BUY' if sign==1 else 'SELL','low':source['l'],'high':source['h'],'origin':source['t'],'originDay':source['day'],'knownAt':last['knownAt'],'retiredAt':retired,'status':'ACTIVE','touches':0,'lastTouch':None,'description':'Candle delivery OB · local adaptation, not native volume/structure OB','raw':{'source':'candle_delivery_ob','sourceCandle':source,'firstDeliveryCandle':first,'confirmationCandle':last,'rule':'Last opposite candle, two advancing directional closes beyond source open; full source wick range.'},'lineage':None})
    return out


def local_swing_shifts(bars,zones,tf,close_break=True):
    """Local adaptation: break the opposing confirmed pivot after a reversal pivot.

    Both pivots come from the native completed-prefix swing stream. Unlike the
    package four-swing CHOCH classification, this tests the actual opposing level.
    Availability waits for both pivots and a completed breaking candle.
    """
    positions={b['t']:i for i,b in enumerate(bars)}
    swings=[z for z in zones if z['kind'] in ['BSL','SSL']]
    out=[]
    for reversal in swings:
        buy=reversal['kind']=='SSL'
        opposing=[z for z in swings if z['kind']==('BSL' if buy else 'SSL') and z['origin']<reversal['origin'] and z['knownAt']<=reversal['knownAt']]
        if not opposing:continue
        pivot=max(opposing,key=lambda z:z['origin'])
        for b in bars[positions[reversal['origin']]+1:]:
            # A new extreme cancels this reversal; no future pivot is substituted.
            if (buy and b['l']<reversal['low']) or (not buy and b['h']>reversal['high']):break
            if b['knownAt']<max(reversal['knownAt'],pivot['knownAt']):continue
            broken=(b['c']>pivot['high'] if buy else b['c']<pivot['low']) if close_break else (b['h']>pivot['high'] if buy else b['l']<pivot['low'])
            if broken:
                out.append({'id':f'{tf}:LOCAL_SHIFT:{reversal["origin"]}:{b["t"]}',
                    'label':'LOCAL_SHIFT','direction':'BUY' if buy else 'SELL',
                    'origin':pivot['origin'],'formationStart':reversal['origin'],
                    'at':b['t'],'knownAt':b['knownAt'],'level':pivot['high'] if buy else pivot['low'],
                    'breakMode':'close' if close_break else 'wick',
                    'raw':{'source':'local_confirmed_swing_break','pivotSource':pivot.get('raw'),'reversalId':reversal['id'],'reversalKnownAt':reversal['knownAt'],'opposingId':pivot['id'],'opposingKnownAt':pivot['knownAt'],'rule':'Completed candle break beyond opposing confirmed pivot; waits for reversal confirmation. Local adaptation, not package CHOCH.'}})
                break
    return out


def eligible_array(a,e,bars,scope):
    if scope=='CONTINUATION':return True
    if scope=='FORMATION':
        return e['formationStart']<=a['origin']<=e['at'] and a['knownAt']<=e['knownAt']
    if a['origin']>e['at']:
        return False
    if a['knownAt']<=e['knownAt']:
        return True
    # The displacement candle can be the FVG middle candle; its third
    # candle must complete before any retest entry can be considered.
    middle=(a.get('raw') or {}).get('middleIndex')
    return a['kind'] in ['FVG','BPR'] and middle is not None and 0<=middle<len(bars) and bars[middle]['t']<=e['at']


def retest_episodes(bars,zone,ready,direction,end_at=None,every_candle=False):
    """One entry per distinct OHLC visit; consecutive overlapping bars are one visit."""
    out=[];inside=False
    for b in bars:
        if b['t']<ready:continue
        if (end_at is not None and b['t']>=end_at) or (zone.get('retiredAt') is not None and b['t']>=zone['retiredAt']):break
        hit=b['h']>=zone['low'] and b['l']<=zone['high']
        if hit and (every_candle or not inside):
            price=min(max(b['o'],zone['low']),zone['high']);sign=1 if direction=='BUY' else -1
            later=[x for x in bars if x['t']>b['t']]
            out.append({'at':b['t'],'knownAt':b['knownAt'],'price':price,'candle':b,'mfe':max([0]+[sign*((x['h'] if sign==1 else x['l'])-price) for x in later]),'mae':max([0]+[-sign*((x['l'] if sign==1 else x['h'])-price) for x in later]),'lastClose':later[-1]['c'] if later else b['c']})
        inside=hit
    return out

def main():
    from mss_strategy_requirements import evaluate,price_bars

    began=time.perf_counter()
    data=json.load(sys.stdin)

    phase=time.perf_counter()
    htf,_=cached_scan(data['higher'],data['tf1'])
    higher_seconds=time.perf_counter()-phase
    phase=time.perf_counter()
    ltf,events=cached_scan(data['lower'],data['tf2'],data.get('confirmation')!='WICK')
    lower_seconds=time.perf_counter()-phase
    phase=time.perf_counter()

    confirmation=data.get('confirmation','CHOCH')
    if confirmation=='WICK':
        events=[{**e,'breakMode':'wick'} for e in events]
    if confirmation in ['CISD','EITHER']:
        events=events+delivery_shifts(data['lower'],ltf,data['tf2'])
    if confirmation in ['LOCAL','LOCAL_WICK']:
        pivots=confirmed_local_pivots(data['lower'],data['tf2'],1) if data.get('pivotStrength',3)==1 else ltf
        events=local_swing_shifts(data['lower'],pivots,data['tf2'],confirmation=='LOCAL')
    shift_labels={'LOCAL_SHIFT'} if confirmation in ['LOCAL','LOCAL_WICK'] else {'CHOCH'} if confirmation in ['CHOCH','WICK'] else {'CISD'} if confirmation=='CISD' else {'CHOCH','CISD'}

    bars=data['lower'];daily=data['daily'];allowed=set(data['htfKinds']);entry_types=set(data['ltfKinds']);out=[];touches=[]
    selected_window=data.get('entryWindowMinutes')
    window_bars=[b for b in bars if data['start']<=b['day']<=data['end'] and selected_window[0]<=b['minute']<=selected_window[1]] if selected_window else []
    window_start=min((b['t'] for b in window_bars),default=None);window_end=max((b['t'] for b in window_bars),default=None)
    entry_cache={};plan_cache={};episodes_cache={}
    if 'BPR' in allowed:htf+=balanced_ranges(htf,data['higher'],data['tf1'])
    if data.get('candleOrderBlocks') and 'OB' in allowed:htf+=candle_delivery_blocks(data['higher'],data['tf1'])
    if 'BPR' in entry_types:ltf+=balanced_ranges(ltf,bars,data['tf2'])

    for z in htf:

        is_swing=z['kind'] in ['BSL','SSL']

        if is_swing and 'SWINGS' not in allowed:continue

        if not is_swing and {'EQH':'BSL','EQL':'SSL'}.get(z['kind'],z['kind']) not in allowed:continue

        first=next((b for b in bars if (data.get('carryIn') or b['day']>=data['start']) and b['day']<=data['end'] and b['t']>=z['knownAt'] and (z['retiredAt'] is None or b['t']<z['retiredAt']) and b['h']>=z['low'] and b['l']<=z['high']),None)

        if first:touches.append((z,first))

    if 'PDH' in allowed or 'PDL' in allowed:

        for day in sorted(set(b['day'] for b in bars if data['start']<=b['day']<=data['end'])):

            previous=next((b for b in reversed(daily) if b['day']<day),None)

            if not previous:continue

            for kind,price,direction in [('PDH',previous['h'],'SELL'),('PDL',previous['l'],'BUY')]:

                if kind not in allowed:continue

                first=next((b for b in bars if b['day']==day and b['t']>=previous['knownAt'] and b['l']<=price<=b['h']),None)

                if first:touches.append(({'id':f'{kind}:{day}','kind':kind,'tf':'1d','direction':direction,'low':price,'high':price,'origin':previous['t'],'originDay':previous['day'],'knownAt':previous['knownAt'],'status':'ACTIVE','touches':0,'lastTouch':None,'description':'Previous completed trading day high/low'},first))

    for z,touch in sorted(touches,key=lambda p:p[1]['t']):

        context_hits=[b for b in bars if (data.get('carryIn') or b['day']>=data['start']) and b['day']<=data['end'] and b['t']>=z['knownAt'] and (z.get('retiredAt') is None or b['t']<z['retiredAt']) and (z['kind'] not in ['PDH','PDL'] or b['day']==touch['day']) and b['h']>=z['low'] and b['l']<=z['high']]
        touch_window=TF1TouchWindow(data['higher'],context_hits,data['tf1'])

        # Raw package CHOCH must confirm on a candle after the observed HTF touch.

        shifts=[e for e in events if touch_window.proof(e['knownAt'])['valid'] and (window_end is None or e['knownAt']<=window_end) and e['label'] in shift_labels and e['direction']==z['direction'] and e['at']>touch['t'] and (e['label']!='CISD' or e['formationStart']>=touch['t']) and (z['kind'] not in ['OB','FVG','IFVG','BREAKER','BPR'] or z.get('retiredAt') is None or e['knownAt']<z['retiredAt']) and (z['kind'] not in ['PDH','PDL'] or next(b['day'] for b in bars if b['t']==e['at'])==touch['day']) and data['start']<=next(b['day'] for b in bars if b['t']==e['at'])<=data['end']]

        for e in shifts or [None]:

            candidates=[]

            if e:

                leg=[b for b in bars if touch['t']<=b['t']<=e['at']]

                extreme=min(leg,key=lambda b:b['l']) if e['direction']=='BUY' else max(leg,key=lambda b:b['h'])

                e={**e,'formationStart':e['formationStart'] if e['label'] in ['CISD','LOCAL_SHIFT'] else extreme['t']}
                end_at=None
                if data.get('arrayScope')=='CONTINUATION':
                    reversal=next((b for b in bars if b['t']==e['formationStart']),extreme)
                    ends=[b['t'] for b in bars if b['t']>=e['knownAt'] and (b['l']<reversal['l'] if e['direction']=='BUY' else b['h']>reversal['h'])]
                    if z.get('retiredAt') is not None:ends.append(z['retiredAt'])
                    end_at=min(ends) if ends else None

                for a in ltf:

                    if window_end is not None and (a['knownAt']>window_end or (a.get('retiredAt') is not None and a['retiredAt']<=window_start)):continue
                    if a['kind'] not in entry_types or a['direction']!=e['direction'] or not eligible_array(a,e,bars,data.get('arrayScope','FORMATION')):continue

                    ready=max(e['knownAt'],a['knownAt'])
                    if a.get('retiredAt') is not None and a['retiredAt']<=ready:continue

                    cache_key=(e['id'],a['id'],end_at)
                    if cache_key not in entry_cache:
                        retest=next((b for b in bars if b['t']>=ready and (end_at is None or b['t']<end_at) and (a.get('retiredAt') is None or b['t']<a['retiredAt']) and b['h']>=a['low'] and b['l']<=a['high']),None)

                        entry=None

                        if retest:

                            price=min(max(retest['o'],a['low']),a['high'])

                            later=[b for b in bars if b['t']>retest['t']]

                            sign=1 if e['direction']=='BUY' else -1

                            entry={'at':retest['t'],'knownAt':retest['knownAt'],'price':price,'candle':retest,'mfe':max([0]+[sign*((b['h'] if sign==1 else b['l'])-price) for b in later]),'mae':max([0]+[-sign*((b['l'] if sign==1 else b['h'])-price) for b in later]),'lastClose':later[-1]['c'] if later else retest['c']}

                        early=next((b for b in bars if b['t']>=a['knownAt'] and b['t']<e['knownAt'] and (a.get('retiredAt') is None or b['t']<a['retiredAt']) and b['h']>=a['low'] and b['l']<=a['high']),None)
                        entry_cache[cache_key]=(entry,early)
                    cached_entry,early=entry_cache[cache_key]
                    if data.get('retestMode') in ['ALL','CANDLES']:
                        if cache_key not in episodes_cache:episodes_cache[cache_key]=retest_episodes(bars,a,ready,e['direction'],end_at,data.get('retestMode')=='CANDLES')
                        entries=[dict(x) for x in episodes_cache[cache_key]]
                    else:entries=[dict(cached_entry)] if cached_entry else []
                    if (data.get('strategyFilters') or {}).get('entryPrice')=='CE':
                        entries=price_bars(bars,a,ready,end_at,data.get('retestMode','FIRST'),'CE')
                    window=data.get('entryWindowMinutes')
                    if window:entries=[x for x in entries if data['start']<=x['candle']['day']<=data['end'] and window[0]<=x['candle']['minute']<=window[1]]
                    for entry in entries or [None]:
                        if entry:
                            plan_key=(e['id'],touch['t'],entry['at'],entry['price'])
                            if plan_key not in plan_cache:plan_cache[plan_key]=structural_plan(entry,e,touch,bars,htf+ltf,daily)
                            entry['plan']=plan_cache[plan_key]
                            shift_proof=touch_window.proof(e['knownAt'])
                            entry_proof=touch_window.proof(entry['at'],e['knownAt'])
                            entry['tf1TouchFreshness']={'valid':shift_proof['valid'] and entry_proof['valid'],'shift':shift_proof,'entry':entry_proof}
                        candidates.append({'zone':a,'entry':entry,'firstRetestBeforeConfirmation':early['t'] if early else None})

            out.append({'id':z['id']+':'+(e['id'] if e else str(touch['t'])),'htf':z,'touch':touch,'mss':e,'arrays':candidates,'state':'NO_MSS' if not e else 'NO_FORMATION_ARRAY' if not candidates else 'RETEST_ENTRY' if any(a['entry'] for a in candidates) else 'AWAITING_RETEST'})

    if data.get('strategyFilters'):
        for item in out:
            for candidate in item['arrays']:
                entry=candidate.get('entry')
                if not entry:continue
                entry['checklist']=evaluate(entry,item['mss'],item['touch'],item['htf'],candidate['zone'],bars,ltf,data['strategyFilters'])
                if not entry['checklist']['eligible']:
                    candidate['rejectedEntry']=entry
                    candidate['entry']=None
            if item['state']=='RETEST_ENTRY' and not any(a['entry'] for a in item['arrays']):item['state']='FILTERED_OUT'

    # Mandatory context freshness is independent of optional strategy checkboxes.
    for item in out:
        for candidate in item['arrays']:
            entry=candidate.get('entry')
            if not entry:continue
            proof=entry['tf1TouchFreshness']
            if entry.get('checklist'):
                entry['checklist']['checks'].append({'id':'TF1_TOUCH_FRESHNESS','step':'TF1 touch within latest five candles at shift and entry','required':True,'verdict':'PASS' if proof['valid'] else 'FAIL','evidence':proof,'source':'TF1_FIVE_CANDLE_WINDOW'})
                if not proof['valid']:
                    entry['checklist']['blockers'].append('TF1_TOUCH_FRESHNESS')
                    entry['checklist']['eligible']=False
            if not proof['valid']:
                candidate['rejectedEntry']=entry
                candidate['rejectionReason']='TF1_TOUCH_EXPIRED'
                candidate['entry']=None
        if item['state']=='RETEST_ENTRY' and not any(a['entry'] for a in item['arrays']):item['state']='FILTERED_OUT'

    print(json.dumps({'tf1TouchRule':{'candles':5,'checkAt':['SHIFT_CONFIRMATION','ENTRY'],'tf':data['tf1'],'currentCandleEvidence':'COMPLETED_TF2_ONLY','postShiftTouchRefresh':False},'provider':'smartmoneyconcepts','version':importlib.metadata.version('smartmoneyconcepts'),'swingLength':3,'localPivotStrength':data.get('pivotStrength',3),'candleOrderBlocks':bool(data.get('candleOrderBlocks')),'retestMode':data.get('retestMode','FIRST'),'confirmation':confirmation,'confirmationRule':('LOCAL_SHIFT is a local adaptation using confirmed opposing/reversal pivots and the selected completed-candle close/wick break; 3-bar native or explicitly selected 1-bar fixed pivots. Not native package CHOCH. ' if confirmation in ['LOCAL','LOCAL_WICK'] else '')+('SMC CHOCH uses high/low penetration (close_break=False), observed at the completed candle end; same-bar entries excluded. ' if confirmation=='WICK' else '')+'CISD is a separately labelled delivery-run-open candidate, with at least two directional bodies and a confirmed reversal swing; no retrospective confirmation or same-bar entry. CHOCH remains native package close_break=True.','execution':'prefix array kernels' if primitives is mss_primitives else 'native package','timings':{'higherSeconds':round(higher_seconds,3),'lowerSeconds':round(lower_seconds,3),'matchingSeconds':round(time.perf_counter()-phase,3),'totalSeconds':round(time.perf_counter()-began,3)},'higherZones':[z for z in htf if (z['kind'] in ['BSL','SSL'] and 'SWINGS' in allowed) or (z['kind'] not in ['BSL','SSL'] and {'EQH':'BSL','EQL':'SSL'}.get(z['kind'],z['kind']) in allowed)],'lowerZones':ltf,'events':events,'investigations':out,'rules':('Every overlapping retest candle is a research entry candidate, not a separate automatic order. ' if data.get('retestMode')=='CANDLES' else '')+('Optional candle-delivery OBs are local interpretations, known at the second advancing close after the source opposite candle; full source wick range. ' if data.get('candleOrderBlocks') else '')+('Separate zone visits retained; consecutive overlap candles form one visit. ' if data.get('retestMode')=='ALL' else '')+('Carry-in HTF touches from the loaded warmup enabled. ' if data.get('carryIn') else '')+('Continuation arrays are allowed until reversal-extreme breach or HTF invalidation; activation and confirmation must precede entry. ' if data.get('arrayScope')=='CONTINUATION' else '')+('Existing arrays and shift-displacement FVGs enabled; entries wait for both activation and confirmation. ' if data.get('arrayScope')=='EXISTING' else 'Formation-only arrays enabled. ' if data.get('arrayScope')=='FORMATION' else '')+('Raw package CHOCH, close_break=False; ' if confirmation=='WICK' else 'Raw package CHOCH, close_break=True; ')+' 3-left/3-right confirmed swings; synthetic endpoints excluded. Formation starts at the reversal extreme between touch and break and ends at package BrokenIndex close; the raw package origin swing is preserved separately. Formation-only mode requires anchor AND activation within formation. Existing mode permits earlier valid arrays and the FVG whose middle candle belongs to the shift, even if its third candle finishes later. Every selected TF1 level requires a completed TF2 touch within the current and previous four TF1 candle positions at both shift confirmation and entry. Touches after confirmation cannot revive that shift. The first touch remains the context story anchor; freshness uses the latest causal qualifying touch before confirmation. CISD candidates use their confirmed reversal swing as formation start and delivery-run opening price as the broken level; see confirmationRule. Previous-day levels apply only to their touch session. First later OHLC retest at open-inside or near zone edge; no same-confirmation-bar entry. IFVG and breaker are explicit close-through derivatives, not native package outputs. Excursions exclude entry candle (intrabar order unknown); measured through selected end. Structural plans use only levels known at entry; no costs or automatic order submission.'},allow_nan=False))

if __name__=='__main__':main()

