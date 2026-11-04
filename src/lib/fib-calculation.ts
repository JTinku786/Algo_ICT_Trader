import type {ReplayBar} from './weekly-replay';
export type FibPivot={id:string;kind:'SH'|'SL';price:number;t:number;knownAt:number;index:number};
export type FibAnchors={points:FibPivot[];base:number;height:number;method:string};
export const fibRatios=[-.65,-.618,-.382,-.236,0,.236,.382,.5,.618,.65,.786,1,1.272,1.414,1.618,1.65,2.618,2.65,3.618,3.65,4.236,4.618];
export const defaultFibRatios=[0,.236,.382,.5,.618,.786,1,1.618,2.618,3.618,4.236];
/** Confirmation clock is the close of the last required right-hand candle. */
export function fibPivots(bars:readonly ReplayBar[],depth:number,asSupplied=false):FibPivot[]{
 const width=Math.max(1,Math.floor(depth/2)),out:FibPivot[]=[];
 for(let i=width;i+width<bars.length;i++)for(const kind of ['SH','SL'] as const){const price=kind==='SH'?bars[i].h:bars[i].l;let valid=true;
  for(let j=i-width;j<=i+width;j++){if(j===i)continue;const value=kind==='SH'?bars[j].h:bars[j].l;const beyond=kind==='SH'?value>price:value<price;const olderTie=!asSupplied&&j<i&&value===price;if(beyond||olderTie){valid=false;break;}}
  if(valid)out.push({id:`${kind}:${bars[i].t}`,kind,price,t:bars[i].t,knownAt:bars[i+width].knownAt,index:i});
 }return out.sort((a,b)=>a.knownAt-b.knownAt||a.index-b.index||(a.kind==='SH'?-1:1));
}
export function atr10(bars:readonly ReplayBar[]):(number|null)[]{let previous:number|null=null;let seed=0;return bars.map((b,i)=>{const tr=i?Math.max(b.h-b.l,Math.abs(b.h-bars[i-1].c),Math.abs(b.l-bars[i-1].c)):b.h-b.l;if(i<10)seed+=tr;if(i===9)previous=seed/10;else if(i>9)previous=(previous!*9+tr)/10;return previous;});}
export function zigzagPivots(bars:readonly ReplayBar[],depth:number,deviation:number):FibPivot[]{const atr=atr10(bars),position=new Map(bars.map((b,i)=>[b.knownAt,i])),out:FibPivot[]=[];
 for(const p of fibPivots(bars,depth)){const last=out.at(-1);if(!last){out.push(p);continue;}if(last.kind===p.kind){if(p.kind==='SH'?p.price>last.price:p.price<last.price)out[out.length-1]=p;continue;}
  const i=position.get(p.knownAt)!;if(atr[i]===null||bars[i].c===0||last.price===0)continue;const threshold=atr[i]!/Math.abs(bars[i].c)*100*deviation;const change=(p.price-last.price)/Math.abs(last.price)*100;
  if(p.kind==='SH'?change>=threshold:change<=-threshold)out.push(p);
 }return out;
}
export function retracementAnchors(points:readonly FibPivot[],reverse=false):FibAnchors|null{if(points.length<2)return null;const a=points.at(-2)!,b=points.at(-1)!;if(a.t>b.t||a.kind===b.kind||a.price===b.price)return null;return {points:[a,b],base:reverse?a.price:b.price,height:reverse?b.price-a.price:a.price-b.price,method:'Latest confirmed ZigZag segment'};}
/** Pine evaluates H and L together using the state at the start of each candle. */
export function extensionPivots(bars:readonly ReplayBar[],depth:number){
 const highs:FibPivot[]=[],lows:FibPivot[]=[];
 const candidates=fibPivots(bars,depth,true);
 for(let i=0;i<candidates.length;){
  const index=candidates[i].index;let high:FibPivot|null=null,low:FibPivot|null=null;
  while(i<candidates.length&&candidates[i].index===index){const p=candidates[i++];if(p.kind==='SH')high=p;else low=p;}
  const lastH=highs.at(-1),lastL=lows.at(-1);
  if(lastH&&lastL){
   if(lastH.t>lastL.t&&high){if(high.price>lastH.price)highs[highs.length-1]=high;high=null;}
   else if(lastH.t<=lastL.t&&low){if(low.price<lastL.price)lows[lows.length-1]=low;low=null;}
  }
  if(high)highs.push(high);if(low)lows.push(low);
 }
 return {highs,lows};
}
/** Literal anchor search from the supplied Auto Fib Extension, including its asymmetric comparison. */
export function extensionAnchors(bars:readonly ReplayBar[],depth:number,comparison:'SUPPLIED'|'DIRECTIONAL'='SUPPLIED'):FibAnchors|null{
 const {highs,lows}=extensionPivots(bars,depth);
 const hs=[...highs],ls=[...lows];
 while(hs.length&&ls.length){let h=hs.pop()!,l=ls.pop()!;let highLast=h.t>l.t;let prior=highLast?hs:ls;
  for(let i=prior.length-1;i>=0;i--){const p=prior[i];if(p.t<l.t)break;const better=comparison==='SUPPLIED'?p.price>h.price:highLast?p.price>h.price:p.price<l.price;
   if(better){if(highLast)h=prior.pop()!;else if(comparison==='SUPPLIED')h=prior.pop()!;else l=prior.pop()!;}else prior.splice(i,1);
  }
  if(!hs.length||!ls.length)break;highLast=h.t>l.t;prior=highLast?hs:ls;const a=prior.at(-1);if(!a)break;const b=highLast?l:h,c=highLast?h:l,diff=Math.abs(a.price-b.price);
  const accepted=highLast?c.price<=b.price+diff&&c.price>=b.price+diff*.236:c.price>=b.price-diff&&c.price<=b.price-diff*.236;
  if(!accepted){(highLast?ls:hs).push(b);continue;}
  if(!(a.t<b.t&&b.t<c.t)||!diff)return null;
  return {points:[a,b,c],base:c.price,height:(highLast?-1:1)*diff,method:comparison==='SUPPLIED'?'Supplied Pine extension anchor search':'Direction-aware extension anchor search'};
 }return null;
}
export function manualAnchors(points:FibPivot[],kind:'retracement'|'extension',reverse=false):FibAnchors|null{const count=kind==='retracement'?2:3;if(points.length!==count||points.some((p,i)=>i>0&&(p.t<=points[i-1].t||p.kind===points[i-1].kind)))return null;
 if(kind==='retracement'){const anchors=retracementAnchors(points,reverse);return anchors?{...anchors,method:'Selected confirmed swing anchors'}:null;}const [a,b,c]=points;if(a.price===b.price)return null;return{points,base:c.price,height:(b.price-a.price)*(reverse?-1:1),method:'Selected confirmed swing anchors'};}
export function fibPrice(anchors:FibAnchors,ratio:number,reverse=false){return anchors.base+anchors.height*ratio*(reverse?-1:1);}

/** Stabilize binary noise around an exact half tick before rounding. */
export function fibTickPrice(price:number,digits:number){const factor=10**digits,scaled=price*factor;return Math.round(scaled+Number.EPSILON*Math.max(1,Math.abs(scaled))*4)/factor;}
