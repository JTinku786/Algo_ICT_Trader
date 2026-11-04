/** Origin is a drawing anchor, not the time the zone became knowable. */
export function replayZoneAnchor<T extends {t:number;knownAt:number}>(bars:T[],zone:{kind:string;origin:number;knownAt:number}):T|undefined {
    if(["OB","FVG","BREAKER"].includes(zone.kind))return bars.find(b=>b.t===zone.origin);
    return bars.find(b=>b.knownAt>=zone.knownAt);
}
