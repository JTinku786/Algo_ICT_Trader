import { ICT_SESSION_DEFINITIONS } from "./ict-sessions";
import type { ReplayBar } from "./weekly-replay";

// These are observed session extrema, not institutional sponsorship or entry signals.
export function timeInfluence(bars: ReplayBar[], daily: ReplayBar[] = []) {
  const format = new Intl.DateTimeFormat("en-CA", {timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
  const clock = (t:number) => {const p=Object.fromEntries(format.formatToParts(t).map(p=>[p.type,p.value]));return {day:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute)};};
  const cutoff = bars.at(-1)?.knownAt ?? 0;
  const windows = ICT_SESSION_DEFINITIONS.filter(s=>["london_open_killzone","new_york_open_killzone","ny_am_session"].includes(s.id));
  const observed = bars.filter(b=>b.t>=cutoff-7*86400000).map(b=>({b,start:clock(b.t),end:clock(b.knownAt)}));
  const days = [...new Set(observed.map(r=>r.start.day))].slice(-5);
  return days.flatMap(day=>windows.flatMap(window=>{
    const members=observed.filter(({start,end})=>start.day===day && end.day===day && start.minute>=window.startMinute && end.minute<=window.endMinute).map(r=>r.b);
    if(!members.length)return [];
    const low=members.reduce((a,b)=>b.l<a.l?b:a), high=members.reduce((a,b)=>b.h>a.h?b:a);
    const current=clock(cutoff), closed=current.day>day || current.day===day && current.minute>=window.endMinute;
    const complete=clock(members[0].t).minute===window.startMinute && clock(members.at(-1)!.knownAt).minute===window.endMinute && members.every((b,i)=>i===0 || b.t===members[i-1].knownAt);
    const session=daily.find(b=>clock(b.t).day===day && b.knownAt<=cutoff);
    return [{id:`${window.id}:${day}`,day,label:window.label,first:members[0],last:members.at(-1)!,low,high,closed,complete,lowOfDay:!!session && session.l===low.l,highOfDay:!!session && session.h===high.h}];
  }));
}
