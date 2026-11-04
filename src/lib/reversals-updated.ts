export type ReversalLane = "history" | "paper" | "practice";
/** Preserve recorded thresholds/details, including paper validation reason arrays. */
export function reversalDecisionReason(row: { state: string; reason: string | null }): string {
  let reason = row.reason?.trim() ?? "";
  if (reason.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(reason);
      if (Array.isArray(parsed)) reason = [...new Set(parsed.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean))].join("; ");
    } catch { /* Keep malformed stored text visible rather than discarding evidence. */ }
  }
  return reason || (/skip/i.test(row.state) ? "No skip reason was recorded." : "No decision / exit reason was recorded.");
}
export type ReversalCostMode = "gross" | "bps" | "reconstructed";
export type ReversalFilters = { lane: ReversalLane; market: "us" | "forex"; tf: "1h" | "30m" | "1d"; symbol: string; start: string; end: string; costBps: number; costMode: ReversalCostMode; spread: number; commissionBps: number; slippageBps: number; financingBpsPerDay: number; page: number };
export type ReversalRow = {
  id: string; ticker: string; direction: string; state: string; entry_at: string; exit_at: string | null;
  entry: number | null; stop: number | null; target: number | null; exit_price: number | null; r: number | null; risk_pct: number | null;
  decision_at: string | null; fill_at: string | null; observed_at: string | null; policy: string | null;
  validation: string | null; reason: string | null; financing: number | null; realized_pl: number | null;
  planned_rr: number | null; evidence?: Record<string, unknown>;
  held_days?: number | null; cost_r?: number | null; display_r?: number | null;
};
export type ReversalMetrics = { total: number; closed: number; wins: number; losses: number; open: number; unverified: number; invalid: number; excluded: number; other: number; avg_r: number | null; sum_r: number | null; avg_loss: number | null; worst_r: number | null; tail_count: number; sensitivity_r: number | null; sensitivity_n: number; latest: string | null; adjusted_n: number; adjusted_wins: number; adjusted_losses: number; adjusted_avg_r: number | null; adjusted_sum_r: number | null; adjusted_avg_loss: number | null; adjusted_worst_r: number | null; adjusted_tail_count: number; avg_cost_r: number | null };
export type ReversalPayload = {
  ok: boolean; error?: string; generated_at: string; filters: ReversalFilters; available: boolean;
  run: { run_id: string; data_start: string; data_end: string; created_at: string; timeframe: string } | null;
  metrics: ReversalMetrics; yearly: { year: string; n: number; avg_r: number | null; sensitivity_r: number | null; adjusted_avg_r: number | null; adjusted_n: number }[];
  policies: { policy: string; n: number }[]; reasons: { reason: string; n: number }[];
  symbols: string[]; rows: ReversalRow[]; row_count: number; page_size: number;
};
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export function parseReversalFilters(params: URLSearchParams): ReversalFilters {
  const lane = params.get("lane") ?? "history", market = params.get("market") ?? "us", tf = params.get("tf") ?? "1h";
  const start = params.get("start") ?? "", end = params.get("end") ?? "", symbol = (params.get("symbol") ?? "").trim().toUpperCase();
  const costBps = Number(params.get("costBps") ?? 0), page = Number(params.get("page") ?? 1);
  const costMode = params.get("costMode") ?? "gross";
  const spread = Number(params.get("spread") ?? 1.5), commissionBps = Number(params.get("commissionBps") ?? 0);
  const slippageBps = Number(params.get("slippageBps") ?? 0), financingBpsPerDay = Number(params.get("financingBpsPerDay") ?? 0);
  if (!["history", "paper", "practice"].includes(lane) || !["us", "forex"].includes(market) || !["1h", "30m", "1d"].includes(tf)) throw new Error("Invalid dataset, market or timeframe.");
  if ((start && !validDate(start)) || (end && !validDate(end)) || (start && end && start > end)) throw new Error("Choose a valid date range.");
  if (symbol && !/^\^?[A-Z0-9.=-]{1,20}$/.test(symbol)) throw new Error("Invalid ticker.");
  if (!Number.isFinite(costBps) || costBps < 0 || costBps > 1000 || !Number.isInteger(page) || page < 1) throw new Error("Invalid cost assumption or page.");
  if (!["gross", "bps", "reconstructed"].includes(costMode) || [spread, commissionBps, slippageBps, financingBpsPerDay].some(v => !Number.isFinite(v) || v < 0 || v > 1000)) throw new Error("Invalid cost model assumptions.");
  if (lane === "practice" && costMode !== "gross") throw new Error("Practice fills already embed bid/ask spread. Use the recorded broker fields; no estimated costs are added again.");
  return { lane: lane as ReversalLane, market: market as "us" | "forex", tf: tf as ReversalFilters["tf"], start, end, symbol, costBps, costMode: costMode as ReversalCostMode, spread, commissionBps, slippageBps, financingBpsPerDay, page };
}
export function estimateReversalCost(row: { entry: number | null; stop: number | null; risk_pct: number | null; held_days?: number | null; ticker: string }, filters: ReversalFilters): number | null {
  if (filters.costMode === "gross") return 0;
  if (row.risk_pct === null || !Number.isFinite(row.risk_pct) || row.risk_pct <= 0) return null;
  if (filters.costMode === "bps") return costInR(row.risk_pct, filters.costBps);
  if (row.entry === null || row.stop === null || !Number.isFinite(row.entry) || !Number.isFinite(row.stop) || Math.abs(row.entry - row.stop) === 0) return null;
  if (filters.financingBpsPerDay > 0 && (row.held_days == null || !Number.isFinite(row.held_days) || row.held_days < 0)) return null;
  const spreadR = filters.market === "forex" ? filters.spread * (row.ticker.replace(/^\^/, "").endsWith("JPY") ? 0.01 : 0.0001) / Math.abs(row.entry - row.stop) : filters.spread / (row.risk_pct * 100);
  return spreadR + (filters.commissionBps + filters.slippageBps + filters.financingBpsPerDay * (row.held_days ?? 0)) / (row.risk_pct * 100);
}
export function costInR(riskPct: number | null, roundTripBps: number): number | null {
  return riskPct !== null && Number.isFinite(riskPct) && riskPct > 0 ? roundTripBps / (riskPct * 100) : null;
}
export function fmtR(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : `${Number(value) > 0 ? "+" : ""}${Number(value).toFixed(digits)}R`;
}
