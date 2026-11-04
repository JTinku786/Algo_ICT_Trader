import type { ReplayBar, IctOverlay } from "./weekly-replay";
import type { ReplayFrame as Frame } from "./weekly-replay";
export type SweepBox = { id:string; direction:"BUY"|"SELL"; start:ReplayBar; end:ReplayBar; level:number; low:number; high:number; knownAt:number };
export function liquiditySweeps(input:ReplayBar[],tf:Frame|"4h"|"1w"|"1mo",invalidDays:string[]=[]) {
  const bars=input.slice(-240),sweeps:SweepBox[]=[],breakers:IctOverlay[]=[];
  type Pivot={index:number;high:boolean;price:number;knownAt:number;raided:boolean};
  type Raid={pool:Pivot;start:number;extreme:number;structure:Pivot|undefined;reclaimed:boolean;broken:boolean};
  const pivots:Pivot[]=[],raids:Raid[]=[];
  const continuity=(a:ReplayBar,b:ReplayBar)=>{
    if(invalidDays.some(d=>d>=a.day && d<=b.day))return false;
    if(tf==="1mo")return new Date(b.day).getUTCFullYear()*12+new Date(b.day).getUTCMonth()===new Date(a.day).getUTCFullYear()*12+new Date(a.day).getUTCMonth()+1;
    if(tf==="1w")return Date.parse(b.day)-Date.parse(a.day)===7*86400000;
    if(tf==="1d")return Date.parse(b.day)-Date.parse(a.day)<=4*86400000;
    return b.t===a.knownAt;
  };
  for(let i=0;i<bars.length;i++){
    const b=bars[i];
    if(i && !continuity(bars[i-1],b)){pivots.length=0;raids.length=0;}
    for(const zone of breakers){if(zone.knownAt>=b.knownAt || zone.status==="SWEPT")continue;if(zone.direction==="BUY" ? b.c<zone.low : b.c>zone.high){zone.status="SWEPT";continue;}if(b.h>=zone.low && b.l<=zone.high){zone.status="TOUCHED";zone.touches++;zone.lastTouch=b.t;}}
    for(const pool of pivots.filter(p=>!p.raided && p.knownAt<b.knownAt)){
      if(!(pool.high ? b.h>pool.price : b.l<pool.price))continue;
      pool.raided=true;
      const structure=[...pivots].reverse().find(p=>p.high!==pool.high && p.index>pool.index && p.knownAt<b.knownAt);
      raids.push({pool,start:i,extreme:pool.high?b.h:b.l,structure,reclaimed:false,broken:false});
    }
    for(const raid of raids){
      const high=raid.pool.high;
      if(!raid.reclaimed){raid.extreme=high?Math.max(raid.extreme,b.h):Math.min(raid.extreme,b.l);if(high ? b.c<raid.pool.price : b.c>raid.pool.price){raid.reclaimed=true;sweeps.push({id:`${tf}-sweep-${bars[raid.pool.index].t}-${bars[raid.start].t}`,direction:high?"SELL":"BUY",start:bars[raid.start],end:b,level:raid.pool.price,low:high?raid.pool.price:raid.extreme,high:high?raid.extreme:raid.pool.price,knownAt:b.knownAt});}}
      const pivot=raid.structure, origin=pivot && bars[pivot.index];
      // Separate completed candles establish raid-before-break; an outside candle alone cannot prove sequence.
      if(pivot && i===raid.start && (high ? b.c<pivot.price : b.c>pivot.price))raid.broken=true;
      if(raid.broken || !pivot || !origin || i<=raid.start || !(high ? b.c<pivot.price : b.c>pivot.price))continue;
      raid.broken=true;
      if(!(high ? origin.c<origin.o : origin.c>origin.o))continue;
      const id=`${tf}-BREAKER-${b.t}-${origin.t}-${high?"SELL":"BUY"}`;
      if(breakers.some(zone=>zone.id===id))continue;
      breakers.push({id,kind:"BREAKER",tf,direction:high?"SELL":"BUY",low:origin.l,high:origin.h,origin:origin.t,originDay:origin.day,knownAt:b.knownAt,touches:0,lastTouch:null,status:"ACTIVE",lineage:`raid:${bars[raid.start].t}`,description:`${high?"Bearish":"Bullish"} breaker candidate: old ${high?"high":"low"} raided ${bars[raid.start].day}; later completed close breaks the intervening confirmed swing ${high?"low":"high"}. ${high?"Down":"Up"}-close swing candle, full wick range. Retest is separate; no entry is inferred. Major/intermediate trend qualification is not certified.`});
    }
    if(i>=2 && continuity(bars[i-2],bars[i-1]) && continuity(bars[i-1],b)){
      const p=bars[i-1];
      const dual=p.h>bars[i-2].h && p.h>b.h && p.l<bars[i-2].l && p.l<b.l;
      if(dual)continue;
      for(const high of [true,false])if(high ? p.h>bars[i-2].h && p.h>b.h : p.l<bars[i-2].l && p.l<b.l)pivots.push({index:i-1,high,price:high?p.h:p.l,knownAt:b.knownAt,raided:false});
    }
  }
  return {sweeps,breakers};
}
