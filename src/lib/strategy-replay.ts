export type StrategyReplayOrder = { id: string; runId: string; strategy: string; direction: string; placedAt: number; decisionAt: number | null; fillAt: number | null; entry: number; stop: number; fillPrice: number | null; tp1: number | null; tp2: number | null; tp3: number | null; pdType: string | null; zoneLow: number | null; zoneHigh: number | null };
export type StrategyReplayEvent = { id: string; at: number; direction: string; label: string; price: number };
export function strategyEvents(orders: StrategyReplayOrder[], cutoff: number): StrategyReplayEvent[] {
  return orders.flatMap(order => {
    if (![order.placedAt,order.entry].every(Number.isFinite) || order.decisionAt === null || !Number.isFinite(order.decisionAt) || order.decisionAt > order.placedAt || order.placedAt > cutoff) return [];
    const events = [{ id: `${order.runId}:${order.id}:placed`, at: order.placedAt, direction: order.direction, label: `${order.strategy} ${order.direction} limit placed`, price: order.entry }];
    if (order.fillAt !== null && order.fillPrice !== null && Number.isFinite(order.fillPrice) && Number.isFinite(order.fillAt) && order.fillAt > order.decisionAt && order.fillAt >= order.placedAt && order.fillAt <= cutoff) events.push({ id: `${order.runId}:${order.id}:fill`, at: order.fillAt, direction: order.direction, label: `${order.strategy} ${order.direction} historical fill`, price: order.fillPrice });
    return events;
  }).sort((a,b)=>a.at-b.at);
}
