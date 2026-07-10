import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TABLE = "public.historical_ict_strategy_met_execution";

function normalizeLimit(value: string | null) {
  const parsed = Number(value || 250);
  if (!Number.isFinite(parsed)) {
    return 250;
  }
  return Math.min(Math.max(Math.trunc(parsed), 1), 1000);
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const market = (sp.get("market") || "").trim().toLowerCase();
  const strategyId = (sp.get("strategy_id") || "").trim().toUpperCase();
  const direction = (sp.get("direction") || "").trim().toUpperCase();
  const ticker = (sp.get("ticker") || "").trim().toUpperCase();
  const dateFrom = (sp.get("date_from") || "").trim();
  const dateTo = (sp.get("date_to") || "").trim();
  const target = ["1", "2", "3"].includes((sp.get("target") || "1").trim())
    ? (sp.get("target") || "1").trim()
    : "1";
  const limit = normalizeLimit(sp.get("limit"));

  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (market && market !== "all") {
    params.push(market);
    conditions.push(`LOWER(market) = $${params.length}`);
  }
  if (strategyId && strategyId !== "ALL") {
    params.push(strategyId);
    conditions.push(`UPPER(strategy_id) = $${params.length}`);
  }
  if (direction && direction !== "ALL") {
    params.push(direction);
    conditions.push(`UPPER(direction) = $${params.length}`);
  }
  if (ticker) {
    params.push(`%${ticker}%`);
    const p = params.length;
    conditions.push(`(UPPER(ticker) LIKE $${p} OR UPPER(base_symbol) LIKE $${p})`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`entry_date >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`entry_date <= $${params.length}::date`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const targetCol = `target_${target}`;

  try {
    const pool = getPostgresPool();

    // Filter option lists (unfiltered, for the dropdowns)
    const optionsQ = pool.query(
      `
      SELECT strategy_id, MIN(strategy) AS strategy, COUNT(*)::int AS signal_count
      FROM ${TABLE}
      WHERE strategy_id IS NOT NULL
      GROUP BY strategy_id
      ORDER BY
        CASE WHEN strategy_id LIKE 'S-CH%' THEN 2 ELSE 1 END,
        NULLIF(regexp_replace(strategy_id, '[^0-9]', '', 'g'), '')::int NULLS LAST
      `,
    );
    const marketsQ = pool.query(
      `
      SELECT market, COUNT(*)::int AS signal_count
      FROM ${TABLE}
      WHERE market IS NOT NULL
      GROUP BY market
      ORDER BY market
      `,
    );

    // KPI summary (respects filters)
    const summaryQ = pool.query(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE UPPER(direction) = 'BUY')::int AS buys,
        COUNT(*) FILTER (WHERE UPPER(direction) = 'SELL')::int AS sells,
        COUNT(DISTINCT ticker)::int AS tickers,
        COUNT(DISTINCT strategy_id)::int AS strategies,
        MIN(entry_date) AS first_date,
        MAX(entry_date) AS last_date,
        AVG(ABS(entry_price - stoploss)) FILTER (
          WHERE entry_price <> 'NaN'::float8 AND stoploss <> 'NaN'::float8
        ) AS avg_risk_points,
        AVG(
          CASE WHEN UPPER(direction) = 'SELL' THEN entry_price - ${targetCol}
               ELSE ${targetCol} - entry_price END
        ) FILTER (
          WHERE entry_price <> 'NaN'::float8 AND ${targetCol} <> 'NaN'::float8
        ) AS avg_reward_points
      FROM ${TABLE}
      ${where}
      `,
      params,
    );

    // Strategy breakdown (respects filters)
    const breakdownQ = pool.query(
      `
      SELECT strategy_id, MIN(strategy) AS strategy, COUNT(*)::int AS signals,
        COUNT(*) FILTER (WHERE UPPER(direction) = 'BUY')::int AS buys,
        COUNT(*) FILTER (WHERE UPPER(direction) = 'SELL')::int AS sells,
        COUNT(DISTINCT ticker)::int AS tickers,
        AVG(ABS(entry_price - stoploss)) FILTER (
          WHERE entry_price <> 'NaN'::float8 AND stoploss <> 'NaN'::float8
        ) AS avg_risk_points
      FROM ${TABLE}
      ${where}
      GROUP BY strategy_id
      ORDER BY signals DESC, strategy_id
      `,
      params,
    );

    // Signal ledger rows (respects filters)
    const rowsQ = pool.query(
      `
      SELECT market, ticker, base_symbol, company_name, direction,
        entry_datetime, entry_date, strategy_id, strategy, strategy_key,
        entry_price, stoploss, target_1, target_2, target_3,
        target_model, weekly_bias, daily_bias, one_hour_bias,
        strategy_json, updated_timestamp
      FROM ${TABLE}
      ${where}
      ORDER BY entry_datetime DESC NULLS LAST
      LIMIT $${params.length + 1}
      `,
      [...params, limit],
    );

    const [options, markets, summaryRes, breakdown, rows] = await Promise.all([
      optionsQ,
      marketsQ,
      summaryQ,
      breakdownQ,
      rowsQ,
    ]);

    const summary = summaryRes.rows[0] || {};
    const risk = Number(summary.avg_risk_points) || 0;
    const reward = Number(summary.avg_reward_points) || 0;
    summary.avg_risk_points = Number.isFinite(risk) && risk ? risk : null;
    summary.avg_reward_points = Number.isFinite(reward) && reward ? reward : null;
    summary.planned_reward_risk =
      Number.isFinite(risk) && risk ? Math.round((reward / risk) * 100) / 100 : null;

    return NextResponse.json({
      success: true,
      source: "postgres",
      filters: {
        markets: markets.rows,
        strategies: options.rows,
      },
      summary,
      strategy_breakdown: breakdown.rows,
      rows: rows.rows,
      returned: rows.rowCount,
      limit,
      target,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Postgres error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
