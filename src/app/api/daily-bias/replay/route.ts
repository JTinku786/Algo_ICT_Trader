import { aggregateReplayBars } from "@/lib/replay-aggregate";
import { getPostgresPool } from "@/lib/db";
import { frames } from "@/lib/daily-bias";
import { WEEKLY_REPLAY_VERSION, type ReplayBar, type ReplayData, type ReplayFrame } from "@/lib/weekly-replay";
import { resolveReplayInstrument } from "@/lib/replay-instruments";
type Frame = Exclude<ReplayFrame, "2m" | "3m">;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
    const params = new URL(request.url).searchParams;
    const name = params.get("symbol") || "AAPL", frame = (params.get("tf") || "1d") as Frame;
    const instrument = await resolveReplayInstrument(name).catch(() => undefined);
    if (!instrument || ![...frames,"1m"].includes(frame))
        return Response.json({ error: "Choose a supported symbol and timeframe." }, { status: 400 });
    const client = await getPostgresPool().connect().catch(() => null);
    if (!client)
        return Response.json({ error: "Unable to connect to replay candle database." }, { status: 503 });
    try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const today = new Date().toLocaleDateString("en-CA", { timeZone: instrument.zone });
        // live=1 (Realtime tab), or a range that runs through today (MSS deep
        // links from realtime trades): include the current session, but only
        // bars that have already completed. Past ranges are unchanged.
        const requestedThrough = params.get("through");
        const live = params.get("live") === "1" || (!!requestedThrough && requestedThrough >= today);
        const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
        let end = live ? tomorrow : [today, "2027-01-01"].sort()[0];
        const through = params.get("through");
        if (through) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(through) || !Number.isFinite(Date.parse(through)) || new Date(through).toISOString().slice(0,10)!==through) {
                await client.query("ROLLBACK");
                return Response.json({error:"Choose a valid historical replay end date."},{status:400});
            }
            const exclusive = new Date(Date.parse(through)+86400000).toISOString().slice(0,10);
            end = [end,exclusive].sort()[0];
        }
        const requestedFrom=params.get("from");
        if (requestedFrom && (!/^\d{4}-\d{2}-\d{2}$/.test(requestedFrom) || !Number.isFinite(Date.parse(requestedFrom)) || requestedFrom < "2000-01-01" || requestedFrom >= end)) { await client.query("ROLLBACK"); return Response.json({error:"Choose a valid historical replay start date."},{status:400}); }
        const invalidDailyDays = new Set<string>();
        const audit: ReplayData["audit"] = { invalid: 0, duplicates: 0, conflicts: 0, sources: [], missingDailyContext: false };
        const sources = new Set<string>();
        const data = new Map<Frame, ReplayBar[]>();
        for (const tf of [...new Set<Frame>(["1d", frame])]) {
            const historical=params.get("backtest")==="1" && instrument.market==="us" && tf!=="1d" && tf!=="1m";
            // Forex history is stored per timeframe in the historical tables,
            // including daily bars. The live candles_* tables are not its archive.
            const forexHistory = instrument.market==="forex";
            const table=forexHistory ? `historical_candles_${tf}` : historical ? "historical_candles_5m" : `candles_${tf}`;
            // US archive coverage ends before some study dates. Fill only
            // missing timestamps from stored live/supplement 5m candles, then
            // roll up the same contiguous completed source bars for every TF.
            // Keep duplicates within the chosen source for validation below.
            const historicalDaily = instrument.market==='us' && tf==='1d';
            const candleSource = historicalDaily ? `(
              SELECT * FROM (
                SELECT raw.*,min(priority) OVER(PARTITION BY candle_ts) AS preferred_priority FROM (
                  SELECT candle_ts,open_price,high_price,low_price,close_price,volume,source,0 AS priority
                    FROM candles_1d WHERE yahoo_symbol=$1 AND market=$3
                    AND candle_ts >= ($5::date::timestamp AT TIME ZONE $2) AND candle_ts < ($4::date::timestamp AT TIME ZONE $2)
                  UNION ALL
                  SELECT candle_ts,open_price,high_price,low_price,close_price,volume,source,1 AS priority
                    FROM historical_candles_1d WHERE yahoo_symbol=$1 AND market=$3
                    AND candle_ts >= ($5::date::timestamp AT TIME ZONE $2) AND candle_ts < ($4::date::timestamp AT TIME ZONE $2)
                ) raw
              ) ranked WHERE priority=preferred_priority
            ) candles` : historical ? `(
              SELECT * FROM (
                SELECT raw.*, min(priority) OVER (PARTITION BY candle_ts) AS preferred_priority FROM (
                  SELECT candle_ts,open_price,high_price,low_price,close_price,volume,source,0 AS priority
                    FROM historical_candles_5m WHERE yahoo_symbol=$1 AND market=$3 AND source IN ('barchart','yahoo_smt_index')
                    AND candle_ts >= ($5::date::timestamp AT TIME ZONE $2) AND candle_ts < ($4::date::timestamp AT TIME ZONE $2)
                  UNION ALL
                  SELECT candle_ts,open_price,high_price,low_price,close_price,volume,source,1
                    FROM candles_5m WHERE yahoo_symbol=$1 AND market=$3
                    AND candle_ts >= ($5::date::timestamp AT TIME ZONE $2) AND candle_ts < ($4::date::timestamp AT TIME ZONE $2)
                  UNION ALL
                  SELECT candle_ts,open_price,high_price,low_price,close_price,volume,source,2
                    FROM realtime_production_mss_reversal_candles WHERE ticker=$1 AND market=$3
                    AND candle_ts >= ($5::date::timestamp AT TIME ZONE $2) AND candle_ts < ($4::date::timestamp AT TIME ZONE $2)
                    AND candle_ts + interval '5 minutes' <= now()
                ) raw
              ) ranked WHERE priority=preferred_priority
            ) candles` : table;
            const result = await client.query(`SELECT extract(epoch FROM candle_ts)*1000 AS t,

        to_char(candle_ts AT TIME ZONE $2,'YYYY-MM-DD') AS day,

        extract(hour FROM candle_ts AT TIME ZONE $2)*60+extract(minute FROM candle_ts AT TIME ZONE $2) AS minute,

        open_price AS o, high_price AS h, low_price AS l, close_price AS c, volume AS v, source

        FROM ${candleSource} ${historical || historicalDaily ? "WHERE true" : "WHERE yahoo_symbol=$1 AND market=$3"}

        AND candle_ts >= ($5::date::timestamp AT TIME ZONE $2)

        AND candle_ts < ($4::date::timestamp AT TIME ZONE $2) ORDER BY candle_ts,source`, [instrument.symbol, instrument.zone, instrument.market, end, tf === "1d" ? (requestedFrom ? `${Math.max(2000,Number(requestedFrom.slice(0,4))-2)}-01-01` : "2023-01-01") : requestedFrom ?? "2025-09-01"]);
            const seen = new Map<number, ReplayBar>(), excluded = new Set<number>();
            for (const raw of result.rows) {
                sources.add(raw.source);
                const b = { t: Number(raw.t), day: raw.day as string, minute: Number(raw.minute), o: Number(raw.o), h: Number(raw.h), l: Number(raw.l), c: Number(raw.c), v: Number(raw.v??0), knownAt: 0 };
                const open = instrument.market === "india" ? 555 : instrument.market === "us" ? 570 : 0;
                const close = instrument.market === "india" ? 930 : instrument.market === "us" ? 960 : 1440;
                if (tf !== "1d" && (b.minute < open || b.minute >= close))
                    continue;
                if ([raw.o, raw.h, raw.l, raw.c].some(v => v === null) || ![b.o, b.h, b.l, b.c].every(Number.isFinite) || b.l > Math.min(b.o, b.c) || b.h < Math.max(b.o, b.c) || b.l > b.h) {
                    audit.invalid++;
                    excluded.add(b.t);
                    seen.delete(b.t);
                    if (tf === "1d")
                        invalidDailyDays.add(b.day);
                    continue;
                }
                const minutes = historical ? 5 : { "1d": close - b.minute, "1h": 60, "30m": 30, "15m": 15, "5m": 5, "10m":10, "1m": 1 }[tf];
                b.knownAt = b.t + Math.min(minutes, close - b.minute) * 60000;
                if (live && b.knownAt > Date.now())
                    continue;
                if (excluded.has(b.t)) {
                    audit.duplicates++;
                    continue;
                }
                const existing = seen.get(b.t);
                if (existing) {
                    audit.duplicates++;
                    if ((["o", "h", "l", "c"] as const).some(k => existing[k] !== b[k])) {
                        audit.conflicts++;
                        excluded.add(b.t);
                        seen.delete(b.t);
                        if (tf === "1d")
                            invalidDailyDays.add(b.day);
                    }
                    continue;
                }
                seen.set(b.t, b);
            }
            data.set(tf, historical && tf!=="5m" ? aggregateReplayBars([...seen.values()],tf==="1h"?60:tf==="30m"?30:15,570,960) : [...seen.values()]);
        }
        await client.query("COMMIT");
        const daily = data.get("1d")!;
        audit.sources = [...sources];
        audit.missingDailyContext = !daily.length;
        const payload: ReplayData = { version: WEEKLY_REPLAY_VERSION, instrument, frame, daily, bars: data.get(frame)!, invalidDailyDays: [...invalidDailyDays].sort(), audit,
            generatedAt: new Date().toISOString(), provenance: `${instrument.market==="forex"?`Forex: historical_candles_${frame} and historical_candles_1d; stored timeframe OHLC (derived_1m where supplied by the archive), with native Barchart / OANDA 1-minute sources. `:""}${frame==="1m"?"Native stored 1-minute candles; not derived from 5-minute history. ":params.get("backtest")==="1" && instrument.market==="us" ? "Backtest intraday: historical Barchart 5m, with missing timestamps supplemented by candles_5m and the isolated completed 5m feed; higher frames derived from contiguous completed source bars. " : ""}Native Postgres OHLC; read-only snapshot. ICT annotations are mechanically derived from completed replay prefixes. Stored ict_* latest snapshots are not used as historical January evidence.` };
        return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
    }
    catch (error) {
        await client.query("ROLLBACK");
        console.error("Weekly replay candle load failed", error);
        return Response.json({ error: "Unable to read weekly replay candles. Check database connectivity." }, { status: 503 });
    }
    finally {
        client.release();
    }
}
