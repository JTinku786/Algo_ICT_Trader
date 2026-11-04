import { confirmedSwingPath, type ReplayBar } from "./weekly-replay";
import type { ReplayFrame as Frame } from "./weekly-replay";

/** Running leg anchored at the latest causally confirmed swing; this is an indicator, not entry approval. */
export function replayFibonacci(bars: ReplayBar[], frame: Frame | "4h" | "1w" | "1mo", invalidDays: string[] = []) {
  const swing = confirmedSwingPath(bars, frame, invalidDays).at(-1), current = bars.at(-1);
  if (!swing || !current || invalidDays.some(day => day >= swing.day && day <= current.day)) return null;
  const leg = bars.filter(b => b.t >= swing.origin);
  const upward = swing.kind === "LOW";
  const low = upward ? swing.price : Math.min(...leg.map(b => b.l));
  const high = upward ? Math.max(...leg.map(b => b.h)) : swing.price;
  if (!(high > low)) return null;
  const level = (ratio: number) => upward ? high - (high - low) * ratio : low + (high - low) * ratio;
  return { low, high, upward, origin: swing.origin, anchorDay: swing.day, anchorKnownAt: swing.knownAt, knownAt: current.knownAt, currentDay: current.day, midpoint: (low + high) / 2, levels: [0, .5, .62, .705, .79, 1].map(ratio => ({ ratio, price: level(ratio) })) };
}
