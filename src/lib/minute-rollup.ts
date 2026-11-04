import type { ReplayBar } from "./weekly-replay";

/** Complete local-day buckets only; missing minutes never become synthetic candles. */
export function rollupMinuteBars(bars: ReplayBar[], minutes: 2 | 3): ReplayBar[] {
  const buckets = new Map<string, ReplayBar[]>();
  for (const b of bars) {
    const key = `${b.day}:${Math.floor(b.minute / minutes)}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(b);
    buckets.set(key, bucket);
  }
  const result: ReplayBar[] = [];
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => a.t - b.t);
    const first = bucket[0], last = bucket[bucket.length - 1];
    if (bucket.length !== minutes || first.minute % minutes !== 0 ||
        bucket.some((b, i) => b.t !== first.t + i * 60000 || b.minute !== first.minute + i || b.knownAt !== b.t + 60000)) continue;
    result.push({ ...first, h: Math.max(...bucket.map(b => b.h)),
      l: Math.min(...bucket.map(b => b.l)), c: last.c,
      v: bucket.reduce((sum, b) => sum + (b.v ?? 0), 0), knownAt: last.knownAt });
  }
  return result.sort((a, b) => a.t - b.t);
}

/** Four complete consecutive hours on the local midnight grid; partial buckets omitted. */
export function rollupFourHourBars(bars: ReplayBar[]): ReplayBar[] {
  const buckets = new Map<string, ReplayBar[]>();
  for (const bar of bars) {
    const key = `${bar.day}:${Math.floor(bar.minute / 240)}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(bar); buckets.set(key, bucket);
  }
  return [...buckets.values()].flatMap(bucket => {
    bucket.sort((a,b)=>a.t-b.t);
    const first=bucket[0],last=bucket.at(-1)!;
    if(bucket.length!==4||first.minute%240!==0||bucket.some((bar,i)=>bar.t!==first.t+i*3600000||bar.minute!==first.minute+i*60||bar.knownAt!==bar.t+3600000))return [];
    return [{...first,h:Math.max(...bucket.map(b=>b.h)),l:Math.min(...bucket.map(b=>b.l)),c:last.c,v:bucket.reduce((sum,b)=>sum+(b.v??0),0),knownAt:last.knownAt}];
  }).sort((a,b)=>a.t-b.t);
}

/** Two consecutive completed 5m candles on the local midnight 10m grid. */
export function rollupTenMinuteBars(bars: ReplayBar[]): ReplayBar[] {
 const buckets=new Map<string,ReplayBar[]>();
 for(const b of bars){const key=`${b.day}:${Math.floor(b.minute/10)}`;const group=buckets.get(key)??[];group.push(b);buckets.set(key,group);}
 return [...buckets.values()].flatMap(group=>{group.sort((a,b)=>a.t-b.t);const first=group[0],last=group.at(-1)!;
 if(group.length!==2||first.minute%10!==0||group.some((b,i)=>b.t!==first.t+i*300000||b.minute!==first.minute+i*5||b.knownAt!==b.t+300000))return [];
 return [{...first,h:Math.max(...group.map(b=>b.h)),l:Math.min(...group.map(b=>b.l)),c:last.c,v:group.reduce((s,b)=>s+(b.v??0),0),knownAt:last.knownAt}];}).sort((a,b)=>a.t-b.t);
}

/** Empty native archives may use complete stored 5m buckets, never interpolation. */
export function rollupStoredFiveMinuteBars(bars:ReplayBar[],minutes:15|30|60,market:string):ReplayBar[]{
 const open=market==='us'?570:market==='india'?555:0;
 const buckets=new Map<string,ReplayBar[]>();
 for(const b of bars){if(b.minute<open)continue;const key=`${b.day}:${Math.floor((b.minute-open)/minutes)}`;const group=buckets.get(key)??[];group.push(b);buckets.set(key,group);}
 return [...buckets.values()].flatMap(group=>{group.sort((a,b)=>a.t-b.t);const first=group[0],last=group.at(-1)!;
 if(group.length!==minutes/5||(first.minute-open)%minutes!==0||group.some((b,i)=>b.t!==first.t+i*300000||b.minute!==first.minute+i*5||b.knownAt!==b.t+300000))return [];
 return [{...first,h:Math.max(...group.map(b=>b.h)),l:Math.min(...group.map(b=>b.l)),c:last.c,v:group.reduce((s,b)=>s+(b.v??0),0),knownAt:last.knownAt}];}).sort((a,b)=>a.t-b.t);
}

/** Preserve native prices; supplement only missing timestamps with complete source buckets. */
export function supplementNativeBars(native:ReplayBar[],derived:ReplayBar[]):ReplayBar[]{
 const existing=new Map(native.map(b=>[b.t,b]));
 for(const b of derived)if(!existing.has(b.t))existing.set(b.t,b);
 return [...existing.values()].sort((a,b)=>a.t-b.t);
}

/** Derive missing US daily context only from a complete regular session. */
export function supplementUsDailyBars(native:ReplayBar[],source:ReplayBar[]):ReplayBar[]{
 const days=new Map(native.map(b=>[b.day,b]));const groups=new Map<string,ReplayBar[]>();
 for(const b of source){if(b.minute<570||b.minute>=960)continue;const rows=groups.get(b.day)??[];rows.push(b);groups.set(b.day,rows);}
 for(const [day,rows] of groups){
  if(days.has(day))continue;rows.sort((a,b)=>a.t-b.t);const first=rows[0],last=rows.at(-1)!;
  if(rows.length!==78||first.minute!==570||last.minute!==955||rows.some((b,i)=>b.minute!==570+i*5||b.t!==first.t+i*300000||b.knownAt!==b.t+300000))continue;
  days.set(day,{...first,h:Math.max(...rows.map(b=>b.h)),l:Math.min(...rows.map(b=>b.l)),c:last.c,v:rows.reduce((n,b)=>n+(b.v??0),0),knownAt:last.knownAt});
 }
 return [...days.values()].sort((a,b)=>a.t-b.t);
}
