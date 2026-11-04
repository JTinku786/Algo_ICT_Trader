import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Stored observations only: opening a chart never requests a broker quote.
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const ticker = (params.get("ticker") || "").trim().toUpperCase();
  const requested = (params.get("strategy") || "").trim().toUpperCase();
  const strategy = ["Scalping_OB_OB_V4", "BPR_OB_V3"].find(s => s.toUpperCase() === requested);
  const direction = (params.get("direction") || "").trim().toUpperCase();
  const entryDate = params.get("entry_date") || "";
  if (!ticker || !strategy || !["BUY", "SELL"].includes(direction) || !/^\d{4}-\d{2}-\d{2}$/.test(entryDate) || Number.isNaN(Date.parse(entryDate)) || new Date(entryDate).toISOString().slice(0, 10) !== entryDate) {
    return NextResponse.json({ success: false, error: "ticker, strategy, BUY/SELL direction and valid entry_date required" }, { status: 400 });
  }
  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT * FROM realtime_production_scalping_option_trades
     WHERE ticker=$1 AND strategy_name=$2 AND direction=$3 AND entry_date=$4::date`,
    [ticker, strategy, direction, entryDate]);
  const trade = result.rows[0];
  if (!trade) return NextResponse.json({ success: false, error: "Trade not found" }, { status: 404 });
  const activity = await pool.query(
    `SELECT * FROM realtime_production_scalping_option_activity WHERE trade_id=$1 ORDER BY sample_at,series_kind`, [trade.trade_id]);
  return NextResponse.json({ success: true, timezone: "America/New_York", trade, activity: activity.rows });
}
