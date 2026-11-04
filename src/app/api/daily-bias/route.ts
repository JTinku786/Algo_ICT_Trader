import { loadDailyBias } from "@/lib/daily-bias-data";
import { DAILY_BIAS_VERSION } from "@/lib/daily-bias";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let cached: { at: number; report: Awaited<ReturnType<typeof loadDailyBias>> } | undefined;
let pending: ReturnType<typeof loadDailyBias> | undefined;
export async function GET(request: Request) {
  try {
    if (new URL(request.url).searchParams.get("refresh") === "1" || !cached || cached.report.version !== DAILY_BIAS_VERSION || Date.now() - cached.at > 15 * 60_000) {
      pending ??= loadDailyBias();
      try { cached = { at: Date.now(), report: await pending }; } finally { pending = undefined; }
    }
    return Response.json(cached.report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Daily bias research failed", error);
    return Response.json({ error: "Unable to load daily-bias candle research. Check server database connectivity." }, { status: 503 });
  }
}
