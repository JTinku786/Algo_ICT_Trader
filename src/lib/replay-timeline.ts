import type { Frame } from "./daily-bias";
import { completedWeeklyBars, type ReplayData } from "./weekly-replay";
export type ReplayFrame = Frame | "1w";
export function replayTimeline(data: Partial<Record<Frame, ReplayData>>, frame: ReplayFrame, through: string, from = "2026-01-01") {
  const daily = data["1d"];
  if (!daily) return [];
  const today = new Date(daily.generatedAt).toLocaleDateString("en-CA", {timeZone:daily.instrument.zone});
  const bars = frame === "1w" ? completedWeeklyBars(daily.daily, today, daily.invalidDailyDays).map(b => ({...b, day: daily.daily.find(d=>d.knownAt===b.knownAt)!.day})) : data[frame]?.bars ?? [];
  return bars.filter(b => b.day >= from && b.day <= through);
}
