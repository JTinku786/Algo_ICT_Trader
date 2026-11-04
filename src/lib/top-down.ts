import { confirmedSwingPath, type ReplayBar } from "./weekly-replay";
export function completedMonthlyBars(daily: ReplayBar[], day: string, invalid: string[] = []) {
  const groups = new Map<string, ReplayBar[]>();
  for (const b of daily) {
    const key = b.day.slice(0, 7);
    if (key >= day.slice(0, 7) || invalid.some(d => d.slice(0, 7) === key)) continue;
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  return [...groups].map(([key, bars]) => ({ ...bars[0], day: `${key}-01`, h: Math.max(...bars.map(b => b.h)), l: Math.min(...bars.map(b => b.l)), c: bars.at(-1)!.c, v: bars.reduce((n,b)=>n+(b.v??0),0), knownAt: bars.at(-1)!.knownAt }));
}
export function topDownStructure(bars: ReplayBar[], frame: Parameters<typeof confirmedSwingPath>[1], invalid: string[]) {
  const pivots = confirmedSwingPath(bars, frame, invalid);
  const highs = pivots.filter(p => p.kind === "HIGH"), lows = pivots.filter(p => p.kind === "LOW");
  if (highs.length < 2 || lows.length < 2) return { direction: "UNKNOWN", text: "Waiting for two confirmed highs and lows" };
  const hh = highs.at(-1)!.price > highs.at(-2)!.price, hl = lows.at(-1)!.price > lows.at(-2)!.price;
  const lh = highs.at(-1)!.price < highs.at(-2)!.price, ll = lows.at(-1)!.price < lows.at(-2)!.price;
  return hh && hl ? { direction: "BUY", text: "Higher highs / higher lows" } : lh && ll ? { direction: "SELL", text: "Lower highs / lower lows" } : { direction: "MIXED", text: "Mixed, equal or expanding swings" };
}
