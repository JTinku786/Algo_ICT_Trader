"""Compact immutable candle archive and exact first-hit exit index.

Detector inputs still materialize the identical bounded dictionaries. Only the
long-lived archive and subsequent-candle SL/TP search use numeric arrays.
"""
import bisect
from collections.abc import Sequence
import numpy as np

class ReplayBars(Sequence):
    def __init__(self,bars):
        count=len(bars)
        self.t=np.fromiter((b['t'] for b in bars),dtype=np.int64,count=count)
        self.knownAt=np.fromiter((b['knownAt'] for b in bars),dtype=np.int64,count=count)
        self.days=np.fromiter((int(b['day'].replace('-','')) for b in bars),dtype=np.int32,count=count)
        self.minute=np.fromiter((b['minute'] for b in bars),dtype=np.int16,count=count)
        self.price=np.empty((5,count),dtype=np.float64)
        for i,k in enumerate(['o','h','l','c','v']):self.price[i]=np.fromiter((b.get(k,0) for b in bars),dtype=np.float64,count=count)
        if np.any(self.t[1:]<=self.t[:-1]):raise ValueError('Archive clocks must be unique and strictly sorted')
        if np.any(self.days[1:]<self.days[:-1]):raise ValueError('Archive local days must be sorted')
        for value in [self.t,self.knownAt,self.days,self.minute,self.price]:value.flags.writeable=False
    def __len__(self):return len(self.t)
    def __getitem__(self,index):
        if isinstance(index,slice):return [self[i] for i in range(*index.indices(len(self)))]
        if index<0:index+=len(self)
        if not 0<=index<len(self):raise IndexError(index)
        d=int(self.days[index]);b={'t':int(self.t[index]),'knownAt':int(self.knownAt[index]),'day':f'{d//10000:04d}-{(d//100)%100:02d}-{d%100:02d}','minute':int(self.minute[index])}
        b.update((k,float(self.price[i,index])) for i,k in enumerate(['o','h','l','c','v']))
        return b
    def day_index(self,day,side='left'):return int(np.searchsorted(self.days,int(day.replace('-','')),side=side))
    def clock_index(self,clock,side='right'):return int(np.searchsorted(self.t,clock,side=side))
    @property
    def bytes(self):return sum(a.nbytes for a in [self.t,self.knownAt,self.days,self.minute,self.price])

class FirstHitIndex:
    """Segment extrema prune whole future spans; leaves retain exact OHLC clock."""
    def __init__(self,archive):
        self.archive=archive;self.n=len(archive);self.size=1
        while self.size<self.n:self.size*=2
        self.low=np.full(self.size*2,np.inf);self.high=np.full(self.size*2,-np.inf)
        self.low[self.size:self.size+self.n]=archive.price[2];self.high[self.size:self.size+self.n]=archive.price[1]
        start=self.size//2
        while start:
            self.low[start:2*start]=np.minimum(self.low[2*start:4*start:2],self.low[2*start+1:4*start:2])
            self.high[start:2*start]=np.maximum(self.high[2*start:4*start:2],self.high[2*start+1:4*start:2]);start//=2
        self.low.flags.writeable=False;self.high.flags.writeable=False
    def first(self,start,price,low):
        if start>=self.n:return None
        extrema=self.low if low else self.high
        def visit(node,left,right):
            if right<=start or left>=self.n or (extrema[node]>price if low else extrema[node]<price):return None
            if right-left==1:return left
            mid=(left+right)//2;hit=visit(node*2,left,mid)
            return hit if hit is not None else visit(node*2+1,mid,right)
        return visit(1,0,self.size)
    def evaluate(self,entry,plan):
        sign=1 if plan['direction']=='BUY' else -1;risk=sign*(plan['entry']-plan['stop'])
        if risk<=0:raise ValueError('Invalid signed stop geometry')
        start=self.archive.clock_index(entry['at'],'right')
        stopped=self.first(start,plan['stop'],sign==1);targeted=self.first(start,plan['target'],sign==-1)
        if stopped is None and targeted is None:return {'outcome':'OPEN','result':'OPEN','r':None,'exitAt':None,'exitKnownAt':None,'ambiguous':False,'holdBars':None}
        loss=stopped is not None and (targeted is None or stopped<=targeted);index=stopped if loss else targeted
        return {'outcome':'LOSS' if loss else 'WIN','result':'LOSS' if loss else 'WIN','r':-1.0 if loss else sign*(plan['target']-plan['entry'])/risk,'exitAt':int(self.archive.t[index]),'exitKnownAt':int(self.archive.knownAt[index]),'ambiguous':stopped is not None and stopped==targeted,'holdBars':index-start+1}
    @property
    def bytes(self):return self.low.nbytes+self.high.nbytes
