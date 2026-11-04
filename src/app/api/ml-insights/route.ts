import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Live ML-scorecard analytics over the scored order book.
// Params: strategy, model, source, market, ticker.
// Returns: decile bands, KS, Gini, AUC, PSI (vs 2017-22 training baseline), calibration, ticker list.

type Row = { p: number; b: number | null; win: number | null; rr: number | null; ticker: string; market: string; yr: number | null };

function ksGiniAuc(rows: { p: number; win: number }[]) {
  if (rows.length < 10) return { auc: null, ks: null, gini: null };
  const s = [...rows].sort((a, b) => a.p - b.p);
  const G = s.reduce((a, r) => a + r.win, 0);
  const B = s.length - G;
  if (G === 0 || B === 0) return { auc: null, ks: null, gini: null };
  let cg = 0, cb = 0, ks = 0;
  // AUC via Mann-Whitney (rank of positives)
  let rankSum = 0;
  for (let i = 0; i < s.length; i++) rankSum += s[i].win ? i + 1 : 0;
  const auc = (rankSum - (G * (G + 1)) / 2) / (G * B);
  for (const r of s) { cg += r.win / G; cb += (1 - r.win) / B; ks = Math.max(ks, Math.abs(cg - cb)); }
  return { auc, ks, gini: 2 * auc - 1 };
}

function psi(base: number[], comp: number[]) {
  const bs = base.reduce((a, x) => a + x, 0) || 1;
  const cs = comp.reduce((a, x) => a + x, 0) || 1;
  const eps = 1e-6;
  let v = 0;
  for (let i = 0; i < Math.max(base.length, comp.length); i++) {
    const bp = (base[i] || 0) / bs + eps;
    const cp = (comp[i] || 0) / cs + eps;
    v += (cp - bp) * Math.log(cp / bp);
  }
  return v;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const strategy = (sp.get("strategy") || "S03").toUpperCase();
  const source = (sp.get("source") || "backtest").toLowerCase();
  const market = (sp.get("market") || "all").toLowerCase();
  const ticker = (sp.get("ticker") || "all").toUpperCase();
  const requestedModel = (sp.get("model") || "incumbent").toLowerCase();
  const allowedModels = new Set(["incumbent", "s03_catboost_v2_stable_tp1", "s03_catboost_v2_stable_tp2"]);
  const model = allowedModels.has(requestedModel) ? requestedModel : "incumbent";
  const stableModel = model.startsWith("s03_catboost_v2_stable_");
  const target = model.endsWith("_tp1") ? "tp1" : "tp2";
  const bandCount = stableModel ? 5 : 10;
  const pool = getPostgresPool();

  if (stableModel && source !== "realtime") {
    return NextResponse.json(
      { ok: false, error: "S03 V2 Stable is available from realtime shadow scores; use source=realtime." },
      { status: 400 },
    );
  }

  try {
    let rowsSql: string;
    const params: unknown[] = [strategy];
    if (source === "realtime") {
      const probability = stableModel
        ? `NULLIF(s.strategy_json->'ml_scores'->'${model}'->>'prob','')::float8`
        : "o.risk_probability::float8";
      const riskBin = stableModel
        ? `NULLIF(s.strategy_json->'ml_scores'->'${model}'->>'bin','')::int`
        : "o.risk_bin";
      const outcome = stableModel && target === "tp2"
        ? "NULL::int"
        : "CASE WHEN o.state='CLOSED_TP' THEN 1 WHEN o.state='CLOSED_SL' THEN 0 ELSE NULL END";
      rowsSql = `
        SELECT ${probability} p, ${riskBin} b,
               ${outcome} win,
               NULL::float8 rr, s.base_symbol ticker, LOWER(COALESCE(o.source_market,s.market)) market,
               EXTRACT(YEAR FROM COALESCE(o.filled_at,o.created_at))::int yr
        FROM realtime_production_orders o
        JOIN realtime_production_ict_strategy_met_execution s ON s.signal_hash=o.signal_id
        WHERE s.strategy_id=$1 AND ${probability} IS NOT NULL`;
      if (market !== "all") { params.push(market); rowsSql += ` AND LOWER(COALESCE(o.source_market,s.market))=$${params.length}`; }
      if (ticker !== "ALL") { params.push(ticker); rowsSql += ` AND UPPER(s.base_symbol)=$${params.length}`; }
    } else {
      rowsSql = `
        SELECT o.risk_probability::float8 p, o.risk_bin b,
               (oc.state='CLOSED_TP')::int win, oc.target_rr::float8 rr, o.symbol ticker, 'us' market,
               EXTRACT(YEAR FROM o.filled_at)::int yr
        FROM historical_ict_orders o
        JOIN historical_ict_order_target_outcomes oc ON oc.order_id=o.order_id AND oc.target_no=2
        WHERE o.strategy_id=$1 AND o.risk_probability IS NOT NULL AND oc.state IN ('CLOSED_TP','CLOSED_SL')`;
      if (ticker !== "ALL") { params.push(ticker); rowsSql += ` AND UPPER(o.symbol)=$${params.length}`; }
    }

    const [rowsRes, baseRes, tickRes] = await Promise.all([
      pool.query(rowsSql, params),
      stableModel ? Promise.resolve({ rows: [] }) : pool.query(
        `SELECT risk_bin b, COUNT(*)::int n FROM historical_ict_orders
         WHERE strategy_id=$1 AND risk_probability IS NOT NULL
           AND EXTRACT(YEAR FROM filled_at) BETWEEN 2017 AND 2022 GROUP BY 1`,
        [strategy],
      ),
      source === "realtime"
        ? pool.query(
            `SELECT DISTINCT s.base_symbol t FROM realtime_production_orders o
             JOIN realtime_production_ict_strategy_met_execution s ON s.signal_hash=o.signal_id
             WHERE s.strategy_id=$1 AND ${stableModel ? `s.strategy_json->'ml_scores'->'${model}' IS NOT NULL` : "o.risk_probability IS NOT NULL"} ORDER BY 1`,
            [strategy],
          )
        : pool.query(
            `SELECT DISTINCT symbol t FROM historical_ict_orders
             WHERE strategy_id=$1 AND risk_probability IS NOT NULL ORDER BY 1`,
            [strategy],
          ),
    ]);

    const rows = rowsRes.rows as Row[];
    const n = rows.length;

    // decile bands
    const bands = Array.from({ length: bandCount }, (_, i) => ({ bin: i + 1, n: 0, sumP: 0, wins: 0, closed: 0, sumR: 0 }));
    const compDist = new Array(bandCount).fill(0);
    for (const r of rows) {
      const bi = Math.min(bandCount - 1, Math.max(0, (r.b ?? 1) - 1));
      const band = bands[bi];
      band.n++; band.sumP += r.p; compDist[bi]++;
      if (r.win !== null) {
        band.closed++; band.wins += r.win;
        band.sumR += r.win ? (r.rr ?? 2) : -1;
      }
    }
    const decileOut = bands.map((b) => ({
      bin: b.bin, n: b.n,
      avgProb: b.n ? b.sumP / b.n : null,
      actual: b.closed ? b.wins / b.closed : null,
      expR: b.closed ? b.sumR / b.closed : null,
    }));

    const closedPairs = rows.filter((r) => r.win !== null).map((r) => ({ p: r.p, win: r.win as number }));
    const disc = ksGiniAuc(closedPairs);
    const overall = closedPairs.length ? closedPairs.reduce((a, r) => a + r.win, 0) / closedPairs.length : null;

    const baseDist = new Array(bandCount).fill(stableModel ? 1 : 0);
    for (const r of baseRes.rows as { b: number; n: number }[]) baseDist[Math.min(bandCount - 1, Math.max(0, r.b - 1))] = r.n;
    const psiVal = n >= 10 ? psi(baseDist, compDist) : null;

    // per-year drift & performance trend
    const byYear = new Map<number, Row[]>();
    for (const r of rows) {
      if (r.yr == null) continue;
      if (!byYear.has(r.yr)) byYear.set(r.yr, []);
      byYear.get(r.yr)!.push(r);
    }
    const trend = [...byYear.keys()].sort((a, b) => a - b).map((yr) => {
      const yrRows = byYear.get(yr)!;
      const dist = new Array(bandCount).fill(0);
      for (const r of yrRows) dist[Math.min(bandCount - 1, Math.max(0, (r.b ?? 1) - 1))]++;
      const pairs = yrRows.filter((r) => r.win !== null).map((r) => ({ p: r.p, win: r.win as number }));
      const d = ksGiniAuc(pairs);
      return {
        year: yr,
        n: yrRows.length,
        winRate: pairs.length ? pairs.reduce((a, r) => a + r.win, 0) / pairs.length : null,
        auc: d.auc, ks: d.ks,
        psi: yrRows.length >= 15 ? psi(baseDist, dist) : null,
      };
    });

    return NextResponse.json({
      ok: true,
      strategy, model, target, source, market, ticker,
      n, closed: closedPairs.length, overall,
      auc: disc.auc, ks: disc.ks, gini: disc.gini, psi: psiVal,
      deciles: decileOut,
      baseDist, compDist,
      trend,
      tickers: (tickRes.rows as { t: string }[]).map((r) => r.t).filter(Boolean),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
