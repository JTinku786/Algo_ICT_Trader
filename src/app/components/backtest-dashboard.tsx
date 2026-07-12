"use client";

import {
  Activity,
  AlertTriangle,
  ArrowUpDown,
  BarChart3,
  CheckCircle2,
  Database,
  FlaskConical,
  LineChart,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  TrendingDown,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { OrderChart } from "./order-chart";
import { StrategyLink } from "./blog-context";

type DirectionStats = {
  trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  net_r: number;
  net_usd: number;
  avg_r: number;
  avg_win_r: number;
  avg_loss_r: number;
  largest_win_r: number;
  largest_loss_r: number;
};

type Summary = {
  sizing?: {
    mode?: "fixed_risk" | "fixed_qty";
    initial_capital?: number;
    risk_usd?: number;
    quantity?: number;
    commission_bps?: number;
    slippage_bps?: number;
  };
  initial_capital?: number;
  ending_capital?: number;
  net_profit_pct?: number;
  exposure_pct?: number;
  cagr?: number | null;
  annual_return_pct?: number;
  risk_adjusted_return_pct?: number | null;
  total: number;
  wins?: number;
  losses?: number;
  long_trades?: number;
  short_trades?: number;
  win_rate?: number;
  net_r?: number;
  net_usd?: number;
  gross_pnl_before_costs_usd?: number;
  transaction_costs_usd?: number;
  gross_profit_usd?: number;
  gross_loss_usd?: number;
  gross_profit_r?: number;
  gross_loss_r?: number;
  profit_factor?: number | null;
  expectancy_r?: number;
  expectancy_usd?: number;
  avg_win_r?: number;
  avg_loss_r?: number;
  payoff_ratio?: number | null;
  largest_win_r?: number;
  largest_loss_r?: number;
  value_at_risk_r?: number;
  value_at_risk_usd?: number;
  best_win_usd?: number;
  worst_loss_usd?: number;
  max_consec_wins?: number;
  max_consec_losses?: number;
  max_trade_drawdown_r?: number;
  max_drawdown_r?: number;
  max_drawdown_usd?: number;
  max_drawdown_pct?: number;
  recovery_factor?: number | null;
  sharpe?: number | null;
  sortino?: number | null;
  calmar?: number | null;
  car_maxdd?: number | null;
  rar_maxdd?: number | null;
  ulcer_index?: number;
  k_ratio?: number | null;
  avg_hold_min?: number | null;
  risk_usd?: number;
  avg_quantity?: number | null;
  min_quantity?: number | null;
  max_quantity?: number | null;
  group_stats?: {
    all: DirectionStats;
    long: DirectionStats;
    short: DirectionStats;
  };
};

type EquityPoint = { i: number; t: number; r: number; balance: number; dd: number };
type MonthlyPoint = { month: string; net_r: number; trades: number; wins: number };
type StrategyOption = { strategy_id: string; strategy_name?: string | null; strategy_key?: string | null; n: number };
type BreakdownRow = {
  strategy_id: string;
  strategy_name?: string | null;
  trades: number;
  win_rate: number;
  net_r: number;
  expectancy_r: number;
  profit_factor: number | null;
};
type TradeRow = {
  order_id: string;
  symbol: string;
  strategy_id: string | null;
  strategy_name?: string | null;
  direction: string | null;
  filled_at: string | null;
  close_ts: string | null;
  entry: number | null;
  filled: number | null;
  stop: number | null;
  tp1: number | null;
  close_price: number | null;
  r: number;
  quantity: number | null;
  risk_usd: number | null;
  gross_pnl_usd: number | null;
  transaction_cost_usd: number | null;
  pnl_usd: number | null;
  outcome: "WIN" | "LOSS";
  hold_min: number | null;
};
type ResearchStats = DirectionStats & {
  expectancy_usd: number;
  trade_sharpe: number | null;
  max_drawdown_usd: number;
  profit_factor: number | null;
};
type AttributionRow = ResearchStats & { label: string };
type Research = {
  validation: {
    method: string;
    oos_pct: number;
    split_trade_index: number;
    split_timestamp: string | null;
    in_sample: ResearchStats;
    out_of_sample: ResearchStats;
    expectancy_degradation_pct: number | null;
  };
  monte_carlo: {
    method: string;
    simulations: number;
    seed: number;
    ending_equity_p05: number;
    ending_equity_p50: number;
    ending_equity_p95: number;
    max_drawdown_p50_usd: number;
    max_drawdown_p95_usd: number;
    probability_of_loss_pct: number;
    probability_of_20pct_drawdown_pct: number;
  };
  attribution: {
    by_year: AttributionRow[];
    by_session: AttributionRow[];
    by_direction: AttributionRow[];
    by_strategy: AttributionRow[];
  };
  data_quality: {
    status: "PASS" | "REVIEW";
    closed_trades: number;
    first_close_ts: string | null;
    last_close_ts: string | null;
    missing: Record<string, number>;
    warnings: string[];
  };
  audit: {
    calculation_version: string;
    generated_at: string;
    source: string;
    assumptions: string[];
  };
  deployment_gate: {
    status: "RESEARCH_PASSED_REVIEW_REQUIRED" | "NOT_READY";
    passed_checks: number;
    total_checks: number;
    checks: Array<{ id: string; label: string; passed: boolean }>;
    note: string;
  };
};
type BacktestResponse = {
  success: boolean;
  error?: string;
  filters?: { symbols: string[]; strategies: StrategyOption[]; years: string[] };
  summary?: Summary;
  equity?: EquityPoint[];
  monthly?: MonthlyPoint[];
  strategy_breakdown?: BreakdownRow[];
  research?: Research;
  trades?: TradeRow[];
  total_trades?: number;
  returned?: number;
};

type ColumnKey = "close_ts" | "symbol" | "strategy_id" | "strategy_name" | "direction" | "filled" | "stop" | "tp1" | "close_price" | "quantity" | "risk_usd" | "gross_pnl_usd" | "transaction_cost_usd" | "pnl_usd" | "r" | "hold_min" | "outcome";
type Column = { key: ColumnKey; label: string; numeric?: boolean; defaultVisible: boolean; render: (trade: TradeRow) => string; tone?: (trade: TradeRow) => "green" | "red" | "muted" | "white" };

const GREEN = "#2fbf71";
const RED = "#e5484d";
const MUTED = "#93a1b6";

const COLUMNS: Column[] = [
  { key: "close_ts", label: "Date", defaultVisible: true, render: (t) => fmtDate(t.close_ts) },
  { key: "symbol", label: "Ticker", defaultVisible: false, render: (t) => t.symbol },
  { key: "strategy_id", label: "Strategy", defaultVisible: true, render: (t) => t.strategy_id || "-" },
  { key: "strategy_name", label: "Name", defaultVisible: false, render: (t) => strategyDisplayName(t.strategy_id, t.strategy_name) },
  { key: "direction", label: "Dir", defaultVisible: true, render: (t) => t.direction || "-", tone: (t) => ((t.direction || "").toUpperCase() === "BUY" ? "green" : "red") },
  { key: "filled", label: "Entry", numeric: true, defaultVisible: true, render: (t) => fmt(t.filled) },
  { key: "stop", label: "Stop", numeric: true, defaultVisible: false, render: (t) => fmt(t.stop) },
  { key: "tp1", label: "TP1", numeric: true, defaultVisible: false, render: (t) => fmt(t.tp1) },
  { key: "close_price", label: "Exit", numeric: true, defaultVisible: true, render: (t) => fmt(t.close_price) },
  { key: "quantity", label: "Qty", numeric: true, defaultVisible: false, render: (t) => fmt(t.quantity, 2) },
  { key: "risk_usd", label: "Risk $", numeric: true, defaultVisible: false, render: (t) => money(t.risk_usd) },
  { key: "gross_pnl_usd", label: "Gross $", numeric: true, defaultVisible: false, render: (t) => money(t.gross_pnl_usd), tone: (t) => ((t.gross_pnl_usd ?? 0) >= 0 ? "green" : "red") },
  { key: "transaction_cost_usd", label: "Costs $", numeric: true, defaultVisible: false, render: (t) => money(t.transaction_cost_usd), tone: () => "red" },
  { key: "pnl_usd", label: "Net P/L $", numeric: true, defaultVisible: true, render: (t) => money(t.pnl_usd), tone: (t) => ((t.pnl_usd ?? 0) >= 0 ? "green" : "red") },
  { key: "r", label: "R", numeric: true, defaultVisible: true, render: (t) => `${t.r >= 0 ? "+" : ""}${fmt(t.r)}`, tone: (t) => (t.r >= 0 ? "green" : "red") },
  { key: "hold_min", label: "Hold", numeric: true, defaultVisible: true, render: (t) => fmtHold(t.hold_min), tone: () => "muted" },
  { key: "outcome", label: "Result", defaultVisible: true, render: (t) => t.outcome, tone: (t) => (t.outcome === "WIN" ? "green" : "red") },
];

const DEFAULT_COLUMNS = COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key);

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}
function fmt(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return Number(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtInt(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function money(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
function pct(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return `${fmt(value, digits)}%`;
}
function fmtDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", { year: "2-digit", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
function fmtHold(minutes: number | null) {
  if (minutes === null || minutes === undefined) return "-";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}
function strategyDisplayName(strategyId?: string | null, strategyName?: string | null) {
  if (strategyName) return strategyName;
  if (!strategyId) return "-";
  if (strategyId.startsWith("S-CH")) return `S-CH ${strategyId.replace("S-CH", "")}`;
  if (strategyId.startsWith("S")) return `Strategy ${strategyId}`;
  if (strategyId.startsWith("A")) return `A-Series ${strategyId}`;
  return strategyId;
}
function toneClass(tone?: "green" | "red" | "muted" | "white") {
  if (tone === "green") return "text-[#62d894]";
  if (tone === "red") return "text-[#ff8b91]";
  if (tone === "muted") return "text-[#93a1b6]";
  return "text-white";
}

type Market = "ALL" | "US" | "INDIA" | "FOREX" | "INDICES";

const MARKET_OPTIONS: { value: Market; label: string }[] = [
  { value: "ALL", label: "ALL - all markets" },
  { value: "US", label: "US Stocks" },
  { value: "INDIA", label: "Indian Stocks" },
  { value: "FOREX", label: "Forex" },
  { value: "INDICES", label: "Indices" },
];

function getSymbolMarket(symbol: string): Market {
  if (symbol.startsWith("^")) {
    // ^ prefixed: if it contains a major currency code, treat as Forex, else Indices
    if (/EUR|USD|GBP|JPY|CHF|AUD|NZD|CAD/.test(symbol)) return "FOREX";
    return "INDICES";
  }
  if (symbol.endsWith(".NS") || symbol.endsWith(".BO") || /^NSE:|^BSE:/.test(symbol)) return "INDIA";
  return "US";
}

export default function BacktestDashboard() {
  const [market, setMarket] = useState<Market>("ALL");
  const [symbol, setSymbol] = useState("ALL");
  const [strategy, setStrategy] = useState("S01");
  const [direction, setDirection] = useState("ALL");
  const [targetNo, setTargetNo] = useState("1");
  const [year, setYear] = useState("ALL");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [sizingMode, setSizingMode] = useState<"fixed_risk" | "fixed_qty">("fixed_risk");
  const [initialCapital, setInitialCapital] = useState("100000");
  const [riskUsd, setRiskUsd] = useState("100");
  const [quantity, setQuantity] = useState("100");
  const [commissionBps, setCommissionBps] = useState("1");
  const [slippageBps, setSlippageBps] = useState("2");
  const [oosPct, setOosPct] = useState("30");
  const [data, setData] = useState<BacktestResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sortKey, setSortKey] = useState<keyof TradeRow>("close_ts");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(DEFAULT_COLUMNS);
  const [selectedOrder, setSelectedOrder] = useState<TradeRow | null>(null);

  const allSymbols = useMemo(() => data?.filters?.symbols ?? [], [data]);
  const marketSymbols = useMemo(() => {
    if (market === "ALL") return allSymbols;
    return allSymbols.filter((s) => getSymbolMarket(s) === market);
  }, [allSymbols, market]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      symbol,
      strategy_id: strategy,
      direction,
      target_no: targetNo,
      year,
      start_date: startDate,
      end_date: endDate,
      sizing_mode: sizingMode,
      initial_capital: initialCapital,
      risk_usd: riskUsd,
      quantity,
      commission_bps: commissionBps,
      slippage_bps: slippageBps,
      oos_pct: oosPct,
    });
    try {
      const response = await fetch(`/api/backtest?${params.toString()}`, { cache: "no-store" });
      const payload = (await response.json()) as BacktestResponse;
      if (!response.ok || !payload.success) throw new Error(payload.error || "Backtest request failed");
      setData(payload);
      setSelectedOrder(null);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : "Backtest request failed");
    } finally {
      setLoading(false);
    }
  }, [symbol, strategy, direction, targetNo, year, startDate, endDate, sizingMode, initialCapital, riskUsd, quantity, commissionBps, slippageBps, oosPct]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const summary = data?.summary;
  const trades = useMemo(() => data?.trades ?? [], [data]);
  const strategyOptions = useMemo(() => data?.filters?.strategies ?? [], [data]);
  const strategyNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of strategyOptions) map.set(item.strategy_id, strategyDisplayName(item.strategy_id, item.strategy_name || item.strategy_key));
    return map;
  }, [strategyOptions]);
  const selectedColumns = COLUMNS.filter((column) => visibleColumns.includes(column.key));
  const sortedTrades = useMemo(() => {
    return [...trades].sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va ?? "").localeCompare(String(vb ?? ""));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [trades, sortDir, sortKey]);
  const netPositive = (summary?.net_r ?? 0) >= 0;

  function toggleSort(key: keyof TradeRow) {
    if (sortKey === key) setSortDir((current) => (current === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  return (
    <section className="space-y-4">
      <div className="rounded-md border border-white/10 bg-[#101620] p-3">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
          <Selector label="Market" value={market} onChange={(v) => { setMarket(v as Market); setSymbol("ALL"); }} options={MARKET_OPTIONS.map((m) => m.value)} labelMap={(value) => MARKET_OPTIONS.find((m) => m.value === value)?.label ?? value} />
          <Selector label="Symbol" value={symbol} onChange={setSymbol} options={["ALL", ...marketSymbols]} labelMap={(value) => value === "ALL" ? `ALL - ${market === "ALL" ? "all symbols" : MARKET_OPTIONS.find((m) => m.value === market)?.label ?? market}` : value} />
          <Selector
            label="Strategy"
            value={strategy}
            onChange={setStrategy}
            options={["ALL", ...strategyOptions.map((item) => item.strategy_id)]}
            labelMap={(value) => (value === "ALL" ? "ALL - all strategies" : `${value} - ${strategyNameById.get(value) || value}`)}
          />
          <Selector label="Direction" value={direction} onChange={setDirection} options={["ALL", "BUY", "SELL"]} />
          <Selector label="Target" value={targetNo} onChange={setTargetNo} options={["1", "2", "3"]} labelMap={(value) => `Target ${value}`} />
          <Selector label="Year" value={year} onChange={setYear} options={["ALL", ...(data?.filters?.years ?? [])]} />
          <DateField label="Start date" value={startDate} onChange={setStartDate} />
          <DateField label="End date" value={endDate} onChange={setEndDate} />
          <Selector label="Sizing" value={sizingMode} onChange={(value) => setSizingMode(value === "fixed_qty" ? "fixed_qty" : "fixed_risk")} options={["fixed_risk", "fixed_qty"]} labelMap={(value) => value === "fixed_qty" ? "Fixed quantity" : "Fixed risk"} />
          <MoneyField label="Initial capital" value={initialCapital} onChange={setInitialCapital} />
          {sizingMode === "fixed_qty" ? (
            <MoneyField label="Quantity" value={quantity} onChange={setQuantity} />
          ) : (
            <MoneyField label="Risk $/trade" value={riskUsd} onChange={setRiskUsd} />
          )}
          <MoneyField label="Commission bps" value={commissionBps} onChange={setCommissionBps} />
          <MoneyField label="Slippage bps" value={slippageBps} onChange={setSlippageBps} />
          <MoneyField label="OOS holdout %" value={oosPct} onChange={setOosPct} />
          <button
            onClick={() => void load()}
            className="flex h-10 items-center justify-center gap-2 self-end rounded-md bg-[#d9a441] px-4 text-sm font-semibold text-[#151109] transition hover:bg-[#edbf5e] xl:col-span-8"
          >
            <RefreshCw className={cx("size-4", loading && "animate-spin")} />
            Run
          </button>
        </div>
        <div className="mt-2 font-mono text-[11px] text-[#93a1b6]">
          {symbol === "ALL" ? `All symbols (${market === "ALL" ? "all markets" : MARKET_OPTIONS.find((m) => m.value === market)?.label ?? market})` : `${symbol} - ${market === "ALL" ? getSymbolMarket(symbol) : MARKET_OPTIONS.find((m) => m.value === market)?.label}`} | {strategy === "ALL" ? "All strategies" : strategyNameById.get(strategy) || strategy} - {data?.total_trades ?? 0} closed trades. {sizingMode === "fixed_qty" ? `Sizing: ${fmt(Number(quantity), 0)} units from ${money(Number(initialCapital))} capital.` : `Sizing: ${money(Number(riskUsd))} risk per trade from ${money(Number(initialCapital))} capital.`} Net results include {fmt(Number(commissionBps), 1)} bps commission + {fmt(Number(slippageBps), 1)} bps slippage per side.
        </div>
      </div>

      {error ? <div className="rounded-md border border-[#e5484d]/30 bg-[#e5484d]/10 p-4 text-sm text-[#ff9da2]">Error: {error}</div> : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        <Kpi label="Net Profit" value={`${fmt(summary?.net_r)}R`} tone={netPositive ? "green" : "red"} big />
        <Kpi label="Net P/L" value={money(summary?.net_usd)} tone={netPositive ? "green" : "red"} />
        <Kpi label="Win Rate" value={pct(summary?.win_rate)} />
        <Kpi label="Profit Factor" value={fmt(summary?.profit_factor)} tone={(summary?.profit_factor ?? 0) >= 1 ? "green" : "red"} />
        <Kpi label="Max Drawdown" value={`${fmt(summary?.max_drawdown_r)}R`} tone="red" />
        <Kpi label="Capital" value={money(summary?.initial_capital)} />
        <Kpi label="Cost Drag" value={money(summary?.transaction_costs_usd)} tone="red" />
        <Kpi label="Trades" value={fmtInt(summary?.total)} />
      </div>

      <PerformanceMatrix summary={summary} />

      <ResearchLab research={data?.research} />

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Panel icon={Activity} title="Equity and Drawdown" note="TradingView-style overview">
          <EquityDrawdownChart points={data?.equity ?? []} />
        </Panel>
        <Panel icon={BarChart3} title="Statistics" note="All / Long / Short">
          <DirectionStatsTable summary={summary} />
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Panel icon={TrendingUp} title="Monthly Performance" note="R by month">
          <MonthlyBars monthly={data?.monthly ?? []} />
          <MonthlyHeatmap monthly={data?.monthly ?? []} />
        </Panel>
        <Panel icon={LineChart} title="Strategy Breakdown" note={`${data?.strategy_breakdown?.length ?? 0} rows`}>
          <BreakdownTable rows={data?.strategy_breakdown ?? []} onPick={setStrategy} />
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1.35fr)]">
        <Panel icon={BarChart3} title="Trade List" note={`${trades.length} shown${data && data.total_trades && data.total_trades > trades.length ? ` of ${data.total_trades}` : ""}`}>
          <ColumnChooser visibleColumns={visibleColumns} onChange={setVisibleColumns} />
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="sticky top-0 z-10 border-b border-white/10 bg-[#0b0f16] text-[11px] uppercase text-[#7f8ca3]">
                <tr>
                  {selectedColumns.map((column) => (
                    <SortTh key={column.key} label={column.label} k={column.key} sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} num={column.numeric} />
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10 font-mono">
                {!loading && sortedTrades.length === 0 ? (
                  <tr>
                    <td colSpan={Math.max(selectedColumns.length, 1)} className="px-4 py-8 text-center text-[#93a1b6]">No trades for this selection.</td>
                  </tr>
                ) : null}
                {sortedTrades.map((trade) => (
                  <tr
                    key={trade.order_id}
                    onClick={() => setSelectedOrder(trade)}
                    className={cx("cursor-pointer transition hover:bg-white/[0.03]", selectedOrder?.order_id === trade.order_id && "bg-[#d9a441]/10")}
                  >
                    {selectedColumns.map((column) => (
                      <TradeCell key={column.key} column={column} trade={trade} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel icon={BarChart3} title="Order Chart" note={selectedOrder ? `${selectedOrder.symbol} - ${selectedOrder.strategy_id}` : "select a trade"}>
          {selectedOrder ? <OrderChart order={{ order_id: selectedOrder.order_id, symbol: selectedOrder.symbol, strategy_id: selectedOrder.strategy_id, direction: selectedOrder.direction, r: selectedOrder.r }} targetNo={targetNo} endpoint="/api/backtest/order-chart" onClose={() => setSelectedOrder(null)} /> : <div className="grid h-[520px] place-items-center text-sm text-[#93a1b6]">Click a trade to inspect the 5-minute entry, stop, targets and candle path.</div>}
        </Panel>
      </div>
    </section>
  );
}

function Selector({ label, value, onChange, options, labelMap }: { label: string; value: string; onChange: (value: string) => void; options: string[]; labelMap?: (value: string) => string }) {
  return (
    <div>
      <span className="mb-1.5 block text-[11px] font-semibold uppercase text-[#7f8ca3]">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full rounded-md border border-white/10 bg-[#0b0f16] px-3 text-sm text-white outline-none">
        {options.map((option) => <option key={option} value={option}>{labelMap ? labelMap(option) : option}</option>)}
      </select>
    </div>
  );
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div>
      <span className="mb-1.5 block text-[11px] font-semibold uppercase text-[#7f8ca3]">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-md border border-white/10 bg-[#0b0f16] px-3 font-mono text-sm text-white outline-none focus:border-[#d9a441]/70"
      />
    </div>
  );
}

function MoneyField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div>
      <span className="mb-1.5 block text-[11px] font-semibold uppercase text-[#7f8ca3]">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/[^0-9.]/g, ""))}
        className="h-10 w-full rounded-md border border-white/10 bg-[#0b0f16] px-3 font-mono text-sm text-white outline-none focus:border-[#d9a441]/70"
      />
    </div>
  );
}

function Kpi({ label, value, tone, big }: { label: string; value: string; tone?: "green" | "red"; big?: boolean }) {
  return (
    <div className="rounded-md border border-white/10 bg-[#101620] p-3">
      <div className="text-[10px] font-semibold uppercase text-[#7f8ca3]">{label}</div>
      <div className={cx("mt-1.5 font-mono font-semibold", big ? "text-2xl" : "text-lg", toneClass(tone || "white"))}>{value}</div>
    </div>
  );
}

function Panel({ icon: Icon, title, note, children }: { icon: React.ComponentType<{ className?: string }>; title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-white/10 bg-[#101620]">
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <Icon className="size-4 text-[#d9a441]" />
        <h2 className="font-semibold">{title}</h2>
        {note ? <span className="ml-auto font-mono text-[11px] text-[#93a1b6]">{note}</span> : null}
      </div>
      {children}
    </div>
  );
}

function MetricGrid({ title, rows }: { title: string; rows: Array<[string, string, ("green" | "red" | "white" | "muted")?]> }) {
  return (
    <div className="rounded-md border border-white/10 bg-[#101620] p-4">
      <h3 className="mb-4 text-sm font-semibold text-white">{title}</h3>
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
        {rows.map(([label, value, tone]) => (
          <div key={label}>
            <div className="text-sm text-[#d6deec]">{label}</div>
            <div className={cx("mt-1 font-mono text-lg", toneClass(tone || "white"))}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PerformanceMatrix({ summary }: { summary?: Summary }) {
  if (!summary || !summary.total) return <div className="rounded-md border border-white/10 bg-[#101620] p-6 text-sm text-[#93a1b6]">Run a backtest to populate metrics.</div>;
  return (
    <div className="space-y-4">
      <MetricGrid title="Performance Metrics" rows={[
        ["Initial Capital", money(summary.initial_capital), "white"],
        ["Ending Equity", money(summary.ending_capital), (summary.net_usd ?? 0) >= 0 ? "green" : "red"],
        ["Return on Capital", pct(summary.net_profit_pct), (summary.net_profit_pct ?? 0) >= 0 ? "green" : "red"],
        ["Return on Risk", `${fmt(summary.net_r)}R`, (summary.net_r ?? 0) >= 0 ? "green" : "red"],
        ["Gross P/L", money(summary.gross_pnl_before_costs_usd), (summary.gross_pnl_before_costs_usd ?? 0) >= 0 ? "green" : "red"],
        ["Execution Costs", money(summary.transaction_costs_usd), "red"],
        ["Net P/L", money(summary.net_usd), (summary.net_usd ?? 0) >= 0 ? "green" : "red"],
        ["Value at Risk", money(summary.value_at_risk_usd), "red"],
        ["CAGR", pct(summary.cagr), (summary.cagr ?? 0) >= 0 ? "green" : "red"],
      ]} />
      <MetricGrid title="Performance Ratios" rows={[
        ["Profit Factor", fmt(summary.profit_factor), (summary.profit_factor ?? 0) >= 1 ? "green" : "red"],
        ["Max Drawdown", `${fmt(summary.max_drawdown_r)}R`, "red"],
        ["Sharpe", fmt(summary.sharpe), "white"],
        ["Sortino", fmt(summary.sortino), "white"],
        ["Calmar", fmt(summary.calmar), "white"],
        ["Recovery Factor", fmt(summary.recovery_factor), "white"],
        ["CAR/MaxDD", fmt(summary.car_maxdd), "white"],
        ["RAR/MaxDD", fmt(summary.rar_maxdd), "white"],
        ["Ulcer Index", fmt(summary.ulcer_index), "white"],
        ["K-Ratio", fmt(summary.k_ratio), "white"],
      ]} />
      <MetricGrid title="Win/Loss Metrics" rows={[
        ["Positions", fmtInt(summary.total), "white"],
        ["Win Rate", pct(summary.win_rate), "green"],
        ["Wins", fmtInt(summary.wins), "green"],
        ["Losses", fmtInt(summary.losses), "red"],
        ["Best Win", `${fmt(summary.largest_win_r)}R`, "green"],
        ["Worst Loss", `${fmt(summary.largest_loss_r)}R`, "red"],
        ["Winning Streak", fmtInt(summary.max_consec_wins), "white"],
        ["Losing Streak", fmtInt(summary.max_consec_losses), "white"],
      ]} />
      <MetricGrid title="Position Averages" rows={[
        ["Win", `${fmt(summary.avg_win_r)}R`, "green"],
        ["Loss", `${fmt(summary.avg_loss_r)}R`, "red"],
        ["P/L", `${fmt(summary.expectancy_r)}R`, (summary.expectancy_r ?? 0) >= 0 ? "green" : "red"],
        ["Expected P/L", money(summary.expectancy_usd), (summary.expectancy_usd ?? 0) >= 0 ? "green" : "red"],
        ["Avg Risk", money(summary.risk_usd), "white"],
        ["Avg Quantity", fmt(summary.avg_quantity, 2), "white"],
        ["Min Quantity", fmt(summary.min_quantity, 2), "white"],
        ["Max Quantity", fmt(summary.max_quantity, 2), "white"],
        ["Duration", fmtHold(summary.avg_hold_min ?? null), "white"],
        ["Exposure", pct(summary.exposure_pct), "white"],
        ["Payoff Ratio", fmt(summary.payoff_ratio), "white"],
      ]} />
    </div>
  );
}

function ResearchLab({ research }: { research?: Research }) {
  if (!research) {
    return <div className="rounded-md border border-white/10 bg-[#101620] p-6 text-sm text-[#93a1b6]">Research validation is unavailable for this result.</div>;
  }
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-white/10 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <FlaskConical className="size-5 text-[#d9a441]" />
            <h2 className="text-lg font-semibold">Research Validation</h2>
          </div>
          <p className="mt-1 text-xs text-[#93a1b6]">Net-of-cost evidence, chronological holdout, path risk, attribution and deployment review.</p>
        </div>
        <GateBadge gate={research.deployment_gate} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel icon={FlaskConical} title="Chronological Holdout" note={`${fmt(research.validation.oos_pct, 0)}% OOS`}>
          <ValidationTable validation={research.validation} />
        </Panel>
        <Panel icon={TrendingDown} title="Monte Carlo Path Risk" note={`${fmtInt(research.monte_carlo.simulations)} deterministic paths`}>
          <MonteCarloSummary value={research.monte_carlo} />
        </Panel>
        <Panel icon={BarChart3} title="Performance Attribution" note="net of configured costs">
          <AttributionTable attribution={research.attribution} />
        </Panel>
        <Panel icon={ShieldCheck} title="Data and Deployment Governance" note={research.audit.calculation_version}>
          <GovernanceSummary research={research} />
        </Panel>
      </div>
    </section>
  );
}

function GateBadge({ gate }: { gate: Research["deployment_gate"] }) {
  const passed = gate.status === "RESEARCH_PASSED_REVIEW_REQUIRED";
  return (
    <div className={cx("flex items-center gap-2 rounded border px-3 py-2 text-xs font-semibold", passed ? "border-[#2fbf71]/35 bg-[#2fbf71]/10 text-[#62d894]" : "border-[#e5484d]/35 bg-[#e5484d]/10 text-[#ff9da2]")}>
      {passed ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
      {passed ? "Research passed - approval required" : `Not ready - ${gate.passed_checks}/${gate.total_checks} checks`}
    </div>
  );
}

function ValidationTable({ validation }: { validation: Research["validation"] }) {
  const rows: Array<[string, (stats: ResearchStats) => string]> = [
    ["Trades", (stats) => fmtInt(stats.trades)],
    ["Win rate", (stats) => pct(stats.win_rate)],
    ["Net P/L", (stats) => money(stats.net_usd)],
    ["Expectancy", (stats) => money(stats.expectancy_usd)],
    ["Profit factor", (stats) => fmt(stats.profit_factor)],
    ["Trade Sharpe", (stats) => fmt(stats.trade_sharpe)],
    ["Max drawdown", (stats) => money(stats.max_drawdown_usd)],
  ];
  return (
    <div>
      <div className="border-b border-white/10 px-4 py-3 text-xs text-[#93a1b6]">
        Split at {fmtDate(validation.split_timestamp)}. No parameters are re-optimized in this holdout.
      </div>
      <table className="w-full text-sm">
        <thead className="bg-[#0b0f16] text-[11px] uppercase text-[#7f8ca3]">
          <tr><th className="px-4 py-2 text-left">Metric</th><th className="px-4 py-2 text-right">In sample</th><th className="px-4 py-2 text-right">Out of sample</th></tr>
        </thead>
        <tbody className="divide-y divide-white/5 font-mono">
          {rows.map(([label, read]) => (
            <tr key={label}>
              <td className="px-4 py-2 font-sans text-[#93a1b6]">{label}</td>
              <td className="px-4 py-2 text-right text-[#d6deec]">{read(validation.in_sample)}</td>
              <td className="px-4 py-2 text-right text-white">{read(validation.out_of_sample)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-white/10 px-4 py-3 text-xs text-[#93a1b6]">
        Expectancy degradation: <span className={cx("font-mono", (validation.expectancy_degradation_pct ?? 0) > 50 ? "text-[#ff9da2]" : "text-[#d6deec]")}>{pct(validation.expectancy_degradation_pct)}</span>
      </div>
    </div>
  );
}

function MonteCarloSummary({ value }: { value: Research["monte_carlo"] }) {
  const metrics: Array<[string, string, "green" | "red" | "white"]> = [
    ["Ending equity P05", money(value.ending_equity_p05), "red"],
    ["Ending equity median", money(value.ending_equity_p50), "white"],
    ["Ending equity P95", money(value.ending_equity_p95), "green"],
    ["Median max drawdown", money(-value.max_drawdown_p50_usd), "red"],
    ["P95 max drawdown", money(-value.max_drawdown_p95_usd), "red"],
    ["Probability of loss", pct(value.probability_of_loss_pct), value.probability_of_loss_pct > 20 ? "red" : "white"],
    ["Probability of 20% DD", pct(value.probability_of_20pct_drawdown_pct), value.probability_of_20pct_drawdown_pct > 10 ? "red" : "white"],
  ];
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-5 p-4 md:grid-cols-3">
      {metrics.map(([label, display, tone]) => (
        <div key={label}>
          <div className="text-xs text-[#93a1b6]">{label}</div>
          <div className={cx("mt-1 font-mono text-base", toneClass(tone))}>{display}</div>
        </div>
      ))}
      <div className="col-span-2 border-t border-white/10 pt-3 text-[11px] text-[#7f8ca3] md:col-span-3">
        Bootstrap resampling of observed net trade P/L. Seed {value.seed}; sequence risk only, not a forecast.
      </div>
    </div>
  );
}

function AttributionTable({ attribution }: { attribution: Research["attribution"] }) {
  const [view, setView] = useState<keyof Research["attribution"]>("by_session");
  const views: Array<[keyof Research["attribution"], string]> = [
    ["by_session", "Session"],
    ["by_year", "Year"],
    ["by_direction", "Direction"],
    ["by_strategy", "Strategy"],
  ];
  return (
    <div>
      <div className="flex gap-1 border-b border-white/10 p-2">
        {views.map(([key, label]) => (
          <button key={key} onClick={() => setView(key)} className={cx("rounded px-2.5 py-1.5 text-xs", view === key ? "bg-[#d9a441]/15 text-[#f2c873]" : "text-[#93a1b6] hover:text-white")}>{label}</button>
        ))}
      </div>
      <div className="max-h-[310px] overflow-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="sticky top-0 bg-[#0b0f16] text-[11px] uppercase text-[#7f8ca3]">
            <tr><th className="px-3 py-2 text-left">{views.find(([key]) => key === view)?.[1]}</th><th className="px-3 py-2 text-right">Trades</th><th className="px-3 py-2 text-right">WR</th><th className="px-3 py-2 text-right">Net P/L</th><th className="px-3 py-2 text-right">Expectancy</th><th className="px-3 py-2 text-right">PF</th></tr>
          </thead>
          <tbody className="divide-y divide-white/5 font-mono">
            {attribution[view].map((row) => (
              <tr key={row.label}>
                <td className="px-3 py-2 font-sans text-[#d6deec]">{row.label}</td>
                <td className="px-3 py-2 text-right">{fmtInt(row.trades)}</td>
                <td className="px-3 py-2 text-right">{pct(row.win_rate)}</td>
                <td className={cx("px-3 py-2 text-right", row.net_usd >= 0 ? "text-[#62d894]" : "text-[#ff8b91]")}>{money(row.net_usd)}</td>
                <td className="px-3 py-2 text-right">{money(row.expectancy_usd)}</td>
                <td className="px-3 py-2 text-right">{fmt(row.profit_factor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GovernanceSummary({ research }: { research: Research }) {
  return (
    <div className="divide-y divide-white/10">
      <div className="grid grid-cols-2 gap-4 p-4 text-xs md:grid-cols-4">
        <AuditValue label="Source" value={research.audit.source} icon={Database} wide />
        <AuditValue label="First close" value={fmtDate(research.data_quality.first_close_ts)} />
        <AuditValue label="Last close" value={fmtDate(research.data_quality.last_close_ts)} />
      </div>
      <div className="p-4">
        <div className="mb-3 text-xs font-semibold uppercase text-[#7f8ca3]">Deployment checks</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {research.deployment_gate.checks.map((check) => (
            <div key={check.id} className="flex items-center gap-2 text-xs text-[#d6deec]">
              {check.passed ? <CheckCircle2 className="size-4 shrink-0 text-[#62d894]" /> : <XCircle className="size-4 shrink-0 text-[#ff8b91]" />}
              {check.label}
            </div>
          ))}
        </div>
      </div>
      <div className="p-4">
        <div className="mb-2 text-xs font-semibold uppercase text-[#7f8ca3]">Model limitations</div>
        <ul className="space-y-1.5 text-xs text-[#93a1b6]">
          {research.data_quality.warnings.map((warning) => <li key={warning}>- {warning}</li>)}
        </ul>
      </div>
      <div className="p-4 text-[11px] text-[#7f8ca3]">
        Generated {fmtDate(research.audit.generated_at)}. {research.deployment_gate.note}
      </div>
    </div>
  );
}

function AuditValue({ label, value, icon: Icon, wide }: { label: string; value: string; icon?: React.ComponentType<{ className?: string }>; wide?: boolean }) {
  return (
    <div className={cx(wide && "col-span-2")}>
      <div className="flex items-center gap-1.5 text-[#7f8ca3]">{Icon ? <Icon className="size-3.5" /> : null}{label}</div>
      <div className="mt-1 break-words font-mono text-[#d6deec]">{value}</div>
    </div>
  );
}

function EquityDrawdownChart({ points }: { points: EquityPoint[] }) {
  if (!points.length) return <div className="grid h-[320px] place-items-center text-sm text-[#93a1b6]">No equity data.</div>;
  const width = 900;
  const height = 320;
  const pad = 28;
  const values = points.map((p) => p.r);
  const dds = points.map((p) => p.dd);
  const minY = Math.min(...values, 0);
  const maxY = Math.max(...values, 1);
  const minDd = Math.min(...dds, -1);
  const x = (index: number) => pad + (index / Math.max(points.length - 1, 1)) * (width - pad * 2);
  const y = (value: number) => pad + ((maxY - value) / Math.max(maxY - minY, 1)) * (height - pad * 2);
  const zeroY = y(0);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.r).toFixed(1)}`).join(" ");
  const area = `${line} L ${x(points.length - 1)} ${zeroY} L ${x(0)} ${zeroY} Z`;
  return (
    <div className="p-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[320px] w-full">
        <defs>
          <linearGradient id="equityFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={GREEN} stopOpacity="0.35" />
            <stop offset="100%" stopColor={GREEN} stopOpacity="0.03" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3].map((i) => <line key={i} x1={pad} x2={width - pad} y1={pad + i * 82} y2={pad + i * 82} stroke="rgba(255,255,255,0.06)" />)}
        <path d={area} fill="url(#equityFill)" />
        <path d={line} fill="none" stroke={GREEN} strokeWidth="2.5" />
        {points.map((p, i) => {
          if (p.dd >= 0) return null;
          const barHeight = Math.max(1, (Math.abs(p.dd) / Math.abs(minDd)) * 90);
          return <rect key={`${p.t}-${i}`} x={x(i) - 1.5} y={height - pad - barHeight} width="3" height={barHeight} fill="rgba(200,145,255,0.35)" />;
        })}
        <text x={pad} y={18} fill={MUTED} fontSize="12">Equity {fmt(points[points.length - 1]?.r)}R</text>
        <text x={width - pad} y={18} fill={MUTED} fontSize="12" textAnchor="end">Max DD {fmt(minDd)}R</text>
      </svg>
    </div>
  );
}

function MonthlyBars({ monthly }: { monthly: MonthlyPoint[] }) {
  if (!monthly.length) return <div className="grid h-[180px] place-items-center text-sm text-[#93a1b6]">No monthly data.</div>;
  const recent = monthly.slice(-24);
  const maxAbs = Math.max(...recent.map((m) => Math.abs(m.net_r)), 1);
  return (
    <div className="flex h-[190px] items-end gap-1 overflow-x-auto px-4 pb-4 pt-5">
      {recent.map((month) => {
        const h = Math.max(4, (Math.abs(month.net_r) / maxAbs) * 130);
        return (
          <div key={month.month} className="flex min-w-8 flex-col items-center gap-1">
            <div title={`${month.month}: ${fmt(month.net_r)}R, ${month.trades} trades`} className="w-5 rounded-t" style={{ height: h, backgroundColor: month.net_r >= 0 ? GREEN : RED }} />
            <span className="font-mono text-[9px] text-[#7f8ca3]">{month.month.slice(2).replace("-", "/")}</span>
          </div>
        );
      })}
    </div>
  );
}

function MonthlyHeatmap({ monthly }: { monthly: MonthlyPoint[] }) {
  const years = [...new Set(monthly.map((m) => m.month.slice(0, 4)))].sort((a, b) => b.localeCompare(a));
  const byMonth = new Map(monthly.map((m) => [m.month, m]));
  const maxAbs = Math.max(...monthly.map((m) => Math.abs(m.net_r)), 1);
  if (!monthly.length) return null;
  return (
    <div className="overflow-auto px-3 pb-3">
      <table className="w-full min-w-[560px] border-separate border-spacing-1 text-center text-[11px]">
        <thead className="text-[#7f8ca3]">
          <tr><th className="text-left">Year</th>{["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((m) => <th key={m}>{m}</th>)}</tr>
        </thead>
        <tbody>
          {years.map((year) => (
            <tr key={year}>
              <td className="pr-2 text-left font-mono text-[#d6deec]">{year}</td>
              {Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0")).map((month) => {
                const item = byMonth.get(`${year}-${month}`);
                const alpha = item ? Math.min(0.85, 0.15 + Math.abs(item.net_r) / maxAbs) : 0;
                return (
                  <td key={month} className="rounded px-1 py-1.5 font-mono text-white" style={{ backgroundColor: item ? (item.net_r >= 0 ? `rgba(47,191,113,${alpha})` : `rgba(229,72,77,${alpha})`) : "transparent" }}>
                    {item ? `${item.net_r >= 0 ? "+" : ""}${item.net_r.toFixed(1)}` : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DirectionStatsTable({ summary }: { summary?: Summary }) {
  const groups = summary?.group_stats;
  if (!summary || !groups) return <div className="grid h-[320px] place-items-center text-sm text-[#93a1b6]">No statistics.</div>;
  const rows: Array<[string, (stats: DirectionStats) => string, ("green" | "red" | "white" | "muted")?]> = [
    ["Trades", (s) => fmtInt(s.trades), "white"],
    ["Wins", (s) => fmtInt(s.wins), "green"],
    ["Losses", (s) => fmtInt(s.losses), "red"],
    ["Win rate", (s) => pct(s.win_rate), "white"],
    ["Net R", (s) => fmt(s.net_r), "white"],
    ["Net $", (s) => money(s.net_usd), "white"],
    ["Avg R", (s) => fmt(s.avg_r), "white"],
    ["Avg Win", (s) => fmt(s.avg_win_r), "green"],
    ["Avg Loss", (s) => fmt(s.avg_loss_r), "red"],
    ["Largest Win", (s) => fmt(s.largest_win_r), "green"],
    ["Largest Loss", (s) => fmt(s.largest_loss_r), "red"],
  ];
  return (
    <div className="max-h-[360px] overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-[#0b0f16] text-[11px] uppercase text-[#7f8ca3]">
          <tr><th className="px-4 py-2 text-left">Metric</th><th className="px-4 py-2 text-right">All</th><th className="px-4 py-2 text-right">Long</th><th className="px-4 py-2 text-right">Short</th></tr>
        </thead>
        <tbody className="divide-y divide-white/5 font-mono">
          {rows.map(([label, read, tone]) => (
            <tr key={label}>
              <td className="px-4 py-2 font-sans text-[#93a1b6]">{label}</td>
              <td className={cx("px-4 py-2 text-right", toneClass(tone))}>{read(groups.all)}</td>
              <td className={cx("px-4 py-2 text-right", toneClass(tone))}>{read(groups.long)}</td>
              <td className={cx("px-4 py-2 text-right", toneClass(tone))}>{read(groups.short)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BreakdownTable({ rows, onPick }: { rows: BreakdownRow[]; onPick: (id: string) => void }) {
  if (!rows.length) return <div className="grid h-[260px] place-items-center text-sm text-[#93a1b6]">No strategy rows.</div>;
  return (
    <div className="max-h-[340px] overflow-auto">
      <table className="w-full min-w-[480px] text-left text-sm">
        <thead className="sticky top-0 border-b border-white/10 bg-[#0b0f16] text-[11px] uppercase text-[#7f8ca3]">
          <tr><th className="px-3 py-2">Strategy</th><th className="px-3 py-2">Name</th><th className="px-3 py-2 text-right">Trades</th><th className="px-3 py-2 text-right">WR%</th><th className="px-3 py-2 text-right">Net R</th><th className="px-3 py-2 text-right">PF</th></tr>
        </thead>
        <tbody className="divide-y divide-white/10 font-mono">
          {rows.map((row) => (
            <tr key={row.strategy_id} onClick={() => onPick(row.strategy_id)} className="cursor-pointer hover:bg-white/[0.03]">
              <td className="px-3 py-2 text-white"><StrategyLink code={row.strategy_id} label={row.strategy_id} /></td>
              <td className="px-3 py-2 font-sans text-[#d6deec]">{strategyDisplayName(row.strategy_id, row.strategy_name)}</td>
              <td className="px-3 py-2 text-right text-[#d6deec]">{fmtInt(row.trades)}</td>
              <td className="px-3 py-2 text-right text-[#d6deec]">{fmt(row.win_rate, 1)}</td>
              <td className={cx("px-3 py-2 text-right font-semibold", row.net_r >= 0 ? "text-[#62d894]" : "text-[#ff8b91]")}>{row.net_r >= 0 ? "+" : ""}{fmt(row.net_r)}</td>
              <td className="px-3 py-2 text-right text-[#f2c873]">{fmt(row.profit_factor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ColumnChooser({ visibleColumns, onChange }: { visibleColumns: ColumnKey[]; onChange: (columns: ColumnKey[]) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
      <SlidersHorizontal className="size-4 text-[#d9a441]" />
      <span className="mr-1 text-xs font-semibold uppercase text-[#7f8ca3]">Columns</span>
      {COLUMNS.map((column) => {
        const active = visibleColumns.includes(column.key);
        return (
          <button
            key={column.key}
            onClick={() => {
              const next = active ? visibleColumns.filter((key) => key !== column.key) : [...visibleColumns, column.key];
              onChange(next.length ? next : [column.key]);
            }}
            className={cx("rounded border px-2 py-1 text-[11px]", active ? "border-[#d9a441]/50 bg-[#d9a441]/15 text-[#f2c873]" : "border-white/10 text-[#93a1b6]")}
          >
            {column.label}
          </button>
        );
      })}
    </div>
  );
}

function SortTh({ label, k, sortKey, sortDir, onClick, num }: { label: string; k: keyof TradeRow; sortKey: keyof TradeRow; sortDir: "asc" | "desc"; onClick: (key: keyof TradeRow) => void; num?: boolean }) {
  const active = sortKey === k;
  return (
    <th className={cx("px-3 py-3 font-semibold", num && "text-right")}>
      <button onClick={() => onClick(k)} className={cx("inline-flex items-center gap-1 hover:text-white", active && "text-[#f2c873]")}>
        {label}
        {active ? <span className="text-[9px]">{sortDir === "asc" ? "▲" : "▼"}</span> : <ArrowUpDown className="size-3 opacity-40" />}
      </button>
    </th>
  );
}

function TradeCell({ column, trade }: { column: Column; trade: TradeRow }) {
  const tone = column.tone?.(trade) || "white";
  if (column.key === "outcome") {
    return (
      <td className="px-3 py-2">
        <span className={cx("rounded px-1.5 py-0.5 text-[10px] font-semibold", trade.outcome === "WIN" ? "bg-[#2fbf71]/15 text-[#62d894]" : "bg-[#e5484d]/15 text-[#ff8b91]")}>{column.render(trade)}</span>
      </td>
    );
  }
  if (column.key === "strategy_id") {
    return <td className="px-3 py-2 text-white"><StrategyLink code={trade.strategy_id} label={trade.strategy_id || "-"} /></td>;
  }
  return <td className={cx("px-3 py-2", column.numeric && "text-right", toneClass(tone))}>{column.render(trade)}</td>;
}
