import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ICT Power of Three / AMD study. Rows are produced by scripts/amd/amd_engine.py into amd_* tables and audited by
// scripts/amd/validate_amd.py (summary.validation). Grid / segment / outcome stats use every row; lists are capped.

const HOLD_H = `extract(epoch from (exit_date - entry_date)) / 3600.0`;
const STAT_SQL = `
  count(*)::int AS n,
  count(*) FILTER (WHERE r > 0)::int AS wins,
  count(*) FILTER (WHERE r < 0)::int AS losses,
  count(*) FILTER (WHERE outcome = 'timeout')::int AS timeouts,
  avg(r)::float AS avg_r, sum(r)::float AS sum_r, avg(pct)::float AS avg_pct,
  avg(r - 0.05 / nullif(risk_pct, 0))::float AS avg_r_cost,  -- 5 bp round-trip cost, expressed in R
  percentile_cont(0.5) WITHIN GROUP (ORDER BY r)::float AS med_r,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY risk_pct)::float AS med_risk_pct,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY ${HOLD_H})::float AS med_hold_h,
  (sum(r) FILTER (WHERE r > 0) / nullif(-sum(r) FILTER (WHERE r < 0), 0))::float AS pf`;
const LIST_CAP = 1500;
const CYCLE_COLS = `c.acc_start, c.acc_confirm, c.acc_hi, c.acc_lo, c.ce, c.atr, c.acc_bars, c.eqh, c.eql, c.pd_pos, c.end_date AS cycle_end,
  c.manip_side, c.manip_kind, c.pierce_date, c.return_date, c.sweep_extreme, c.sweep_depth_pct, c.manip_time, c.mss_date, c.mss_level,
  c.mss_swing_date, c.fvg, c.true_open, c.pdh, c.pdl, c.day`;

function plainDates<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const [key, value] of Object.entries(out)) {
      if (value instanceof Date && key !== "created_at") {
        if (key.endsWith("_known_at") || key === "order_active_at" || key === "entry_not_before") {
          out[key] = value.toISOString();
          continue;
        }
        const p = (n: number) => String(n).padStart(2, "0");
        const day = `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
        out[key] = value.getHours() || value.getMinutes() ? `${day} ${p(value.getHours())}:${p(value.getMinutes())}` : day;
      }
    }
    return out as T;
  });
}

export async function GET(request: NextRequest) {
  const pool = getPostgresPool();
  const sp = request.nextUrl.searchParams;
  try {
    const runs = (
      await pool.query(
        `SELECT DISTINCT ON (timeframe, period, config_name) run_id, config_name, family, timeframe, period, params, notes,
                data_start, data_end, symbols, created_at, summary
           FROM amd_runs WHERE params->>'engine_version' = 'AMD_CAUSAL_V2'
             AND params->>'spec_version' = 'amd-local-v2.1'
             AND summary->'validation'->'failures' = '[]'::jsonb
           ORDER BY timeframe, period, config_name, created_at DESC`,
      )
    ).rows;
    if (!runs.length) {
      return NextResponse.json({ ok: false, error: "Corrected AMD results are rebuilding. Legacy runs failed causality and are excluded." }, { status: 404 });
    }
    const tf = sp.get("tf") || "1d";
    const requested = sp.get("run");
    const forTf = runs.filter((r) => r.timeframe === tf);
    const runRow = (requested && forTf.find((r) => r.run_id === requested)) || forTf.find((r) => r.config_name === "standard") || forTf[0] || runs[0];
    const runId = runRow.run_id as string;
    const invalid = await pool.query(`SELECT count(*)::int AS n FROM amd_trades t
      LEFT JOIN amd_cycles c USING (run_id, cycle_id) WHERE t.run_id=$1 AND (
        c.cycle_id IS NULL OR t.decision_known_at IS NULL OR t.order_active_at IS NULL OR t.entry_not_before IS NULL
        OR t.entry_date <= t.decision_date OR t.decision_known_at > t.order_active_at OR t.order_active_at > t.entry_not_before
        OR (t.model LIKE 'MSS%' AND (c.mss_date IS NULL OR t.mss_known_at IS NULL OR c.mss_date >= t.entry_date OR t.mss_known_at > t.decision_known_at))
        OR (t.model LIKE 'MSS_FVG%' AND (t.fvg_known_at IS NULL OR t.fvg_known_at > t.decision_known_at)))`,[runId]);
    if (invalid.rows[0].n) return NextResponse.json({ok:false,error:`AMD run quarantined: ${invalid.rows[0].n} causal invariant failures.`},{status:409});
    const session = runRow.family === "session";
    const model = sp.get("model") || (session ? "PO3_SESSION" : "MSS_FVG");
    const target = sp.get("target") || (session ? "EOD" : "liq_2R");
    const riskOnly = sp.get("min_risk") !== "false";
    const bias = sp.get("bias") || "all";
    const sym = (sp.get("sym") || "").toUpperCase();
    const cycOutcome = sp.get("outcome") || "";
    const split = "2022-01-01";

    const base = `t.run_id = $1 AND t.outcome IN ('win','loss','timeout') AND ($2::boolean = false OR t.risk_ok)
                  AND ($3 = 'all' OR ($3 = 'with' AND t.with_bias IS TRUE) OR ($3 = 'against' AND t.with_bias IS FALSE))`;
    const sel = `${base} AND t.model = $4 AND t.target = $5 AND ($7 = '' OR t.sym = $7) AND ($8 = '' OR t.cycle_outcome = $8)`;
    const selArgs = [runId, riskOnly, bias, model, target];

    const segSql = session
      ? `WITH b AS (SELECT t.*, c.manip_kind, c.manip_time, c.sweep_depth_pct FROM amd_trades t JOIN amd_cycles c ON c.run_id = t.run_id AND c.cycle_id = t.cycle_id WHERE ${sel})
         SELECT 'Side' AS dim, CASE side WHEN 'bull' THEN 'Long (Judas below open)' ELSE 'Short (Judas above open)' END AS key, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'HTF order flow (daily)', CASE WHEN with_bias IS NULL THEN 'Neutral' WHEN with_bias THEN 'With HTF bias' ELSE 'Against HTF bias' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Judas swing took', CASE manip_kind WHEN 'swept_PDL' THEN 'Prior-day low (SSL)' WHEN 'swept_PDH' THEN 'Prior-day high (BSL)' WHEN 'opened_outside_prior_range' THEN 'Gap day (opened outside prior range)' ELSE 'Inside prior-day range' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Judas extreme time (ET)', coalesce(manip_time, 'n/a'), ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Judas depth (% of daily ATR)', CASE WHEN sweep_depth_pct < 20 THEN '10-20%' WHEN sweep_depth_pct < 35 THEN '20-35%' WHEN sweep_depth_pct < 50 THEN '35-50%' ELSE '≥ 50%' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Entry time (ET)', CASE WHEN entry_date::time < '10:30' THEN '09:30-10:30' WHEN entry_date::time < '11:00' THEN '10:30-11:00' ELSE '11:00-12:30' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Risk %', CASE WHEN risk_pct < 0.5 THEN '< 0.5%' WHEN risk_pct < 1 THEN '0.5-1%' WHEN risk_pct < 2 THEN '1-2%' ELSE '≥ 2%' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Historical period (retrospective)', CASE WHEN entry_date < $6::date THEN 'Before ' || $6::text ELSE 'From ' || $6::text END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Year', extract(year from entry_date)::int::text, ${STAT_SQL} FROM b GROUP BY 2
         ORDER BY 1, 2`
      : `WITH b AS (SELECT t.*, c.manip_kind, c.manip_time, c.sweep_depth_pct, c.pd_pos, c.acc_bars FROM amd_trades t JOIN amd_cycles c ON c.run_id = t.run_id AND c.cycle_id = t.cycle_id WHERE ${sel})
         SELECT 'Side' AS dim, CASE side WHEN 'bull' THEN 'Long (SSL raided)' ELSE 'Short (BSL raided)' END AS key, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'HTF order flow', CASE WHEN with_bias IS NULL THEN 'Neutral' WHEN with_bias THEN 'With HTF bias' ELSE 'Against HTF bias' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Manipulation type', CASE manip_kind WHEN 'wick' THEN 'Wick raid (closed back inside)' ELSE '2B / Judas (close beyond, reclaimed ≤ 3 bars)' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Raid depth (% of range)', CASE WHEN sweep_depth_pct < 10 THEN '< 10%' WHEN sweep_depth_pct < 25 THEN '10-25%' WHEN sweep_depth_pct < 50 THEN '25-50%' ELSE '≥ 50%' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Accumulation in prior 126 bars', CASE WHEN pd_pos IS NULL THEN 'n/a' WHEN (side = 'bull' AND pd_pos < 0.5) OR (side = 'bear' AND pd_pos >= 0.5) THEN 'Aligned (long in discount / short in premium)' ELSE 'Misaligned' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Accumulation length (bars)', CASE WHEN acc_bars < 15 THEN '< 15' WHEN acc_bars < 30 THEN '15-30' WHEN acc_bars < 60 THEN '30-60' ELSE '≥ 60' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Cycle outcome · HINDSIGHT (diagnostic only, unavailable at entry)', cycle_outcome, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Raid time (ET)', coalesce(manip_time, 'n/a'), ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Risk %', CASE WHEN risk_pct < 0.5 THEN '< 0.5%' WHEN risk_pct < 1 THEN '0.5-1%' WHEN risk_pct < 2 THEN '1-2%' WHEN risk_pct < 4 THEN '2-4%' ELSE '≥ 4%' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Historical period (retrospective)', CASE WHEN entry_date < $6::date THEN 'Before ' || $6::text ELSE 'From ' || $6::text END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Year', extract(year from entry_date)::int::text, ${STAT_SQL} FROM b GROUP BY 2
         ORDER BY 1, 2`;

    // ICT claim being tested: after a raid on one side that returns, price is delivered to the opposite side's liquidity
    const ictSql = session
      ? `SELECT CASE manip_kind WHEN 'swept_PDL' THEN 'Judas took PDL' WHEN 'swept_PDH' THEN 'Judas took PDH' WHEN 'opened_outside_prior_range' THEN 'Gap day (open outside prior range)' ELSE 'Judas inside prior range' END
                  || ' · ' || CASE WHEN with_bias IS NULL THEN 'neutral' WHEN with_bias THEN 'with HTF bias' ELSE 'against HTF bias' END AS key,
                count(*)::int AS n, count(*) FILTER (WHERE outcome = 'po3_day_complete')::int AS delivered,
                count(*) FILTER (WHERE outcome = 'po3_day_failed')::int AS failed, 0::int AS mss, 0::int AS unresolved
           FROM amd_cycles WHERE run_id = $1 AND outcome IN ('po3_day_complete', 'po3_day_failed') GROUP BY 1 ORDER BY 1`
      : `SELECT CASE manip_kind WHEN 'wick' THEN 'Wick raid' ELSE '2B / Judas' END
                  || ' · ' || CASE WHEN with_bias IS NULL THEN 'neutral' WHEN with_bias THEN 'with HTF bias' ELSE 'against HTF bias' END AS key,
                count(*)::int AS n,
                count(*) FILTER (WHERE outcome IN ('distribution_complete', 'distribution_no_mss'))::int AS delivered,
                count(*) FILTER (WHERE outcome = 'manipulation_failed')::int AS failed,
                count(*) FILTER (WHERE mss_date IS NOT NULL)::int AS mss,
                count(*) FILTER (WHERE outcome IN ('unresolved', 'active'))::int AS unresolved
           FROM amd_cycles WHERE run_id = $1 AND manip_kind IS NOT NULL GROUP BY 1 ORDER BY 1`;

    const [grid, segments, outcomes, ictTest, cycles, trades, totals] = await Promise.all([
      pool.query(
        `SELECT model, target, ${STAT_SQL},
                count(*) FILTER (WHERE entry_date < $4::date)::int AS n_is, avg(r) FILTER (WHERE entry_date < $4::date)::float AS r_is,
                count(*) FILTER (WHERE entry_date >= $4::date)::int AS n_oos, avg(r) FILTER (WHERE entry_date >= $4::date)::float AS r_oos
           FROM amd_trades t WHERE ${base} AND ($5 = '' OR t.sym=$5) AND ($6 = '' OR t.cycle_outcome=$6) GROUP BY model, target ORDER BY model, target`,
        [runId, riskOnly, bias, split, sym, cycOutcome],
      ),
      pool.query(segSql, [...selArgs, split, sym, cycOutcome]),
      pool.query(
        `SELECT outcome, count(*)::int AS n, count(*) FILTER (WHERE with_bias)::int AS with_bias,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY acc_bars)::float AS med_bars,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY sweep_depth_pct)::float AS med_depth
           FROM amd_cycles WHERE run_id = $1 GROUP BY outcome`,
        [runId],
      ),
      pool.query(ictSql, [runId]),
      pool.query(
        `SELECT * FROM amd_cycles WHERE run_id = $1 AND ($2 = '' OR sym = $2) AND ($3 = '' OR outcome = $3)
          ORDER BY coalesce(day, acc_confirm) DESC LIMIT ${LIST_CAP}`,
        [runId, sym, cycOutcome],
      ),
      pool.query(
        `SELECT t.*, ${HOLD_H}::float AS hold_h, ${CYCLE_COLS}
           FROM amd_trades t JOIN amd_cycles c ON c.run_id = t.run_id AND c.cycle_id = t.cycle_id
          WHERE t.run_id = $1 AND ($2::boolean = false OR t.risk_ok)
            AND ($3 = 'all' OR ($3 = 'with' AND t.with_bias IS TRUE) OR ($3 = 'against' AND t.with_bias IS FALSE))
            AND t.model = $4 AND t.target = $5 AND ($6 = '' OR t.sym = $6) AND ($7 = '' OR t.cycle_outcome = $7)
          ORDER BY t.entry_date DESC LIMIT ${LIST_CAP}`,
        [...selArgs, sym, cycOutcome],
      ),
      pool.query(
        `SELECT (SELECT count(*)::int FROM amd_cycles WHERE run_id = $1 AND ($2 = '' OR sym = $2) AND ($3 = '' OR outcome = $3)) AS cycles,
                (SELECT count(*)::int FROM amd_trades WHERE run_id = $1 AND model = $4 AND target = $5 AND ($2 = '' OR sym = $2) AND ($3 = '' OR cycle_outcome = $3)
                   AND ($6::boolean = false OR risk_ok) AND ($7 = 'all' OR ($7 = 'with' AND with_bias IS TRUE) OR ($7 = 'against' AND with_bias IS FALSE))) AS trades,
                (SELECT array_agg(DISTINCT sym ORDER BY sym) FROM amd_cycles WHERE run_id = $1) AS symbols`,
        [runId, sym, cycOutcome, model, target, riskOnly, bias],
      ),
    ]);

    return NextResponse.json({
      ok: true, runs: plainDates(runs), runId, timeframe: runRow.timeframe, family: runRow.family, split,
      selection: { model, target, riskOnly, bias, sym, outcome: cycOutcome },
      grid: grid.rows, segments: segments.rows, outcomes: outcomes.rows, ictTest: ictTest.rows,
      cycles: plainDates(cycles.rows), trades: plainDates(trades.rows), totals: totals.rows[0], listCap: LIST_CAP,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Postgres error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
