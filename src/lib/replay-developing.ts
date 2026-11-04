import type {ReplayBar} from "./weekly-replay";
import {weekStart} from "./weekly-replay";

/** Display-only candle assembled from observations available at the 5m clock. */
export function developingReplayBar(frame:string, source:ReplayBar[], daily:ReplayBar[], completed:ReplayBar[], clock:number, sessionOpen:number, sourceStep=5):ReplayBar|null {
 const revealed=source.filter(b=>b.knownAt<=clock).sort((a,b)=>a.t-b.t);
 const last=revealed.at(-1);if(!last)return null;
 const aggregate=(group:ReplayBar[],day=group[0]?.day,t=group[0]?.t):ReplayBar|null=>group.length?{...group[0],day,t,h:Math.max(...group.map(b=>b.h)),l:Math.min(...group.map(b=>b.l)),c:group.at(-1)!.c,knownAt:group.at(-1)!.knownAt}:null;
 if(["2m","3m","5m","10m","15m","30m","1h","4h"].includes(frame)){
  const minutes=frame==="4h"?240:frame==="1h"?60:Number(frame.slice(0,-1));
  if(minutes<=sourceStep)return null;
  const start=sessionOpen+Math.floor((last.minute-sessionOpen)/minutes)*minutes;
  const group=revealed.filter(b=>b.day===last.day && b.minute>=start && b.minute<start+minutes);
  // Missing leading or interior source bars cannot define a reliable developing open.
  if(group[0]?.minute!==start || group.some((b,i)=>b.minute!==start+i*sourceStep))return null;
  const bar=aggregate(group);return bar && !completed.some(b=>b.t===bar.t)?bar:null;
 }
 const currentDay=aggregate(revealed.filter(b=>b.day===last.day));
 if(!currentDay)return null;
 const days=daily.filter(b=>b.knownAt<=clock);
 if(!days.some(b=>b.day===last.day))days.push(currentDay);
 if(frame==="1d")return completed.some(b=>b.day===last.day)?null:currentDay;
 const key=frame==="1w"?weekStart(last.day):`${last.day.slice(0,7)}-01`;
 const group=days.filter(b=>(frame==="1w"?weekStart(b.day):`${b.day.slice(0,7)}-01`)===key).sort((a,b)=>a.t-b.t);
 const bar=aggregate(group,key);
 return bar && !completed.some(b=>b.day===key)?bar:null;
}
