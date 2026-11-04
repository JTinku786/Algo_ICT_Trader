"use client";

import { Bot, History, RefreshCw, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

type SimilarTrade = {
  order_id: string;
  signal_hash: string;
  symbol: string;
  market: string;
  direction: string;
  strategy_id: string;
  entry_datetime: string | null;
  close_ts: string | null;
  close_reason: string;
  realized_r: number | null;
  similarity_score: number;
  matched_features: string[];
};

type SimilarTradesResponse = {
  success: boolean;
  error?: string;
  current?: { ticker: string; market: string; strategy_id: string; direction: string; entry_datetime: string | null };
  methodology?: string;
  summary?: {
    sample_size: number;
    closed_count: number;
    win_rate_pct: number | null;
    average_realized_r: number | null;
    average_similarity_pct: number | null;
    strongest_matches: string[];
    evidence_readout: string;
  };
  trades?: SimilarTrade[];
};

function fmtR(value: number | null) {
  return value === null || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`;
}

function localDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("en-CA");
}

function outcomeClass(value: number | null) {
  if (value === null) return "text-slate-400";
  return value > 0 ? "text-emerald-300" : value < 0 ? "text-rose-300" : "text-amber-200";
}

export function SimilarTrades({ source, identifierParam, identifier }: { source: "realtime" | "backtest"; identifierParam: "order_id" | "signal_hash"; identifier: string }) {
  const [result, setResult] = useState<{ url: string; payload: SimilarTradesResponse } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [explanation, setExplanation] = useState("");
  const [explaining, setExplaining] = useState(false);

  const url = useMemo(() => `/api/similar-trades?source=${source}&identifier_param=${identifierParam}&identifier=${encodeURIComponent(identifier)}`, [source, identifierParam, identifier]);
  // Computed only on the Refresh click (it is slow); a different trade clears the previous result.
  const data = result?.url === url ? result.payload : null;
  const load = () => {
    setLoading(true);
    setError("");
    setExplanation("");
    fetch(url, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: SimilarTradesResponse) => {
        if (!payload.success) throw new Error(payload.error || "Unable to load similar trades");
        setResult({ url, payload });
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to load similar trades"))
      .finally(() => setLoading(false));
  };

  const askTitania = async () => {
    if (!data?.summary || explaining) return;
    setExplaining(true);
    setExplanation("");
    const top = (data.trades ?? []).slice(0, 5).map((trade) => ({
      symbol: trade.symbol, date: trade.entry_datetime, match_pct: trade.similarity_score,
      matched_features: trade.matched_features, realized_r: trade.realized_r, close_reason: trade.close_reason,
    }));
    const prompt = [
      "Explain this verified historical-similarity evidence in plain English.",
      "Do not give a buy/sell recommendation, entry, stop, target, position size, or prediction. Do not invent data.",
      `Current setup: ${data.current?.strategy_id} ${data.current?.direction} on ${data.current?.ticker} (${data.current?.market}).`,
      `Evidence: ${JSON.stringify(data.summary)}. Top deterministic matches: ${JSON.stringify(top)}.`,
      "State sample-size limits and describe only the observed historical pattern.",
    ].join("\n");
    try {
      const response = await fetch("/api/assistant/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: prompt, stream: false, context: { current_tab: "realtime-orders" } }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.answer) throw new Error(payload.detail || "Titania is unavailable");
      setExplanation(String(payload.answer));
    } catch (reason) {
      setExplanation(`Titania explanation is unavailable: ${reason instanceof Error ? reason.message : "unknown error"}`);
    } finally {
      setExplaining(false);
    }
  };

  return (
    <section className="mt-3 overflow-hidden rounded-lg border border-cyan-400/20 bg-[#0b1020]">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2.5">
        <History className="size-4 text-cyan-300" />
        <div>
          <h3 className="text-sm font-semibold text-white">Similar historical trades</h3>
          <p className="text-[10px] text-[#7f8ca3]">Newest 30 completed trades for this strategy, ranked deterministically by timeframe and persisted ICT evidence.</p>
        </div>
        <button onClick={load} disabled={loading} className="ml-auto grid size-7 place-items-center rounded border border-white/10 text-[#93a1b6] hover:text-white disabled:opacity-40" title={data ? "Refresh similar trades" : "Load similar trades"}><RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} /></button>
      </div>

      {loading ? <div className="px-3 py-5 text-xs text-[#93a1b6]">Matching the latest 30 completed setups…</div> : null}
      {!loading && !error && !data ? <button type="button" onClick={load} className="w-full px-3 py-5 text-left text-xs text-[#93a1b6] hover:text-white">Not loaded - click refresh <RefreshCw className="inline size-3" /> to match similar trades.</button> : null}
      {error ? <div className="px-3 py-5 text-xs text-rose-300">{error}</div> : null}
      {!loading && !error && data?.summary ? <>
        <div className="grid grid-cols-2 gap-px border-b border-white/10 bg-white/5 sm:grid-cols-5">
          <Metric label="Reference set" value={`${data.summary.sample_size} trades`} />
          <Metric label="Closed outcomes" value={String(data.summary.closed_count)} />
          <Metric label="Positive rate" value={data.summary.win_rate_pct === null ? "—" : `${data.summary.win_rate_pct.toFixed(1)}%`} />
          <Metric label="Average outcome" value={fmtR(data.summary.average_realized_r)} tone={outcomeClass(data.summary.average_realized_r)} />
          <Metric label="Average match" value={data.summary.average_similarity_pct === null ? "—" : `${data.summary.average_similarity_pct}%`} />
        </div>
        <div className="border-b border-white/10 px-3 py-2.5 text-xs text-[#b9c4d6]">
          <span className="font-semibold text-cyan-200">Evidence readout: </span>{data.summary.evidence_readout}
          {data.summary.strongest_matches.length ? <span className="text-[#7f8ca3]"> Highest-ranked overlap: {data.summary.strongest_matches.join(", ")}.</span> : null}
        </div>
        <div className="max-h-80 overflow-auto">
          <table className="w-full min-w-[720px] text-left text-[11px]">
            <thead className="sticky top-0 bg-[#11182a] text-[10px] uppercase tracking-wide text-[#7f8ca3]"><tr><th className="px-3 py-2">Match</th><th className="px-3 py-2">Trade</th><th className="px-3 py-2">Entry</th><th className="px-3 py-2">Outcome</th><th className="px-3 py-2">Matched ICT evidence</th></tr></thead>
            <tbody className="divide-y divide-white/5">{(data.trades ?? []).map((trade) => <tr key={trade.order_id} className="hover:bg-cyan-400/[0.04]"><td className="px-3 py-2 font-mono font-bold text-cyan-200">{trade.similarity_score}%</td><td className="px-3 py-2"><div className="font-mono font-semibold text-white">{trade.symbol}</div><div className="text-[10px] text-[#657187]">{trade.market} · {trade.direction}</div></td><td className="px-3 py-2 font-mono text-[#b9c4d6]">{localDate(trade.entry_datetime)}</td><td className={`px-3 py-2 font-mono font-semibold ${outcomeClass(trade.realized_r)}`}>{fmtR(trade.realized_r)}<div className="text-[10px] font-normal text-[#657187]">{trade.close_reason.replaceAll("_", " ")}</div></td><td className="max-w-80 px-3 py-2 text-[#93a1b6]">{trade.matched_features.length ? trade.matched_features.join(" · ") : "Partial persisted-context match"}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="border-t border-white/10 px-3 py-2.5">
          <button onClick={askTitania} disabled={explaining} className="inline-flex items-center gap-1.5 rounded border border-violet-400/30 bg-violet-400/10 px-2.5 py-1.5 text-xs font-semibold text-violet-200 hover:bg-violet-400/20 disabled:opacity-50"><Bot className="size-3.5" />{explaining ? "Titania is reading the evidence…" : "Ask Titania to explain evidence"}<Sparkles className="size-3" /></button>
          {explanation ? <p className="mt-2 whitespace-pre-wrap rounded bg-black/20 p-2.5 text-xs leading-5 text-[#cbd5e1]">{explanation}</p> : null}
          <p className="mt-2 text-[10px] text-[#657187]">Similarity and outcome metrics are deterministic. Titania receives the fixed evidence only and cannot change the ranking or create a trade plan.</p>
        </div>
      </> : null}
    </section>
  );
}

function Metric({ label, value, tone = "text-white" }: { label: string; value: string; tone?: string }) {
  return <div className="bg-[#0b1020] px-3 py-2.5"><div className="text-[9px] uppercase tracking-[0.12em] text-[#657187]">{label}</div><div className={`mt-1 font-mono text-sm font-bold ${tone}`}>{value}</div></div>;
}
