"""Exact array transport for the pinned completed-prefix SMC scanner.

Uses the existing parity-tested 0.0.24 kernels. Every prefix is still evaluated;
only DataFrame construction/transport is removed. Package swing pruning order,
float32 liquidity/structure/OB levels, activation clocks and zone update order
are retained. No full-history swing inference or approximate event sampling.
"""
import importlib.metadata
import numpy as np
from numba import njit
from mss_primitives import _liquidity, _structure, _ob


@njit(cache=True)
def _swings(high, low):
    """Package shift(-3).rolling(6), simultaneous duplicate pruning, endpoint trim."""
    n=len(high);signs=np.full(n,np.nan)
    # Rolling is evaluated on the shifted series, so its first valid index is 5.
    for j in range(5,n-3):
        maximum=high[j-2];minimum=low[j-2]
        for k in range(j-1,j+4):
            maximum=max(maximum,high[k]);minimum=min(minimum,low[k])
        if high[j]==maximum:signs[j]=1
        elif low[j]==minimum:signs[j]=-1
    while True:
        positions=np.flatnonzero(~np.isnan(signs))
        if len(positions)<2:break
        remove=np.zeros(len(positions),np.bool_)
        for k in range(len(positions)-1):
            a,b=positions[k],positions[k+1]
            if signs[a]==1 and signs[b]==1:
                if high[a]<high[b]:remove[k]=True
                else:remove[k+1]=True
            elif signs[a]==-1 and signs[b]==-1:
                if low[a]>low[b]:remove[k]=True
                else:remove[k+1]=True
        if not np.any(remove):break
        for k in range(len(positions)):
            if remove[k]:signs[positions[k]]=np.nan
    # Package inserts synthetic first/last endpoints; the shared scanner strips
    # both and every unconfirmed right endpoint before any primitive call.
    for j in range(n):
        if j<3 or j>n-4:signs[j]=np.nan
    levels=np.full(n,np.nan)
    for j in range(n):
        if not np.isnan(signs[j]):levels[j]=high[j] if signs[j]==1 else low[j]
    return signs,levels


def scan(bars, tf, close_break=True):
    if importlib.metadata.version('smartmoneyconcepts')!='0.0.24':
        raise ValueError('Fast scanner requires parity-pinned smartmoneyconcepts 0.0.24')
    if len(bars)<8:return [],[]
    open_,high,low,close,volume=(np.asarray([b.get(key,0) for b in bars],dtype=np.float64) for key in ['o','h','l','c','v'])
    zones={};events={};swings={};ob_crossed=set();origin_positions={}
    for j,b in enumerate(bars):origin_positions.setdefault(b['t'],j)

    def zone(kind,sign,lo,hi,origin,at,raw=None,lineage=None):
        key=f'{tf}:{kind}:{bars[origin]["t"]}:{sign}'
        if key not in zones:
            zones[key]={'id':key,'kind':kind,'tf':tf,'direction':'BUY' if sign==1 else 'SELL','low':float(lo),'high':float(hi),'origin':bars[origin]['t'],'originDay':bars[origin]['day'],'knownAt':bars[at]['knownAt'],'touches':0,'lastTouch':None,'status':'ACTIVE','description':f'{kind} · smartmoneyconcepts completed-prefix evidence' if kind not in ['IFVG','BREAKER'] else f'{kind} · close-through of source array','raw':raw,'lineage':lineage,'retiredAt':None}
        return key

    for i in range(7,len(bars)):
        end=i+1;hp,lp,cp=high[:end],low[:end],close[:end]
        signs,levels=_swings(hp,lp)
        positions=np.flatnonzero(~np.isnan(signs));new_swing=False
        for j in positions:
            j=int(j);side=int(signs[j]);key=(j,side)
            if key not in swings:
                new_swing=True;swings[key]={'index':j,'known':i}
                zone('BSL' if side==1 else 'SSL',-side,levels[j],levels[j],j,i,{'source':'confirmed_swing','HighLow':side})
        pools,pool_levels,ends,swept=_liquidity(hp,lp,signs,levels,0.01)
        for j in np.flatnonzero(pools):
            j=int(j)
            if swept[j]>0:continue
            side=int(pools[j])
            zone('EQH' if side==1 else 'EQL',-side,pool_levels[j],pool_levels[j],j,i,{'source':'package_liquidity','Liquidity':side,'End':int(ends[j])})
        bos,choch,structure_levels,broken=_structure(cp if close_break else hp,cp if close_break else lp,signs,levels)
        for j in np.flatnonzero(broken):
            j=int(j);broken_index=int(broken[j])
            if (broken_index!=i if close_break else broken_index>i) or not (choch[j] or bos[j]):continue
            side=int(choch[j] or bos[j]);label='CHOCH' if choch[j] else 'BOS'
            key=f'{tf}:{label}:{bars[j]["t"]}:{bars[broken_index]["t"]}:{side}'
            events.setdefault(key,{'id':key,'label':label,'direction':'BUY' if side==1 else 'SELL','origin':bars[j]['t'],'at':bars[broken_index]['t'],'knownAt':bars[i]['knownAt'],'level':float(structure_levels[j]),'raw':{'BOS':int(bos[j]) if bos[j] else None,'CHOCH':int(choch[j]) if choch[j] else None,'BrokenIndex':broken_index,'originIndex':j}})
        ob_trigger=new_swing
        for side in [1,-1]:
            eligible=positions[(signs[positions]==side)&(positions<i)]
            if not len(eligible):continue
            j=int(eligible[-1]);key=(side,j)
            crossed=close[i]>high[j] if side==1 else close[i]<low[j]
            if crossed and key not in ob_crossed:ob_trigger=True;ob_crossed.add(key)
        if ob_trigger:
            obs,tops,bottoms,volumes,mitigated,percentage=_ob(open_[:end],hp,lp,cp,volume[:end],signs)
            for j in np.flatnonzero(obs):
                j=int(j);side=int(obs[j])
                zone('OB',side,bottoms[j],tops[j],j,i,{'OB':side,'Top':float(tops[j]),'Bottom':float(bottoms[j]),'OBVolume':float(volumes[j])})
        # Exact native fvg(...last three candles, join_consecutive=False), middle
        # row only. MitigatedIndex is unused by the established scanner.
        j=i-1
        if high[i-2]<low[i] and close[j]>open_[j]:
            zone('FVG',1,high[i-2],low[i],j-1,i,{'FVG':1,'middleIndex':j,'Top':float(low[i]),'Bottom':float(high[i-2])})
        elif low[i-2]>high[i] and close[j]<open_[j]:
            zone('FVG',-1,high[i],low[i-2],j-1,i,{'FVG':-1,'middleIndex':j,'Top':float(low[i-2]),'Bottom':float(high[i])})
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
                    zone(kind,-1 if z['direction']=='BUY' else 1,z['low'],z['high'],origin_positions[z['origin']],i,lineage=z['id'])
    return list(zones.values()),list(events.values())
