/** Candle-derived context only. Times are seconds; callers supply completed bars. */
export type ContextBar = { time: number; open: number; high: number; low: number; close: number };
export type ContextMark = { kind: string; label: string; low: number; high: number; time: number; end_time?: number; direction: "BUY" | "SELL" };
export function ictChartContext(bars: ContextBar[], step: number, timezone: string): ContextMark[] {
  const marks: ContextMark[] = [];
  const add = (kind: string, label: string, low: number, high: number, time: number, direction: "BUY" | "SELL") => marks.push({ kind, label, low, high, time, direction });
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1], b = bars[i];
    if (b.time - a.time !== step) continue;
    const ah = Math.max(a.open, a.close), al = Math.min(a.open, a.close), bh = Math.max(b.open, b.close), bl = Math.min(b.open, b.close);
    if (Math.max(a.low, b.low) <= Math.min(a.high, b.high)) {
      if (bl > ah) add("vi", "VI · bullish body imbalance", ah, bl, b.time + step, "BUY");
      if (bh < al) add("vi", "VI · bearish body imbalance", bh, al, b.time + step, "SELL");
    }
    if (i >= 2 && a.time - bars[i - 2].time === step) {
      const first = bars[i - 2];
      if (b.low > first.high && a.close > a.open) add("fvg", "BISI · bullish FVG inefficiency", first.high, b.low, b.time + step, "BUY");
      if (b.high < first.low && a.close < a.open) add("fvg", "SIBI · bearish FVG inefficiency", b.high, first.low, b.time + step, "SELL");
    }
  }
  const pivots: ContextMark[] = [];
  for (let i = 2; i + 2 < bars.length; i++) {
    const b = bars[i], neighbors = bars.slice(i - 2, i + 3).filter((_, j) => j !== 2);
    const known = bars[i + 2].time + step;
    for (const high of [true, false]) {
      const price = high ? b.high : b.low;
      if (!neighbors.every(n => high ? n.high < price : n.low > price)) continue;
      const kind = high ? "bsl" : "ssl";
      const previous = pivots.filter(p => p.kind === kind).at(-1);
      const tolerance = Math.max(...bars.slice(i - 2, i + 3).map(n => n.high - n.low)) * 0.1;
      if (previous && Math.abs(previous.low - price) <= tolerance && !bars.filter(n => n.time >= previous.time && n.time < known - step).some(n => high ? n.high > Math.max(previous.low, price) : n.low < Math.min(previous.low, price)))
        add(high ? "eqh" : "eql", high ? "EQH · equal highs" : "EQL · equal lows", price, price, known, high ? "SELL" : "BUY");
      const pivot: ContextMark = { kind, label: high ? "BSL · confirmed swing high" : "SSL · confirmed swing low", low: price, high: price, time: known, direction: high ? "SELL" : "BUY" };
      const rangeHigh = pivots.filter(p => p.kind === "bsl").at(-1)?.high;
      const rangeLow = pivots.filter(p => p.kind === "ssl").at(-1)?.low;
      if (rangeHigh !== undefined && rangeLow !== undefined && price > rangeLow && price < rangeHigh)
        pivot.label += " · IRL (prior swing range)";
      pivots.push(pivot); marks.push(pivot);
    }
  }
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const days = new Map<string, ContextBar[]>();
  for (const b of bars) { const key = date.format(new Date(b.time * 1000)); days.set(key, [...(days.get(key) ?? []), b]); }
  // A period is published only once a later observed period begins. First loaded
  // day/week is withheld because the fetched window may start mid-period.
  const periods = (weekly: boolean) => {
    const groups = new Map<string, ContextBar[]>();
    for (const [day, candles] of days) {
      const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
      const key = weekly ? d.toISOString().slice(0, 10) : day;
      groups.set(key, [...(groups.get(key) ?? []), ...candles]);
    }
    const entries = [...groups.values()];
    for (let i = 2; i < entries.length; i++) {
      const previous = entries[i - 1], current = entries[i];
      const time = current[0].time;
      add("period", weekly ? "PWH · previous observed week high" : "PDH · previous observed day high", Math.max(...previous.map(b => b.high)), Math.max(...previous.map(b => b.high)), time, "SELL");
      add("period", weekly ? "PWL · previous observed week low" : "PDL · previous observed day low", Math.min(...previous.map(b => b.low)), Math.min(...previous.map(b => b.low)), time, "BUY");
    }
  };
  if (step < 86400) { periods(false); periods(true); }
  for (const mark of marks) {
    const hit = bars.find(b => b.time >= mark.time && (mark.low === mark.high ? mark.direction === "BUY" ? b.low <= mark.low : b.high >= mark.high : mark.direction === "BUY" ? b.low <= mark.low : b.high >= mark.high));
    if (hit) mark.end_time = hit.time;
  }
  return marks;
}
