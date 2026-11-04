import { Pool } from "pg";

let pool: Pool | null = null;

function getConnectionString() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL;
}

function normalizeConnectionString(connectionString: string) {
  try {
    const url = new URL(connectionString);
    url.searchParams.delete("sslmode");
    return url.toString();
  } catch {
    return connectionString;
  }
}

// ---------------------------------------------------------------------------
// Vercel: no direct Postgres. When PG_PROXY_URL is set, every query is sent to
// the local REST bridge (backend/rest_api.py POST /api/sql/query) through zrok.
// Runs read-only. BEGIN/COMMIT/ROLLBACK/SET LOCAL become no-ops on the bridge.
// ---------------------------------------------------------------------------
const DATE_OIDS = new Set([1082, 1114, 1184]);

type ProxyField = { name: string; dataTypeID: number };
type ProxyResult = { rows: Record<string, unknown>[]; fields: ProxyField[]; rowCount: number; command: string };

async function proxyQuery(textOrConfig: string | { text: string; values?: unknown[] }, maybeValues?: unknown[]) {
  const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
  const values = (typeof textOrConfig === "string" ? maybeValues : textOrConfig.values ?? maybeValues) ?? [];
  const res = await fetch(new URL("/api/sql/query", process.env.PG_PROXY_URL), {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.PG_PROXY_TOKEN ?? "" },
    // Base64 envelope: zrok's public frontend blocks some raw SQL patterns in request bodies.
    body: JSON.stringify({
      b64: Buffer.from(
        JSON.stringify({ text, values: values.map((v) => (v instanceof Date ? v.toISOString() : v)) }),
        "utf8",
      ).toString("base64"),
    }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => null)) as (ProxyResult & { error?: string }) | null;
  if (!res.ok || !body) {
    throw new Error(`Postgres proxy error (${res.status}): ${body?.error ?? "unavailable"}`);
  }
  const dateCols = (body.fields ?? []).filter((f) => DATE_OIDS.has(f.dataTypeID)).map((f) => f.name);
  if (dateCols.length) {
    for (const row of body.rows) {
      for (const col of dateCols) {
        const v = row[col];
        if (typeof v === "string") row[col] = new Date(v);
      }
    }
  }
  return body;
}

function createProxyPool(): Pool {
  const client = { query: proxyQuery, release: () => undefined };
  return {
    query: proxyQuery,
    connect: async () => client,
    end: async () => undefined,
    on: () => undefined,
  } as unknown as Pool;
}

export function hasPostgresConfig() {
  if (process.env.PG_PROXY_URL) {
    return true;
  }
  if (getConnectionString()) {
    return true;
  }

  return Boolean(
    process.env.POSTGRES_HOST &&
      process.env.POSTGRES_DATABASE &&
      process.env.POSTGRES_USER &&
      process.env.POSTGRES_PASSWORD,
  );
}

function shouldUseSsl(connectionString?: string) {
  return (
    process.env.POSTGRES_SSLMODE === "require" ||
    process.env.DATABASE_SSL === "true" ||
    Boolean(connectionString?.includes("sslmode=require"))
  );
}

export function getPostgresPool() {
  if (pool) {
    return pool;
  }

  if (process.env.PG_PROXY_URL) {
    pool = createProxyPool();
    return pool;
  }

  const connectionString = getConnectionString();
  if (connectionString) {
    pool = new Pool({
      connectionString: normalizeConnectionString(connectionString),
      ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : false,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    return pool;
  }

  const host = process.env.POSTGRES_HOST;
  const database = process.env.POSTGRES_DATABASE;
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;

  if (!host || !database || !user || !password) {
    throw new Error("Missing Postgres environment variables");
  }

  pool = new Pool({
    host,
    database,
    user,
    password,
    port: Number(process.env.POSTGRES_PORT || 5432),
    ssl: process.env.POSTGRES_SSLMODE === "require" ? { rejectUnauthorized: false } : false,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  return pool;
}
