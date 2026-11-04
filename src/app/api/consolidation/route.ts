import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";
import { buildCsv, csvDownloadResponse } from "@/lib/csv-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ICT consolidation study. Rows are produced by scripts/consolidation/consolidation_engine.py into consolidation_* tables.
// Grid / segment / fate stats are computed over every row; the box and trade lists are capped (most recent first).

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
const VALID_GEOMETRY = `t.entry > 0 AND t.stop > 0 AND t.tgt > 0 AND ((t.side='bull' AND t.stop<t.entry AND t.tgt>t.entry) OR (t.side='bear' AND t.stop>t.entry AND t.tgt<t.entry))`;

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
           FROM consolidation_runs ORDER BY timeframe, period, config_name, created_at DESC`,
      )
    ).rows;
    if (!runs.length) {
      return NextResponse.json({ ok: false, error: "No consolidation runs found. Run scripts/consolidation/consolidation_engine.py first." }, { status: 404 });
    }
    const tf = sp.get("tf") || "1d";
    const requested = sp.get("run");
    const forTf = runs.filter((r) => r.timeframe === tf);
    const runRow = (requested && forTf.find((r) => r.run_id === requested)) || forTf.find((r) => r.config_name === "tight") || forTf[0] || runs[0];
    const runId = runRow.run_id as string;
    const model = sp.get("model") || "SWEEP_FADE";
    const target = sp.get("target") || "2R";
    const riskOnly = sp.get("min_risk") !== "false";
    const bias = sp.get("bias") || "all"; // all | with | against
    const sym = (sp.get("sym") || "").toUpperCase();
    const fate = sp.get("fate") || "";
    const split = "2022-01-01";

    const base = `${VALID_GEOMETRY} AND t.run_id = $1 AND t.outcome IN ('win','loss','timeout') AND ($2::boolean = false OR t.risk_ok)
                  AND ($3 = 'all' OR ($3 = 'with' AND t.with_bias IS TRUE) OR ($3 = 'against' AND t.with_bias IS FALSE))
                  AND ($4 = '' OR t.sym = $4) AND ($5 = '' OR t.fate = $5)`;
    const sel = `${base} AND t.model = $6 AND t.target = $7`;
    const selArgs = [runId, riskOnly, bias, sym, fate, model, target];

    if (sp.get("format") === "csv") {
      const boxesExport = sp.get("view") === "boxes";
      const result = boxesExport
        ? await pool.query(`SELECT * FROM consolidation_boxes WHERE run_id=$1 AND ($2='' OR sym=$2) AND ($3='' OR fate=$3) ORDER BY confirm_date DESC,box_id`, [runId,sym,fate])
        : await pool.query(`SELECT t.*, (${VALID_GEOMETRY}) AS execution_valid FROM consolidation_trades t WHERE t.run_id=$1 AND ($2::boolean=false OR t.risk_ok) AND ($3='all' OR ($3='with' AND t.with_bias IS TRUE) OR ($3='against' AND t.with_bias IS FALSE)) AND ($4='' OR t.sym=$4) AND ($5='' OR t.fate=$5) AND t.model=$6 AND t.target=$7 ORDER BY entry_date DESC,trade_id`,selArgs);
      const rows = plainDates(result.rows);
      const keys = result.fields.map((f) => f.name);
      return csvDownloadResponse(buildCsv(keys.map((key) => ({ key, value: (row: Record<string, unknown>) => row[key] })), rows), `consolidation_${runId}_${boxesExport ? "boxes" : `${model}_${target}`}.csv`, rows.length);
    }

    const [grid, segments, fates, ictTest, boxes, trades, totals] = await Promise.all([
      pool.query(
        `SELECT model, target, ${STAT_SQL},
                count(*) FILTER (WHERE entry_date < $6::date)::int AS n_is, avg(r) FILTER (WHERE entry_date < $6::date)::float AS r_is,
                count(*) FILTER (WHERE entry_date >= $6::date)::int AS n_oos, avg(r) FILTER (WHERE entry_date >= $6::date)::float AS r_oos
           FROM consolidation_trades t WHERE ${base} GROUP BY model, target ORDER BY model, target`,
        [runId, riskOnly, bias, sym, fate, split],
      ),
      pool.query(
        `WITH b AS (
           SELECT t.*, x.height_atr, x.atr_ratio, x.bars AS box_bars, x.top_tests + x.bot_tests AS tests, x.sweep_depth_pct, x.dwell_bars
             FROM consolidation_trades t JOIN consolidation_boxes x ON x.run_id = t.run_id AND x.box_id = t.box_id
            WHERE ${sel})
         SELECT 'Side' AS dim, CASE side WHEN 'bull' THEN 'Long' ELSE 'Short' END AS key, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'HTF order flow', CASE WHEN with_bias IS NULL THEN 'Neutral' WHEN with_bias THEN 'With HTF bias' ELSE 'Against HTF bias' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Box fate', fate, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Box span (× ATR20)', CASE WHEN height_atr < 1.5 THEN '< 1.5' WHEN height_atr < 2 THEN '1.5-2' WHEN height_atr < 2.5 THEN '2-2.5' ELSE '2.5-3' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'ATR7 / ATR21 at confirm', CASE WHEN atr_ratio IS NULL THEN 'n/a' WHEN atr_ratio < 0.7 THEN '< 0.7 (compressed)' WHEN atr_ratio < 0.9 THEN '0.7-0.9' WHEN atr_ratio < 1.1 THEN '0.9-1.1' ELSE '≥ 1.1 (expanding)' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'EQH + EQL swing count', CASE WHEN tests <= 4 THEN '4' WHEN tests <= 6 THEN '5-6' ELSE '7+' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Box length (bars)', CASE WHEN box_bars <= 10 THEN '≤ 10' WHEN box_bars <= 15 THEN '11-15' WHEN box_bars <= 25 THEN '16-25' ELSE '26+' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Box location (126-bar range)', CASE WHEN pd_pos IS NULL THEN 'n/a' WHEN pd_pos < 0.25 THEN 'Deep discount (< 25%)' WHEN pd_pos < 0.5 THEN 'Discount (25-50%)' WHEN pd_pos < 0.75 THEN 'Premium (50-75%)' ELSE 'Deep premium (≥ 75%)' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Sweep type', coalesce(CASE sweep_kind WHEN '2B' THEN 'Failed break (2B)' WHEN 'wick' THEN 'Wick sweep' END, 'n/a (break model)'), ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Sweep depth (% of box)', CASE WHEN sweep_kind IS NULL OR sweep_depth_pct IS NULL THEN 'n/a' WHEN sweep_depth_pct < 10 THEN '< 10%' WHEN sweep_depth_pct < 25 THEN '10-25%' WHEN sweep_depth_pct < 50 THEN '25-50%' ELSE '≥ 50%' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Risk %', CASE WHEN risk_pct < 0.5 THEN '< 0.5%' WHEN risk_pct < 1 THEN '0.5-1%' WHEN risk_pct < 2 THEN '1-2%' ELSE '≥ 2%' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Entry time (ET)', CASE WHEN entry_date::time = '00:00' THEN 'Daily bar' WHEN entry_date::time < '10:30' THEN '09:30-10:30'
                        WHEN entry_date::time < '12:00' THEN '10:30-12:00' WHEN entry_date::time < '14:00' THEN '12:00-14:00' ELSE '14:00-16:00' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Walk-forward', CASE WHEN entry_date < $8::date THEN 'In-sample (before ' || $8::text || ')' ELSE 'Out-of-sample (from ' || $8::text || ')' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Year', extract(year from entry_date)::int::text, ${STAT_SQL} FROM b GROUP BY 2
         ORDER BY 1, 2`,
        [...selArgs, split],
      ),
      pool.query(
        `SELECT fate, count(*)::int AS n,
                count(*) FILTER (WHERE expanded_1h)::int AS expanded,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY exp_mfe_h)::float AS med_mfe_h,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY dwell_bars)::float AS med_dwell,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY bars)::float AS med_bars
           FROM consolidation_boxes WHERE run_id = $1 GROUP BY fate`,
        [runId],
      ),
      // ICT claim: with a bullish HTF bias the sweep should come BELOW the range, then expand up (and vice versa)
      pool.query(
        `SELECT CASE WHEN htf_bias = 0 THEN 'Neutral HTF bias'
                     WHEN (htf_bias = 1 AND sweep_side = 'dn') OR (htf_bias = -1 AND sweep_side = 'up') THEN 'Sweep AGAINST HTF bias (ICT setup)'
                     ELSE 'Sweep WITH HTF bias' END AS key,
                count(*)::int AS n,
                count(*) FILTER (WHERE fate = 'manipulation_then_expansion')::int AS reversed,
                count(*) FILTER (WHERE fate = 'sweep_then_break_same_side')::int AS continued,
                count(*) FILTER (WHERE fate IN ('unresolved', 'active'))::int AS unresolved
           FROM consolidation_boxes WHERE run_id = $1 AND sweep_side IS NOT NULL GROUP BY 1 ORDER BY 1`,
        [runId],
      ),
      pool.query(
        `SELECT * FROM consolidation_boxes WHERE run_id = $1 AND ($2 = '' OR sym = $2) AND ($3 = '' OR fate = $3)
          ORDER BY confirm_date DESC LIMIT ${LIST_CAP}`,
        [runId, sym, fate],
      ),
      pool.query(
        `SELECT t.*, (${VALID_GEOMETRY}) AS execution_valid, ${HOLD_H}::float AS hold_h, x.start_date, x.confirm_date, x.sweep_side, x.sweep_kind AS box_sweep_kind,
                x.sweep_date, x.break_dir, x.break_date, x.end_date AS box_end_date, x.eqh, x.eql, x.sweep_extreme
           FROM consolidation_trades t JOIN consolidation_boxes x ON x.run_id = t.run_id AND x.box_id = t.box_id
          WHERE t.run_id = $1 AND ($2::boolean = false OR t.risk_ok)
            AND ($3 = 'all' OR ($3 = 'with' AND t.with_bias IS TRUE) OR ($3 = 'against' AND t.with_bias IS FALSE))
            AND t.model = $6 AND t.target = $7 AND ($4 = '' OR t.sym = $4) AND ($5 = '' OR t.fate = $5)
          ORDER BY t.entry_date DESC LIMIT ${LIST_CAP}`,
        selArgs,
      ),
      pool.query(
        `SELECT (SELECT count(*)::int FROM consolidation_boxes WHERE run_id = $1 AND ($2 = '' OR sym = $2) AND ($3 = '' OR fate = $3)) AS boxes,
                (SELECT count(*)::int FROM consolidation_trades WHERE run_id = $1 AND model = $4 AND target = $5 AND ($2 = '' OR sym = $2) AND ($3 = '' OR fate = $3)
                   AND ($6::boolean = false OR risk_ok) AND ($7 = 'all' OR ($7 = 'with' AND with_bias IS TRUE) OR ($7 = 'against' AND with_bias IS FALSE))) AS trades,
                (SELECT array_agg(DISTINCT sym ORDER BY sym) FROM consolidation_boxes WHERE run_id = $1) AS symbols`,
        [runId, sym, fate, model, target, riskOnly, bias],
      ),
    ]);

    return NextResponse.json({
      ok: true,
      runs: plainDates(runs),
      runId,
      timeframe: runRow.timeframe,
      split,
      selection: { model, target, riskOnly, bias, sym, fate },
      grid: grid.rows,
      segments: segments.rows,
      fates: fates.rows,
      ictTest: ictTest.rows,
      boxes: plainDates(boxes.rows),
      trades: plainDates(trades.rows),
      totals: totals.rows[0],
      listCap: LIST_CAP,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Postgres error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
