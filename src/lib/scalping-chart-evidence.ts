import type { IctOverlay, ReplayBar } from "./weekly-replay";

export type SavedLevel = { id: string; kind: string; tf: string; low?: number; high?: number; level?: number; origin?: number; knownAt: number };
export type ScalpingProof = {
 context: IctOverlay; array: IctOverlay; touch: ReplayBar;
 confirmation: { id: string; origin: number; at: number; formationStart?: number; knownAt: number; level: number; label: string };
 plan: { entry: number; stop: number; stopAt?: number; target: number; knownAt: number; rule?: string; sweepSources?: SavedLevel[]; targetSource?: SavedLevel; targetCandidates?: SavedLevel[] };
 validFvg?: Record<string, {valid: boolean; reason?: string; midpoint?: number; range?: {tf:string;low:number;high:number;equilibrium:number;lowOrigin:number;highOrigin:number;knownAt:number}}>;
 tf1TouchFreshness?: {valid:boolean;shift?:{valid:boolean;reason:string};entry?:{valid:boolean;reason:string}};
};
export type EvidenceLine = {label:string;price:number;color:string;knownAt:number;originAt?:number;sourceId?:string};

/** Only saved JSON prices and timestamps; never re-detect a different setup. */
export function scalpingEvidence(proof:ScalpingProof, frame:"TF1"|"TF2", allTargets=false) {
 const own=frame==="TF1" ? proof.context : proof.array;
 const lines:EvidenceLine[]=[];
 const add=(label:string,price:number|undefined,knownAt:number,color:string,originAt?:number,sourceId?:string)=>{
  if(Number.isFinite(price))lines.push({label,price:price!,knownAt,color,originAt,sourceId});
 };
 add(`${frame} ${own.kind} CE`,(own.low+own.high)/2,own.knownAt,"#0f766e",own.origin,own.id);
 if(own.lineage){
  add(`Source ${own.lineage.split(":")[1]} low → ${own.kind}`,own.low,own.knownAt,"#64748b",own.origin,own.lineage);
  add(`Source ${own.lineage.split(":")[1]} high → ${own.kind}`,own.high,own.knownAt,"#64748b",own.origin,own.lineage);
 }
 for(const [name,check] of Object.entries(proof.validFvg??{})){
  if(!name.endsWith(frame)||!check.range)continue;
  const r=check.range;
  add(`${frame} dealing range high`,r.high,r.knownAt,"#7c3aed",r.highOrigin);
  add(`${frame} dealing range low`,r.low,r.knownAt,"#7c3aed",r.lowOrigin);
  add(`${frame} dealing range EQ · 50%`,r.equilibrium,r.knownAt,"#7c3aed",Math.min(r.lowOrigin,r.highOrigin));
 }
 const sources=[...(proof.plan.sweepSources??[]),...(proof.plan.targetSource?[proof.plan.targetSource]:[]),...(allTargets?proof.plan.targetCandidates??[]:[])];
 const unique=new Map(sources.map(s=>[s.id,s]));
 for(const s of unique.values()){
  if(frame==="TF1"&&s.tf!==proof.context.tf)continue;
  const selected=s.id===proof.plan.targetSource?.id;
  const swept=proof.plan.sweepSources?.some(x=>x.id===s.id);
  add(`${s.tf} ${s.kind} · ${selected?"selected target":swept?"raid source":"target candidate"}`,s.level??s.low,s.knownAt,selected?"#15803d":swept?"#c2410c":"#64748b",s.origin,s.id);
 }
 return {zones:[own],lines};
}
