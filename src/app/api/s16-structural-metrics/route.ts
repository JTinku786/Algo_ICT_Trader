import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const pool = getPostgresPool();
  try {
    const snapshotResult = await pool.query(`
      SELECT metric_version AS "metricVersion",
             strategy_id AS "strategyId",
             market,
             identity_name AS "identityName",
             identity_definition AS "identityDefinition",
             calculated_at AS "calculatedAt",
             source_row_count AS "sourceRowCount",
             unique_setups AS "uniqueSetups",
             fully_resolved AS "fullyResolved",
             missed_entries AS "missedEntries",
             open_orders AS "openOrders",
             status,
             source_hash AS "sourceHash",
             metadata
      FROM research_strategy_metric_snapshots
      WHERE strategy_id = 'S16' AND market = 'us'
      ORDER BY calculated_at DESC
      LIMIT 1
    `);
    if (!snapshotResult.rowCount) {
      return NextResponse.json({ ok: false, error: "No S16 structural snapshot is published." }, { status: 404 });
    }
    const snapshot = snapshotResult.rows[0];
    const metricsResult = await pool.query(
      `SELECT metric_group AS "metricGroup",
              metric_key AS "metricKey",
              period,
              target,
              status,
              n,
              wins,
              hit_rate AS "hitRate",
              hit_rate_ci_low AS "hitRateCiLow",
              hit_rate_ci_high AS "hitRateCiHigh",
              median_planned_win_r AS "medianPlannedWinR",
              planned_expectancy_r AS "plannedExpectancyR",
              fill_adjusted_expectancy_r AS "fillAdjustedExpectancyR",
              net_5bps_r AS "net5BpsR",
              net_10bps_r AS "net10BpsR",
              net_25bps_r AS "net25BpsR",
              positive_payoff_rate AS "positivePayoffRate",
              payoff_std_r AS "payoffStdR",
              metadata
       FROM research_strategy_metrics
       WHERE metric_version = $1
       ORDER BY metric_group, metric_key, period`,
      [snapshot.metricVersion],
    );
    const metrics = metricsResult.rows;
    return NextResponse.json({
      ok: true,
      snapshot,
      targets: metrics.filter((row) => row.metricGroup === "target"),
      candidates: metrics.filter((row) => row.metricGroup === "candidate"),
      rrBands: metrics.filter((row) => row.metricGroup === "rr_band"),
      scaleouts: metrics.filter((row) => row.metricGroup === "scaleout"),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Postgres error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
