"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Download, RefreshCw, TrendingUp } from "lucide-react";
import ExpansionIctChart, { type IctLeg } from "./expansion-ict-chart";

// ICT expansion study: legs and trades written by scripts/expansion/expansion_engine.py.

type Tf = "1d" | "1h" | "30m";
type Validation = {
  checked_legs: number; total_legs: number; checked_trades: number; total_trades: number; validated_at: string; failures: string[];
  leg_checks: Record<string, { pass: number; n: number }>; trade_checks: Record<string, { pass: number; n: number }>;
};
type Run = {
  run_id: string; config_name: string; timeframe: Tf; period: string; notes: string; data_start: string; data_end: string; symbols: number;
  params: Record<string, unknown> & { disp_body?: number; min_leg?: number; max_wait?: number; data_quality?: string[]; bias_source?: string; min_risk_pct?: number };
  summary: { legs?: number; outcomes?: Record<string, number>; touched_eq_pct?: number | null; validation?: Validation };
};
type Stat = { n: number; wins: number; losses: number; timeouts: number; avg_r: number | null; sum_r: number | null; avg_pct: number | null; med_r: number | null; med_risk_pct: number | null; med_bars: number | null; med_hold_h: number | null };
type GridRow = Stat & { model: string; target: string; n_is: number; r_is: number | null; n_oos: number; r_oos: number | null };
type SegRow = Stat & { dim: string; key: string };
type OutcomeRow = { outcome: string; n: number; med_retrace: number | null; med_leg_atr: number | null; touched_eq: number; touched_ote: number };
type IctRow = { key: string; n: number; continued: number; failed: number; unresolved: number };
type Leg = IctLeg & {
  leg_id: string; leg_atr: number; leg_pct: number; disp_body_atr: number; disp_bars: number; fvg_count: number; killzone: string;
  outcome: string; retrace_pct: number; touched_eq: boolean; touched_ote: boolean; htf_bias: number;
};
type Trade = {
  trade_id: string; leg_id: string; sym: string; side: "bull" | "bear"; model: string; target: string; trigger_date: string; entry_date: string;
  exit_date: string; entry: number; stop: number; tgt: number; plan_r: number; outcome: string; r: number; pct: number; risk_pct: number;
  bars_held: number; risk_ok: boolean; htf_bias: number; with_bias: boolean | null; leg_outcome: string | null; mfe_r: number | null;
  origin: number; ext: number | null; eq: number | null; hold_h: number | null;
  origin_date: string | null; disp_date: string | null; ext_date: string | null; confirm_date: string | null; leg_end_date: string | null;
  broken_swing_date: string | null; broken_level: number | null; ote: number | null; fvgs: [string, number, number][] | null;
  entry_fvg: [string, number, number] | null; origin_sweep: boolean | null; retrace_pct: number | null; leg_atr: number | null;
};
type Payload = {
  ok: boolean; error?: string; runs: Run[]; runId: string; timeframe: Tf; split: string; grid: GridRow[]; segments: SegRow[];
  outcomes: OutcomeRow[]; ictTest: IctRow[]; legs: Leg[]; trades: Trade[]; totals: { legs: number; trades: number; symbols: string[] | null }; listCap: number;
};
type Selected = { type: "leg"; row: Leg } | { type: "trade"; row: Trade } | null;

const TF_LABEL: Record<Tf, string> = { "1d": "Daily", "1h": "1 hour", "30m": "30 minute" };
const LEG_TARGETS = ["leg_high", "ext_27", "ext_62", "2R", "3R"];
const MODELS: { id: string; label: string; help: string; targets: string[] }[] = [
  { id: "FVG_CE", label: "FVG CE (retracement)", help: "Limit at the 50% (CE) of the leg's highest FVG that sits in discount (premium for shorts). Stop = leg origin.", targets: LEG_TARGETS },
  { id: "OTE_LIMIT", label: "OTE 70.5%", help: "Limit at the 70.5% retracement of origin → swing extreme. Stop = leg origin.", targets: LEG_TARGETS },
  { id: "SWEEP_MSS", label: "Sweep + rejection", help: "Range Expansion guide: once price is in discount (premium for shorts), a candle sweeps a pullback swing low (high) and closes back through it with a bullish (bearish) body → next open. Stop = sweep extreme.", targets: LEG_TARGETS },
  { id: "CHASE", label: "Chase (baseline)", help: "What ICT warns against: buy the open after every displacement candle, stop at the origin.", targets: ["2R", "3R"] },
];
const TARGET_LABEL: Record<string, string> = { leg_high: "Leg extreme (ERL)", ext_27: "-0.27 extension", ext_62: "-0.62 extension", "2R": "2R", "3R": "3R" };
const OUTCOMES: { id: string; label: string; tone: string; help: string }[] = [
  { id: "continued_after_retrace", label: "Retraced past 50%, then continued", tone: "text-[#62d894] border-[#2fbf71]/30 bg-[#2fbf71]/10", help: "ICT ideal: pulled back into discount (premium for shorts), then took the leg's extreme" },
  { id: "continued_shallow", label: "Ran without a discount retrace", tone: "text-[#8edfff] border-[#64d2ff]/30 bg-[#64d2ff]/10", help: "Took the extreme before reaching 50% — no entry, \"let it go\"" },
  { id: "failed", label: "Failed (closed through origin)", tone: "text-[#ff8b91] border-[#e5484d]/30 bg-[#e5484d]/10", help: "A close beyond the leg origin before a new extreme — reversal" },
  { id: "active", label: "Still active", tone: "text-[#d6deec] border-white/20 bg-white/5", help: "Data ends inside the retracement window" },
  { id: "unresolved", label: "Unresolved", tone: "text-[#f2c873] border-[#d9a441]/30 bg-[#d9a441]/10", help: "Neither the extreme nor the origin within the window" },
];
const OUTCOME_LABEL = Object.fromEntries(OUTCOMES.map((f) => [f.id, f.label]));

const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(" ");
const f2 = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "–" : v.toFixed(d));
const pct = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? "–" : `${v.toFixed(d)}%`);
const signed = (v: number | null | undefined, d = 2, s = "") => (v == null || !Number.isFinite(v) ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(d)}${s}`);
const toneR = (v: number | null | undefined) => (v == null ? "text-[#93a1b6]" : v > 0 ? "text-[#62d894]" : v < 0 ? "text-[#ff8b91]" : "text-[#d6deec]");
const wr = (s: Stat) => (s.n ? (s.wins / s.n) * 100 : null);
const biasLabel = (b: number | null | undefined) => (b === 1 ? "Bullish" : b === -1 ? "Bearish" : "Neutral");
function downloadRows(rows: Record<string, unknown>[], filename: string) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => { const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const url = URL.createObjectURL(new Blob([[cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n")], { type: "text/csv" }));
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}
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

export default function ExpansionDashboard() {
  const [tf, setTf] = useState<Tf>("1d");
  const [runId, setRunId] = useState("");
  const [model, setModel] = useState("FVG_CE");
  const [target, setTarget] = useState("leg_high");
  const [bias, setBias] = useState<"all" | "with" | "against">("all");
  const [riskOnly, setRiskOnly] = useState(true);
  const [fSym, setFSym] = useState("");
  const [fOut, setFOut] = useState("");
  const [view, setView] = useState<"legs" | "trades">("trades");
  const [selected, setSelected] = useState<Selected>(null);
  const [nonce, setNonce] = useState(0);
  const [data, setData] = useState<Payload | null>(null);
  const [state, setState] = useState<{ key: string; error?: string }>({ key: "" });

  const query = useMemo(() => {
    const qs = new URLSearchParams({ tf, model, target, bias, min_risk: String(riskOnly), sym: fSym, outcome: fOut });
    if (runId) qs.set("run", runId);
    return qs.toString();
  }, [tf, runId, model, target, bias, riskOnly, fSym, fOut]);
  const reqKey = `${query}#${nonce}`;
  const loading = state.key !== reqKey;
  const error = state.key === reqKey ? state.error : undefined;

  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/expansion?${query}`, { cache: "no-store", signal: ctl.signal })
      .then((r) => r.json() as Promise<Payload>)
      .then((j) => { if (!j.ok) throw new Error(j.error || "Load failed"); setData(j); setState({ key: reqKey }); })
      .catch((e) => { if (e?.name !== "AbortError") setState({ key: reqKey, error: e instanceof Error ? e.message : String(e) }); });
    return () => ctl.abort();
  }, [query, reqKey]);

  const dtf: Tf = data?.timeframe ?? tf;
  const run = data?.runs.find((r) => r.run_id === data.runId);
  const tfRuns = (data?.runs ?? []).filter((r) => r.timeframe === dtf);
  const outMap = useMemo(() => Object.fromEntries((data?.outcomes ?? []).map((f) => [f.outcome, f])), [data]);
  const legTotal = (data?.outcomes ?? []).reduce((a, f) => a + f.n, 0);
  const segDims = useMemo(() => {
    const m = new Map<string, SegRow[]>();
    for (const s of data?.segments ?? []) m.set(s.dim, [...(m.get(s.dim) ?? []), s]);
    return Array.from(m.entries());
  }, [data]);
  const modelDef = MODELS.find((m) => m.id === model)!;
  const validation = run?.summary?.validation;

  const dispBody = String(run?.params.disp_body ?? "–");
  const chart = useMemo(() => {
    if (!selected) return null;
    let leg: IctLeg | null = null;
    const t = selected.type === "trade" ? selected.row : null;
    if (selected.type === "leg") leg = selected.row;
    else if (t && t.origin_date && t.ext != null && t.eq != null && t.ote != null && t.broken_level != null) {
      leg = { sym: t.sym, side: t.side, origin: t.origin, ext: t.ext, eq: t.eq, ote: t.ote, broken_level: t.broken_level, origin_date: t.origin_date,
        disp_date: t.disp_date!, ext_date: t.ext_date!, confirm_date: t.confirm_date!, end_date: t.leg_end_date!, broken_swing_date: t.broken_swing_date!,
        fvgs: t.fvgs, entry_fvg: t.entry_fvg, origin_sweep: t.origin_sweep, htf_bias: t.htf_bias, outcome: t.leg_outcome ?? undefined };
    }
    const bull = (leg?.side ?? t?.side) === "bull";
    const notes: string[] = [];
    if (leg) {
      const L = Math.abs(leg.ext - leg.origin);
      notes.push(`1 · Displacement ${leg.disp_date}: a ${bull ? "bullish" : "bearish"} candle with a body ≥ ${dispBody}× ATR20 closed ${bull ? "above" : "below"} the swing ${bull ? "high" : "low"} at ${f2(leg.broken_level)} (${leg.broken_swing_date}) → break of structure.`);
      notes.push(`2 · Leg: origin ${f2(leg.origin)} (${leg.origin_date}${leg.origin_sweep ? ", took the prior 20-bar " + (bull ? "low" : "high") + " = sweep then expansion" : ""}) → swing ${bull ? "high" : "low"} ${f2(leg.ext)} (${leg.ext_date}), confirmed ${leg.confirm_date}. Size ${f2(L)}${selected.type === "leg" ? ` = ${f2(selected.row.leg_atr)}× ATR20` : ""}. ${(leg.fvgs ?? []).length} FVG(s) left behind.`);
      notes.push(`3 · Dealing range of the leg: equilibrium ${f2(leg.eq)}, OTE 70.5% ${f2(leg.ote)}, ${bull ? "discount below" : "premium above"} ${f2(leg.eq)}. Entry FVG in ${bull ? "discount" : "premium"}: ${leg.entry_fvg ? `${f2(leg.entry_fvg[1])}–${f2(leg.entry_fvg[2])} (CE ${f2((leg.entry_fvg[1] + leg.entry_fvg[2]) / 2)})` : "none"}.`);
      notes.push(`4 · HTF order flow: ${biasLabel(leg.htf_bias).toUpperCase()} · leg outcome: ${OUTCOME_LABEL[leg.outcome ?? ""] ?? leg.outcome ?? "–"}${selected.type === "leg" ? ` · deepest retracement ${pct(selected.row.retrace_pct, 0)} of the leg` : t?.retrace_pct != null ? ` · deepest retracement ${pct(t.retrace_pct, 0)}` : ""}.`);
    }
    if (t) notes.push(`${leg ? "5" : "1"} · ${MODELS.find((m) => m.id === t.model)?.label}: ${t.side === "bull" ? "BUY" : "SELL"} ${t.entry_date} @ ${f2(t.entry)}, SL ${f2(t.stop)} (${pct(t.risk_pct, 2)}), TP ${TARGET_LABEL[t.target] ?? t.target} ${f2(t.tgt)} → ${t.outcome.toUpperCase()} ${signed(t.r, 2, "R")} on ${t.exit_date} (best excursion ${f2(t.mfe_r)}R).${!leg ? " No qualifying leg followed this displacement candle, so there is no leg to draw." : ""}`);
    const title = t
      ? `${t.sym} · ${TF_LABEL[dtf]} · ${MODELS.find((m) => m.id === t.model)?.label} · ${t.side === "bull" ? "Long" : "Short"} · ${t.outcome.toUpperCase()} ${signed(t.r, 2, "R")}`
      : `${leg!.sym} · ${TF_LABEL[dtf]} · ${bull ? "bullish" : "bearish"} expansion ${f2(leg!.origin)} → ${f2(leg!.ext)}`;
    return { leg, trade: t, title, notes };
  }, [selected, dtf, dispBody]);

  const th = "px-2 py-2 text-left font-medium text-[#7f8ca3]";
  const td = "px-2 py-1.5 font-mono";
  return (
    <div className="space-y-5">
      <section className="rounded-md border border-white/10 bg-[#101620] p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="grid size-9 place-items-center rounded-md border border-[#d9a441]/30 bg-[#d9a441]/10"><TrendingUp className="size-4 text-[#f2c873]" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-lg font-semibold">Expansion · {TF_LABEL[dtf]}</h1>
              <div className="flex items-center gap-1 rounded-md border border-white/10 bg-[#0b0f16] p-1">
                {(["1d", "1h", "30m"] as Tf[]).map((x) => (
                  <button key={x} onClick={() => { setTf(x); setRunId(""); setSelected(null); }} className={cx("rounded px-3 py-1 font-mono text-xs", tf === x ? "bg-[#d9a441]/20 text-[#f2c873]" : "text-[#93a1b6] hover:text-white")}>{x === "1d" ? "1D" : x}</button>
                ))}
              </div>
              <span className="font-mono text-[11px] text-[#7f8ca3]">2017 → 2026 · walk-forward split {data?.split ?? "2022-01-01"}</span>
            </div>
            <p className="mt-1 text-xs leading-5 text-[#93a1b6]">
              ICT: expansion = price leaves equilibrium quickly with displacement and leaves FVGs; do not chase it — enter on the retracement into discount (longs) / premium (shorts).
              Displacement = body ≥ {String(run?.params.disp_body ?? "–")}× ATR20 and ≥ 60% of its range, closing through the last confirmed 3-candle swing (BOS).
              Leg = lowest low since that swing → first confirmed swing high after the candle, ≥ {String(run?.params.min_leg ?? "–")}× ATR20 with ≥ 1 FVG.
              Orders work {String(run?.params.max_wait ?? "–")} bars; a new extreme or a close through the origin ends the leg. HTF bias = {run?.params.bias_source ?? "–"}.
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
                  <span className="font-mono text-[11px] text-[#93a1b6]">{r.summary?.legs ?? 0} legs · {pct(r.summary?.touched_eq_pct, 0)} retraced to 50%</span>
                </div>
                <div className="mt-1 text-[11px] leading-4 text-[#93a1b6]">{r.notes}</div>
              </button>
            );
          })}
        </div>
        {run ? (
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-[#7f8ca3]">
            <span>run {run.run_id}</span><span>{run.data_start} → {run.data_end}</span><span>{run.symbols} symbols</span>
            <span>bar-level fills · hard stop · stop checked before target · no target on a limit&apos;s fill bar</span>
          </div>
        ) : null}
        {run?.params.data_quality?.length ? (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-[#d9a441]/30 bg-[#d9a441]/10 px-3 py-2 text-xs text-[#f2c873]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span>Data quality: {run.params.data_quality.join(" · ")}</span>
          </div>
        ) : null}
        {validation ? (() => {
          const rows = [...Object.entries(validation.leg_checks), ...Object.entries(validation.trade_checks)];
          const bad = rows.filter(([, v]) => v.pass !== v.n);
          return (
            <details className={cx("mt-3 rounded-md border px-3 py-2 text-xs", bad.length ? "border-[#e5484d]/40 bg-[#e5484d]/10 text-[#ff9da2]" : "border-[#2fbf71]/30 bg-[#2fbf71]/10 text-[#62d894]")}>
              <summary className="cursor-pointer">
                Independent audit ({validation.validated_at.replace("T", " ")}): {bad.length ? `${bad.length} rule(s) failing` : "every rule re-derived from raw bars matches"} · {validation.checked_legs}/{validation.total_legs} legs · {validation.checked_trades}/{validation.total_trades} closed trades re-checked
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

      <Panel title="What did the expansions do next?" note={`${legTotal} legs`}>
        <div className="grid gap-3 p-4 md:grid-cols-3 xl:grid-cols-5">
          {OUTCOMES.map((f) => {
            const row = outMap[f.id]; const n = row?.n ?? 0; const active = fOut === f.id;
            return (
              <button key={f.id} onClick={() => { setFOut(active ? "" : f.id); setView("legs"); }} className={cx("rounded-md border p-3 text-left transition", f.tone, active && "ring-1 ring-white/40")}>
                <div className="text-[11px] font-semibold uppercase">{f.label}</div>
                <div className="mt-2 flex items-baseline gap-2"><span className="font-mono text-3xl font-semibold">{n}</span><span className="font-mono text-xs opacity-80">{legTotal ? pct((n / legTotal) * 100, 0) : ""}</span></div>
                <div className="mt-1 font-mono text-[11px] text-[#a9b5c9]">{row ? `med retrace ${pct(row.med_retrace, 0)} · leg ${f2(row.med_leg_atr, 1)}× ATR` : ""}</div>
                <div className="mt-2 text-[11px] leading-4 text-[#a9b5c9]">{f.help}</div>
              </button>
            );
          })}
        </div>
        <div className="overflow-x-auto px-4 pb-4">
          <div className="mb-2 text-xs text-[#93a1b6]">ICT check — expansions are meant to resume from a retracement into discount / OTE. Legs whose deepest pullback reached…</div>
          <table className="w-full text-xs">
            <thead><tr className="border-b border-white/10"><th className={th}>Deepest retracement</th><th className={th}>Legs</th><th className={th}>Then took the extreme</th><th className={th}>Then failed through the origin</th><th className={th}>Unresolved / active</th></tr></thead>
            <tbody>
              {(data?.ictTest ?? []).map((r) => (
                <tr key={r.key} className="border-b border-white/5"><td className="px-2 py-1.5">{r.key.slice(4)}</td><td className={td}>{r.n}</td>
                  <td className={cx(td, "text-[#62d894]")}>{r.continued} · {pct((r.continued / r.n) * 100, 0)}</td>
                  <td className={cx(td, "text-[#ff8b91]")}>{r.failed} · {pct((r.failed / r.n) * 100, 0)}</td>
                  <td className={td}>{r.unresolved}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Trade models" note="Click a cell to load its trades. R per trade, risk-filtered by default." right={
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
                    <td className="py-1 pr-2">{OUTCOME_LABEL[s.key] ?? s.key}</td><td className="py-1 text-right font-mono text-[#93a1b6]">{s.n}</td>
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
            {chart.leg ? <ExpansionIctChart key={`${chart.leg.sym}${chart.leg.disp_date}${chart.trade?.trade_id ?? ""}`} tf={dtf} leg={chart.leg} trade={chart.trade} targetLabel={chart.trade ? TARGET_LABEL[chart.trade.target] : undefined} /> : null}
          </div>
        </Panel>
      ) : null}

      <Panel title={view === "trades" ? `Trades · ${modelDef.label} → ${TARGET_LABEL[target]}` : "Expansion legs"} note={`showing ${view === "trades" ? data?.trades.length ?? 0 : data?.legs.length ?? 0} of ${view === "trades" ? data?.totals.trades ?? 0 : data?.totals.legs ?? 0} (most recent first, list capped at ${data?.listCap ?? 0})`} right={
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="flex items-center gap-1 rounded-md border border-white/10 bg-[#0b0f16] p-1">
            {(["trades", "legs"] as const).map((v) => <button key={v} onClick={() => setView(v)} className={cx("rounded px-2 py-0.5", view === v ? "bg-[#d9a441]/20 text-[#f2c873]" : "text-[#93a1b6]")}>{v === "trades" ? "Trades" : "Legs"}</button>)}
          </div>
          <select value={fSym} onChange={(e) => setFSym(e.target.value)} className="rounded border border-white/10 bg-[#0b0f16] px-2 py-1">
            <option value="">All symbols</option>{(data?.totals.symbols ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={fOut} onChange={(e) => setFOut(e.target.value)} className="rounded border border-white/10 bg-[#0b0f16] px-2 py-1">
            <option value="">All leg outcomes</option>{OUTCOMES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <button onClick={() => downloadRows((view === "trades" ? data?.trades : data?.legs) as unknown as Record<string, unknown>[] ?? [], `expansion_${dtf}_${view}.csv`)} className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[#93a1b6] hover:text-white"><Download className="size-3" /> CSV</button>
        </div>}>
        <div className="max-h-[560px] overflow-auto">
          {view === "trades" ? (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[#101620]"><tr className="border-b border-white/10">{["Symbol", "Side", "Entry", "Entry px", "Stop", "Target", "Risk %", "HTF", "Leg outcome", "Outcome", "R", "%", "Exit", "MFE R"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
              <tbody>{(data?.trades ?? []).map((t) => (
                <tr key={t.trade_id} onClick={() => setSelected({ type: "trade", row: t })} className={cx("cursor-pointer border-b border-white/5 hover:bg-white/5", selected?.type === "trade" && selected.row.trade_id === t.trade_id && "bg-[#d9a441]/10")}>
                  <td className="px-2 py-1.5 font-semibold">{t.sym}</td><td className={cx("px-2", t.side === "bull" ? "text-[#62d894]" : "text-[#ff8b91]")}>{t.side === "bull" ? "Long" : "Short"}</td>
                  <td className={td}>{t.entry_date}</td><td className={td}>{f2(t.entry)}</td><td className={td}>{f2(t.stop)}</td><td className={td}>{f2(t.tgt)}</td><td className={td}>{pct(t.risk_pct, 2)}</td>
                  <td className="px-2">{t.with_bias == null ? "–" : t.with_bias ? "with" : "against"}</td><td className="px-2 text-[#93a1b6]">{t.leg_outcome ? OUTCOME_LABEL[t.leg_outcome] ?? t.leg_outcome : "–"}</td>
                  <td className="px-2">{t.outcome}</td><td className={cx(td, toneR(t.r))}>{signed(t.r)}</td><td className={cx(td, toneR(t.pct))}>{signed(t.pct, 2, "%")}</td><td className={td}>{t.exit_date}</td><td className={td}>{f2(t.mfe_r)}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[#101620]"><tr className="border-b border-white/10">{["Symbol", "Side", "Displacement", "Origin", "Extreme", "× ATR", "Body × ATR", "FVGs", "Origin sweep", "HTF bias", "Deepest retrace", "Outcome"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
              <tbody>{(data?.legs ?? []).map((b) => (
                <tr key={b.leg_id} onClick={() => setSelected({ type: "leg", row: b })} className={cx("cursor-pointer border-b border-white/5 hover:bg-white/5", selected?.type === "leg" && selected.row.leg_id === b.leg_id && "bg-[#d9a441]/10")}>
                  <td className="px-2 py-1.5 font-semibold">{b.sym}</td><td className={cx("px-2", b.side === "bull" ? "text-[#62d894]" : "text-[#ff8b91]")}>{b.side === "bull" ? "Bullish" : "Bearish"}</td>
                  <td className={td}>{b.disp_date}</td><td className={td}>{f2(b.origin)}</td><td className={td}>{f2(b.ext)}</td><td className={td}>{f2(b.leg_atr, 1)}</td><td className={td}>{f2(b.disp_body_atr)}</td>
                  <td className={td}>{b.fvg_count}</td><td className="px-2">{b.origin_sweep ? "yes" : "no"}</td><td className="px-2">{biasLabel(b.htf_bias)}</td><td className={td}>{pct(b.retrace_pct, 0)}</td>
                  <td className="px-2 text-[#93a1b6]">{OUTCOME_LABEL[b.outcome] ?? b.outcome}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </Panel>
    </div>
  );
}
