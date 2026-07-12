import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool, hasPostgresConfig } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Row = Record<string, unknown>;

const SORT_FIELDS: Record<string, string> = {
  entry_datetime: "entry_datetime",
  market: "market",
  ticker: "ticker",
  strategy_id: "strategy_id",
  direction: "direction",
  state: "state",
  realized_r: "realized_r",
};

function n(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function outcome(state: string, realizedR: number | null) {
  const upper = state.toUpperCase();
  if (upper === "OPEN" || upper.includes("PENDING") || upper === "FILLED") return "OPEN";
  if (upper === "CLOSED_TP") return "WIN";
  if (upper === "CLOSED_SL") return "LOSS";
  if (upper.startsWith("CLOSED")) {
    if (realizedR === null || Math.abs(realizedR) < 0.000001) return "BREAKEVEN";
    return realizedR > 0 ? "WIN" : "LOSS";
  }
  return upper ? "UNKNOWN" : "SIGNAL_ONLY";
}

function marketTimezone(market: string, exchangeTimezone: string) {
  if (exchangeTimezone) return exchangeTimezone;
  return market.toLowerCase() === "india" ? "Asia/Kolkata" : "America/New_York";
}

function localDate(value: unknown, timezone: string) {
  if (!value) return "";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function stats(rows: Row[]) {
  const closed = rows.filter((row) => ["WIN", "LOSS", "BREAKEVEN"].includes(text(row.outcome)));
  const wins = closed.filter((row) => text(row.outcome) === "WIN");
  const losses = closed.filter((row) => text(row.outcome) === "LOSS");
  const rValues = closed.map((row) => n(row.realized_r)).filter((value): value is number => value !== null);
  const grossWin = rValues.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(rValues.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const netR = rValues.reduce((sum, value) => sum + value, 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of rValues) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  const daily = new Map<string, number>();
  for (const row of closed) {
    const key = text(row.local_date);
    if (key) daily.set(key, (daily.get(key) ?? 0) + (n(row.realized_r) ?? 0));
  }
  const dailyValues = [...daily.values()];
  const dailyMean = dailyValues.length ? dailyValues.reduce((sum, value) => sum + value, 0) / dailyValues.length : null;
  const variance = dailyValues.length > 1 && dailyMean !== null
    ? dailyValues.reduce((sum, value) => sum + (value - dailyMean) ** 2, 0) / (dailyValues.length - 1)
    : null;
  const sharpe = variance && variance > 0 && dailyMean !== null ? dailyMean / Math.sqrt(variance) * Math.sqrt(252) : null;
  const buy = closed.filter((row) => text(row.direction).toUpperCase() === "BUY");
  const sell = closed.filter((row) => text(row.direction).toUpperCase() === "SELL");
  const wr = (items: Row[]) => items.length ? 100 * items.filter((row) => text(row.outcome) === "WIN").length / items.length : null;

  return {
    outcomes: closed.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: closed.length - wins.length - losses.length,
    win_rate_pct: closed.length ? round(100 * wins.length / closed.length) : null,
    buy_win_rate_pct: wr(buy) === null ? null : round(wr(buy)!),
    sell_win_rate_pct: wr(sell) === null ? null : round(wr(sell)!),
    profit_factor: grossLoss > 0 ? round(grossWin / grossLoss) : grossWin > 0 ? null : null,
    net_r: round(netR),
    expectancy_r: rValues.length ? round(netR / rValues.length) : null,
    avg_win_r: wins.length ? round(wins.reduce((sum, row) => sum + (n(row.realized_r) ?? 0), 0) / wins.length) : null,
    max_drawdown_r: round(maxDrawdown),
    sharpe_daily_r: sharpe === null ? null : round(sharpe),
  };
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const market = (sp.get("market") || "ALL").trim();
  const ticker = (sp.get("ticker") || "ALL").trim().toUpperCase();
  const strategy = (sp.get("strategy") || "ALL").trim().toUpperCase();
  const direction = (sp.get("direction") || "ALL").trim().toUpperCase();
  const status = (sp.get("status") || "ALL").trim().toUpperCase();
  const dateFrom = (sp.get("date_from") || "").trim();
  const dateTo = (sp.get("date_to") || "").trim();
  const page = Math.max(1, Number(sp.get("page") || 1));
  const pageSize = Math.min(100, Math.max(10, Number(sp.get("page_size") || 25)));
  const sort = SORT_FIELDS[sp.get("sort") || "entry_datetime"] || "entry_datetime";
  const order = sp.get("order") === "asc" ? "asc" : "desc";

  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace("?", `$${params.length}`));
  };
  if (market !== "ALL") add("LOWER(s.market) = LOWER(?)", market);
  if (ticker !== "ALL") add("UPPER(s.ticker) = UPPER(?)", ticker);
  if (strategy !== "ALL") add("UPPER(s.strategy_id) = UPPER(?)", strategy);
  if (direction !== "ALL") add("UPPER(s.direction) = UPPER(?)", direction);
  if (status === "OPEN") conditions.push("o.state = 'OPEN'");
  if (status === "COMPLETED") conditions.push("o.state LIKE 'CLOSED%'");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    // Source raw rows either directly from Postgres or, when the app is deployed
    // without DB access (e.g. Vercel), from the local REST API bridge. All the
    // timezone-aware aggregation below runs identically on either source.
    let rawRows: Record<string, unknown>[];
    const restApiUrl = process.env.CANDLES_REST_API_URL;
    if (!hasPostgresConfig() && restApiUrl) {
      const upstream = new URL("/api/realtime-analytics/rows", restApiUrl);
      for (const [key, value] of sp.entries()) upstream.searchParams.set(key, value);
      const upstreamResponse = await fetch(upstream, {
        headers: process.env.CANDLES_REST_API_TOKEN ? { "x-api-key": process.env.CANDLES_REST_API_TOKEN } : undefined,
        cache: "no-store",
      });
      const payload = await upstreamResponse.json();
      if (!upstreamResponse.ok || payload?.success === false) {
        return NextResponse.json({ success: false, error: payload?.error || `REST API error (${upstreamResponse.status})` }, { status: upstreamResponse.ok ? 502 : upstreamResponse.status });
      }
      rawRows = (payload.rows ?? []) as Record<string, unknown>[];
    } else {
      const pool = getPostgresPool();
      const result = await pool.query(
        `SELECT
           s.signal_hash, s.market, s.ticker, s.base_symbol, s.company_name,
           s.exchange_timezone, s.direction, s.entry_datetime, s.entry_date,
           s.strategy_id, s.strategy, s.strategy_key, s.entry_price AS signal_entry_price,
           s.stoploss AS signal_stoploss, s.target_1, s.target_2, s.target_3, s.as_of_ts,
           o.order_id, o.state, o.order_type, o.qty, o.entry_price, o.filled_price,
           o.stoploss, o.tp1, o.tp2, o.tp3, o.filled_at, o.close_price, o.close_ts,
           o.close_reason, o.updated_at
         FROM realtime_production_ict_strategy_met_execution s
         LEFT JOIN realtime_production_orders o ON o.signal_id = s.signal_hash
         ${where}
         ORDER BY s.entry_datetime DESC NULLS LAST
         LIMIT 10000`,
        params,
      );
      rawRows = result.rows as Record<string, unknown>[];
    }

    const normalizedAll = rawRows.map((raw): Row => {
      const entry = n(raw.filled_price) ?? n(raw.entry_price) ?? n(raw.signal_entry_price);
      const stop = n(raw.stoploss) ?? n(raw.signal_stoploss);
      const close = n(raw.close_price);
      const directionUpper = text(raw.direction).toUpperCase();
      const riskPoints = entry !== null && stop !== null ? Math.abs(entry - stop) : null;
      const pnlPoints = entry !== null && close !== null
        ? (directionUpper === "SELL" ? entry - close : close - entry)
        : null;
      const realizedR = riskPoints && riskPoints > 0 && pnlPoints !== null ? pnlPoints / riskPoints : null;
      const plannedRr = riskPoints && riskPoints > 0 && n(raw.target_1) !== null && entry !== null
        ? Math.abs(n(raw.target_1)! - entry) / riskPoints
        : null;
      const timezone = marketTimezone(text(raw.market), text(raw.exchange_timezone));
      const local = localDate(raw.filled_at ?? raw.entry_datetime, timezone);
      const state = text(raw.state);
      const rowOutcome = outcome(state, realizedR);
      const qty = n(raw.qty);
      return {
        ...raw,
        entry_price: entry,
        stoploss: stop,
        tp1: n(raw.tp1) ?? n(raw.target_1),
        tp2: n(raw.tp2) ?? n(raw.target_2),
        tp3: n(raw.tp3) ?? n(raw.target_3),
        risk_points: riskPoints === null ? null : round(riskPoints, 4),
        planned_rr: plannedRr === null ? null : round(plannedRr),
        pnl_points: pnlPoints === null ? null : round(pnlPoints, 4),
        realized_r: realizedR === null ? null : round(realizedR),
        pnl_value: qty && qty > 0 && pnlPoints !== null ? round(qty * pnlPoints) : null,
        outcome: rowOutcome,
        timezone,
        local_date: local,
      };
    });
    // Apply date boundaries after converting each row to its market-local trading
    // date. PostgreSQL session dates would otherwise shift India/US rows around
    // midnight and disagree with the IST/ET dates shown in the interface.
    const normalized = normalizedAll.filter((row) => {
      const date = text(row.local_date);
      if (!date) return !dateFrom && !dateTo;
      if (dateFrom && date < dateFrom) return false;
      if (dateTo && date > dateTo) return false;
      return true;
    });

    const performanceRows = normalized.filter((row) => row.order_id);
    const latestByMarket: Record<string, { market: string; timezone: string; date: string; orders: number; last_7_days: number; last_30_days: number }> = {};
    for (const row of performanceRows) {
      const key = text(row.market).toLowerCase() || "unknown";
      const date = text(row.local_date);
      if (!date) continue;
      if (!latestByMarket[key] || date > latestByMarket[key].date) {
        latestByMarket[key] = { market: text(row.market), timezone: text(row.timezone), date, orders: 0, last_7_days: 0, last_30_days: 0 };
      }
    }
    for (const item of Object.values(latestByMarket)) {
      const marketRows = performanceRows.filter((row) => text(row.market).toLowerCase() === item.market.toLowerCase());
      item.orders = marketRows.filter((row) => text(row.local_date) === item.date).length;
      item.last_7_days = marketRows.filter((row) => {
        const diff = daysBetween(text(row.local_date), item.date);
        return diff >= 0 && diff < 7;
      }).length;
      item.last_30_days = marketRows.filter((row) => {
        const diff = daysBetween(text(row.local_date), item.date);
        return diff >= 0 && diff < 30;
      }).length;
    }

    const dailyMap = new Map<string, { date: string; signals: number; buy: number; sell: number; net_r: number; wins: number; losses: number }>();
    for (const row of normalized) {
      const date = text(row.local_date) || localDate(row.entry_datetime, text(row.timezone));
      if (!date) continue;
      const item = dailyMap.get(date) ?? { date, signals: 0, buy: 0, sell: 0, net_r: 0, wins: 0, losses: 0 };
      item.signals += 1;
      item.buy += text(row.direction).toUpperCase() === "BUY" ? 1 : 0;
      item.sell += text(row.direction).toUpperCase() === "SELL" ? 1 : 0;
      item.net_r += n(row.realized_r) ?? 0;
      item.wins += row.outcome === "WIN" ? 1 : 0;
      item.losses += row.outcome === "LOSS" ? 1 : 0;
      dailyMap.set(date, item);
    }
    const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map((item) => ({ ...item, net_r: round(item.net_r), win_rate_pct: item.wins + item.losses ? round(100 * item.wins / (item.wins + item.losses)) : null }));
    let cumulative = 0;
    const equity = daily.map((item) => ({ date: item.date, daily_r: item.net_r, equity_r: round(cumulative += item.net_r) }));

    const weekdayMap = new Map<string, number>();
    for (const item of daily) {
      const weekday = new Date(`${item.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short" });
      weekdayMap.set(weekday, (weekdayMap.get(weekday) ?? 0) + item.net_r);
    }
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri"].map((day) => ({ day, net_r: round(weekdayMap.get(day) ?? 0) }));

    const monthMap = new Map<string, { month: string; signals: number; wins: number; losses: number; net_r: number }>();
    for (const item of daily) {
      const key = item.date.slice(0, 7);
      const month = monthMap.get(key) ?? { month: key, signals: 0, wins: 0, losses: 0, net_r: 0 };
      month.signals += item.signals; month.wins += item.wins; month.losses += item.losses; month.net_r += item.net_r;
      monthMap.set(key, month);
    }
    const monthly = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month)).map((item) => ({ ...item, net_r: round(item.net_r), win_rate_pct: item.wins + item.losses ? round(100 * item.wins / (item.wins + item.losses)) : null }));

    const groups = new Map<string, Row[]>();
    for (const row of normalized) {
      const key = text(row.strategy_id) || "Unknown";
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const strategyPerformance = [...groups.entries()].map(([strategyId, rows]) => ({ strategy_id: strategyId, strategy_name: text(rows[0]?.strategy), orders: rows.filter((row) => row.order_id).length, ...stats(rows.filter((row) => row.order_id)) })).sort((a, b) => b.orders - a.orders);
    const totalSignals = Math.max(normalized.length, 1);
    const strategyCoverage = [...groups.entries()].map(([strategyId, rows]) => ({
      strategy_id: strategyId,
      strategy_name: text(rows[0]?.strategy),
      signals: rows.length,
      buy: rows.filter((row) => text(row.direction).toUpperCase() === "BUY").length,
      sell: rows.filter((row) => text(row.direction).toUpperCase() === "SELL").length,
      tickers: new Set(rows.map((row) => text(row.ticker))).size,
      avg_risk_points: rows.some((row) => n(row.risk_points) !== null) ? round(rows.reduce((sum, row) => sum + (n(row.risk_points) ?? 0), 0) / rows.filter((row) => n(row.risk_points) !== null).length, 4) : null,
      share_pct: round(100 * rows.length / totalSignals),
    })).sort((a, b) => b.signals - a.signals);

    const rrBins = [
      { label: "Loss <= -1R", min: -Infinity, max: -1 },
      { label: "-1R to 0R", min: -1, max: 0 },
      { label: "0R to 1R", min: 0, max: 1 },
      { label: "1R to 2R", min: 1, max: 2 },
      { label: "2R to 3R", min: 2, max: 3 },
      { label: "3R+", min: 3, max: Infinity },
    ].map((bin) => ({ label: bin.label, count: performanceRows.filter((row) => {
      const value = n(row.realized_r);
      return value !== null && value >= bin.min && value < bin.max;
    }).length }));

    const sortValue = (row: Row) => sort === "realized_r" ? n(row.realized_r) ?? -Infinity : text(row[sort]);
    const sorted = [...normalized].sort((a, b) => {
      const av = sortValue(a); const bv = sortValue(b);
      const comparison = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return order === "asc" ? comparison : -comparison;
    });
    const start = (page - 1) * pageSize;

    return NextResponse.json({
      success: true,
      generated_at: new Date().toISOString(),
      data_as_of: normalized[0]?.entry_datetime ?? null,
      calculation_version: "realtime-analytics-v1",
      filters: {
        markets: [...new Set(normalized.map((row) => text(row.market)).filter(Boolean))].sort(),
        tickers: [...new Set(normalized.map((row) => text(row.ticker)).filter(Boolean))].sort(),
        strategies: [...new Set(normalized.map((row) => text(row.strategy_id)).filter(Boolean))].sort(),
      },
      query: { market, ticker, strategy, direction, status, date_from: dateFrom, date_to: dateTo, page, page_size: pageSize, sort, order },
      counts: { latest_by_market: Object.values(latestByMarket), signals: normalized.length, orders: performanceRows.length, open: performanceRows.filter((row) => row.outcome === "OPEN").length, completed: performanceRows.filter((row) => ["WIN", "LOSS", "BREAKEVEN"].includes(text(row.outcome))).length },
      summary: { strategies: new Set(normalized.map((row) => row.strategy_id)).size, tickers: new Set(normalized.map((row) => row.ticker)).size, buy_setups: normalized.filter((row) => text(row.direction).toUpperCase() === "BUY").length, sell_setups: normalized.filter((row) => text(row.direction).toUpperCase() === "SELL").length, avg_risk_points: normalized.some((row) => n(row.risk_points) !== null) ? round(normalized.reduce((sum, row) => sum + (n(row.risk_points) ?? 0), 0) / normalized.filter((row) => n(row.risk_points) !== null).length, 4) : null, avg_planned_rr: normalized.some((row) => n(row.planned_rr) !== null) ? round(normalized.reduce((sum, row) => sum + (n(row.planned_rr) ?? 0), 0) / normalized.filter((row) => n(row.planned_rr) !== null).length) : null, ...stats(performanceRows) },
      series: { daily, monthly, equity, weekdays, rr_distribution: rrBins },
      strategy_performance: strategyPerformance,
      strategy_coverage: strategyCoverage,
      open_orders: performanceRows.filter((row) => row.outcome === "OPEN").slice(0, 100),
      outcomes_ledger: performanceRows.filter((row) => ["WIN", "LOSS", "BREAKEVEN"].includes(text(row.outcome))).slice(0, 200),
      pagination: { page, page_size: pageSize, total: normalized.length, pages: Math.max(1, Math.ceil(normalized.length / pageSize)) },
      rows: sorted.slice(start, start + pageSize),
      warnings: ["Performance metrics use internal realtime orders, not broker fills.", "Currency P&L is unavailable when stored quantity is zero; R and points remain available.", "Sharpe is annualized from daily realized R."],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Postgres error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
