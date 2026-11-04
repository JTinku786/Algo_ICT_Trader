import { NextRequest, NextResponse } from "next/server";
import { REALTIME_ROWS_SOURCE } from "@/lib/realtime-rows-sql";
import { getPostgresPool } from "@/lib/db";
import { smtForTrades } from "@/lib/smt-signal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function epoch(v: string | null): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

type ObjRow = Record<string, unknown>;

function obj(value: unknown): ObjRow {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjRow : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

// V5 persists its IPDA/FVG/MSS/sweep proof inside strategy_json. Surface that
// proof on realtime charts even when the generic relevant_* columns are empty.
function extractIpdaEvidence(strategyJson: unknown, direction: unknown) {
  const pattern = obj(obj(strategyJson).pattern);
  const range = obj(pattern.ipda_range);
  const fvg = obj(pattern.fvg);
  const mss = obj(pattern.mss);
  const stopSwing = obj(pattern.previous_confirmed_swing_stop);
  const sweep = obj(pattern.liquidity_extreme);
  const low = num(range.low); const q25 = num(range.q25); const eq50 = num(range.eq50); const q75 = num(range.q75); const high = num(range.high);
  const ipda = [low, q25, eq50, q75, high].every((value) => value !== null)
    ? { low, q25, eq50, q75, high, start_time: epoch(text(range.start_ts)), end_time: epoch(text(range.end_ts)), sessions: num(range.sessions) ?? 20, selected_level: text(pattern.ipda_level_name) }
    : null;
  const fvgTime = epoch(text(fvg.formation_ts)); const fvgLow = num(fvg.zone_low); const fvgHigh = num(fvg.zone_high);
  const fvgOverlay = fvgTime !== null && fvgLow !== null && fvgHigh !== null
    ? { kind: "fvg", top: fvgHigh, bottom: fvgLow, time: fvgTime, direction: text(fvg.direction) || text(direction), broken: false, mitigated: false, filled: false, label: "VIRGIN FVG · FIRST TOUCH" } : null;
  const mssTime = epoch(text(mss.break_ts)); const mssPrice = num(mss.break_close) ?? num(obj(mss.pivot).price);
  const mssOverlay = mssTime !== null && mssPrice !== null
    ? { kind: "mss", top: mssPrice, bottom: mssPrice, time: mssTime, direction: text(mss.direction) || text(direction), broken: false, mitigated: false, filled: false, label: "MSS · CLOSE CONFIRMED" } : null;
  const swingTime = epoch(text(stopSwing.confirmation_ts) || text(stopSwing.pivot_ts)); const swingPrice = num(stopSwing.price);
  const swingOverlay = swingTime !== null && swingPrice !== null
    ? { kind: "swing", level: swingPrice, time: swingTime, side: text(stopSwing.kind), direction: text(direction), label: `${text(stopSwing.timeframe)?.toUpperCase() || "STRUCTURAL"} STOP SWING` } : null;
  const sweepTime = epoch(text(sweep.source_ts)); const sweepPrice = num(sweep.price);
  const sweepOverlay = sweepTime !== null && sweepPrice !== null
    ? { kind: "liquidity", level: sweepPrice, time: sweepTime, side: null, direction: text(direction), label: "LIQUIDITY SWEEP" } : null;
  return { ipda, fvgOverlay, mssOverlay, swingOverlay, sweepOverlay };
}

function mapZone(o: ObjRow, kindFallback: string) {
  // Structure events (BOS / MSS / CHoCH) carry a single `level` rather than a
  // top/bottom band — collapse those to a zero-height zone so they still render
  // as a clean horizontal line.
  const lvl = num(o.level);
  let top = num(o.top);
  let bottom = num(o.bottom);
  if ((top === null || bottom === null) && lvl !== null) {
    top = lvl;
    bottom = lvl;
  }
  const t = epoch((o.formed_datetime_et as string) || (o.start_datetime_et as string) || (o.bar_timestamp_et as string) || (o.event_datetime_et as string) || null);
  if (top === null || bottom === null || t === null) return null;
  return {
    kind: (o.zone_type as string) || (o.event_type as string) || kindFallback,
    top,
    bottom,
    time: t,
    direction: (o.direction as string) || null,
    broken: Boolean(o.broken),
    mitigated: Boolean(o.mitigated),
    filled: Boolean(o.fully_filled),
    label: (o.summary as string) || "",
  };
}

function mapLevel(o: ObjRow, kind: string) {
  const level = num(o.level);
  const t = epoch((o.bar_timestamp_et as string) || (o.formed_datetime_et as string) || (o.event_datetime_et as string) || null);
  if (level === null) return null;
  return {
    kind,
    level,
    time: t,
    side: (o.side as string) || null,
    direction: (o.direction as string) || null,
    label: (o.ict_label as string) || (o.liquidity_label as string) || (o.event_type as string) || kind,
  };
}

const EMPTY_OVERLAYS = {
  order_blocks: [] as unknown[],
  fvgs: [] as unknown[],
  liquidity: [] as unknown[],
  swings: [] as unknown[],
  structure: [] as unknown[],
  ipda: null as unknown,
  bias: null as unknown,
  timeframe_5m: {} as Record<string, unknown[]>,
  timeframe_15m: {} as Record<string, unknown[]>,
  timeframe_30m: {} as Record<string, unknown[]>,
  timeframe_1h: {} as Record<string, unknown[]>,
  timeframe_daily: {} as Record<string, unknown[]>,
  timeframe_weekly: {} as Record<string, unknown[]>,
};

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const orderId = (sp.get("order_id") || "").trim();
  const signalHash = (sp.get("signal_hash") || "").trim();
  const rejectionRunId = (sp.get("rejection_run_id") || "").trim();
  const target_no = [1, 2, 3].includes(Number(sp.get("target_no"))) ? Number(sp.get("target_no")) : 1;
  const fromTsParam = Number(sp.get("from_ts"));
  const toTsParam = Number(sp.get("to_ts"));
  const candlesOnly = Number.isFinite(fromTsParam) && Number.isFinite(toTsParam) && fromTsParam > 0 && toTsParam > fromTsParam;
  if (!orderId && !signalHash) {
    return NextResponse.json({ success: false, error: "order_id or signal_hash required" }, { status: 400 });
  }

  const restApiUrl = process.env.CANDLES_REST_API_URL;
  if (restApiUrl) {
    const upstreamUrl = new URL("/api/realtime-analytics/order-chart", restApiUrl);
    for (const [key, value] of sp.entries()) upstreamUrl.searchParams.set(key, value);
    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        headers: process.env.CANDLES_REST_API_TOKEN ? { "x-api-key": process.env.CANDLES_REST_API_TOKEN } : undefined,
        cache: "no-store",
      });
      const payload = await upstreamResponse.json();
      return NextResponse.json(payload, { status: upstreamResponse.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown REST API error";
      return NextResponse.json({ success: false, error: `REST API unavailable: ${message}` }, { status: 502 });
    }
  }

  try {
    const pool = getPostgresPool();

    // 1) Resolve the order (preferred) or fall back to the raw signal row.
    let o: ObjRow | null = null;
    if (orderId) {
      const res = await pool.query(
        `SELECT o.order_id, o.signal_id, o.symbol, o.market, o.direction,
                o.entry_price, o.filled_price, o.stoploss, o.tp1, o.tp2, o.tp3,
                o.qty, o.filled_at, o.close_price, o.close_ts, o.close_reason, o.state
         FROM realtime_production_orders o
         WHERE o.order_id::text = $1 LIMIT 1`,
        [orderId],
      );
      if (res.rowCount) o = res.rows[0];
    }
    if (!o && signalHash) {
      const res = await pool.query(
        `SELECT o.order_id, o.signal_id, o.symbol, o.market, o.direction,
                o.entry_price, o.filled_price, o.stoploss, o.tp1, o.tp2, o.tp3,
                o.qty, o.filled_at, o.close_price, o.close_ts, o.close_reason, o.state
         FROM realtime_production_orders o
         WHERE o.signal_id = $1
         ORDER BY o.updated_at DESC NULLS LAST LIMIT 1`,
        [signalHash],
      );
      if (res.rowCount) o = res.rows[0];
    }

    // Signal row (for prices when there is no order, symbol resolution, overlays, bias).
    const sigId = (o?.signal_id as string) || signalHash;
    let sig: ObjRow | null = null;
    if (sigId) {
      try {
        const res = await pool.query(
          `SELECT signal_hash, market, ticker, base_symbol, direction, entry_datetime,
                  entry_price, stoploss, target_1, target_2, target_3
           FROM realtime_production_ict_strategy_met_execution
           WHERE signal_hash = $1 LIMIT 1`,
          [sigId],
        );
        if (res.rowCount) sig = res.rows[0];
      } catch {
        sig = null;
      }
    }

    // Dedicated execution lanes are exposed through the same source as the trade list.
    if (!o && !sig) {
      const igsKey = orderId || signalHash;
      const res = await pool.query(
        `SELECT r.* FROM ${REALTIME_ROWS_SOURCE} r
         WHERE r.strategy_key IN ('IGS01V2','MSS_REVERSAL','REVERSAL_K1','SCALPING_OB_OB_V4','BPR_OB_V3') AND (r.order_id = $1 OR r.signal_hash = $1)
         LIMIT 1`,
        [igsKey],
      );
      if (res.rowCount) {
        const g = res.rows[0] as ObjRow;
        if (g.order_id) o = { ...g, symbol: g.ticker, signal_id: g.signal_hash };
        sig = {
          signal_hash: g.signal_hash, market: g.market, ticker: g.ticker, base_symbol: g.base_symbol, strategy_json:g.strategy_json,
          direction: g.direction, entry_datetime: g.entry_datetime, entry_price: g.signal_entry_price,
          stoploss: g.signal_stoploss, target_1: g.target_1, target_2: g.target_2, target_3: g.target_3,
        };
      }
    }

    if (!o && !sig) {
      return NextResponse.json({ success: false, error: "order or signal not found" }, { status: 404 });
    }

    // k1_reclaim3 entries are formed on Daily / 1H / 30m itself. Display the
    // completed native bars saved by that detector, instead of a 5m chart.
    const k1Proof=obj(sig?.strategy_json);
    if(k1Proof.config==="k1_reclaim3") {
      const candles=(Array.isArray(k1Proof.chart_candles)?k1Proof.chart_candles:[]).map((value:unknown)=>{
        const b=obj(value);return {time:Math.floor(Number(b.ts)/1000),open:num(b.o),high:num(b.h),low:num(b.l),close:num(b.c),volume:0};
      });
      const entryTime=epoch(o?.entry_datetime as string|null);
      const exitTime=epoch(o?.close_ts as string|null);
      return NextResponse.json({success:true,order:{...o,symbol:o?.symbol,entry_price:o?.entry_price,filled_price:o?.entry_price,filled_at:o?.entry_datetime,realized_r:o?.live_realized_r,outcome:o?.state==="CLOSED_TP"?"WIN":o?.state==="CLOSED_SL"?"LOSS":"OPEN"},timeframe:k1Proof.timeframe,
        markers:{entry:{time:entryTime,price:o?.entry_price},exit:{time:exitTime,price:o?.close_price,outcome:o?.state}},candles,
        overlays:{...EMPTY_OVERLAYS,strategy_timeframe:k1Proof.timeframe},window:{from:candles[0]?.time,to:candles.at(-1)?.time},rejection:null});
    }

    const symbol = (o?.symbol as string) || (sig?.ticker as string) || (sig?.base_symbol as string) || "";
    const base = (sig?.base_symbol as string) || symbol;

    // ----- Older-candle window fetch (lazy pan-left) --------------------------
    if (candlesOnly) {
      const fromIso = new Date(fromTsParam * 1000).toISOString();
      const toIso = new Date(toTsParam * 1000).toISOString();
      const cmap = new Map<number, { time: number; open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null }>();
      const addRows = (rows: ObjRow[]) => {
        for (const r of rows) {
          const t = epoch(r.candle_ts as string);
          const open = num(r.open_price);
          if (t === null || open === null || cmap.has(t)) continue;
          cmap.set(t, { time: t, open, high: num(r.high_price), low: num(r.low_price), close: num(r.close_price), volume: num(r.volume) });
        }
      };
      for (const tbl of ["candles_5m", "historical_candles_5m"]) {
        try {
          const res = await pool.query(
            `SELECT candle_ts, open_price, high_price, low_price, close_price, volume
             FROM ${tbl}
             WHERE (yahoo_symbol = $1 OR base_symbol = $1 OR yahoo_symbol = $2 OR base_symbol = $2)
               AND candle_ts >= $3::timestamptz AND candle_ts <= $4::timestamptz
             ORDER BY candle_ts ASC LIMIT 3000`,
            [symbol, base, fromIso, toIso],
          );
          addRows(res.rows);
        } catch {
          /* table not available for this symbol */
        }
      }
      try {
        const supplement = await pool.query(`SELECT candle_ts,open_price,high_price,low_price,close_price,volume
          FROM realtime_production_mss_reversal_candles
          WHERE (ticker=$1 OR ticker=$2) AND candle_ts >= $3::timestamptz AND candle_ts <= $4::timestamptz
          ORDER BY candle_ts LIMIT 3000`, [symbol, base, fromIso, toIso]);
        addRows(supplement.rows);
      } catch { /* isolated gap feed not populated */ }
      // A window that lands entirely in a market gap (weekend, holiday, data
      // hole) is not "history exhausted" - same rule as the Backtest chart:
      // fall back to the newest bars at or before to_ts so panning left keeps
      // working across the gap.
      if (cmap.size === 0) {
        for (const tbl of ["candles_5m", "historical_candles_5m"]) {
          try {
            const back = await pool.query(
              `SELECT candle_ts, open_price, high_price, low_price, close_price, volume
               FROM ${tbl}
               WHERE (yahoo_symbol = $1 OR base_symbol = $1 OR yahoo_symbol = $2 OR base_symbol = $2)
                 AND candle_ts <= $3::timestamptz
               ORDER BY candle_ts DESC LIMIT 1500`,
              [symbol, base, toIso],
            );
            addRows(back.rows);
          } catch {
            /* table not available for this symbol */
          }
        }
      }
      const candles = [...cmap.values()].sort((a, b) => a.time - b.time);
      return NextResponse.json({ success: true, candles, window: { from: fromTsParam, to: toTsParam }, timeframe: "5m" });
    }

    // Optional stored rejection context. The chart remains read-only and uses
    // the materialized ict_rejection_trade_* rows; no rejection geometry is
    // recomputed during a page request.
    let rejectionTrade: ObjRow | null = null;
    let rejectionOutcomes: ObjRow[] = [];
    if (rejectionRunId && o?.order_id) {
      const rejectionRes = await pool.query(
        `SELECT r.run_id, r.date_from, r.date_to, r.cost_bps_per_side,
                (r.date_to + 1)::timestamptz AS analysis_end,
                x.parent_order_id, x.parent_direction, x.parent_filled_at,
                x.parent_entry, x.parent_stop, x.parent_tp1, x.parent_tp2, x.parent_tp3,
                x.parent_close_at, x.parent_close_reason, x.rejection_direction,
                x.stop_touch_candle_at, x.rejection_entry_at, x.rejection_entry,
                x.rejection_stop, x.rejection_risk,
                x.parent_favorable_extreme_at, x.parent_favorable_extreme_price,
                x.parent_max_favorable_points, x.parent_max_favorable_pct,
                x.parent_max_favorable_r, x.parent_tp1_progress_pct,
                x.parent_pre_rejection_lesson,
                x.analysis_status, x.status_reason
         FROM ict_rejection_trade_orders x
         JOIN ict_rejection_trade_runs r ON r.run_id=x.run_id
         WHERE x.run_id=$1::uuid AND x.parent_order_id=$2
           AND r.status='COMPLETED'
         LIMIT 1`,
        [rejectionRunId, String(o.order_id)],
      );
      rejectionTrade = rejectionRes.rows[0] ?? null;
      if (rejectionTrade) {
        const outcomesRes = await pool.query(
          `SELECT target_no, original_rr, target_price, outcome, exit_price,
                  exit_at, gross_r, cost_r, net_r, cycle_net_r
           FROM ict_rejection_trade_target_outcomes
           WHERE run_id=$1::uuid AND parent_order_id=$2
           ORDER BY target_no`,
          [rejectionRunId, String(o.order_id)],
        );
        rejectionOutcomes = outcomesRes.rows;
      }
    }

    const market = (o?.market as string) || (sig?.market as string) || "";
    const direction = (o?.direction as string) || (sig?.direction as string) || null;

    const entryPrice = num(o?.filled_price) ?? num(o?.entry_price) ?? num(sig?.entry_price);
    const stoploss = num(o?.stoploss) ?? num(sig?.stoploss);
    const tp1 = num(o?.tp1) ?? num(sig?.target_1);
    const tp2 = num(o?.tp2) ?? num(sig?.target_2);
    const tp3 = num(o?.tp3) ?? num(sig?.target_3);
    const closePrice = num(o?.close_price);
    const state = (o?.state as string) || "SIGNAL_ONLY";

    const filledAt = (o?.filled_at as string) || (sig?.entry_datetime as string) || null;
    const closeTs = (o?.close_ts as string) || null;

    const filledSec = epoch(filledAt) ?? 0;
    const rejectionTimes = rejectionTrade
      ? [
          epoch(rejectionTrade.parent_favorable_extreme_at as string),
          epoch(rejectionTrade.stop_touch_candle_at as string),
          epoch(rejectionTrade.rejection_entry_at as string),
          epoch(rejectionTrade.analysis_end as string),
          ...rejectionOutcomes.map((row) => epoch(row.exit_at as string)),
        ].filter((value): value is number => value !== null)
      : [];
    const closeSec = Math.max(
      epoch(closeTs) ?? 0,
      ...rejectionTimes,
      // Open trades run to now; closed trades end at their exit (+ padding), like the Backtest chart.
      rejectionTimes.length || epoch(closeTs) !== null ? 0 : Math.floor(Date.now() / 1000),
    );
    const rawSpan = Math.max(closeSec - filledSec, 3600);
    const stepSec = 300;
    // Same context padding as the Backtest order chart (>= 30 bars each side).
    const pad = rejectionTrade ? 24 * stepSec : Math.max(rawSpan * 0.4, 30 * stepSec);
    const fromSec = filledSec - pad;
    const toSec = closeSec + pad;
    const fromIso = new Date(fromSec * 1000).toISOString();
    const toIso = new Date(toSec * 1000).toISOString();

    // 2) Candles: merge live 5m table with the historical 5m archive (best effort).
    const candleMap = new Map<number, { time: number; open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null }>();
    const addCandles = (rows: ObjRow[]) => {
      for (const r of rows) {
        const t = epoch(r.candle_ts as string);
        const open = num(r.open_price);
        if (t === null || open === null) continue;
        if (!candleMap.has(t)) {
          candleMap.set(t, { time: t, open, high: num(r.high_price), low: num(r.low_price), close: num(r.close_price), volume: num(r.volume) });
        }
      }
    };
    try {
      const live = await pool.query(
        `SELECT candle_ts, open_price, high_price, low_price, close_price, volume
         FROM candles_5m
         WHERE (yahoo_symbol = $1 OR base_symbol = $1 OR yahoo_symbol = $2 OR base_symbol = $2)
           AND candle_ts >= $3::timestamptz AND candle_ts <= $4::timestamptz
         ORDER BY candle_ts ASC LIMIT 5000`,
        [symbol, base, fromIso, toIso],
      );
      addCandles(live.rows);
    } catch {
      /* live candle table unavailable for this symbol */
    }
    try {
      const hist = await pool.query(
        `SELECT candle_ts, open_price, high_price, low_price, close_price, volume
         FROM historical_candles_5m
         WHERE (yahoo_symbol = $1 OR base_symbol = $1 OR yahoo_symbol = $2 OR base_symbol = $2)
           AND candle_ts >= $3::timestamptz AND candle_ts <= $4::timestamptz
         ORDER BY candle_ts ASC LIMIT 5000`,
        [symbol, base, fromIso, toIso],
      );
      addCandles(hist.rows);
    } catch {
      /* historical candle table unavailable for this symbol */
    }
    try {
      const supplement = await pool.query(`SELECT candle_ts,open_price,high_price,low_price,close_price,volume
        FROM realtime_production_mss_reversal_candles
        WHERE market=$5 AND (ticker=$1 OR ticker=$2) AND candle_ts >= $3::timestamptz AND candle_ts <= $4::timestamptz
        ORDER BY candle_ts LIMIT 5000`,[symbol,base,fromIso,toIso,market]);
      addCandles(supplement.rows);
    } catch { /* Isolated gap feed not yet populated. */ }
    // Forex 5m bars are derived from the 1m feed and can trail it by a few
    // minutes (or longer if the rollup job is down). Fill any missing 5m bucket
    // straight from the 1m table so live forex trades always have candles.
    try {
      const oneMin = await pool.query(
        `SELECT to_timestamp(floor(extract(epoch FROM candle_ts) / 300) * 300) AS candle_ts,
                (array_agg(open_price ORDER BY candle_ts))[1] AS open_price,
                max(high_price) AS high_price, min(low_price) AS low_price,
                (array_agg(close_price ORDER BY candle_ts DESC))[1] AS close_price,
                sum(volume) AS volume
         FROM historical_candles_1m
         WHERE (yahoo_symbol = $1 OR base_symbol = $1 OR yahoo_symbol = $2 OR base_symbol = $2)
           AND market = 'forex'
           AND candle_ts >= $3::timestamptz AND candle_ts <= $4::timestamptz
         GROUP BY 1 ORDER BY 1 LIMIT 3000`,
        [symbol, base, fromIso, toIso],
      );
      addCandles(oneMin.rows);
    } catch {
      /* 1m table unavailable */
    }
    const candles = [...candleMap.values()].sort((a, b) => a.time - b.time);

    // 3) ICT overlays + bias (best effort — realtime signal table may differ).
    const overlays = JSON.parse(JSON.stringify(EMPTY_OVERLAYS)) as typeof EMPTY_OVERLAYS;
    if (sigId) {
      try {
        const sigRes = await pool.query(
          `SELECT weekly_bias, daily_bias, one_hour_bias, strategy_json,
                  five_min_relevant_order_block AS ob_5m,
                  five_min_relevant_fvg AS fvg_5m,
                  five_min_relevant_liquidity_levels AS liq_5m,
                  five_min_relevant_swings AS sw_5m,
                  five_min_relevant_bos_mss_choch AS bos_5m,
                  fifteen_min_relevant_order_block AS ob_15m,
                  fifteen_min_relevant_fvg AS fvg_15m,
                  fifteen_min_relevant_liquidity_levels AS liq_15m,
                  fifteen_min_relevant_swings AS sw_15m,
                  fifteen_min_relevant_bos_mss_choch AS bos_15m,
                  thirty_min_relevant_order_block AS ob_30m,
                  thirty_min_relevant_fvg AS fvg_30m,
                  thirty_min_relevant_liquidity_levels AS liq_30m,
                  thirty_min_relevant_swings AS sw_30m,
                  thirty_min_relevant_bos_mss_choch AS bos_30m,
                  one_hour_relevant_order_block AS ob_1h,
                  one_hour_relevant_fvg AS fvg_1h,
                  one_hour_relevant_liquidity_levels AS liq_1h,
                  one_hour_relevant_swings AS sw_1h,
                  one_hour_relevant_bos_mss_choch AS bos_1h,
                  daily_relevant_order_block AS ob_d,
                  daily_relevant_fvg AS fvg_d,
                  daily_relevant_liquidity_levels AS liq_d,
                  daily_relevant_swings AS sw_d,
                  daily_relevant_bos_mss_choch AS bos_d,
                  weekly_relevant_order_block AS ob_w,
                  weekly_relevant_fvg AS fvg_w,
                  weekly_relevant_liquidity_levels AS liq_w,
                  weekly_relevant_swings AS sw_w,
                  weekly_relevant_bos_mss_choch AS bos_w
           FROM realtime_production_ict_strategy_met_execution
           WHERE signal_hash = $1 LIMIT 1`,
          [sigId],
        );
        if (sigRes.rowCount) {
          const s = sigRes.rows[0];
          // Higher-timeframe context (30m/1h liquidity sweeps, MSS/BOS, order
          // blocks) forms hours-to-days before the entry, well before the narrow
          // 5m candle window. Only exclude anything that happens AFTER the entry;
          // keep everything at/before it regardless of how early it formed.
          const inWindow = (t: number | null) => t === null || t <= filledSec + stepSec;
          const extractZones = (col: unknown, kind: string) => {
            const items = ((col as Record<string, unknown>)?.recent_10_order_blocks
              || (col as Record<string, unknown>)?.recent_10_fvgs
              || (col as Record<string, unknown>)?.recent_10_bos_mss_choch
              || []) as ObjRow[];
            return items.map((x) => mapZone(x, kind)).filter((z) => z && inWindow(z.time));
          };
          const extractLevels = (col: unknown, kind: string) => {
            const items = [
              ...(((col as Record<string, unknown>)?.recent_10_buyside_liquidity_levels || []) as ObjRow[]),
              ...(((col as Record<string, unknown>)?.recent_10_sellside_liquidity_levels || []) as ObjRow[]),
              ...(((col as Record<string, unknown>)?.recent_10_swing_highs || []) as ObjRow[]),
              ...(((col as Record<string, unknown>)?.recent_10_swing_lows || []) as ObjRow[]),
            ];
            return items.map((x) => mapLevel(x, kind)).filter((z) => z && inWindow(z.time));
          };
          const fillTf = (tfKey: "timeframe_5m" | "timeframe_15m" | "timeframe_30m" | "timeframe_1h" | "timeframe_daily" | "timeframe_weekly",
            ob: unknown, fvg: unknown, liq: unknown, sw: unknown, bos: unknown) => {
            overlays[tfKey]["order_blocks"] = extractZones(ob, "order_block");
            overlays[tfKey]["fvgs"] = extractZones(fvg, "fvg");
            overlays[tfKey]["liquidity"] = extractLevels(liq, "liquidity");
            overlays[tfKey]["swings"] = extractLevels(sw, "swing");
            overlays[tfKey]["structure"] = extractZones(bos, "structure");
          };
          fillTf("timeframe_5m", s.ob_5m, s.fvg_5m, s.liq_5m, s.sw_5m, s.bos_5m);
          fillTf("timeframe_15m", s.ob_15m, s.fvg_15m, s.liq_15m, s.sw_15m, s.bos_15m);
          fillTf("timeframe_30m", s.ob_30m, s.fvg_30m, s.liq_30m, s.sw_30m, s.bos_30m);
          fillTf("timeframe_1h", s.ob_1h, s.fvg_1h, s.liq_1h, s.sw_1h, s.bos_1h);
          fillTf("timeframe_daily", s.ob_d, s.fvg_d, s.liq_d, s.sw_d, s.bos_d);
          fillTf("timeframe_weekly", s.ob_w, s.fvg_w, s.liq_w, s.sw_w, s.bos_w);
          const ipdaEvidence = extractIpdaEvidence(s.strategy_json, direction);
          overlays.ipda = ipdaEvidence.ipda;
          if (ipdaEvidence.fvgOverlay) overlays.timeframe_5m["fvgs"].push(ipdaEvidence.fvgOverlay);
          if (ipdaEvidence.mssOverlay) overlays.timeframe_5m["structure"].push(ipdaEvidence.mssOverlay);
          if (ipdaEvidence.swingOverlay) overlays.timeframe_5m["swings"].push(ipdaEvidence.swingOverlay);
          if (ipdaEvidence.sweepOverlay) overlays.timeframe_5m["liquidity"].push(ipdaEvidence.sweepOverlay);
          overlays.bias = { weekly: s.weekly_bias ?? null, daily: s.daily_bias ?? null, one_hour: s.one_hour_bias ?? null };
        }
      } catch {
        /* overlay columns not present on realtime signal table — degrade gracefully */
      }
    }

    const mssProof=obj(sig?.strategy_json);
    if(mssProof.source==='realtime_production_mss_reversal_orders'){
      const z=obj(mssProof.zone),shift=obj(mssProof.shift);
      const overlay={kind:z.kind,top:z.high,bottom:z.low,time:Math.floor(Number(z.origin)/1000),direction:z.direction,label:`${z.kind} · MSS entry array`};
      if(['FVG','IFVG','BPR'].includes(String(z.kind)))overlays.fvgs.push(overlay);else overlays.order_blocks.push(overlay);
      overlays.structure.push({kind:'mss',top:shift.level,bottom:shift.level,time:Math.floor(Number(shift.at)/1000),direction:shift.direction,label:'SMC CHOCH · close'});
    }
    // Outcome / realized R (points-based, matching the realtime analytics route).
    const dirUpper = (direction || "").toUpperCase();
    const riskPoints = entryPrice !== null && stoploss !== null ? Math.abs(entryPrice - stoploss) : null;
    const pnlPoints = entryPrice !== null && closePrice !== null ? (dirUpper === "SELL" ? entryPrice - closePrice : closePrice - entryPrice) : null;
    const brokerR = num(o?.live_realized_r);
    const realizedR = brokerR !== null
      ? Math.round(brokerR * 100) / 100
      : riskPoints && riskPoints > 0 && pnlPoints !== null ? Math.round((pnlPoints / riskPoints) * 100) / 100 : null;
    const upper = state.toUpperCase();
    // SMT divergence at signal time (same cache key as /api/realtime-analytics).
    let smt = null;
    try {
      const key = `realtime:${(o?.order_id as string) || sigId}`;
      smt = (await smtForTrades(pool, [{ key, symbol: symbol || null, market: market || null, signalTs: (sig?.entry_datetime as string) || filledAt, direction }], 1)).get(key) ?? null;
    } catch { /* advisory */ }
    const outcome = upper === "CLOSED_TP" ? "WIN" : upper === "CLOSED_SL" ? "LOSS" : upper.startsWith("CLOSED") ? (realizedR === null ? "UNKNOWN" : realizedR > 0 ? "WIN" : "LOSS") : upper === "OPEN" || upper.includes("PENDING") ? "OPEN" : "SIGNAL_ONLY";

    return NextResponse.json({
      success: true,
      order: {
        order_id: (o?.order_id as string) || sigId,
        symbol,
        market,
        direction,
        entry_price: num(o?.entry_price) ?? num(sig?.entry_price),
        filled_price: entryPrice,
        stoploss,
        tp1,
        tp2,
        tp3,
        filled_at: filledAt,
        close_ts: closeTs,
        close_price: closePrice,
        close_reason: (o?.close_reason as string) || null,
        target_no,
        realized_r: realizedR,
        outcome,
      },
      timeframe: "5m",
      markers: {
        entry: { time: filledSec, price: entryPrice },
        exit: { time: closeSec, price: closePrice, outcome },
      },
      rejection: rejectionTrade ? {
        run_id: rejectionTrade.run_id,
        cost_bps_per_side: num(rejectionTrade.cost_bps_per_side),
        parent_direction: rejectionTrade.parent_direction,
        parent_filled_at: rejectionTrade.parent_filled_at,
        parent_entry: num(rejectionTrade.parent_entry),
        parent_stop: num(rejectionTrade.parent_stop),
        parent_targets: [num(rejectionTrade.parent_tp1), num(rejectionTrade.parent_tp2), num(rejectionTrade.parent_tp3)],
        parent_close_at: rejectionTrade.parent_close_at,
        rejection_direction: rejectionTrade.rejection_direction,
        stop_touch_candle_at: rejectionTrade.stop_touch_candle_at,
        rejection_entry_at: rejectionTrade.rejection_entry_at,
        rejection_entry: num(rejectionTrade.rejection_entry),
        rejection_stop: num(rejectionTrade.rejection_stop),
        rejection_risk: num(rejectionTrade.rejection_risk),
        parent_favorable_extreme_at: rejectionTrade.parent_favorable_extreme_at,
        parent_favorable_extreme_price: num(rejectionTrade.parent_favorable_extreme_price),
        parent_max_favorable_points: num(rejectionTrade.parent_max_favorable_points),
        parent_max_favorable_pct: num(rejectionTrade.parent_max_favorable_pct),
        parent_max_favorable_r: num(rejectionTrade.parent_max_favorable_r),
        parent_tp1_progress_pct: num(rejectionTrade.parent_tp1_progress_pct),
        parent_pre_rejection_lesson: rejectionTrade.parent_pre_rejection_lesson,
        analysis_status: rejectionTrade.analysis_status,
        outcomes: rejectionOutcomes.map((row) => ({
          target_no: num(row.target_no),
          original_rr: num(row.original_rr),
          target_price: num(row.target_price),
          outcome: row.outcome,
          exit_price: num(row.exit_price),
          exit_at: row.exit_at,
          gross_r: num(row.gross_r),
          cost_r: num(row.cost_r),
          net_r: num(row.net_r),
          cycle_net_r: num(row.cycle_net_r),
        })),
      } : null,
      candles,
      overlays,
      smt,
      window: { from: fromSec, to: toSec },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Postgres error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
