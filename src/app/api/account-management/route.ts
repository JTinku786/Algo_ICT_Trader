import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Raw = Record<string, unknown>;

const ACCOUNTS_SQL = `
  SELECT
    c.customer_id::text, c.customer_key, c.display_name, c.active AS customer_active,
    a.broker_account_id::text, a.broker, a.broker_client_id, a.account_label,
    a.environment, a.active, a.strategies, a.risk_config, a.auth_status,
    a.token_expires_at, a.last_verified_at, a.created_at, a.updated_at,
    TRUE AS linked_customer
  FROM realtime_production_customers c
  JOIN realtime_production_customer_broker_accounts a ON a.customer_id = c.customer_id
  UNION ALL
  SELECT
    NULL, LOWER(e.broker || '_' || e.broker_account),
    CASE WHEN e.broker_account = 'Titania_ICT_Algo' THEN 'Naveen' ELSE e.broker_account END,
    TRUE, NULL, e.broker, NULL, e.broker_account, 'live', TRUE,
    '[]'::jsonb, '{}'::jsonb, 'legacy_unlinked', NULL, NULL,
    MIN(e.created_at), MAX(e.updated_at), FALSE
  FROM realtime_production_broker_order_executions e
  WHERE NULLIF(TRIM(e.broker_account), '') IS NOT NULL
    AND NOT EXISTS (
    SELECT 1 FROM realtime_production_customer_broker_accounts a
    WHERE LOWER(a.broker) = LOWER(e.broker)
      AND LOWER(a.account_label) = LOWER(e.broker_account)
  )
  GROUP BY e.broker, e.broker_account
`;

const EXECUTIONS_SQL = `
  SELECT
    execution_id::text, source_order_id::text, broker, broker_account,
    source_market, underlying, direction, option_type, option_tradingsymbol,
    quantity, lots, lotsize, status, error, dry_run, broker_response,
    exit_status, exit_reason, exit_price, exit_at, exit_response,
    created_at, updated_at
  FROM realtime_production_broker_order_executions
  ORDER BY created_at DESC
  LIMIT 10000
`;

function text(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}

function number(value: unknown): number | null {
  const parsed = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(parsed) ? null : parsed;
}

function object(value: unknown): Raw {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Raw : {};
}

function nestedNumber(value: unknown, paths: string[][]): number | null {
  const root = object(value);
  for (const path of paths) {
    let current: unknown = root;
    for (const key of path) current = object(current)[key];
    const result = number(current);
    if (result !== null) return result;
  }
  return null;
}

function isoDate(value: unknown) {
  if (!value) return "";
  const date = new Date(text(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function entryPrice(row: Raw) {
  return nestedNumber(row.broker_response, [
    ["average_traded_price"], ["averageprice"], ["averagePrice"], ["filled_price"],
    ["orderbook_status", "averageprice"], ["orderbook_status", "price"],
    ["status_poll", "average_price"], ["status_poll", "averagePrice"],
  ]);
}

function confirmedExitPrice(row: Raw) {
  const brokerConfirmed = nestedNumber(row.exit_response, [
    ["average_traded_price"], ["averageprice"], ["averagePrice"], ["filled_price"],
    ["orderbook_status", "averageprice"], ["orderbook_status", "price"],
    ["status_poll", "average_price"], ["status_poll", "averagePrice"],
  ]);
  if (brokerConfirmed !== null) return brokerConfirmed;

  // A few legacy rows stored the underlying's spot price in exit_price. Only
  // accept the column when a broker exit payload exists to corroborate it.
  return Object.keys(object(row.exit_response)).length > 0 ? number(row.exit_price) : null;
}

function realizedPnl(row: Raw) {
  const entry = entryPrice(row);
  const exit = confirmedExitPrice(row);
  const quantity = number(row.quantity);
  return entry !== null && exit !== null && quantity !== null ? round((exit - entry) * quantity) : null;
}

export async function GET(request: NextRequest) {
  const brokerFilter = (request.nextUrl.searchParams.get("broker") || "ALL").toLowerCase();
  const accountFilter = request.nextUrl.searchParams.get("account") || "ALL";
  const month = request.nextUrl.searchParams.get("month") || new Date().toISOString().slice(0, 7);

  try {
    let accountRows: Raw[];
    let executionRows: Raw[];
    const restApiUrl = process.env.CANDLES_REST_API_URL;
    if (restApiUrl) {
      const response = await fetch(new URL("/api/account-management/rows", restApiUrl), {
        headers: process.env.CANDLES_REST_API_TOKEN ? { "x-api-key": process.env.CANDLES_REST_API_TOKEN } : undefined,
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok || payload?.success === false) throw new Error(payload?.error || `REST API error (${response.status})`);
      accountRows = payload.accounts ?? [];
      executionRows = payload.executions ?? [];
    } else {
      const pool = getPostgresPool();
      const [accounts, executions] = await Promise.all([pool.query(ACCOUNTS_SQL), pool.query(EXECUTIONS_SQL)]);
      accountRows = accounts.rows as Raw[];
      executionRows = executions.rows as Raw[];
    }

    const allAccounts = accountRows.map((row) => ({
      id: `${text(row.broker).toLowerCase()}:${text(row.account_label)}:${text(row.environment) || "live"}`,
      customer_id: row.customer_id ?? null,
      customer_key: text(row.customer_key),
      display_name: text(row.display_name) || text(row.account_label),
      broker: text(row.broker).toLowerCase(),
      broker_client_id: row.broker_client_id ? text(row.broker_client_id) : null,
      account_label: text(row.account_label),
      environment: text(row.environment) || "live",
      active: Boolean(row.active) && row.customer_active !== false,
      strategies: Array.isArray(row.strategies) ? row.strategies.map(text) : [],
      risk_config: object(row.risk_config),
      auth_status: text(row.auth_status) || "unverified",
      token_expires_at: row.token_expires_at ? text(row.token_expires_at) : null,
      last_verified_at: row.last_verified_at ? text(row.last_verified_at) : null,
      linked_customer: Boolean(row.linked_customer),
    }));

    const accountByExecution = new Map(allAccounts.map((account) => [`${account.broker}:${account.account_label.toLowerCase()}`, account.id]));
    const enriched = executionRows.map((row) => {
      const accountId = accountByExecution.get(`${text(row.broker).toLowerCase()}:${text(row.broker_account).toLowerCase()}`) ?? "unlinked";
      const pnl = realizedPnl(row);
      const exitDate = isoDate(row.exit_at);
      return {
        execution_id: text(row.execution_id), account_id: accountId,
        broker: text(row.broker).toLowerCase(), account_label: text(row.broker_account),
        market: text(row.source_market), underlying: text(row.underlying), direction: text(row.direction),
        option_type: text(row.option_type), option_tradingsymbol: text(row.option_tradingsymbol),
        quantity: number(row.quantity), status: text(row.status), error: text(row.error), dry_run: Boolean(row.dry_run),
        exit_status: text(row.exit_status), exit_reason: text(row.exit_reason),
        entry_price: entryPrice(row), exit_price: confirmedExitPrice(row), realized_pnl_inr: pnl,
        created_at: text(row.created_at), exit_at: row.exit_at ? text(row.exit_at) : null, exit_date: exitDate,
      };
    });

    const visibleAccounts = allAccounts.filter((account) =>
      (brokerFilter === "all" || account.broker === brokerFilter) && (accountFilter === "ALL" || account.id === accountFilter),
    );
    const visibleIds = new Set(visibleAccounts.map((account) => account.id));
    const visibleExecutions = enriched.filter((row) => visibleIds.has(row.account_id));

    const accounts = visibleAccounts.map((account) => {
      const rows = enriched.filter((row) => row.account_id === account.id);
      const closed = rows.filter((row) => row.exit_at || row.exit_status.toLowerCase().includes("closed") || row.exit_status.toLowerCase().includes("exit"));
      const knownPnl = closed.filter((row) => row.realized_pnl_inr !== null);
      return {
        ...account,
        metrics: {
          executions: rows.length,
          placed: rows.filter((row) => ["placed", "submitted_pending"].includes(row.status.toLowerCase())).length,
          rejected: rows.filter((row) => ["failed", "broker_rejected"].includes(row.status.toLowerCase())).length,
          closed: closed.length,
          realized_pnl_inr: round(knownPnl.reduce((sum, row) => sum + (row.realized_pnl_inr ?? 0), 0)),
          unknown_closed_pnl: closed.length - knownPnl.length,
        },
      };
    });

    const dailyMap = new Map<string, { date: string; realized_pnl_inr: number; closed_trades: number; unknown_pnl: number; executions: number }>();
    for (const row of visibleExecutions) {
      const date = row.exit_date || isoDate(row.created_at);
      if (!date || date.slice(0, 7) !== month) continue;
      const item = dailyMap.get(date) ?? { date, realized_pnl_inr: 0, closed_trades: 0, unknown_pnl: 0, executions: 0 };
      item.executions += 1;
      if (row.exit_date) {
        item.closed_trades += 1;
        if (row.realized_pnl_inr === null) item.unknown_pnl += 1;
        else item.realized_pnl_inr += row.realized_pnl_inr;
      }
      dailyMap.set(date, item);
    }
    const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map((item) => ({ ...item, realized_pnl_inr: round(item.realized_pnl_inr) }));
    const knownDaily = daily.filter((item) => item.closed_trades > item.unknown_pnl);

    return NextResponse.json({
      success: true,
      generated_at: new Date().toISOString(),
      query: { broker: brokerFilter, account: accountFilter, month },
      filters: {
        brokers: [...new Set(allAccounts.map((account) => account.broker))].sort(),
        accounts: allAccounts.map((account) => ({ id: account.id, label: `${account.display_name} · ${account.broker.toUpperCase()}` })),
        months: [...new Set(enriched.map((row) => (row.exit_date || isoDate(row.created_at)).slice(0, 7)).filter(Boolean))].sort().reverse(),
      },
      summary: {
        accounts: visibleAccounts.length,
        active: visibleAccounts.filter((account) => account.active).length,
        attention: visibleAccounts.filter((account) => !["verified", "live", "healthy"].includes(account.auth_status.toLowerCase())).length,
        realized_pnl_inr: round(knownDaily.reduce((sum, day) => sum + day.realized_pnl_inr, 0)),
        closed_trades: daily.reduce((sum, day) => sum + day.closed_trades, 0),
        unknown_pnl: daily.reduce((sum, day) => sum + day.unknown_pnl, 0),
      },
      accounts,
      calendar: daily,
      recent_activity: visibleExecutions.slice(0, 100),
      warnings: [
        "Calendar P&L uses broker-confirmed entry and exit prices only.",
        "Closed executions without both confirmed prices are marked P&L unavailable and excluded from totals.",
        "Legacy broker accounts should be linked to a customer record for complete governance.",
      ],
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Account management query failed" }, { status: 500 });
  }
}
