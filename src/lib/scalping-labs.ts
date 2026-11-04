export const scalpingPlaybooks = [
 {id:"RAID",name:"A · Liquidity raid → reversal"},
 {id:"INVERSION",name:"B · FVG failure → IFVG"},
 {id:"BREAKER",name:"C · Breaker / BPR"},
 {id:"REACTION",name:"D · HTF array reaction"},
 {id:"OPENING",name:"E · Opening-price context"},
 {id:"CONTINUATION",name:"F · Continuation / redistribution"},
] as const;
export type ScalpingSettings={version:1;playbooks:string[];anchor:"CE"|"EDGE"|"OB_OPEN"|"BODY_MT";stop:"EXTREME"|"ARRAY"|"OB_MT";target:"LIQUIDITY"|"HTF_ARRAY";tickSize:number;maxAgeBars:number};
export const defaultScalpingSettings:ScalpingSettings={version:1,playbooks:["RAID","INVERSION","BREAKER","REACTION","OPENING","CONTINUATION"],anchor:"CE",stop:"EXTREME",target:"LIQUIDITY",tickSize:0.00001,maxAgeBars:200};
export function validateScalpingSettings(value:unknown):string|null{
 if(!value||typeof value!=="object")return "Select Scalping Labs playbooks and execution settings.";
 const s=value as ScalpingSettings;
 if(s.version!==1||!Array.isArray(s.playbooks)||!s.playbooks.length||new Set(s.playbooks).size!==s.playbooks.length||s.playbooks.some(id=>!scalpingPlaybooks.some(p=>p.id===id)))return "Select at least one known Scalping Labs playbook.";
 if(!["CE","EDGE","OB_OPEN","BODY_MT"].includes(s.anchor)||!["EXTREME","ARRAY","OB_MT"].includes(s.stop)||!["LIQUIDITY","HTF_ARRAY"].includes(s.target))return "Unknown entry, stop or target policy.";
 if(!Number.isFinite(s.tickSize)||s.tickSize<=0||s.tickSize>100||!Number.isInteger(s.maxAgeBars)||s.maxAgeBars<1||s.maxAgeBars>10000)return "Tick size must be positive; freshness must be 1–10,000 candles.";
 return null;
}

/** Shared simple-form scan policy; source audits must use the same contract. */
export const defaultScalpingSelection={confirmation:"CHOCH,CISD",arrayScope:"CONTINUATION",carryIn:true,retestMode:"ALL",htfKinds:["OB","FVG","IFVG","BREAKER","BPR","BSL","SSL","SWINGS","PDH","PDL","REJECTION","WICK"],ltfKinds:["OB","FVG","IFVG","BREAKER","BPR","MITIGATION","PROPULSION"]};
