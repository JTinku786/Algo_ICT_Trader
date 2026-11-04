"""Point-in-time FVG premium/discount qualification; original SMC zones untouched."""
from bisect import bisect_right

class DealingRanges:
    def __init__(self,pivots,bars,tf):
        self.pivots=sorted(pivots,key=lambda p:(p['knownAt'],p['origin'],p['kind']))
        self.clocks=[p['knownAt'] for p in self.pivots]
        self.bars=sorted(bars,key=lambda b:b['knownAt'])
        self.bar_clocks=[b['knownAt'] for b in self.bars]
        self.tf=tf;self.cache={}

    def range_at(self,at,direction):
        key=(at,direction)
        if key in self.cache:return self.cache[key]
        swings=self.pivots[:bisect_right(self.clocks,at)]
        buy=direction=='BUY';kind='BSL' if buy else 'SSL'
        endpoints=sorted((p for p in swings if p['kind']==kind),key=lambda p:p['origin'])
        result=None
        if len(endpoints)>=2:
            first=len(endpoints)-1
            while first>0 and (endpoints[first]['high']>endpoints[first-1]['high'] if buy else endpoints[first]['low']<endpoints[first-1]['low']):first-=1
            if first<len(endpoints)-1:
                chain=endpoints[first:];end=chain[-1]
                anchors=[p for p in swings if p['kind']!=kind and chain[0]['origin']<p['origin']<end['origin']]
                if anchors:
                    anchor=min(anchors,key=lambda p:p['low']) if buy else max(anchors,key=lambda p:p['high'])
                    low,high=(anchor,end) if buy else (end,anchor)
                    if high['high']>low['low']:
                        subsequent=[b for b in self.bars[:bisect_right(self.bar_clocks,at)] if b['t']>end['origin']]
                        breached=any(b['l']<low['low'] or b['h']>high['high'] for b in subsequent)
                        result={'state':'BROKEN' if breached else 'ACTIVE','tf':self.tf,'direction':direction,'low':low['low'],'high':high['high'],'equilibrium':(low['low']+high['high'])/2,'lowOrigin':low['origin'],'highOrigin':high['origin'],'chainStart':chain[0]['origin'],'knownAt':max(p['knownAt'] for p in chain+[anchor]),'sourceIds':[p['id'] for p in chain+[anchor]],'rule':'Increasing confirmed swing highs -> lowest intervening swing low; decreasing confirmed swing lows -> highest intervening swing high. Reset the endpoint chain on non-extension. Completed wick breach invalidates the range.'}
        self.cache[key]=result
        return result

    def qualify(self,z,at):
        r=self.range_at(at,z['direction']);ce=(z['low']+z['high'])/2
        valid=bool(r and r['state']=='ACTIVE' and r['low']<=ce<=r['high'] and (ce<=r['equilibrium'] if z['direction']=='BUY' else ce>=r['equilibrium']))
        return {'valid':valid,'at':at,'midpoint':ce,'range':r,'reason':'DISCOUNT' if valid and z['direction']=='BUY' else 'PREMIUM' if valid else 'NO_CONFIRMED_RANGE' if not r else 'RANGE_BREACHED' if r['state']!='ACTIVE' else 'OUTSIDE_RANGE' if not r['low']<=ce<=r['high'] else 'WRONG_HALF','rule':'Bullish FVG midpoint in discount (<=50%); bearish midpoint in premium (>=50%). Activation and retirement are checked separately.'}

    def timeline(self):
        out=[];previous=None
        for b in self.bars:
            buy=self.range_at(b['knownAt'],'BUY');sell=self.range_at(b['knownAt'],'SELL')
            pair=(buy,sell)
            if pair!=previous:out.append({'at':b['knownAt'],'buy':buy,'sell':sell});previous=pair
        return out


class AutoFibRanges(DealingRanges):
    """Same confirmed Depth/ATR ZigZag as Fib Calculation, queried causally."""
    def __init__(self,bars,tf,depth=10,deviation=3):
        self.bars=sorted(bars,key=lambda b:b['knownAt'])
        self.bar_clocks=[b['knownAt'] for b in self.bars]
        self.tf=tf;self.depth=depth;self.deviation=deviation;self.cache={}
        self.snapshots=[];self.snapshot_clocks=[];self.origin_clocks=[b['t'] for b in self.bars]
        width=max(1,int(depth)//2);atr=[];seed=0;previous=None
        for i,b in enumerate(self.bars):
            tr=b['h']-b['l'] if not i else max(b['h']-b['l'],abs(b['h']-self.bars[i-1]['c']),abs(b['l']-self.bars[i-1]['c']))
            if i<10:seed+=tr
            if i==9:previous=seed/10
            elif i>9:previous=(previous*9+tr)/10
            atr.append(previous)
        self.pivots=[];zz=[]
        for i in range(width,len(self.bars)-width):
            for kind,field in [('BSL','h'),('SSL','l')]:
                price=self.bars[i][field]
                if any((self.bars[j][field]>price if kind=='BSL' else self.bars[j][field]<price) or (j<i and self.bars[j][field]==price) for j in range(i-width,i+width+1) if j!=i):continue
                clock=self.bars[i+width]['knownAt']
                pivot={'id':f"{'SH' if kind=='BSL' else 'SL'}:{self.bars[i]['t']}",'kind':kind,'origin':self.bars[i]['t'],'knownAt':clock,'low':price,'high':price}
                self.pivots.append(pivot);last=zz[-1] if zz else None;changed=False
                if last is None:zz.append(pivot);changed=True
                elif last['kind']==kind:
                    if price>last['high'] if kind=='BSL' else price<last['low']:zz[-1]=pivot;changed=True
                else:
                    confirm=i+width;close=self.bars[confirm]['c']
                    if atr[confirm] is None or not close or not last['low']:continue
                    threshold=atr[confirm]/abs(close)*100*deviation
                    change=(price-last['low'])/abs(last['low'])*100
                    if change>=threshold if kind=='BSL' else change<=-threshold:zz.append(pivot);changed=True
                if changed:
                    self.snapshot_clocks.append(clock);self.snapshots.append(tuple(zz[-2:]))

    def range_at(self,at,direction):
        key=(at,direction)
        if key in self.cache:return self.cache[key]
        index=bisect_right(self.snapshot_clocks,at)-1;result=None
        points=self.snapshots[index] if index>=0 else ()
        if len(points)==2:
            a,b=points
            low=min(points,key=lambda p:p['low']);high=max(points,key=lambda p:p['high'])
            if high['high']>low['low']:
                subsequent=self.bars[bisect_right(self.origin_clocks,b['origin']):bisect_right(self.bar_clocks,at)]
                breached=any(bar['l']<low['low'] or bar['h']>high['high'] for bar in subsequent)
                result={'state':'BROKEN' if breached else 'ACTIVE','tf':self.tf,'direction':direction,'low':low['low'],'high':high['high'],'equilibrium':(low['low']+high['high'])/2,'lowOrigin':low['origin'],'highOrigin':high['origin'],'chainStart':a['origin'],'knownAt':max(a['knownAt'],b['knownAt']),'sourceIds':[p['id'] for p in points],'depth':self.depth,'deviation':self.deviation,'method':'AUTO_FIB_RETRACEMENT','fibBase':b['low'],'fibHeight':a['low']-b['low'],'rule':f'Latest confirmed Auto Fib retracement leg; Depth {self.depth} and ATR(10)/close * 100 * Deviation {self.deviation}. Completed wick breach invalidates qualification; no future or unconfirmed swings.'}
        self.cache[key]=result
        return result
