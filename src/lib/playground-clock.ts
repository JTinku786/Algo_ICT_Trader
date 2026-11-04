import type { ReplayBar } from "./weekly-replay";
export function nextPlaygroundBar(bars: ReplayBar[], clock: number) {
  return bars.find(b => b.knownAt > clock);
}
export function revealedPlaygroundBars(bars: ReplayBar[], clock: number, limit?: number) {
  const revealed=bars.filter(b=>b.knownAt<=clock);
  return limit ? revealed.slice(-limit) : revealed;
}
