import type { ReferencePoint } from "./daily-context";
import type { IctOverlay } from "./weekly-replay";
export function rangeLiquidity(references: ReferencePoint[], zones: IctOverlay[]) {
  const highs=references.filter(r=>r.low===r.high && /high/i.test(r.kind));
  const high=highs.find(r=>/^Weekly high/i.test(r.kind))??highs[0];
  const low=high && references.find(r=>r.low===r.high && /low/i.test(r.kind) && r.knownAt===high.knownAt && r.originDay===high.originDay && (!/^Weekly high/i.test(high.kind) || /^Weekly low/i.test(r.kind)));
  if(!high || !low || high.high<=low.low)return null;
  const active=zones.filter(z=>z.status!=="SWEPT");
  return {high:high.high,low:low.low,origin:high.originDay,basis:high.kind.replace(/high.*$/i,"range"),
    buyPools:active.filter(z=>["BSL","EQH"].includes(z.kind) && z.low>high.high),
    sellPools:active.filter(z=>["SSL","EQL"].includes(z.kind) && z.high<low.low),
    internal:active.filter(z=>["FVG","IFVG","OB","BREAKER"].includes(z.kind) && z.low>=low.low && z.high<=high.high),
    voids:references.filter(r=>/void/i.test(r.kind) && r.low>=low.low && r.high<=high.high)};
}
