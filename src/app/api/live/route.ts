import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const pool = getPostgresPool();

    const openQ = pool.query(
      `SELECT order_id, symbol, market, direction, state, order_type,
              qty, entry_price, filled_price, stoploss, tp1, tp2, tp3,
              current_tp_index, filled_at, close_price, close_ts, close_reason,
              expires_at, last_checked_at, updated_at
       FROM realtime_production_orders
       WHERE state = 'OPEN'
       ORDER BY filled_at DESC NULLS LAST, updated_at DESC
       LIMIT 100`,
    );

    const recentQ = pool.query(
      `SELECT order_id, symbol, market, direction, state, entry_price, filled_price,
              close_price, close_reason, filled_at, close_ts, updated_at
       FROM realtime_production_orders
       ORDER BY updated_at DESC
       LIMIT 40`,
    );

    const eventsQ = pool.query(
      `SELECT e.event_id, e.order_id, e.event_type, e.event_ts, e.price,
              e.state_before, e.state_after, o.symbol, o.direction
       FROM realtime_production_order_events e
       LEFT JOIN realtime_production_orders o ON o.order_id = e.order_id
       ORDER BY e.event_ts DESC NULLS LAST
       LIMIT 60`,
    );

    const alertsQ = pool.query(
      `SELECT alert_id, market, symbol, strategy_id, event_type, channel_id,
              delivery_status, message, created_at
       FROM realtime_production_discord_alerts
       ORDER BY created_at DESC
       LIMIT 60`,
    );

    const statsQ = pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM realtime_production_orders WHERE state='OPEN') AS open_positions,
         (SELECT COUNT(*)::int FROM realtime_production_orders WHERE state='CLOSED_TP') AS wins,
         (SELECT COUNT(*)::int FROM realtime_production_orders WHERE state='CLOSED_SL') AS losses,
         (SELECT COUNT(*)::int FROM realtime_production_discord_alerts
            WHERE created_at::date = (SELECT MAX(created_at)::date FROM realtime_production_discord_alerts)) AS alerts_today,
         (SELECT COUNT(*)::int FROM realtime_production_discord_alerts WHERE delivery_status <> 'sent') AS alerts_failed,
         (SELECT MAX(updated_at) FROM realtime_production_orders) AS last_order_update,
         (SELECT MAX(created_at) FROM realtime_production_discord_alerts) AS last_alert`,
    );

    const [open, recent, events, alerts, stats] = await Promise.all([openQ, recentQ, eventsQ, alertsQ, statsQ]);

    return NextResponse.json({
      success: true,
      server_time: new Date().toISOString(),
      stats: stats.rows[0] || {},
      open_orders: open.rows,
      recent_orders: recent.rows,
      events: events.rows,
      alerts: alerts.rows,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Postgres error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
