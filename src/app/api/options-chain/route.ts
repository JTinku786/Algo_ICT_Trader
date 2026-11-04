import { NextRequest, NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CONTRACT_MAP = "public.realtime_production_option_contract_map";
const PRICE_HISTORY = "public.option_chain_history";

type StrikeRow = {
  strike: number;
  ce: number | null;
  pe: number | null;
  ceMoneyness: string | null;
  peMoneyness: string | null;
  ceSymbol: string | null;
  peSymbol: string | null;
  ceToken: string | null;
  peToken: string | null;
};

function modeStep(strikes: number[]): number | null {
  if (strikes.length < 2) return null;
  const sorted = [...strikes].sort((a, b) => a - b);
  const counts = new Map<number, number>();
  for (let index = 1; index < sorted.length; index++) {
    const gap = Math.round((sorted[index] - sorted[index - 1]) * 100) / 100;
    if (gap > 0) counts.set(gap, (counts.get(gap) || 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [gap, count] of counts) {
    if (count > bestCount) {
      best = gap;
      bestCount = count;
    }
  }
  return best;
}

function moneyness(optionType: "CE" | "PE", strike: number, spot: number | null): string | null {
  if (spot == null) return null;
  if (Math.abs(strike - spot) < 0.001) return "ATM";
  if (optionType === "CE") return strike < spot ? "ITM" : "OTM";
  return strike > spot ? "ITM" : "OTM";
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const underlying = (params.get("underlying") || "ONGC").trim().toUpperCase().replace(/\.NS$/, "");
  const interval = (params.get("interval") || "FIVE_MINUTE").trim().toUpperCase();
  const expiryParam = (params.get("expiry") || "").trim();

  try {
    const pool = getPostgresPool();
    const expiriesResult = await pool.query(
      `SELECT DISTINCT expiry_date::text AS expiry
       FROM ${CONTRACT_MAP}
       WHERE underlying = $1 AND expiry_date >= CURRENT_DATE
       ORDER BY expiry ASC`,
      [underlying],
    );
    const expiries: string[] = expiriesResult.rows.map((row) => row.expiry);
    if (!expiries.length) {
      return NextResponse.json({ underlying, expiries: [], expiry: null, strikes: [], source: "contract-map-empty" });
    }
    const expiry = expiryParam && expiries.includes(expiryParam) ? expiryParam : expiries[0];

    const contractsResult = await pool.query(
      `SELECT m.option_symboltoken AS token, m.option_tradingsymbol AS tradingsymbol,
              m.option_type, m.strike::float8 AS strike, m.lotsize,
              h.close::float8 AS close, h.candle_ts
       FROM ${CONTRACT_MAP} m
       LEFT JOIN LATERAL (
         SELECT close, candle_ts
         FROM ${PRICE_HISTORY}
         WHERE token = m.option_symboltoken AND interval = $3
         ORDER BY candle_ts DESC
         LIMIT 1
       ) h ON TRUE
       WHERE m.underlying = $1 AND m.expiry_date = $2::date
       ORDER BY m.strike, m.option_type`,
      [underlying, expiry, interval],
    );
    const spotResult = await pool.query(
      `SELECT underlying_ltp::float8 AS spot, updated_at
       FROM public.realtime_production_broker_order_executions
       WHERE underlying = $1 AND underlying_ltp IS NOT NULL AND underlying_ltp > 0
       ORDER BY updated_at DESC
       LIMIT 1`,
      [underlying],
    );
    const spot = spotResult.rows[0]?.spot ?? null;
    const byStrike = new Map<number, StrikeRow>();
    let latestPremiumTs: string | null = null;
    let lotSize: number | null = null;
    let pricedContracts = 0;
    for (const row of contractsResult.rows) {
      const strike = Number(row.strike);
      const current = byStrike.get(strike) || {
        strike, ce: null, pe: null, ceMoneyness: null, peMoneyness: null,
        ceSymbol: null, peSymbol: null, ceToken: null, peToken: null,
      };
      lotSize ??= Number(row.lotsize) || null;
      if (row.close != null) {
        pricedContracts++;
        if (!latestPremiumTs || row.candle_ts > latestPremiumTs) latestPremiumTs = row.candle_ts;
      }
      if (row.option_type === "CE") {
        current.ce = row.close == null ? null : Number(row.close);
        current.ceMoneyness = moneyness("CE", strike, spot);
        current.ceSymbol = row.tradingsymbol;
        current.ceToken = row.token;
      } else if (row.option_type === "PE") {
        current.pe = row.close == null ? null : Number(row.close);
        current.peMoneyness = moneyness("PE", strike, spot);
        current.peSymbol = row.tradingsymbol;
        current.peToken = row.token;
      }
      byStrike.set(strike, current);
    }
    const strikes = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
    const step = modeStep(strikes.map((row) => row.strike));
    const atm = spot != null && strikes.length
      ? strikes.reduce((best, row) => Math.abs(row.strike - spot) < Math.abs(best.strike - spot) ? row : best).strike
      : null;

    return NextResponse.json({
      underlying, interval, expiry, expiries, asOf: latestPremiumTs ?? spotResult.rows[0]?.updated_at ?? null,
      spot, atm, step, lotSize, strikes, contracts: contractsResult.rows.length, pricedContracts,
      source: pricedContracts ? "angel-contract-map + option-price-history" : "angel-contract-map (premium capture pending)",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown DB error";
    return NextResponse.json({ underlying, error: `options-chain unavailable: ${message}`, strikes: [] }, { status: 502 });
  }
}
