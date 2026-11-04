import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";
import { computeWeeklyProfile } from "@/lib/weekly-profile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Weekly profile for one symbol at one moment: /api/weekly-profile?symbol=AAPL&ts=2026-10-14T14:30:00Z&direction=BUY&market=us */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const symbol = sp.get("symbol");
  const ts = sp.get("ts");
  if (!symbol || !ts) return NextResponse.json({ error: "symbol and ts are required" }, { status: 400 });
  try {
    const result = await computeWeeklyProfile(getPostgresPool(), {
      key: `adhoc:${symbol}:${ts}`, symbol, market: sp.get("market"), signalTs: ts, direction: sp.get("direction") ?? "BUY",
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
