import { replayInstruments } from "@/lib/replay-instruments";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try { return Response.json({ instruments: await replayInstruments() }); }
  catch { return Response.json({error:"Unable to load stored ticker catalog."},{status:503}); }
}
