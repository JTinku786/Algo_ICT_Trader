"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import chapters from "../data/ict-core-chapters.json";
import { instruments } from "@/lib/daily-bias";

const DailyContextPanel = dynamic(() => import("./daily-context-panel"));
const TopDownAnalysis = dynamic(() => import("./top-down-analysis"));
export type CoreDestination = "daily-bias" | "reversal" | "strategy-builder" | "backtest" | "ml" | "live-orders";
type View = "Learn" | "Daily context" | "Top Down Analysis" | "Checklist" | "Research" | "Integration";
type Observation = { result: "UNKNOWN" | "OBSERVED" | "NOT_OBSERVED"; note: string };
const views: View[] = ["Learn", "Daily context", "Top Down Analysis", "Checklist", "Research", "Integration"];
const modules: { destination: CoreDestination; name: string; detail: string }[] = [
  { destination: "daily-bias", name: "Daily Bias", detail: "Inspect existing bias rules and daily outcomes." },
  { destination: "reversal", name: "Reversal", detail: "Inspect the existing reversal research and chart." },
  { destination: "strategy-builder", name: "Strategy Builder", detail: "Use the existing builder. Chapter rules have not been compiled into its strategy contract." },
  { destination: "backtest", name: "Backtest", detail: "Inspect existing strategy results. They are not chapter validation results." },
  { destination: "ml", name: "Machine Learning", detail: "Inspect existing models. Chapter-specific feature and label mapping is pending." },
  { destination: "live-orders", name: "Live Orders", detail: "Inspect existing order monitoring. This workspace creates no orders." },
];
const button = "rounded-lg border border-white/15 px-3 py-2 text-sm hover:border-amber-300/50 focus-visible:outline-2 focus-visible:outline-amber-300";

const sessionKey = "ict-core-study-v1";
function readSession() {
  const empty = { chapterId: chapters[0].id, symbol: "AAPL", visited: [] as string[], observations: {} as Record<string, Observation> };
  try {
    const stored = JSON.parse(sessionStorage.getItem(sessionKey) ?? "null");
    if (!stored || stored.version !== 1) return empty;
    const observations: Record<string, Observation> = {};
    if (stored.observations && typeof stored.observations === "object") {
      for (const [key, value] of Object.entries(stored.observations)) {
        const candidate = value as Partial<Observation> | null;
        if (candidate && ["UNKNOWN", "OBSERVED", "NOT_OBSERVED"].includes(candidate.result ?? "") && typeof candidate.note === "string" && chapters.some(c => c.questions.some((_, i) => key === `${c.id}:${i}`))) observations[key] = candidate as Observation;
      }
    }
    return { chapterId: chapters.some(c => c.id === stored.chapterId) ? stored.chapterId : empty.chapterId, symbol: instruments.some(i => i.name === stored.symbol) ? stored.symbol : empty.symbol, visited: Array.isArray(stored.visited) ? [...new Set<string>(stored.visited.filter((id: unknown) => typeof id === "string" && chapters.some(c => c.id === id)))] : [], observations };
  } catch { return empty; }
}

export default function IctCoreWorkspace({ onOpenModule }: { onOpenModule: (destination: CoreDestination) => void }) {
  const [session] = useState(readSession);
  const [chapterId, setChapterId] = useState<string>(session.chapterId);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("Learn");
  const [symbol, setSymbol] = useState<string>(session.symbol);
  const [observations, setObservations] = useState<Record<string, Observation>>(session.observations);
  const [visited, setVisited] = useState<string[]>(session.visited);
  const [exportError, setExportError] = useState("");
  useEffect(() => {
    try { sessionStorage.setItem(sessionKey, JSON.stringify({ version: 1, chapterId, symbol, observations, visited })); } catch { /* Export remains available when browser storage is disabled. */ }
  }, [chapterId, symbol, observations, visited]);
  const chapter = chapters.find(c => c.id === chapterId) ?? chapters[0];
  const index = chapters.findIndex(c => c.id === chapter.id);
  const filtered = chapters.filter(c => `${c.id} ${c.title} ${c.monthTitle}`.toLowerCase().includes(query.trim().toLowerCase()));

  function selectChapter(id: string) { setChapterId(id); setView("Learn"); }
  function updateObservation(key: string, update: Partial<Observation>) {
    setObservations(current => ({ ...current, [key]: { ...(current[key] ?? { result: "UNKNOWN", note: "" }), ...update } }));
  }
  function downloadNotes() {
    try {
      const payload = { version: "ict-core-observations-v1", exportedAt: new Date().toISOString(), chapter: chapter.id, symbol, source: { file: chapter.sourceFile, sha256: chapter.sourceHash, pages: chapter.pages }, observations: chapter.questions.map((question, i) => ({ question, ...(observations[`${chapter.id}:${i}`] ?? { result: "UNKNOWN", note: "" }) })), scope: "Manual study observations; not detector or strategy validation" };
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `${chapter.id}-${symbol}-observations.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setExportError("");
    } catch { setExportError("Could not export notes. Your observations remain in this session."); }
  }

  return <div className="space-y-5" data-ict-core-workspace>
    <header className="rounded-xl border border-amber-300/20 bg-amber-300/5 p-5">
      <p className="text-xs font-medium uppercase tracking-widest text-amber-300">ICT Core · Learn → Observe → Validate</p>
      <h1 className="mt-2 text-2xl font-semibold">One chapter. One clear chart. One testable idea.</h1>
      <p className="mt-2 max-w-3xl text-sm text-slate-300">12 months · 38 implementation chapters · 1,246 source pages. Original study notes connect the foundational material to the existing trading workspace.</p>
      <p className="mt-2 text-xs text-slate-400">Learning content is available. Rule validation and chapter-specific backtests remain pending. Chapter names organize our implementation; they are not an official source table of contents.</p>
    </header>
    <div className="grid gap-5 xl:grid-cols-[290px_minmax(0,1fr)]">
      <aside className="rounded-xl border border-white/10 p-3" aria-label="Core chapter navigation">
        <label className="text-xs text-slate-400" htmlFor="core-search">Find a chapter</label>
        <input id="core-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Liquidity, risk, day trading…" className="mt-1 w-full rounded-lg border border-white/15 bg-[#101722] p-2 text-sm" />
        <p className="my-3 text-xs text-slate-400">{filtered.length} chapters · {visited.length} marked studied</p>
        <div className="max-h-[650px] space-y-2 overflow-y-auto">
          {Array.from({ length: 12 }, (_, i) => i + 1).map(month => {
            const items = filtered.filter(c => c.month === month);
            return items.length ? <details key={month} open={month === chapter.month || query.trim().length > 0} className="rounded-lg border border-white/10 p-2">
              <summary className="cursor-pointer text-sm font-medium">{String(month).padStart(2, "0")} · {items[0].monthTitle}</summary>
              <div className="mt-2 space-y-1">{items.map(c => <button key={c.id} aria-current={c.id === chapter.id ? "page" : undefined} onClick={() => selectChapter(c.id)} className={`w-full rounded-md p-2 text-left text-xs ${c.id === chapter.id ? "bg-amber-300/15 text-amber-200" : "text-slate-300 hover:bg-white/5"}`}><span className="block text-[10px] text-slate-400">{c.id}{visited.includes(c.id) ? " · studied" : ""}</span>{c.title}</button>)}</div>
            </details> : null;
          })}
          {!filtered.length ? <p className="p-2 text-sm text-slate-400">No matching chapters. Try a different term.</p> : null}
        </div>
      </aside>
      <section className="min-w-0 space-y-4" aria-label="Selected chapter">
        <div className="rounded-xl border border-white/10 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-amber-300">{chapter.id} · Month {chapter.month}</span><span className="rounded-full bg-blue-400/10 px-3 py-1 text-xs text-blue-200">Learning available · detector unvalidated</span></div>
          <h2 className="mt-2 text-xl font-semibold">{chapter.title}</h2>
          <p className="mt-2 text-xs text-slate-400">Source: {chapter.sourceFile} · PDF pages {chapter.pages.join(", ")} (physical page numbers)</p>
          <nav className="mt-4 flex flex-wrap gap-2" aria-label="Chapter views">{views.map(v => <button key={v} aria-pressed={view === v} onClick={() => setView(v)} className={`${button} ${view === v ? "bg-amber-300/15 text-amber-200" : "text-slate-300"}`}>{v}</button>)}</nav>
        </div>
        {view === "Learn" ? <div className="space-y-4 rounded-xl border border-white/10 p-5">
          <h3 className="font-semibold">The idea in plain language</h3><p className="max-w-3xl leading-7 text-slate-300">{chapter.overview}</p>
          {chapter.id === "CC-M01-C01" ? <div className="grid gap-3 sm:grid-cols-2">{[["Consolidation", "Price stays within a reference range."], ["Expansion", "Price moves away from balance."], ["Retracement", "Price returns into a recent move."], ["Reversal", "Price changes the direction of that move."]].map(([name, explanation]) => <div key={name} className="rounded-lg border border-white/10 p-3"><strong className="text-amber-200">{name}</strong><p className="mt-1 text-sm text-slate-400">{explanation}</p></div>)}</div> : null}
          <h3 className="font-semibold">What to look for in replay</h3><ol className="list-decimal space-y-2 pl-5 text-sm text-slate-300">{chapter.questions.map(q => <li key={q}>{q}</li>)}</ol>
          <p className="text-xs text-slate-400">{chapter.month > 1 ? `Review Month ${chapter.month - 1} before this chapter. ` : "Start with the reference range and completed candles. "}Study observations below are our learning prompts, not a finalized source-derived entry checklist.</p>
          <div className="flex flex-wrap gap-2"><button className={button} onClick={() => setView("Top Down Analysis")}>Explore top down analysis</button><button className={button} aria-pressed={visited.includes(chapter.id)} onClick={() => setVisited(current => current.includes(chapter.id) ? current.filter(id => id !== chapter.id) : [...current, chapter.id])}>{visited.includes(chapter.id) ? "Unmark studied" : "Mark studied"}</button></div>
          <p className="text-xs text-slate-500">Study marks and notes stay in this browser tab when storage is available. Export a copy to keep them beyond the session.</p>
        </div> : null}
        {view === "Daily context" ? <DailyContextPanel symbol={symbol} onSymbolChange={setSymbol} /> : null}
        {view === "Top Down Analysis" ? <TopDownAnalysis symbol={symbol} onSymbolChange={setSymbol} /> : null}
        {view === "Checklist" ? <div className="space-y-4 rounded-xl border border-white/10 p-5">
          <h3 className="font-semibold">Record your observations</h3><p className="text-sm text-slate-400">These manual notes describe what you saw. They do not validate a detector or approve a trade. Include the symbol, date, timeframe and candle evidence in each note.</p>
          {chapter.questions.map((q, i) => { const key = `${chapter.id}:${i}`; const observation = observations[key]; return <fieldset key={key} className="space-y-2 rounded-lg border border-white/10 p-3"><legend className="px-1 text-sm">{q}</legend><label htmlFor={`${key}-result`} className="mr-2 text-xs text-slate-400">Observation</label><select id={`${key}-result`} className="rounded border border-white/15 bg-[#101722] p-2 text-xs" value={observation?.result ?? "UNKNOWN"} onChange={e => updateObservation(key, { result: e.target.value as Observation["result"] })}><option value="UNKNOWN">Unknown / not inspected</option><option value="OBSERVED">Observed</option><option value="NOT_OBSERVED">Not observed</option></select><label htmlFor={`${key}-note`} className="block text-xs text-slate-400">Candle evidence</label><textarea id={`${key}-note`} rows={2} value={observation?.note ?? ""} onChange={e => updateObservation(key, { note: e.target.value })} placeholder="AAPL · date · timeframe · observed prices and confirmation time" className="w-full rounded border border-white/15 bg-[#101722] p-2 text-sm" /></fieldset>; })}
          <button className={button} onClick={downloadNotes}>Export chapter observations</button>{exportError ? <p role="alert" className="text-red-300">{exportError}</p> : null}
        </div> : null}
        {view === "Research" ? <div className="space-y-4 rounded-xl border border-white/10 p-5">
          <h3 className="font-semibold">From observation to reproducible evidence</h3><p className="text-sm text-slate-300">Chapter-specific research has not run. Existing performance belongs to the existing strategy version; it cannot establish that this chapter is correct.</p>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-300"><li>Finalize source conditions and identify local adaptations.</li><li>Check native data coverage, session boundaries and known-at timing.</li><li>Keep positive, negative, neutral and missing-data examples.</li><li>Version the strategy, fill policy, costs, stops and targets.</li><li>Evaluate net results on a time-separated holdout and inspect failed cases.</li></ol>
          <button className={button} onClick={() => onOpenModule("backtest")}>Open existing Backtest</button>
        </div> : null}
        {view === "Integration" ? <div className="space-y-4 rounded-xl border border-white/10 p-5">
          <h3 className="font-semibold">Connect to the existing workspace</h3><div className="grid gap-3 md:grid-cols-2">{modules.map(m => <div key={m.destination} className="rounded-lg border border-white/10 p-3"><h4 className="font-medium">{m.name}</h4><p className="my-2 text-xs leading-5 text-slate-400">{m.detail}</p><button className={button} onClick={() => onOpenModule(m.destination)}>Open {m.name}</button></div>)}</div>
          <dl className="grid gap-2 text-xs sm:grid-cols-2"><div><dt className="text-slate-400">Learning notes</dt><dd>Available · original overview</dd></div><div><dt className="text-slate-400">Replay</dt><dd>Shared candle replay · local candidate rules</dd></div><div><dt className="text-slate-400">Detector</dt><dd>{chapter.detectorStatus}</dd></div><div><dt className="text-slate-400">Chapter backtest</dt><dd>{chapter.backtestStatus}</dd></div><div><dt className="text-slate-400">Paper / live integration</dt><dd>Not connected to this chapter</dd></div></dl>
        </div> : null}
        <footer className="flex items-center justify-between gap-3"><button className={button} disabled={index === 0} onClick={() => selectChapter(chapters[index - 1].id)}>Previous chapter</button><span className="text-xs text-slate-400">{index + 1} of {chapters.length}</span><button className={button} disabled={index === chapters.length - 1} onClick={() => selectChapter(chapters[index + 1].id)}>Next chapter</button></footer>
        <details className="rounded-lg border border-white/10 p-3 text-xs text-slate-400"><summary className="cursor-pointer">Source provenance and review status</summary><p className="mt-2">{chapter.sourceReview}. Full diagram and condition review precedes any validated detector.</p><p className="mt-2 break-all">SHA-256: {chapter.sourceHash}</p></details>
      </section>
    </div>
  </div>;
}
