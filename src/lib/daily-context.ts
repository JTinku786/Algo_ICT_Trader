import { confirmedSwingPath, deriveIctOverlays, weeklyReference, type ReplayBar, type ReplayData } from "./weekly-replay";

export const DAILY_CONTEXT_VERSION = "daily-context-local-v1";
export type ContextLabel = "Expansion" | "Retracement" | "Reversal" | "Consolidation";
export type ReferencePoint = {
  observedDay?: string;
  kind: string; low: number; high: number; knownAt: number; originDay: string;
  timing: "Before day" | "Confirmed at close"; response: string;
};
const sign = (n: number) => n > 0 ? 1 : n < 0 ? -1 : 0;
const intersects = (b: ReplayBar, low: number, high: number) => b.h >= low && b.l <= high;
function atr(bars: ReplayBar[]) {
  const values = bars.slice(-14).map((b, i, tail) => {
    const previous = i ? tail[i - 1] : bars[bars.length - tail.length - 1];
    return previous ? Math.max(b.h - b.l, Math.abs(b.h - previous.c), Math.abs(b.l - previous.c)) : b.h - b.l;
  });
  return values.length === 14 ? values.reduce((a, b) => a + b, 0) / 14 : null;
}
function response(b: ReplayBar, low: number, high: number) {
  return !intersects(b, low, high) ? "Not touched" : b.l <= low && b.h >= high ? "Entire price interval traded this day" : "Partial overlap this day";
}

/** End-of-day observations. Thresholds are explicit local adaptations, not source-certified entry rules. */
export function dailyContext(data: ReplayData, day: string, cadence: "1d" | "1w" = "1d") {
  const index = data.daily.findIndex(b => b.day === day);
  if (index < 0) return null;
  const b = data.daily[index], before = data.daily.slice(0, index), prefix = data.daily.slice(0, index + 1);
  const previous = before.at(-1), volatility = atr(before), path = confirmedSwingPath(before, cadence, data.invalidDailyDays);
  const weekly = cadence === "1d" ? weeklyReference(before, day, data.invalidDailyDays) : null;
  const zones = deriveIctOverlays(before, cadence, data.instrument.market, before);
  const newZones = deriveIctOverlays(prefix, cadence, data.instrument.market, prefix).filter(z => z.knownAt === b.knownAt);
  const pools: ReferencePoint[] = [];
  function pool(kind: string, price: number, knownAt: number, originDay: string, side: "HIGH" | "LOW") {
    const pierced = side === "HIGH" ? b.h > price : b.l < price;
    const rejected = pierced && (side === "HIGH" ? b.c < price : b.c > price);
    pools.push({ observedDay: day, kind, low: price, high: price, knownAt, originDay, timing: "Before day", response: rejected ? "Stop-run candidate: pierced, closed back inside" : pierced ? "Pierced; no close back inside" : (side === "HIGH" ? b.h === price : b.l === price) ? "Equal-price touch; no sweep" : "Not touched" });
  }
  if (previous) { pool(cadence === "1w" ? "Old high · previous week · buy stops / buy-side open float" : "Old high · previous day · buy stops / buy-side open float", previous.h, previous.knownAt, previous.day, "HIGH"); pool(cadence === "1w" ? "Old low · previous week · sell stops / sell-side open float" : "Old low · previous day · sell stops / sell-side open float", previous.l, previous.knownAt, previous.day, "LOW"); }
  if (weekly) { pool("Old high · previous week · buy stops / buy-side open float", weekly.high, before.find(x => x.day === weekly.last)!.knownAt, weekly.last, "HIGH"); pool("Old low · previous week · sell stops / sell-side open float", weekly.low, before.find(x => x.day === weekly.last)!.knownAt, weekly.last, "LOW"); }
  for (const s of path.filter(s => !before.some(x => x.knownAt > s.knownAt && (s.kind === "HIGH" ? x.h >= s.price : x.l <= s.price)))) pool(s.kind === "HIGH" ? "Clean swing high · buy-stop liquidity pool" : "Clean swing low · sell-stop liquidity pool", s.price, s.knownAt, s.day, s.kind);
  for (const z of zones.filter(z => ["EQH", "EQL"].includes(z.kind) && z.status !== "SWEPT")) pool(z.kind === "EQH" ? "Clean highs · buy-stop liquidity pool (EQH)" : "Clean lows · sell-stop liquidity pool (EQL)", z.high, z.knownAt, z.originDay, z.kind === "EQH" ? "HIGH" : "LOW");
  for (const swing of confirmedSwingPath(prefix, cadence, data.invalidDailyDays).filter(s => s.knownAt === b.knownAt)) {
    pools.push({ observedDay: day, kind: swing.kind === "HIGH" ? "Clean swing high · buy-stop liquidity pool" : "Clean swing low · sell-stop liquidity pool", low: swing.price, high: swing.price, knownAt: swing.knownAt, originDay: swing.day, timing: "Confirmed at close", response: "New three-bar swing confirmed at this close; usable afterwards" });
  }
  for (const z of newZones.filter(z => ["EQH", "EQL"].includes(z.kind))) pools.push({ observedDay: day, kind: z.kind === "EQH" ? "Clean highs · buy-stop liquidity pool (EQH)" : "Clean lows · sell-stop liquidity pool (EQL)", low: z.low, high: z.high, knownAt: z.knownAt, originDay: z.originDay, timing: "Confirmed at close", response: "Equal-price pool newly confirmed at this close" });
  const point = (z: typeof zones[number], timing: ReferencePoint["timing"]): ReferencePoint => ({ kind: `${z.kind} ${z.direction}`, low: z.low, high: z.high, knownAt: z.knownAt, originDay: z.originDay, timing, response: timing === "Confirmed at close" ? "New at this close; usable only afterwards" : response(b, z.low, z.high) });
  const orderblocks = [...zones.filter(z => z.kind === "OB" && z.status !== "SWEPT").map(z => point(z, "Before day")), ...newZones.filter(z => z.kind === "OB").map(z => point(z, "Confirmed at close"))];
  const gaps = [...zones.filter(z => ["FVG", "IFVG"].includes(z.kind) && z.status !== "SWEPT").map(z => point(z, "Before day")), ...newZones.filter(z => z.kind === "FVG").map(z => point(z, "Confirmed at close"))];
  // A broad one-way delivery candidate is kept distinct from a three-bar FVG.
  // OHLC cannot establish actual thin trading or institutional order flow.
  const voids: ReferencePoint[] = [];
  function covered(bars: ReplayBar[], low: number, high: number) {
    const intervals = bars.filter(x => intersects(x, low, high)).map(x => [Math.max(low, x.l), Math.min(high, x.h)]).sort((a,b) => a[0]-b[0]);
    let cursor = low;
    for (const [from, to] of intervals) { if (from > cursor) return false; cursor = Math.max(cursor, to); if (cursor >= high) return true; }
    return false;
  }
  for (let j = Math.max(14, index - 60); j <= index; j++) {
    const candidates: ReferencePoint[] = [];
    for (const length of [1, 2, 3]) {
      const start = j - length + 1, impulse = prefix.slice(start, j + 1), baseline = atr(prefix.slice(0, start));
      if (!baseline || impulse.length !== length || data.invalidDailyDays.some(d => d >= (prefix[Math.max(0,start-15)]?.day ?? "") && d <= prefix[j].day)) continue;
      const direction = sign(impulse[0].c - impulse[0].o);
      const move = Math.abs(impulse.at(-1)!.c - impulse[0].o), width = Math.max(...impulse.map(x => x.h)) - Math.min(...impulse.map(x => x.l));
      if (!direction || !impulse.every(x => sign(x.c - x.o) === direction) || move < 2 * baseline || !width || move / width < .8) continue;
      const low = Math.min(impulse[0].o, impulse.at(-1)!.c), high = Math.max(impulse[0].o, impulse.at(-1)!.c);
      const later = before.slice(j + 1);
      if (covered(later,low,high)) continue;
      candidates.push({ kind: `Sharp run · liquidity void candidate ${direction > 0 ? "BUY" : "SELL"}`, low, high, knownAt: impulse.at(-1)!.knownAt, originDay: impulse[0].day, timing: j === index ? "Confirmed at close" : "Before day", response: j === index ? "New at this close; not an earlier entry reference" : covered([...later,b],low,high) ? "Liquidity void filled in: accumulated candle-range coverage" : response(b, low, high) });
    }
    const broadest = candidates.sort((a,b) => (b.high-b.low)-(a.high-a.low))[0];
    if (broadest) voids.push(broadest);
  }
  const equilibrium: ReferencePoint[] = [];
  if (previous) equilibrium.push({ kind: cadence === "1w" ? "Previous week equilibrium" : "Previous day equilibrium", low: (previous.h + previous.l) / 2, high: (previous.h + previous.l) / 2, knownAt: previous.knownAt, originDay: previous.day, timing: "Before day", response: response(b, (previous.h + previous.l) / 2, (previous.h + previous.l) / 2) });
  if (weekly) equilibrium.push({ kind: "Previous week equilibrium", low: weekly.midpoint, high: weekly.midpoint, knownAt: before.find(x => x.day === weekly.last)!.knownAt, originDay: weekly.last, timing: "Before day", response: response(b, weekly.midpoint, weekly.midpoint) });
  const recent = prefix.slice(-4), previousTrend = before.length >= 4 ? sign(before.at(-1)!.c - before.at(-4)!.c) : 0;
  const body = Math.abs(b.c - b.o), direction = sign(b.c - b.o);
  const gap = previous ? data.invalidDailyDays.some(d => d > previous.day && d <= day) : false;
  const baselineInvalid = before.length >= 14 && data.invalidDailyDays.some(d => d >= (before.at(-15)?.day ?? before.at(-14)!.day) && d <= day);
  const ready = !!previous && !!volatility && !gap && !baselineInvalid;
  const stopRun = pools.some(p => p.response.startsWith("Stop-run"));
  const reversal = ready && previousTrend !== 0 && direction === -previousTrend && (previousTrend > 0 ? b.c < previous!.l || b.h > previous!.h && b.c < previous!.c : b.c > previous!.h || b.l < previous!.l && b.c > previous!.c);
  const expansion = ready && body >= volatility! && (direction > 0 ? b.c > previous!.h : direction < 0 && b.c < previous!.l);
  const retracement = ready && previousTrend !== 0 && direction === -previousTrend && b.c >= previous!.l && b.c <= previous!.h && intersects(b, previous!.l, previous!.h);
  const totalRange = recent.length === 4 ? Math.max(...recent.map(x => x.h)) - Math.min(...recent.map(x => x.l)) : null;
  const efficiency = totalRange ? Math.abs(recent.at(-1)!.c - recent[0].o) / totalRange : null;
  const consolidation = ready && totalRange !== null && efficiency !== null && totalRange <= 2 * volatility! && efficiency <= .35;
  const states: { label: ContextLabel; matched: boolean; evidence: string }[] = [
    { label: "Expansion", matched: !!expansion, evidence: `Body ${body.toFixed(2)}; prior ATR14 ${volatility?.toFixed(2) ?? "unavailable"}; requires body ≥ ATR and directional close beyond previous bar’s wick range.` },
    { label: "Retracement", matched: !!retracement, evidence: `Prior 3-bar close direction ${previousTrend > 0 ? "up" : previousTrend < 0 ? "down" : "flat/insufficient"}; requires opposite body and close inside previous bar’s range.` },
    { label: "Reversal", matched: !!reversal, evidence: `Requires body opposite prior 3-bar direction and either close beyond opposite previous-bar wick or previous-bar sweep/rejection closing beyond prior close. ${stopRun ? "A known liquidity level also had a stop-run candidate." : "No detected stop-run candidate."}` },
    { label: "Consolidation", matched: !!consolidation, evidence: `Last 4-bar range ${totalRange?.toFixed(2) ?? "unavailable"}; efficiency ${efficiency?.toFixed(2) ?? "unavailable"}; requires range ≤ 2 × prior ATR14 and efficiency ≤ 0.35.` },
  ];
  const primary = !ready ? "Insufficient valid context" : reversal ? "Reversal" : expansion ? "Expansion" : retracement ? "Retracement" : consolidation ? "Consolidation" : "Unclassified / mixed";
  return { version: DAILY_CONTEXT_VERSION, day, knownAt: b.knownAt, candle: b, primary, ready, states: states.map(s => ({ ...s, status: !ready ? "UNKNOWN" : s.matched ? "MATCH" : "NO_MATCH" })), orderblocks, gaps, voids, pools, equilibrium, invalidContext: gap || baselineInvalid };
}

export function defaultContextReferences(context: NonNullable<ReturnType<typeof dailyContext>>) {
  const nearestPools = ["high", "low"].flatMap(side => {
    const candidate = context.pools.filter(p => p.kind.includes("Clean") && p.kind.includes(side)).sort((a,b) => b.knownAt-a.knownAt)[0];
    return candidate ? [candidate] : [];
  });
  const points = [...context.orderblocks, ...context.gaps, ...context.voids, ...context.pools].filter(p => p.response !== "Not touched" || p.kind.includes("previous day") || p.kind.includes("previous week"));
  return [...new Map([...points, ...nearestPools, ...context.equilibrium].map(p => [`${p.kind}:${p.knownAt}:${p.low}:${p.high}`,p])).values()];
}
