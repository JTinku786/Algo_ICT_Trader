export type Candle = { t: number; day: string; minute: number; o: number; h: number; l: number; c: number };
export const frames = ["1d", "1h", "30m", "15m", "5m"] as const;
export type Frame = typeof frames[number];
export type Bars = Record<Frame, Candle[]>;
export const DAILY_BIAS_VERSION = "2026-09-30-v2";
export const instruments = [
  { name: "EURUSD", symbol: "^EURUSD", market: "forex", zone: "America/New_York" },
  { name: "AAPL", symbol: "AAPL", market: "us", zone: "America/New_York" },
  { name: "AXP", symbol: "AXP", market: "us", zone: "America/New_York" },
  { name: "Nifty", symbol: "%5ENSEI", market: "india", zone: "Asia/Kolkata" },
  { name: "BankNifty", symbol: "%5ENSEBANK", market: "india", zone: "Asia/Kolkata" },
  { name: "SPY", symbol: "SPY", market: "us", zone: "America/New_York" },
  { name: "QQQ", symbol: "QQQ", market: "us", zone: "America/New_York" },
  { name: "RELIANCE", symbol: "RELIANCE.NS", market: "india", zone: "Asia/Kolkata" },
  { name: "TCS", symbol: "TCS.NS", market: "india", zone: "Asia/Kolkata" },
];
export const concepts = ["Previous day", "Previous week", "Swing / next day"];
type Bias = { direction: number; target: number; reason: string };
export type Observation = { symbol: string; concept: string; day: string; direction: string; reason: string; signalDay: string; previousHigh: number; previousLow: number; dayOpen: number; dayClose: number; target: number; hit: boolean; closeBeyondDraw: boolean; candleAligned: boolean; status: string; entry?: number; stop?: number; exit?: number; entryTime?: string; exitTime?: string; knownAt?: string; r?: number; ambiguous?: boolean };
export function evaluateDailyOutcome(today: Candle, target: number, direction: number) {
  return {
    hit: direction > 0 ? today.h >= target : today.l <= target,
    closeBeyondDraw: direction * (today.c - target) > 0,
    candleAligned: direction * (today.c - today.o) > 0,
  };
}
function week(day: string) { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); }
function classify(b: Candle, high: number, low: number): Bias | null {
  if (b.c > high) return { direction: 1, target: b.h, reason: "Close above reference high: continuation" };
  if (b.c < low) return { direction: -1, target: b.l, reason: "Close below reference low: continuation" };
  const up = b.h > high && b.c < high, down = b.l < low && b.c > low;
  if (up === down) return null;
  return down ? { direction: 1, target: b.h, reason: "Low swept, close back above: reversal" } : { direction: -1, target: b.l, reason: "High swept, close back below: reversal" };
}
// Pivots require two completed candles on each side. Swept pivots are retired.
function swingBias(d: Candle[], i: number): Bias | null {
  const highs: number[] = [], lows: number[] = [];
  for (let j = Math.max(2, i - 60); j <= i - 3; j++) {
    const neighbors = [d[j - 2], d[j - 1], d[j + 1], d[j + 2]];
    if (neighbors.every(b => b.h < d[j].h) && !d.slice(j + 3, i - 1).some(b => b.h > d[j].h)) highs.push(d[j].h);
    if (neighbors.every(b => b.l > d[j].l) && !d.slice(j + 3, i - 1).some(b => b.l < d[j].l)) lows.push(d[j].l);
  }
  const b = d[i - 1], high = highs.at(-1), low = lows.at(-1);
  const up = high !== undefined && b.h > high && b.c < high;
  const down = low !== undefined && b.l < low && b.c > low;
  if (up === down) return null;
  const direction = down ? 1 : -1;
  const targets = (down ? highs : lows).filter(v => direction * (v - b.c) > 0).sort((a, z) => direction * (a - z));
  return { direction, target: targets[0] ?? (down ? b.h : b.l), reason: "Confirmed daily swing swept and rejected; opposite unswept swing or prior-day extreme" };
}
export function fvg(bars: Candle[], index: number, direction: number, minutes: number, adjacent?: (a: Candle, b: Candle) => boolean) {
  if (index < 2) return null;
  const a = bars[index - 2], b = bars[index - 1], c = bars[index];
  // Consecutive trading candles may straddle a scheduled session break, but
  // may not jump over a missing candle while the market is open.
  const consecutive = adjacent ?? ((x: Candle, y: Candle) => y.t - x.t === minutes * 60_000);
  if (!consecutive(a, b) || !consecutive(b, c)) return null;
  if (direction > 0 && c.l > a.h && b.c > b.o) return { low: a.h, high: c.l };
  if (direction < 0 && c.h < a.l && b.c < b.o) return { low: c.h, high: a.l };
  return null;
}
const duration = { "1h": 60, "30m": 30, "15m": 15, "5m": 5 };
export function replayLimit(bars: Candle[], signalIndex: number, direction: number, entry: number, stop: number, target: number, draw: number) {
  const result: { status: string; entryTime?: string; exitTime?: string; exit?: number; r?: number; ambiguous?: boolean } = { status: "UNFILLED" };
  const risk = direction * (entry - stop);
  if (risk <= 0) throw new Error("Invalid entry/stop geometry");
  for (let m = signalIndex + 1; m <= Math.min(signalIndex + 6, bars.length - 1); m++) {
    const b = bars[m];
    // A favorable gap makes a limit marketable at the open. Use the limit price
    // conservatively, even when that opening price would offer price improvement.
    const marketable = direction * (b.o - entry) <= 0;
    const fill = marketable || (b.l <= entry && b.h >= entry);
    if (!fill) {
      if (direction > 0 ? b.h >= draw : b.l <= draw) result.status = "DRAW_REACHED_BEFORE_FILL";
      if (result.status !== "UNFILLED") break;
      continue;
    }
    result.entryTime = new Date(b.t).toISOString();
    result.status = "EOD";
    for (let e = m; e < bars.length; e++) {
      const x = bars[e];
      const sl = direction > 0 ? x.l <= stop : x.h >= stop;
      const tp = direction > 0 ? x.h >= target : x.l <= target;
      // For a marketable opening fill, the entire subsequent candle is eligible.
      // For a touched limit, intrabar order is unknown: stop-first and no fill-bar TP.
      if (sl || (tp && (e > m || marketable))) {
        result.ambiguous = sl && tp;
        result.status = sl ? "SL" : "TP";
        result.exit = sl ? (direction > 0 ? Math.min(stop, x.o) : Math.max(stop, x.o)) : target;
        result.exitTime = new Date(x.t).toISOString();
        break;
      }
      if (e === m && tp) result.ambiguous = true;
    }
    if (result.exit === undefined) {
      result.exit = bars.at(-1)!.c;
      result.exitTime = new Date(bars.at(-1)!.t + 300_000).toISOString();
    }
    result.r = direction * (result.exit - entry) / risk;
    break;
  }
  return result;
}
export function analyze(instrument: typeof instruments[number], bars: Bars, start = "2026-01-01", end = "2026-09-30", invalidDailyDays: string[] = []) {
  const rows: Observation[] = [], d = bars["1d"];
  const open = instrument.market === "india" ? 555 : instrument.market === "us" ? 570 : 0;
  const close = instrument.market === "india" ? 930 : instrument.market === "us" ? 960 : 1440;
  const session = (b: Candle) => b.minute >= open && b.minute < close;
  const completedAt = (b: Candle, f: Exclude<Frame, "1d">) => b.t + Math.min(duration[f], close - b.minute) * 60_000;
  const dailyIndex = new Map(d.map((b, i) => [b.day, i]));
  const adjacent = (f: Exclude<Frame, "1d">) => (a: Candle, b: Candle) => {
    if (a.day === b.day || instrument.market === "forex") return b.t - a.t === duration[f] * 60_000;
    return a.minute === open + (Math.ceil((close - open) / duration[f]) - 1) * duration[f]
      && b.minute === open && dailyIndex.has(a.day) && dailyIndex.get(b.day) === dailyIndex.get(a.day)! + 1
      && !invalidDailyDays.some(day => day >= a.day && day <= b.day);
  };
  const byDay = Object.fromEntries(frames.filter(f => f !== "1d").map(f => {
    const map = new Map<string, Candle[]>();
    for (const b of bars[f].filter(session)) { const list = map.get(b.day) ?? []; list.push(b); map.set(b.day, list); }
    return [f, map];
  })) as Record<Exclude<Frame, "1d">, Map<string, Candle[]>>;
  let neutral = 0, incomplete = 0, invalidDailyContext = 0;
  for (let i = 2; i < d.length; i++) {
    const today = d[i], prev = d[i - 1];
    if (today.day < start || today.day >= end) continue;
    if (invalidDailyDays.some(day => day >= d[i - 2].day && day <= today.day)) { invalidDailyContext++; continue; }
    const previousWeek = d.slice(0, i - 1).filter(b => week(b.day) < week(prev.day));
    const key = previousWeek.at(-1) && week(previousWeek.at(-1)!.day);
    const wb = previousWeek.filter(b => week(b.day) === key);
    const weekly = wb.length ? classify(prev, Math.max(...wb.map(b => b.h)), Math.min(...wb.map(b => b.l))) : null;
    if (weekly && weekly.reason.includes("reversal")) weekly.target = weekly.direction > 0 ? Math.max(...wb.map(b => b.h)) : Math.min(...wb.map(b => b.l));
    const biases = [classify(prev, d[i - 2].h, d[i - 2].l), weekly, swingBias(d, i)];
    const intraday = byDay["5m"].get(today.day) ?? [];
    const complete = (["1h", "30m", "15m", "5m"] as const).every(f => {
      const list = byDay[f].get(today.day) ?? [];
      return list.length === Math.ceil((close - open) / duration[f]) && list.every((b, n) => b.minute === open + n * duration[f]);
    });
    if (!complete) incomplete++;
    biases.forEach((bias, k) => {
      if (!bias) { neutral++; return; }
      const row: Observation = { symbol: instrument.name, concept: concepts[k], day: today.day, signalDay: prev.day, previousHigh: prev.h, previousLow: prev.l, dayOpen: today.o, dayClose: today.c, direction: bias.direction > 0 ? "BUY" : "SELL", target: bias.target, reason: bias.reason, ...evaluateDailyOutcome(today, bias.target, bias.direction), status: complete ? "NO_SETUP" : "INCOMPLETE_SESSION" };
      rows.push(row);
      if (!complete) return;
      for (let n = 2; n < intraday.length - 2; n++) {
        const c = intraday[n], zone = fvg(intraday, n, bias.direction, 5);
        // Equity morning adaptation; FX London + New York windows in ET.
        const window = instrument.market === "forex" ? (c.minute >= 120 && c.minute < 300) || (c.minute >= 420 && c.minute < 600) : c.minute < open + 150;
        if (!zone || !window) continue;
        const known = c.t + 300_000;
        const context = (["1h", "30m", "15m"] as const).map(f => {
          const list = bars[f].filter(session); let found = false;
          for (let j = list.length - 1; j >= 2; j--) {
            const b = list[j];
            if (completedAt(b, f) > known || known - b.t > 5 * 86400_000) continue;
            const z = fvg(list, j, bias.direction, duration[f], adjacent(f));
            if (z && c.l <= z.high && c.h >= z.low && !list.slice(j + 1).some(x => completedAt(x, f) <= known && (bias.direction > 0 ? x.c < z.low : x.c > z.high))) { found = true; break; }
          }
          return found;
        });
        if (!context.every(Boolean)) continue;
        const entry = (zone.low + zone.high) / 2;
        const stop = bias.direction > 0 ? Math.min(...intraday.slice(Math.max(0, n - 5), n + 1).map(b => b.l)) : Math.max(...intraday.slice(Math.max(0, n - 5), n + 1).map(b => b.h));
        const risk = bias.direction * (entry - stop), room = bias.direction * (bias.target - entry);
        if (risk <= 0 || room < 2 * risk || intraday.slice(0, n + 1).some(b => bias.direction > 0 ? b.h >= bias.target : b.l <= bias.target)) continue;
        const target = entry + bias.direction * 2 * risk;
        row.status = "UNFILLED"; row.entry = entry; row.stop = stop; row.knownAt = new Date(known).toISOString();
        Object.assign(row, replayLimit(intraday, n, bias.direction, entry, stop, target, bias.target));
        break; // One canonical setup per concept/symbol/day, no cherry-picking retries.
      }
    });
  }
  const summaries = concepts.map(concept => {
    const sample = rows.filter(r => r.concept === concept), trades = sample.filter(r => r.r !== undefined);
    let equity = 0, peak = 0, drawdown = 0;
    for (const t of trades) { equity += t.r!; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }
    const gains = trades.reduce((s, r) => s + Math.max(0, r.r!), 0), losses = trades.reduce((s, r) => s + Math.max(0, -r.r!), 0);
    return { symbol: instrument.name, concept, days: sample.length, drawHit: sample.filter(r => r.hit).length, closeBeyondDraw: sample.filter(r => r.closeBeyondDraw).length, candleAligned: sample.filter(r => r.candleAligned).length, trades: trades.length, wins: trades.filter(r => r.r! > 0).length, totalR: equity, expectancy: trades.length ? equity / trades.length : null, profitFactor: losses ? gains / losses : null, drawdown, ambiguous: trades.filter(r => r.ambiguous).length, netAt005R: equity - trades.length * 0.05, netAt010R: equity - trades.length * 0.1 };
  });
  const evaluated = d.filter((b, i) => i >= 2 && b.day >= start && b.day < end && !invalidDailyDays.some(day => day >= d[i - 2].day && day <= b.day));
  const baseline = { days: evaluated.length, bullishClose: evaluated.filter(b => b.c > b.o).length,
    previousHighHit: evaluated.filter(b => b.h >= d[d.indexOf(b)-1].h).length,
    previousLowHit: evaluated.filter(b => b.l <= d[d.indexOf(b)-1].l).length,
    closeAbovePreviousHigh: evaluated.filter(b => b.c > d[d.indexOf(b)-1].h).length,
    closeBelowPreviousLow: evaluated.filter(b => b.c < d[d.indexOf(b)-1].l).length };
  const monthly = [...new Set(rows.map(r => r.day.slice(0,7)))].flatMap(month => concepts.map(concept => {
    const sample = rows.filter(r => r.day.startsWith(month) && r.concept === concept);
    const trades = sample.filter(r => r.r !== undefined);
    return { month, concept, days: sample.length, hits: sample.filter(r => r.hit).length, closeBeyondDraw: sample.filter(r => r.closeBeyondDraw).length, candleAligned: sample.filter(r => r.candleAligned).length, trades: trades.length, totalR: trades.reduce((s,r) => s+r.r!,0) };
  }));
  return { instrument, baseline, monthly, coverage: frames.map(frame => ({ frame, count: bars[frame].length, first: bars[frame][0]?.day ?? null, last: bars[frame].at(-1)?.day ?? null })), neutral, incomplete, invalidDailyContext, rows, summaries };
}
