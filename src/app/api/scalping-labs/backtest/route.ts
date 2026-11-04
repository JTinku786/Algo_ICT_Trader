import { backtestBuckets, loadBacktestResults, type BacktestFilters } from "@/lib/scalping-backtest-results";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const list = (key: string) => [...new Set((q.get(key) ?? "").split(",").filter(Boolean))].slice(0, 100);
  const buckets = list("buckets");
  if (buckets.some(bucket => !backtestBuckets.some(b => b === bucket))) return Response.json({ error: "Unknown R:R bucket." }, { status: 400 });
  const filters: BacktestFilters = { markets: list("markets"), symbols: list("symbols"), years: list("years"), buckets, side: ["BUY", "SELL"].includes(q.get("side") ?? "") ? q.get("side")! : "ALL", confirmation: q.get("confirmation") ?? "ALL", tf1: q.get("tf1") ?? "", tf2: q.get("tf2") ?? "", page: Math.floor(Math.min(1000, Math.max(1, Number(q.get("page")) || 1))) };
  try { return Response.json(await loadBacktestResults(filters)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "INDEX_BUILDING") return Response.json({ error: (error as Error).message }, { status: 503 });
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Response.json({ error: "The historical backtest report is not available yet. Results will appear here when the ticker workers publish their report." }, { status: 404 });
    console.error("Scalping Labs backtest report:", error instanceof Error ? error.message : "Unknown error");
    return Response.json({ error: "Unable to read the backtest report." }, { status: 500 });
  }
}
