import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Reversal study (sweep -> MSS). Rows are produced by
// Desktop/ICT_Automation/trend_reversal_2026/reversal_engine.py into reversal_* tables.
// period '2026' = 2026 only, 'FULL' = 2017-01-01 onwards.

// Hold time uses persisted actual exit timestamps; corrected exits are 5m confirmation times.
const HOLD_H = `extract(epoch from (exit_date - entry_date)) / 3600.0`;

// raw R, R capped at the planned R (no gap windfall), robust quantiles and hold time
const STAT_SQL = `
  count(*)::int AS n,
  count(*) FILTER (WHERE outcome = 'win')::int AS wins,
  count(*) FILTER (WHERE outcome = 'loss')::int AS losses,
  count(*) FILTER (WHERE outcome = 'timeout')::int AS timeouts,
  avg(r)::float AS avg_r, avg(least(r, plan_r))::float AS avg_r_capped, sum(r)::float AS sum_r, avg(pct)::float AS avg_pct,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY r)::float AS med_r,
  percentile_cont(0.05) WITHIN GROUP (ORDER BY r)::float AS p05_r,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY r)::float AS p95_r,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY risk_pct)::float AS med_risk_pct,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY bars_held)::float AS med_bars,
  avg(${HOLD_H})::float AS avg_hold_h,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY ${HOLD_H})::float AS med_hold_h`;

// pg returns DATE columns as JS Dates at local midnight; send plain YYYY-MM-DD strings instead.
function plainDates<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const [key, value] of Object.entries(out)) {
      if (value instanceof Date && ["filled_at", "decision_known_at"].includes(key)) {
        out[key] = value.toISOString();
      } else if (value instanceof Date && key !== "created_at") {
        const p = (n: number) => String(n).padStart(2, "0");
        const day = `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
        // daily rows are stored at midnight -> plain date; intraday rows keep the ET wall-clock time
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
        `SELECT DISTINCT ON (coalesce(timeframe, '1d'), coalesce(period, '2026'), config_name)
                run_id, config_name, coalesce(timeframe, '1d') AS timeframe, coalesce(period, '2026') AS period,
                params, notes, data_start, data_end, symbols, created_at, summary
           FROM reversal_runs
          ORDER BY coalesce(timeframe, '1d'), coalesce(period, '2026'), config_name, created_at DESC`,
      )
    ).rows;
    if (!runs.length) {
      return NextResponse.json({ ok: false, error: "No reversal runs found. Run reversal_engine.py first." }, { status: 404 });
    }
    const tf = sp.get("tf") || "1d";
    const period = sp.get("period") || "2026";
    const requested = sp.get("run");
    const pool_ = runs.filter((r) => r.timeframe === tf && r.period === period);
    const runRow =
      (requested && pool_.find((r) => r.run_id === requested)) ||
      pool_.find((r) => r.config_name === "k1_reclaim3") ||
      pool_[0] ||
      (period.startsWith("FX") ? undefined : runs.find((r) => r.timeframe === tf && !String(r.period).startsWith("FX"))) ||
      runs[0];
    const runId = runRow.run_id as string;
    const model = sp.get("model") || "OTE62_limit";
    const target = sp.get("target") || "2R";
    const stopMode = sp.get("stop_mode") || "hard";
    const primaryOnly = sp.get("primary") !== "false";
    const riskOnly = sp.get("min_risk") !== "false";
    // walk-forward split: first part = in-sample, the rest = out-of-sample
    const split = runRow.period === "FULL" || runRow.period === "FX_FULL" ? "2022-01-01" : "2026-05-01";

    const base = `run_id = $1 AND outcome IN ('win', 'loss', 'timeout') AND exit_verified IS TRUE AND setup_valid IS TRUE AND ($2::boolean = false OR is_primary) AND ($3::boolean = false OR coalesce(risk_ok, true))`;
    const sel = `${base} AND model = $4 AND target = $5 AND stop_mode = $6`;
    const selArgs = [runId, primaryOnly, riskOnly, model, target, stopMode];

    const [grid, trades, segments, audit, fates, events, signals, excluded, auditCounts] = await Promise.all([
      pool.query(
        `SELECT model, target, stop_mode, ${STAT_SQL},
                count(*) FILTER (WHERE entry_date < $4::date)::int AS n_is,
                avg(least(r, plan_r)) FILTER (WHERE entry_date < $4::date)::float AS capped_is,
                count(*) FILTER (WHERE entry_date >= $4::date)::int AS n_oos,
                avg(least(r, plan_r)) FILTER (WHERE entry_date >= $4::date)::float AS capped_oos
           FROM reversal_trades
          WHERE ${base}
          GROUP BY model, target, stop_mode ORDER BY model, target, stop_mode`,
        [runId, primaryOnly, riskOnly, split],
      ),
      pool.query(
        `SELECT t.*, ${HOLD_H}::float AS hold_h, s.swept_level, s.internal_level, s.opposite_liquidity, s.reclaim_date,
                s.mss_range_pct, s.fvg_count
           FROM reversal_trades t JOIN reversal_signals s ON s.run_id = t.run_id AND s.signal_id = t.signal_id
          WHERE t.run_id = $1 AND t.outcome IS NOT NULL AND ($2::boolean = false OR t.is_primary) AND ($3::boolean = false OR coalesce(t.risk_ok, true))
            AND t.model = $4 AND t.target = $5 AND t.stop_mode = $6
          ORDER BY t.entry_date, t.sym`,
        selArgs,
      ),
      pool.query(
        `WITH b AS (
           SELECT *, CASE WHEN htf LIKE '%W_FVG%' THEN 'Weekly FVG'
                       WHEN htf LIKE '%D_FVG%' THEN 'Daily FVG (no weekly FVG)'
                       WHEN htf LIKE '%W_OB%' THEN 'Weekly OB only'
                       WHEN htf LIKE '%D_OB%' THEN 'Daily OB only'
                       ELSE 'No HTF array' END AS htf_bucket,
                  CASE WHEN pd_pos IS NULL THEN 'n/a'
                       WHEN (side = 'bear' AND pd_pos > 0.5) OR (side = 'bull' AND pd_pos < 0.5) THEN 'Correct side' ELSE 'Wrong side' END AS pd_bucket
             FROM reversal_trades WHERE ${sel})
         SELECT 'HTF PD array' AS dim, htf_bucket AS key, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Side', CASE side WHEN 'bear' THEN 'Short (bearish)' ELSE 'Long (bullish)' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Trigger', CASE kind WHEN '2B' THEN 'Failed break (2B)' ELSE 'Wick sweep' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Lookback', lookback || 'D', ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Liquidity windows swept', CASE WHEN swept_windows IS NULL THEN 'n/a'
                        WHEN swept_windows = 3 AND windows_same_level THEN '20+40+60 · one pool (same level)'
                        WHEN swept_windows = 3 THEN '20+40+60 · distinct pools'
                        WHEN swept_windows = 2 AND windows_same_level THEN '20+40 · one pool'
                        WHEN swept_windows = 2 THEN '20+40 · distinct pools'
                        WHEN swept_windows = 1 THEN '20 only' ELSE '0 (swept on a later bar)' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Bigger liquidity (120 / 252 bars)', CASE WHEN swept_252 THEN '252-bar (≈1y on daily) taken'
                        WHEN swept_120 THEN '120-bar taken (not 252)' WHEN swept_120 IS NULL THEN 'n/a' ELSE 'Neither' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Sweep depth past level', CASE WHEN sweep_depth_pct IS NULL THEN 'n/a' WHEN sweep_depth_pct < 0.25 THEN '< 0.25%'
                        WHEN sweep_depth_pct < 1 THEN '0.25-1%' WHEN sweep_depth_pct < 2.5 THEN '1-2.5%' ELSE '≥ 2.5%' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Premium/Discount', pd_bucket, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'HTF order flow', CASE WHEN htf_bias IS NULL OR htf_bias = 0 THEN 'Neutral / n/a'
                        WHEN (side = 'bull' AND htf_bias = 1) OR (side = 'bear' AND htf_bias = -1) THEN 'With HTF flow' ELSE 'Against HTF flow' END,
                   ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Sweep → entry arrays', CASE WHEN sw_fvg_with IS NULL THEN 'n/a'
                        WHEN sw_fvg_with > 0 AND sw_ob THEN 'FVG + OB (with trade)'
                        WHEN sw_fvg_with > 0 THEN 'FVG only' WHEN sw_ob THEN 'OB only' ELSE 'No FVG / OB' END,
                   ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Entry location', CASE WHEN entry_in_fvg IS NULL THEN 'n/a'
                        WHEN entry_in_fvg AND entry_in_ob THEN 'Inside FVG + OB' WHEN entry_in_fvg THEN 'Inside FVG'
                        WHEN entry_in_ob THEN 'Inside OB' ELSE 'Not in FVG / OB' END,
                   ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Swept level age', CASE WHEN level_age IS NULL THEN 'n/a' WHEN level_age <= 3 THEN '≤3 bars (fresh)'
                        WHEN level_age <= 10 THEN '4-10 bars' ELSE '>10 bars (resting)' END,
                   ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Opposite FVG in leg', CASE WHEN sw_fvg_against IS NULL THEN 'n/a' WHEN sw_fvg_against > 0 THEN 'Yes (continuation sign)' ELSE 'No' END,
                   ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT '2B reclaim', CASE WHEN kind <> '2B' THEN 'Wick (n/a)' WHEN reclaim_by_gap THEN 'Only by gap' ELSE 'Traded back in' END,
                   ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'MSS displacement (body % of range)', CASE WHEN mss_body_ratio IS NULL THEN 'n/a' WHEN mss_body_ratio < 0.4 THEN '< 40%'
                        WHEN mss_body_ratio < 0.7 THEN '40-70%' ELSE '≥ 70% (strong)' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Bars sweep → MSS', CASE WHEN bars_to_mss IS NULL THEN 'n/a' WHEN bars_to_mss <= 1 THEN '0-1'
                        WHEN bars_to_mss <= 4 THEN '2-4' ELSE '5-10' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Risk %', CASE WHEN risk_pct < 0.25 THEN '< 0.25%' WHEN risk_pct < 0.5 THEN '0.25-0.5%'
                        WHEN risk_pct < 1 THEN '0.5-1%' WHEN risk_pct < 2 THEN '1-2%' WHEN risk_pct < 4 THEN '2-4%' ELSE '≥ 4%' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Entry time (ET)', CASE WHEN entry_date::time = '00:00' THEN 'Daily bar'
                        WHEN entry_date::time < '10:30' THEN '09:30-10:30' WHEN entry_date::time < '12:00' THEN '10:30-12:00'
                        WHEN entry_date::time < '14:00' THEN '12:00-14:00' ELSE '14:00-16:00' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Walk-forward', CASE WHEN entry_date < $7::date THEN 'In-sample (before ' || $7::text || ')' ELSE 'Out-of-sample (from ' || $7::text || ')' END,
                   ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Open FVG/OB past the stop', CASE WHEN pd_beyond_n IS NULL THEN 'n/a' WHEN pd_beyond_n = 0 THEN 'None'
                        WHEN pd_beyond_near_pct < 1 THEN 'Yes · nearest < 1% past stop' ELSE 'Yes · nearest ≥ 1% past stop' END, ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'LTF 1H at the fill', coalesce(ltf_1h, 'n/a (intraday run)'), ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'LTF 30m at the fill', coalesce(ltf_30m, 'n/a (intraday run)'), ${STAT_SQL} FROM b GROUP BY 2
         UNION ALL SELECT 'Year', extract(year from entry_date)::int::text, ${STAT_SQL} FROM b GROUP BY 2
         ORDER BY 1, 2`,
        [...selArgs, split],
      ),
      pool.query(`SELECT * FROM reversal_audit WHERE run_id = $1 ORDER BY pivot_date, sym LIMIT 20000`, [runId]),
      pool.query(
        `SELECT lookback, fate, count(*)::int AS n,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY internal_dist_pct)::float AS med_internal_dist_pct,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY mfe20_pct)::float AS med_mfe20_pct,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY mae20_pct)::float AS med_mae20_pct
           FROM reversal_sweeps WHERE run_id = $1 GROUP BY lookback, fate ORDER BY lookback, n DESC`,
        [runId],
      ),
      pool.query(`SELECT lookback, typ, count(*)::int AS n FROM reversal_events WHERE run_id = $1 GROUP BY lookback, typ ORDER BY lookback, typ`, [runId]),
      pool.query(`SELECT count(*)::int AS n FROM reversal_signals WHERE run_id = $1`, [runId]),
      pool.query(
        `SELECT count(*)::int AS n, max(r)::float AS max_r FROM reversal_trades
          WHERE run_id = $1 AND outcome IN ('win', 'loss', 'timeout') AND exit_verified IS TRUE AND setup_valid IS TRUE AND ($2::boolean = false OR is_primary) AND risk_ok = false
            AND model = $3 AND target = $4 AND stop_mode = $5`,
        [runId, primaryOnly, model, target, stopMode],
      ),
      // the audit list is capped at 20k rows; the category cards use the full counts
      pool.query(`SELECT category, count(*)::int AS n FROM reversal_audit WHERE run_id = $1 GROUP BY category`, [runId]),
    ]);

    return NextResponse.json({
      ok: true,
      runs: plainDates(runs),
      runId,
      timeframe: runRow.timeframe ?? "1d",
      period: runRow.period ?? "2026",
      split,
      selection: { model, target, stopMode, primaryOnly, riskOnly },
      grid: grid.rows,
      trades: plainDates(trades.rows),
      segments: segments.rows,
      audit: plainDates(audit.rows),
      fates: fates.rows,
      events: events.rows,
      signalCount: signals.rows[0]?.n ?? 0,
      tinyRisk: excluded.rows[0] ?? { n: 0, max_r: null },
      auditCounts: Object.fromEntries(auditCounts.rows.map((r) => [r.category, r.n])),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Postgres error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
