import { getPostgresPool } from "./db";
import { analyze, DAILY_BIAS_VERSION, frames, instruments, type Bars, type Candle } from "./daily-bias";
export async function loadDailyBias() {
  const pool = getPostgresPool();
  const end = [new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }), "2027-01-01"].sort()[0];
  const results = [];
  const client = await pool.connect();
  try {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  for (const instrument of instruments) {
    const bars = {} as Bars;
    const audits: { frame: string; duplicates: number; conflicts: number; invalid: number; invalidDays: string[]; sources: string[] }[] = [];
    for (const frame of frames) {
      const result = await client.query(`SELECT extract(epoch FROM candle_ts)*1000 AS t,
        to_char(candle_ts AT TIME ZONE $2,'YYYY-MM-DD') AS day,
        extract(hour FROM candle_ts AT TIME ZONE $2)*60 + extract(minute FROM candle_ts AT TIME ZONE $2) AS minute,
        open_price AS o, high_price AS h, low_price AS l, close_price AS c, source
        FROM candles_${frame} WHERE yahoo_symbol=$1 AND market=$3
        AND candle_ts >= '2025-09-01'::timestamptz AND candle_ts < now()
        ORDER BY candle_ts, source`, [instrument.symbol, instrument.zone, instrument.market]);
      const seen = new Map<number, Candle>(); let duplicates = 0, invalid = 0;
      const conflicts = new Set<number>(), invalidDays = new Set<string>();
      const sources = new Set<string>();
      for (const row of result.rows) {
        sources.add(row.source);
        const b = { t: Number(row.t), day: row.day as string, minute: Number(row.minute), o: Number(row.o), h: Number(row.h), l: Number(row.l), c: Number(row.c) };
        if (b.day >= end) continue;
        if ([row.o,row.h,row.l,row.c].some(v => v === null) || ![b.o,b.h,b.l,b.c].every(Number.isFinite) || b.l > Math.min(b.o,b.c) || b.h < Math.max(b.o,b.c) || b.l > b.h) { invalid++; invalidDays.add(b.day); continue; }
        if (conflicts.has(b.t)) { duplicates++; continue; }
        const existing = seen.get(b.t);
        if (existing) {
          duplicates++;
          if (["o","h","l","c"].some(key => existing[key as "o"] !== b[key as "o"])) {
            conflicts.add(b.t); invalidDays.add(b.day); seen.delete(b.t);
          }
          continue;
        }
        seen.set(b.t,b);
      }
      bars[frame] = [...seen.values()];
      audits.push({ frame, duplicates, conflicts: conflicts.size, invalid, invalidDays: [...invalidDays].sort(), sources: [...sources] });
    }
    results.push({ ...analyze(instrument, bars, "2026-01-01", end, audits.find(a => a.frame === "1d")!.invalidDays), audits });
  }
  await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  return { version: DAILY_BIAS_VERSION, generatedAt: new Date().toISOString(), start: "2026-01-01", endExclusive: end, source: "Read-only repeatable-read Postgres snapshot; native timeframes", definitions: { drawHit: "BUY: daily high >= draw; SELL: daily low <= draw", closeBeyondDraw: "BUY: daily close > draw; SELL: daily close < draw. Equality is not confirmation.", candleAligned: "BUY: daily close > daily open; SELL: daily close < daily open. Separate next-day candle-body diagnostic." }, results };
}
export type DailyBiasReport = Awaited<ReturnType<typeof loadDailyBias>>;
