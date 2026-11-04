/** Price bounds for the latest revealed 80 candles, with 2% price padding. */
export function replayFollowRange(bars:readonly {h:number;l:number}[],minMove:number){
  const window=bars.slice(-80).filter(b=>Number.isFinite(b.h)&&Number.isFinite(b.l));
  if(!window.length)return null;
  const high=Math.max(...window.map(b=>b.h)),low=Math.min(...window.map(b=>b.l));
  return {minValue:low-Math.max(Math.abs(low)*.02,minMove),maxValue:high+Math.max(Math.abs(high)*.02,minMove)};
}
