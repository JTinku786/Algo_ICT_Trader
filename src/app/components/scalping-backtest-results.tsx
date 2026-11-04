"use client";



import { useEffect, useMemo, useState } from "react";

import type { BacktestFilters, BacktestResults, BacktestTrade, PairedRRReport } from "@/lib/scalping-backtest-results";



const buckets = ["0-1", "1-2", "2-3", "3-4", "4+"];

const initial: BacktestFilters = { markets: [], symbols: [], years: [], buckets, side: "ALL", confirmation: "ALL", page: 1 };

const control = "rounded border border-white/15 bg-slate-900 px-3 py-2 text-sm";

const panel = "rounded-xl border border-white/10 bg-slate-950/30 p-4";

const f = (n: number | null | undefined, digits = 2) => n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });

const r = (n: number | null | undefined) => n == null ? "—" : `${n >= 0 ? "+" : ""}${f(n)}R`;

const tone = (n: number | null) => n == null ? "text-slate-400" : n >= 0 ? "text-emerald-300" : "text-rose-300";

const label = (kind: string) => ({ VALID_FVG: "Valid FVG", OB: "Order block", IFVG: "IFVG", BREAKER: "Breaker", BPR: "BPR", BSL: "Buyside liquidity", SSL: "Sellside liquidity", SWINGS: "Swing high / low", PDH: "Previous day high", PDL: "Previous day low" })[kind as "OB"] ?? kind;

const date = (at: number | null) => at == null ? "Open" : new Date(at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

type ValidationStats = { closed: number; open: number; netR: number; expectancyR: number | null; profitFactor: number | null; maxDrawdownR: number; winRate: number | null };

type ValidationChoice = { tf1Kind: string; tf2Kind: string; confirmation: string; rrBucket: string; train: ValidationStats; holdout: ValidationStats; holdoutCostSensitivity: Record<string, ValidationStats> };

type Validation = { status?: string; recommendationsByMarket?: { market: string; selectedOn: string; choice: ValidationChoice | null; verdict: string }[]; walkForward?: { year: number; market: string; selectedPair: Pick<ValidationChoice, "tf1Kind" | "tf2Kind" | "confirmation" | "rrBucket">; training: ValidationStats; test: ValidationStats; testCostSensitivity: Record<string, ValidationStats> }[] };



function ValidationPanel({ report }: { report: Record<string, unknown> }) {

  const validation = report as Validation;

  return <section className={panel}><h3 className="font-semibold">Training-selected rules · holdout and walk-forward</h3><p className="mt-2 text-sm text-slate-400">These full-run choices use only pre-2024 closed outcomes for selection. The 2024 onward holdout tests the fixed choice; each walk-forward year selects from outcomes closed before that year. Current display filters do not alter these saved validations.</p>{validation.status?.toUpperCase() !== "COMPLETE" ? <p className="mt-2 text-sm text-amber-200">Validation is provisional until the full historical run completes.</p> : null}<div className="mt-4 grid gap-4 md:grid-cols-2">{validation.recommendationsByMarket?.map(item => <article key={item.market} className="rounded border border-white/10 p-4"><p className="text-xs uppercase tracking-widest text-amber-300">{item.market}</p><p className="mt-2 font-semibold">{item.choice ? `${label(item.choice.tf1Kind)} → ${label(item.choice.tf2Kind)} · ${item.choice.confirmation} · R:R ${item.choice.rrBucket}` : item.verdict === "RUN_INCOMPLETE" ? "Waiting for the complete historical run" : "Insufficient training sample"}</p><p className={`mt-2 text-xs ${item.verdict === "HOLDOUT_POSITIVE" ? "text-emerald-300" : "text-amber-300"}`}>{item.verdict.replaceAll("_", " ")}</p><p className="mt-2 text-xs text-slate-400">{item.selectedOn}</p>{item.choice ? <div className="mt-3 grid grid-cols-2 gap-2 text-sm"><span>Training n={item.choice.train.closed}</span><span>Exp. {r(item.choice.train.expectancyR)}</span><span>Holdout n={item.choice.holdout.closed}</span><span>Exp. {r(item.choice.holdout.expectancyR)}</span><span>Gross holdout</span><span className={tone(item.choice.holdout.netR)}>{r(item.choice.holdout.netR)}</span><span>2 bps holdout</span><span className={tone(item.choice.holdoutCostSensitivity?.["2"]?.netR ?? null)}>{r(item.choice.holdoutCostSensitivity?.["2"]?.netR)}</span><span>Holdout monthly DD</span><span>{f(item.choice.holdout.maxDrawdownR)}R</span></div> : null}</article>)}</div><p className="mt-3 text-xs text-slate-400">A positive holdout supports further validation; it does not establish a perfect R:R or authorize deployment. Pair attribution overlaps; no portfolio sizing is simulated.</p>{validation.walkForward?.length ? <div className="mt-4 max-h-80 overflow-auto"><table className="w-full whitespace-nowrap text-sm"><thead className="text-left text-xs text-slate-400"><tr>{["Test year", "Market", "Selected TF1 → TF2", "Confirm", "Bucket", "Train n", "Test n", "Gross test R", "2 bps test R", "Test monthly DD"].map(h => <th className="pb-3 pr-4" key={h}>{h}</th>)}</tr></thead><tbody>{validation.walkForward.map(row => <tr key={`${row.year}:${row.market}`} className="border-t border-white/10"><td className="py-2">{row.year}</td><td>{row.market}</td><td className="pr-4">{label(row.selectedPair.tf1Kind)} → {label(row.selectedPair.tf2Kind)}</td><td>{row.selectedPair.confirmation}</td><td>{row.selectedPair.rrBucket}</td><td>{row.training.closed}</td><td>{row.test.closed}</td><td className={tone(row.test.netR)}>{r(row.test.netR)}</td><td className={tone(row.testCostSensitivity?.["2"]?.netR ?? null)}>{r(row.testCostSensitivity?.["2"]?.netR)}</td><td>{f(row.test.maxDrawdownR)}R</td></tr>)}</tbody></table></div> : null}<details className="mt-4"><summary className="cursor-pointer text-xs text-slate-400">Validation evidence JSON</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap text-xs text-slate-300">{JSON.stringify(report, null, 2)}</pre></details></section>;

}



function PairedRRPanel({ report, provisional }: { report: PairedRRReport; provisional: boolean }) {

  const families = report.commonFamilies?.filter(row => row.scope === "MARKET") ?? [];

  const rows = report.bucketResults?.filter(row => row.scope === "MARKET") ?? [];

  return <section className={panel}>

    <h3 className="font-semibold">Same-entry R:R comparison</h3>
    {provisional ? <p className="mt-2 text-sm text-amber-200">Saved partial-run audit; remaining years and tickers are pending. No final comparison is available yet.</p> : null}

    <p className="mt-2 text-sm text-slate-400">Each comparison uses the same entry and stop with a target available in all five buckets, and requires every outcome to be closed. Training also requires every exit before {report.holdoutStart ?? "2024-01-01"}. Current display filters do not alter this saved audit.</p>

    {!report.comparisonAvailable ? <p className="mt-3 text-sm text-amber-200">{report.reason ?? "No comparable closed entry families are available."}</p> : null}

    <div className="mt-3 flex flex-wrap gap-3">{families.map(row => <div key={`${row.market}:${row.period}`} className="rounded border border-white/10 p-3 text-xs"><p className="font-semibold">{row.market} · {row.period}</p><p className="mt-1">{row.comparableClosed.toLocaleString()} comparable / {row.eligible.toLocaleString()} eligible</p><p className="mt-1 text-slate-400">{row.unresolved.toLocaleString()} unresolved · {row.trainingBoundaryExcluded.toLocaleString()} training-boundary exclusions</p></div>)}</div>

    {rows.length ? <div className="mt-4 overflow-auto"><table className="w-full whitespace-nowrap text-sm"><thead className="text-left text-xs text-slate-400"><tr>{["Market", "Period", "Bucket", "Closed", "Gross R", "Mean R", "2 bps R", "Mean difference vs 0–1"].map(h => <th key={h} className="pb-3 pr-4">{h}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={`${row.market}:${row.period}:${row.rrBucket}`} className="border-t border-white/10"><td className="py-2 pr-4">{row.market}</td><td className="pr-4">{row.period}</td><td>{row.rrBucket}</td><td>{row.closed.toLocaleString()}</td><td className={tone(row.netR)}>{r(row.netR)}</td><td className={tone(row.expectancyR)}>{r(row.expectancyR)}</td><td className={tone(row.costSensitivityNetR?.["2"] ?? null)}>{r(row.costSensitivityNetR?.["2"])}</td><td className={tone(row.pairedMeanDeltaVs0To1)}>{r(row.pairedMeanDeltaVs0To1)}</td></tr>)}</tbody></table></div> : null}

    <p className="mt-3 text-xs text-slate-400">Descriptive comparison only; this does not select a winning bucket. Excluding unresolved families can favor faster outcomes. Independent bucket scenarios do not add to a portfolio.</p>

  </section>;

}



function MultiFilter({ name, options, values, onChange }: { name: string; options: string[]; values: string[]; onChange: (values: string[]) => void }) {

  const [search, setSearch] = useState("");
  const selected = values.length ? values.filter(v => options.includes(v)) : options;
  return <details className="relative min-w-36"><summary className={`${control} cursor-pointer`}>{name} · {!values.length ? "All" : selected.length ? selected.length <= 2 ? selected.join(", ") : `${selected.length} selected` : "None"}</summary><div className="absolute z-20 mt-1 max-h-72 min-w-full overflow-auto rounded border border-white/20 bg-slate-950 p-3 shadow-xl"><div className="mb-2 flex gap-4"><button className="text-xs text-sky-300 underline" onClick={() => onChange([])}>Select all</button><button className="text-xs text-sky-300 underline" onClick={() => onChange(["__NONE__"])}>Clear</button></div><input aria-label={`Search ${name}`} className="mb-2 w-full rounded border border-white/15 bg-slate-900 p-2 text-sm" placeholder={`Search ${name.toLowerCase()}`} value={search} onChange={e => setSearch(e.target.value)} />{options.filter(value => value.toLowerCase().includes(search.toLowerCase())).map(value => <div key={value} className="flex items-center justify-between gap-4"><label className="flex cursor-pointer items-center gap-2 whitespace-nowrap py-1 text-sm"><input type="checkbox" checked={selected.includes(value)} onChange={e => { const next = e.target.checked ? [...selected, value] : selected.filter(x => x !== value); onChange(next.length ? next : ["__NONE__"]); }} />{value}</label><button aria-label={`Only ${value}`} className="text-xs text-sky-300" onClick={() => onChange([value])}>Only</button></div>)}</div></details>;

}



function Equity({ data }: { data: BacktestResults["equity"] }) {

  const colors = ["#fbbf24", "#38bdf8", "#34d399", "#c084fc", "#fb7185"];

  const months = [...new Set(data.map(p => p.month))].sort();

  if (!months.length) return <p className="py-8 text-sm text-slate-400">No closed outcomes for these filters.</p>;

  const values = [0, ...data.map(p => p.cumulativeR)], min = Math.min(...values), max = Math.max(...values), span = max - min || 1;

  const x = (month: string) => 56 + 870 * months.indexOf(month) / Math.max(1, months.length - 1), y = (n: number) => 218 - (n - min) / span * 185;

  return <><svg viewBox="0 0 960 255" role="img" aria-label="Cumulative closed gross R for each independent R:R bucket" className="mt-3 w-full"><line x1="56" x2="930" y1={y(0)} y2={y(0)} stroke="#475569" strokeDasharray="4 4" />{[min, max].map((n, i) => <text key={i} x="4" y={y(n) + 4} fill="#94a3b8" fontSize="12">{f(n, 0)}R</text>)}{buckets.map((bucket, i) => <polyline key={bucket} fill="none" stroke={colors[i]} strokeWidth="2" points={data.filter(p => p.bucket === bucket).map(p => `${x(p.month)},${y(p.cumulativeR)}`).join(" ")} />)}<text x="56" y="247" fill="#94a3b8" fontSize="12">{months[0]}</text><text x="874" y="247" fill="#94a3b8" fontSize="12">{months.at(-1)}</text></svg><div className="flex flex-wrap gap-4 text-xs">{buckets.filter(bucket => data.some(p => p.bucket === bucket)).map(bucket => <span key={bucket} style={{ color: colors[buckets.indexOf(bucket)] }}>R:R {bucket}</span>)}</div></>;

}



export default function ScalpingBacktestResults({ onInspect }: { onInspect?: (trade: BacktestTrade) => void }) {

  const [draft, setDraft] = useState(initial), [applied, setApplied] = useState(initial), [refresh, setRefresh] = useState(0);

  const [state, setState] = useState<{ data?: BacktestResults; error?: string; loading: boolean }>({ loading: true });

  const [heatBucket, setHeatBucket] = useState("1-2"), [heatMode, setHeatMode] = useState<"expectancy" | "grossR" | "closed">("expectancy");

  useEffect(() => {

    const abort = new AbortController();

    const q = new URLSearchParams({ markets: applied.markets.join(","), symbols: applied.symbols.join(","), years: applied.years.join(","), buckets: applied.buckets.join(","), side: applied.side, confirmation: applied.confirmation, tf1: applied.tf1 ?? "", tf2: applied.tf2 ?? "", page: String(applied.page) });

    fetch(`/api/scalping-labs/backtest?${q}`, { signal: abort.signal, cache: "no-store" }).then(async response => {
      if (!response.headers.get("content-type")?.includes("application/json")) {
        throw new Error(response.status === 404
          ? "The backtest results service is unavailable. Restart the website server, then refresh results."
          : `Backtest results unavailable (HTTP ${response.status}). Please retry shortly.`);
      }
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Backtest results unavailable.");
      return body as BacktestResults;
    }).then(data => setState({ data, loading: false })).catch(error => { if (!abort.signal.aborted) setState({ error: error.message, loading: false }); });

    return () => abort.abort();

  }, [applied, refresh]);

  const data = state.data;
  const pending = JSON.stringify({ ...draft, page: 1 }) !== JSON.stringify({ ...applied, page: 1 });
  const selectedBuckets = data?.filters.buckets.length ? data.filters.buckets : buckets;
  const activeHeatBucket = selectedBuckets.includes(heatBucket) ? heatBucket : selectedBuckets[0];
  const matchingAttributions = (trade: BacktestTrade) => (trade.attributions ?? []).filter(a => (!applied.tf1 || a.tf1Kind === applied.tf1) && (!applied.tf2 || a.tf2Kind === applied.tf2) && (applied.confirmation === "ALL" || a.confirmation === applied.confirmation));

  const heat = useMemo(() => {

    const groups = new Map<string, { grossR: number; closed: number }>();

    for (const c of data?.heatmapCells ?? []) { if (c.bucket !== activeHeatBucket) continue; const key = `${c.tf1}|${c.tf2}`, previous = groups.get(key) ?? { grossR: 0, closed: 0 }; previous.grossR += c.grossR; previous.closed += c.closed; groups.set(key, previous); }

    return { groups, tf1: [...new Set([...groups.keys()].map(k => k.split("|")[0]))].sort(), tf2: [...new Set([...groups.keys()].map(k => k.split("|")[1]))].sort() };

  }, [data, activeHeatBucket]);

  const patch = (value: Partial<BacktestFilters>) => setDraft(old => ({ ...old, ...value }));

  const apply = (value = { ...draft, page: 1 }) => { setState({ loading: true }); setApplied(value); };

  const status = String(data?.summary.status ?? "pending");

  return <section aria-label="Scalping Labs historical backtest results" className="space-y-5">

    <header className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-widest text-amber-300">Historical research · US + Forex + India (NSE)</p><h2 className="mt-1 text-2xl font-semibold">Historical backtest results</h2><p className="mt-2 max-w-4xl text-sm text-slate-400">TF1 1 Hour → TF2 5 Minutes · five-candle TF1 touch rule · MSS / CISD confirmation · hold until stop or liquidity target. Entries unresolved at the latest stored candle stay open. Valid FVG is the directional premium / discount filter on FVG; qualifying FVG rows are labelled Valid FVG.</p></div><button className={control} disabled={state.loading} onClick={() => { setState(old => ({ ...old, loading: true })); setRefresh(old => old + 1); }}>Refresh results</button></header>

    {state.loading ? <p role="status" className="text-sm text-sky-300">Reading historical results…</p> : null}

    {state.error ? <p role="alert" className={`${panel} text-amber-200`}>{state.error}</p> : null}

    {data ? <>

      <div className={`${panel} text-sm`}><div className="flex flex-wrap items-center gap-x-5 gap-y-2"><span className={status.toUpperCase() === "COMPLETE" ? "text-emerald-300" : "text-amber-300"}>Run status: {status}</span><span>{String(data.summary.counts?.completed ?? data.options.symbols.length)} / {String(data.summary.counts?.instruments ?? data.options.symbols.length)} completed tickers · {data.availableFiles} indexed entry-window files</span><span>Indexed entry years {data.options.years[0] ?? "—"}–{data.options.years.at(-1) ?? "—"}</span><span>Requested {String(data.summary.selection?.start ?? "2017-01-01")}–{String(data.summary.selection?.end ?? "latest available")}</span>{data.summary.generatedAt ? <span className="text-slate-400">Updated {data.summary.generatedAt}</span> : null}</div>{status.toUpperCase() === "RUNNING" ? <p className="mt-2 text-amber-200">Results are provisional while workers finish. Missing years or tickers do not mean zero trades.</p> : null}{data.missingFiles || data.malformed ? <p className="mt-2 text-rose-300">{data.missingFiles} entry-window files not yet indexed · {data.malformed} unreadable rows. Metrics cover the indexed snapshot.</p> : null}{data.summary.errors?.length ? <p className="mt-2 text-rose-300">{data.summary.errors.length} recorded worker errors; see coverage and run diagnostics below.</p> : null}</div>

      <div className={`${panel} space-y-4`}><div className="flex flex-wrap gap-3"><MultiFilter name="Market" options={data.options.markets} values={draft.markets} onChange={markets => patch({ markets })} /><MultiFilter name="Ticker" options={data.options.symbols} values={draft.symbols} onChange={symbols => patch({ symbols })} /><MultiFilter name="Entry year" options={data.options.years} values={draft.years} onChange={years => patch({ years })} /><label className="flex items-center gap-2 text-sm">Side<select className={control} value={draft.side} onChange={e => patch({ side: e.target.value })}>{["ALL", "BUY", "SELL"].map(side => <option key={side}>{side}</option>)}</select></label><label className="flex items-center gap-2 text-sm">Confirmation<select className={control} value={draft.confirmation} onChange={e => patch({ confirmation: e.target.value })}>{["ALL", ...data.options.confirmations].map(c => <option key={c}>{c}</option>)}</select></label></div><div className="flex flex-wrap items-center gap-4 text-sm"><label>TF1 context <select aria-label="Historical TF1 context" className={control} value={draft.tf1 ?? ""} onChange={e => patch({ tf1: e.target.value })}><option value="">All</option>{["PDL","PDH","BSL","SSL","SWINGS","BPR","OB","VALID_FVG","IFVG","BREAKER"].map(k => <option key={k} value={k}>{label(k)}</option>)}</select></label><label>TF2 array <select aria-label="Historical TF2 array" className={control} value={draft.tf2 ?? ""} onChange={e => patch({ tf2: e.target.value })}><option value="">All</option>{["OB","BPR","BREAKER","IFVG","VALID_FVG"].map(k => <option key={k} value={k}>{label(k)}</option>)}</select></label></div><div className="flex flex-wrap items-center gap-4 text-sm"><span>R:R buckets</span>{buckets.map(bucket => <label key={bucket} className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={draft.buckets.includes(bucket)} onChange={e => patch({ buckets: e.target.checked ? [...draft.buckets, bucket] : draft.buckets.filter(b => b !== bucket) })} />{bucket}</label>)}<button className="rounded bg-amber-300 px-4 py-2 font-medium text-slate-950 disabled:opacity-40" disabled={state.loading || !draft.buckets.length} onClick={() => apply()}>Apply filters</button></div><p className="text-xs text-sky-200" aria-label="Applied historical filters">Displayed snapshot: {data.filters.markets.length ? data.filters.markets.join(", ") : "all markets"} · {data.filters.symbols.length ? data.filters.symbols.join(", ") : "all tickers"} · R:R {data.filters.buckets.length ? data.filters.buckets.join(", ") : "all buckets"} · {data.filters.years.length ? data.filters.years.join(", ") : "all entry years"} · {data.filters.side} · {data.filters.confirmation} · {label(data.filters.tf1 || "All TF1")} → {label(data.filters.tf2 || "All TF2")}. These filters apply to every metric, table and trade below.</p>{pending ? <p role="status" className="text-sm text-amber-200">Filters changed. Click Apply filters to update the displayed historical results.</p> : null}<p className="text-xs text-slate-400">Each bucket selects the closest existing liquidity target in its range. Entries can qualify for some buckets and lack an eligible target in others, so sample sizes can differ. Buckets are independent target scenarios. Several buckets may evaluate the same entry; their combined figures are research totals, not portfolio returns. TF1 / TF2 attribution cells may share an entry and must not be added together.</p></div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">{[["Closed scenarios", f(data.stats.closed, 0)], ["Open scenarios", f(data.stats.open, 0)], ["Gross R", r(data.stats.grossR)], ["Expectancy", r(data.stats.expectancy)], ["Win rate", `${f(data.stats.winRate, 1)}%`], ["Profit factor", data.stats.noLosses ? "No losses" : f(data.stats.profitFactor)]].map(([name, value]) => <div key={name} className={panel}><p className="text-xs text-slate-400">{name}</p><p className="mt-2 text-xl font-semibold">{value}</p></div>)}</div>

      <p className="text-xs text-slate-400">Universe: current stored US and forex symbols, including SPY / QQQ; this is not a point-in-time historical market universe. Main metrics use completed-candle gross R. Open scenarios are excluded from win rate, expectancy and profit factor. Same-candle stop + target follows the saved conservative stop-first policy. Costs and fills are research assumptions, not broker execution.</p>

      {data.options.markets.includes("india") ? <p className="rounded border border-sky-400/30 bg-sky-950/30 p-3 text-xs text-sky-100">India (NSE) · 50 NIFTY stocks, 2017–2026, IST session 09:15–15:30. Built with the desk rules: one trade per TF1×TF2 pair, ticker, side and IST day (first entry, nearest liquidity target with R:R ≥ 1); stop exits on a 5-minute close beyond the stop, target on a wick touch, fill-candle rule, same-candle fill + target resolved by candle shape. R is gross; use the 5 bps cost card for realistic Indian costs. Edge is concentrated in the 09:15–10:15 IST hour, which this viewer cannot filter. Charts may not load for India trades.</p> : null}

      <section className={panel}><h3 className="font-semibold">Filtered historical trades · newest entry first</h3><p className="mt-1 text-xs text-slate-400">Times shown in New York. Matching contexts are attributed to one economic entry per bucket, according to the saved deduplication policy.</p><div className="mt-4 overflow-x-auto"><table className="w-full whitespace-nowrap text-sm"><thead className="text-left text-xs text-slate-400"><tr>{["Entry datetime", "Ticker", "Side", "TF1", "TF2", "Confirm", "Bucket", "Entry", "SL", "TP", "R:R", "Result", "Gross R", "Exit datetime", "Trade source", "Chart"].map(h => <th key={h} className="pb-3 pr-4">{h}</th>)}</tr></thead><tbody>{data.trades.map(t => <tr key={t.id} className="border-t border-white/10"><td className="py-3 pr-4">{date(t.entryAt)}</td><td>{t.symbol}</td><td className={t.side === "BUY" ? "text-emerald-300" : "text-rose-300"}>{t.side}</td><td className="max-w-56 truncate pr-4" title={t.tf1Kind}>{[...new Set(matchingAttributions(t).map(a => label(a.tf1Kind)))].join(", ") || label(t.tf1Kind)}</td><td className="pr-4">{[...new Set(matchingAttributions(t).map(a => label(a.tf2Kind)))].join(", ") || label(t.tf2Kind)}</td><td>{[...new Set(matchingAttributions(t).map(a => a.confirmation))].join(" / ") || t.confirmation}</td><td>{t.rrBucket}</td><td>{f(t.entry, t.market === "forex" ? 5 : 2)}</td><td>{f(t.stop, t.market === "forex" ? 5 : 2)}</td><td>{f(t.target, t.market === "forex" ? 5 : 2)}</td><td>1:{f(t.plannedRR)}</td><td>{t.result}</td><td className={tone(t.r)}>{r(t.r)}</td><td>{date(t.exitAt)}</td><td className="py-3 pr-4"><details className="max-w-md whitespace-normal"><summary className="cursor-pointer text-sky-300">Why this trade? · {matchingAttributions(t).length || 1} matching setup{matchingAttributions(t).length > 1 ? "s" : ""}</summary><div className="mt-2 space-y-2 text-xs"><p>Historical run · TF1 1 Hour → TF2 5 Minutes · {t.symbol} · {t.market}</p>{matchingAttributions(t).map((a, i) => <div key={i}><p>{label(a.tf1Kind)} touch → {a.confirmation === "CHOCH" ? "MSS" : a.confirmation} → {label(a.tf2Kind)} retest</p><p className="break-all text-slate-400">Context: {a.contextId || "Not recorded"} · Array: {a.arrayId || "Not recorded"}</p><button className="mt-1 text-sky-300 underline" disabled={!onInspect || state.loading} onClick={() => onInspect?.({ ...t, chartSelection: a, chartStats: data.stats, chartFilters: applied })}>Open this setup chart</button></div>)}<p>Entry known: {t.entryKnownAt ? date(t.entryKnownAt) : "Not recorded"} New York</p><p className="break-all">Scenario ID: {t.id}</p><p className="break-all">Saved source: {t.sourceFile || "Source file not recorded"}</p><p>R:R {t.rrBucket} is a separate target scenario. Shared setup labels do not create additional economic entries.</p></div></details></td><td><button className={control} onClick={() => onInspect?.({ ...t, chartSelection: matchingAttributions(t)[0], chartStats: data.stats, chartFilters: applied })} disabled={!onInspect || state.loading}>ICT chart</button></td></tr>)}</tbody></table></div>{!data.trades.length ? <p className="py-5 text-sm text-slate-400">No historical trades match these filters. Broaden the ticker, entry year, setup or R:R selection.</p> : null}<div className="mt-4 flex items-center gap-4 text-sm"><button disabled={applied.page <= 1 || state.loading} className={`${control} disabled:opacity-30`} onClick={() => apply({ ...applied, page: applied.page - 1 })}>Previous</button><span>{data.pagination.total ? `${(applied.page - 1) * 50 + 1}–${Math.min(applied.page * 50, data.pagination.total)}` : "0"} of {f(data.pagination.total, 0)}</span><button disabled={applied.page * 50 >= data.pagination.total || state.loading} className={`${control} disabled:opacity-30`} onClick={() => apply({ ...applied, page: applied.page + 1 })}>Next</button></div></section>

      <section className={panel}><h3 className="font-semibold">Round-trip cost sensitivity</h3><p className="mt-1 text-xs text-slate-400">Fixed 1 / 2 / 5 basis points of entry price, divided by original stop risk. These are research assumptions, not observed spreads or broker commissions.</p><div className="mt-3 grid gap-3 sm:grid-cols-3">{data.costSensitivity.map(c => <div key={c.bps} className="rounded border border-white/10 p-3"><p className="text-xs text-slate-400">{c.bps} bps · {c.closed} closed with price / risk data</p><p className={`mt-1 text-lg ${tone(c.grossR)}`}>{r(c.grossR)}</p><p className="mt-1 text-xs">Expectancy {r(c.expectancy)} · PF {c.noLosses ? "∞" : f(c.profitFactor)}</p></div>)}</div></section><div className="grid gap-4 xl:grid-cols-2"><section className={panel}><h3 className="font-semibold">Selected R:R scenarios</h3><div className="mt-3 overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-xs text-slate-400"><tr>{["Bucket", "Closed", "Open", "Gross R", "Exp. R", "Win %", "PF"].map(h => <th key={h} className="pb-3 pr-3">{h}</th>)}</tr></thead><tbody>{selectedBuckets.map(bucket => { const b = data.buckets.find(row => row.bucket === bucket); return <tr key={bucket} className="border-t border-white/10"><td className="py-3">{bucket}</td><td>{b?.closed ?? "—"}</td><td>{b?.open ?? "—"}</td><td className={tone(b?.grossR ?? null)}>{r(b?.grossR)}</td><td>{r(b?.expectancy)}</td><td>{f(b?.winRate, 1)}</td><td>{b?.noLosses ? "∞" : f(b?.profitFactor)}</td></tr>; })}</tbody></table></div></section><section className={panel}><h3 className="font-semibold">Cumulative closed gross R</h3><p className="mt-1 text-xs text-slate-400">Each line follows an independent bucket, ordered by exit month. This is a trade-R diagnostic, not a funded equity curve.</p><Equity data={data.equity} /></section></div>

      <section className={panel}><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">TF1 × TF2 combinations</h3><p className="mt-1 text-xs text-slate-400">Cells pool selected markets; an economic entry counts once per pair even when both MSS and CISD qualify. Grey cells have fewer than 30 closed scenarios.</p></div><div className="flex gap-3"><label className="flex items-center gap-2 text-sm">Bucket<select className={control} value={activeHeatBucket} onChange={e => setHeatBucket(e.target.value)}>{selectedBuckets.map(bucket => <option key={bucket}>{bucket}</option>)}</select></label><select aria-label="Heatmap metric" className={control} value={heatMode} onChange={e => setHeatMode(e.target.value as typeof heatMode)}><option value="expectancy">Expectancy R</option><option value="grossR">Gross R</option><option value="closed">Closed sample</option></select></div></div><div className="mt-4 overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="p-2 text-left text-xs text-slate-400">TF1 / TF2</th>{heat.tf2.map(tf2 => <th className="p-2 text-xs" key={tf2}>{label(tf2)}</th>)}</tr></thead><tbody>{heat.tf1.map(tf1 => <tr key={tf1}><th className="p-2 text-left text-xs font-normal">{label(tf1)}</th>{heat.tf2.map(tf2 => { const c = heat.groups.get(`${tf1}|${tf2}`), value = c ? heatMode === "expectancy" ? c.grossR / (c.closed || 1) : c[heatMode] : null; const alpha = value == null ? 0 : Math.min(.65, .12 + Math.abs(value) / (heatMode === "grossR" ? 100 : heatMode === "closed" ? 1000 : 1)); return <td key={tf2} className="border border-slate-950 p-3 text-center" style={{ background: !c || c.closed < 30 ? "rgba(148,163,184,.08)" : value! >= 0 ? `rgba(16,185,129,${alpha})` : `rgba(244,63,94,${alpha})` }} title={`${c?.closed ?? 0} closed scenarios`}><span>{value == null ? "—" : heatMode === "closed" ? f(value, 0) : r(value)}</span><span className="mt-1 block text-[10px] text-slate-300">n={c?.closed ?? 0}</span></td>; })}</tr>)}</tbody></table></div>{!heat.tf1.length ? <p className="py-5 text-sm text-slate-400">No scenarios in this bucket and filter selection.</p> : null}</section>

      <section className={panel}><h3 className="font-semibold">Combination robustness · training / holdout</h3><p className="mt-1 text-xs text-slate-400">Training entries and exits precede {data.summary.holdoutStart ?? "2024-01-01"}; holdout entries begin on that date. Sorted by holdout expectancy for inspection. Choosing a winner after viewing holdout makes that period selection data; it is not a fresh validation.</p><div className="mt-4 max-h-96 overflow-auto"><table className="w-full whitespace-nowrap text-sm"><thead className="text-left text-xs text-slate-400"><tr>{["Market", "TF1", "TF2", "Bucket", "Confirm", "Closed", "Gross R", "Train n", "Train exp.", "Holdout n", "Holdout exp.", "Support"].map(h => <th key={h} className="pb-3 pr-4">{h}</th>)}</tr></thead><tbody>{data.combinations.map(c => <tr key={`${c.market}:${c.tf1}:${c.tf2}:${c.bucket}:${c.confirmation}`} className="border-t border-white/10"><td className="py-2 pr-4">{c.market}</td><td className="pr-4">{label(c.tf1)}</td><td className="pr-4">{label(c.tf2)}</td><td>{c.bucket}</td><td>{c.confirmation}</td><td>{c.closed}</td><td className={tone(c.grossR)}>{r(c.grossR)}</td><td>{c.train.closed}</td><td>{r(c.train.expectancy)}</td><td>{c.holdout.closed}</td><td className={tone(c.holdout.expectancy)}>{r(c.holdout.expectancy)}</td><td className={c.train.closed >= 30 && c.holdout.closed >= 10 ? "text-slate-300" : "text-amber-300"}>{c.train.closed >= 30 && c.holdout.closed >= 10 ? "Sample threshold met" : "Limited sample"}</td></tr>)}</tbody></table></div></section>

      <section className={panel}><h3 className="font-semibold">Entry-year outcomes</h3><div className="mt-4 max-h-72 overflow-auto"><table className="w-full text-sm"><thead className="text-left text-xs text-slate-400"><tr>{["Year", "R:R bucket", "Closed", "Open", "Gross R", "Expectancy", "Win %"].map(h => <th key={h} className="pb-3">{h}</th>)}</tr></thead><tbody>{data.years.map(row => <tr key={`${row.year}:${row.bucket}`} className="border-t border-white/10"><td className="py-2">{row.year}</td><td>{row.bucket}</td><td>{row.closed}</td><td>{row.open}</td><td className={tone(row.grossR)}>{r(row.grossR)}</td><td>{r(row.expectancy)}</td><td>{f(row.winRate, 1)}</td></tr>)}</tbody></table></div></section>

      <details className={panel}><summary className="cursor-pointer font-semibold">Full-run validation archive · all tickers · independent of filters</summary><p className="my-3 text-sm text-amber-200">Saved run-wide research below covers the complete run, independently of your selected tickers. Use the filtered combination table above for your current selection.</p>{data.pairedRR ? <PairedRRPanel report={data.pairedRR} provisional={data.summary.status?.toUpperCase() !== "COMPLETE"} /> : <p className="text-xs text-slate-400">Same-entry R:R audit will publish after the historical run completes.</p>}

      {data.validation ? <ValidationPanel report={data.validation} /> : null}</details>

      <details className={panel}><summary className="cursor-pointer text-sm">Coverage, execution policy and run diagnostics</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap text-xs text-slate-400">{JSON.stringify(data.summary, null, 2)}</pre></details>

    </> : null}

  </section>;

}

