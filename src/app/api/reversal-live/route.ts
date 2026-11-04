import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Reversal k1 forex -> OANDA practice account. Written by
// ICT_Automation/realtime_execution/reversal_k1_oanda_live.py (one row per k1 signal decision).
// Exits: target = OANDA take-profit (touch); stop = completed 5m candle closing beyond SL -> market close.
// R is measured on the risk actually taken: |fill price - stop|.
const SQL = `
  SELECT k1_order_id::text AS id, setup_key, ticker, instrument, timeframe, direction, signal_entry, stoploss, tp1,
         observed_at, entry_clock, ict_sessions, decided_at, status, skip_reason, quote_bid, quote_ask,
         planned_rr_at_market, nav, units, risk_usd, oanda_order_id, oanda_trade_id, fill_price, fill_ts,
         close_price, close_ts, exit_reason, realized_pl, financing, realized_r, stop_breach_bar, updated_at
  FROM reversal_k1_live_orders
  ORDER BY COALESCE(fill_ts, decided_at) DESC`;

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export async function GET() {
  try {
    const pool = getPostgresPool();
    const exists = await pool.query("SELECT to_regclass('public.reversal_k1_live_orders') IS NOT NULL AS ok");
    const rows: Row[] = exists.rows[0]?.ok ? (await pool.query(SQL)).rows : [];
    const traded = rows.filter((r) => r.oanda_trade_id);
    const closed = traded
      .filter((r) => String(r.status).startsWith("CLOSED"))
      .sort((a, b) => new Date(String(a.close_ts)).getTime() - new Date(String(b.close_ts)).getTime());
    const open = traded.filter((r) => r.status === "OPEN");
    const rs = closed.map((r) => num(r.realized_r) ?? 0);
    const wins = rs.filter((r) => r > 0);
    const losses = rs.filter((r) => r <= 0);
    const grossWin = wins.reduce((s, r) => s + r, 0);
    const grossLoss = -losses.reduce((s, r) => s + r, 0);
    let equity = 0, peak = 0, maxDd = 0, pl = 0;
    const curve = closed.map((r) => {
      equity += num(r.realized_r) ?? 0;
      pl += (num(r.realized_pl) ?? 0) + (num(r.financing) ?? 0);
      peak = Math.max(peak, equity);
      maxDd = Math.min(maxDd, equity - peak);
      return { ts: r.close_ts, ticker: r.ticker, r: num(r.realized_r), equity_r: round(equity), pl_usd: round(pl) };
    });
    const skipReasons: Record<string, number> = {};
    for (const r of rows.filter((x) => !x.oanda_trade_id)) {
      const key = String(r.skip_reason ?? r.status)
        .replace(/ already traded live.*$/, " (already traded live)")
        .replace(/ of [0-9a-f-]{36}$/, "")
        .replace(/\s*\([^)]*\)$/, "");
      skipReasons[key] = (skipReasons[key] ?? 0) + 1;
    }
    return NextResponse.json({
      success: true,
      generated_at: new Date().toISOString(),
      summary: {
        decisions: rows.length, traded: traded.length, open: open.length, closed: closed.length,
        wins: wins.length, losses: losses.length,
        win_rate_pct: closed.length ? round((wins.length / closed.length) * 100) : null,
        net_r: round(rs.reduce((s, r) => s + r, 0)),
        expectancy_r: closed.length ? round(rs.reduce((s, r) => s + r, 0) / closed.length) : null,
        profit_factor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
        net_pl_usd: round(closed.reduce((s, r) => s + (num(r.realized_pl) ?? 0) + (num(r.financing) ?? 0), 0)),
        max_drawdown_r: round(maxDd),
        skipped: rows.length - traded.length,
      },
      skip_reasons: Object.entries(skipReasons).sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
      equity: curve,
      rows,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
