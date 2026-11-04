import { createReadStream } from "node:fs";

import { readFile, stat } from "node:fs/promises";

import path from "node:path";

import { createInterface } from "node:readline";
import { REPORTS_DIR } from "./reports-dir";




export const backtestBuckets = ["0-1", "1-2", "2-3", "3-4", "4+"] as const;

export type BacktestTrade = {

  id: string; symbol: string; market: string; entryAt: number; entryKnownAt?: number; exitAt: number | null;

  side: string; tf1Kind: string; tf2Kind: string; confirmation: string; rrBucket: string;

  plannedRR: number; result: string; r: number | null; netR?: number | null;

  entry?: number; stop?: number; target?: number; holdBars?: number;

  sourceFile?: string;
  tf1Kinds?: string[]; tf2Kinds?: string[]; pairs?: { tf1: string; tf2: string }[];

  attributions?: { tf1Kind: string; tf2Kind: string; confirmation: string; contextId?: string; arrayId?: string }[];
  chartSelection?: { tf1Kind: string; tf2Kind: string; confirmation: string; contextId?: string; arrayId?: string };
  chartStats?: BacktestMetrics;
  chartFilters?: BacktestFilters;

};

export type BacktestMetrics = {

  scenarios: number; closed: number; open: number; wins: number; losses: number;

  grossR: number; netR: number; expectancy: number | null; winRate: number | null;

  profitFactor: number | null; noLosses: boolean; avgRR: number | null; missingNetCosts: number;

};

export type BacktestSummary = {

  status?: string; generatedAt?: string; selection?: Record<string, unknown>;

  dateCoverage?: unknown; counts?: Record<string, unknown>; errors?: unknown[];

  holdoutStart?: string; tradeFiles?: (string | { path: string; symbol?: string })[]; files?: (string | { path: string; symbol?: string })[];

  [key: string]: unknown;

};

export type BacktestFilters = { markets: string[]; symbols: string[]; years: string[]; buckets: string[]; side: string; confirmation: string; page: number; tf1?: string; tf2?: string };

type Accumulator = { scenarios: number; closed: number; open: number; wins: number; losses: number; grossR: number; netR: number; positiveR: number; negativeR: number; rr: number; missingNetCosts: number };

const blank = (): Accumulator => ({ scenarios: 0, closed: 0, open: 0, wins: 0, losses: 0, grossR: 0, netR: 0, positiveR: 0, negativeR: 0, rr: 0, missingNetCosts: 0 });

function add(a: Accumulator, t: BacktestTrade) {

  a.scenarios++; a.rr += Number.isFinite(t.plannedRR) ? t.plannedRR : 0;

  if (!["WIN", "LOSS"].includes(t.result) || t.exitAt == null || t.r == null) { a.open++; return; }

  a.closed++; a.grossR += t.r;

  const net = t.netR == null ? t.r : t.netR;

  if (t.netR == null) a.missingNetCosts++;

  a.netR += net;

  if (t.r > 0) { a.wins++; a.positiveR += t.r; }

  if (t.r < 0) { a.losses++; a.negativeR -= t.r; }

}

function finish(a: Accumulator): BacktestMetrics {

  return { scenarios: a.scenarios, closed: a.closed, open: a.open, wins: a.wins, losses: a.losses, grossR: a.grossR, netR: a.netR, expectancy: a.closed ? a.grossR / a.closed : null, winRate: a.closed ? a.wins / a.closed * 100 : null, profitFactor: a.negativeR ? a.positiveR / a.negativeR : null, noLosses: a.positiveR > 0 && a.negativeR === 0, avgRR: a.scenarios ? a.rr / a.scenarios : null, missingNetCosts: a.missingNetCosts };

}

const time = (value: unknown): number | null => { if (value == null) return null; const n = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : null; };

const nyYear = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" });

const nyMonth = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit" });

const monthAt = (at: number) => { const parts = nyMonth.formatToParts(new Date(at)); return `${parts.find(p => p.type === "year")!.value}-${parts.find(p => p.type === "month")!.value}`; };

export function normalizeBacktestTrade(row: Record<string, unknown>): BacktestTrade | null {

  const entryAt = time(row.entryAt);

  if (entryAt == null || !row.symbol || !row.rrBucket) return null;

  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

  const kinds = (value: unknown): string[] | undefined => Array.isArray(value) ? value.map(String) : undefined;

  const tf1Kinds = kinds(row.tf1Kinds) ?? kinds(row.tf1Kind), tf2Kinds = kinds(row.tf2Kinds) ?? kinds(row.tf2Kind);

  const attributions = Array.isArray(row.attributions) ? row.attributions.flatMap(value => value && typeof value === "object" && "tf1Kind" in value && "tf2Kind" in value && "confirmation" in value ? [{ tf1Kind: String(value.tf1Kind), tf2Kind: String(value.tf2Kind), confirmation: String(value.confirmation), contextId: "contextId" in value && value.contextId != null ? String(value.contextId) : undefined, arrayId: "arrayId" in value && value.arrayId != null ? String(value.arrayId) : undefined }] : []) : undefined;

  const pairs = Array.isArray(row.pairs) ? row.pairs.flatMap(value => value && typeof value === "object" && "tf1" in value && "tf2" in value ? [{ tf1: String(value.tf1), tf2: String(value.tf2) }] : []) : tf1Kinds?.flatMap(tf1 => (tf2Kinds ?? [String(row.tf2Kind ?? "")]).map(tf2 => ({ tf1, tf2 })));

  return { id: String(row.id ?? `${row.symbol}:${entryAt}:${row.tf1Kind}:${row.tf2Kind}:${row.rrBucket}:${row.confirmation}`), symbol: String(row.symbol), market: String(row.market ?? "unknown"), entryAt, entryKnownAt: time(row.entryKnownAt) ?? undefined, exitAt: time(row.exitAt), side: String(row.side ?? ""), tf1Kind: attributions?.length ? [...new Set(attributions.map(a => a.tf1Kind))].join(", ") : tf1Kinds?.join(", ") ?? String(row.tf1Kind ?? ""), tf2Kind: attributions?.length ? [...new Set(attributions.map(a => a.tf2Kind))].join(", ") : tf2Kinds?.join(", ") ?? String(row.tf2Kind ?? ""), confirmation: String(row.confirmation ?? ""), rrBucket: String(row.rrBucket), plannedRR: number(row.plannedRR) ?? 0, result: String(row.result ?? "OPEN"), r: number(row.r) ?? null, netR: number(row.netR), entry: number(row.entry), stop: number(row.stop), target: number(row.target), holdBars: number(row.holdBars), sourceFile: row.sourceFile == null ? undefined : String(row.sourceFile), tf1Kinds, tf2Kinds, pairs, attributions };

}

export function createBacktestAggregation(filters: BacktestFilters, holdoutStart = "2024-01-01") {

  const cutoff = Date.parse(`${holdoutStart}T00:00:00-05:00`);

  const all = blank(), markets = new Set<string>(), symbols = new Set<string>(), years = new Set<string>(), confirmations = new Set<string>();

  const bucketGroups = new Map<string, Accumulator>(), annual = new Map<string, Accumulator>(), combinations = new Map<string, { all: Accumulator; train: Accumulator; holdout: Accumulator }>();

  const heatmapGroups = new Map<string, Accumulator>();

  const months = new Map<string, number>(), trades: BacktestTrade[] = [];

  const costs = new Map([1, 2, 5].map(bps => [bps, blank()]));

  let malformed = 0, tradeMatches = 0;

  const keep = Math.max(1, filters.page) * 50;

  const consume = (row: Record<string, unknown>) => {

    const t = normalizeBacktestTrade(row); if (!t) { malformed++; return; }

    const year = nyYear.format(new Date(t.entryAt));

    const attributes = t.attributions?.length ? t.attributions : (t.pairs?.length ? t.pairs : [{ tf1: t.tf1Kind, tf2: t.tf2Kind }]).map(pair => ({ tf1Kind: pair.tf1, tf2Kind: pair.tf2, confirmation: t.confirmation }));

    const uniqueAttributes = [...new Map(attributes.map(a => [`${a.tf1Kind}|${a.tf2Kind}|${a.confirmation}`, a])).values()];
    const matchingAttributes = uniqueAttributes.filter(a => (!filters.tf1 || a.tf1Kind === filters.tf1) && (!filters.tf2 || a.tf2Kind === filters.tf2) && (filters.confirmation === "ALL" || a.confirmation === filters.confirmation));

    markets.add(t.market); symbols.add(t.symbol); years.add(year); uniqueAttributes.forEach(a => confirmations.add(a.confirmation));

    if ((filters.markets.length && !filters.markets.includes(t.market)) || (filters.symbols.length && !filters.symbols.includes(t.symbol)) || (filters.years.length && !filters.years.includes(year)) || (filters.buckets.length && !filters.buckets.includes(t.rrBucket)) || (filters.side !== "ALL" && filters.side !== t.side) || (filters.confirmation !== "ALL" && !uniqueAttributes.some(a => a.confirmation === filters.confirmation))) return;

    if (!matchingAttributes.length) return;
    add(all, t);

    for (const [bps, stats] of costs) {

      const risk = t.entry != null && t.stop != null ? Math.abs(t.entry - t.stop) : 0;

      if (["WIN", "LOSS"].includes(t.result) && t.r != null && risk > 0) add(stats, { ...t, r: t.r - Math.abs(t.entry!) * bps / 10000 / risk, netR: undefined });

      else if (t.result === "OPEN") add(stats, t);

    }

    const accumulate = (groups: Map<string, Accumulator>, key: string) => { const a = groups.get(key) ?? blank(); add(a, t); groups.set(key, a); };

    accumulate(bucketGroups, t.rrBucket); accumulate(annual, `${year}|${t.rrBucket}`);

    for (const attribute of matchingAttributes) {

      if (filters.confirmation !== "ALL" && filters.confirmation !== attribute.confirmation) continue;

      const key = `${t.market}|${attribute.tf1Kind}|${attribute.tf2Kind}|${t.rrBucket}|${attribute.confirmation}`;

      const combo = combinations.get(key) ?? { all: blank(), train: blank(), holdout: blank() };

      add(combo.all, t);

      if (t.entryAt >= cutoff) add(combo.holdout, t);

      else if (t.exitAt != null && t.exitAt < cutoff) add(combo.train, t);

      combinations.set(key, combo);

    }

    const pairKeys = new Set(matchingAttributes.map(a => `${t.market}|${a.tf1Kind}|${a.tf2Kind}|${t.rrBucket}`));

    for (const key of pairKeys) { const group = heatmapGroups.get(key) ?? blank(); add(group, t); heatmapGroups.set(key, group); }

    if (["WIN", "LOSS"].includes(t.result) && t.exitAt != null && t.r != null) { const key = `${monthAt(t.exitAt)}|${t.rrBucket}`; months.set(key, (months.get(key) ?? 0) + t.r); }

    // Retain only the requested page prefix, rather than shipping full history to the browser.

    const tradeMatch = uniqueAttributes.some(a => (!filters.tf1 || a.tf1Kind === filters.tf1) && (!filters.tf2 || a.tf2Kind === filters.tf2) && (filters.confirmation === "ALL" || a.confirmation === filters.confirmation));
    if (tradeMatch) tradeMatches++;
    if (tradeMatch && (trades.length < keep || t.entryAt > trades[trades.length - 1].entryAt)) { trades.push(t); trades.sort((a, b) => b.entryAt - a.entryAt || a.id.localeCompare(b.id)); if (trades.length > keep) trades.pop(); }

  };

  const result = () => {

    const equity: { month: string; bucket: string; netR: number; cumulativeR: number }[] = [];

    for (const bucket of backtestBuckets) { let cumulativeR = 0; for (const [key, netR] of [...months].sort(([a], [b]) => a.localeCompare(b))) { const [month, band] = key.split("|"); if (band === bucket) { cumulativeR += netR; equity.push({ month, bucket, netR, cumulativeR }); } } }

    return { options: { markets: [...markets].sort(), symbols: [...symbols].sort(), years: [...years].sort(), confirmations: [...confirmations].sort() }, stats: finish(all), costSensitivity: [...costs].map(([bps, stats]) => ({ bps, ...finish(stats) })), heatmapCells: [...heatmapGroups].map(([key, stats]) => { const [market, tf1, tf2, bucket] = key.split("|"); return { market, tf1, tf2, bucket, ...finish(stats) }; }), buckets: [...bucketGroups].map(([bucket, stats]) => ({ bucket, ...finish(stats) })), years: [...annual].map(([key, stats]) => { const [year, bucket] = key.split("|"); return { year, bucket, ...finish(stats) }; }).sort((a, b) => a.year.localeCompare(b.year) || a.bucket.localeCompare(b.bucket)), combinations: [...combinations].map(([key, stats]) => { const [market, tf1, tf2, bucket, confirmation] = key.split("|"); return { market, tf1, tf2, bucket, confirmation, ...finish(stats.all), train: finish(stats.train), holdout: finish(stats.holdout) }; }).sort((a, b) => (b.holdout.expectancy ?? -Infinity) - (a.holdout.expectancy ?? -Infinity) || b.closed - a.closed), equity, trades: trades.slice((filters.page - 1) * 50, filters.page * 50), pagination: { page: filters.page, pageSize: 50, total: tradeMatches }, malformed };

  };

  return { consume, result };

}

export type PairedRRReport = {

  status: string; comparisonAvailable: boolean; reason?: string; holdoutStart?: string;

  commonFamilies?: { scope: string; market: string; period: string; eligible: number; comparableClosed: number; unresolved: number; trainingBoundaryExcluded: number }[];

  bucketResults?: { scope: string; market: string; period: string; rrBucket: string; closed: number; netR: number; expectancyR: number | null; costSensitivityNetR: Record<string, number>; pairedMeanDeltaVs0To1: number | null }[];

};

export type BacktestResults = ReturnType<ReturnType<typeof createBacktestAggregation>["result"]> & { summary: BacktestSummary; validation: Record<string, unknown> | null; pairedRR: PairedRRReport | null; availableFiles: number; missingFiles: number; filters: BacktestFilters };

const root = path.join(REPORTS_DIR, "scalping-labs", "backtest");

const cache = new Map<string, { at: number; data: BacktestResults }>();

type SqlDatabase = { prepare: (sql: string) => { all: (...parameters: (string | number)[]) => Record<string, unknown>[]; iterate: (...parameters: (string | number)[]) => Iterable<Record<string, unknown>>; get: (...parameters: (string | number)[]) => Record<string, unknown> | undefined }; exec: (sql: string) => void; close: () => void };

type CubeMetrics = Partial<Accumulator> & { costs?: Record<string, Partial<Accumulator>> };

function mergeMetrics(destination: Accumulator, metrics: CubeMetrics) {

  for (const key of Object.keys(destination) as (keyof Accumulator)[]) destination[key] += Number(metrics[key] ?? (key === "netR" ? metrics.grossR : 0)) || 0;

}

function sqliteFilters(filters: BacktestFilters, table: "scenario_stats" | "pair_stats" | "trades") {

  const terms: string[] = [], parameters: (string | number)[] = [];

  const list = (column: string, values: string[]) => { if (values.length) { terms.push(`${column} IN (${values.map(() => "?").join(",")})`); parameters.push(...values); } };

  list("market", filters.markets); list("symbol", filters.symbols); list("entryYear", filters.years); list("rrBucket", filters.buckets);

  if (filters.side !== "ALL") { terms.push("side=?"); parameters.push(filters.side); }

  if (filters.confirmation !== "ALL") {

    terms.push(table === "scenario_stats" ? "instr(',' || confirmationSet || ',', ',' || ? || ',') > 0" : table === "pair_stats" ? "confirmation=?" : "EXISTS (SELECT 1 FROM attributions a WHERE a.tradeId=t.id AND a.confirmation=?)");

    parameters.push(filters.confirmation);

  }

  return { where: terms.length ? ` WHERE ${terms.join(" AND ")}` : "", parameters };

}

function readSqliteResults(filters: BacktestFilters, summary: BacktestSummary): Omit<BacktestResults, "validation" | "pairedRR"> {

  // node:sqlite is supplied by the workspace's Node 24 runtime; no package install or database writes are needed.

  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string, options: { readOnly: boolean }) => SqlDatabase };
  const database = new DatabaseSync(path.join(root, "results.sqlite"), { readOnly: true });

  try {

    database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;");

    if (!database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cube_metadata'").get()) throw Object.assign(new Error("Backtest result indexing is still in progress."), { code: "INDEX_BUILDING" });

    if (String(database.prepare("SELECT value FROM cube_metadata WHERE key='schemaVersion'").get()?.value) !== "3") throw Object.assign(new Error("Backtest result indexing is still in progress."), { code: "INDEX_BUILDING" });

    // A scenario may match several attributions. Read its union once when filtering
    // by context/array, so all analytics and the trade list share the same scope.
    // Summing pair cubes here would double-count entries with overlapping pairs.
    if (filters.tf1 || filters.tf2) {
      const query = sqliteFilters(filters, "trades");
      const terms: string[] = [], parameters: string[] = [];
      if (filters.tf1) { terms.push("a.tf1Kind=?"); parameters.push(filters.tf1); }
      if (filters.tf2) { terms.push("a.tf2Kind=?"); parameters.push(filters.tf2); }
      if (filters.confirmation !== "ALL") { terms.push("a.confirmation=?"); parameters.push(filters.confirmation); }
      const where = query.where + `${query.where ? " AND " : " WHERE "}t.id IN (SELECT a.tradeId FROM attributions a WHERE ${terms.join(" AND ")})`;
      const aggregate = createBacktestAggregation(filters, summary.holdoutStart);
      const statement = database.prepare(`SELECT t.*, (SELECT json_group_array(json_object('tf1Kind',a.tf1Kind,'tf2Kind',a.tf2Kind,'confirmation',a.confirmation,'contextId',a.contextId,'arrayId',a.arrayId)) FROM attributions a WHERE a.tradeId=t.id) AS savedAttributions FROM trades t${where} ORDER BY entryAt DESC,id`);
      for (const row of statement.iterate(...query.parameters, ...parameters)) aggregate.consume({ ...row, attributions: JSON.parse(String(row.savedAttributions)) });
      const option = (column: string, table = "scenario_stats") => database.prepare(`SELECT DISTINCT ${column} FROM ${table} ORDER BY ${column}`).all().map(row => String(row[column]));
      const files = Number(database.prepare("SELECT COUNT(*) AS n FROM files").get()?.n ?? 0);
      const requested = (summary.files ?? summary.tradeFiles)?.length ?? files;
      return { ...aggregate.result(), summary, filters, availableFiles: files, missingFiles: Math.max(0, requested - files), options: { markets: option("market"), symbols: option("symbol"), years: option("entryYear"), confirmations: option("confirmation", "pair_stats") } };
    }
    const mainFilter = sqliteFilters(filters, "scenario_stats"), pairFilter = sqliteFilters(filters, "pair_stats"), tradeFilter = sqliteFilters(filters, "trades");

    const rows = database.prepare(`SELECT * FROM scenario_stats${mainFilter.where}`).all(...mainFilter.parameters);

    const pairs = database.prepare(`SELECT * FROM pair_stats${pairFilter.where}`).all(...pairFilter.parameters);

    const all = blank(), bucketGroups = new Map<string, Accumulator>(), annual = new Map<string, Accumulator>(), monthly = new Map<string, number>(), costs = new Map([1, 2, 5].map(b => [b, blank()]));

    const grouped = (map: Map<string, Accumulator>, key: string, metrics: CubeMetrics) => { const target = map.get(key) ?? blank(); mergeMetrics(target, metrics); map.set(key, target); };

    for (const row of rows) {

      const metrics = JSON.parse(String(row.metrics)) as CubeMetrics;

      mergeMetrics(all, metrics); grouped(bucketGroups, String(row.rrBucket), metrics); grouped(annual, `${row.entryYear}|${row.rrBucket}`, metrics);

      for (const [bps, target] of costs) mergeMetrics(target, metrics.costs?.[String(bps)] ?? {});

      if (row.exitMonth) { const key = `${row.exitMonth}|${row.rrBucket}`; monthly.set(key, (monthly.get(key) ?? 0) + Number(metrics.grossR ?? 0)); }

    }

    const combinations = new Map<string, { all: Accumulator; train: Accumulator; holdout: Accumulator }>();

    for (const row of pairs) {

      const key = `${row.market}|${row.tf1Kind}|${row.tf2Kind}|${row.rrBucket}|${row.confirmation}`, group = combinations.get(key) ?? { all: blank(), train: blank(), holdout: blank() };

      const period = String(row.period).toLowerCase() as keyof typeof group;

      if (group[period]) mergeMetrics(group[period], JSON.parse(String(row.metrics)));

      combinations.set(key, group);

    }

    const heatmap = new Map<string, Accumulator>();

    if (filters.confirmation === "ALL") {

      const query = sqliteFilters(filters, "pair_stats");

      for (const row of database.prepare(`SELECT * FROM pair_union_stats${query.where}`).all(...query.parameters)) { const key = `${row.market}|${row.tf1Kind}|${row.tf2Kind}|${row.rrBucket}`; grouped(heatmap, key, JSON.parse(String(row.metrics))); }

    } else {

      for (const [key, metrics] of combinations) { const [market, tf1, tf2, bucket] = key.split("|"); grouped(heatmap, `${market}|${tf1}|${tf2}|${bucket}`, metrics.all); }

    }

    const equity: BacktestResults["equity"] = [];

    for (const bucket of backtestBuckets) { let cumulativeR = 0; for (const [key, netR] of [...monthly].sort(([a], [b]) => a.localeCompare(b))) { const [month, band] = key.split("|"); if (band === bucket) { cumulativeR += netR; equity.push({ month, bucket, netR, cumulativeR }); } } }

    const option = (column: string, table = "scenario_stats") => database.prepare(`SELECT DISTINCT ${column} FROM ${table} ORDER BY ${column}`).all().map(row => String(row[column]));

    const pairTerms: string[] = [], pairParameters: string[] = [];
    if (filters.tf1) { pairTerms.push("a.tf1Kind=?"); pairParameters.push(filters.tf1); }
    if (filters.tf2) { pairTerms.push("a.tf2Kind=?"); pairParameters.push(filters.tf2); }
    if (pairTerms.length && filters.confirmation !== "ALL") { pairTerms.push("a.confirmation=?"); pairParameters.push(filters.confirmation); }
    const tradeWhere = tradeFilter.where + (pairTerms.length ? `${tradeFilter.where ? " AND " : " WHERE "}t.id IN (SELECT a.tradeId FROM attributions a WHERE ${pairTerms.join(" AND ")})` : "");
    const tradeParameters = [...tradeFilter.parameters, ...pairParameters];
    const tradeTotal = pairTerms.length ? Number(database.prepare(`SELECT COUNT(*) AS n FROM trades t${tradeWhere}`).get(...tradeParameters)?.n ?? 0) : all.scenarios;
    const trades = database.prepare(`SELECT t.* FROM trades t${tradeWhere} ORDER BY entryAt DESC,id LIMIT 50 OFFSET ?`).all(...tradeParameters, (filters.page - 1) * 50).flatMap(row => {

      const attributions = database.prepare("SELECT tf1Kind,tf2Kind,confirmation,contextId,arrayId FROM attributions WHERE tradeId=?").all(String(row.id));

      const trade = normalizeBacktestTrade({ ...row, attributions }); return trade ? [trade] : [];

    });

    const files = Number(database.prepare("SELECT COUNT(*) AS n FROM files").get()?.n ?? 0), requested = (summary.files ?? summary.tradeFiles)?.length ?? files;

    return { summary, filters, availableFiles: files, missingFiles: Math.max(0, requested - files), options: { markets: option("market"), symbols: option("symbol"), years: option("entryYear"), confirmations: option("confirmation", "pair_stats") }, stats: finish(all), heatmapCells: [...heatmap].map(([key, metrics]) => { const [market, tf1, tf2, bucket] = key.split("|"); return { market, tf1, tf2, bucket, ...finish(metrics) }; }), buckets: [...bucketGroups].map(([bucket, metrics]) => ({ bucket, ...finish(metrics) })), years: [...annual].map(([key, metrics]) => { const [year, bucket] = key.split("|"); return { year, bucket, ...finish(metrics) }; }).sort((a, b) => a.year.localeCompare(b.year) || a.bucket.localeCompare(b.bucket)), combinations: [...combinations].map(([key, metrics]) => { const [market, tf1, tf2, bucket, confirmation] = key.split("|"); return { market, tf1, tf2, bucket, confirmation, ...finish(metrics.all), train: finish(metrics.train), holdout: finish(metrics.holdout) }; }).sort((a, b) => (b.holdout.expectancy ?? -Infinity) - (a.holdout.expectancy ?? -Infinity) || b.closed - a.closed), costSensitivity: [...costs].map(([bps, metrics]) => ({ bps, ...finish(metrics) })), equity, trades, pagination: { page: filters.page, pageSize: 50, total: tradeTotal }, malformed: 0 };

  } finally { database.exec("ROLLBACK;"); database.close(); }

}

export async function loadBacktestResults(filters: BacktestFilters): Promise<BacktestResults> {

  let summary: BacktestSummary;

  try { summary = JSON.parse(await readFile(path.join(root, "summary.json"), "utf8")); }

  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; summary = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")); }

  const artifactNames = ["validation.json", "paired-rr-comparison.json"];

  const artifactStamps = await Promise.all(artifactNames.map(async name => { const metadata = await stat(path.join(root, name)).catch(() => null); return metadata ? `${metadata.mtimeMs}:${metadata.size}` : null; }));

  const readArtifact = async (name: string) => { try { return JSON.parse(await readFile(path.join(root, name), "utf8")); } catch { return null; } };

  let databaseStamp: string | null = null;

  try { const metadata = await stat(path.join(root, "results.sqlite")); const indexed = await stat(path.join(root, "index-status.json")).catch(() => null); databaseStamp = `${metadata.mtimeMs}:${metadata.size}:${indexed?.mtimeMs}`; } catch { /* Small pilots can use the streaming reader before indexing. */ }

  if (databaseStamp) {

    const key = JSON.stringify([databaseStamp, summary.generatedAt, summary.status, artifactStamps, filters]);

    const old = cache.get(key); if (old && Date.now() - old.at < 300_000) return old.data;

    const [validation, pairedRR] = await Promise.all(artifactNames.map(readArtifact));

    const data = { ...readSqliteResults(filters, summary), validation, pairedRR };

    cache.set(key, { at: Date.now(), data }); while (cache.size > 12) cache.delete(cache.keys().next().value!);

    return data;

  }

  const names = (summary.tradeFiles ?? summary.files)?.map(file => typeof file === "string" ? file : file.path) ?? ["trades.ndjson"];

  const files = names.map(name => { const file = path.resolve(root, name); if (!file.startsWith(`${root}${path.sep}`) || !file.endsWith(".ndjson")) throw new Error("Invalid backtest trade manifest."); return file; });

  const metadata = await Promise.all(files.map(async file => { try { const s = await stat(file); return { file, stamp: `${s.mtimeMs}:${s.size}` }; } catch { return null; } }));

  if (metadata.reduce((size, item) => size + Number(item?.stamp.split(":")[1] ?? 0), 0) > 100_000_000) throw Object.assign(new Error("Historical results are still being indexed. Refresh when the ticker index catches up."), { code: "INDEX_BUILDING" });

  const key = JSON.stringify([summary.generatedAt, summary.status, metadata, artifactStamps, filters]);

  const old = cache.get(key); if (old && Date.now() - old.at < 300_000) return old.data;

  const aggregate = createBacktestAggregation(filters, summary.holdoutStart);

  for (const source of metadata) {

    if (!source) continue;

    const lines = createInterface({ input: createReadStream(source.file, { encoding: "utf8" }), crlfDelay: Infinity });

    for await (const line of lines) { if (!line.trim()) continue; try { aggregate.consume({ ...JSON.parse(line), sourceFile: path.relative(root, source.file) }); } catch { aggregate.consume({}); } }

  }

  const [validation, pairedRR] = await Promise.all(artifactNames.map(readArtifact));

  const data = { ...aggregate.result(), summary, validation, pairedRR, availableFiles: metadata.filter(Boolean).length, missingFiles: metadata.filter(x => !x).length, filters };

  cache.set(key, { at: Date.now(), data }); while (cache.size > 12) cache.delete(cache.keys().next().value!);

  return data;

}

