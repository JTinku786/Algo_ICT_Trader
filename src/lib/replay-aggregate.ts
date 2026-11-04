import type {ReplayBar} from "./weekly-replay";
/** Aggregate only contiguous, fully completed source candles, anchored to session open. */
export function aggregateReplayBars(bars:ReplayBar[],minutes:number,open:number,close:number){
 const groups=new Map<string,ReplayBar[]>();
 for(const b of bars){const start=open+Math.floor((b.minute-open)/minutes)*minutes;const key=`${b.day}:${start}`;const group=groups.get(key)??[];group.push(b);groups.set(key,group);}
 return [...groups.values()].flatMap(group=>{
  group.sort((a,b)=>a.t-b.t);const first=group[0],start=open+Math.floor((first.minute-open)/minutes)*minutes,end=Math.min(start+minutes,close);
  if(first.minute!==start || group.length!==(end-start)/5 || group.some((b,i)=>b.minute!==start+i*5 || (i>0 && b.t-group[i-1].t!==300000)))return [];
  return [{...first,h:Math.max(...group.map(b=>b.h)),l:Math.min(...group.map(b=>b.l)),c:group.at(-1)!.c,v:group.reduce((n,b)=>n+(b.v??0),0),knownAt:group.at(-1)!.knownAt}];
 }).sort((a,b)=>a.t-b.t);
}
