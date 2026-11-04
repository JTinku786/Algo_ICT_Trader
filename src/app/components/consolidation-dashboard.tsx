"use client";



import { useEffect, useMemo, useState, type ReactNode } from "react";

import { AlertTriangle, Download, Layers, RefreshCw } from "lucide-react";

import { downloadCsv } from "@/lib/download-csv";

import ConsolidationIctChart, { type IctBox } from "./consolidation-ict-chart";
import ConsolidationDayClose from "./consolidation-day-close";



// ICT consolidation study: boxes and trades written by scripts/consolidation/consolidation_engine.py.



type Tf = "1d" | "1h" | "30m";

type Run = {

  run_id: string; config_name: string; timeframe: Tf; period: string; notes: string; data_start: string; data_end: string; symbols: number;

  params: Record<string, unknown> & { h_mult?: number; min_bars?: number; reclaim?: number; max_active?: number; data_quality?: string[]; bias_source?: string };

  summary: { boxes?: number; fates?: Record<string, number>; expanded_1h_pct?: number | null; validation?: Validation };

};

type Validation = {

  checked_boxes: number; total_boxes: number; checked_trades: number; total_trades: number; validated_at: string; failures: string[];

  box_checks: Record<string, { pass: number; n: number }>; trade_checks: Record<string, { pass: number; n: number }>;

};

type Stat = { n: number; wins: number; losses: number; timeouts: number; avg_r: number | null; sum_r: number | null; avg_pct: number | null; med_r: number | null; med_risk_pct: number | null; med_bars: number | null; med_hold_h: number | null };

type GridRow = Stat & { model: string; target: string; n_is: number; r_is: number | null; n_oos: number; r_oos: number | null };

type SegRow = Stat & { dim: string; key: string };

type FateRow = { fate: string; n: number; expanded: number; med_mfe_h: number | null; med_dwell: number | null; med_bars: number | null };

type IctRow = { key: string; n: number; reversed: number; continued: number; unresolved: number };

type Box = {

  box_id: string; sym: string; start_date: string; confirm_date: string; end_date: string; box_hi: number; box_lo: number; ce: number;

  height_pct: number; height_atr: number; bars: number; dwell_bars: number; top_tests: number; bot_tests: number; ce_crosses: number;

  atr_ratio: number | null; pd_pos: number | null; htf_bias: number; sweep_side: "up" | "dn" | null; sweep_kind: "wick" | "2B" | null;

  sweep_date: string | null; sweep_extreme: number | null; sweep_depth_pct: number | null; break_dir: "up" | "dn" | null; break_date: string | null;

  fate: string; exp_mfe_h: number | null; exp_mae_h: number | null; expanded_1h: boolean;

  eqh: [string, number][] | null; eql: [string, number][] | null;

};

type Trade = {

  trade_id: string; box_id: string; sym: string; side: "bull" | "bear"; model: string; target: string; trigger_date: string; entry_date: string;

  exit_date: string; entry: number; stop: number; tgt: number; plan_r: number; outcome: string; r: number; pct: number; risk_pct: number;

  execution_valid?: boolean; bars_held: number; risk_ok: boolean; htf_bias: number; with_bias: boolean | null; fate: string; box_hi: number; box_lo: number; ce: number;

  mfe_r: number | null; sweep_kind: string | null; hold_h: number | null;

  start_date: string; confirm_date: string; sweep_side: "up" | "dn" | null; box_sweep_kind: "wick" | "2B" | null; sweep_date: string | null;

  break_dir: "up" | "dn" | null; break_date: string | null;

  box_end_date: string; eqh: [string, number][] | null; eql: [string, number][] | null; sweep_extreme: number | null;

};

type Payload = {

  ok: boolean; error?: string; runs: Run[]; runId: string; timeframe: Tf; split: string; grid: GridRow[]; segments: SegRow[];

  fates: FateRow[]; ictTest: IctRow[]; boxes: Box[]; trades: Trade[]; totals: { boxes: number; trades: number; symbols: string[] | null }; listCap: number;

};

type Selected = { type: "box"; row: Box } | { type: "trade"; row: Trade } | null;



const TF_LABEL: Record<Tf, string> = { "1d": "Daily", "1h": "1 hour", "30m": "30 minute" };

const MODELS: { id: string; label: string; help: string; targets: string[] }[] = [

  { id: "SWEEP_FADE", label: "Sweep fade", help: "First stop run of an edge (wick or 2B) → next open, fade back into the box. Stop = sweep extreme.", targets: ["CE", "opp_edge", "1R", "2R", "3R", "measured"] },

  { id: "BREAK_CE_LIMIT", label: "Break → CE retest", help: "ICT alternate path: body-close break not reclaimed → limit at the CE. Stop = opposite edge.", targets: ["1R", "2R", "3R", "measured"] },

  { id: "BREAK_NEXT_OPEN", label: "Breakout (retail)", help: "Baseline: buy/sell the confirmed break at the next open, stop at the CE.", targets: ["1R", "2R", "3R", "measured"] },

];

const TARGET_LABEL: Record<string, string> = { CE: "CE (50%)", opp_edge: "Opposite edge", "1R": "1R", "2R": "2R", "3R": "3R", measured: "Measured move (1 box)" };

const FATES: { id: string; label: string; tone: string; help: string }[] = [

  { id: "manipulation_then_expansion", label: "Sweep → expansion other way", tone: "text-[#62d894] border-[#2fbf71]/30 bg-[#2fbf71]/10", help: "Power of 3: stop run on one edge, then a body-close break of the opposite edge" },

  { id: "direct_breakout", label: "Direct breakout", tone: "text-[#8edfff] border-[#64d2ff]/30 bg-[#64d2ff]/10", help: "Body-close break with no stop run first (the CE-retest path)" },

  { id: "sweep_then_break_same_side", label: "Sweep, then broke same side", tone: "text-[#f2c873] border-[#d9a441]/30 bg-[#d9a441]/10", help: "The first poke past an edge was the real move — fading it lost" },

  { id: "active", label: "Still active", tone: "text-[#d6deec] border-white/20 bg-white/5", help: "Box is live: the data ends inside its active window (today's ranges)" },

  { id: "unresolved", label: "Unresolved", tone: "text-[#ff8b91] border-[#e5484d]/30 bg-[#e5484d]/10", help: "No confirmed break within the active window" },

];

const FATE_LABEL = Object.fromEntries(FATES.map((f) => [f.id, f.label]));



const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(" ");

const f2 = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "–" : v.toFixed(d));

const pct = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? "–" : `${v.toFixed(d)}%`);

const signed = (v: number | null | undefined, d = 2, s = "") => (v == null || !Number.isFinite(v) ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(d)}${s}`);

const toneR = (v: number | null | undefined) => (v == null ? "text-[#93a1b6]" : v > 0 ? "text-[#62d894]" : v < 0 ? "text-[#ff8b91]" : "text-[#d6deec]");

const wr = (s: Stat) => (s.n ? (s.wins / s.n) * 100 : null);

const biasLabel = (b: number) => (b === 1 ? "Bullish" : b === -1 ? "Bearish" : "Neutral");



function Panel({ title, note, children, right }: { title: string; note?: string; children: ReactNode; right?: ReactNode }) {

  return (

    <section className="rounded-md border border-white/10 bg-[#101620]">

      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3">

        <h2 className="text-sm font-semibold">{title}</h2>

        {note ? <span className="text-[11px] text-[#7f8ca3]">{note}</span> : null}

        <div className="ml-auto">{right}</div>

      </div>

      {children}

    </section>

  );

}



export default function ConsolidationDashboard() {

  const [tf, setTf] = useState<Tf>("1d");

  const [runId, setRunId] = useState("");

  const [model, setModel] = useState("SWEEP_FADE");

  const [target, setTarget] = useState("2R");

  const [bias, setBias] = useState<"all" | "with" | "against">("all");

  const [riskOnly, setRiskOnly] = useState(true);

  const [fSym, setFSym] = useState("");

  const [fFate, setFFate] = useState("");

  const [view, setView] = useState<"boxes" | "trades">("trades");

  const [selected, setSelected] = useState<Selected>(null);

  const [nonce, setNonce] = useState(0);

  const [data, setData] = useState<Payload | null>(null);

  const [state, setState] = useState<{ key: string; error?: string }>({ key: "" });



  const query = useMemo(() => {

    const qs = new URLSearchParams({ tf, model, target, bias, min_risk: String(riskOnly), sym: fSym, fate: fFate });

    if (runId) qs.set("run", runId);

    return qs.toString();

  }, [tf, runId, model, target, bias, riskOnly, fSym, fFate]);

  const reqKey = `${query}#${nonce}`;

  const loading = state.key !== reqKey;

  const error = state.key === reqKey ? state.error : undefined;



  useEffect(() => {

    const ctl = new AbortController();

    fetch(`/api/consolidation?${query}`, { cache: "no-store", signal: ctl.signal })

      .then((r) => r.json() as Promise<Payload>)

      .then((j) => { if (!j.ok) throw new Error(j.error || "Load failed"); setData(j); setState({ key: reqKey }); })

      .catch((e) => { if (e?.name !== "AbortError") setState({ key: reqKey, error: e instanceof Error ? e.message : String(e) }); });

    return () => ctl.abort();

  }, [query, reqKey]);



  const dtf: Tf = data?.timeframe ?? tf;

  const run = data?.runs.find((r) => r.run_id === data.runId);

  const tfRuns = (data?.runs ?? []).filter((r) => r.timeframe === dtf);

  const fateMap = useMemo(() => Object.fromEntries((data?.fates ?? []).map((f) => [f.fate, f])), [data]);

  const boxTotal = (data?.fates ?? []).reduce((a, f) => a + f.n, 0);

  const resolved = (data?.fates ?? []).filter((f) => f.fate !== "unresolved" && f.fate !== "active");

  const expandedPct = resolved.reduce((a, f) => a + f.n, 0) ? (resolved.reduce((a, f) => a + f.expanded, 0) / resolved.reduce((a, f) => a + f.n, 0)) * 100 : null;

  const segDims = useMemo(() => {

    const m = new Map<string, SegRow[]>();

    for (const s of data?.segments ?? []) m.set(s.dim, [...(m.get(s.dim) ?? []), s]);

    return Array.from(m.entries());

  }, [data]);

  const modelDef = MODELS.find((m) => m.id === model)!;



  const chart = useMemo(() => {

    if (!selected) return null;

    const r = selected.row;

    const box: IctBox = selected.type === "box" ? selected.row : {

      sym: r.sym, box_hi: r.box_hi, box_lo: r.box_lo, ce: r.ce, start_date: selected.row.start_date, confirm_date: selected.row.confirm_date,

      end_date: selected.row.box_end_date, eqh: selected.row.eqh, eql: selected.row.eql, htf_bias: selected.row.htf_bias,

      sweep_side: selected.row.sweep_side, sweep_kind: selected.row.box_sweep_kind, sweep_date: selected.row.sweep_date,

      sweep_extreme: selected.row.sweep_extreme, break_dir: selected.row.break_dir, break_date: selected.row.break_date, fate: r.fate,

    };

    const t = selected.type === "trade" ? selected.row : null;

    const H = box.box_hi - box.box_lo;

    const biasWord = box.htf_bias === 1 ? "BULLISH" : box.htf_bias === -1 ? "BEARISH" : "NEUTRAL";

    const notes: string[] = [];

    notes.push(`1 · Consolidation ${box.start_date} → confirmed ${box.confirm_date}: ${(box.eqh ?? []).length} swing highs in the top 20% (EQH, buy stops above ${f2(box.box_hi)}) and ${(box.eql ?? []).length} swing lows in the bottom 20% (EQL, sell stops below ${f2(box.box_lo)}). CE ${f2(box.ce)}.`);

    notes.push(`2 · HTF order flow at confirmation: ${biasWord}${box.htf_bias === 1 ? " → ICT expects the raid BELOW the range (SSL) then expansion up" : box.htf_bias === -1 ? " → ICT expects the raid ABOVE the range (BSL) then expansion down" : ""}.`);

    if (box.sweep_side) notes.push(`3 · ${box.sweep_side === "up" ? "Buy-side (EQH)" : "Sell-side (EQL)"} raided ${box.sweep_date} by a ${box.sweep_kind === "2B" ? "close beyond that was reclaimed within 3 bars (2B / false breakout)" : "wick that closed back inside"}${box.sweep_extreme != null ? `, extreme ${f2(box.sweep_extreme)} (${((Math.abs(box.sweep_extreme - (box.sweep_side === "up" ? box.box_hi : box.box_lo)) / H) * 100).toFixed(0)}% of the box past the edge)` : ""}.`);

    else notes.push("3 · No stop run before the range resolved.");

    notes.push(box.break_dir ? `4 · Displacement ${box.break_dir === "up" ? "UP" : "DOWN"} ${box.break_date}: body close beyond the ${box.break_dir === "up" ? "high" : "low"} held for 3 bars → ${FATE_LABEL[box.fate ?? ""] ?? box.fate}.` : `4 · ${FATE_LABEL[box.fate ?? ""] ?? box.fate}: no confirmed break inside the active window.`);

    if (t) notes.push(`5 · ${MODELS.find((m) => m.id === t.model)?.label}: ${t.side === "bull" ? "BUY" : "SELL"} ${t.entry_date} @ ${f2(t.entry)}, SL ${f2(t.stop)} (${pct(t.risk_pct, 2)}), TP ${TARGET_LABEL[t.target] ?? t.target} ${f2(t.tgt)} → ${t.execution_valid === false ? "INVALID EXECUTION" : t.outcome.toUpperCase()} ${signed(t.r, 2, "R")} on ${t.exit_date} (best excursion ${f2(t.mfe_r)}R).`);

    const title = t

      ? `${t.sym} · ${TF_LABEL[dtf]} · ${MODELS.find((m) => m.id === t.model)?.label} · ${t.side === "bull" ? "Long" : "Short"} · ${t.execution_valid === false ? "INVALID EXECUTION" : t.outcome.toUpperCase()} ${signed(t.r, 2, "R")}`

      : `${box.sym} · ${TF_LABEL[dtf]} · range ${f2(box.box_lo)}–${f2(box.box_hi)} · ${FATE_LABEL[box.fate ?? ""] ?? ""}`;

    return { box, trade: t, title, notes };

  }, [selected, dtf]);

  const validation = run?.summary?.validation;



  const th = "px-2 py-2 text-left font-medium text-[#7f8ca3]";

  const td = "px-2 py-1.5 font-mono";

  return (

    <div className="space-y-5">

      <section className="rounded-md border border-white/10 bg-[#101620] p-4">

        <div className="flex flex-wrap items-start gap-3">

          <div className="grid size-9 place-items-center rounded-md border border-[#d9a441]/30 bg-[#d9a441]/10"><Layers className="size-4 text-[#f2c873]" /></div>

          <div className="min-w-0 flex-1">

            <div className="flex flex-wrap items-center gap-3">

              <h1 className="text-lg font-semibold">Consolidation · {TF_LABEL[dtf]}</h1>

              <div className="flex items-center gap-1 rounded-md border border-white/10 bg-[#0b0f16] p-1">

                {(["1d", "1h", "30m"] as Tf[]).map((x) => (

                  <button key={x} onClick={() => { setTf(x); setRunId(""); setSelected(null); }} className={cx("rounded px-3 py-1 font-mono text-xs", tf === x ? "bg-[#d9a441]/20 text-[#f2c873]" : "text-[#93a1b6] hover:text-white")}>{x === "1d" ? "1D" : x}</button>

                ))}

              </div>

              <span className="font-mono text-[11px] text-[#7f8ca3]">2017 → 2026 · walk-forward split {data?.split ?? "2022-01-01"}</span>

            </div>

            <p className="mt-1 text-xs leading-5 text-[#93a1b6]">

              ICT: price moves inside a clear trading range with no willingness to move significantly — orders build on both sides, expect a new expansion.

              Box = ≥{String(run?.params.min_bars ?? "–")} bars spanning ≤ {String(run?.params.h_mult ?? "–")}× ATR20 (ATR taken before the box) with ≥2 three-candle swing highs in the top 20% (EQH = buy stops) and ≥2 swing lows in the bottom 20% (EQL = sell stops).

              Edges freeze at confirmation; CE = 50%. Wick past an edge that closes back inside, or a close past it reclaimed within {String(run?.params.reclaim ?? 3)} bars = stop run; an unreclaimed close = break.

              HTF bias = {run?.params.bias_source ?? (dtf === "1d" ? "weekly order flow" : "daily order flow")}.

            </p>

          </div>

          <button onClick={() => setNonce((n) => n + 1)} className="flex h-9 items-center gap-2 rounded-md border border-white/10 px-3 text-xs text-[#93a1b6] hover:text-white">

            <RefreshCw className={cx("size-3.5", loading && "animate-spin")} /> Refresh

          </button>

        </div>

        <div className="mt-4 grid gap-2 md:grid-cols-2">

          {tfRuns.map((r) => {

            const active = r.run_id === data?.runId;

            return (

              <button key={r.run_id} onClick={() => { setRunId(r.run_id); setSelected(null); }} className={cx("rounded-md border p-3 text-left transition", active ? "border-[#d9a441]/60 bg-[#d9a441]/10" : "border-white/10 bg-[#0b0f16] hover:border-white/25")}>

                <div className="flex items-center justify-between gap-2">

                  <span className={cx("font-mono text-xs font-semibold", active ? "text-[#f2c873]" : "text-white")}>{r.config_name}</span>

                  <span className="font-mono text-[11px] text-[#93a1b6]">{r.summary?.boxes ?? 0} boxes · {pct(r.summary?.expanded_1h_pct, 0)} expanded ≥1 box</span>

                </div>

                <div className="mt-1 text-[11px] leading-4 text-[#93a1b6]">{r.notes}</div>

              </button>

            );

          })}

        </div>

        {run ? (

          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-[#7f8ca3]">

            <span>run {run.run_id}</span><span>{run.data_start} → {run.data_end}</span><span>{run.symbols} symbols</span>

            <span>active window {String(run.params.max_active)} bars</span><span>bar-level fills · hard stop · stop checked before target</span>

          </div>

        ) : null}

        <div className="mt-3 rounded-md border border-[#d9a441]/30 bg-[#d9a441]/10 px-3 py-2 text-xs text-[#f2c873]">

          Research replay: local ATR/range rules, native-bar hard stops and conservative same-bar stop priority. This tab does not use the reversal 5m-close stop rule. The legacy feed may clip prices and reconstruct missing session tails; source fidelity is not certified by the sampled audit. Fate filters use future outcomes. <a className="underline" href="/reports/consolidation-end-to-end-review.html" target="_blank" rel="noreferrer">Read the end-to-end review</a>. <a className="underline" href="/reports/consolidation-research-results.html" target="_blank" rel="noreferrer">Explore the measured research experiments</a>.

        </div>

        {run?.params.data_quality?.length ? (

          <div className="mt-3 flex items-start gap-2 rounded-md border border-[#d9a441]/30 bg-[#d9a441]/10 px-3 py-2 text-xs text-[#f2c873]">

            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span>Data quality: {run.params.data_quality.join(" · ")}</span>

          </div>

        ) : null}

        {validation ? (() => {

          const rows = [...Object.entries(validation.box_checks), ...Object.entries(validation.trade_checks)];

          const bad = rows.filter(([, v]) => v.pass !== v.n);

          return (

            <details className={cx("mt-3 rounded-md border px-3 py-2 text-xs", bad.length ? "border-[#e5484d]/40 bg-[#e5484d]/10 text-[#ff9da2]" : "border-[#2fbf71]/30 bg-[#2fbf71]/10 text-[#62d894]")}>

              <summary className="cursor-pointer">

                Independent audit ({validation.validated_at.replace("T", " ")}): {bad.length ? `${bad.length} rule(s) failing` : "sampled rules match the engine feed; source fidelity is a separate check"} · {validation.checked_boxes}/{validation.total_boxes} boxes · {validation.checked_trades}/{validation.total_trades} closed trades re-checked

              </summary>

              <div className="mt-2 grid gap-x-6 gap-y-0.5 font-mono text-[11px] text-[#a9b5c9] md:grid-cols-2">

                {rows.map(([k, v]) => <span key={k} className={v.pass === v.n ? "" : "text-[#ff9da2]"}>{v.pass === v.n ? "✓" : "✗"} {k}: {v.pass}/{v.n}</span>)}

              </div>

              {validation.failures.length ? <div className="mt-2 font-mono text-[10px] text-[#ff9da2]">{validation.failures.slice(0, 8).join(" · ")}</div> : null}

            </details>

          );

        })() : null}

        {error ? <div className="mt-3 rounded-md bg-[#e5484d]/10 px-3 py-2 text-sm text-[#ff9da2]">{error}</div> : null}

      </section>



      <ConsolidationDayClose timeframe={dtf} config={run?.config_name ?? "tight"} />

      <Panel title="How did the ranges resolve?" note={`${boxTotal} boxes · ${pct(expandedPct, 0)} of resolved boxes ran ≥ 1 box height past the broken edge`}>

        <div className="grid gap-3 p-4 md:grid-cols-3 xl:grid-cols-5">

          {FATES.map((f) => {

            const row = fateMap[f.id]; const n = row?.n ?? 0; const active = fFate === f.id;

            return (

              <button key={f.id} onClick={() => { setFFate(active ? "" : f.id); setView("boxes"); }} className={cx("rounded-md border p-3 text-left transition", f.tone, active && "ring-1 ring-white/40")}>

                <div className="text-[11px] font-semibold uppercase">{f.label}</div>

                <div className="mt-2 flex items-baseline gap-2"><span className="font-mono text-3xl font-semibold">{n}</span><span className="font-mono text-xs opacity-80">{boxTotal ? pct((n / boxTotal) * 100, 0) : ""}</span></div>

                <div className="mt-1 font-mono text-[11px] text-[#a9b5c9]">{f.id !== "unresolved" && f.id !== "active" && row ? `${pct((row.expanded / n) * 100, 0)} expanded ≥1 box · med ${f2(row.med_mfe_h, 1)} boxes` : row ? `med dwell ${f2(row.med_dwell, 0)} bars` : ""}</div>

                <div className="mt-2 text-[11px] leading-4 text-[#a9b5c9]">{f.help}</div>

              </button>

            );

          })}

        </div>

        <div className="overflow-x-auto px-4 pb-4">

          <div className="mb-2 text-xs text-[#93a1b6]">ICT check — with a bullish HTF bias the stop run should come <b>below</b> the range and price should then expand up (and the reverse for bearish). Boxes whose first sweep went…</div>

          <table className="w-full text-xs">

            <thead><tr className="border-b border-white/10"><th className={th}>First sweep</th><th className={th}>Boxes</th><th className={th}>Then expanded the other way</th><th className={th}>Then broke the same side</th><th className={th}>Unresolved</th></tr></thead>

            <tbody>

              {(data?.ictTest ?? []).map((r) => (

                <tr key={r.key} className="border-b border-white/5"><td className="px-2 py-1.5">{r.key}</td><td className={td}>{r.n}</td>

                  <td className={cx(td, "text-[#62d894]")}>{r.reversed} · {pct((r.reversed / r.n) * 100, 0)}</td>

                  <td className={cx(td, "text-[#f2c873]")}>{r.continued} · {pct((r.continued / r.n) * 100, 0)}</td>

                  <td className={td}>{r.unresolved}</td></tr>

              ))}

            </tbody>

          </table>

        </div>

      </Panel>



      <Panel title="Trade models" note="Symbol and fate filters apply to results. Fate is a retrospective outcome, unavailable at entry. R before costs; invalid price geometry excluded; risk-filtered by default." right={

        <div className="flex flex-wrap items-center gap-2 text-xs">

          <div className="flex items-center gap-1 rounded-md border border-white/10 bg-[#0b0f16] p-1">

            {(["all", "with", "against"] as const).map((b) => (

              <button key={b} onClick={() => setBias(b)} className={cx("rounded px-2 py-0.5", bias === b ? "bg-[#64d2ff]/15 text-[#8edfff]" : "text-[#93a1b6]")}>{b === "all" ? "All" : b === "with" ? "With HTF bias" : "Against HTF bias"}</button>

            ))}

          </div>

          <label className="flex items-center gap-1 text-[#93a1b6]"><input type="checkbox" checked={riskOnly} onChange={(e) => setRiskOnly(e.target.checked)} /> min risk {pct(Number(run?.params.min_risk_pct ?? 0), 2)}</label>

        </div>}>

        <div className="overflow-x-auto p-4">

          <table className="w-full text-xs">

            <thead><tr className="border-b border-white/10"><th className={th}>Model</th><th className={th}>Target</th><th className={th}>Trades</th><th className={th}>Win %</th><th className={th}>Avg R</th><th className={th}>Median R</th><th className={th}>Sum R</th><th className={th}>Avg %</th><th className={th}>Med risk %</th><th className={th}>Med hold</th><th className={th}>In-sample R</th><th className={th}>Out-of-sample R</th></tr></thead>

            <tbody>

              {MODELS.flatMap((m) => m.targets.map((tg, i) => {

                const g = data?.grid.find((x) => x.model === m.id && x.target === tg);

                const active = model === m.id && target === tg;

                return (

                  <tr key={m.id + tg} onClick={() => { setModel(m.id); setTarget(tg); setView("trades"); setSelected(null); }} className={cx("cursor-pointer border-b border-white/5 hover:bg-white/5", active && "bg-[#d9a441]/10")}>

                    <td className="px-2 py-1.5" title={m.help}>{i === 0 ? <span className="font-semibold">{m.label}</span> : ""}</td>

                    <td className="px-2 py-1.5">{TARGET_LABEL[tg]}</td>

                    <td className={td}>{g?.n ?? 0}</td><td className={td}>{g ? pct(wr(g)) : "–"}</td>

                    <td className={cx(td, toneR(g?.avg_r))}>{signed(g?.avg_r, 3)}</td><td className={cx(td, toneR(g?.med_r))}>{signed(g?.med_r, 2)}</td>

                    <td className={cx(td, toneR(g?.sum_r))}>{signed(g?.sum_r, 1)}</td><td className={cx(td, toneR(g?.avg_pct))}>{signed(g?.avg_pct, 2, "%")}</td>

                    <td className={td}>{pct(g?.med_risk_pct, 2)}</td><td className={td}>{g?.med_hold_h == null ? "–" : dtf === "1d" ? `${(g.med_hold_h / 24).toFixed(1)}d` : `${g.med_hold_h.toFixed(1)}h`}</td>

                    <td className={cx(td, toneR(g?.r_is))}>{signed(g?.r_is, 3)} <span className="text-[#7f8ca3]">({g?.n_is ?? 0})</span></td>

                    <td className={cx(td, toneR(g?.r_oos))}>{signed(g?.r_oos, 3)} <span className="text-[#7f8ca3]">({g?.n_oos ?? 0})</span></td>

                  </tr>

                );

              }))}

            </tbody>

          </table>

          <p className="mt-3 text-[11px] leading-4 text-[#7f8ca3]">{modelDef.label}: {modelDef.help} Exits are simulated on the {TF_LABEL[dtf]} bars themselves (no 5m replay), so a bar that touches both stop and target counts as a loss.</p>

        </div>

      </Panel>



      <Panel title={`What separates winners · ${modelDef.label} → ${TARGET_LABEL[target]}`} note={bias === "all" ? "" : bias === "with" ? "with HTF bias only" : "against HTF bias only"}>

        <div className="grid gap-3 p-4 lg:grid-cols-2 2xl:grid-cols-3">

          {segDims.map(([dim, rows]) => (

            <div key={dim} className="rounded-md border border-white/10 bg-[#0b0f16] p-3">

              <div className="mb-2 text-[11px] font-semibold uppercase text-[#93a1b6]">{dim}</div>

              <table className="w-full text-xs">

                <tbody>{rows.map((s) => (

                  <tr key={s.key} className="border-b border-white/5 last:border-0">

                    <td className="py-1 pr-2">{FATE_LABEL[s.key] ?? s.key}</td><td className="py-1 text-right font-mono text-[#93a1b6]">{s.n}</td>

                    <td className="py-1 text-right font-mono">{pct(wr(s), 0)}</td><td className={cx("py-1 text-right font-mono", toneR(s.avg_r))}>{signed(s.avg_r, 3)}R</td>

                  </tr>

                ))}</tbody>

              </table>

            </div>

          ))}

        </div>

      </Panel>



      {chart ? (

        <Panel title={chart.title} right={<button onClick={() => setSelected(null)} className="rounded border border-white/15 px-2 py-0.5 text-xs text-[#93a1b6]">Close</button>}>

          <div className="p-4">

            <ol className="mb-3 space-y-1 text-[11px] leading-4 text-[#a9b5c9]">{chart.notes.map((x) => <li key={x}>{x}</li>)}</ol>

            <ConsolidationIctChart key={`${chart.box.sym}${chart.box.start_date}${chart.trade?.trade_id ?? ""}`} tf={dtf} box={chart.box} trade={chart.trade} targetLabel={chart.trade ? TARGET_LABEL[chart.trade.target] : undefined} />

            {selected?.type === "box" ? (

              <div className="mt-3 grid gap-x-6 gap-y-1 font-mono text-[11px] text-[#93a1b6] md:grid-cols-3">

                <span>span {pct(selected.row.height_pct, 2)} · {f2(selected.row.height_atr)}× ATR20</span><span>{selected.row.bars} bars to confirm · dwell {selected.row.dwell_bars} bars after</span>

                <span>EQH swings {selected.row.top_tests} · EQL swings {selected.row.bot_tests} · {selected.row.ce_crosses} CE crosses</span>

                <span>ATR7/ATR21 {f2(selected.row.atr_ratio)}</span><span>HTF bias {biasLabel(selected.row.htf_bias)} · location {pct(selected.row.pd_pos == null ? null : selected.row.pd_pos * 100, 0)} of 126-bar range</span>

                <span>after break: MFE {f2(selected.row.exp_mfe_h)} boxes · MAE {f2(selected.row.exp_mae_h)} boxes</span>

              </div>

            ) : null}

          </div>

        </Panel>

      ) : null}



      <Panel title={view === "trades" ? `Trades · ${modelDef.label} → ${TARGET_LABEL[target]}` : "Consolidation boxes"} note={`showing ${view === "trades" ? data?.trades.length ?? 0 : data?.boxes.length ?? 0} of ${view === "trades" ? data?.totals.trades ?? 0 : data?.totals.boxes ?? 0} (most recent first, list capped at ${data?.listCap ?? 0})`} right={

        <div className="flex flex-wrap items-center gap-2 text-xs">

          <div className="flex items-center gap-1 rounded-md border border-white/10 bg-[#0b0f16] p-1">

            {(["trades", "boxes"] as const).map((v) => <button key={v} onClick={() => setView(v)} className={cx("rounded px-2 py-0.5", view === v ? "bg-[#d9a441]/20 text-[#f2c873]" : "text-[#93a1b6]")}>{v === "trades" ? "Trades" : "Boxes"}</button>)}

          </div>

          <select value={fSym} onChange={(e) => setFSym(e.target.value)} className="rounded border border-white/10 bg-[#0b0f16] px-2 py-1">

            <option value="">All symbols</option>{(data?.totals.symbols ?? []).map((s) => <option key={s} value={s}>{s}</option>)}

          </select>

          <select value={fFate} onChange={(e) => setFFate(e.target.value)} className="rounded border border-white/10 bg-[#0b0f16] px-2 py-1">

            <option value="">All fates</option>{FATES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}

          </select>

          <button onClick={() => { void downloadCsv(`/api/consolidation?${query}&format=csv&view=${view}`, `consolidation_${dtf}_${view}.csv`).catch((e) => setState({key:reqKey,error:String(e)})); }} className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[#93a1b6] hover:text-white"><Download className="size-3" /> CSV</button>

        </div>}>

        <div className="max-h-[560px] overflow-auto">

          {view === "trades" ? (

            <table className="w-full text-xs">

              <thead className="sticky top-0 bg-[#101620]"><tr className="border-b border-white/10">{["Symbol", "Side", "Entry", "Entry px", "Stop", "Target", "Risk %", "HTF", "Box fate", "Outcome", "R", "%", "Exit", "MFE R"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>

              <tbody>{(data?.trades ?? []).map((t) => (

                <tr key={t.trade_id} onClick={() => setSelected({ type: "trade", row: t })} className={cx("cursor-pointer border-b border-white/5 hover:bg-white/5", selected?.type === "trade" && selected.row.trade_id === t.trade_id && "bg-[#d9a441]/10")}>

                  <td className="px-2 py-1.5 font-semibold">{t.sym}</td><td className={cx("px-2", t.side === "bull" ? "text-[#62d894]" : "text-[#ff8b91]")}>{t.side === "bull" ? "Long" : "Short"}</td>

                  <td className={td}>{t.entry_date}</td><td className={td}>{f2(t.entry)}</td><td className={td}>{f2(t.stop)}</td><td className={td}>{f2(t.tgt)}</td><td className={td}>{pct(t.risk_pct, 2)}</td>

                  <td className="px-2">{t.with_bias == null ? "–" : t.with_bias ? "with" : "against"}</td><td className="px-2 text-[#93a1b6]">{FATE_LABEL[t.fate] ?? t.fate}</td>

                  <td className="px-2">{t.execution_valid === false ? "INVALID EXECUTION" : t.outcome}</td><td className={cx(td, toneR(t.r))}>{t.execution_valid === false ? "–" : signed(t.r)}</td><td className={cx(td, toneR(t.pct))}>{signed(t.pct, 2, "%")}</td><td className={td}>{t.exit_date}</td><td className={td}>{f2(t.mfe_r)}</td>

                </tr>

              ))}</tbody>

            </table>

          ) : (

            <table className="w-full text-xs">

              <thead className="sticky top-0 bg-[#101620]"><tr className="border-b border-white/10">{["Symbol", "Start", "Confirmed", "Low", "High", "Span %", "× ATR", "Bars", "EQH/EQL", "HTF bias", "First sweep", "Break", "Fate", "MFE (boxes)"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>

              <tbody>{(data?.boxes ?? []).map((b) => (

                <tr key={b.box_id} onClick={() => setSelected({ type: "box", row: b })} className={cx("cursor-pointer border-b border-white/5 hover:bg-white/5", selected?.type === "box" && selected.row.box_id === b.box_id && "bg-[#d9a441]/10")}>

                  <td className="px-2 py-1.5 font-semibold">{b.sym}</td><td className={td}>{b.start_date}</td><td className={td}>{b.confirm_date}</td><td className={td}>{f2(b.box_lo)}</td><td className={td}>{f2(b.box_hi)}</td>

                  <td className={td}>{pct(b.height_pct, 2)}</td><td className={td}>{f2(b.height_atr)}</td><td className={td}>{b.bars}</td><td className={td}>{b.top_tests}/{b.bot_tests}</td><td className="px-2">{biasLabel(b.htf_bias)}</td>

                  <td className="px-2">{b.sweep_side ? `${b.sweep_side === "up" ? "High" : "Low"} · ${b.sweep_kind} · ${b.sweep_date}` : "–"}</td>

                  <td className="px-2">{b.break_dir ? `${b.break_dir === "up" ? "Up" : "Down"} · ${b.break_date}` : "–"}</td>

                  <td className="px-2 text-[#93a1b6]">{FATE_LABEL[b.fate] ?? b.fate}</td><td className={td}>{f2(b.exp_mfe_h)}</td>

                </tr>

              ))}</tbody>

            </table>

          )}

        </div>

      </Panel>

    </div>

  );

}

