import type { IctOverlay } from "./weekly-replay";
import type { ReferencePoint } from "./daily-context";
import type { WickRejection } from "./wick-rejections";

export type PdLevel = { id: string; low: number; high: number; originDay: string; knownAt: number; kind: string };
export type PdRow = { label: string; levels: PdLevel[]; availability: string };
export type PdRange = { h: number; l: number; knownAt: number; day: string; highDay?: string; lowDay?: string };
/** Presentation hierarchy, not a price ranking or an entry qualification. */
export function pdArrays(range: PdRange | undefined, cutoff: number, zones: IctOverlay[], references: ReferencePoint[], wicks: WickRejection[] = []) {
  if (!range || range.knownAt > cutoff || range.h <= range.l) return null;
  const midpoint = (range.h + range.l) / 2;
  const active = zones.filter(z => z.knownAt <= cutoff && z.status !== "SWEPT");
  const rejections = wicks.filter(w => w.knownAt <= cutoff && w.status !== "INVALIDATED");
  const voids = references.filter(p => p.knownAt <= cutoff && /void/i.test(p.kind) && !/filled in|close through|entire price interval/i.test(p.response));
  function rows(side: "BUY" | "SELL"): PdRow[] {
    const inside = (p: { low: number; high: number }) => side === "SELL" ? p.low >= midpoint && p.high <= range!.h : p.low >= range!.l && p.high <= midpoint;
    const matching = (kind: IctOverlay["kind"][]) => active.filter(z => z.direction === side && kind.includes(z.kind) && inside(z));
    const row = (label: string, levels: PdLevel[], availability = "No active candidate in this half of the range"): PdRow => ({ label, levels: [...levels].sort((a,b) => b.knownAt-a.knownAt), availability });
    const oldPrice = side === "SELL" ? range!.h : range!.l;
    const ordered = [
      row(side === "SELL" ? "Old High / Low" : "Old Low / High", [{ id: `range-${side}`, low: oldPrice, high: oldPrice, originDay: (side === "SELL" ? range!.highDay : range!.lowDay) ?? range!.day, knownAt: range!.knownAt, kind: side === "SELL" ? "Old high" : "Old low" }]),
      row("Rejection Block", rejections.filter(w => w.direction === side && inside(w)).map(w => ({ ...w, kind: "Wick rejection candidate" })), "No eligible wick candidate; ICT rejection-block validation unavailable"),
      row(side === "SELL" ? "Bearish Orderblock" : "Bullish Orderblock", matching(["OB"])),
      row("Fair Value Gap", matching(["FVG", "IFVG"])),
      row("Liquidity Void", voids.filter(p => (side === "BUY" ? /BUY/.test(p.kind) : /SELL/.test(p.kind)) && inside(p)).map((p,i) => ({ ...p, id: `void-${side}-${i}` })), "No eligible source void candidate; void certification unavailable"),
      row(side === "SELL" ? "Bearish Breaker" : "Bullish Breaker", matching(["BREAKER"])),
      row("Mitigation Block", [], "Detector not implemented; no levels inferred from touched orderblocks"),
    ];
    return side === "SELL" ? ordered : ordered.reverse();
  }
  return { low: range.l, high: range.h, midpoint, originDay: range.day, knownAt: range.knownAt, premium: rows("SELL"), discount: rows("BUY"), straddling: active.filter(z => ["FVG","IFVG","OB","BREAKER"].includes(z.kind) && z.low < midpoint && z.high > midpoint).length };
}
