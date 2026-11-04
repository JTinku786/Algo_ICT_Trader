import type { ReplayBar } from "./weekly-replay";
import type { ReplayFrame } from "./replay-timeline";
export type SmtPair = { a: ReplayBar; b: ReplayBar; knownAt: number; gapBefore?: boolean };
export type SmtEvent = { id: string; direction: "BUY"|"SELL"; side: "HIGH"|"LOW"; knownAt: number; previousA: ReplayBar; currentA: ReplayBar; previousB: ReplayBar; currentB: ReplayBar; aPrice: number; previousAPrice: number; bPrice: number; previousBPrice: number; aBroke: boolean; bBroke: boolean };
export function alignSmtBars(a: ReplayBar[],b: ReplayBar[],frame: ReplayFrame): SmtPair[] {
  const key=(bar:ReplayBar)=>frame==="1d" || frame==="1w" ? bar.day : String(bar.t);
  const peer=new Map(b.map((bar,index)=>[key(bar),{bar,index}]));
  let previousA=-1,previousB=-1;
  return a.flatMap((bar,index)=>{const other=peer.get(key(bar));if(!other)return [];const gapBefore=previousA>=0 && (index!==previousA+1 || other.index!==previousB+1);previousA=index;previousB=other.index;return [{a:bar,b:other.bar,knownAt:Math.max(bar.knownAt,other.bar.knownAt),gapBefore}];});
}
export function smtDivergences(pairs:SmtPair[],frame:ReplayFrame,inverse:boolean,cutoff:number): SmtEvent[] {
  const events:SmtEvent[]=[];
  const previous = new Map<string,{a:ReplayBar;b:ReplayBar;aPrice:number;bPrice:number}>();
  const nativeMinutes={"5m":5,"15m":15,"30m":30,"1h":60,"1d":1440,"1w":10080}[frame];
  for(let i=1;i<pairs.length-1;i++){
    const left=pairs[i-1],middle=pairs[i],right=pairs[i+1];
    const knownAt=Math.max(left.knownAt,middle.knownAt,right.knownAt);
    if(knownAt>cutoff)break;
    // Never bridge an absent intraday counterpart candle or a long daily data gap.
    const maxGap=(frame==="1d" ? 4*1440 : frame==="1w" ? 10080 : nativeMinutes)*60000;
    const time=(bar:ReplayBar)=>frame==="1w" ? Date.parse(bar.day) : bar.t;
    if(middle.gapBefore || right.gapBefore || time(middle.a)-time(left.a)>maxGap || time(right.a)-time(middle.a)>maxGap){previous.clear();continue;}
    if(middle.a.h>left.a.h && middle.a.h>right.a.h && middle.a.l<left.a.l && middle.a.l<right.a.l)continue;
    for(const side of ["HIGH","LOW"] as const){
      const high=side==="HIGH";
      if(!(high ? middle.a.h>left.a.h && middle.a.h>right.a.h : middle.a.l<left.a.l && middle.a.l<right.a.l))continue;
      const peerHigh=inverse ? !high : high;
      const b=[left.b,middle.b,right.b].reduce((a,b)=>peerHigh ? b.h>a.h?b:a : b.l<a.l?b:a);
      const aPrice=high ? middle.a.h : middle.a.l,bPrice=peerHigh ? b.h : b.l;
      const prior=previous.get(side);
      if(prior){
        const aBroke=high ? aPrice>prior.aPrice : aPrice<prior.aPrice;
        const bBroke=peerHigh ? bPrice>prior.bPrice : bPrice<prior.bPrice;
        if(aBroke!==bBroke)events.push({id:`${side}:${middle.a.t}`,direction:high?"SELL":"BUY",side,knownAt,previousA:prior.a,currentA:middle.a,previousB:prior.b,currentB:b,aPrice,previousAPrice:prior.aPrice,bPrice,previousBPrice:prior.bPrice,aBroke,bBroke});
      }
      previous.set(side,{a:middle.a,b,aPrice,bPrice});
    }
  }
  return events;
}
