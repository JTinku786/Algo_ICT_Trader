import { getPostgresPool } from "@/lib/db";
import { resolveReplayInstrument } from "@/lib/replay-instruments";
import type { StrategyReplayOrder } from "@/lib/strategy-replay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const instrument = await resolveReplayInstrument(params.get("symbol") || "AAPL").catch(() => undefined);
  if (!instrument) return Response.json({error:"Unsupported instrument"},{status:400});
  const client = await getPostgresPool().connect().catch(()=>null);
  if (!client) return Response.json({error:"Unable to load strategy records"},{status:503});
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const runs = await client.query(`SELECT run_id,spec_version,source,start_date,end_date,status FROM s16v2_runs WHERE published AND market=$1 AND EXISTS (SELECT 1 FROM s16v2_orders o WHERE o.run_id=s16v2_runs.run_id AND o.symbol=$2) ORDER BY created_at DESC LIMIT 1`,[instrument.market,instrument.symbol]);
    const run = runs.rows[0];
    const result = run ? await client.query(`SELECT o.setup_id,o.run_id,o.direction,o.placed_at,o.ce,o.stop,o.fill_ts,o.fill_price,o.tp1,o.tp2,o.tp3,st.decision_known_at,st.pd_type,st.zone_low,st.zone_high FROM s16v2_orders o LEFT JOIN s16v2_setups st ON st.run_id=o.run_id AND st.setup_id=o.setup_id WHERE o.run_id=$1 AND o.symbol=$2 AND o.run_date >= '2026-01-01' AND o.run_date < '2027-01-01' ORDER BY o.placed_at,o.setup_id`,[run.run_id,instrument.symbol]) : {rows:[]};
    const epoch = (value: unknown) => value ? new Date(String(value)).getTime() : null;
    const orders: StrategyReplayOrder[] = result.rows.map(r=>({id:r.setup_id,runId:r.run_id,strategy:"S16-V2",direction:r.direction,placedAt:epoch(r.placed_at)!,decisionAt:epoch(r.decision_known_at),fillAt:epoch(r.fill_ts),entry:Number(r.ce),stop:Number(r.stop),fillPrice:r.fill_price === null ? null : Number(r.fill_price),tp1:r.tp1,tp2:r.tp2,tp3:r.tp3,pdType:r.pd_type,zoneLow:r.zone_low,zoneHigh:r.zone_high}));
    await client.query("COMMIT");
    return Response.json({run:run??null,orders,scope:"Published historical S16-V2 records; placement/fill timing only. No broker execution or strategy revalidation claim."},{headers:{"Cache-Control":"no-store"}});
  } catch { await client.query("ROLLBACK"); return Response.json({error:"Unable to read S16-V2 records"},{status:503}); }
  finally {client.release();}
}
