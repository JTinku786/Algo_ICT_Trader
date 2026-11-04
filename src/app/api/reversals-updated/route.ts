import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";
import { buildCsv, csvDownloadResponse } from "@/lib/csv-export";
import { parseReversalFilters, type ReversalRow } from "@/lib/reversals-updated";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const PAGE_SIZE = 50;

export async function GET(request: NextRequest) {
  let filters;
  try { filters = parseReversalFilters(request.nextUrl.searchParams); }
  catch (error) { return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Invalid filters" }, { status: 400 }); }
  const f = filters;
  const client = await Promise.resolve().then(() => getPostgresPool().connect()).catch(() => null);
  if (!client) return NextResponse.json({ ok: false, error: "Reversal data is temporarily unavailable. Try again." }, { status: 503 });
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const source = f.lane === "history" ? "reversal_runs" : f.lane === "paper" ? "realtime_production_reversal_k1_setups" : "reversal_k1_live_orders";
    const exists = (await client.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${source}`])).rows[0].ok;
    let run = null;
    if (exists && f.lane === "history") {
      run = (await client.query(`SELECT run_id, data_start::text, data_end::text, created_at, timeframe FROM reversal_runs
        WHERE config_name='k1_reclaim3' AND timeframe=$1 AND period=$2 ORDER BY created_at DESC,run_id DESC LIMIT 1`, [f.tf, f.market === "forex" ? "FX_FULL" : "FULL"])).rows[0] ?? null;
    }
    const available = exists && (f.lane !== "history" || Boolean(run)) && !(f.lane === "practice" && f.market !== "forex");
    // Normalize all three contracts; preserve their evidence and never mix their outcomes.
    const history = `SELECT trade_id AS id,sym AS ticker,CASE WHEN side='bull' THEN 'BUY' ELSE 'SELL' END AS direction,
      outcome AS state,entry_date AS entry_filter,entry_date::text AS entry_at,exit_date::text AS exit_at,
      entry,stop,tgt AS target,exit_price,r,risk_pct,decision_known_at AS decision_at,filled_at AS fill_at,NULL::timestamptz AS observed_at,
      exit_evidence->>'policy_version' AS policy,setup_validation->>'verdict' AS validation,NULL::text AS reason,
      NULL::float AS financing,NULL::float AS realized_pl,plan_r AS planned_rr,exit_evidence AS evidence,
      (is_primary IS TRUE AND risk_ok IS TRUE) AS eligible,
      (outcome IN ('win','loss') AND exit_verified IS TRUE AND setup_valid IS TRUE AND r IS NOT NULL) AS certified,
      extract(epoch FROM ((exit_date AT TIME ZONE 'America/New_York')-coalesce(filled_at,entry_date AT TIME ZONE 'America/New_York')))/86400.0 AS held_days,
      NULL::timestamptz AS updated_at FROM reversal_trades
      WHERE run_id=$1 AND model='OTE62_limit' AND target='2R' AND stop_mode='hard'`;
    const paper = `SELECT order_id::text AS id,ticker,direction,state,entry_datetime AT TIME ZONE 'America/New_York' AS entry_filter,
      entry_datetime::text AS entry_at,close_ts::text AS exit_at,entry_price AS entry,stoploss AS stop,tp1 AS target,close_price AS exit_price,realized_r AS r,
      (strategy_json->'trade'->>'risk_pct')::float AS risk_pct,
      to_timestamp((strategy_json->'entry_validation'->>'decision_known_at')::float/1000) AS decision_at,
      to_timestamp((strategy_json->'entry_validation'->>'filled_at')::float/1000) AS fill_at,observed_at,
      strategy_json->>'outcome_policy' AS policy,strategy_json->'entry_validation'->>'verdict' AS validation,
      coalesce(nullif((strategy_json->'exit_coverage'->'reasons')::text,'[]'),nullif((strategy_json->'entry_validation'->'reasons')::text,'[]')) AS reason,
      NULL::float AS financing,NULL::float AS realized_pl,2::float AS planned_rr,strategy_json AS evidence,
      (duplicate_of IS NULL AND (strategy_json->'trade'->>'risk_ok')::boolean IS TRUE) AS eligible,
      coalesce((state IN ('CLOSED_TP','CLOSED_SL') AND realized_r IS NOT NULL AND strategy_json->'entry_validation'->>'verdict'='VALID_PAPER_FILL'),false) AS certified,
      extract(epoch FROM (close_ts-coalesce(to_timestamp((strategy_json->'entry_validation'->>'filled_at')::float/1000),entry_datetime)))/86400.0 AS held_days,
      updated_at FROM realtime_production_reversal_k1_setups WHERE market=$1 AND timeframe=$2`;
    const practice = `SELECT k1_order_id::text AS id,ticker,direction,status AS state,
      coalesce(fill_ts,decided_at) AT TIME ZONE 'America/New_York' AS entry_filter,
      coalesce(fill_ts,decided_at)::text AS entry_at,close_ts::text AS exit_at,fill_price AS entry,stoploss AS stop,tp1 AS target,close_price AS exit_price,
      realized_r AS r,NULL::float AS risk_pct,NULL::timestamptz AS decision_at,fill_ts AS fill_at,observed_at,
      'OANDA_PRACTICE_MARKET'::text AS policy,NULL::text AS validation,coalesce(nullif(btrim(skip_reason),''),nullif(btrim(exit_reason),'')) AS reason,
      financing,realized_pl,planned_rr_at_market AS planned_rr,
      jsonb_build_object('environment','practice','decision_recorded_at',decided_at,'quote_bid',quote_bid,'quote_ask',quote_ask,
        'stop_breach_bar',stop_breach_bar,'stored_fill_response',raw ? 'orderFillTransaction') AS evidence,
      true AS eligible,(status LIKE 'CLOSED%' AND realized_r IS NOT NULL AND oanda_trade_id IS NOT NULL) AS certified,
      extract(epoch FROM (close_ts-fill_ts))/86400.0 AS held_days,
      updated_at FROM reversal_k1_live_orders WHERE market=$1 AND timeframe=$2`;
    const base = f.lane === "history" ? history : f.lane === "paper" ? paper : practice;
    const args: unknown[] = f.lane === "history" ? [run?.run_id ?? ""] : [f.market, f.tf];
    const symbolArg = args.push(f.symbol), startArg = args.push(f.start || null), endArg = args.push(f.end || null), costArg = args.push(f.costBps);
    const modeArg = args.push(f.costMode), spreadArg = args.push(f.spread), commissionArg = args.push(f.commissionBps), slipArg = args.push(f.slippageBps), financeArg = args.push(f.financingBpsPerDay);
    const estimatedCost = `CASE WHEN $${modeArg}::text='gross' THEN 0::float
      WHEN NOT (risk_pct>0) OR risk_pct IS NULL THEN NULL
      WHEN $${modeArg}::text='bps' THEN $${costArg}::float/(risk_pct*100)
      WHEN entry IS NULL OR stop IS NULL OR entry=stop OR ($${financeArg}::float>0 AND (held_days IS NULL OR held_days<0)) THEN NULL
      ELSE ${f.market === 'forex' ? `$${spreadArg}::float * CASE WHEN right(ticker,3)='JPY' THEN 0.01 ELSE 0.0001 END / nullif(abs(entry-stop),0)` : `$${spreadArg}::float/(risk_pct*100)`}
      + ($${commissionArg}::float + $${slipArg}::float + $${financeArg}::float*coalesce(held_days,0))/(risk_pct*100) END`;
    const cohort = `WITH source AS (${base}), filtered AS (SELECT * FROM source WHERE ($${symbolArg}::text='' OR ticker=$${symbolArg})
      AND ($${startArg}::date IS NULL OR entry_filter >= $${startArg}::date)
      AND ($${endArg}::date IS NULL OR entry_filter < $${endArg}::date + interval '1 day') AND $${costArg}::float>=0
      AND $${spreadArg}::float>=0 AND $${commissionArg}::float>=0 AND $${slipArg}::float>=0 AND $${financeArg}::float>=0),
      costed AS (SELECT *,${estimatedCost} AS cost_r FROM filtered),cohort AS (SELECT *,r-cost_r AS display_r FROM costed)`;
    const sensitivity = `CASE WHEN risk_pct>0 THEN r-$${costArg}::float/(risk_pct*100) END`;
    const valid = "eligible AND certified";
    const zero = { total: 0, closed: 0, wins: 0, losses: 0, open: 0, unverified: 0, invalid: 0, excluded: 0, other: 0, avg_r: null, sum_r: null, avg_loss: null, worst_r: null, tail_count: 0, sensitivity_r: null, sensitivity_n: 0, latest: null, adjusted_n: 0, adjusted_wins: 0, adjusted_losses: 0, adjusted_avg_r: null, adjusted_sum_r: null, adjusted_avg_loss: null, adjusted_worst_r: null, adjusted_tail_count: 0, avg_cost_r: null };
    let metrics = zero, yearly = [], policies = [], reasons = [], symbols: string[] = [], rows: ReversalRow[] = [], rowCount = 0;
    const csv = request.nextUrl.searchParams.get("format") === "csv";
    if (available) {
      // Each query runs in the same read-only snapshot. Counts cover the full cohort, not a page.
      metrics = (await client.query(`${cohort} SELECT count(*)::int AS total,
        count(*) FILTER(WHERE ${valid})::int AS closed,count(*) FILTER(WHERE ${valid} AND r>0)::int AS wins,
        count(*) FILTER(WHERE ${valid} AND r<=0)::int AS losses,count(*) FILTER(WHERE eligible AND state IN ('open','OPEN'))::int AS open,
        count(*) FILTER(WHERE eligible AND state IN ('unverified','UNVERIFIED'))::int AS unverified,
        count(*) FILTER(WHERE eligible AND (state='INVALID_EXECUTION' OR state IN ('win','loss','CLOSED_TP','CLOSED_SL') AND NOT certified))::int AS invalid,
        count(*) FILTER(WHERE NOT eligible)::int AS excluded,avg(r) FILTER(WHERE ${valid})::float AS avg_r,
        sum(r) FILTER(WHERE ${valid})::float AS sum_r,avg(r) FILTER(WHERE ${valid} AND r<0)::float AS avg_loss,
        min(r) FILTER(WHERE ${valid})::float AS worst_r,count(*) FILTER(WHERE ${valid} AND r < -1.5)::int AS tail_count,
        avg(${sensitivity}) FILTER(WHERE ${valid})::float AS sensitivity_r,
        count(*) FILTER(WHERE ${valid} AND risk_pct>0)::int AS sensitivity_n,max(updated_at) AS latest,
        count(display_r) FILTER(WHERE ${valid})::int AS adjusted_n,
        count(*) FILTER(WHERE ${valid} AND display_r>0)::int AS adjusted_wins,
        count(*) FILTER(WHERE ${valid} AND display_r<=0)::int AS adjusted_losses,
        avg(display_r) FILTER(WHERE ${valid})::float AS adjusted_avg_r,
        sum(display_r) FILTER(WHERE ${valid})::float AS adjusted_sum_r,
        avg(display_r) FILTER(WHERE ${valid} AND display_r<0)::float AS adjusted_avg_loss,
        min(display_r) FILTER(WHERE ${valid})::float AS adjusted_worst_r,
        count(*) FILTER(WHERE ${valid} AND display_r < -1.5)::int AS adjusted_tail_count,
        avg(cost_r) FILTER(WHERE ${valid})::float AS avg_cost_r FROM cohort`, args)).rows[0];
      yearly = (await client.query(`${cohort} SELECT extract(year from entry_filter)::text AS year,count(*)::int AS n,
        avg(r)::float AS avg_r,avg(${sensitivity})::float AS sensitivity_r,avg(display_r)::float AS adjusted_avg_r,count(display_r)::int AS adjusted_n FROM cohort WHERE ${valid} GROUP BY 1 ORDER BY 1`, args)).rows;
      policies = (await client.query(`${cohort} SELECT coalesce(policy,'Not recorded') AS policy,count(*)::int AS n FROM cohort WHERE ${valid} GROUP BY 1 ORDER BY 2 DESC`, args)).rows;
      reasons = (await client.query(`${cohort} SELECT coalesce(nullif(reason,'[]'),state) AS reason,count(*)::int AS n FROM cohort
        WHERE NOT (${valid}) GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, args)).rows;
      const symbolArgs = f.lane === "history" ? [run.run_id] : [f.market, f.tf];
      symbols = (await client.query(`SELECT DISTINCT ticker FROM (${base}) s ORDER BY ticker`, symbolArgs)).rows.map(r => r.ticker);
      rowCount = (await client.query(`${cohort} SELECT count(*)::int AS n FROM cohort WHERE eligible`, args)).rows[0].n;
      rows = (await client.query(`${cohort} SELECT id,ticker,direction,state,entry_at,exit_at,entry,stop,target,exit_price,r,risk_pct,
        decision_at,fill_at,observed_at,policy,validation,reason,financing,realized_pl,planned_rr,held_days::float AS held_days,cost_r,display_r,evidence
        FROM cohort WHERE eligible ORDER BY entry_filter DESC,id ${csv ? "" : `LIMIT ${PAGE_SIZE} OFFSET ${(f.page - 1) * PAGE_SIZE}`}`, args)).rows;
    }
    metrics.other = metrics.total - metrics.closed - metrics.open - metrics.unverified - metrics.invalid - metrics.excluded;
    await client.query("COMMIT");
    if (csv) {
      const keys = ["id","ticker","direction","state","entry_at","exit_at","entry","stop","target","exit_price","r","display_r","cost_r","held_days","risk_pct","decision_at","fill_at","observed_at","policy","validation","reason","financing","realized_pl","planned_rr","evidence"] as const;
      const body = buildCsv([...keys.map(key => ({ key, value: (row: ReversalRow) => row[key] })), {key: "cost_assumptions",value: () => ({mode:f.costMode,roundTripBps:f.costBps,spread:f.spread,spreadUnit:f.market==='forex'?'pips':'bps',commissionBps:f.commissionBps,slippageBps:f.slippageBps,financingBpsPerDay:f.financingBpsPerDay})}], rows);
      return csvDownloadResponse(body, `reversals-updated-${f.lane}-${f.market}-${f.tf}.csv`, rows.length);
    }
    return NextResponse.json({ ok: true, generated_at: new Date().toISOString(), filters: f, available, run, metrics, yearly, policies, reasons, symbols, rows, row_count: rowCount, page_size: PAGE_SIZE });
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    return NextResponse.json({ ok: false, error: "The selected reversal cohort could not be loaded. Retry or narrow the date range." }, { status: 503 });
  } finally { client.release(); }
}
