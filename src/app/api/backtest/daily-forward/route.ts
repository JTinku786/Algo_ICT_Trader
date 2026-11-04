import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

/**
 * Candles around a trade on a higher timeframe, built from the same regular-session 5m candles
 * the backtests use (so prices match the order chart exactly).
 *   GET /api/backtest/daily-forward?symbol=HD&entry_ts=...&tf=1d|1h|30m|15m&before=60&after=60
 * Intraday bars are session-anchored (US 09:30, India 09:15), e.g. 1h = 09:30-10:30 ... 15:30-16:00.
 * Returns up to `before` bars before the bar containing the entry and `after` bars after it.
 */
const MARKETS = [
  // US: barchart 5m history, then live yfinance candles_5m strictly after the last barchart bar
  // (candles_5m_live_fallback) so charts keep working past the end of the historical download.
  { market: "us", table: `(SELECT yahoo_symbol, market, candle_ts, open_price, high_price, low_price, close_price, volume FROM historical_candles_5m WHERE source = 'barchart'
      UNION ALL SELECT c.yahoo_symbol, c.market, c.candle_ts, c.open_price, c.high_price, c.low_price, c.close_price, c.volume FROM candles_5m c
      WHERE c.candle_ts > COALESCE((SELECT MAX(h.candle_ts) FROM historical_candles_5m h WHERE h.yahoo_symbol = c.yahoo_symbol AND h.source = 'barchart'), '-infinity'::timestamptz)) candles_5m_live_fallback`,
    source: null, tz: "America/New_York", open: "09:30", last: "15:55", sessionMin: 390 },
  { market: "india", table: "candles_5m", source: null, tz: "Asia/Kolkata", open: "09:15", last: "15:25", sessionMin: 375 },
] as const;
const TF_MIN: Record<string, number> = { "1d": 0, "1h": 60, "30m": 30, "15m": 15 };

type Row = { d: string; day: string; start_ms: string; o: number; h: number; l: number; c: number; bars: number };

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const symbol = (sp.get("symbol") || "").trim();
  const entryTs = sp.get("entry_ts");
  const tf = (sp.get("tf") || "1d").toLowerCase();
  const tfMin = TF_MIN[tf];
  const before = Math.min(Math.max(Number(sp.get("before") ?? 20) || 20, 0), 200);
  const after = Math.min(Math.max(Number(sp.get("after") ?? 60) || 60, 1), 250);
  const entry = entryTs ? new Date(entryTs) : null;
  if (!symbol || !entry || Number.isNaN(entry.getTime()) || tfMin === undefined) {
    return NextResponse.json({ success: false, error: "symbol, a valid entry_ts and tf in 1d|1h|30m|15m are required" }, { status: 400 });
  }
  const pool = getPostgresPool();
  try {
    for (const m of MARKETS) {
      // calendar-day span that surely covers the requested number of bars
      const barsPerDay = tfMin ? Math.ceil(m.sessionMin / tfMin) : 1;
      const spanBefore = (before / barsPerDay) * 1.6 + 6;
      const spanAfter = (after / barsPerDay) * 1.6 + 6;
      const from = new Date(entry.getTime() - spanBefore * 86_400_000);
      const to = new Date(entry.getTime() + spanAfter * 86_400_000);
      const params: unknown[] = [symbol, m.market, from.toISOString(), to.toISOString(), m.tz, m.open, m.last, tfMin];
      const src = m.source ? `AND source = $9` : "";
      if (m.source) params.push(m.source);
      // bucket = session date for daily, else session-anchored intraday bucket
      const bucket = tfMin
        ? `((candle_ts AT TIME ZONE $5)::date + $6::time
             + make_interval(mins => (floor(EXTRACT(EPOCH FROM ((candle_ts AT TIME ZONE $5)::time - $6::time)) / 60 / $8::int) * $8::int)::int))`
        : `((candle_ts AT TIME ZONE $5)::date + $6::time)`;
      const { rows } = await pool.query<Row>(
        `SELECT to_char(${bucket}, ${tfMin ? "'YYYY-MM-DD HH24:MI'" : "'YYYY-MM-DD'"}) AS d,
                to_char((candle_ts AT TIME ZONE $5)::date, 'YYYY-MM-DD') AS day,
                (EXTRACT(EPOCH FROM (${bucket} AT TIME ZONE $5)) * 1000)::bigint AS start_ms,
                (array_agg(open_price ORDER BY candle_ts))[1]::float8 AS o,
                max(high_price)::float8 AS h, min(low_price)::float8 AS l,
                (array_agg(close_price ORDER BY candle_ts DESC))[1]::float8 AS c,
                count(*)::int AS bars
           FROM ${m.table}
          WHERE yahoo_symbol = $1 AND market = $2 AND candle_ts >= $3 AND candle_ts < $4 ${src}
            AND (candle_ts AT TIME ZONE $5)::time >= $6::time AND (candle_ts AT TIME ZONE $5)::time <= $7::time
            AND EXTRACT(ISODOW FROM (candle_ts AT TIME ZONE $5)) < 6
            AND $8::int >= 0
          GROUP BY 1, 2, 3
          ${tfMin ? "" : "HAVING count(*) >= 40   -- drop partial sessions (data gaps); a US half-day has 42 bars"}
          ORDER BY 3`,
        params,
      );
      if (!rows.length) continue;
      const entryMs = entry.getTime();
      const entryDay = new Intl.DateTimeFormat("en-CA", { timeZone: m.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(entry);
      let idx: number;
      if (tfMin) {
        // the bar that contains the fill: last bar starting at or before it
        idx = -1;
        for (let k = 0; k < rows.length; k++) if (Number(rows[k].start_ms) <= entryMs) idx = k;
        if (idx < 0) idx = rows.length;
      } else {
        idx = rows.findIndex((r) => r.d >= entryDay);
        if (idx < 0) idx = rows.length;
      }
      const lo = Math.max(0, idx - before), hi = Math.min(rows.length, idx + after + 1);
      return NextResponse.json({
        success: true, symbol, market: m.market, timezone: m.tz, tf, entry_day: entryDay,
        entry_bar: rows[idx]?.d ?? null, entry_index: idx - lo,
        sessions_after_available: Math.max(0, hi - idx - 1),
        bars: rows.slice(lo, hi).map((r) => ({ d: r.d, day: r.day, t: Number(r.start_ms), o: r.o, h: r.h, l: r.l, c: r.c, bars: r.bars })),
      });
    }
    return NextResponse.json({ success: false, error: `no 5m candles for ${symbol}` }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
