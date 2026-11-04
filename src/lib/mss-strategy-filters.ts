/** Versioned research requirements. Checkbox selection is an AND; array kinds remain OR. */
export const strategyChecks = [
  {id:"SWEEP",label:"Liquidity swept and reclaimed",help:"Observed reversal extreme penetrates an already known opposing pool, followed by a reclaim before entry."},
  {id:"DISPLACEMENT",label:"Directional displacement",help:"Shift candle body is at least 60% of its range and 1.5 times the median body of the previous 20 completed candles. This threshold is a local interpretation."},
  {id:"PD_RANGE",label:"Entry in discount / premium",help:"BUY below, SELL above the midpoint of the observed reversal-to-shift range. This is the TF2 formation range, not an assumed weekly range."},
  {id:"OTE",label:"Entry in the 62%–79% retracement",help:"Retracement of the observed TF2 reversal-to-shift range. The range endpoints are recorded; this does not substitute for an unspecified HTF dealing range."},
  {id:"UNICORN",label:"Breaker + FVG overlap",help:"Entry lies inside the overlap of a same-direction breaker and FVG, both active and known before the entry candle."},
  {id:"THREE_DRIVES",label:"Three confirmed drives",help:"Three successively higher confirmed highs for SELL, or lower confirmed lows for BUY, before shift confirmation. Uses confirmed native pivots; local interpretation."},
  {id:"HTF_CE",label:"TF1 imbalance midpoint reached",help:"The HTF touch candle crosses the selected FVG / IFVG midpoint. Not applicable to a non-imbalance context."},
  {id:"NY_OPEN",label:"Favourable side of NY midnight open",help:"BUY below or SELL above the same-day New York midnight open. Missing midnight candle is unverified, not a pass."},
  {id:"TARGET",label:"Existing opposing liquidity target",help:"Structural target is already known, remains unswept and is beyond entry in trade direction."},
  {id:"SMT",label:"SMT divergence",help:"Requires a synchronized comparison instrument and a specified pivot pair. Not computed by this investigation; selecting it holds candidates as unverified."},
  {id:"NEWS",label:"News-event clearance",help:"Requires an event calendar and an explicit exclusion interval. Not computed; selecting it holds candidates as unverified."},
] as const;
export type StrategyCheck = typeof strategyChecks[number]["id"];
export type StrategyFilters={version:1;playbook:string;required:StrategyCheck[];direction:"ALL"|"BUY"|"SELL";entryPrice:"EDGE"|"CE";minRR:number;maxRR:number|null;session:"ANY"|"LONDON"|"NEW_YORK"|"LONDON_LUNCH"};
export const defaultStrategyFilters:StrategyFilters={version:1,playbook:"CUSTOM",required:[],direction:"ALL",entryPrice:"EDGE",minRR:0,maxRR:null,session:"ANY"};
export const playbooks=[
 {id:"CUSTOM",name:"Custom investigation",note:"Keep the detector selections; choose independent evidence requirements.",required:[] as StrategyCheck[],arrays:["OB","BREAKER","FVG","IFVG","BPR"],scope:"EXISTING"},
 {id:"SWEEP_REVERSAL",name:"Liquidity → shift → retest",note:"A sweep/reclaim, selected shift and later valid-array retest. The shift method remains explicit.",required:["SWEEP","TARGET"] as StrategyCheck[],arrays:["OB","FVG","BREAKER"],scope:"EXISTING"},
 {id:"UNICORN",name:"Unicorn · breaker + FVG",note:"Requires the actual breaker/FVG price overlap; checking both array types alone is insufficient.",required:["SWEEP","UNICORN","TARGET"] as StrategyCheck[],arrays:["BREAKER","FVG"],scope:"EXISTING"},
 {id:"INVERSION",name:"Inversion / balanced range",note:"IFVG and BPR are separate array types; either can supply the retest. Opposing-gap overlap is mechanically derived.",required:["SWEEP","TARGET"] as StrategyCheck[],arrays:["IFVG","BPR"],scope:"EXISTING"},
 {id:"CONTINUATION",name:"Post-shift continuation",note:"Allows arrays activated after the shift, until reversal-extreme breach or HTF invalidation. Does not certify a complete MMXM narrative.",required:["TARGET"] as StrategyCheck[],arrays:["OB","FVG","BREAKER","IFVG","BPR"],scope:"CONTINUATION"},
 {id:"THREE_DRIVES",name:"Three drives → reversal",note:"Adds a confirmed-pivot three-drive requirement. Hand-drawn peaks can differ from confirmed library pivots.",required:["SWEEP","THREE_DRIVES","TARGET"] as StrategyCheck[],arrays:["FVG","OB","BPR"],scope:"EXISTING"},
] as const;

export function validateStrategyFilters(value:unknown):string|null{
 if(value===undefined)return null;
 if(!value||typeof value!=="object")return "Strategy filters must be an object.";
 const f=value as StrategyFilters;
 if(f.version!==1||!playbooks.some(p=>p.id===f.playbook)||!Array.isArray(f.required)||f.required.some(k=>!strategyChecks.some(c=>c.id===k))||new Set(f.required).size!==f.required.length)return "Unknown strategy version, playbook or requirement.";
 if(!["ALL","BUY","SELL"].includes(f.direction)||!["EDGE","CE"].includes(f.entryPrice)||!["ANY","LONDON","NEW_YORK","LONDON_LUNCH"].includes(f.session))return "Invalid strategy direction, entry pricing or session.";
 if(!Number.isFinite(f.minRR)||f.minRR<0||f.minRR>100||f.maxRR!==null&&(!Number.isFinite(f.maxRR)||f.maxRR<=f.minRR||f.maxRR>100))return "R:R limits must be ordered, finite and between 0 and 100.";
 return null;
}
