"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Download, RefreshCw, Triangle } from "lucide-react";
import AmdIctChart, { type AmdCycle, type AmdTrade } from "./amd-ict-chart";

// ICT Power of Three / AMD study: cycles and trades written by scripts/amd/amd_engine.py, audited by scripts/amd/validate_amd.py.

type Tf = "1d" | "1h" | "30m";
type Validation = {
  checked_cycles: number; total_cycles: number; checked_trades: number; total_trades: number; validated_at: string; failures: string[];
  cycle_checks: Record<string, { pass: number; n: number }>; trade_checks: Record<string, { pass: number; n: number }>;
};
type Run = {
  run_id: string; config_name: string; family: "structural" | "session"; timeframe: Tf; period: string; notes: string; data_start: string; data_end: string; symbols: number;
  params: Record<string, unknown> & { h_mult?: number; mss_body?: number; data_quality?: string[]; bias_source?: string; min_risk_pct?: number; min_bars?: number; max_dist?: number };
  summary: { cycles?: number; outcomes?: Record<string, number>; validation?: Validation };
};
type Stat = { n: number; wins: number; losses: number; timeouts: number; avg_r: number | null; avg_r_cost: number | null; sum_r: number | null; avg_pct: number | null; med_r: number | null; med_risk_pct: number | null; med_hold_h: number | null; pf: number | null };
type GridRow = Stat & { model: string; target: string; n_is: number; r_is: number | null; n_oos: number; r_oos: number | null };
type SegRow = Stat & { dim: string; key: string };
type OutcomeRow = { outcome: string; n: number; with_bias: number; med_bars: number | null; med_depth: number | null };
type IctRow = { key: string; n: number; delivered: number; failed: number; mss: number; unresolved: number };
type Cycle = AmdCycle & { run_id: string; cycle_id: string; acc_bars: number | null; sweep_depth_pct: number | null; manip_time: string | null; expected_dir: string | null; with_bias: boolean | null; pd_pos: number | null };
type Trade = AmdTrade & {
  run_id: string; trade_id: string; cycle_id: string; sym: string; family: "structural" | "session"; plan_r: number | null; pct: number; risk_pct: number; bars_held: number;
  risk_ok: boolean; htf_bias: number; with_bias: boolean | null; cycle_outcome: string; mfe_r: number | null; hold_h: number | null;
  acc_start: string; acc_confirm: string; acc_hi: number | null; acc_lo: number | null; ce: number | null; atr: number | null; acc_bars: number | null;
  eqh: AmdCycle["eqh"]; eql: AmdCycle["eql"]; pd_pos: number | null; cycle_end: string; manip_side: "up" | "dn" | null; manip_kind: string | null;
  pierce_date: string | null; return_date: string | null; sweep_extreme: number | null; sweep_depth_pct: number | null; manip_time: string | null;
  mss_date: string | null; mss_level: number | null; mss_swing_date: string | null; fvg: AmdCycle["fvg"]; true_open: number | null; pdh: number | null; pdl: number | null; day: string | null;
};
type Payload = {
  ok: boolean; error?: string; runs: Run[]; runId: string; timeframe: Tf; family: "structural" | "session"; split: string; grid: GridRow[]; segments: SegRow[];
  outcomes: OutcomeRow[]; ictTest: IctRow[]; cycles: Cycle[]; trades: Trade[]; totals: { cycles: number; trades: number; symbols: string[] | null }; listCap: number;
};
type Selected = { type: "cycle"; row: Cycle } | { type: "trade"; row: Trade } | null;

const TF_LABEL: Record<Tf, string> = { "1d": "Daily", "1h": "1 hour", "30m": "30 minute" };
const S_TARGETS = ["liq_2R", "opp_edge", "ext_pool", "CE", "fib_1.5", "2R"];
const MODELS: Record<"structural" | "session", { id: string; label: string; help: string; targets: string[] }[]> = {
  structural: [
    { id: "MSS_FVG", label: "MSS → FVG CE", help: "Require a new displacement close through a confirmed swing, including on the raid/reclaim candle. Select a fresh displacement FVG at MSS close, otherwise MSS+1. Activate only after BOTH confirmations, for 10 bars. Cancel on stop breach or prior delivery to the opposite edge. Stop = sweep extreme ∓ 0.1 × ATR. Versioned local thresholds; completed-candle execution proxy.", targets: S_TARGETS },
    { id: "MSS_FVG_EDGE", label: "MSS → FVG edge (comparison)", help: "Separate shallow-retracement model: same completed MSS and fresh three-candle displacement FVG, limit at the near edge plus $0.01 for longs / minus $0.01 for shorts. Activate after both confirmations. The intended entry level must be unfilled before activation. Keep separate from CE; these are alternative entries, not extra portfolio positions. Equity tick and all numerical thresholds are local choices.", targets: S_TARGETS },
    { id: "MSS_CLOSE", label: "MSS close", help: "Market at the open after the MSS candle. Stop = sweep extreme ∓ 0.1 × ATR.", targets: S_TARGETS },
    { id: "RETURN_CLOSE", label: "Return close (indicator-style)", help: "What the public Po3 indicators do: buy/sell the open after the raid closes back inside — no MSS confirmation. Stop = sweep extreme ∓ 0.4 × ATR. Baseline.", targets: S_TARGETS },
  ],
  session: [
    { id: "PO3_SESSION", label: "RTH proxy (raid → open reclaim)", help: "Equity RTH adaptation: raid ≥ 0.1 × prior daily ATR through the 09:30 session open, raid candle complete by 11:00 and reclaim complete before noon → next open. Stop = raid extreme ∓ 0.1 × ATR. Exchange-calendar session close, including early closes. Missing tails remain open. Overnight accumulation and midnight open are unavailable.", targets: ["EOD", "PDH_PDL", "2R", "3R"] },
  ],
};
const TARGET_LABEL: Record<string, string> = {
  liq_2R: "First liquidity ≥ 2R", opp_edge: "Opposite edge (EQH/EQL)", ext_pool: "External pool (unswept swing)", CE: "Range CE 50%",
  "fib_1.5": "1.5 fib ext of the raid", "2R": "2R (fixed)", "3R": "3R (fixed)", PDH_PDL: "PDH / PDL (prior-day liquidity)", EOD: "Hold to 16:00 close",
};
const OUTCOMES: Record<"structural" | "session", { id: string; label: string; tone: string; help: string }[]> = {
  structural: [
    { id: "distribution_complete", label: "Full AMD: raid → MSS → opposite edge", tone: "text-[#62d894] border-[#2fbf71]/30 bg-[#2fbf71]/10", help: "Textbook Power of Three: raid returned, MSS printed, price delivered to the opposite pool" },
    { id: "distribution_no_mss", label: "Delivered without MSS", tone: "text-[#8edfff] border-[#64d2ff]/30 bg-[#64d2ff]/10", help: "Opposite edge reached before any qualifying MSS — no confirmed entry" },
    { id: "manipulation_failed", label: "Raid failed (closed beyond sweep)", tone: "text-[#ff8b91] border-[#e5484d]/30 bg-[#e5484d]/10", help: "A close beyond the sweep extreme — the raid was the real move" },
    { id: "breakout_no_manipulation", label: "Breakout, no return", tone: "text-[#d6deec] border-white/20 bg-white/5", help: "Closed beyond an edge and stayed out ≥ 3 bars — expansion, not AMD" },
    { id: "news_reset", label: "Both sides in one bar", tone: "text-[#f2c873] border-[#d9a441]/30 bg-[#d9a441]/10", help: "Both edges taken on one bar — no read" },
    { id: "unresolved", label: "Unresolved", tone: "text-[#f2c873] border-[#d9a441]/30 bg-[#d9a441]/10", help: "Neither side resolved within the distribution window" },
  ],
  session: [
    { id: "po3_day_complete", label: "Po3 day: closed beyond open", tone: "text-[#62d894] border-[#2fbf71]/30 bg-[#2fbf71]/10", help: "Judas, reclaim, and the session closed on the expected side of the open" },
    { id: "po3_day_failed", label: "Po3 day failed", tone: "text-[#ff8b91] border-[#e5484d]/30 bg-[#e5484d]/10", help: "Trigger printed, but the session closed back on the Judas side" },
    { id: "no_judas", label: "No Judas / no reclaim", tone: "text-[#d6deec] border-white/20 bg-white/5", help: "No qualifying Judas before 11:00 or no reclaim before 12:00 — no trade" },
  ],
};

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

export default function AmdDashboard() {
  const [tf, setTf] = useState<Tf>("1d");
  const [runId, setRunId] = useState("");
  const [model, setModel] = useState("");
  const [target, setTarget] = useState("");
  const [bias, setBias] = useState<"all" | "with" | "against">("all");
  const [riskOnly, setRiskOnly] = useState(true);
  const [fSym, setFSym] = useState("");
  const [fOut, setFOut] = useState("");
  const [view, setView] = useState<"cycles" | "trades">("trades");
  const [selected, setSelected] = useState<Selected>(null);
  const [nonce, setNonce] = useState(0);
  const [data, setData] = useState<Payload | null>(null);
  const [state, setState] = useState<{ key: string; error?: string }>({ key: "" });

  const query = useMemo(() => {
    const qs = new URLSearchParams({ tf, bias, min_risk: String(riskOnly), sym: fSym, outcome: fOut });
    if (runId) qs.set("run", runId);
    if (model) qs.set("model", model);
    if (target) qs.set("target", target);
    return qs.toString();
  }, [tf, runId, model, target, bias, riskOnly, fSym, fOut]);
  const reqKey = `${query}#${nonce}`;
  const loading = state.key !== reqKey;
  const error = state.key === reqKey ? state.error : undefined;

  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/amd?${query}`, { cache: "no-store", signal: ctl.signal })
      .then((r) => r.json() as Promise<Payload>)
      .then((j) => { if (!j.ok) throw new Error(j.error || "Load failed"); setData(j); setState({ key: reqKey }); })
      .catch((e) => { if (e?.name !== "AbortError") { setData(null); setState({ key: reqKey, error: e instanceof Error ? e.message : String(e) }); } });
    return () => ctl.abort();
  }, [query, reqKey]);

  const dtf: Tf = data?.timeframe ?? tf;
  const family = data?.family ?? "structural";
  const run = data?.runs.find((r) => r.run_id === data.runId);
  const tfRuns = (data?.runs ?? []).filter((r) => r.timeframe === dtf);
  const models = MODELS[family];
  const curModel = models.find((m) => m.id === model) ?? models[0];
  const curTarget = curModel.targets.includes(target) ? target : curModel.targets[0];
  const outDefs = OUTCOMES[family];
  const outLabel = useMemo(() => Object.fromEntries([...OUTCOMES.structural, ...OUTCOMES.session].map((f) => [f.id, f.label])), []);
  const outMap = useMemo(() => Object.fromEntries((data?.outcomes ?? []).map((f) => [f.outcome, f])), [data]);
  const cycTotal = (data?.outcomes ?? []).reduce((a, f) => a + f.n, 0);
  const segDims = useMemo(() => {
    const m = new Map<string, SegRow[]>();
    for (const s of data?.segments ?? []) m.set(s.dim, [...(m.get(s.dim) ?? []), s]);
    return Array.from(m.entries());
  }, [data]);
  const validation = run?.summary?.validation;
  const mssBody = String(run?.params.mss_body ?? "–");
  const hMult = String(run?.params.h_mult ?? "–");

  const chart = useMemo(() => {
    if (!selected || selected.row.run_id !== data?.runId) return null;
    const t = selected.type === "trade" ? selected.row : null;
    const c: AmdCycle = selected.type === "cycle" ? selected.row : {
      family: t!.family, sym: t!.sym, outcome: t!.cycle_outcome, htf_bias: t!.htf_bias, acc_start: t!.acc_start, acc_confirm: t!.acc_confirm,
      acc_hi: t!.acc_hi, acc_lo: t!.acc_lo, ce: t!.ce, atr: t!.atr, eqh: t!.eqh, eql: t!.eql, end_date: t!.cycle_end, manip_side: t!.manip_side,
      manip_kind: t!.manip_kind, pierce_date: t!.pierce_date, return_date: t!.return_date, sweep_extreme: t!.sweep_extreme, mss_date: t!.mss_date,
      mss_level: t!.mss_level, mss_swing_date: t!.mss_swing_date, fvg: t!.fvg_evidence ?? t!.fvg, true_open: t!.true_open, pdh: t!.pdh, pdl: t!.pdl, day: t!.day,
    };
    const bull = c.manip_side === "dn";
    const depth = selected.type === "cycle" ? selected.row.sweep_depth_pct : t!.sweep_depth_pct;
    const notes: string[] = [];
    if (c.family === "session") {
      notes.push(`A · True day open ${f2(c.true_open)} (09:30 RTH open). Prior-day liquidity: PDH ${f2(c.pdh)} (buy stops), PDL ${f2(c.pdl)} (sell stops). Daily ATR20 (prior day) ${f2(c.atr)}.`);
      if (c.pierce_date) {
        notes.push(`M · Judas swing ${bull ? "below" : "above"} the open: extreme ${f2(c.sweep_extreme)} at ${c.pierce_date} (${pct(depth, 0)} of daily ATR${c.manip_kind === "swept_PDL" ? ", took the prior-day low" : c.manip_kind === "swept_PDH" ? ", took the prior-day high" : c.manip_kind === "opened_outside_prior_range" ? "; the day opened outside the prior-day range (gap), so no prior-day pool was raided" : ", inside the prior-day range"}).`);
        notes.push(`D · ${c.return_date}: first close back ${bull ? "above" : "below"} the open before 12:00 → decision bar. Session ${c.outcome === "po3_day_complete" ? "closed on the expected side of the open" : "closed back on the Judas side"}.`);
      } else notes.push("No Judas move ≥ 0.1 × daily ATR before 11:00, or no reclaim of the open before 12:00 → no trade.");
    } else {
      notes.push(`A · Accumulation ${c.acc_start} → confirmed ${c.acc_confirm}: range ${f2(c.acc_lo)}–${f2(c.acc_hi)}, CE ${f2(c.ce)}, span ≤ ${hMult}× ATR20 with ≥ 2 equal highs (BSL) and ≥ 2 equal lows (SSL). Edges frozen at confirmation.`);
      if (c.pierce_date && c.return_date) {
        notes.push(`M · ${bull ? "Sell-side (EQL)" : "Buy-side (EQH)"} raid ${c.pierce_date}: ${c.manip_kind === "2B" ? "closed beyond the edge and was reclaimed within 3 bars (2B / Judas)" : "wick beyond the edge, closed back inside"}; sweep extreme ${f2(c.sweep_extreme)} (${pct(depth, 0)} of range), back inside ${c.return_date}. Expected distribution: ${bull ? "up to BSL" : "down to SSL"}.`);
        notes.push(c.mss_date ? `D · MSS ${c.mss_date}: displacement (body ≥ ${mssBody}× ATR20) closed ${bull ? "above" : "below"} the internal swing ${f2(c.mss_level)} (${c.mss_swing_date}).` : "D · No MSS printed before the cycle resolved.");
      } else notes.push(c.outcome === "breakout_no_manipulation" ? "M · The first edge event was a close beyond that was NOT reclaimed within 3 bars → breakout, not a manipulation. No trade." : `Outcome: ${outLabel[c.outcome] ?? c.outcome}.`);
      notes.push(`Cycle outcome: ${outLabel[c.outcome] ?? c.outcome} · HTF order flow ${biasLabel(c.htf_bias).toUpperCase()}.`);
    }
    if (t) {
      const m = MODELS[t.family].find((x) => x.id === t.model);
      notes.push(`Trade · ${m?.label}: signal decision ${t.decision_date} → ${t.side === "bull" ? "BUY" : "SELL"} ${t.entry_date} @ ${f2(t.entry)}, SL ${f2(t.stop)} (${pct(t.risk_pct, 2)}), TP ${TARGET_LABEL[t.target] ?? t.target}${t.tgt != null ? ` ${f2(t.tgt)} (${f2(t.plan_r, 1)}R planned)` : ""} → ${t.outcome.toUpperCase()} ${signed(t.r, 2, "R")} on ${t.exit_date} (best excursion ${f2(t.mfe_r)}R).`);
      const et = (v: string) => new Date(v).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
      if (t.decision_known_at) notes.push(`Causal clock (ET) · required inputs complete ${et(t.decision_known_at)}${t.mss_known_at ? ` · MSS complete ${et(t.mss_known_at)}` : ""}${t.fvg_known_at ? ` · FVG complete ${et(t.fvg_known_at)}` : ""}${t.order_active_at ? ` · order eligible ${et(t.order_active_at)}` : ""}. Entry is a subsequent-bar OHLC proxy, not a broker-confirmed fill.`);
    }
    const title = t
      ? `${t.sym} · ${TF_LABEL[dtf]} · ${MODELS[t.family].find((x) => x.id === t.model)?.label} · ${t.side === "bull" ? "Long" : "Short"} · ${t.outcome.toUpperCase()} ${signed(t.r, 2, "R")}`
      : `${c.sym} · ${TF_LABEL[dtf]} · ${outLabel[c.outcome] ?? c.outcome}`;
    return { cycle: c, trade: t, title, notes };
  }, [selected, data?.runId, dtf, mssBody, hMult, outLabel]);

  if (run && run.params.spec_version !== "amd-local-v2.1") return <div className="rounded-md border border-[#e5484d]/40 p-4 text-sm text-[#ff9da2]">Legacy AMD results are quarantined. Refresh to load corrected research runs.</div>;

  const th = "px-2 py-2 text-left font-medium text-[#7f8ca3]";
  const td = "px-2 py-1.5 font-mono";
  return (
    <div className="space-y-5">
      <section className="rounded-md border border-white/10 bg-[#101620] p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="grid size-9 place-items-center rounded-md border border-[#d9a441]/30 bg-[#d9a441]/10"><Triangle className="size-4 text-[#f2c873]" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-lg font-semibold">AMD · Power of Three · {TF_LABEL[dtf]}</h1>
              <div className="flex items-center gap-1 rounded-md border border-white/10 bg-[#0b0f16] p-1">
                {(["1d", "1h", "30m"] as Tf[]).map((x) => (
                  <button key={x} onClick={() => { setTf(x); setRunId(""); setModel(""); setTarget(""); setFOut(""); setSelected(null); }} className={cx("rounded px-3 py-1 font-mono text-xs", tf === x ? "bg-[#d9a441]/20 text-[#f2c873]" : "text-[#93a1b6] hover:text-white")}>{x === "1d" ? "1D" : x}</button>
                ))}
              </div>
              <span className="font-mono text-[11px] text-[#7f8ca3]">Historical research · retrospective split {data?.split ?? "2022-01-01"}</span>
            </div>
            <p className="mt-1 text-xs leading-5 text-[#93a1b6]">
              {family === "session"
                ? "Equity RTH proxy: 09:30 session open, raid completed by 11:00 and reclaim completed before noon. Targets are prior-day liquidity or fixed R. Complete sessions exit at the exchange close; missing tails remain unresolved. This feed does not contain overnight accumulation or ICT's midnight open."
                : "Accumulation = the Consolidation tab's box (equal highs = buy stops, equal lows = sell stops). Manipulation = the first raid of an edge that comes back (wick or 2B reclaimed within 3 bars) — a close beyond that stays out is an Expansion, not AMD. Distribution = the Reversal tab's MSS (displacement closing through the last internal swing) toward the opposite pool. Stops sit beyond the liquidity that was taken; targets are the next resting liquidity, all frozen at the decision bar."}
              {" "}HTF bias = {run?.params.bias_source ?? "–"}.
            </p>
          </div>
          <button onClick={() => setNonce((n) => n + 1)} className="flex h-9 items-center gap-2 rounded-md border border-white/10 px-3 text-xs text-[#93a1b6] hover:text-white">
            <RefreshCw className={cx("size-3.5", loading && "animate-spin")} /> Refresh
          </button>
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-3">
          {tfRuns.map((r) => {
            const active = r.run_id === data?.runId;
            return (
              <button key={r.run_id} onClick={() => { setRunId(r.run_id); setModel(""); setTarget(""); setFOut(""); setSelected(null); }} className={cx("rounded-md border p-3 text-left transition", active ? "border-[#d9a441]/60 bg-[#d9a441]/10" : "border-white/10 bg-[#0b0f16] hover:border-white/25")}>
                <div className="flex items-center justify-between gap-2">
                  <span className={cx("font-mono text-xs font-semibold", active ? "text-[#f2c873]" : "text-white")}>{r.family === "session" ? "session Po3" : r.config_name}</span>
                  <span className="font-mono text-[11px] text-[#93a1b6]">{r.summary?.cycles ?? 0} {r.family === "session" ? "days" : "cycles"}</span>
                </div>
                <div className="mt-1 text-[11px] leading-4 text-[#93a1b6]">{r.notes}</div>
              </button>
            );
          })}
        </div>
        {run ? (
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-[#7f8ca3]">
            <span>run {run.run_id}</span><span>{run.data_start} → {run.data_end}</span><span>{run.symbols} symbols</span>
            <span>V2 raw completed bars · MSS + FVG known before activation · research only · stop first on ambiguous bars</span>
          </div>
        ) : null}
        {run?.params.data_quality?.length ? (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-[#d9a441]/30 bg-[#d9a441]/10 px-3 py-2 text-xs text-[#f2c873]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span>Data quality: {run.params.data_quality.join(" · ")}</span>
          </div>
        ) : null}
        {validation ? (() => {
          const rows = [...Object.entries(validation.cycle_checks), ...Object.entries(validation.trade_checks)];
          const bad = rows.filter(([, v]) => v.pass !== v.n);
          return (
            <details className={cx("mt-3 rounded-md border px-3 py-2 text-xs", bad.length ? "border-[#e5484d]/40 bg-[#e5484d]/10 text-[#ff9da2]" : "border-[#2fbf71]/30 bg-[#2fbf71]/10 text-[#62d894]")}>
              <summary className="cursor-pointer">
                Causality checks ({validation.validated_at.replace("T", " ")}): {bad.length ? `${bad.length} rule(s) failing` : "recorded timing and geometry checks pass"} · {validation.checked_cycles}/{validation.total_cycles} cycles · {validation.checked_trades}/{validation.total_trades} trade rows · exit replay sampled separately; live discovery unverified
              </summary>
              <div className="mt-2 grid gap-x-6 gap-y-0.5 font-mono text-[11px] text-[#a9b5c9] md:grid-cols-2">
                {rows.map(([k, v]) => <span key={k} className={v.pass === v.n ? "" : "text-[#ff9da2]"}>{v.pass === v.n ? "✓" : "✗"} {k}: {v.pass}/{v.n}</span>)}
              </div>
              {validation.failures.length ? <div className="mt-2 font-mono text-[10px] text-[#ff9da2]">{validation.failures.slice(0, 8).join(" · ")}</div> : null}
            </details>
          );
        })() : <div className="mt-3 rounded-md border border-[#d9a441]/30 bg-[#d9a441]/10 px-3 py-2 text-xs text-[#f2c873]">Not yet audited — run scripts/amd/validate_amd.py.</div>}
        {error ? <div className="mt-3 rounded-md bg-[#e5484d]/10 px-3 py-2 text-sm text-[#ff9da2]">{error}</div> : null}
      </section>

      <Panel title={family === "session" ? "What did the sessions do?" : "What happened after each accumulation?"} note={`${cycTotal} ${family === "session" ? "days" : "cycles"}`}>
        <div className={cx("grid gap-3 p-4", family === "session" ? "md:grid-cols-3" : "md:grid-cols-3 xl:grid-cols-6")}>
          {outDefs.map((f) => {
            const row = outMap[f.id]; const n = row?.n ?? 0; const active = fOut === f.id;
            return (
              <button key={f.id} onClick={() => { setFOut(active ? "" : f.id); setView("cycles"); }} className={cx("rounded-md border p-3 text-left transition", f.tone, active && "ring-1 ring-white/40")}>
                <div className="text-[11px] font-semibold uppercase">{f.label}</div>
                <div className="mt-2 flex items-baseline gap-2"><span className="font-mono text-3xl font-semibold">{n}</span><span className="font-mono text-xs opacity-80">{cycTotal ? pct((n / cycTotal) * 100, 0) : ""}</span></div>
                <div className="mt-1 font-mono text-[11px] text-[#a9b5c9]">{row && row.med_depth != null ? `med raid depth ${pct(row.med_depth, 0)}${family === "session" ? " ATR" : ""}` : ""}</div>
                <div className="mt-2 text-[11px] leading-4 text-[#a9b5c9]">{f.help}</div>
              </button>
            );
          })}
        </div>
        <div className="overflow-x-auto px-4 pb-4">
          <div className="mb-2 text-xs text-[#93a1b6]">
            ICT check — after liquidity is raided on one side and price returns, it should be delivered to the other side.{" "}
            {family === "session" ? "Days with a Judas + reclaim, by what the Judas took and HTF alignment:" : "Cycles with a qualifying raid, by raid type and HTF alignment:"}
          </div>
          <table className="w-full text-xs">
            <thead><tr className="border-b border-white/10"><th className={th}>Group</th><th className={th}>N</th><th className={th}>{family === "session" ? "Closed beyond the open" : "Reached opposite pool"}</th><th className={th}>{family === "session" ? "Closed back on Judas side" : "Failed through the sweep"}</th>{family === "structural" ? <><th className={th}>MSS printed</th><th className={th}>Unresolved</th></> : null}</tr></thead>
            <tbody>
              {(data?.ictTest ?? []).map((r) => (
                <tr key={r.key} className="border-b border-white/5"><td className="px-2 py-1.5">{r.key}</td><td className={td}>{r.n}</td>
                  <td className={cx(td, "text-[#62d894]")}>{r.delivered} · {pct((r.delivered / r.n) * 100, 0)}</td>
                  <td className={cx(td, "text-[#ff8b91]")}>{r.failed} · {pct((r.failed / r.n) * 100, 0)}</td>
                  {family === "structural" ? <><td className={td}>{r.mss} · {pct((r.mss / r.n) * 100, 0)}</td><td className={td}>{r.unresolved}</td></> : null}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Trade models × liquidity targets" note="Click a row to load its trades. R per trade, risk-filtered by default." right={
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
            <thead><tr className="border-b border-white/10"><th className={th}>Model</th><th className={th}>Target</th><th className={th}>Closed trades</th><th className={th}>Profitable %</th><th className={th}>Avg R</th><th className={th} title="Average R after an assumed 5 bp round-trip cost, converted with each trade's risk %">R after 5bp</th><th className={th}>Median R</th><th className={th}>PF</th><th className={th}>Sum R</th><th className={th}>Avg %</th><th className={th}>Med risk %</th><th className={th}>Med hold</th><th className={th}>Before 2022 R</th><th className={th}>2022+ R</th></tr></thead>
            <tbody>
              {models.flatMap((m) => m.targets.map((tg, i) => {
                const g = data?.grid.find((x) => x.model === m.id && x.target === tg);
                const active = curModel.id === m.id && curTarget === tg;
                return (
                  <tr key={m.id + tg} onClick={() => { setModel(m.id); setTarget(tg); setView("trades"); setSelected(null); }} className={cx("cursor-pointer border-b border-white/5 hover:bg-white/5", active && "bg-[#d9a441]/10")}>
                    <td className="px-2 py-1.5" title={m.help}>{i === 0 ? <span className="font-semibold">{m.label}</span> : ""}</td>
                    <td className="px-2 py-1.5">{TARGET_LABEL[tg]}</td>
                    <td className={td}>{g?.n ?? 0}</td><td className={td}>{g ? pct(wr(g)) : "–"}</td>
                    <td className={cx(td, toneR(g?.avg_r))}>{signed(g?.avg_r, 3)}</td><td className={cx(td, toneR(g?.avg_r_cost))}>{signed(g?.avg_r_cost, 3)}</td><td className={cx(td, toneR(g?.med_r))}>{signed(g?.med_r, 2)}</td>
                    <td className={td}>{f2(g?.pf)}</td>
                    <td className={cx(td, toneR(g?.sum_r))}>{signed(g?.sum_r, 1)}</td><td className={cx(td, toneR(g?.avg_pct))}>{signed(g?.avg_pct, 2, "%")}</td>
                    <td className={td}>{pct(g?.med_risk_pct, 2)}</td><td className={td}>{g?.med_hold_h == null ? "–" : dtf === "1d" ? `${(g.med_hold_h / 24).toFixed(1)}d` : `${g.med_hold_h.toFixed(1)}h`}</td>
                    <td className={cx(td, toneR(g?.r_is))}>{signed(g?.r_is, 3)} <span className="text-[#7f8ca3]">({g?.n_is ?? 0})</span></td>
                    <td className={cx(td, toneR(g?.r_oos))}>{signed(g?.r_oos, 3)} <span className="text-[#7f8ca3]">({g?.n_oos ?? 0})</span></td>
                  </tr>
                );
              }))}
            </tbody>
          </table>
          <p className="mt-3 text-[11px] leading-4 text-[#7f8ca3]">{curModel.label}: {curModel.help} Liquidity targets are only taken when they sit in profit at the decision bar; the external pool is the nearest confirmed swing beyond the opposite edge that had not been traded through by then. Exits are simulated on the {TF_LABEL[dtf]} bars themselves, so a bar that touches both stop and target counts as a loss. The target rows are alternative exits for the same entries — compare them, do not add them up.</p>
        </div>
      </Panel>

      <Panel title={`What separates winners · ${curModel.label} → ${TARGET_LABEL[curTarget]}`} note={bias === "all" ? "" : bias === "with" ? "with HTF bias only" : "against HTF bias only"}>
        <div className="grid gap-3 p-4 lg:grid-cols-2 2xl:grid-cols-3">
          {segDims.map(([dim, rows]) => (
            <div key={dim} className="rounded-md border border-white/10 bg-[#0b0f16] p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase text-[#93a1b6]">{dim}</div>
              <table className="w-full text-xs">
                <tbody>{rows.map((s) => (
                  <tr key={s.key} className="border-b border-white/5 last:border-0">
                    <td className="py-1 pr-2">{outLabel[s.key] ?? s.key}</td><td className="py-1 text-right font-mono text-[#93a1b6]">{s.n}</td>
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
            <AmdIctChart key={`${chart.cycle.sym}${chart.cycle.acc_start}${chart.trade?.trade_id ?? ""}`} tf={dtf} cycle={chart.cycle} trade={chart.trade} targetLabel={chart.trade ? TARGET_LABEL[chart.trade.target] : undefined} />
          </div>
        </Panel>
      ) : null}

      <Panel title={view === "trades" ? `Trades · ${curModel.label} → ${TARGET_LABEL[curTarget]}` : family === "session" ? "Sessions" : "AMD cycles"} note={`showing ${view === "trades" ? data?.trades.length ?? 0 : data?.cycles.length ?? 0} of ${view === "trades" ? data?.totals.trades ?? 0 : data?.totals.cycles ?? 0} (most recent first, list capped at ${data?.listCap ?? 0})`} right={
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="flex items-center gap-1 rounded-md border border-white/10 bg-[#0b0f16] p-1">
            {(["trades", "cycles"] as const).map((v) => <button key={v} onClick={() => setView(v)} className={cx("rounded px-2 py-0.5", view === v ? "bg-[#d9a441]/20 text-[#f2c873]" : "text-[#93a1b6]")}>{v === "trades" ? "Trades" : family === "session" ? "Sessions" : "Cycles"}</button>)}
          </div>
          <select value={fSym} onChange={(e) => setFSym(e.target.value)} className="rounded border border-white/10 bg-[#0b0f16] px-2 py-1">
            <option value="">All symbols</option>{(data?.totals.symbols ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={fOut} onChange={(e) => setFOut(e.target.value)} className="rounded border border-white/10 bg-[#0b0f16] px-2 py-1">
            <option value="">All cycle outcomes (hindsight only)</option>{outDefs.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <button onClick={() => downloadRows((view === "trades" ? data?.trades : data?.cycles) as unknown as Record<string, unknown>[] ?? [], `amd_${dtf}_${run?.config_name ?? ""}_${view}_displayed_rows.csv`)} className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[#93a1b6] hover:text-white"><Download className="size-3" /> CSV (displayed rows)</button>
        </div>}>
        <div className="max-h-[560px] overflow-auto">
          {view === "trades" ? (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[#101620]"><tr className="border-b border-white/10">{["Symbol", "Side", "Decision", "Entry", "Entry px", "Stop", "Target", "Plan R", "Risk %", "HTF", "Cycle", "Outcome", "R", "Exit", "MFE R"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
              <tbody>{(data?.trades ?? []).map((t) => (
                <tr key={t.trade_id} onClick={() => setSelected({ type: "trade", row: t })} className={cx("cursor-pointer border-b border-white/5 hover:bg-white/5", selected?.type === "trade" && selected.row.trade_id === t.trade_id && "bg-[#d9a441]/10")}>
                  <td className="px-2 py-1.5 font-semibold">{t.sym}</td><td className={cx("px-2", t.side === "bull" ? "text-[#62d894]" : "text-[#ff8b91]")}>{t.side === "bull" ? "Long" : "Short"}</td>
                  <td className={td}>{t.decision_date}</td><td className={td}>{t.entry_date}</td><td className={td}>{f2(t.entry)}</td><td className={td}>{f2(t.stop)}</td><td className={td}>{t.tgt == null ? "EOD" : f2(t.tgt)}</td>
                  <td className={td}>{f2(t.plan_r, 1)}</td><td className={td}>{pct(t.risk_pct, 2)}</td>
                  <td className="px-2">{t.with_bias == null ? "–" : t.with_bias ? "with" : "against"}</td><td className="px-2 text-[#93a1b6]">{outLabel[t.cycle_outcome] ?? t.cycle_outcome}</td>
                  <td className="px-2">{t.outcome}</td><td className={cx(td, toneR(t.r))}>{signed(t.r)}</td><td className={td}>{t.exit_date}</td><td className={td}>{f2(t.mfe_r)}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[#101620]"><tr className="border-b border-white/10">{(family === "session"
                ? ["Symbol", "Day", "Open", "PDH", "PDL", "Judas", "Took", "Depth % ATR", "Reclaim", "HTF bias", "Outcome"]
                : ["Symbol", "Confirmed", "Range", "Bars", "Raid", "Type", "Depth %", "Back inside", "MSS", "HTF bias", "Outcome"]).map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
              <tbody>{(data?.cycles ?? []).map((b) => (
                <tr key={b.cycle_id} onClick={() => setSelected({ type: "cycle", row: b })} className={cx("cursor-pointer border-b border-white/5 hover:bg-white/5", selected?.type === "cycle" && selected.row.cycle_id === b.cycle_id && "bg-[#d9a441]/10")}>
                  <td className="px-2 py-1.5 font-semibold">{b.sym}</td>
                  {family === "session" ? <>
                    <td className={td}>{(b.day ?? "").slice(0, 10)}</td><td className={td}>{f2(b.true_open)}</td><td className={td}>{f2(b.pdh)}</td><td className={td}>{f2(b.pdl)}</td>
                    <td className={cx("px-2", b.manip_side === "dn" ? "text-[#62d894]" : b.manip_side === "up" ? "text-[#ff8b91]" : "")}>{b.manip_side ? `${b.manip_side === "dn" ? "below" : "above"} ${f2(b.sweep_extreme)}` : "–"}</td>
                    <td className="px-2">{b.manip_kind ?? "–"}</td><td className={td}>{pct(b.sweep_depth_pct, 0)}</td><td className={td}>{b.return_date ?? "–"}</td>
                  </> : <>
                    <td className={td}>{b.acc_confirm}</td><td className={td}>{f2(b.acc_lo)}–{f2(b.acc_hi)}</td><td className={td}>{b.acc_bars ?? "–"}</td>
                    <td className={cx("px-2", b.manip_side === "dn" ? "text-[#62d894]" : b.manip_side === "up" ? "text-[#ff8b91]" : "")}>{b.manip_side ? `${b.manip_side === "dn" ? "SSL" : "BSL"} ${b.pierce_date}` : "–"}</td>
                    <td className="px-2">{b.manip_kind ?? "–"}</td><td className={td}>{pct(b.sweep_depth_pct, 0)}</td><td className={td}>{b.return_date ?? "–"}</td><td className={td}>{b.mss_date ?? "–"}</td>
                  </>}
                  <td className="px-2">{biasLabel(b.htf_bias)}</td><td className="px-2 text-[#93a1b6]">{outLabel[b.outcome] ?? b.outcome}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </Panel>
    </div>
  );
}
