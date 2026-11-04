/**
 * Deep link from a trade (Backtest or Realtime) into the Market Structure Shift
 * tab. The MSS tab reads these query params once on load (symbol, tf1, tf2,
 * start, end, entry, dir) and focuses the investigation nearest the entry, so
 * both tabs open the same TF1 -> TF2 replay for the same trade.
 */
export type TradeMarket = "us" | "india" | "forex";

export type MssLinkTrade = {
  symbol: string;
  direction?: string | null;
  /** Fill time (or signal time) as an ISO string. */
  entryTs?: string | null;
  /** Market column when known; otherwise inferred from the symbol. */
  market?: string | null;
  tf1?: "1d" | "1h" | "30m" | "15m";
  tf2?: "1h" | "30m" | "15m" | "5m";
  candleSource?: "REVERSAL_K1";
};

export function tradeMarket(symbol: string | null | undefined, market?: string | null): TradeMarket {
  const m = (market ?? "").toLowerCase();
  if (m === "us" || m === "india" || m === "forex") return m;
  const s = (symbol ?? "").toUpperCase();
  if (s.endsWith(".NS") || s.endsWith(".BO") || s.startsWith("^NSE") || s === "^BSESN") return "india";
  if (s.endsWith("=X") || (/^\^?[A-Z]{6}$/.test(s) && !["^SPX", "^NDX"].includes(s))) return "forex";
  return "us";
}

export function exchangeTimeZone(market: TradeMarket): string {
  return market === "india" ? "Asia/Kolkata" : "America/New_York";
}

export function tradeSide(direction: string | null | undefined): "BUY" | "SELL" {
  return /^(S|SHORT|BEAR)/i.test((direction ?? "").trim()) ? "SELL" : "BUY";
}

export function mssDeepLink(trade: MssLinkTrade): { href: string; day: string; side: "BUY" | "SELL"; tf1: string; tf2: string } | null {
  const at = trade.entryTs ? Date.parse(trade.entryTs) : Number.NaN;
  if (!trade.symbol || !Number.isFinite(at)) return null;
  const zone = exchangeTimeZone(tradeMarket(trade.symbol, trade.market));
  // Session date in the exchange's own zone (an IST morning is the previous UTC day).
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
  const side = tradeSide(trade.direction);
  const tf1 = trade.tf1 ?? "1h";
  const tf2 = trade.tf2 ?? "5m";
  const qs = new URLSearchParams({
    tab: "market-structure-shift",
    symbol: trade.symbol,
    tf1,
    tf2,
    start: day,
    end: day,
    entry: new Date(at).toISOString(),
    dir: side,
  });
  if (trade.candleSource) qs.set("candleSource", trade.candleSource);
  return { href: `/?${qs.toString()}`, day, side, tf1, tf2 };
}
