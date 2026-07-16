import { SlackChartClient } from "./slack-chart-client";

export const dynamic = "force-dynamic";

export default async function SlackChartPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const signalHash = String(params.signal_hash || "").trim();
  const ticker = String(params.ticker || "S03").trim();

  return (
    <main className="min-h-screen bg-[#0b0f16] p-4 text-white">
      <section className="overflow-hidden rounded-xl border border-amber-400/25 bg-[#0d111a]">
        <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <div>
            <h1 className="font-semibold">S03 ICT Breaker Execution Chart · {ticker}</h1>
            <p className="text-xs text-[#7f8ca3]">Entry, risk, targets and ICT evidence from Algo ICT Trader</p>
          </div>
          <span className="ml-auto rounded border border-amber-400/25 bg-amber-400/10 px-2 py-1 font-mono text-xs text-amber-300">S03</span>
        </header>
        {signalHash ? (
          <SlackChartClient signalHash={signalHash} ticker={ticker} />
        ) : (
          <div className="grid h-[650px] place-items-center text-sm text-rose-300">signal_hash is required</div>
        )}
      </section>
    </main>
  );
}
