"use client";

import { useEffect, useState } from "react";
import { OrderChart, type OrderChartResponse } from "./order-chart";
import { DailyForwardChart } from "./daily-forward-chart";
import { MssLinkBar } from "./mss-link-bar";
import { SmtLinkBar } from "./smt-link-bar";
import type { ReversalFilters, ReversalRow } from "@/lib/reversals-updated";

type Bar = {t: number; o: number; h: number; l: number; c: number};

export default function ReversalResultCharts({row, filters, runId, onClose}: {
  row: ReversalRow; filters: ReversalFilters; runId: string | null; onClose: () => void;
}) {
  const symbol = row.ticker.replace(/^\^/, "");
  const skipped = /skip|reject|cancel/i.test(row.state);
  const at = row.fill_at ?? row.decision_at ?? row.entry_at;
  const [snapshot, setSnapshot] = useState<OrderChartResponse | null>(null);
  const [error, setError] = useState("");
  const history = filters.lane === "history";
  useEffect(() => {
    if (history) return;
    const controller = new AbortController();
    const params = new URLSearchParams({symbol, entry_ts:at, tf:"5m", before:"120", after:"60"});
    fetch(`/api/reversal/daily-forward?${params}`, {cache:"no-store", signal:controller.signal})
      .then(async response => {
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.error ?? "Execution candles unavailable.");
        const candles = (payload.bars as Bar[]).map(b => ({time:b.t/1000,open:b.o,high:b.h,low:b.l,close:b.c}));
        if (!candles.length) throw new Error("No stored 5m candles for this decision.");
        setSnapshot({success:true,timeframe:"5m",candles,
          order:{order_id:row.id,symbol,market:filters.market,direction:row.direction,
            entry_price:skipped?null:row.entry,filled_price:row.fill_at && !skipped?row.entry:null,
            stoploss:row.stop,tp1:row.target,tp2:null,tp3:null,filled_at:row.fill_at,
            close_ts:row.exit_at,close_price:row.exit_price,close_reason:row.reason,realized_r:row.r,outcome:row.state},
          markers:{entry:{time:Date.parse(at)/1000,price:skipped?null:row.entry},exit:{time:row.exit_at?Date.parse(row.exit_at)/1000:0,price:row.exit_price,outcome:row.state}},
        });
      })
      .catch(error => {if (!controller.signal.aborted) setError(error instanceof Error?error.message:"Unable to load execution candles.");});
    return () => controller.abort();
  }, [history,symbol,at,row,filters.market,skipped]);
  const trade = {symbol:row.ticker,market:filters.market,direction:row.direction,entryTs:at};
  return <section className="my-5 space-y-3" aria-label="Reversal execution and HTF charts">
    <MssLinkBar trade={trade} note={skipped?"Skipped decision context · no fill":"Reversal result"} />
    <SmtLinkBar trade={trade} smtText="Open peer investigation; SMT at decision not verified here" />
    {skipped && <p className="rounded border border-amber-300/25 p-3 text-xs text-amber-200">Skipped decision context. The chart is anchored to the recorded decision; no executed entry is claimed.</p>}
    <div className="grid items-start gap-4 2xl:grid-cols-2">
      <div className="min-w-0 rounded-lg border border-white/10 p-3">
        <h3 className="mb-3 text-sm font-semibold">ICT execution / decision chart · {symbol}</h3>
        {history && runId ? <OrderChart order={{order_id:row.id,symbol:row.ticker,direction:row.direction,r:row.r}} targetNo="1" endpoint={`/api/reversal/order-chart?run=${encodeURIComponent(runId)}`} identifierParam="trade_id" identifier={row.id} showSimilarTrades={false} onClose={onClose} />
          : error ? <p role="status" className="p-5 text-sm text-amber-200">{error}</p>
          : snapshot ? <OrderChart order={{order_id:row.id,symbol:row.ticker,direction:row.direction,r:row.r}} targetNo="1" endpoint="" snapshot={snapshot} showSimilarTrades={false} onClose={onClose} />
          : <p role="status" className="p-5 text-sm text-slate-400">Loading stored execution candles…</p>}
        {!history && <p className="mt-2 text-xs text-slate-500">Stored 5m candle context. Enable VI / BISI / SIBI, swing liquidity and previous-period overlays in the chart toolbar. These derived studies do not certify the original setup.</p>}
      </div>
      <div className="min-w-0 rounded-lg border border-white/10 p-3">
        <h3 className="mb-3 text-sm font-semibold">HTF ICT · Daily / 1H / 30m / 15m · ±20 / 40 / 60 bars</h3>
        <DailyForwardChart endpoint="/api/reversal/daily-forward" initialTf={filters.tf} plotEvidence={false} evidence={{labels:[],notes:[]}} trade={{symbol,direction:row.direction,entryTs:at,fill:skipped?null:row.entry,stop:row.stop,target:row.target,exitTs:row.exit_at,exitPrice:row.exit_price,exitLabel:row.exit_at?row.state:null}} />
      </div>
    </div>
  </section>;
}
