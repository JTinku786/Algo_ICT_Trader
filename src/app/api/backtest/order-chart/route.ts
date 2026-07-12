import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function epoch(v: string | null): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

// choose candle table by window length (seconds)
function pickTable(spanSec: number) {
  const day = 86400;
  if (spanSec <= 4 * day) return { table: "historical_candles_5m", stepSec: 300 };
  if (spanSec <= 25 * day) return { table: "historical_candles_1h", stepSec: 3600 };
  return { table: "candles_1d", stepSec: 86400 };
}

type ObjRow = Record<string, unknown>;

function mapZone(o: ObjRow, kindFallback: string) {
  const top = num(o.top);
  const bottom = num(o.bottom);
  const t = epoch((o.event_datetime_et as string) || (o.formed_datetime_et as string) || null);
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
  const t = epoch((o.event_datetime_et as string) || (o.bar_timestamp_et as string) || null);
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

function stepTable(step: number) {
  if (step <= 600) return { table: "historical_candles_5m", stepSec: 300 };
  if (step <= 7200) return { table: "historical_candles_1h", stepSec: 3600 };
  return { table: "candles_1d", stepSec: 86400 };
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const orderId = (sp.get("order_id") || "").trim();
  const target_no = [1, 2, 3].includes(Number(sp.get("target_no"))) ? Number(sp.get("target_no")) : 1;
  // Optional explicit candle window (used by the chart to lazy-load older bars
  // when the user pans/drag-scrolls to the left). When present we return only
  // candles for that range and skip the heavy ICT overlay assembly.
  const fromTsParam = Number(sp.get("from_ts"));
  const toTsParam = Number(sp.get("to_ts"));
  const stepParam = Number(sp.get("step")) || 300;
  const candlesOnly = Number.isFinite(fromTsParam) && Number.isFinite(toTsParam) && fromTsParam > 0 && toTsParam > fromTsParam;
  if (!orderId) {
    return NextResponse.json({ success: false, error: "order_id required" }, { status: 400 });
  }

  const restApiUrl = process.env.CANDLES_REST_API_URL;
  if (restApiUrl) {
    const upstreamUrl = new URL("/api/backtest/order-chart", restApiUrl);
    for (const [key, value] of sp.entries()) {
      upstreamUrl.searchParams.set(key, value);
    }
    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        headers: process.env.CANDLES_REST_API_TOKEN
          ? { "x-api-key": process.env.CANDLES_REST_API_TOKEN }
          : undefined,
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
    const orderRes = await pool.query(
      `SELECT o.order_id, o.signal_id, o.symbol, o.market, o.direction,
              o.entry_price, o.filled_price, o.stoploss, o.tp1, o.tp2, o.tp3,
              o.filled_at, t.target_no, t.target_price, t.target_rr, t.state,
              t.close_ts, t.close_price, t.close_reason
       FROM historical_ict_orders o
       JOIN historical_ict_order_target_outcomes t ON t.order_id=o.order_id
       WHERE o.order_id = $1 AND t.target_no = $2
       LIMIT 1`,
      [orderId, target_no],
    );
    if (orderRes.rowCount === 0) {
      return NextResponse.json({ success: false, error: "order not found" }, { status: 404 });
    }
    const o = orderRes.rows[0];
    const symbol = o.symbol as string;

    // ----- Older-candle window fetch (lazy pan-left) --------------------------
    if (candlesOnly) {
      const { table: tbl, stepSec: st } = stepTable(stepParam);
      const fromIso = new Date(fromTsParam * 1000).toISOString();
      const toIso = new Date(toTsParam * 1000).toISOString();
      const res = await pool.query(
        `SELECT candle_ts, open_price, high_price, low_price, close_price, volume
         FROM ${tbl}
         WHERE (yahoo_symbol = $1 OR base_symbol = $1)
           AND candle_ts >= $2::timestamptz AND candle_ts <= $3::timestamptz
         ORDER BY candle_ts ASC LIMIT 3000`,
        [symbol, fromIso, toIso],
      );
      const candles = res.rows
        .map((r) => ({ time: epoch(r.candle_ts as string), open: num(r.open_price), high: num(r.high_price), low: num(r.low_price), close: num(r.close_price), volume: num(r.volume) }))
        .filter((c) => c.time !== null && c.open !== null);
      return NextResponse.json({ success: true, candles, window: { from: fromTsParam, to: toTsParam }, timeframe: st === 300 ? "5m" : st === 3600 ? "1h" : "1d" });
    }

    const filledSec = epoch(o.filled_at) ?? 0;
    const closeSec = epoch(o.close_ts) ?? filledSec;
    const rawSpan = Math.max(closeSec - filledSec, 3600);
    const { table, stepSec } = pickTable(rawSpan);
    const pad = Math.max(rawSpan * 0.4, 30 * stepSec);
    const fromSec = filledSec - pad;
    const toSec = closeSec + pad;
    const fromIso = new Date(fromSec * 1000).toISOString();
    const toIso = new Date(toSec * 1000).toISOString();

    const candleRes = await pool.query(
      `SELECT candle_ts, open_price, high_price, low_price, close_price, volume
       FROM ${table}
       WHERE (yahoo_symbol = $1 OR base_symbol = $1)
         AND candle_ts >= $2::timestamptz AND candle_ts <= $3::timestamptz
       ORDER BY candle_ts ASC
       LIMIT 1500`,
      [symbol, fromIso, toIso],
    );

    const candles = candleRes.rows
      .map((r) => ({
        time: epoch(r.candle_ts as string),
        open: num(r.open_price),
        high: num(r.high_price),
        low: num(r.low_price),
        close: num(r.close_price),
        volume: num(r.volume),
      }))
      .filter((c) => c.time !== null && c.open !== null);

    // Signal ICT overlays (all timeframes) — best-effort join
    const overlays: {
      order_blocks: unknown[];
      fvgs: unknown[];
      liquidity: unknown[];
      swings: unknown[];
      structure: unknown[];
      bias: unknown | null;
      timeframe_5m: Record<string, unknown[]>;
      timeframe_15m: Record<string, unknown[]>;
      timeframe_30m: Record<string, unknown[]>;
      timeframe_1h: Record<string, unknown[]>;
      timeframe_daily: Record<string, unknown[]>;
      timeframe_weekly: Record<string, unknown[]>;
    } = { order_blocks: [], fvgs: [], liquidity: [], swings: [], structure: [], bias: null, timeframe_5m: {}, timeframe_15m: {}, timeframe_30m: {}, timeframe_1h: {}, timeframe_daily: {}, timeframe_weekly: {} };

    if (o.signal_id) {
      const sigRes = await pool.query(
        `SELECT signal_hash, strategy_id, ticker, direction, entry_datetime,
                weekly_bias, daily_bias, one_hour_bias,
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
         FROM historical_ict_strategy_met_execution
         WHERE signal_hash = $1 LIMIT 1`,
        [o.signal_id],
      );
      if (sigRes.rowCount && sigRes.rowCount > 0) {
        const s = sigRes.rows[0];
        const inWindow = (t: number | null) => t === null || (t >= fromSec - stepSec && t <= toSec + stepSec);

        // Helper to extract zone-type overlays from a column
        function extractZones(col: unknown, kind: string) {
          const items = ((col as Record<string, unknown>)?.recent_10_order_blocks
            || (col as Record<string, unknown>)?.recent_10_fvgs
            || (col as Record<string, unknown>)?.recent_10_bos_mss_choch
            || []) as ObjRow[];
          return items.map((x) => mapZone(x, kind)).filter((z) => z && inWindow(z.time));
        }
        function extractLevels(col: unknown, kind: string) {
          const items = [
            ...(((col as Record<string, unknown>)?.recent_10_buyside_liquidity_levels || []) as ObjRow[]),
            ...(((col as Record<string, unknown>)?.recent_10_sellside_liquidity_levels || []) as ObjRow[]),
            ...(((col as Record<string, unknown>)?.recent_10_swing_highs || []) as ObjRow[]),
            ...(((col as Record<string, unknown>)?.recent_10_swing_lows || []) as ObjRow[]),
          ];
          return items.map((x) => mapLevel(x, kind)).filter((z) => z && inWindow(z.time));
        }

        // 5m overlays
        overlays.timeframe_5m["order_blocks"] = extractZones(s.ob_5m, "order_block");
        overlays.timeframe_5m["fvgs"] = extractZones(s.fvg_5m, "fvg");
        overlays.timeframe_5m["liquidity"] = extractLevels(s.liq_5m, "liquidity");
        overlays.timeframe_5m["swings"] = extractLevels(s.sw_5m, "swing");
        overlays.timeframe_5m["structure"] = extractZones(s.bos_5m, "structure");

        // 30m overlays (best-effort, may be null)
        overlays.timeframe_30m["order_blocks"] = extractZones(s.ob_30m, "order_block");
        overlays.timeframe_30m["fvgs"] = extractZones(s.fvg_30m, "fvg");
        overlays.timeframe_30m["liquidity"] = extractLevels(s.liq_30m, "liquidity");
        overlays.timeframe_30m["swings"] = extractLevels(s.sw_30m, "swing");
        overlays.timeframe_30m["structure"] = extractZones(s.bos_30m, "structure");

        // 15m overlays
        overlays.timeframe_15m["order_blocks"] = extractZones(s.ob_15m, "order_block");
        overlays.timeframe_15m["fvgs"] = extractZones(s.fvg_15m, "fvg");
        overlays.timeframe_15m["liquidity"] = extractLevels(s.liq_15m, "liquidity");
        overlays.timeframe_15m["swings"] = extractLevels(s.sw_15m, "swing");
        overlays.timeframe_15m["structure"] = extractZones(s.bos_15m, "structure");

        // 1h overlays
        overlays.timeframe_1h["order_blocks"] = extractZones(s.ob_1h, "order_block");
        overlays.timeframe_1h["fvgs"] = extractZones(s.fvg_1h, "fvg");
        overlays.timeframe_1h["liquidity"] = extractLevels(s.liq_1h, "liquidity");
        overlays.timeframe_1h["swings"] = extractLevels(s.sw_1h, "swing");
        overlays.timeframe_1h["structure"] = extractZones(s.bos_1h, "structure");

        // Daily overlays
        overlays.timeframe_daily["order_blocks"] = extractZones(s.ob_d, "order_block");
        overlays.timeframe_daily["fvgs"] = extractZones(s.fvg_d, "fvg");
        overlays.timeframe_daily["liquidity"] = extractLevels(s.liq_d, "liquidity");
        overlays.timeframe_daily["swings"] = extractLevels(s.sw_d, "swing");
        overlays.timeframe_daily["structure"] = extractZones(s.bos_d, "structure");

        // Weekly overlays
        overlays.timeframe_weekly["order_blocks"] = extractZones(s.ob_w, "order_block");
        overlays.timeframe_weekly["fvgs"] = extractZones(s.fvg_w, "fvg");
        overlays.timeframe_weekly["liquidity"] = extractLevels(s.liq_w, "liquidity");
        overlays.timeframe_weekly["swings"] = extractLevels(s.sw_w, "swing");
        overlays.timeframe_weekly["structure"] = extractZones(s.bos_w, "structure");

        // Bias
        overlays.bias = {
          weekly: s.weekly_bias,
          daily: s.daily_bias,
          one_hour: s.one_hour_bias,
        };

        // Also populate the flat arrays for backward compat
        overlays.order_blocks = [
          ...(overlays.timeframe_5m["order_blocks"] as ObjRow[]),
          ...(overlays.timeframe_30m["order_blocks"] as ObjRow[]),
        ];
        overlays.fvgs = [
          ...(overlays.timeframe_5m["fvgs"] as ObjRow[]),
          ...(overlays.timeframe_30m["fvgs"] as ObjRow[]),
        ];
        overlays.liquidity = [
          ...(overlays.timeframe_5m["liquidity"] as ObjRow[]),
          ...(overlays.timeframe_30m["liquidity"] as ObjRow[]),
        ];
        overlays.swings = [
          ...(overlays.timeframe_5m["swings"] as ObjRow[]),
          ...(overlays.timeframe_30m["swings"] as ObjRow[]),
        ];
        overlays.structure = [
          ...(overlays.timeframe_5m["structure"] as ObjRow[]),
          ...(overlays.timeframe_30m["structure"] as ObjRow[]),
        ];
      }
    }

    const isWin = o.state === "CLOSED_TP";
    const rr = num(o.target_rr);

    return NextResponse.json({
      success: true,
      order: {
        order_id: o.order_id,
        symbol,
        market: o.market,
        direction: o.direction,
        entry_price: num(o.entry_price),
        filled_price: num(o.filled_price),
        stoploss: num(o.stoploss),
        tp1: num(o.tp1),
        tp2: num(o.tp2),
        tp3: num(o.tp3),
        filled_at: o.filled_at,
        close_ts: o.close_ts,
        close_price: num(o.close_price),
        close_reason: o.close_reason,
        target_no: o.target_no,
        target_price: num(o.target_price),
        realized_r: isWin ? rr : -1,
        outcome: isWin ? "WIN" : "LOSS",
      },
      timeframe: table.replace("historical_candles_", "").replace("candles_", ""),
      markers: {
        entry: { time: filledSec, price: num(o.filled_price) ?? num(o.entry_price) },
        exit: { time: closeSec, price: num(o.close_price), outcome: isWin ? "WIN" : "LOSS" },
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
