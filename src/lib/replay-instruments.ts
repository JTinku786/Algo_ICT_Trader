import { getPostgresPool } from "./db";
import { frames, instruments } from "./daily-bias";

export type ReplayInstrument = { name: string; symbol: string; market: string; zone: string; availableFrames: string[] };
let cached: { expires: number; entries: ReplayInstrument[] } | undefined;
let pending: Promise<ReplayInstrument[]> | undefined;
export async function replayInstruments(): Promise<ReplayInstrument[]> {
  if (cached && cached.expires > Date.now()) return cached.entries;
  if (pending) return pending;
  pending = (async () => {
    const sql = frames.map(tf => `SELECT DISTINCT yahoo_symbol AS symbol, market, '${tf}' AS frame FROM candles_${tf} WHERE yahoo_symbol IS NOT NULL AND market IN ('us','india','forex')`).join(" UNION ALL ");
    // Stored historical-only instruments (including SPY/QQQ) are replayable too.
    const archives = ` UNION ALL SELECT DISTINCT yahoo_symbol AS symbol,market,'5m' AS frame FROM historical_candles_5m WHERE yahoo_symbol IS NOT NULL AND market IN ('us','forex')`;
    const result = await getPostgresPool().query(sql+archives);
    const entries = new Map<string, ReplayInstrument>();
    for (const row of result.rows) {
      const key = `${row.market}:${row.symbol}`;
      const known = instruments.find(i => i.symbol === row.symbol && i.market === row.market);
      const entry: ReplayInstrument = entries.get(key) ?? { name: known?.name ?? key, symbol: row.symbol, market: row.market, zone: row.market === "india" ? "Asia/Kolkata" : "America/New_York", availableFrames: [] };
      if(!entry.availableFrames.includes(row.frame))entry.availableFrames.push(row.frame);
      entries.set(key, entry);
    }
    const sorted = [...entries.values()].sort((a,b) => a.name.localeCompare(b.name));
    cached = { expires: Date.now()+300000, entries: sorted };
    return sorted;
  })();
  try { return await pending; } finally { pending = undefined; }
}
export async function resolveReplayInstrument(name: string) {
  const known = instruments.find(i => i.name === name || i.symbol === name);
  if (known) return known;
  const entries=await replayInstruments();
  const exact=entries.find(i=>i.name===name);
  if(exact)return exact;
  const matching=entries.filter(i=>i.symbol===name);
  return matching.length===1 ? matching[0] : undefined;
}
