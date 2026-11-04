import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";
import { reversalFiveMinuteSql } from "@/lib/reversal-five-minute-sql";

/** Reversal chart feed uses validated raw 5m OHLC shared with exit replay.
 * Conflicting native timestamps are omitted; isolated feed fills only native gaps.
 * GET /api/reversal/daily-forward?symbol=HD&entry_ts=...&tf=1d|1h|30m|15m
 */
const TZ = "America/New_York", OPEN = "09:30", LAST = "15:55", SESSION_MIN = 390;
const TF_MIN: Record<string, number> = { "1d": 0, "1h": 60, "30m": 30, "15m": 15, "5m": 5 };

type Row = { d: string; day: string; start_ms: string; o: number; h: number; l: number; c: number; bars: number };

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const symbol = (sp.get("symbol") || "").trim();
  const entryTs = sp.get("entry_ts");
  const tf = (sp.get("tf") || "1d").toLowerCase();
  const tfMin = TF_MIN[tf];
  const before = Math.min(Math.max(Number(sp.get("before") ?? 20) || 20, 0), 600);
  const after = Math.min(Math.max(Number(sp.get("after") ?? 60) || 60, 1), 250);
  const entry = entryTs ? new Date(entryTs) : null;
  if (!symbol || !entry || Number.isNaN(entry.getTime()) || tfMin === undefined) {
    return NextResponse.json({ success: false, error: "symbol, a valid entry_ts and tf in 1d|1h|30m|15m|5m are required" }, { status: 400 });
  }
  const etf = symbol === "SPY" || symbol === "QQQ";
  if (/^[A-Z]{6}$/.test(symbol) && !etf) return fxForward(symbol, entry, tf, tfMin, before, after);
  const barsPerDay = tfMin ? Math.ceil(SESSION_MIN / tfMin) : 1;
  const from = new Date(entry.getTime() - ((before / barsPerDay) * 1.6 + 6) * 86_400_000);
  const to = new Date(entry.getTime() + ((after / barsPerDay) * 1.6 + 6) * 86_400_000);
  const bucket = tfMin
    ? `((candle_ts AT TIME ZONE $5)::date + $6::time
         + make_interval(mins => (floor(EXTRACT(EPOCH FROM ((candle_ts AT TIME ZONE $5)::time - $6::time)) / 60 / $8::int) * $8::int)::int))`
    : `((candle_ts AT TIME ZONE $5)::date + $6::time)`;
  try {
    const { rows } = await getPostgresPool().query<Row>(
      `WITH ${reversalFiveMinuteSql('$1', '$2', '$3::timestamptz', '$4::timestamptz')}
       SELECT to_char(${bucket}, ${tfMin ? "'YYYY-MM-DD HH24:MI'" : "'YYYY-MM-DD'"}) AS d,
              to_char((candle_ts AT TIME ZONE $5)::date, 'YYYY-MM-DD') AS day,
              (EXTRACT(EPOCH FROM (${bucket} AT TIME ZONE $5)) * 1000)::bigint AS start_ms,
              (array_agg(open_price ORDER BY candle_ts))[1]::float8 AS o,
              max(high_price)::float8 AS h, min(low_price)::float8 AS l,
              (array_agg(close_price ORDER BY candle_ts DESC))[1]::float8 AS c,
              count(*)::int AS bars
         FROM five
        WHERE (candle_ts AT TIME ZONE $5)::time >= $6::time AND (candle_ts AT TIME ZONE $5)::time <= $7::time
          AND EXTRACT(ISODOW FROM (candle_ts AT TIME ZONE $5)) < 6
          AND $8::int >= 0
        GROUP BY 1, 2, 3
        ${tfMin ? "" : "HAVING count(*) >= 40   -- drop partial sessions (data gaps); a US half-day has 42 bars"}
        ORDER BY 3`,
      [symbol, "us", from.toISOString(), to.toISOString(), TZ, OPEN, LAST, tfMin],
    );
    if (!rows.length) return NextResponse.json({ success: false, error: `no 5m candles for ${symbol}` }, { status: 404 });
    const entryMs = entry.getTime();
    const entryDay = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(entry);
    let idx: number;
    if (tfMin) {
      idx = -1;
      for (let k = 0; k < rows.length; k++) if (Number(rows[k].start_ms) <= entryMs) idx = k;
      if (idx < 0) idx = rows.length;
    } else {
      idx = rows.findIndex((r) => r.d >= entryDay);
      if (idx < 0) idx = rows.length;
    }
    const lo = Math.max(0, idx - before), hi = Math.min(rows.length, idx + after + 1);
    return NextResponse.json({
      success: true, symbol, market: "us", timezone: TZ, tf, entry_day: entryDay,
      entry_bar: rows[idx]?.d ?? null, entry_index: idx - lo,
      sessions_after_available: Math.max(0, hi - idx - 1),
      bars: rows.slice(lo, hi).map((r) => ({ d: r.d, day: r.day, t: Number(r.start_ms), o: r.o, h: r.h, l: r.l, c: r.c, bars: r.bars })),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

/** Forex: 24h sessions from historical_candles_5m (barchart, then derived_1m), America/New_York days with the
 *  Sunday-evening stub merged into Monday; intraday buckets on the clock (00:00, 01:00 ...). */
async function fxForward(symbol: string, entry: Date, tf: string, tfMin: number, before: number, after: number) {
  const barsPerDay = tfMin ? Math.ceil(1440 / tfMin) : 1;
  const from = new Date(entry.getTime() - ((before / barsPerDay) * 1.6 + 6) * 86_400_000);
  const to = new Date(entry.getTime() + ((after / barsPerDay) * 1.6 + 6) * 86_400_000);
  const day = `(CASE WHEN extract(isodow FROM (candle_ts AT TIME ZONE $4)) = 7 THEN (candle_ts AT TIME ZONE $4)::date + 1 ELSE (candle_ts AT TIME ZONE $4)::date END)`;
  const bucket = tfMin
    ? `(date_trunc('hour', candle_ts AT TIME ZONE $4) + make_interval(mins => (floor(extract(minute FROM candle_ts AT TIME ZONE $4) / $5::int) * $5::int)::int))`
    : `(${day} + time '00:00')`;
  try {
    const { rows } = await getPostgresPool().query<Row>(
      `WITH ${reversalFiveMinuteSql('$1', "'forex'", '$2::timestamptz', '$3::timestamptz')}
       SELECT to_char(${bucket}, ${tfMin ? "'YYYY-MM-DD HH24:MI'" : "'YYYY-MM-DD'"}) AS d,
              to_char(${day}, 'YYYY-MM-DD') AS day,
              (EXTRACT(EPOCH FROM (${bucket} AT TIME ZONE $4)) * 1000)::bigint AS start_ms,
              (array_agg(open_price ORDER BY candle_ts))[1]::float8 AS o,
              max(high_price)::float8 AS h, min(low_price)::float8 AS l,
              (array_agg(close_price ORDER BY candle_ts DESC))[1]::float8 AS c,
              count(*)::int AS bars
         FROM five
        WHERE extract(isodow FROM (candle_ts AT TIME ZONE $4)) <> 6 AND $5::int >= 0
        GROUP BY 1, 2, 3
        ORDER BY 3`,
      [`^${symbol}`, from.toISOString(), to.toISOString(), TZ, tfMin || 0],
    );
    if (!rows.length) return NextResponse.json({ success: false, error: `no 5m candles for ${symbol}` }, { status: 404 });
    const entryMs = entry.getTime();
    const entryDay = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(entry);
    let idx: number;
    if (tfMin) {
      idx = -1;
      for (let k = 0; k < rows.length; k++) if (Number(rows[k].start_ms) <= entryMs) idx = k;
      if (idx < 0) idx = rows.length;
    } else {
      idx = rows.findIndex((r) => r.d >= entryDay);
      if (idx < 0) idx = rows.length;
    }
    const lo = Math.max(0, idx - before), hi = Math.min(rows.length, idx + after + 1);
    return NextResponse.json({
      success: true, symbol, market: "forex", timezone: TZ, tf, entry_day: entryDay,
      entry_bar: rows[idx]?.d ?? null, entry_index: idx - lo,
      sessions_after_available: Math.max(0, hi - idx - 1),
      bars: rows.slice(lo, hi).map((r) => ({ d: r.d, day: r.day, t: Number(r.start_ms), o: r.o, h: r.h, l: r.l, c: r.c, bars: r.bars })),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
