import type {IctOverlay} from "./weekly-replay";
/** Closest active PD candidates below, containing, and above the revealed close. */
export function nearestPdArrays(zones:IctOverlay[],price:number,cutoff:number){
 const candidates=zones.filter(z=>["FVG","IFVG","OB","BREAKER"].includes(z.kind)&&z.status!=="SWEPT"&&z.knownAt<=cutoff);
 const distance=(z:IctOverlay)=>price<z.low?z.low-price:price>z.high?price-z.high:0;
 const sorted=candidates.sort((a,b)=>distance(a)-distance(b)||b.knownAt-a.knownAt);
 return [sorted.find(z=>z.high<price),sorted.find(z=>z.low<=price&&z.high>=price),sorted.find(z=>z.low>price)].filter((z):z is IctOverlay=>!!z);
}
