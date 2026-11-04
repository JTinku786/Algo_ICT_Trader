export const riskBuckets = ["NEAREST", "0-1", "1-2", "2-3", "3-4", "4+"] as const;
export type RiskBucket = typeof riskBuckets[number];
export const riskBucketLabels: Record<RiskBucket, string> = {
  NEAREST: "Nearest liquidity", "0-1": "R:R 0 to 1", "1-2": "R:R 1 to 2",
  "2-3": "R:R 2 to 3", "3-4": "R:R 3 to 4", "4+": "R:R 4+",
};
export type LiquidityTarget = {
  id?: string; kind: string; tf: string; low: number; knownAt?: number; origin?: number;
};
type Plan = {
  state: string; direction: "BUY" | "SELL"; entry: number; stop: number;
  target: number | null; rr: number | null; targetSource: LiquidityTarget | null;
  targetCandidates?: LiquidityTarget[];
};
export function bucketContains(rr: number, bucket: RiskBucket): boolean {
  if (!Number.isFinite(rr) || rr <= 0) return false;
  if (bucket === "NEAREST") return true;
  if (bucket === "4+") return rr >= 4;
  const [lower, upper] = bucket.split("-").map(Number);
  return rr >= lower && rr < upper;
}
export function planForBucket<T extends Plan>(plan: T, bucket: RiskBucket): T {
  if (bucket === "NEAREST" || plan.state !== "READY") return plan;
  const sign = plan.direction === "BUY" ? 1 : -1;
  const risk = sign * (plan.entry - plan.stop);
  if (!(risk > 0)) return { ...plan, state: "INVALID_STOP", target: null, targetSource: null, rr: null };
  const candidates = plan.targetCandidates ?? (plan.targetSource ? [plan.targetSource] : []);
  const target = candidates
    .map(source => ({ source, rr: sign * (source.low - plan.entry) / risk }))
    .filter(candidate => bucketContains(candidate.rr, bucket))
    .sort((a, b) => a.rr - b.rr)[0];
  return { ...plan, state: target ? "READY" : "NO_TARGET_IN_BUCKET",
    target: target?.source.low ?? null, targetSource: target?.source ?? null, rr: target?.rr ?? null };
}
