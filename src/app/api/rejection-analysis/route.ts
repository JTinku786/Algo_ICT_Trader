import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Row = Record<string, unknown>;

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rounded(value: number, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function summarize(outcomes: Row[]) {
  return [1, 2, 3].map((targetNo) => {
    const targetRows = outcomes.filter((row) => Number(row.target_no) === targetNo);
    const resolved = targetRows.filter((row) => row.outcome === "WIN" || row.outcome === "LOSS");
    const wins = resolved.filter((row) => row.outcome === "WIN").length;
    const sum = (key: string) => rounded(resolved.reduce((total, row) => total + (numeric(row[key]) ?? 0), 0));
    const netR = sum("net_r");
    return {
      target_no: targetNo,
      original_rr_avg: targetRows.length
        ? rounded(targetRows.reduce((total, row) => total + (numeric(row.original_rr) ?? 0), 0) / targetRows.length)
        : null,
      valid: targetRows.length,
      resolved: resolved.length,
      wins,
      losses: resolved.length - wins,
      ambiguous: targetRows.filter((row) => row.outcome === "AMBIGUOUS").length,
      open: targetRows.filter((row) => row.outcome === "OPEN").length,
      win_rate_pct: resolved.length ? rounded(100 * wins / resolved.length, 2) : null,
      gross_r: sum("gross_r"),
      cost_r: sum("cost_r"),
      net_r: netR,
      expectancy_r: resolved.length ? rounded(netR / resolved.length) : null,
      cycle_net_r: sum("cycle_net_r"),
    };
  });
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const market = (sp.get("market") || "ALL").trim().toLowerCase();
  const tickers = (sp.get("ticker") || "ALL")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value && value !== "ALL");
  const strategies = (sp.get("strategy") || "ALL")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value && value.toUpperCase() !== "ALL");
  const direction = (sp.get("direction") || "ALL").trim().toUpperCase();
  const dateFrom = (sp.get("date_from") || "").trim();
  const dateTo = (sp.get("date_to") || "").trim();
  const requestedCutoff = (sp.get("reentry_cutoff") || "ALL").trim();
  const reentryCutoff = /^(13:00|15:00|15:15|15:30|15:45)$/.test(requestedCutoff) ? requestedCutoff : "ALL";
  const requestedMinParentMinutes = numeric(sp.get("min_parent_minutes"));
  const minParentMinutes = requestedMinParentMinutes !== null && requestedMinParentMinutes >= 0
    ? requestedMinParentMinutes
    : null;
  const requestedProgressOperator = (sp.get("progress_op") || "ALL").trim().toLowerCase();
  const progressOperator = ["gte", "lte"].includes(requestedProgressOperator) ? requestedProgressOperator : "ALL";
  const requestedProgressPct = numeric(sp.get("progress_pct"));
  const progressPct = requestedProgressPct !== null && requestedProgressPct >= 0 ? requestedProgressPct : null;
  const requestedVolatilityMetric = (sp.get("volatility_metric") || "ALL").trim().toLowerCase();
  const volatilityColumns: Record<string, string> = {
    atr_pct: "o.stop_candle_atr_pct",
    range_atr: "o.stop_candle_range_atr",
    penetration_r: "o.stop_close_penetration_r",
  };
  const volatilityMetric = volatilityColumns[requestedVolatilityMetric] ? requestedVolatilityMetric : "ALL";
  const requestedVolatilityOperator = (sp.get("volatility_op") || "ALL").trim().toLowerCase();
  const volatilityOperator = ["gte", "lte"].includes(requestedVolatilityOperator)
    ? requestedVolatilityOperator
    : "ALL";
  const volatilityValue = numeric(sp.get("volatility_value"));

  try {
    const pool = getPostgresPool();
    const runResult = await pool.query<Row>(
      `SELECT * FROM ict_rejection_trade_runs
       WHERE strategy_id='LIVE_MULTI' AND source='realtime_orders' AND status='COMPLETED'
       ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
    );
    if (!runResult.rows.length) {
      return NextResponse.json({
        success: false,
        error: "No completed multi-strategy rejection analysis is stored. Run scripts/build_ict_rejection_trades.py first.",
      }, { status: 503 });
    }

    const run = runResult.rows[0];
    const conditions = ["o.run_id = $1"];
    const params: unknown[] = [run.run_id];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replace("?", `$${params.length}`));
    };
    if (market !== "all") add("LOWER(o.market) = ?", market);
    if (tickers.length) add("UPPER(o.ticker) = ANY(?::text[])", tickers);
    if (strategies.length) add("o.strategy_id = ANY(?::text[])", strategies);
    if (["BUY", "SELL"].includes(direction)) add("UPPER(o.parent_direction) = ?", direction);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) add("o.parent_filled_at::date >= ?::date", dateFrom);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) add("o.parent_filled_at::date <= ?::date", dateTo);
    if (reentryCutoff !== "ALL") {
      add(`timezone(
        CASE WHEN LOWER(o.market) = 'india' THEN 'Asia/Kolkata' ELSE 'America/New_York' END,
        o.rejection_entry_at
      )::time <= ?::time`, reentryCutoff);
    }
    if (minParentMinutes !== null) {
      add("EXTRACT(EPOCH FROM (o.rejection_entry_at - o.parent_filled_at)) / 60.0 >= ?::double precision", minParentMinutes);
    }
    if (progressPct !== null && progressOperator !== "ALL") {
      add(`o.parent_tp1_progress_pct ${progressOperator === "gte" ? ">=" : "<="} ?::double precision`, progressPct);
    }
    if (volatilityMetric !== "ALL" && volatilityOperator !== "ALL" && volatilityValue !== null) {
      add(`${volatilityColumns[volatilityMetric]} ${volatilityOperator === "gte" ? ">=" : "<="} ?::double precision`, volatilityValue);
    }
    const where = conditions.join(" AND ");

    const [ordersResult, outcomesResult] = await Promise.all([
      pool.query<Row>(
        `SELECT o.* FROM ict_rejection_trade_orders o
         WHERE ${where} ORDER BY o.parent_filled_at DESC, o.parent_order_id`,
        params,
      ),
      pool.query<Row>(
        `SELECT t.* FROM ict_rejection_trade_target_outcomes t
         JOIN ict_rejection_trade_orders o
           ON o.run_id=t.run_id AND o.parent_order_id=t.parent_order_id
         WHERE ${where} ORDER BY o.parent_filled_at DESC, t.target_no`,
        params,
      ),
    ]);

    const outcomeMap = new Map<string, Row[]>();
    for (const row of outcomesResult.rows) {
      const key = String(row.parent_order_id);
      const values = outcomeMap.get(key) ?? [];
      values.push(row);
      outcomeMap.set(key, values);
    }
    const trades = ordersResult.rows.map((row) => ({
      ...row,
      outcomes: outcomeMap.get(String(row.parent_order_id)) ?? [],
    }));
    const validRows = ordersResult.rows.filter((row) => row.analysis_status === "VALID");
    const valid = validRows.length;
    const recordedStoplosses = validRows.filter((row) => row.parent_close_reason === "hit_stoploss").length;
    const candleConfirmedReconciliations = validRows.filter(
      (row) => row.parent_close_reason === "broker_position_already_closed",
    ).length;
    const marketSummary = [...new Set(ordersResult.rows.map((row) => String(row.market)))].map((marketName) => {
      const orderIds = new Set(
        ordersResult.rows
          .filter((row) => row.market === marketName)
          .map((row) => String(row.parent_order_id)),
      );
      return {
        market: marketName,
        trades: orderIds.size,
        targets: summarize(outcomesResult.rows.filter((row) => orderIds.has(String(row.parent_order_id)))),
      };
    });
    const strategySummary = [...new Set(ordersResult.rows.map((row) => String(row.strategy_id)))].map((strategyId) => {
      const orderIds = new Set(
        ordersResult.rows
          .filter((row) => row.strategy_id === strategyId)
          .map((row) => String(row.parent_order_id)),
      );
      return {
        strategy_id: strategyId,
        trades: orderIds.size,
        targets: summarize(outcomesResult.rows.filter((row) => orderIds.has(String(row.parent_order_id)))),
      };
    });

    return NextResponse.json({
      success: true,
      generated_at: new Date().toISOString(),
      storage: "ict_rejection_trade_*",
      run: {
        run_id: run.run_id,
        strategy_id: run.strategy_id,
        strategy_ids: run.strategy_ids,
        markets: run.markets,
        date_from: run.date_from,
        date_to: run.date_to,
        completed_at: run.completed_at,
        candle_timeframe: run.candle_timeframe,
        cost_bps_per_side: numeric(run.cost_bps_per_side),
        details: run.details,
      },
      filters: {
        market,
        tickers,
        strategies,
        available_strategies: run.strategy_ids,
        direction,
        date_from: dateFrom,
        date_to: dateTo,
        reentry_cutoff: reentryCutoff,
        reentry_cutoff_policy: "ET for US/forex; IST for India",
        min_parent_minutes: minParentMinutes,
        progress_operator: progressOperator,
        progress_pct: progressPct,
        volatility_metric: volatilityMetric,
        volatility_operator: volatilityOperator,
        volatility_value: volatilityValue,
      },
      counts: {
        stored_trades: ordersResult.rows.length,
        valid_reversals: valid,
        recorded_stoplosses: recordedStoplosses,
        candle_confirmed_reconciliations: candleConfirmedReconciliations,
        excluded_non_price_stops: ordersResult.rows.filter((row) => row.analysis_status === "EXCLUDED_NON_PRICE_STOP").length,
        invalid_input: ordersResult.rows.filter((row) => row.analysis_status === "INVALID_INPUT").length,
        invalid_geometry: ordersResult.rows.filter((row) => row.analysis_status === "INVALID_GEOMETRY").length,
        missing_stop_candle: ordersResult.rows.filter((row) => row.analysis_status === "NO_STOP_CANDLE").length,
      },
      target_summary: summarize(outcomesResult.rows),
      market_summary: marketSummary,
      strategy_summary: strategySummary,
      trades,
      warnings: [
        "Stored research output only. The page never computes a rejection entry or submits an order.",
        "The parent lesson uses completed 5-minute candles after the parent fill and strictly before the stop/rejection candle; the trigger candle is excluded.",
        "Results use completed 5-minute OHLC candles; same-candle stop/target collisions remain AMBIGUOUS.",
        "Broker-position reconciliation closures are included only when the recorded close equals the parent stop and a completed 5-minute candle confirms the stop touch.",
        "Cycle net R includes the parent -1R and rejection-leg costs, but excludes unavailable parent execution costs.",
        "No latency, spread widening, market impact, tax, or broker rejection is modeled beyond stored bps costs.",
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown rejection-analysis error";
    const missingTable = message.includes("ict_rejection_trade_runs");
    return NextResponse.json({
      success: false,
      error: missingTable
        ? "Rejection analysis tables are not installed. Run scripts/build_ict_rejection_trades.py first."
        : message,
    }, { status: missingTable ? 503 : 500 });
  }
}
