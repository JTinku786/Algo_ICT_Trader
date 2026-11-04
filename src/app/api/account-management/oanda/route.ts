import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * OANDA forex account (Account Management · OANDA view).
 *
 * Reads the broker-truth tables written by scripts/broker_sync/oanda_sync.py:
 * what OANDA itself reports (trades, funding transfers, balance / NAV), with
 * each trade attributed to the strategy that placed it. Raw rows come straight
 * from Postgres or through the local REST bridge; the aggregation below is the
 * single source of truth for both paths.
 */

type Raw = Record<string, unknown>;

const OANDA_TRADES_SQL = `
  SELECT account_id, trade_id::text, environment, instrument, local_symbol, side, units, state,
         open_ts, open_price, open_order_id::text, open_order_type, close_ts, close_price, close_reason,
         realized_pl, financing, half_spread_cost, unrealized_pl, take_profit, stop_loss,
         client_tag, strategy_id, strategy_detail, strategy_source, synced_at
  FROM oanda_account_trades ORDER BY open_ts DESC`;
const OANDA_TRANSFERS_SQL = `
  SELECT account_id, transaction_id::text, transfer_ts, amount, funding_reason, account_balance
  FROM oanda_account_transfers ORDER BY transfer_ts`;
const OANDA_SNAPSHOT_SQL = `
  SELECT snapshot_at, account_id, environment, currency, balance, nav, pl, unrealized_pl, financing,
         commission, open_trade_count, last_transaction_id::text, created_time
  FROM oanda_account_snapshots ORDER BY snapshot_at DESC LIMIT 1`;

const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const r2 = (v: number) => Math.round(v * 100) / 100;

async function loadRows(): Promise<{ ready: boolean; trades: Raw[]; transfers: Raw[]; snapshot: Raw | null }> {
  const restApiUrl = process.env.CANDLES_REST_API_URL;
  if (restApiUrl) {
    const response = await fetch(new URL("/api/account-management/oanda/rows", restApiUrl), {
      headers: process.env.CANDLES_REST_API_TOKEN ? { "x-api-key": process.env.CANDLES_REST_API_TOKEN } : undefined,
      cache: "no-store",
    });
    const payload = await response.json();
    if (!response.ok || payload?.success === false) throw new Error(payload?.error || `REST API error (${response.status})`);
    return { ready: payload.schema_ready !== false, trades: payload.trades ?? [], transfers: payload.transfers ?? [], snapshot: payload.snapshot ?? null };
  }
  const pool = getPostgresPool();
  const exists = await pool.query(`SELECT to_regclass('public.oanda_account_trades') IS NOT NULL AS ok`);
  if (!exists.rows[0]?.ok) return { ready: false, trades: [], transfers: [], snapshot: null };
  const [trades, transfers, snapshot] = await Promise.all([
    pool.query(OANDA_TRADES_SQL), pool.query(OANDA_TRANSFERS_SQL), pool.query(OANDA_SNAPSHOT_SQL),
  ]);
  return { ready: true, trades: trades.rows, transfers: transfers.rows, snapshot: snapshot.rows[0] ?? null };
}

type Agg = { strategy_id: string; trades: number; closed: number; open: number; wins: number; losses: number; realized_pl: number; financing: number; net_pl: number; unrealized_pl: number; best: number | null; worst: number | null; first_trade: string | null; last_trade: string | null };

function aggregate(rows: Raw[], key: (row: Raw) => string): Agg[] {
  const map = new Map<string, Agg>();
  for (const row of rows) {
    const id = key(row);
    const a = map.get(id) ?? { strategy_id: id, trades: 0, closed: 0, open: 0, wins: 0, losses: 0, realized_pl: 0, financing: 0, net_pl: 0, unrealized_pl: 0, best: null, worst: null, first_trade: null, last_trade: null };
    const realized = n(row.realized_pl) ?? 0;
    const financing = n(row.financing) ?? 0;
    const net = realized + financing;
    a.trades += 1;
    if (row.state === "CLOSED") {
      a.closed += 1;
      if (net > 0) a.wins += 1; else if (net < 0) a.losses += 1;
      a.best = a.best === null ? net : Math.max(a.best, net);
      a.worst = a.worst === null ? net : Math.min(a.worst, net);
    } else {
      a.open += 1;
      a.unrealized_pl += n(row.unrealized_pl) ?? 0;
    }
    a.realized_pl += realized;
    a.financing += financing;
    a.net_pl += net;
    const opened = row.open_ts ? new Date(row.open_ts as string | Date) : null;
    const t = opened && !Number.isNaN(opened.getTime()) ? opened.toISOString() : "";
    if (t && (!a.first_trade || t < a.first_trade)) a.first_trade = t;
    if (t && (!a.last_trade || t > a.last_trade)) a.last_trade = t;
    map.set(id, a);
  }
  return [...map.values()]
    .map((a) => ({ ...a, realized_pl: r2(a.realized_pl), financing: r2(a.financing), net_pl: r2(a.net_pl), unrealized_pl: r2(a.unrealized_pl), best: a.best === null ? null : r2(a.best), worst: a.worst === null ? null : r2(a.worst) }))
    .sort((x, y) => y.trades - x.trades);
}

export async function GET() {
  try {
    const { ready, trades, transfers, snapshot } = await loadRows();
    if (!ready) {
      return NextResponse.json({ success: true, schema_ready: false, message: "OANDA tables are not created yet. Run scripts/broker_sync/oanda_sync.py once." });
    }
    const funding = transfers; // every TRANSFER_FUNDS: deposits positive, withdrawals negative
    const deposits = r2(funding.reduce((sum, t) => sum + (n(t.amount) ?? 0), 0));
    const firstFunding = funding[0] ?? null;
    const byStrategy = aggregate(trades, (row) => String(row.strategy_id ?? "UNATTRIBUTED"));
    const totals = aggregate(trades, () => "ALL")[0] ?? null;
    const balance = n(snapshot?.balance);
    const nav = n(snapshot?.nav);
    const reconciliation = balance === null || !totals ? null : {
      deposits,
      net_trade_pl: totals.net_pl,
      expected_balance: r2(deposits + totals.net_pl),
      broker_balance: balance,
      difference: r2(balance - (deposits + totals.net_pl)),
    };
    return NextResponse.json({
      success: true,
      schema_ready: true,
      account: snapshot ? {
        account_id: snapshot.account_id, environment: snapshot.environment, currency: snapshot.currency,
        balance, nav, unrealized_pl: n(snapshot.unrealized_pl), open_trade_count: n(snapshot.open_trade_count),
        created_time: snapshot.created_time, synced_at: snapshot.snapshot_at,
      } : null,
      funding: {
        deposits,
        initial_amount: n(firstFunding?.amount),
        initial_ts: firstFunding?.transfer_ts ?? null,
        transfers: funding,
        return_pct: deposits && nav !== null ? r2(((nav - deposits) / deposits) * 100) : null,
      },
      totals,
      by_strategy: byStrategy,
      reconciliation,
      trades,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
