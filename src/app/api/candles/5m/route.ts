import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MARKET_MAP: Record<string, string> = {
  us: "us",
  india: "india",
  forex: "forex",
};

function normalizeLimit(value: string | null) {
  const parsed = Number(value || 100);
  if (!Number.isFinite(parsed)) {
    return 100;
  }
  return Math.min(Math.max(Math.trunc(parsed), 1), 500);
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const market = MARKET_MAP[(searchParams.get("market") || "us").toLowerCase()] || "us";
  const limit = normalizeLimit(searchParams.get("limit"));
  const tickers = (searchParams.get("tickers") || "")
    .split(",")
    .map((ticker) => ticker.trim())
    .filter(Boolean)
    .slice(0, 25);

  const restApiUrl = process.env.CANDLES_REST_API_URL;
  if (restApiUrl) {
    const upstreamUrl = new URL("/api/candles/5m", restApiUrl);
    upstreamUrl.searchParams.set("market", market);
    upstreamUrl.searchParams.set("limit", String(limit));
    if (tickers.length > 0) {
      upstreamUrl.searchParams.set("tickers", tickers.join(","));
    }

    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        headers: process.env.CANDLES_REST_API_TOKEN
          ? { "x-api-key": process.env.CANDLES_REST_API_TOKEN }
          : undefined,
        cache: "no-store",
      });
      const payload = await upstreamResponse.json();
      return NextResponse.json(payload, { status: upstreamResponse.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown REST API error";
      return NextResponse.json(
        {
          table: "candles_5m",
          market,
          tickers,
          limit,
          error: `REST API unavailable: ${message}`,
        },
        { status: 502 },
      );
    }
  }

  const params: Array<string | string[] | number> = [market];
  const filters = ["market = $1"];

  if (tickers.length > 0) {
    params.push(tickers);
    filters.push(`yahoo_symbol = ANY($${params.length}::text[])`);
  }

  params.push(limit);

  try {
    const result = await getPostgresPool().query(
      `
        SELECT
          yahoo_symbol,
          base_symbol,
          company_name,
          market,
          exchange_timezone,
          candle_ts,
          open_price,
          high_price,
          low_price,
          close_price,
          volume,
          source,
          fetched_at,
          updated_at
        FROM candles_5m
        WHERE ${filters.join(" AND ")}
        ORDER BY candle_ts DESC
        LIMIT $${params.length}
      `,
      params,
    );

    return NextResponse.json({
      table: "candles_5m",
      source: "postgres",
      market,
      tickers,
      limit,
      rowCount: result.rowCount,
      rows: result.rows,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Postgres error";
    return NextResponse.json(
      {
        table: "candles_5m",
        market,
        tickers,
        limit,
        error: message,
      },
      { status: 500 },
    );
  }
}
