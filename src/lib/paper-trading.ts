import type { ReplayBar } from "./weekly-replay";
export type PaperTrade = { id: string; symbol: string; frame: string; direction: "BUY" | "SELL"; entry: number; stop: number; target: number; quantity: number; placedAt: number; closedAt?: number; closePrice?: number };
export function paperResult(trade: PaperTrade, bars: ReplayBar[]) {
  const sign = trade.direction === "BUY" ? 1 : -1;
  for (const bar of bars.filter(b => b.knownAt > trade.placedAt).sort((a,b)=>a.knownAt-b.knownAt)) {
    if (trade.closedAt !== undefined && bar.knownAt > trade.closedAt) break;
    const stop = sign === 1 ? bar.l <= trade.stop : bar.h >= trade.stop;
    const target = sign === 1 ? bar.h >= trade.target : bar.l <= trade.target;
    if (stop || target) {
      const level = stop ? trade.stop : trade.target;
      const price = stop ? sign === 1 ? Math.min(bar.o, level) : Math.max(bar.o, level) : level;
      return { status: stop && target ? "Stopped · ambiguous candle, stop first" : stop ? "Stopped" : "Target reached", price, at: bar.knownAt, pnl: (price-trade.entry)*sign*trade.quantity };
    }
  }
  const last=bars.at(-1);
  const manual=trade.closedAt !== undefined && last && trade.closedAt <= last.knownAt;
  const price=manual ? trade.closePrice! : last?.c ?? trade.entry;
  return { status: manual ? "Closed manually" : "Open", price, at: manual ? trade.closedAt! : last?.knownAt ?? trade.placedAt, pnl: (price-trade.entry)*sign*trade.quantity };
}
