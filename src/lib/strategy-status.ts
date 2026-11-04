// Single source of truth for which strategies are Live / Paper / Archived.
// Both the Realtime Orders and Backtest tabs read from here so they cannot
// drift apart again. Market keys are lowercase, matching the DB `market` column.
export type StrategyStatus = "LIVE" | "PAPER_TRADING" | "BACKTESTING" | "ARCHIVED";
export type StrategyMarket = "us" | "india" | "forex";

export const STRATEGY_MARKETS: StrategyMarket[] = ["us", "india", "forex"];

export const STRATEGY_STATUS_OPTIONS: Array<{ value: StrategyStatus; label: string }> = [
  { value: "LIVE", label: "Live" },
  { value: "PAPER_TRADING", label: "Paper Trading" },
  { value: "BACKTESTING", label: "Backtesting" },
  { value: "ARCHIVED", label: "Archived" },
];

export const LIVE_STRATEGIES_BY_MARKET: Record<StrategyMarket, string[]> = {
  us: ["S03", "S-CH10", "S16"],
  india: ["S03", "S-CH08", "S16"],
  forex: ["IGS01V2_LondonLiqGrab_SweepReversal"],
};

export const REVERSAL_K1_STRATEGIES = ["1d","1h","30m"].map((tf)=>`REV-k1_reclaim3-OTE62-2R-TOUCH-${tf}`);

export const PAPER_STRATEGIES_BY_MARKET: Record<StrategyMarket, string[]> = {
  us: ["A03", "S21", "S29", "S33", "MSS-REVERSAL-D1-M5-CLOSE",...REVERSAL_K1_STRATEGIES, "Scalping_OB_OB_V4", "BPR_OB_V3", "IFVG_OB_V1"],
  india: [],
  forex: ["MSS-REVERSAL-D1-M5-CLOSE",...REVERSAL_K1_STRATEGIES],
};

export const ARCHIVED_STRATEGIES = new Set(["S-ICT-IPDA-PD-ARRAY-PREVIOUS-SWING-V4"]);

/** "ALL", "US", "us", "INDIA", "FOREX" ... -> market key, or null for all markets. */
export function strategyMarketKey(market: string | null | undefined): StrategyMarket | null {
  const key = (market || "").trim().toLowerCase();
  return (STRATEGY_MARKETS as string[]).includes(key) ? (key as StrategyMarket) : null;
}

function forMarket(table: Record<StrategyMarket, string[]>, market: string | null | undefined) {
  const key = strategyMarketKey(market);
  const ids = key ? table[key] : STRATEGY_MARKETS.flatMap((m) => table[m]);
  return [...new Set(ids)];
}

export const liveStrategyIds = (market?: string | null) => forMarket(LIVE_STRATEGIES_BY_MARKET, market);
export const paperStrategyIds = (market?: string | null) => forMarket(PAPER_STRATEGIES_BY_MARKET, market);

export function strategyStatusLabel(status: StrategyStatus) {
  return STRATEGY_STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status;
}

/** Short badge for a strategy in a given market: "Live", "Paper", "Archived" or "". */
export function strategyDeploymentBadge(id: string, market?: string | null) {
  if (ARCHIVED_STRATEGIES.has(id)) return "Archived";
  if (liveStrategyIds(market).includes(id)) return "Live";
  if (paperStrategyIds(market).includes(id)) return "Paper";
  return "";
}

// Compact labels for ids that are too long to read in a dropdown.
const SHORT_STRATEGY_LABELS: Record<string, string> = {
  "MSS-REVERSAL-D1-M5-CLOSE": "MSS reversal · Daily/5m close",
  IGS01V2_LondonLiqGrab_SweepReversal: "IGS01V2 · London Sweep Reversal",
  IGS02_Manipulation_MSS_IFVG: "IGS02 · NY Manipulation → MSS → FVG",
  IGS01_LondonLiqGrab_IFVG: "IGS01 · London Liq Grab IFVG",
};

export function shortStrategyLabel(id: string) {
  if (id.startsWith("REV-k1_reclaim3-OTE62-2R-TOUCH-")) return `k1_reclaim3 · ${id.split("-").at(-1)}`;
  return SHORT_STRATEGY_LABELS[id] ?? id;
}
