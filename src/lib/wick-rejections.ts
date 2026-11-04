import { confirmedSwingPath, type ReplayBar } from "./weekly-replay";
export type WickRejection = { id: string; direction: "BUY" | "SELL"; low: number; high: number; origin: number; originDay: string; knownAt: number; confirmedDay: string; touches: number; status: "ACTIVE" | "RETESTED" | "INVALIDATED"; invalidatedAt: number | null };
/** Local swing-wick + subsequent departure candidate; not a source-certified entry model. */
export function wickRejections(bars: ReplayBar[], frame: "1w" | "1mo", invalidDays: string[] = []): WickRejection[] {
  const zones: WickRejection[] = [], tested = new Map<string, boolean>();
  for (let i = 2; i < bars.length; i++) {
    const bar = bars[i];
    for (const zone of zones) {
      if (zone.status === "INVALIDATED" || bar.knownAt <= zone.knownAt) continue;
      const touch = bar.h >= zone.low && bar.l <= zone.high;
      if (touch && !tested.get(zone.id)) zone.touches++;
      tested.set(zone.id, touch);
      if (touch) zone.status = "RETESTED";
      if (zone.direction === "BUY" ? bar.c < zone.low : bar.c > zone.high) { zone.status = "INVALIDATED"; zone.invalidatedAt = bar.knownAt; }
    }
    const prefix = bars.slice(0,i+1);
    const pivots = confirmedSwingPath(prefix,frame,invalidDays);
    for (const pivot of pivots) {
      const at = bars.findIndex(b => b.t === pivot.origin);
      // A completed right-hand candle establishes the swing, then departure must occur within 3 bars.
      if (at < 8 || i <= at || i > at+3) continue;
      const origin = bars[at], bodyLow = Math.min(origin.o,origin.c), bodyHigh = Math.max(origin.o,origin.c);
      const lower = pivot.kind === "LOW", low = lower ? origin.l : bodyHigh, high = lower ? bodyLow : origin.h;
      const wick = high-low, range = origin.h-origin.l, body = Math.abs(origin.c-origin.o);
      if (range <= 0 || wick < range*.25 || wick < body) continue;
      const history = bars.slice(Math.max(1,at-14),at);
      const atr = history.reduce((sum,b) => { const previous = bars[bars.findIndex(x=>x.t===b.t)-1]; return sum+Math.max(b.h-b.l,Math.abs(b.h-previous.c),Math.abs(b.l-previous.c)); },0)/history.length;
      const validSpan = !invalidDays.some(d => d >= history[0].day && d <= bar.day);
      if (!validSpan || !Number.isFinite(atr) || atr <= 0) continue;
      const serial = (day: string) => frame === "1mo" ? new Date(day).getUTCFullYear()*12+new Date(day).getUTCMonth() : Date.parse(day)/604800000;
      if (bars.slice(at,i+1).some((b,n,span) => n > 0 && Math.abs(serial(b.day)-serial(span[n-1].day)-1)>1e-6)) continue;
      const departure = lower ? bar.c > origin.h && bar.c-bodyLow >= atr*.5 : bar.c < origin.l && bodyHigh-bar.c >= atr*.5;
      if (!departure) continue;
      const id = `wick-${frame}-${pivot.origin}-${lower ? "BUY" : "SELL"}`;
      if (zones.some(z=>z.id===id)) continue;
      zones.push({ id, direction: lower ? "BUY" : "SELL", low, high, origin: origin.t, originDay: origin.day, knownAt: bar.knownAt, confirmedDay: bar.day, touches: 0, status: "ACTIVE", invalidatedAt: null });
    }
  }
  return zones;
}
