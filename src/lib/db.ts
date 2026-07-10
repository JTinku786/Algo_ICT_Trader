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

export function hasPostgresConfig() {
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
