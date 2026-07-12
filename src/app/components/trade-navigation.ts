export type TradePrefill = {
  signal_hash?: string | null;
  order_id?: string | null;
  market?: string | null;
  ticker?: string | null;
  strategy_id?: string | null;
  direction?: string | null;
  entry_datetime?: string | null;
  entry_price?: number | null;
  stoploss?: number | null;
  tp1?: number | null;
  tp2?: number | null;
  tp3?: number | null;
  state?: string | null;
  outcome?: string | null;
};
