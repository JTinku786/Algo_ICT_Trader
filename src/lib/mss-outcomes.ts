import type {ReplayBar} from './weekly-replay';

export type OutcomeMode='UNTIL_HIT'|'CLOSE_BY_END';
export type OutcomePlan={key:string;direction:'BUY'|'SELL';entryAt:number;entry:number;stop:number;target:number};
export type TradeOutcome={outcome:'WIN'|'LOSS'|'OPEN'|'END';r:number;exitAt:number|null;exitKnownAt:number|null;lastClose:number|null};
export function candleExit(plan:OutcomePlan,b:ReplayBar):TradeOutcome|null {
 const sign=plan.direction==='BUY'?1:-1,risk=sign*(plan.entry-plan.stop);
 if(b.t<=plan.entryAt||risk<=0)return null;
 const stop=sign===1?b.l<=plan.stop:b.h>=plan.stop;
 const target=sign===1?b.h>=plan.target:b.l<=plan.target;
 if(!stop&&!target)return null;
 return {outcome:stop?'LOSS':'WIN',r:stop?-1:sign*(plan.target-plan.entry)/risk,exitAt:b.t,exitKnownAt:b.knownAt,lastClose:b.c};
}
export function walkOutcome(plan:OutcomePlan,bars:ReplayBar[],mode:OutcomeMode='UNTIL_HIT'):TradeOutcome {
 const sign=plan.direction==='BUY'?1:-1,risk=sign*(plan.entry-plan.stop);
 let last:ReplayBar|undefined;
 for(const b of bars){if(b.t<plan.entryAt)continue;last=b;if(b.t===plan.entryAt)continue;const hit=candleExit(plan,b);if(hit)return hit;}
 return {outcome:mode==='CLOSE_BY_END'&&last?'END':'OPEN',r:last&&risk>0?sign*(last.c-plan.entry)/risk:0,exitAt:mode==='CLOSE_BY_END'&&last?last.t:null,exitKnownAt:mode==='CLOSE_BY_END'&&last?last.knownAt:null,lastClose:last?.c??null};
}
export type FutureOutcomeData={outcomes:Record<string,TradeOutcome>;lower:ReplayBar[];higher:ReplayBar[];daily:ReplayBar[];scannedThrough:string;unresolved:number;lastCandleAt:number|null};
