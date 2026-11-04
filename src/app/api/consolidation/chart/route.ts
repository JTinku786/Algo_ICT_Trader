import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";
import { GET as legacyChart } from "../../reversal/chart/route";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The FULL consolidation engine builds session hours from 30m history.
// This isolated endpoint follows that lineage without changing reversal charts.
export async function GET(request: NextRequest) {
  const sp=request.nextUrl.searchParams;
  if (sp.get("tf") !== "1h") return legacyChart(request);
  const sym=(sp.get("sym") || "").toUpperCase(), from=sp.get("from"),to=sp.get("to");
  if(!sym || !from || !to) return NextResponse.json({ok:false,error:"sym, from and to required"},{status:400});
  try {
    const {rows}=await getPostgresPool().query(`
      WITH raw AS (
        SELECT candle_ts AT TIME ZONE 'America/New_York' ts,open_price o,high_price h,low_price l,close_price c,0 priority
        FROM candles_30m WHERE market='us' AND base_symbol=$1 AND candle_ts >= '2026-01-21'
        UNION ALL
        SELECT candle_ts AT TIME ZONE 'America/New_York',open_price,high_price,low_price,close_price,1
        FROM historical_candles_30m WHERE market='us' AND base_symbol=$1
          AND (base_symbol IN ('SPY','QQQ') OR candle_ts < '2026-01-21')
      ), selected AS (
        SELECT DISTINCT ON(ts) * FROM raw WHERE ts::date BETWEEN $2::date AND $3::date
          AND ts::time >= '09:30' AND ts::time < '16:00' AND o IS NOT NULL AND h IS NOT NULL AND l IS NOT NULL AND c IS NOT NULL
        ORDER BY ts,priority
      ), hours AS (
        SELECT ts::date + interval '570 minutes' + floor((extract(hour from ts)*60+extract(minute from ts)-570)/60)*interval '60 minutes' ts,
          (array_agg(o ORDER BY ts))[1] o,max(h) h,min(l) l,(array_agg(c ORDER BY ts DESC))[1] c
        FROM selected GROUP BY 1
      ), daily AS (
        SELECT DISTINCT ON((candle_ts AT TIME ZONE 'America/New_York')::date)
          (candle_ts AT TIME ZONE 'America/New_York')::date AS day,high_price h,low_price l
        FROM candles_1d WHERE market='us' AND base_symbol=$1 AND $1 NOT IN ('SPY','QQQ') ORDER BY 1,candle_ts
      ), etf AS (
        SELECT (candle_ts AT TIME ZONE 'America/New_York')::date AS day,high_price h,low_price l
        FROM historical_candles_1d WHERE market='us' AND base_symbol=$1 AND $1 IN ('SPY','QQQ')
      ), d AS (SELECT * FROM daily UNION ALL SELECT * FROM etf)
      SELECT to_char(hours.ts,'YYYY-MM-DD HH24:MI') AS key,o::float AS open,
        greatest(least(hours.h,coalesce(d.h,hours.h)),o,c)::float AS high,
        least(greatest(hours.l,coalesce(d.l,hours.l)),o,c)::float AS low,c::float AS close
      FROM hours LEFT JOIN d ON d.day=hours.ts::date ORDER BY hours.ts`,[sym,from,to]);
    return NextResponse.json({ok:true,sym,tf:'1h',candles:rows,source:'legacy_full_30m_rollup',source_fidelity:'uncertified'});
  } catch(e) {return NextResponse.json({ok:false,error:e instanceof Error?e.message:String(e)},{status:500});}
}
