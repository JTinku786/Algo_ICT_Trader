import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Candles for the Reversal tab chart, from the same sources the engine reads:
//   1d : candles_1d (Dow) / historical_candles_1d (SPY, QQQ)
//   1h : candles_1h (Dow) / historical_candles_1h (SPY, QQQ; hour-labelled bars shifted +30m)
//   30m: historical_candles_30m before 2026-01-21 (and SPY/QQQ), candles_30m after
// Intraday bars are clipped to the official daily high/low exactly as the engine does.
// `key` is the ET wall-clock label ("YYYY-MM-DD" or "YYYY-MM-DD HH:MM") used to place markers.
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const sym = (sp.get("sym") || "").toUpperCase();
  const from = sp.get("from");
  const to = sp.get("to");
  const tf = sp.get("tf") || "1d";
  if (!sym || !from || !to || !["1d", "1h", "30m"].includes(tf)) {
    return NextResponse.json({ ok: false, error: "sym, from, to and tf (1d|1h|30m) are required" }, { status: 400 });
  }
  const pool = getPostgresPool();
  const etf = sym === "SPY" || sym === "QQQ";
  const fx = /^[A-Z]{6}$/.test(sym) && !etf;
  const dailyTable = etf ? "historical_candles_1d" : "candles_1d";
  try {
    if (fx) {
      // forex: NY calendar days, Sunday-evening stub merged into Monday (same as reversal_engine.py --market forex)
      const { rows } = await pool.query(
        `WITH b AS (SELECT candle_ts, (candle_ts AT TIME ZONE 'America/New_York')::date AS d, open_price, high_price, low_price, close_price
                      FROM historical_candles_1d WHERE market = 'forex' AND base_symbol = $1),
              k AS (SELECT *, CASE WHEN extract(isodow FROM d) = 7 THEN d + 1 ELSE d END AS day FROM b)
         SELECT to_char(day, 'YYYY-MM-DD') AS key,
                (array_agg(open_price ORDER BY candle_ts))[1]::float AS open, max(greatest(high_price, open_price, close_price))::float AS high,
                min(least(low_price, open_price, close_price))::float AS low, (array_agg(close_price ORDER BY candle_ts DESC))[1]::float AS close
           FROM k WHERE day BETWEEN $2::date AND $3::date
          GROUP BY day HAVING bool_or(extract(isodow FROM d) < 6) ORDER BY day`,
        [`^${sym}`, from, to],
      );
      return NextResponse.json({ ok: true, sym, tf, candles: rows });
    }
    if (tf === "1d") {
      const { rows } = await pool.query(
        `SELECT to_char((candle_ts AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS key,
                open_price::float AS open, greatest(high_price, open_price, close_price)::float AS high,
                least(low_price, open_price, close_price)::float AS low, close_price::float AS close
           FROM ${dailyTable}
          WHERE market = 'us' AND yahoo_symbol = $1
            AND (candle_ts AT TIME ZONE 'America/New_York')::date BETWEEN $2::date AND $3::date
          ORDER BY candle_ts`,
        [sym, from, to],
      );
      return NextResponse.json({ ok: true, sym, tf, candles: rows });
    }
    let source: string;
    if (tf === "1h") {
      source = etf
        ? `SELECT candle_ts AT TIME ZONE 'America/New_York'
                  + CASE WHEN extract(minute FROM candle_ts AT TIME ZONE 'America/New_York') = 0 THEN interval '30 minutes' ELSE interval '0' END AS ts,
                  open_price, high_price, low_price, close_price
             FROM historical_candles_1h WHERE market = 'us' AND yahoo_symbol = $1`
        : `SELECT candle_ts AT TIME ZONE 'America/New_York' AS ts, open_price, high_price, low_price, close_price
             FROM candles_1h WHERE market = 'us' AND yahoo_symbol = $1`;
    } else {
      source = etf
        ? `SELECT candle_ts AT TIME ZONE 'America/New_York' AS ts, open_price, high_price, low_price, close_price
             FROM historical_candles_30m WHERE market = 'us' AND yahoo_symbol = $1`
        : `SELECT candle_ts AT TIME ZONE 'America/New_York' AS ts, open_price, high_price, low_price, close_price
             FROM candles_30m WHERE market = 'us' AND yahoo_symbol = $1 AND candle_ts >= '2026-01-21'
           UNION ALL
           SELECT candle_ts AT TIME ZONE 'America/New_York', open_price, high_price, low_price, close_price
             FROM historical_candles_30m WHERE market = 'us' AND yahoo_symbol = $1 AND candle_ts < '2026-01-21'`;
    }
    const { rows } = await pool.query(
      `WITH b AS (${source}),
            s AS (SELECT DISTINCT ON (ts) * FROM b
                   WHERE ts::date BETWEEN $2::date AND $3::date
                     AND ts::time >= '09:30' AND ts::time < '16:00'
                   ORDER BY ts),
            d AS (SELECT (candle_ts AT TIME ZONE 'America/New_York')::date AS day, high_price AS dh, low_price AS dl
                    FROM ${dailyTable} WHERE market = 'us' AND yahoo_symbol = $1)
       SELECT to_char(s.ts, 'YYYY-MM-DD HH24:MI') AS key,
              s.open_price::float AS open,
              greatest(least(s.high_price, coalesce(d.dh, s.high_price)), s.open_price, s.close_price)::float AS high,
              least(greatest(s.low_price, coalesce(d.dl, s.low_price)), s.open_price, s.close_price)::float AS low,
              s.close_price::float AS close
         FROM s LEFT JOIN d ON d.day = s.ts::date
        ORDER BY s.ts`,
      [sym, from, to],
    );
    return NextResponse.json({ ok: true, sym, tf, candles: rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Postgres error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
