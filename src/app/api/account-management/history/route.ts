import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Historical Account Management.
 *
 * Reads the broker-truth tables written by
 * scripts/broker_sync/sync_broker_accounts.py — what Angel One, Dhan and Groww
 * actually reported, per account, per trading day. That is what makes open
 * positions, closed positions and rejected orders complete: the older view
 * could only ever show orders the algo itself placed.
 *
 * Raw rows come either straight from Postgres or through the local REST bridge;
 * the aggregation below is the single source of truth for both paths.
 */

type Raw = Record<string, unknown>;

const REGISTRY_SQL = `
  SELECT
    c.customer_id::text, c.customer_key, c.display_name, c.active AS customer_active,
    a.broker_account_id::text, a.broker, a.broker_client_id, a.account_label,
    a.environment, a.active, a.strategies, a.risk_config, a.auth_status,
    a.token_expires_at, a.last_verified_at, TRUE AS linked_customer
  FROM realtime_production_customers c
  JOIN realtime_production_customer_broker_accounts a ON a.customer_id = c.customer_id
  UNION ALL
  SELECT
    NULL, LOWER(o.broker || '_' || o.broker_account), o.broker_account, TRUE, NULL,
    o.broker, NULL, o.broker_account, 'live', TRUE,
    '[]'::jsonb, '{}'::jsonb, 'unregistered', NULL, NULL, FALSE
  FROM realtime_production_broker_orders o
  WHERE NOT EXISTS (
    SELECT 1 FROM realtime_production_customer_broker_accounts a
    WHERE LOWER(a.broker) = LOWER(o.broker) AND LOWER(a.account_label) = LOWER(o.broker_account)
  )
  GROUP BY o.broker, o.broker_account
`;

const POSITIONS_SQL = `
  SELECT broker, broker_account, trade_date, tradingsymbol, underlying, exchange, segment,
         product, instrument_type, option_type, strike, expiry_date, position_type,
         net_quantity, buy_quantity, sell_quantity, buy_avg_price, sell_avg_price,
         average_price, last_price, close_price, realized_pnl, unrealized_pnl, total_pnl,
         lotsize, snapshot_at, source_feed
    FROM realtime_production_broker_positions
   WHERE trade_date BETWEEN $1 AND $2
   ORDER BY trade_date DESC, tradingsymbol
   LIMIT 20000
`;

const ORDERS_SQL = `
  SELECT order_uid, broker, broker_account, broker_order_id, exchange_order_id, trade_date,
         status, status_raw, is_open, reject_reason, exchange, segment, tradingsymbol,
         underlying, instrument_type, option_type, strike, expiry_date, product, order_type,
         side, quantity, filled_quantity, pending_quantity, price, trigger_price,
         average_price, order_ts, exchange_ts, broker_updated_ts, source,
         algo_execution_id::text, algo_source_order_id::text, source_feed
    FROM realtime_production_broker_orders
   WHERE trade_date BETWEEN $1 AND $2
   ORDER BY COALESCE(order_ts, broker_updated_ts) DESC NULLS LAST, trade_date DESC
   LIMIT 20000
`;

const TRADES_SQL = `
  SELECT trade_uid, broker, broker_account, broker_order_id, broker_trade_id, trade_date,
         tradingsymbol, underlying, exchange, segment, option_type, strike, expiry_date,
         product, side, quantity, price, trade_value, trade_ts, brokerage, taxes, charges_total,
         source_feed
    FROM realtime_production_broker_trades
   WHERE trade_date BETWEEN $1 AND $2
   ORDER BY trade_ts DESC NULLS LAST
   LIMIT 20000
`;

const FUNDS_SQL = `
  SELECT DISTINCT ON (broker, broker_account)
         broker, broker_account, trade_date, available_cash, opening_balance, utilised_margin,
         collateral, withdrawable_balance, net_balance, realized_pnl, unrealized_pnl, snapshot_at
    FROM realtime_production_broker_funds
   WHERE trade_date <= $1
   ORDER BY broker, broker_account, trade_date DESC
`;

const LEDGER_SQL = `
  SELECT broker, broker_account, entry_date, category, voucher_type, narration,
         debit, credit, net_amount, running_balance
    FROM realtime_production_broker_ledger
   WHERE entry_date BETWEEN $1 AND $2
   ORDER BY entry_date DESC
   LIMIT 20000
`;

const SYNC_SQL = `
  SELECT broker, broker_account, dataset, last_record_ts, last_trade_date, last_success_at,
         last_attempt_at, last_status, last_error, rows_total
    FROM realtime_production_broker_sync_watermarks
   ORDER BY broker, broker_account, dataset
`;

const ISSUES_SQL = `
  SELECT issue_uid, broker, broker_account, trade_date, issue_type, severity,
         broker_order_id, execution_id::text, tradingsymbol, message, details,
         first_seen_at, last_seen_at
    FROM realtime_production_broker_reconciliation_issues
   WHERE resolved = FALSE
   ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, last_seen_at DESC
   LIMIT 500
`;

const SCHEMA_SQL = `
  SELECT COUNT(*)::int AS present FROM pg_class
   WHERE relkind = 'r' AND relname = ANY($1::text[])
`;

const REQUIRED_TABLES = [
  "realtime_production_broker_orders",
  "realtime_production_broker_trades",
  "realtime_production_broker_positions",
  "realtime_production_broker_funds",
  "realtime_production_broker_ledger",
  "realtime_production_broker_sync_watermarks",
  "realtime_production_broker_reconciliation_issues",
];

function text(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function n0(value: unknown): number {
  return num(value) ?? 0;
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function obj(value: unknown): Raw {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {};
}

function isoDate(value: unknown) {
  if (!value) return "";
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function accountId(broker: unknown, label: unknown, environment: unknown = "live") {
  return `${text(broker).toLowerCase()}:${text(label)}:${text(environment) || "live"}`;
}

function matchKey(broker: unknown, label: unknown) {
  return `${text(broker).toLowerCase()}:${text(label).toLowerCase()}`;
}

type Datasets = {
  schema_ready: boolean;
  message?: string;
  accounts: Raw[];
  positions: Raw[];
  orders: Raw[];
  trades: Raw[];
  funds: Raw[];
  ledger: Raw[];
  sync_status: Raw[];
  issues: Raw[];
};

async function loadDatasets(from: string, to: string): Promise<Datasets> {
  const restApiUrl = process.env.CANDLES_REST_API_URL;
  if (restApiUrl) {
    const url = new URL("/api/account-management/history/rows", restApiUrl);
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    const response = await fetch(url, {
      headers: process.env.CANDLES_REST_API_TOKEN ? { "x-api-key": process.env.CANDLES_REST_API_TOKEN } : undefined,
      cache: "no-store",
    });
    const payload = await response.json();
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || `REST API error (${response.status})`);
    }
    return {
      schema_ready: payload.schema_ready !== false,
      message: payload.message,
      accounts: payload.accounts ?? [],
      positions: payload.positions ?? [],
      orders: payload.orders ?? [],
      trades: payload.trades ?? [],
      funds: payload.funds ?? [],
      ledger: payload.ledger ?? [],
      sync_status: payload.sync_status ?? [],
      issues: payload.issues ?? [],
    };
  }

  const pool = getPostgresPool();
  const schema = await pool.query(SCHEMA_SQL, [REQUIRED_TABLES]);
  if (Number(schema.rows[0]?.present ?? 0) !== REQUIRED_TABLES.length) {
    return {
      schema_ready: false,
      message:
        "Broker-truth tables are not created yet. Run scripts/broker_sync/sync_broker_accounts.py --schema-only once.",
      accounts: [], positions: [], orders: [], trades: [], funds: [], ledger: [], sync_status: [], issues: [],
    };
  }

  const [registry, positions, orders, trades, funds, ledger, sync, issues] = await Promise.all([
    pool.query(REGISTRY_SQL),
    pool.query(POSITIONS_SQL, [from, to]),
    pool.query(ORDERS_SQL, [from, to]),
    pool.query(TRADES_SQL, [from, to]),
    pool.query(FUNDS_SQL, [to]),
    pool.query(LEDGER_SQL, [from, to]),
    pool.query(SYNC_SQL),
    pool.query(ISSUES_SQL),
  ]);

  return {
    schema_ready: true,
    accounts: registry.rows as Raw[],
    positions: positions.rows as Raw[],
    orders: orders.rows as Raw[],
    trades: trades.rows as Raw[],
    funds: funds.rows as Raw[],
    ledger: ledger.rows as Raw[],
    sync_status: sync.rows as Raw[],
    issues: issues.rows as Raw[],
  };
}

function monthBounds(month: string) {
  const [year, value] = month.split("-").map(Number);
  const start = new Date(Date.UTC(year, value - 1, 1));
  const end = new Date(Date.UTC(year, value, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const brokerFilter = (params.get("broker") || "ALL").toLowerCase();
  const accountFilter = params.get("account") || "ALL";
  const month = params.get("month") || new Date().toISOString().slice(0, 7);
  const bounds = monthBounds(month);
  const from = params.get("from") || bounds.from;
  const to = params.get("to") || bounds.to;

  try {
    const data = await loadDatasets(from, to);

    const allAccounts = data.accounts.map((row) => ({
      id: accountId(row.broker, row.account_label, row.environment),
      match: matchKey(row.broker, row.account_label),
      customer_id: row.customer_id ?? null,
      customer_key: text(row.customer_key),
      display_name: text(row.display_name) || text(row.account_label),
      broker: text(row.broker).toLowerCase(),
      broker_client_id: row.broker_client_id ? text(row.broker_client_id) : null,
      account_label: text(row.account_label),
      environment: text(row.environment) || "live",
      active: Boolean(row.active) && row.customer_active !== false,
      strategies: Array.isArray(row.strategies) ? row.strategies.map(text) : [],
      risk_config: obj(row.risk_config),
      auth_status: text(row.auth_status) || "unverified",
      token_expires_at: row.token_expires_at ? text(row.token_expires_at) : null,
      last_verified_at: row.last_verified_at ? text(row.last_verified_at) : null,
      linked_customer: Boolean(row.linked_customer),
    }));

    const idByMatch = new Map(allAccounts.map((account) => [account.match, account.id]));
    const resolve = (broker: unknown, label: unknown) => idByMatch.get(matchKey(broker, label)) ?? "unlinked";

    const positions = data.positions.map((row) => ({
      account_id: resolve(row.broker, row.broker_account),
      broker: text(row.broker).toLowerCase(),
      account_label: text(row.broker_account),
      trade_date: isoDate(row.trade_date),
      tradingsymbol: text(row.tradingsymbol),
      underlying: text(row.underlying),
      exchange: text(row.exchange),
      product: text(row.product),
      option_type: text(row.option_type),
      strike: num(row.strike),
      expiry_date: isoDate(row.expiry_date),
      position_type: text(row.position_type) || "OPEN",
      net_quantity: num(row.net_quantity),
      buy_quantity: num(row.buy_quantity),
      sell_quantity: num(row.sell_quantity),
      buy_avg_price: num(row.buy_avg_price),
      sell_avg_price: num(row.sell_avg_price),
      last_price: num(row.last_price),
      realized_pnl: num(row.realized_pnl),
      unrealized_pnl: num(row.unrealized_pnl),
      total_pnl: num(row.total_pnl),
      snapshot_at: text(row.snapshot_at),
      source_feed: text(row.source_feed) || "broker_api",
    }));

    const orders = data.orders.map((row) => ({
      order_uid: text(row.order_uid),
      account_id: resolve(row.broker, row.broker_account),
      broker: text(row.broker).toLowerCase(),
      account_label: text(row.broker_account),
      broker_order_id: text(row.broker_order_id),
      trade_date: isoDate(row.trade_date),
      status: text(row.status),
      status_raw: text(row.status_raw),
      is_open: Boolean(row.is_open),
      reject_reason: text(row.reject_reason),
      tradingsymbol: text(row.tradingsymbol),
      underlying: text(row.underlying),
      exchange: text(row.exchange),
      product: text(row.product),
      order_type: text(row.order_type),
      side: text(row.side),
      quantity: num(row.quantity),
      filled_quantity: num(row.filled_quantity),
      price: num(row.price),
      average_price: num(row.average_price),
      order_ts: text(row.order_ts),
      source: text(row.source) || "unknown",
      source_feed: text(row.source_feed) || "broker_api",
      algo_execution_id: row.algo_execution_id ? text(row.algo_execution_id) : null,
    }));

    const trades = data.trades.map((row) => ({
      trade_uid: text(row.trade_uid),
      account_id: resolve(row.broker, row.broker_account),
      broker: text(row.broker).toLowerCase(),
      account_label: text(row.broker_account),
      broker_order_id: text(row.broker_order_id),
      trade_date: isoDate(row.trade_date),
      tradingsymbol: text(row.tradingsymbol),
      side: text(row.side),
      product: text(row.product),
      quantity: num(row.quantity),
      price: num(row.price),
      trade_value: num(row.trade_value),
      trade_ts: text(row.trade_ts),
      charges_total: num(row.charges_total),
      brokerage: num(row.brokerage),
      taxes: num(row.taxes),
      source_feed: text(row.source_feed) || "broker_api",
    }));

    const ledger = data.ledger.map((row) => ({
      account_id: resolve(row.broker, row.broker_account),
      broker: text(row.broker).toLowerCase(),
      account_label: text(row.broker_account),
      entry_date: isoDate(row.entry_date),
      category: text(row.category) || "other",
      narration: text(row.narration),
      debit: n0(row.debit),
      credit: n0(row.credit),
      net_amount: n0(row.net_amount),
      running_balance: num(row.running_balance),
    }));

    const fundsById = new Map(
      data.funds.map((row) => [
        resolve(row.broker, row.broker_account),
        {
          trade_date: isoDate(row.trade_date),
          available_cash: num(row.available_cash),
          opening_balance: num(row.opening_balance),
          utilised_margin: num(row.utilised_margin),
          collateral: num(row.collateral),
          withdrawable_balance: num(row.withdrawable_balance),
          net_balance: num(row.net_balance),
          snapshot_at: text(row.snapshot_at),
        },
      ]),
    );

    const syncStatus = data.sync_status.map((row) => ({
      account_id: resolve(row.broker, row.broker_account),
      broker: text(row.broker).toLowerCase(),
      account_label: text(row.broker_account),
      dataset: text(row.dataset),
      last_record_ts: row.last_record_ts ? text(row.last_record_ts) : null,
      last_trade_date: isoDate(row.last_trade_date),
      last_success_at: row.last_success_at ? text(row.last_success_at) : null,
      last_attempt_at: row.last_attempt_at ? text(row.last_attempt_at) : null,
      last_status: text(row.last_status) || "never",
      last_error: text(row.last_error),
      rows_total: n0(row.rows_total),
    }));

    const issues = data.issues.map((row) => ({
      issue_uid: text(row.issue_uid),
      account_id: resolve(row.broker, row.broker_account),
      broker: text(row.broker).toLowerCase(),
      account_label: text(row.broker_account),
      trade_date: isoDate(row.trade_date),
      issue_type: text(row.issue_type),
      severity: text(row.severity) || "warning",
      broker_order_id: text(row.broker_order_id),
      tradingsymbol: text(row.tradingsymbol),
      message: text(row.message),
      last_seen_at: text(row.last_seen_at),
    }));

    // ---- filtering ------------------------------------------------------
    const visibleAccounts = allAccounts.filter(
      (account) =>
        (brokerFilter === "all" || account.broker === brokerFilter) &&
        (accountFilter === "ALL" || account.id === accountFilter),
    );
    const visibleIds = new Set(visibleAccounts.map((account) => account.id));
    const keep = <T extends { account_id: string }>(rows: T[]) => rows.filter((row) => visibleIds.has(row.account_id));

    const visiblePositions = keep(positions);
    const visibleOrders = keep(orders);
    const visibleTrades = keep(trades);
    const visibleLedger = keep(ledger);
    const visibleIssues = keep(issues);

    // ---- per-account metrics -------------------------------------------
    const accounts = visibleAccounts.map((account) => {
      const accountPositions = visiblePositions.filter((row) => row.account_id === account.id);
      const accountOrders = visibleOrders.filter((row) => row.account_id === account.id);
      const accountTrades = visibleTrades.filter((row) => row.account_id === account.id);
      const accountLedger = visibleLedger.filter((row) => row.account_id === account.id);
      const latestDate = accountPositions.reduce((best, row) => (row.trade_date > best ? row.trade_date : best), "");
      const latestPositions = accountPositions.filter((row) => row.trade_date === latestDate);

      return {
        ...account,
        funds: fundsById.get(account.id) ?? null,
        metrics: {
          open_positions: latestPositions.filter((row) => row.position_type === "OPEN").length,
          closed_positions: accountPositions.filter((row) => row.position_type === "CLOSED").length,
          orders: accountOrders.length,
          rejected: accountOrders.filter((row) => row.status === "REJECTED").length,
          cancelled: accountOrders.filter((row) => row.status === "CANCELLED").length,
          working: accountOrders.filter((row) => row.is_open).length,
          algo_orders: accountOrders.filter((row) => row.source === "algo").length,
          manual_orders: accountOrders.filter((row) => row.source === "manual").length,
          trades: accountTrades.length,
          realized_pnl: round(accountPositions.reduce((sum, row) => sum + n0(row.realized_pnl), 0)),
          unrealized_pnl: round(latestPositions.reduce((sum, row) => sum + n0(row.unrealized_pnl), 0)),
          charges: round(
            accountTrades.reduce((sum, row) => sum + n0(row.charges_total), 0) +
              accountLedger.filter((row) => row.category === "charges").reduce((sum, row) => sum + row.debit, 0),
          ),
          turnover: round(accountTrades.reduce((sum, row) => sum + Math.abs(n0(row.trade_value)), 0)),
        },
      };
    });

    // ---- daily calendar -------------------------------------------------
    type Day = {
      date: string;
      realized_pnl: number;
      charges: number;
      net_pnl: number;
      closed_positions: number;
      open_positions: number;
      orders: number;
      rejected: number;
      trades: number;
    };
    const byDate = new Map<string, Day>();
    const day = (date: string) => {
      const existing = byDate.get(date);
      if (existing) return existing;
      const fresh: Day = {
        date, realized_pnl: 0, charges: 0, net_pnl: 0,
        closed_positions: 0, open_positions: 0, orders: 0, rejected: 0, trades: 0,
      };
      byDate.set(date, fresh);
      return fresh;
    };

    for (const row of visiblePositions) {
      if (!row.trade_date) continue;
      const item = day(row.trade_date);
      item.realized_pnl += n0(row.realized_pnl);
      if (row.position_type === "CLOSED") item.closed_positions += 1;
      else item.open_positions += 1;
    }
    for (const row of visibleOrders) {
      if (!row.trade_date) continue;
      const item = day(row.trade_date);
      item.orders += 1;
      if (row.status === "REJECTED") item.rejected += 1;
    }
    for (const row of visibleTrades) {
      if (!row.trade_date) continue;
      const item = day(row.trade_date);
      item.trades += 1;
      item.charges += n0(row.charges_total);
    }
    for (const row of visibleLedger) {
      if (!row.entry_date || row.category !== "charges") continue;
      day(row.entry_date).charges += row.debit;
    }

    const calendar = [...byDate.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((item) => ({
        ...item,
        realized_pnl: round(item.realized_pnl),
        charges: round(item.charges),
        net_pnl: round(item.realized_pnl - item.charges),
      }));

    const latestByAccount = new Map<string, string>();
    for (const row of visiblePositions) {
      const best = latestByAccount.get(row.account_id) ?? "";
      if (row.trade_date > best) latestByAccount.set(row.account_id, row.trade_date);
    }
    const openPositions = visiblePositions.filter(
      (row) => row.position_type === "OPEN" && row.trade_date === latestByAccount.get(row.account_id),
    );
    const closedPositions = visiblePositions.filter((row) => row.position_type === "CLOSED");
    const rejectedOrders = visibleOrders.filter((row) => row.status === "REJECTED");

    return NextResponse.json({
      success: true,
      view: "historical",
      schema_ready: data.schema_ready,
      message: data.message ?? null,
      generated_at: new Date().toISOString(),
      query: { broker: brokerFilter, account: accountFilter, month, from, to },
      filters: {
        brokers: [...new Set(allAccounts.map((account) => account.broker))].sort(),
        accounts: allAccounts.map((account) => ({
          id: account.id,
          label: `${account.display_name} · ${account.broker.toUpperCase()}`,
        })),
        months: [...new Set(calendar.map((item) => item.date.slice(0, 7)))].sort().reverse(),
      },
      summary: {
        accounts: visibleAccounts.length,
        active: visibleAccounts.filter((account) => account.active).length,
        attention: visibleAccounts.filter(
          (account) => !["verified", "live", "healthy"].includes(account.auth_status.toLowerCase()),
        ).length,
        realized_pnl: round(calendar.reduce((sum, item) => sum + item.realized_pnl, 0)),
        charges: round(calendar.reduce((sum, item) => sum + item.charges, 0)),
        net_pnl: round(calendar.reduce((sum, item) => sum + item.net_pnl, 0)),
        unrealized_pnl: round(openPositions.reduce((sum, row) => sum + n0(row.unrealized_pnl), 0)),
        open_positions: openPositions.length,
        closed_positions: closedPositions.length,
        orders: visibleOrders.length,
        rejected: rejectedOrders.length,
        trades: visibleTrades.length,
        manual_orders: visibleOrders.filter((row) => row.source === "manual").length,
        available_cash: round(
          visibleAccounts.reduce((sum, account) => sum + n0(fundsById.get(account.id)?.available_cash), 0),
        ),
        open_issues: visibleIssues.length,
        // Angel One and Groww have no historical API, so anything older than
        // the first sync is reconstructed. Say so rather than implying the
        // broker returned it.
        provenance: {
          broker_api: visiblePositions.filter((row) => row.source_feed === "broker_api").length,
          derived_trades: visiblePositions.filter((row) => row.source_feed === "derived_trades").length,
          execution_audit: visiblePositions.filter((row) => row.source_feed === "execution_audit").length,
        },
      },
      accounts,
      calendar,
      open_positions: openPositions,
      closed_positions: closedPositions.slice(0, 500),
      rejected_orders: rejectedOrders.slice(0, 300),
      orders: visibleOrders.slice(0, 300),
      trades: visibleTrades.slice(0, 300),
      sync_status: syncStatus.filter((row) => visibleIds.has(row.account_id)),
      issues: visibleIssues,
      warnings: [
        "Rows marked Broker come straight from the broker API. Rows marked Rebuilt were reconstructed from the algo execution audit trail, because Angel One and Groww publish no historical endpoint.",
        "Angel One and Groww expose no ledger endpoint, so charges for those accounts come from trade-level data only.",
        "Angel One and Groww order, trade and position books are day scoped — from here on, only the daily sync can capture them.",
      ],
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Account history query failed" },
      { status: 500 },
    );
  }
}
