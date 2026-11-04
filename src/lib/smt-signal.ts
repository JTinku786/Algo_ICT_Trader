/**
 * SMT divergence at signal time (Realtime + Backtest).
 *
 * Each trade is compared with its index / correlated peer on completed 5m
 * candles known at the signal time:
 *   India -> NIFTY 50 (%5ENSEI)        (NIFTY 50 itself -> NIFTY BANK)
 *   US    -> SPY (S&P 500)              (SPY -> QQQ, QQQ -> SPY)
 *   Forex -> correlated pair (EURUSD <-> GBPUSD, AUDUSD <-> NZDUSD, ... ; USDCHF vs EURUSD inverse)
 * Detection is the SMC Divergence tab's own engine (alignSmtBars / smtDivergences):
 * a strict 3-bar pivot on the traded symbol, the peer's extreme in the same
 * window, and exactly one of the two breaking its previous same-side extreme.
 * The latest divergence confirmed within SMT_LOOKBACK_BARS before the signal is
 * the trade's SMT; "aligned" means it points the same way as the trade.
 *
 * Results are immutable (only candles known at the signal are used), so they
 * are cached in ict_trade_smt and computed once per trade.
 */
import type { Pool } from "pg";
import { alignSmtBars, smtDivergences } from "./smt-divergence";
import type { ReplayBar } from "./weekly-replay";

export const SMT_VERSION = "smt-signal-v3";
export const SMT_LOOKBACK_BARS = 12; // the last hour of 5m candles before the signal: the setup's own swing
const STEP_MS = 300_000;

export type SmtStatus = "BULLISH_SMT" | "BEARISH_SMT" | "NO_SMT" | "NO_PEER_DATA" | "UNSUPPORTED";
export type SmtResult = {
  status: SmtStatus;
  aligned: boolean | null;
  peer: string | null;
  peer_label: string | null;
  inverse: boolean;
  bars_compared: number;
  event: null | {
    confirmed_at: string; swing_at: string; side: "HIGH" | "LOW";
    price: number; previous_price: number; peer_price: number; previous_peer_price: number;
    symbol_broke: boolean; peer_broke: boolean; previous_swing_at: string;
  };
  version: string;
};
export type SmtTrade = { key: string; symbol: string | null; market: string | null; signalTs: string | Date | null; direction: string | null };

const FOREX_PEERS: Record<string, [string, boolean]> = {
  EURUSD: ["GBPUSD", false], GBPUSD: ["EURUSD", false], AUDUSD: ["NZDUSD", false], NZDUSD: ["AUDUSD", false],
  USDCHF: ["EURUSD", true], USDCAD: ["USDCHF", false], USDJPY: ["USDCHF", false],
  EURJPY: ["GBPJPY", false], GBPJPY: ["EURJPY", false], AUDJPY: ["EURJPY", false], CHFJPY: ["EURJPY", false],
  EURGBP: ["EURUSD", false], XAUUSD: ["XAGUSD", false], XAGUSD: ["XAUUSD", false],
};

export function smtPeer(symbol: string | null | undefined, market: string | null | undefined): { peer: string; label: string; inverse: boolean } | null {
  const raw = String(symbol ?? "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  const m = String(market ?? "").toLowerCase();
  const core = upper.replace(/^(\^|%5E)/, "").replace(/=X$/, "");
  if (m === "forex" || FOREX_PEERS[core]) {
    const pair = FOREX_PEERS[core];
    return pair ? { peer: `^${pair[0]}`, label: `${pair[0].slice(0, 3)}/${pair[0].slice(3)}${pair[1] ? " (inverse)" : ""}`, inverse: pair[1] } : null;
  }
  if (m === "india" || upper.endsWith(".NS") || core.startsWith("NSE")) {
    if (core === "NSEI") return { peer: "%5ENSEBANK", label: "NIFTY BANK", inverse: false };
    return { peer: "%5ENSEI", label: "NIFTY 50", inverse: false };
  }
  if (core === "SPY") return { peer: "QQQ", label: "QQQ (Nasdaq-100)", inverse: false };
  if (core === "QQQ") return { peer: "SPY", label: "SPY (S&P 500)", inverse: false };
  return { peer: "SPY", label: "SPY (S&P 500)", inverse: false };
}

type CandleRow = { yahoo_symbol: string; candle_ts: Date; open_price: number; high_price: number; low_price: number; close_price: number };

async function loadBars(pool: Pool, symbols: string[], from: Date, to: Date, forex: boolean): Promise<Map<string, ReplayBar[]>> {
  const params = [symbols, from.toISOString(), to.toISOString()];
  const base = (table: string) => `SELECT yahoo_symbol, candle_ts, open_price, high_price, low_price, close_price, 0 AS pri FROM ${table}
      WHERE yahoo_symbol = ANY($1) AND candle_ts >= $2::timestamptz AND candle_ts <= $3::timestamptz`;
  const rollup = `SELECT yahoo_symbol, to_timestamp(floor(extract(epoch FROM candle_ts) / 300) * 300) AS candle_ts,
        (array_agg(open_price ORDER BY candle_ts))[1] AS open_price, max(high_price) AS high_price, min(low_price) AS low_price,
        (array_agg(close_price ORDER BY candle_ts DESC))[1] AS close_price, 1 AS pri
      FROM historical_candles_1m WHERE yahoo_symbol = ANY($1) AND market = 'forex'
        AND candle_ts >= $2::timestamptz AND candle_ts <= $3::timestamptz
      GROUP BY 1, 2 HAVING count(*) = 5`;
  const sql = `${base("candles_5m")} UNION ALL ${base("historical_candles_5m")}${forex ? ` UNION ALL ${rollup}` : ""} ORDER BY 1, 2, pri`;
  const { rows } = await pool.query<CandleRow & { pri: number }>(sql, params);
  const out = new Map<string, ReplayBar[]>();
  const seen = new Set<string>();
  for (const r of rows) {
    const t = new Date(r.candle_ts).getTime();
    const key = `${r.yahoo_symbol}|${t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const o = Number(r.open_price), h = Number(r.high_price), l = Number(r.low_price), c = Number(r.close_price);
    if (![o, h, l, c].every(Number.isFinite) || l > h) continue;
    const bar: ReplayBar = { t, day: new Date(t).toISOString().slice(0, 10), minute: 0, o, h, l, c, knownAt: t + STEP_MS };
    out.set(r.yahoo_symbol, [...(out.get(r.yahoo_symbol) ?? []), bar]);
  }
  return out;
}

const iso = (t: number) => new Date(t).toISOString();

export async function computeSmt(pool: Pool, trade: SmtTrade): Promise<SmtResult> {
  const pairing = smtPeer(trade.symbol, trade.market);
  const empty = (status: SmtStatus, bars = 0): SmtResult => ({ status, aligned: null, peer: pairing?.peer ?? null, peer_label: pairing?.label ?? null, inverse: pairing?.inverse ?? false, bars_compared: bars, event: null, version: SMT_VERSION });
  const signal = trade.signalTs ? new Date(trade.signalTs) : null;
  if (!pairing || !trade.symbol || !signal || Number.isNaN(signal.getTime())) return empty("UNSUPPORTED");
  const cutoff = signal.getTime();
  const from = new Date(cutoff - 4 * 86_400_000);
  const forex = String(trade.market ?? "").toLowerCase() === "forex" || pairing.peer.startsWith("^") && !pairing.peer.startsWith("^NSE");
  const bars = await loadBars(pool, [trade.symbol, pairing.peer], from, signal, forex);
  const a = (bars.get(trade.symbol) ?? []).filter((b) => b.knownAt <= cutoff);
  const b = (bars.get(pairing.peer) ?? []).filter((x) => x.knownAt <= cutoff);
  const pairs = alignSmtBars(a, b, "5m");
  const recentPairs = pairs.filter((p) => p.knownAt >= cutoff - SMT_LOOKBACK_BARS * STEP_MS);
  // No peer candles at all = missing data. A young session (signal in its first
  // minutes, the overnight gap resets pivots) simply has no SMT yet.
  if (!b.length || !pairs.length) return empty("NO_PEER_DATA", 0);
  if (recentPairs.length < 3) return empty("NO_SMT", recentPairs.length);
  const events = smtDivergences(pairs, "5m", pairing.inverse, cutoff)
    .filter((e) => e.knownAt <= cutoff && e.knownAt >= cutoff - SMT_LOOKBACK_BARS * STEP_MS);
  const e = events.at(-1);
  if (!e) return empty("NO_SMT", recentPairs.length);
  const side = String(trade.direction ?? "").toUpperCase().startsWith("S") ? "SELL" : "BUY";
  return {
    status: e.direction === "BUY" ? "BULLISH_SMT" : "BEARISH_SMT",
    aligned: e.direction === side,
    peer: pairing.peer, peer_label: pairing.label, inverse: pairing.inverse, bars_compared: recentPairs.length,
    event: {
      confirmed_at: iso(e.knownAt), swing_at: iso(e.currentA.t), side: e.side,
      price: e.aPrice, previous_price: e.previousAPrice, peer_price: e.bPrice, previous_peer_price: e.previousBPrice,
      symbol_broke: e.aBroke, peer_broke: e.bBroke, previous_swing_at: iso(e.previousA.t),
    },
    version: SMT_VERSION,
  };
}

let schemaReady: Promise<void> | null = null;
function ensureSchema(pool: Pool) {
  schemaReady ??= pool.query(`CREATE TABLE IF NOT EXISTS ict_trade_smt (
      trade_key text PRIMARY KEY, symbol text, peer text, signal_ts timestamptz, direction text,
      status text NOT NULL, aligned boolean, result jsonb NOT NULL, version text NOT NULL,
      computed_at timestamptz NOT NULL DEFAULT now())`).then(() => undefined).catch((error) => { schemaReady = null; throw error; });
  return schemaReady;
}

/**
 * SMT for many trades: cached rows first, then up to `computeLimit` missing ones.
 * Missing beyond the limit come back as undefined (shown as "pending") and are
 * filled on the next request or by /api/smt/backfill.
 */
export async function smtForTrades(pool: Pool, trades: SmtTrade[], computeLimit = 150): Promise<Map<string, SmtResult>> {
  const out = new Map<string, SmtResult>();
  if (!trades.length) return out;
  await ensureSchema(pool);
  const keys = [...new Set(trades.map((t) => t.key))];
  const cached = await pool.query<{ trade_key: string; result: SmtResult }>(
    `SELECT trade_key, result FROM ict_trade_smt WHERE trade_key = ANY($1) AND version = $2`, [keys, SMT_VERSION]);
  for (const row of cached.rows) out.set(row.trade_key, row.result);
  const missing = trades.filter((t, i, all) => !out.has(t.key) && all.findIndex((x) => x.key === t.key) === i).slice(0, computeLimit);
  const recentMs = Date.now() - 2 * 86_400_000;
  for (let i = 0; i < missing.length; i += 6) {
    const batch = missing.slice(i, i + 6);
    const results = await Promise.all(batch.map((t) => computeSmt(pool, t).catch(() => null)));
    const rows: unknown[] = [];
    batch.forEach((t, j) => {
      const r = results[j];
      if (!r) return;
      out.set(t.key, r);
      // Peer candles for a fresh signal can still be arriving; retry those later.
      const signalMs = t.signalTs ? new Date(t.signalTs).getTime() : 0;
      if (r.status === "NO_PEER_DATA" && signalMs > recentMs) return;
      rows.push([t.key, t.symbol, r.peer, t.signalTs, t.direction, r.status, r.aligned, JSON.stringify(r), SMT_VERSION]);
    });
    for (const row of rows) {
      await pool.query(`INSERT INTO ict_trade_smt (trade_key, symbol, peer, signal_ts, direction, status, aligned, result, version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT (trade_key) DO UPDATE SET status=EXCLUDED.status, aligned=EXCLUDED.aligned,
        result=EXCLUDED.result, version=EXCLUDED.version, computed_at=now()`, row as unknown[]);
    }
  }
  return out;
}

export const SMT_FILTERS = ["ALL", "ALIGNED", "OPPOSED", "ANY", "NONE"] as const;
export type SmtFilter = (typeof SMT_FILTERS)[number];
export function parseSmtFilter(value: string | null): SmtFilter {
  const v = String(value ?? "ALL").toUpperCase();
  return (SMT_FILTERS as readonly string[]).includes(v) ? (v as SmtFilter) : "ALL";
}
export function passesSmtFilter(result: SmtResult | undefined, filter: SmtFilter): boolean {
  if (filter === "ALL") return true;
  const has = result?.status === "BULLISH_SMT" || result?.status === "BEARISH_SMT";
  if (filter === "ANY") return has;
  if (filter === "NONE") return result?.status === "NO_SMT";
  if (filter === "ALIGNED") return has && result?.aligned === true;
  return has && result?.aligned === false;
}
export function smtGroup(result: SmtResult | undefined): string {
  if (!result) return "Pending";
  if (result.status === "BULLISH_SMT" || result.status === "BEARISH_SMT") return result.aligned ? "SMT with the trade" : "SMT against the trade";
  if (result.status === "NO_SMT") return "No SMT at signal";
  return "No peer data";
}
