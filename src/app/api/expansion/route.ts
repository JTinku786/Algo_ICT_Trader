import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ICT expansion study. Rows are produced by scripts/expansion/expansion_engine.py into expansion_* tables.
// Grid / segment / outcome stats use every row; the leg and trade lists are capped (most recent first).

const HOLD_H = `extract(epoch from (exit_date - entry_date)) / 3600.0`;
const STAT_SQL = `
  count(*)::int AS n,
  count(*) FILTER (WHERE outcome = 'win')::int AS wins,
  count(*) FILTER (WHERE outcome = 'loss')::int AS losses,
  count(*) FILTER (WHERE outcome = 'timeout')::int AS timeouts,
  avg(r)::float AS avg_r, sum(r)::float AS sum_r, avg(pct)::float AS avg_pct,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY r)::float AS med_r,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY risk_pct)::float AS med_risk_pct,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY bars_held)::float AS med_bars,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY ${HOLD_H})::float AS med_hold_h`;
const LIST_CAP = 1500;

function plainDates<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const [key, value] of Object.entries(out)) {
      if (value instanceof Date && key !== "created_at") {
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
        `SELECT DISTINCT ON (timeframe, period, config_name) run_id, config_name, timeframe, period, params, notes,
                data_start, data_end, symbols, created_at, summary
           FROM expansion_runs ORDER BY timeframe, period, config_name, created_at DESC`,
      )
    ).rows;
    if (!runs.length) {
      return NextResponse.json({ ok: false, error: "No expansion runs found. Run scripts/expansion/expansion_engine.py first." }, { status: 404 });
    }
    const tf = sp.get("tf") || "1d";
    const requested = sp.get("run");
    const forTf = runs.filter((r) => r.timeframe === tf);
    const runRow = (requested && forTf.find((r) => r.run_id === requested)) || forTf.find((r) => r.config_name === "standard") || forTf[0] || runs[0];
    const runId = runRow.run_id as string;
    const model = sp.get("model") || "FVG_CE";
    const target = sp.get("target") || "leg_high";
    const riskOnly = sp.get("min_risk") !== "false";
    const bias = sp.get("bias") || "all";
    const sym = (sp.get("sym") || "").toUpperCase();
    const legOutcome = sp.get("outcome") || "";
    const split = "2022-01-01";

    const base = `t.run_id = $1 AND t.outcome IN ('win','loss','timeout') AND ($2::boolean = false OR t.risk_ok)
                  AND ($3 = 'all' OR ($3 = 'with' AND t.with_bias IS TRUE) OR ($3 = 'against' AND t.with_bias IS FALSE))`;
    const sel = `${base} AND t.model = $4 AND t.target = $5`;
    const selArgs = [runId, riskOnly, bias, model, target];

    const [grid, segments, outcomes, ictTest, legs, trades, totals] = await Promise.all([
      pool.query(
        `SELECT model, target, ${STAT_SQL},
                count(*) FILTER (WHERE entry_date < $4::date)::int AS n_is, avg(r) FILTER (WHERE entry_date < $4::date)::float AS r_is,
                count(*) FILTER (WHERE entry_date >= $4::date)::int AS n_oos, avg(r) FILTER (WHERE entry_date >= $4::date)::float AS r_oos
           FROM expansion_trades t WHERE ${base} GROUP BY model, target ORDER BY model, target`,
        [runId, riskOnly, bias, split],
      ),
      pool.query(
        `WITH b AS (
           SELECT t.*, x.disp_body_atr, x.leg_atr, x.fvg_count, x.origin_sweep, x.killzone, x.disp_bars
             FROM expansion_trades t LEFT JOIN expansion_legs x ON x.run_id = t.run_id AND x.leg_id = t.leg_id
            WHERE ${sel})
         SELECT 'Side' AS dim, CASE side WHEN 'bull' THEN 'Long' ELSE 'Short' END AS key, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'HTF order flow', CASE WHEN with_bias IS NULL THEN 'Neutral' WHEN with_bias THEN 'With HTF bias' ELSE 'Against HTF bias' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Leg outcome · HINDSIGHT (known only after the trade, not a filter)', coalesce(leg_outcome, 'n/a (chase)'), ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Displacement body (× ATR20)', CASE WHEN disp_body_atr IS NULL THEN 'n/a' WHEN disp_body_atr < 1.25 THEN '1.0-1.25' WHEN disp_body_atr < 1.5 THEN '1.25-1.5' WHEN disp_body_atr < 2 THEN '1.5-2' ELSE '≥ 2' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Leg size (× ATR20)', CASE WHEN leg_atr IS NULL THEN 'n/a' WHEN leg_atr < 3 THEN '2-3' WHEN leg_atr < 4 THEN '3-4' WHEN leg_atr < 6 THEN '4-6' ELSE '≥ 6' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'FVGs in the leg', CASE WHEN fvg_count IS NULL THEN 'n/a' WHEN fvg_count = 1 THEN '1' WHEN fvg_count = 2 THEN '2' ELSE '3+' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Origin swept liquidity (20-bar)', CASE WHEN origin_sweep IS NULL THEN 'n/a' WHEN origin_sweep THEN 'Yes (sweep → expansion)' ELSE 'No' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Displacement time (ET)', coalesce(killzone, 'n/a'), ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Risk %', CASE WHEN risk_pct < 0.5 THEN '< 0.5%' WHEN risk_pct < 1 THEN '0.5-1%' WHEN risk_pct < 2 THEN '1-2%' WHEN risk_pct < 4 THEN '2-4%' ELSE '≥ 4%' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Entry time (ET)', CASE WHEN entry_date::time = '00:00' THEN 'Daily bar' WHEN entry_date::time < '10:30' THEN '09:30-10:30'
                        WHEN entry_date::time < '12:00' THEN '10:30-12:00' WHEN entry_date::time < '14:00' THEN '12:00-14:00' ELSE '14:00-16:00' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Walk-forward', CASE WHEN entry_date < $6::date THEN 'In-sample (before ' || $6::text || ')' ELSE 'Out-of-sample (from ' || $6::text || ')' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Year', extract(year from entry_date)::int::text, ${STAT_SQL} FROM b GROUP BY 2
         ORDER BY 1, 2`,
        [...selArgs, split],
      ),
      pool.query(
        `SELECT outcome, count(*)::int AS n,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY retrace_pct)::float AS med_retrace,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY leg_atr)::float AS med_leg_atr,
                count(*) FILTER (WHERE touched_eq)::int AS touched_eq, count(*) FILTER (WHERE touched_ote)::int AS touched_ote
           FROM expansion_legs WHERE run_id = $1 GROUP BY outcome`,
        [runId],
      ),
      // ICT claim: a retracement into discount (OTE) is where the expansion resumes; a deep move through it fails
      pool.query(
        `SELECT CASE WHEN touched_ote THEN '2 · Retraced into OTE (≥ 62%)' WHEN touched_eq THEN '1 · Retraced past 50% (50-62%)' ELSE '0 · Never reached 50% (no discount)' END AS key,
                count(*)::int AS n,
                count(*) FILTER (WHERE outcome IN ('continued_after_retrace', 'continued_shallow'))::int AS continued,
                count(*) FILTER (WHERE outcome = 'failed')::int AS failed,
                count(*) FILTER (WHERE outcome IN ('unresolved', 'active'))::int AS unresolved
           FROM expansion_legs WHERE run_id = $1 GROUP BY 1 ORDER BY 1`,
        [runId],
      ),
      pool.query(
        `SELECT * FROM expansion_legs WHERE run_id = $1 AND ($2 = '' OR sym = $2) AND ($3 = '' OR outcome = $3)
          ORDER BY disp_date DESC LIMIT ${LIST_CAP}`,
        [runId, sym, legOutcome],
      ),
      pool.query(
        `SELECT t.*, ${HOLD_H}::float AS hold_h, x.origin_date, x.disp_date, x.ext_date, x.confirm_date, x.end_date AS leg_end_date,
                x.broken_swing_date, x.broken_level, x.ote, x.fvgs, x.entry_fvg, x.origin_sweep, x.retrace_pct, x.leg_atr
           FROM expansion_trades t LEFT JOIN expansion_legs x ON x.run_id = t.run_id AND x.leg_id = t.leg_id
          WHERE t.run_id = $1 AND ($2::boolean = false OR t.risk_ok)
            AND ($3 = 'all' OR ($3 = 'with' AND t.with_bias IS TRUE) OR ($3 = 'against' AND t.with_bias IS FALSE))
            AND t.model = $4 AND t.target = $5 AND ($6 = '' OR t.sym = $6) AND ($7 = '' OR t.leg_outcome = $7)
          ORDER BY t.entry_date DESC LIMIT ${LIST_CAP}`,
        [...selArgs, sym, legOutcome],
      ),
      pool.query(
        `SELECT (SELECT count(*)::int FROM expansion_legs WHERE run_id = $1 AND ($2 = '' OR sym = $2) AND ($3 = '' OR outcome = $3)) AS legs,
                (SELECT count(*)::int FROM expansion_trades WHERE run_id = $1 AND model = $4 AND target = $5 AND ($2 = '' OR sym = $2) AND ($3 = '' OR leg_outcome = $3)
                   AND ($6::boolean = false OR risk_ok) AND ($7 = 'all' OR ($7 = 'with' AND with_bias IS TRUE) OR ($7 = 'against' AND with_bias IS FALSE))) AS trades,
                (SELECT array_agg(DISTINCT sym ORDER BY sym) FROM expansion_legs WHERE run_id = $1) AS symbols`,
        [runId, sym, legOutcome, model, target, riskOnly, bias],
      ),
    ]);

    return NextResponse.json({
      ok: true, runs: plainDates(runs), runId, timeframe: runRow.timeframe, split,
      selection: { model, target, riskOnly, bias, sym, outcome: legOutcome },
      grid: grid.rows, segments: segments.rows, outcomes: outcomes.rows, ictTest: ictTest.rows,
      legs: plainDates(legs.rows), trades: plainDates(trades.rows), totals: totals.rows[0], listCap: LIST_CAP,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Postgres error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
