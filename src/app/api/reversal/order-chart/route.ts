import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";
import { reversalFiveMinuteSql } from "@/lib/reversal-five-minute-sql";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ICT order chart feed for the Reversal tab. Returns the same OrderChartResponse shape as
// /api/backtest/order-chart so the shared <OrderChart> component renders reversal trades with the
// Backtest tab's framework: 5m execution base aggregated client-side to 15m / 30m / 1h / 1D / 1W,
// per-timeframe ICT context (FVGs, order blocks, swings, liquidity, structure), the setup's own
// evidence (swept external liquidity, internal swing / MSS, displacement FVG, HTF PD arrays) on the
// timeframe the setup was detected on, and the dealing range as the premium/discount overlay.

type Bar = { time: number; open: number; high: number; low: number; close: number; volume?: number };
type Zone = { kind: string; top: number; bottom: number; time: number; end_time?: number | null; direction: string | null; broken: boolean; mitigated: boolean; filled: boolean; label: string; primary?: boolean };
type Level = { kind: string; level: number; time: number; end_time?: number | null; side: string | null; direction: string | null; label: string };
type Ctx = { order_blocks: Zone[]; fvgs: Zone[]; liquidity: Level[]; swings: Level[]; structure: Zone[] };

const EMPTY = (): Ctx => ({ order_blocks: [], fvgs: [], liquidity: [], swings: [], structure: [] });
const DAY = 86400;
const ET_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

// ------------------------------------------------------------------ candles
async function fiveMinute(sym: string, market: string, fromTs: number, toTs: number): Promise<Bar[]> {
  const { rows } = await getPostgresPool().query(
    `WITH ${reversalFiveMinuteSql('$1', '$4', 'to_timestamp($2)', 'to_timestamp($3)')}
     SELECT extract(epoch FROM candle_ts)::bigint AS time,open_price::float AS open,
       high_price::float AS high,low_price::float AS low,close_price::float AS close
     FROM five WHERE ($4='forex' OR ((candle_ts AT TIME ZONE 'America/New_York')::time >= '09:30'
       AND (candle_ts AT TIME ZONE 'America/New_York')::time < '16:00')) ORDER BY candle_ts`,
    [sym,fromTs,toTs,market],
  );
  return rows.map(r=>({...r,time:Number(r.time)}));
}

async function dailyBars(sym: string, market: string, fromTs: number, toTs: number): Promise<Bar[]> {
  const table = market === "forex" || sym === "SPY" || sym === "QQQ" ? "historical_candles_1d" : "candles_1d";
  // time = 09:30 ET of the session, which is where the client's 1D aggregation places the bar.
  const { rows } = await getPostgresPool().query(
    `SELECT extract(epoch FROM (((candle_ts AT TIME ZONE 'America/New_York')::date + time '09:30') AT TIME ZONE 'America/New_York'))::bigint AS time,
            open_price::float AS open, greatest(high_price, open_price, close_price)::float AS high,
            least(low_price, open_price, close_price)::float AS low, close_price::float AS close
       FROM ${table}
      WHERE market = $4 AND base_symbol=ANY(ARRAY[$1::text,ltrim($1::text,'^'),'^'||ltrim($1::text,'^')]) AND candle_ts BETWEEN to_timestamp($2) AND to_timestamp($3)
      ORDER BY candle_ts`,
    [sym, fromTs, toTs, market],
  );
  return rows.map((r) => ({ ...r, time: Number(r.time) }));
}

// Same bucketing as the chart's client-side aggregation, so labels land on the candles you see.
function aggregate(bars: Bar[], sec: number): Bar[] {
  const out = new Map<number, Bar>();
  for (const b of bars) {
    const k = Math.floor(b.time / sec) * sec;
    const cur = out.get(k);
    if (!cur) out.set(k, { time: k, open: b.open, high: b.high, low: b.low, close: b.close });
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; }
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}

function weekly(days: Bar[]): Bar[] {
  const out = new Map<string, Bar>();
  for (const b of days) {
    const [y, m, d] = ET_DATE.format(b.time * 1000).split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
    const k = dt.toISOString().slice(0, 10);
    const cur = out.get(k);
    if (!cur) out.set(k, { ...b });
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; }
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}

// ------------------------------------------------------------------ generic ICT context (before entry)
function context(bars: Bar[], entryTime: number, tfLabel: string): Ctx {
  const ctx = EMPTY();
  const pre = bars.filter((b) => b.time < entryTime);
  const n = pre.length;
  if (n < 5) return ctx;
  const f = (v: number) => v.toFixed(2);
  // FVGs still open at entry (not closed through their far edge)
  for (let i = 2; i < n; i += 1) {
    const a = pre[i - 2], c = pre[i];
    let zone: Zone | null = null;
    if (c.low > a.high) zone = { kind: "fvg", bottom: a.high, top: c.low, time: pre[i - 1].time, direction: "bullish", broken: false, mitigated: false, filled: false, label: `${tfLabel} bullish FVG ${f(a.high)}-${f(c.low)}` };
    if (c.high < a.low) zone = { kind: "fvg", bottom: c.high, top: a.low, time: pre[i - 1].time, direction: "bearish", broken: false, mitigated: false, filled: false, label: `${tfLabel} bearish FVG ${f(c.high)}-${f(a.low)}` };
    if (!zone) continue;
    const after = pre.slice(i + 1);
    const bull = zone.direction === "bullish";
    if (after.some((b) => (bull ? b.close < zone!.bottom : b.close > zone!.top))) continue;
    zone.mitigated = after.some((b) => (bull ? b.low <= zone!.top : b.high >= zone!.bottom));
    ctx.fvgs.push(zone);
  }
  // Order blocks: last opposite candle before a candle that closes beyond its range; still unbroken at entry
  for (let i = 1; i < n - 1; i += 1) {
    const ob = pre[i], nx = pre[i + 1];
    const bullOB = ob.close < ob.open && nx.close > ob.high;
    const bearOB = ob.close > ob.open && nx.close < ob.low;
    if (!bullOB && !bearOB) continue;
    const after = pre.slice(i + 2);
    if (after.some((b) => (bullOB ? b.close < ob.low : b.close > ob.high))) continue;
    ctx.order_blocks.push({ kind: "order_block", bottom: ob.low, top: ob.high, time: ob.time, direction: bullOB ? "bullish" : "bearish", broken: false, mitigated: false, filled: false, label: `${tfLabel} ${bullOB ? "bullish" : "bearish"} OB` });
  }
  // Swings (2-bar fractals) and the last break of one (BOS)
  const hi: Level[] = [], lo: Level[] = [];
  for (let i = 2; i < n - 2; i += 1) {
    const w = pre.slice(i - 2, i + 3);
    if (pre[i].high === Math.max(...w.map((b) => b.high))) hi.push({ kind: "swing", level: pre[i].high, time: pre[i].time, side: "buyside", direction: null, label: `${tfLabel} swing high` });
    if (pre[i].low === Math.min(...w.map((b) => b.low))) lo.push({ kind: "swing", level: pre[i].low, time: pre[i].time, side: "sellside", direction: null, label: `${tfLabel} swing low` });
  }
  ctx.swings = [...hi.slice(-1), ...lo.slice(-1)];
  let lastBos: Zone | null = null;
  for (const s of [...hi, ...lo]) {
    const brk = pre.find((b) => b.time > s.time + 1 && (s.side === "buyside" ? b.close > s.level : b.close < s.level));
    if (brk && (!lastBos || brk.time > lastBos.time)) {
      lastBos = { kind: "bos", top: s.level, bottom: s.level, time: brk.time, direction: s.side === "buyside" ? "bullish" : "bearish", broken: false, mitigated: false, filled: false, label: `${tfLabel} BOS ${s.side === "buyside" ? "up" : "down"}` };
    }
  }
  if (lastBos) ctx.structure.push(lastBos);
  // External liquidity: the 20-bar high / low resting at entry
  const last = pre.slice(-20);
  const hh = last.reduce((a, b) => (b.high > a.high ? b : a));
  const ll = last.reduce((a, b) => (b.low < a.low ? b : a));
  ctx.liquidity = [
    { kind: "liquidity", level: hh.high, time: hh.time, side: "buyside", direction: "bearish", label: `${tfLabel} 20-bar high (BSL)` },
    { kind: "liquidity", level: ll.low, time: ll.time, side: "sellside", direction: "bullish", label: `${tfLabel} 20-bar low (SSL)` },
  ];
  return ctx;
}

const TF_META: Record<string, { key: string; strat: string; unit: string; sec: number; pre: number; post: number }> = {
  "1d": { key: "timeframe_daily", strat: "1D", unit: "D", sec: DAY, pre: 80 * DAY, post: 14 * DAY },
  "1h": { key: "timeframe_1h", strat: "1h", unit: " bars", sec: 3600, pre: 14 * DAY, post: 4 * DAY },
  "30m": { key: "timeframe_30m", strat: "30m", unit: " bars", sec: 1800, pre: 8 * DAY, post: 3 * DAY },
};

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const tradeId = sp.get("trade_id");
  if (!tradeId) return NextResponse.json({ success: false, error: "trade_id is required" }, { status: 400 });
  const pool = getPostgresPool();
  try {
    const { rows } = await pool.query(
      `SELECT t.*, coalesce(r.timeframe, '1d') AS tf,coalesce(r.params->>'market','us') AS market, s.swept_level, s.sweep_extreme, s.internal_level, s.opposite_liquidity,
              s.fvg_top, s.fvg_bottom, s.htf_zones, s.bars_to_mss,
              extract(epoch FROM (t.sweep_date AT TIME ZONE 'America/New_York'))::bigint AS sweep_ts,
              extract(epoch FROM (s.reclaim_date AT TIME ZONE 'America/New_York'))::bigint AS reclaim_ts,
              extract(epoch FROM (t.mss_date AT TIME ZONE 'America/New_York'))::bigint AS mss_ts,
              extract(epoch FROM coalesce(t.filled_at,t.entry_date AT TIME ZONE 'America/New_York'))::bigint AS entry_ts,
              extract(epoch FROM (t.exit_date AT TIME ZONE 'America/New_York'))::bigint AS exit_ts,
              extract(epoch FROM (s.fvg_date AT TIME ZONE 'America/New_York'))::bigint AS fvg_ts
         FROM reversal_trades t
         JOIN reversal_signals s ON s.run_id = t.run_id AND s.signal_id = t.signal_id
         JOIN reversal_runs r ON r.run_id = t.run_id
        WHERE t.trade_id = $1 AND ($2::text IS NULL OR t.run_id = $2)
        LIMIT 1`,
      [tradeId, sp.get("run")],
    );
    if (!rows.length) return NextResponse.json({ success: false, error: "Trade not found" }, { status: 404 });
    const t = rows[0];
    if (t.outcome === "unverified") return NextResponse.json({ success: false, error: "This trade has no verified 5m exit path. Inspect its setup in the historical chart; no exit price or time is asserted." }, { status: 422 });
    const sym: string = t.sym;
    const market: string = t.market;
    const meta = TF_META[t.tf] ?? TF_META["1d"];
    const daily = t.tf === "1d" && market === "us";
    // Daily rows are stored at midnight: place the daily events on the session (entry 09:30, sweep/MSS 09:30, exit 15:55).
    const at = (ts: number | string | null, hm: number) => (ts === null ? null : Number(ts) + (daily ? hm : 0));
    const sweepT = at(t.sweep_ts, 9.5 * 3600)!;
    const mssT = at(t.mss_ts, 9.5 * 3600)!;
    const entryT = t.filled_at ? Number(t.entry_ts) : at(t.entry_ts, 9.5 * 3600)!;
    // Corrected daily trades carry the actual 5m close time, not a midnight placeholder.
    const exitT = t.exit_ts == null ? Math.floor(Date.now() / 1000) : t.exit_verified ? Number(t.exit_ts) : at(t.exit_ts, 15 * 3600 + 55 * 60)!;
    const fvgT = at(t.fvg_ts, 9.5 * 3600);

    // Lazy history requests from the chart: candles only.
    const fromQ = sp.get("from_ts"), toQ = sp.get("to_ts");
    if (fromQ && toQ) {
      const candles = await fiveMinute(sym, market, Number(fromQ), Number(toQ));
      return NextResponse.json({ success: true, timeframe: "5m", candles });
    }

    const fromTs = sweepT - meta.pre;
    const toTs = exitT + meta.post;
    const [candles, days] = await Promise.all([fiveMinute(sym, market, fromTs, toTs), dailyBars(sym, market, sweepT - 260 * DAY, toTs)]);
    if (!candles.length) return NextResponse.json({ success: false, error: `No 5m candles for ${sym} in this window` }, { status: 404 });

    const bear = t.side === "bear";
    const s = bear ? -1 : 1;
    const risk = (t.entry - t.stop) * s;
    const exitPrice = t.exit_price ?? (t.r == null ? null : t.entry + s * t.r * risk);
    const unit = meta.unit;

    // generic context per timeframe, then the setup's own evidence on its timeframe
    const overlays: Record<string, Ctx> = {
      timeframe_1m: EMPTY(),
      timeframe_5m: EMPTY(),
      timeframe_15m: context(aggregate(candles, 900), entryT, "15m"),
      timeframe_30m: context(aggregate(candles, 1800), entryT, "30m"),
      timeframe_1h: context(aggregate(candles, 3600), entryT, "1h"),
      timeframe_daily: context(days, entryT, "D"),
      timeframe_weekly: context(weekly(days), entryT, "W"),
    };
    const setup = EMPTY();
    setup.liquidity.push(
      { kind: "liquidity", level: t.swept_level, time: sweepT, side: bear ? "buyside" : "sellside", direction: bear ? "bearish" : "bullish",
        label: `${t.lookback}${unit} ${bear ? "BSL" : "SSL"} ${t.kind === "2B" ? "broken + reclaimed (2B)" : "swept"}` },
      { kind: "liquidity", level: t.opposite_liquidity, time: sweepT, side: bear ? "sellside" : "buyside", direction: null,
        label: `Opposite ${t.lookback}${unit} liquidity (draw)` },
    );
    setup.swings.push({ kind: "swing", level: t.internal_level, time: sweepT, side: bear ? "sellside" : "buyside", direction: null, label: "Internal swing (MSS level)" });
    setup.structure.push({ kind: "mss", top: t.internal_level, bottom: t.internal_level, time: mssT, direction: bear ? "bearish" : "bullish",
      broken: false, mitigated: false, filled: false, label: `MSS ${bear ? "down" : "up"} (close through internal swing)` });
    if (t.fvg_top !== null && t.fvg_bottom !== null && fvgT) {
      setup.fvgs.push({ kind: "fvg", top: t.fvg_top, bottom: t.fvg_bottom, time: fvgT, direction: bear ? "bearish" : "bullish",
        broken: false, mitigated: false, filled: false, primary: true, label: `Displacement FVG ${Number(t.fvg_bottom).toFixed(2)}-${Number(t.fvg_top).toFixed(2)}` });
    }
    const htf = (Array.isArray(t.htf_zones) ? t.htf_zones : []) as Array<{ kind: string; bottom: number; top: number; usable_from: string }>;
    for (const z of htf) {
      const weeklyZone = z.kind.startsWith("W_");
      const usable = Math.floor(new Date(`${z.usable_from.slice(0, 10)}T09:30:00-04:00`).getTime() / 1000);
      const zone: Zone = { kind: z.kind.endsWith("FVG") ? "fvg" : "order_block", top: z.top, bottom: z.bottom,
        time: usable - (weeklyZone ? 7 : 1) * DAY, direction: bear ? "bearish" : "bullish", broken: false, mitigated: true, filled: false,
        label: `${weeklyZone ? "Weekly" : "Daily"} ${z.kind.endsWith("FVG") ? "FVG" : "OB"} (HTF PD array in play)` };
      (zone.kind === "fvg" ? setup.fvgs : setup.order_blocks).push(zone);
      const home = weeklyZone ? overlays.timeframe_weekly : overlays.timeframe_daily;
      (zone.kind === "fvg" ? home.fvgs : home.order_blocks).push(zone);
    }
    overlays[meta.key] = setup;

    const lo = Math.min(t.swept_level, t.opposite_liquidity), hi = Math.max(t.swept_level, t.opposite_liquidity);
    const outcome = String(t.outcome).toUpperCase();
    return NextResponse.json({
      success: true,
      timeframe: "5m",
      order: {
        order_id: t.trade_id, symbol: sym, market, direction: bear ? "SELL" : "BUY",
        entry_price: t.entry, filled_price: t.entry, stoploss: t.stop, tp1: t.tgt, tp2: null, tp3: null,
        filled_at: new Date(entryT * 1000).toISOString(), close_ts: t.exit_ts == null ? null : new Date(exitT * 1000).toISOString(),
        setup_valid: t.setup_valid, setup_validation: t.setup_validation, decision_known_at: t.decision_known_at,
        close_price: exitPrice, close_reason: t.outcome, realized_r: t.r, outcome,
      },
      markers: { entry: { time: entryT, price: t.entry }, exit: t.exit_ts == null ? null : { time: exitT, price: exitPrice, outcome } },
      candles,
      overlays: {
        ...overlays[meta.key],
        ipda: { low: lo, q25: lo + (hi - lo) * 0.25, eq50: (lo + hi) / 2, q75: lo + (hi - lo) * 0.75, high: hi,
          start_time: sweepT, end_time: entryT, sessions: t.lookback, selected_level: null, anchored: true,
          title: `${t.lookback}${unit} dealing range` },
        bias: null,
        strategy_timeframe: meta.strat,
        ...overlays,
      },
      window: { from: fromTs, to: toTs },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Postgres error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
