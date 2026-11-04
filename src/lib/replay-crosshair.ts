export type ReplayCursor={source:string;at:number;price:number}|null;
export function createReplayCrosshair(){
 const listeners=new Set<(cursor:ReplayCursor)=>void>();
 return {publish(cursor:ReplayCursor){listeners.forEach(listener=>listener(cursor));},subscribe(listener:(cursor:ReplayCursor)=>void){listeners.add(listener);return ()=>{listeners.delete(listener);};}};
}
export type ReplayCrosshair=ReturnType<typeof createReplayCrosshair>;
export function matchingReplayCandle<T extends {t:number;knownAt:number}>(bars:readonly T[],at:number){return bars.findLast(b=>b.t<=at && at<b.knownAt);}
