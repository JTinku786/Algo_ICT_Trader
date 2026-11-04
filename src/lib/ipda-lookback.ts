import type { ReplayBar, IctOverlay } from "./weekly-replay";
export function ipdaLookback(daily:ReplayBar[],day:string,zones:IctOverlay[]=[]) {
  const date=new Date(`${day}T12:00:00Z`);
  if(!Number.isFinite(date.getTime()))return null;
  const previousMonth=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()-1,1)).toISOString().slice(0,7);
  const quarterStart=new Date(Date.UTC(date.getUTCFullYear(),Math.floor(date.getUTCMonth()/3)*3,1)).toISOString().slice(0,10);
  const firstCandidate=daily.find(b=>b.day.startsWith(previousMonth));
  const initial=firstCandidate && (daily[0].day<`${previousMonth}-01` || firstCandidate.day===`${previousMonth}-01`) ? firstCandidate : undefined;
  let anchor=initial,high=initial?.h??NaN,low=initial?.l??NaN,reason="Previous month's first stored completed trading session";
  if(initial)for(const b of daily.filter(b=>b.t>initial.t)){
    const hh=b.h>high,ll=b.l<low;
    if(hh || ll){anchor=b;reason=hh&&ll?"Both extremes extended; no direction inferred":hh?"New higher high resets anchor":"New lower low resets anchor";}
    high=Math.max(high,b.h);low=Math.min(low,b.l);
  }
  return {quarterStart,previousMonth,initial,anchor,reason,windows:[20,40,60].map(count=>{
    const bars=daily.slice(-count),complete=bars.length===count;
    const refs=complete?zones.filter(z=>z.status!=="SWEPT" && z.originDay>=bars[0].day && ["OB","FVG","IFVG","BREAKER"].includes(z.kind)):[];
    return {count,complete,available:bars.length,first:bars[0],last:bars.at(-1),high:complete?Math.max(...bars.map(b=>b.h)):null,low:complete?Math.min(...bars.map(b=>b.l)):null,references:refs};
  })};
}
