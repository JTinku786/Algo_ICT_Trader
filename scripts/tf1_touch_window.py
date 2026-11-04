from bisect import bisect_right

class TF1TouchWindow:
    """Five actual TF1 candle positions; never read a developing candle's OHLC."""
    def __init__(self,higher,touches,tf):
        self.starts=sorted({b['t'] for b in higher})
        self.touches=sorted(touches,key=lambda b:b['knownAt'])
        self.clocks=[b['knownAt'] for b in self.touches];self.tf=tf

    def proof(self,at,confirmed_by=None):
        index=bisect_right(self.starts,at)-1
        window=self.starts[max(0,index-4):index+1] if index>=0 else []
        hit=bisect_right(self.clocks,min(at,confirmed_by) if confirmed_by is not None else at)-1
        touch=self.touches[hit] if hit>=0 else None
        valid=bool(window and touch and touch['t']>=window[0])
        return {'valid':valid,'at':at,'tf':self.tf,'limitCandles':5,'windowStart':window[0] if window else None,'latestCandleStart':window[-1] if window else None,'availableWindowCandles':len(window),'touchAt':touch['t'] if touch else None,'touchKnownAt':touch['knownAt'] if touch else None,'confirmationCutoff':confirmed_by,'reason':'RECENT_TF1_TOUCH' if valid else 'NO_TF1_HISTORY' if not window else 'NO_CONFIRMED_TOUCH' if not touch else 'TF1_TOUCH_EXPIRED','rule':'Touch in latest five TF1 candle positions at shift confirmation and entry. Current TF1 candle uses completed TF2 evidence only; touches after the shift cannot refresh it.'}
