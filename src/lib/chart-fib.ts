// Shared Fibonacci overlay for every ICT chart. Uses the same engine and defaults
// as the Fib Calculation page (lib/fib-calculation.ts), so levels agree everywhere:
//  - Retracement: latest confirmed ZigZag segment (depth 10, ATR deviation 3).
//  - Extension:   3-point A-B-C trend-based extension (Pine auto-extension search).
// Only bars passed in are used, so a chart cut at entry never sees future swings.
import { extensionAnchors, fibPrice, retracementAnchors, zigzagPivots, type FibAnchors } from "./fib-calculation";
import type { ReplayBar } from "./weekly-replay";

export type FibBar = { t: number; o: number; h: number; l: number; c: number; knownAt?: number };
export type FibLevel = { ratio: number; price: number; label: string; color: string };
export type FibStudy = { kind: "retracement" | "extension"; anchors: FibAnchors; startT: number; levels: FibLevel[] };
export type ChartFib = { retracement: FibStudy | null; extension: FibStudy | null };

export const FIB_RETRACEMENT_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 1];
export const FIB_EXTENSION_RATIOS = [0, 0.618, 1, 1.272, 1.618, 2, 2.618];
export const FIB_DEFAULTS = { depth: 10, deviation: 3 };

// Retracement teal family with the ICT OTE band (0.618–0.786) highlighted; extensions violet.
export function fibLevelColor(kind: FibStudy["kind"], ratio: number) {
  if (kind === "extension") return ratio === 0 ? "#8b8fa3" : ratio >= 2 ? "#e879f9" : ratio >= 1.272 ? "#c084fc" : "#a78bfa";
  if (ratio === 0 || ratio === 1) return "#8b8fa3";
  if (ratio >= 0.618 && ratio <= 0.786) return "#f59e0b";
  return ratio === 0.5 ? "#38bdf8" : "#2dd4bf";
}

const pct = (ratio: number) => `${Number((ratio * 100).toFixed(1))}%`;

function toReplayBars(bars: readonly FibBar[]): ReplayBar[] {
  return bars
    .filter((bar) => [bar.t, bar.o, bar.h, bar.l, bar.c].every(Number.isFinite))
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((bar) => ({ ...bar, knownAt: bar.knownAt ?? bar.t }) as ReplayBar);
}

export function computeChartFib(bars: readonly FibBar[], options: Partial<typeof FIB_DEFAULTS> = {}): ChartFib {
  const { depth, deviation } = { ...FIB_DEFAULTS, ...options };
  const replay = toReplayBars(bars);
  if (replay.length < depth + 2) return { retracement: null, extension: null };
  const retraceAnchors = retracementAnchors(zigzagPivots(replay, depth, deviation));
  const extendAnchors = extensionAnchors(replay, depth);
  const study = (kind: FibStudy["kind"], anchors: FibAnchors | null, ratios: number[], startIndex: number): FibStudy | null => {
    if (!anchors) return null;
    return {
      kind,
      anchors,
      startT: anchors.points[startIndex].t,
      levels: ratios.map((ratio) => ({
        ratio,
        price: fibPrice(anchors, ratio),
        label: `${kind === "retracement" ? "R" : "E"} ${pct(ratio)}`,
        color: fibLevelColor(kind, ratio),
      })),
    };
  };
  return {
    retracement: study("retracement", retraceAnchors, FIB_RETRACEMENT_RATIOS, 0),
    extension: study("extension", extendAnchors, FIB_EXTENSION_RATIOS, 2),
  };
}

export type FibVisibility = { retracement: boolean; extension: boolean };
// Checkboxes on every chart; retracement is ticked by default, extension is opt-in.
export const FIB_VISIBILITY_DEFAULT: FibVisibility = { retracement: true, extension: false };

/** Levels to draw for the current toggles; prices are included in the chart's y-range. */
export function visibleFibStudies(fib: ChartFib, show: FibVisibility): FibStudy[] {
  return [show.retracement ? fib.retracement : null, show.extension ? fib.extension : null].filter((study): study is FibStudy => !!study);
}
