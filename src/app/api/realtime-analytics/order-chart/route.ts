import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

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
         WHERE o.order_id = $1 LIMIT 1`,
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

    if (!o && !sig) {
      return NextResponse.json({ success: false, error: "order or signal not found" }, { status: 404 });
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
      const candles = [...cmap.values()].sort((a, b) => a.time - b.time);
      return NextResponse.json({ success: true, candles, window: { from: fromTsParam, to: toTsParam }, timeframe: "5m" });
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
    const closeSec = epoch(closeTs) ?? Math.floor(Date.now() / 1000);
    const rawSpan = Math.max(closeSec - filledSec, 3600);
    const stepSec = 300;
    const pad = Math.max(rawSpan * 0.4, 24 * stepSec);
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
         ORDER BY candle_ts ASC LIMIT 2000`,
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
         ORDER BY candle_ts ASC LIMIT 2000`,
        [symbol, base, fromIso, toIso],
      );
      addCandles(hist.rows);
    } catch {
      /* historical candle table unavailable for this symbol */
    }
    const candles = [...candleMap.values()].sort((a, b) => a.time - b.time);

    // 3) ICT overlays + bias (best effort — realtime signal table may differ).
    const overlays = JSON.parse(JSON.stringify(EMPTY_OVERLAYS)) as typeof EMPTY_OVERLAYS;
    if (sigId) {
      try {
        const sigRes = await pool.query(
          `SELECT weekly_bias, daily_bias, one_hour_bias,
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
          overlays.bias = { weekly: s.weekly_bias ?? null, daily: s.daily_bias ?? null, one_hour: s.one_hour_bias ?? null };
        }
      } catch {
        /* overlay columns not present on realtime signal table — degrade gracefully */
      }
    }

    // Outcome / realized R (points-based, matching the realtime analytics route).
    const dirUpper = (direction || "").toUpperCase();
    const riskPoints = entryPrice !== null && stoploss !== null ? Math.abs(entryPrice - stoploss) : null;
    const pnlPoints = entryPrice !== null && closePrice !== null ? (dirUpper === "SELL" ? entryPrice - closePrice : closePrice - entryPrice) : null;
    const realizedR = riskPoints && riskPoints > 0 && pnlPoints !== null ? Math.round((pnlPoints / riskPoints) * 100) / 100 : null;
    const upper = state.toUpperCase();
    const outcome = upper === "CLOSED_TP" ? "WIN" : upper === "CLOSED_SL" ? "LOSS" : upper.startsWith("CLOSED") ? (realizedR === null ? "UNKNOWN" : realizedR > 0 ? "WIN" : "LOSS") : upper === "OPEN" ? "OPEN" : "SIGNAL_ONLY";

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
      candles,
      overlays,
      window: { from: fromSec, to: toSec },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Postgres error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
