import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool, hasPostgresConfig } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RawTrade = {
  order_id: string;
  symbol: string;
  strategy_id: string | null;
  strategy_name: string | null;
  direction: string | null;
  filled_at: string | null;
  entry_price: string | number | null;
  filled_price: string | number | null;
  stoploss: string | number | null;
  tp1: string | number | null;
  close_ts: string | null;
  close_price: string | number | null;
  target_rr: string | number | null;
  state: string;
};

type Trade = {
  order_id: string;
  symbol: string;
  strategy_id: string | null;
  strategy_name: string | null;
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

type SizingMode = "fixed_risk" | "fixed_qty";

type SizingSettings = {
  mode: SizingMode;
  initialCapital: number;
  riskUsd: number;
  quantity: number;
  commissionBps: number;
  slippageBps: number;
};

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function targetNo(v: string | null) {
  const n = Number(v || 1);
  return [1, 2, 3].includes(n) ? n : 1;
}

function cleanDate(v: string | null) {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return "";
  return v;
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const symbol = (sp.get("symbol") || "AAPL").trim().toUpperCase();
  const strategy = (sp.get("strategy_id") || "S16").trim().toUpperCase();
  const direction = (sp.get("direction") || "ALL").trim().toUpperCase();
  const target_no = targetNo(sp.get("target_no"));
  const year = (sp.get("year") || "ALL").trim();
  const startDate = cleanDate(sp.get("start_date"));
  const endDate = cleanDate(sp.get("end_date"));
  const sizingMode: SizingMode = sp.get("sizing_mode") === "fixed_qty" ? "fixed_qty" : "fixed_risk";
  const sizing: SizingSettings = {
    mode: sizingMode,
    initialCapital: Math.max(1, Number(sp.get("initial_capital") || 100000) || 100000),
    riskUsd: Math.max(1, Number(sp.get("risk_usd") || 100) || 100),
    quantity: Math.max(1, Number(sp.get("quantity") || 100) || 100),
    commissionBps: Math.max(0, Number(sp.get("commission_bps") || 1) || 0),
    slippageBps: Math.max(0, Number(sp.get("slippage_bps") || 2) || 0),
  };
  const oosPct = Math.min(50, Math.max(10, Number(sp.get("oos_pct") || 30) || 30));

  const restApiUrl = process.env.CANDLES_REST_API_URL;
  if (!hasPostgresConfig() && restApiUrl) {
    const upstreamUrl = new URL("/api/backtest", restApiUrl);
    for (const [key, value] of sp.entries()) {
      upstreamUrl.searchParams.set(key, value);
    }
    if (!sp.has("strategy_id")) upstreamUrl.searchParams.set("strategy_id", "S16");
    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        headers: process.env.CANDLES_REST_API_TOKEN
          ? { "x-api-key": process.env.CANDLES_REST_API_TOKEN }
          : undefined,
        cache: "no-store",
      });
      const payload = await upstreamResponse.json();
      return NextResponse.json(payload, { status: upstreamResponse.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown REST API error";
      return NextResponse.json({ success: false, error: `REST API unavailable: ${message}` }, { status: 502 });
    }
  }

  const conds = ["t.state IN ('CLOSED_TP','CLOSED_SL')", "t.target_no = $1"];
  const params: Array<string | number> = [target_no];
  if (symbol && symbol !== "ALL") {
    params.push(symbol);
    conds.push(`UPPER(o.symbol) = $${params.length}`);
  }
  if (strategy && strategy !== "ALL") {
    params.push(strategy);
    conds.push(`UPPER(o.strategy_id) = $${params.length}`);
  }
  if (direction && direction !== "ALL") {
    params.push(direction);
    conds.push(`UPPER(o.direction) = $${params.length}`);
  }
  if (year && year !== "ALL") {
    params.push(year);
    conds.push(`EXTRACT(YEAR FROM o.run_date)::text = $${params.length}`);
  }
  if (startDate) {
    params.push(startDate);
    conds.push(`t.close_ts::date >= $${params.length}::date`);
  }
  if (endDate) {
    params.push(endDate);
    conds.push(`t.close_ts::date <= $${params.length}::date`);
  }
  const where = conds.join(" AND ");

  try {
    const pool = getPostgresPool();

    const symbolsQ = pool.query(
      `SELECT DISTINCT o.symbol FROM historical_ict_orders o
       JOIN historical_ict_order_target_outcomes t ON t.order_id=o.order_id
       WHERE t.state IN ('CLOSED_TP','CLOSED_SL') ORDER BY o.symbol`,
    );
    const strategiesQ = (() => {
      if (symbol && symbol !== "ALL") {
        return pool.query(
          `SELECT o.strategy_id, MIN(r.strategy_name) AS strategy_name, MIN(r.strategy_key) AS strategy_key, COUNT(*)::int AS n
           FROM historical_ict_orders o
           JOIN historical_ict_order_target_outcomes t ON t.order_id=o.order_id
           LEFT JOIN ict_strategy_reference r ON r.strategy_id = o.strategy_id
           WHERE t.state IN ('CLOSED_TP','CLOSED_SL') AND t.target_no=$1 AND UPPER(o.symbol)=$2
           GROUP BY o.strategy_id ORDER BY n DESC`,
          [target_no, symbol],
        );
      }
      return pool.query(
        `SELECT o.strategy_id, MIN(r.strategy_name) AS strategy_name, MIN(r.strategy_key) AS strategy_key, COUNT(*)::int AS n
         FROM historical_ict_orders o
         JOIN historical_ict_order_target_outcomes t ON t.order_id=o.order_id
         LEFT JOIN ict_strategy_reference r ON r.strategy_id = o.strategy_id
         WHERE t.state IN ('CLOSED_TP','CLOSED_SL') AND t.target_no=$1
         GROUP BY o.strategy_id ORDER BY n DESC`,
        [target_no],
      );
    })();
    const yearsQ = (() => {
      if (symbol && symbol !== "ALL") {
        return pool.query(
          `SELECT DISTINCT EXTRACT(YEAR FROM o.run_date)::int AS y FROM historical_ict_orders o
           JOIN historical_ict_order_target_outcomes t ON t.order_id=o.order_id
           WHERE t.state IN ('CLOSED_TP','CLOSED_SL') AND UPPER(o.symbol)=$1 ORDER BY y DESC`,
          [symbol],
        );
      }
      return pool.query(
        `SELECT DISTINCT EXTRACT(YEAR FROM o.run_date)::int AS y FROM historical_ict_orders o
         JOIN historical_ict_order_target_outcomes t ON t.order_id=o.order_id
         WHERE t.state IN ('CLOSED_TP','CLOSED_SL') ORDER BY y DESC`,
      );
    })();
    const tradesQ = pool.query(
      `SELECT o.order_id, o.symbol, o.strategy_id, r.strategy_name, o.direction, o.filled_at,
              o.entry_price, o.filled_price, o.stoploss, o.tp1,
              t.close_ts, t.close_price, t.target_rr, t.state
       FROM historical_ict_orders o
       JOIN historical_ict_order_target_outcomes t ON t.order_id=o.order_id
       LEFT JOIN ict_strategy_reference r ON r.strategy_id = o.strategy_id
       WHERE ${where}
       ORDER BY t.close_ts ASC NULLS LAST, o.order_id`,
      params,
    );

    const [symbols, strategies, years, tradesRes] = await Promise.all([
      symbolsQ,
      strategiesQ,
      yearsQ,
      tradesQ,
    ]);

    const trades: Trade[] = (tradesRes.rows as RawTrade[]).map((row) => {
      const isWin = row.state === "CLOSED_TP";
      const rr = num(row.target_rr);
      const filledAt = row.filled_at ? new Date(row.filled_at).getTime() : null;
      const closeTs = row.close_ts ? new Date(row.close_ts).getTime() : null;
      const holdMin = filledAt && closeTs ? Math.round((closeTs - filledAt) / 60000) : null;
      const baseTrade: Trade = {
        order_id: row.order_id,
        symbol: row.symbol,
        strategy_id: row.strategy_id,
        strategy_name: row.strategy_name,
        direction: row.direction,
        filled_at: row.filled_at,
        close_ts: row.close_ts,
        entry: num(row.entry_price),
        filled: num(row.filled_price),
        stop: num(row.stoploss),
        tp1: num(row.tp1),
        close_price: num(row.close_price),
        r: isWin ? (rr === null ? 0 : rr) : -1,
        quantity: null,
        risk_usd: null,
        gross_pnl_usd: null,
        transaction_cost_usd: null,
        pnl_usd: null,
        outcome: isWin ? "WIN" : "LOSS",
        hold_min: holdMin,
      };
      return applySizing(baseTrade, sizing);
    });

    const summary = computeMetrics(trades, sizing);
    const equity = buildEquity(trades, sizing.initialCapital);
    const monthly = buildMonthly(trades);
    const breakdown = buildStrategyBreakdown(trades);
    const research = buildResearch(trades, sizing, oosPct);

    // Cap the trades payload but keep metrics on the full set.
    const MAX_ROWS = 1500;
    const tradesOut = trades.length > MAX_ROWS ? trades.slice(-MAX_ROWS).reverse() : [...trades].reverse();

    return NextResponse.json({
      success: true,
      source: "postgres",
      params: {
        symbol,
        strategy,
        direction,
        target_no,
        year,
        start_date: startDate,
        end_date: endDate,
        sizing_mode: sizing.mode,
        initial_capital: sizing.initialCapital,
        risk_usd: sizing.riskUsd,
        quantity: sizing.quantity,
        commission_bps: sizing.commissionBps,
        slippage_bps: sizing.slippageBps,
        oos_pct: oosPct,
      },
      filters: {
        symbols: symbols.rows.map((r: { symbol: string }) => r.symbol),
        strategies: strategies.rows,
        years: years.rows.map((r: { y: number }) => String(r.y)),
      },
      summary,
      equity,
      monthly,
      strategy_breakdown: breakdown,
      research,
      trades: tradesOut,
      total_trades: trades.length,
      returned: tradesOut.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Postgres error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

function round(n: number, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function signedPricePnl(trade: Pick<Trade, "direction" | "filled" | "close_price">, quantity: number) {
  if (trade.filled === null || trade.close_price === null) return null;
  const side = (trade.direction || "").toUpperCase() === "SELL" ? -1 : 1;
  return (trade.close_price - trade.filled) * side * quantity;
}

function applySizing(trade: Trade, sizing: SizingSettings): Trade {
  const stopDistance = trade.filled !== null && trade.stop !== null ? Math.abs(trade.filled - trade.stop) : null;
  const quantity = sizing.mode === "fixed_qty" ? sizing.quantity : stopDistance && stopDistance > 0 ? sizing.riskUsd / stopDistance : null;
  const riskUsd = sizing.mode === "fixed_qty" && stopDistance && stopDistance > 0 ? stopDistance * sizing.quantity : sizing.riskUsd;
  const pricePnl = quantity !== null ? signedPricePnl(trade, quantity) : null;
  const grossPnlUsd = sizing.mode === "fixed_qty" && pricePnl !== null ? pricePnl : trade.r * riskUsd;
  const entryNotional = quantity !== null && trade.filled !== null ? Math.abs(quantity * trade.filled) : 0;
  const exitNotional = quantity !== null && trade.close_price !== null ? Math.abs(quantity * trade.close_price) : entryNotional;
  const transactionCostUsd = (entryNotional + exitNotional) * (sizing.commissionBps + sizing.slippageBps) / 10000;
  const pnlUsd = grossPnlUsd - transactionCostUsd;
  const realizedR = riskUsd > 0 ? pnlUsd / riskUsd : trade.r;

  return {
    ...trade,
    r: round(realizedR),
    quantity: quantity === null ? null : round(quantity, 4),
    risk_usd: round(riskUsd),
    gross_pnl_usd: round(grossPnlUsd),
    transaction_cost_usd: round(transactionCostUsd),
    pnl_usd: round(pnlUsd),
  };
}

function computeMetrics(trades: Trade[], sizing: SizingSettings) {
  const n = trades.length;
  if (n === 0) {
    return { total: 0, sizing };
  }
  const rs = trades.map((t) => t.r);
  const pnls = trades.map((t) => t.pnl_usd ?? 0);
  const grossPnls = trades.map((t) => t.gross_pnl_usd ?? 0);
  const transactionCosts = trades.map((t) => t.transaction_cost_usd ?? 0);
  const wins = trades.filter((t) => (t.pnl_usd ?? 0) > 0);
  const losses = trades.filter((t) => (t.pnl_usd ?? 0) < 0);
  const grossProfit = wins.reduce((a, t) => a + t.r, 0);
  const grossLoss = losses.reduce((a, t) => a + t.r, 0); // negative
  const netR = grossProfit + grossLoss;
  const grossProfitUsd = wins.reduce((a, t) => a + (t.pnl_usd ?? 0), 0);
  const grossLossUsd = losses.reduce((a, t) => a + (t.pnl_usd ?? 0), 0);
  const netUsd = pnls.reduce((a, b) => a + b, 0);
  const mean = netR / n;
  const variance = rs.reduce((a, r) => a + (r - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const downside = losses.map((t) => t.r);
  const downsideVariance = downside.length
    ? downside.reduce((a, r) => a + Math.min(0, r - 0) ** 2, 0) / downside.length
    : 0;
  const downsideStd = Math.sqrt(downsideVariance);

  let cum = 0;
  let cumUsd = 0;
  let peak = 0;
  let peakUsd = 0;
  let maxDD = 0;
  let maxDDUsd = 0;
  let ddSquared = 0;
  for (let i = 0; i < rs.length; i += 1) {
    const r = rs[i];
    cum += r;
    if (cum > peak) peak = cum;
    const dd = cum - peak;
    if (dd < maxDD) maxDD = dd;
    ddSquared += dd ** 2;

    cumUsd += pnls[i];
    if (cumUsd > peakUsd) peakUsd = cumUsd;
    const ddUsd = cumUsd - peakUsd;
    if (ddUsd < maxDDUsd) maxDDUsd = ddUsd;
  }

  // Consecutive streaks
  let curW = 0;
  let curL = 0;
  let maxW = 0;
  let maxL = 0;
  for (const r of rs) {
    if (r > 0) {
      curW += 1;
      curL = 0;
      if (curW > maxW) maxW = curW;
    } else {
      curL += 1;
      curW = 0;
      if (curL > maxL) maxL = curL;
    }
  }

  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const holds = trades.map((t) => t.hold_min).filter((v): v is number => v !== null);
  const avgHold = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null;
  const sortedR = [...rs].sort((a, b) => a - b);
  const sortedUsd = [...pnls].sort((a, b) => a - b);
  const varR = sortedR[Math.max(0, Math.floor(sortedR.length * 0.05) - 1)] ?? 0;
  const varUsd = sortedUsd[Math.max(0, Math.floor(sortedUsd.length * 0.05) - 1)] ?? 0;
  const first = trades.find((t) => t.close_ts)?.close_ts;
  const last = [...trades].reverse().find((t) => t.close_ts)?.close_ts;
  const firstMs = first ? new Date(first).getTime() : null;
  const lastMs = last ? new Date(last).getTime() : null;
  const years =
    firstMs !== null && lastMs !== null && lastMs > firstMs
      ? Math.max((lastMs - firstMs) / (365.25 * 24 * 60 * 60 * 1000), 1 / 365)
      : 1;
  const initialCapital = sizing.initialCapital;
  const endingCapital = initialCapital + netUsd;
  const netProfitPct = (netUsd / initialCapital) * 100;
  const cagr = endingCapital > 0 ? ((endingCapital / initialCapital) ** (1 / years) - 1) * 100 : null;
  const annualReturn = netProfitPct / years;
  const maxDdPct = (maxDDUsd / initialCapital) * 100;
  const exposureMinutes = holds.reduce((a, b) => a + b, 0);
  const periodMinutes =
    firstMs !== null && lastMs !== null && lastMs > firstMs ? (lastMs - firstMs) / 60000 : exposureMinutes || 1;
  const exposurePct = Math.min(100, (exposureMinutes / periodMinutes) * 100);
  const ulcerIndex = Math.sqrt(ddSquared / n);
  const longTrades = trades.filter((t) => (t.direction || "").toUpperCase() === "BUY");
  const shortTrades = trades.filter((t) => (t.direction || "").toUpperCase() === "SELL");
  const quantities = trades.map((t) => t.quantity).filter((v): v is number => v !== null);
  const risks = trades.map((t) => t.risk_usd).filter((v): v is number => v !== null);

  return {
    sizing: {
      mode: sizing.mode,
      initial_capital: round(initialCapital),
      risk_usd: round(sizing.riskUsd),
      quantity: round(sizing.quantity, 4),
      commission_bps: round(sizing.commissionBps),
      slippage_bps: round(sizing.slippageBps),
    },
    initial_capital: round(initialCapital),
    ending_capital: round(endingCapital),
    net_profit_pct: round(netProfitPct),
    exposure_pct: round(exposurePct),
    cagr: cagr === null ? null : round(cagr),
    annual_return_pct: round(annualReturn),
    risk_adjusted_return_pct: std !== 0 ? round((mean / std) * 100) : null,
    total: n,
    wins: wins.length,
    losses: losses.length,
    long_trades: longTrades.length,
    short_trades: shortTrades.length,
    win_rate: round((wins.length / n) * 100, 1),
    net_r: round(netR),
    net_usd: round(netUsd),
    gross_pnl_before_costs_usd: round(grossPnls.reduce((a, b) => a + b, 0)),
    transaction_costs_usd: round(transactionCosts.reduce((a, b) => a + b, 0)),
    gross_profit_usd: round(grossProfitUsd),
    gross_loss_usd: round(grossLossUsd),
    gross_profit_r: round(grossProfit),
    gross_loss_r: round(grossLoss),
    profit_factor: grossLoss !== 0 ? round(grossProfit / Math.abs(grossLoss)) : null,
    expectancy_r: round(mean),
    expectancy_usd: round(netUsd / n),
    avg_win_r: round(avgWin),
    avg_loss_r: round(avgLoss),
    payoff_ratio: avgLoss !== 0 ? round(avgWin / Math.abs(avgLoss)) : null,
    largest_win_r: round(Math.max(...rs)),
    largest_loss_r: round(Math.min(...rs)),
    value_at_risk_r: round(varR),
    value_at_risk_usd: round(varUsd),
    best_win_usd: round(Math.max(...pnls)),
    worst_loss_usd: round(Math.min(...pnls)),
    max_consec_wins: maxW,
    max_consec_losses: maxL,
    max_trade_drawdown_r: round(Math.min(...rs)),
    max_drawdown_r: round(maxDD),
    max_drawdown_usd: round(maxDDUsd),
    max_drawdown_pct: round(maxDdPct),
    recovery_factor: maxDD !== 0 ? round(netR / Math.abs(maxDD)) : null,
    sharpe: std !== 0 ? round(mean / std) : null,
    sortino: downsideStd !== 0 ? round(mean / downsideStd) : null,
    calmar: maxDdPct !== 0 && cagr !== null ? round(cagr / Math.abs(maxDdPct)) : null,
    car_maxdd: maxDD !== 0 && cagr !== null ? round(cagr / Math.abs(maxDdPct || maxDD)) : null,
    rar_maxdd: maxDD !== 0 && std !== 0 ? round((mean / std) / Math.abs(maxDD)) : null,
    ulcer_index: round(ulcerIndex),
    k_ratio: std !== 0 ? round((netR / n) / std) : null,
    avg_hold_min: avgHold === null ? null : Math.round(avgHold),
    risk_usd: round(risks.length ? risks.reduce((a, b) => a + b, 0) / risks.length : sizing.riskUsd),
    avg_quantity: quantities.length ? round(quantities.reduce((a, b) => a + b, 0) / quantities.length, 2) : null,
    min_quantity: quantities.length ? round(Math.min(...quantities), 2) : null,
    max_quantity: quantities.length ? round(Math.max(...quantities), 2) : null,
    group_stats: {
      all: computeGroupStats(trades),
      long: computeGroupStats(longTrades),
      short: computeGroupStats(shortTrades),
    },
  };
}

function computeGroupStats(trades: Trade[]) {
  const n = trades.length;
  if (!n) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      win_rate: 0,
      net_r: 0,
      net_usd: 0,
      avg_r: 0,
      avg_win_r: 0,
      avg_loss_r: 0,
      largest_win_r: 0,
      largest_loss_r: 0,
      profit_factor: null,
    };
  }
  const rs = trades.map((t) => t.r);
  const wins = trades.filter((t) => t.r > 0);
  const losses = trades.filter((t) => t.r < 0);
  const net = rs.reduce((a, b) => a + b, 0);
  const netUsd = trades.reduce((a, t) => a + (t.pnl_usd ?? 0), 0);
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    win_rate: round((wins.length / n) * 100, 1),
    net_r: round(net),
    net_usd: round(netUsd),
    avg_r: round(net / n),
    avg_win_r: wins.length ? round(wins.reduce((a, t) => a + t.r, 0) / wins.length) : 0,
    avg_loss_r: losses.length ? round(losses.reduce((a, t) => a + t.r, 0) / losses.length) : 0,
    largest_win_r: round(Math.max(...rs)),
    largest_loss_r: round(Math.min(...rs)),
    profit_factor: losses.length ? round(wins.reduce((a, t) => a + t.r, 0) / Math.abs(losses.reduce((a, t) => a + t.r, 0))) : null,
  };
}

function buildEquity(trades: Trade[], initialCapital: number) {
  let cum = 0;
  let cumUsd = 0;
  let peak = 0;
  return trades.map((t, i) => {
    cum += t.r;
    cumUsd += t.pnl_usd ?? 0;
    if (cum > peak) peak = cum;
    return {
      i,
      t: t.close_ts ? Math.floor(new Date(t.close_ts).getTime() / 1000) : i,
      r: round(cum),
      balance: round(initialCapital + cumUsd),
      dd: round(cum - peak),
    };
  });
}

function buildMonthly(trades: Trade[]) {
  const map = new Map<string, { net_r: number; trades: number; wins: number }>();
  for (const t of trades) {
    if (!t.close_ts) continue;
    const d = new Date(t.close_ts);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const m = map.get(key) || { net_r: 0, trades: 0, wins: 0 };
    m.net_r += t.r;
    m.trades += 1;
    if (t.r > 0) m.wins += 1;
    map.set(key, m);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({ month, net_r: round(v.net_r), trades: v.trades, wins: v.wins }));
}

function buildStrategyBreakdown(trades: Trade[]) {
  const map = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = t.strategy_id || "—";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }
  return [...map.entries()]
    .map(([strategy_id, list]) => {
      const wins = list.filter((t) => t.r > 0);
      const gp = wins.reduce((a, t) => a + t.r, 0);
      const gl = list.filter((t) => t.r < 0).reduce((a, t) => a + t.r, 0);
      const netR = gp + gl;
      return {
        strategy_id,
        trades: list.length,
        win_rate: round((wins.length / list.length) * 100, 1),
        net_r: round(netR),
        expectancy_r: round(netR / list.length),
        profit_factor: gl !== 0 ? round(gp / Math.abs(gl)) : null,
      };
    })
    .sort((a, b) => b.net_r - a.net_r);
}

function researchStats(trades: Trade[]) {
  const stats = computeGroupStats(trades);
  const pnls = trades.map((trade) => trade.pnl_usd ?? 0);
  const mean = pnls.length ? pnls.reduce((sum, value) => sum + value, 0) / pnls.length : 0;
  const variance = pnls.length
    ? pnls.reduce((sum, value) => sum + (value - mean) ** 2, 0) / pnls.length
    : 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdownUsd = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdownUsd = Math.min(maxDrawdownUsd, equity - peak);
  }
  return {
    ...stats,
    expectancy_usd: round(mean),
    trade_sharpe: variance > 0 ? round(mean / Math.sqrt(variance)) : null,
    max_drawdown_usd: round(maxDrawdownUsd),
  };
}

function attributionRows(trades: Trade[], keyFor: (trade: Trade) => string) {
  const groups = new Map<string, Trade[]>();
  for (const trade of trades) {
    const key = keyFor(trade);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(trade);
  }
  return [...groups.entries()]
    .map(([label, rows]) => ({ label, ...researchStats(rows) }))
    .sort((a, b) => b.net_usd - a.net_usd);
}

function percentile(sorted: number[], probability: number) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * probability)));
  return sorted[index];
}

function createSeededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function monteCarlo(trades: Trade[], initialCapital: number) {
  const simulations = trades.length ? 500 : 0;
  const pnls = trades.map((trade) => trade.pnl_usd ?? 0);
  const random = createSeededRandom(16012026);
  const endingEquities: number[] = [];
  const maxDrawdowns: number[] = [];
  let losingPaths = 0;
  let drawdown20Paths = 0;

  for (let simulation = 0; simulation < simulations; simulation += 1) {
    let equity = initialCapital;
    let peak = initialCapital;
    let maxDrawdown = 0;
    for (let index = 0; index < pnls.length; index += 1) {
      equity += pnls[Math.floor(random() * pnls.length)];
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak - equity);
    }
    endingEquities.push(equity);
    maxDrawdowns.push(maxDrawdown);
    if (equity < initialCapital) losingPaths += 1;
    if (maxDrawdown >= initialCapital * 0.2) drawdown20Paths += 1;
  }

  endingEquities.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => a - b);
  return {
    method: "bootstrap_with_replacement",
    simulations,
    seed: 16012026,
    ending_equity_p05: round(percentile(endingEquities, 0.05)),
    ending_equity_p50: round(percentile(endingEquities, 0.5)),
    ending_equity_p95: round(percentile(endingEquities, 0.95)),
    max_drawdown_p50_usd: round(percentile(maxDrawdowns, 0.5)),
    max_drawdown_p95_usd: round(percentile(maxDrawdowns, 0.95)),
    probability_of_loss_pct: simulations ? round(losingPaths / simulations * 100, 1) : 0,
    probability_of_20pct_drawdown_pct: simulations ? round(drawdown20Paths / simulations * 100, 1) : 0,
  };
}

function buildResearch(trades: Trade[], sizing: SizingSettings, oosPct: number) {
  const splitIndex = trades.length
    ? Math.min(trades.length - 1, Math.max(1, Math.floor(trades.length * (1 - oosPct / 100))))
    : 0;
  const inSample = trades.slice(0, splitIndex);
  const outOfSample = trades.slice(splitIndex);
  const inStats = researchStats(inSample);
  const outStats = researchStats(outOfSample);
  const expectancyDegradation = inStats.expectancy_usd !== 0
    ? (1 - outStats.expectancy_usd / inStats.expectancy_usd) * 100
    : null;
  const missing = {
    filled_price: trades.filter((trade) => trade.filled === null).length,
    stoploss: trades.filter((trade) => trade.stop === null).length,
    close_price: trades.filter((trade) => trade.close_price === null).length,
    timestamps: trades.filter((trade) => !trade.filled_at || !trade.close_ts).length,
    quantity: trades.filter((trade) => trade.quantity === null).length,
  };
  const warnings: string[] = [];
  if (trades.length < 100) warnings.push("Sample contains fewer than 100 closed trades.");
  if (outOfSample.length < 30) warnings.push("Out-of-sample segment contains fewer than 30 trades.");
  if (Object.values(missing).some((count) => count > 0)) warnings.push("One or more critical execution fields are missing.");
  if (sizing.commissionBps + sizing.slippageBps === 0) warnings.push("Execution friction is disabled.");
  warnings.push("No spread, partial-fill, market-impact, borrow, tax, or regulatory-fee model is applied.");
  warnings.push("This is a chronological holdout, not parameter-optimized walk-forward validation.");

  const checks = [
    { id: "sample_size", label: "At least 100 closed trades", passed: trades.length >= 100 },
    { id: "oos_sample", label: "At least 30 out-of-sample trades", passed: outOfSample.length >= 30 },
    { id: "costs", label: "Commission and slippage enabled", passed: sizing.commissionBps + sizing.slippageBps > 0 },
    { id: "critical_fields", label: "Critical execution fields complete", passed: Object.values(missing).every((count) => count === 0) },
    { id: "oos_profitability", label: "Out-of-sample expectancy positive", passed: outStats.expectancy_usd > 0 },
    { id: "oos_profit_factor", label: "Out-of-sample profit factor above 1", passed: (outStats.profit_factor ?? 0) > 1 },
  ];
  const passedChecks = checks.filter((check) => check.passed).length;

  return {
    validation: {
      method: "chronological_holdout",
      oos_pct: oosPct,
      split_trade_index: splitIndex,
      split_timestamp: outOfSample[0]?.close_ts ?? null,
      in_sample: inStats,
      out_of_sample: outStats,
      expectancy_degradation_pct: expectancyDegradation === null ? null : round(expectancyDegradation),
    },
    monte_carlo: monteCarlo(trades, sizing.initialCapital),
    attribution: {
      by_year: attributionRows(trades, (trade) => trade.close_ts ? String(new Date(trade.close_ts).getUTCFullYear()) : "Unknown"),
      by_session: attributionRows(trades, (trade) => {
        if (!trade.filled_at) return "Unknown";
        const hour = new Date(trade.filled_at).getUTCHours();
        if (hour < 7) return "Asia 00-07 UTC";
        if (hour < 12) return "London 07-12 UTC";
        if (hour < 21) return "New York 12-21 UTC";
        return "Other 21-24 UTC";
      }),
      by_direction: attributionRows(trades, (trade) => (trade.direction || "Unknown").toUpperCase()),
      by_strategy: attributionRows(trades, (trade) => trade.strategy_id || "Unknown"),
    },
    data_quality: {
      status: warnings.length > 2 ? "REVIEW" : "PASS",
      closed_trades: trades.length,
      first_close_ts: trades.find((trade) => trade.close_ts)?.close_ts ?? null,
      last_close_ts: [...trades].reverse().find((trade) => trade.close_ts)?.close_ts ?? null,
      missing,
      warnings,
    },
    audit: {
      calculation_version: "research-v1",
      generated_at: new Date().toISOString(),
      source: "historical_ict_orders + historical_ict_order_target_outcomes",
      assumptions: [
        `${sizing.mode} sizing`,
        `${round(sizing.commissionBps)} bps commission plus ${round(sizing.slippageBps)} bps slippage on entry and exit notional`,
        "Closed TP and SL outcomes only",
        "Chronological ordering by close timestamp",
        "Monte Carlo resamples observed net trade P/L with replacement",
      ],
    },
    deployment_gate: {
      status: passedChecks === checks.length ? "RESEARCH_PASSED_REVIEW_REQUIRED" : "NOT_READY",
      passed_checks: passedChecks,
      total_checks: checks.length,
      checks,
      note: "This gate does not approve live capital. Risk, operations, and execution review remain mandatory.",
    },
  };
}
