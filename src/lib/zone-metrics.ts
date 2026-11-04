import type { IctOverlay, ReplayBar } from "./weekly-replay";
/** Candle-range coverage, not volume or an institutional mitigation score. */
export function zoneMetrics(zone: IctOverlay, bars: ReplayBar[]) {
  const width = zone.high - zone.low;
  const intervals: [number, number][] = [];
  let touches = 0, touchBars = 0, inside = false;
  for (const bar of bars) {
    if (bar.knownAt <= zone.knownAt) continue;
    const intersects = bar.h >= zone.low && bar.l <= zone.high;
    if (intersects) {
      touchBars++;
      if (!inside) touches++;
      const lo = Math.max(zone.low, bar.l), hi = Math.min(zone.high, bar.h);
      if (hi > lo) intervals.push([lo, hi]);
    }
    inside = intersects;
    // Original zone metrics stop at its invalidating close. Inversions have their own lifecycle.
    if (zone.direction === "BUY" ? bar.c < zone.low : bar.c > zone.high) break;
  }
  intervals.sort((a,b) => a[0]-b[0]);
  let coverage = 0, left = 0, right = 0, started = false;
  for (const [lo, hi] of intervals) {
    if (!started) { left = lo; right = hi; started = true; }
    else if (lo <= right) right = Math.max(right, hi);
    else { coverage += right-left; left = lo; right = hi; }
  }
  if (started) coverage += right-left;
  const filled = width > 0 ? Math.min(100, Math.max(0, coverage/width*100)) : 0;
  return { completeHistory: !!bars.length && bars[0].knownAt <= zone.knownAt && width > 0, filled, freshness: 100-filled, touches, touchBars, state: touchBars === 0 ? "Fresh" : filled >= 100-1e-8 ? "Filled" : "Tested" };
}
