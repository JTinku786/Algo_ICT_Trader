"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Crosshair, Download, GitBranch, RefreshCw, Target, TrendingDown, TrendingUp } from "lucide-react";
import ReversalChart, { type ChartLine, type ChartMarker } from "./reversal-chart";
import { DailyForwardChart, type EvLabel, type EvNote } from "./daily-forward-chart";

import MssReversalSignals from "./mss-reversal-signals";
import RealtimeOrdersDashboard from "./realtime-orders-dashboard";
import ReversalLiveTrading from "./reversal-live-trading";
import type { ComponentProps } from "react";
import type {MssResult,MssFocus} from "./market-structure-shift";

export default function ReversalDashboard(props:{mssResult:MssResult|null;onInspect:(focus:MssFocus)=>void;onOpenMss:()=>void;onOpenTrade:ComponentProps<typeof RealtimeOrdersDashboard>["onOpenTrade"]}) {
 const [view,setView]=useState("realtime");
 return <div><div className="mb-4 flex flex-wrap gap-2">{[["realtime","Realtime reversals"],["live","Live trading (OANDA)"],["mss","MSS signals"],["historical","Historical study"]].map(([key,label])=><button key={key} onClick={()=>setView(key)} aria-pressed={view===key} className={`rounded border px-4 py-2 ${view===key?"border-yellow-400 text-yellow-300":"border-white/15"}`}>{label}</button>)}</div>{view==="realtime"?<RealtimeOrdersDashboard reversalMode onOpenTrade={props.onOpenTrade}/>:view==="live"?<ReversalLiveTrading/>:view==="mss"?<MssReversalSignals {...props}/>:<HistoricalReversalDashboard mssResult={props.mssResult}/>}</div>;
}

// ET wall-clock label ("YYYY-MM-DD" or "YYYY-MM-DD HH:MM") -> epoch ms. Daily rows sit on the 09:30 session open.
// US DST in 2026 runs Mar 8 - Nov 1 (UTC-4), otherwise UTC-5.
function etMs(label: string): number {
  const day = label.slice(0, 10);
  const time = label.length > 10 ? label.slice(11, 16) : "09:30";
  const dst = day >= "2026-03-08" && day < "2026-11-01";
  return Date.parse(`${day}T${time}:00${dst ? "-04:00" : "-05:00"}`);
}

// Deep link into the Market Structure Shift tab: same ticker, 1H -> 5m, start = end = the entry date,
// with the TF1 levels / TF2 arrays / confirmation of the latest MSS run (or the MSS defaults).
function mssLink(t: { sym: string; side: "bear" | "bull"; entry_date: string }, sel?: MssResult["selection"] | null): string {
  const day = t.entry_date.slice(0, 10);
  const qs = new URLSearchParams({
    tab: "market-structure-shift", symbol: t.sym, tf1: "1h", tf2: "5m", start: day, end: day,
    entry: new Date(etMs(t.entry_date)).toISOString(), dir: t.side === "bear" ? "SELL" : "BUY",
    htf: (sel?.htfKinds ?? ["OB", "BREAKER", "FVG", "IFVG", "BPR", "BSL", "SSL", "PDH", "PDL"]).join(","),
    ltf: (sel?.ltfKinds ?? ["OB", "BREAKER", "FVG", "IFVG", "BPR"]).join(","),
    conf: sel?.confirmation ?? "CHOCH,WICK,CISD,EITHER", scope: sel?.arrayScope ?? "EXISTING", retest: sel?.retestMode ?? "FIRST",
    pivot: String(sel?.pivotStrength ?? 3), carry: String(sel?.carryIn ?? false), cob: String(sel?.candleOrderBlocks ?? false),
  });
  return `/?${qs.toString()}`;
}

function MssLinkBar({ t, sel }: { t: { sym: string; side: "bear" | "bull"; entry_date: string }; sel?: MssResult["selection"] | null }) {
  const href = mssLink(t, sel);
  const [copied, setCopied] = useState(false);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-[#d9a441]/30 bg-[#d9a441]/5 px-3 py-2 text-xs">
      <span className="font-semibold text-[#f2c873]">MSS · 1H → 5m</span>
      <span className="text-[#93a1b6]">{t.sym} · entry {t.entry_date} · {t.side === "bear" ? "SELL" : "BUY"}{sel ? " · fields from your last MSS run" : " · MSS default fields"}</span>
      <a href={href} className="rounded bg-[#d9a441] px-3 py-1 font-semibold text-black hover:bg-[#f2c873]">Open in MSS tab</a>
      <a href={href} target="_blank" rel="noopener noreferrer" className="rounded border border-white/15 px-3 py-1 text-[#d6deec] hover:bg-white/5">New window</a>
      <button className="rounded border border-white/15 px-3 py-1 text-[#d6deec] hover:bg-white/5"
        onClick={() => { void navigator.clipboard?.writeText(window.location.origin + href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
        {copied ? "Copied" : "Copy link"}
      </button>
      <code className="w-full truncate font-mono text-[10px] text-[#7f8ca3]" title={href}>{href}</code>
    </div>
  );
}

// ---------------------------------------------------------------- types
type Tf = "1d" | "1h" | "30m";
type Run = {
  run_id: string;
  config_name: string;
  timeframe: Tf;
  period?: string;
  notes: string;
  data_start: string;
  data_end: string;
  symbols: number;
  params: Record<string, unknown> & { data_quality?: string[]; piv_k?: number; reclaim?: number; reversal_move_pct?: number; sources?: string[] };
  summary: { audit?: Record<string, number>; audit_total?: number; signals?: number };
};
type Stat = {
  n: number; wins: number; losses: number; timeouts: number;
  avg_r: number | null; avg_r_capped: number | null; sum_r: number | null; avg_pct: number | null; med_risk_pct: number | null; med_bars: number | null;
  med_r?: number | null; p05_r?: number | null; p95_r?: number | null; avg_hold_h?: number | null; med_hold_h?: number | null;
};
type GridRow = Stat & { model: string; target: string; stop_mode: string; n_is?: number; capped_is?: number | null; n_oos?: number; capped_oos?: number | null };
type SegRow = Stat & { dim: string; key: string };
type Trade = {
  trade_id: string; signal_id: string; sym: string; lookback: number; side: "bear" | "bull"; kind: "wick" | "2B";
  model: string; target: string; stop_mode: string; sweep_date: string; reclaim_date: string; mss_date: string;
  setup_valid?: boolean | null; setup_validation?: Record<string, unknown> | null; filled_at?: string | null; decision_known_at?: string | null;
  exit_price?: number | null; exit_verified?: boolean; exit_evidence?: Record<string, unknown>;
  entry_date: string; exit_date: string; entry: number; stop: number; tgt: number; plan_r: number; outcome: string;
  r: number; pct: number; risk_pct: number; bars_held: number; htf: string; pd_pos: number | null; is_primary: boolean;
  swept_level: number; internal_level: number; opposite_liquidity: number; bars_to_mss: number;
  mss_body_ratio: number; mss_range_pct: number; fvg_count: number;
  htf_bias?: number | null; level_age?: number | null; reclaim_by_gap?: boolean | null;
  sw_fvg_with?: number | null; sw_fvg_against?: number | null; sw_ob?: boolean | null; entry_in_fvg?: boolean | null; entry_in_ob?: boolean | null;
  pd_between?: { kind: "FVG" | "OB"; dir: "with" | "against"; bottom: number; top: number; time: string }[] | null;
  mfe_r?: number | null; post_stop_r?: number | null; hold_h?: number | null; risk_ok?: boolean | null;
  swept_windows?: number | null; windows_same_level?: boolean | null; swept_120?: boolean | null; swept_252?: boolean | null; sweep_depth_pct?: number | null;
  pd_beyond?: { kind: "FVG" | "OB"; bottom: number; top: number; time: string; dist_pct: number }[] | null; pd_beyond_n?: number | null; pd_beyond_near_pct?: number | null;
  ltf_1h?: string | null; ltf_30m?: string | null;
};
type SortKey = "sym" | "side" | "kind" | "lookback" | "sweep_date" | "mss_date" | "entry_date" | "entry" | "stop" | "tgt" | "risk_pct" | "htf"
  | "setup_valid" | "exit_verified" | "outcome" | "r" | "pct" | "exit_date" | "hold_h" | "bars_held" | "pd_beyond_n" | "ltf_1h" | "ltf_30m";
type AuditRow = {
  sym: string; pivot_date: string; side: "bear" | "bull"; pivot_price: number; move_pct: number; category: string;
  lookbacks_caught: string; sweep_fate: string | null; htf: string; internal_sweep: boolean;
  mss_lag_bars: number | null; move_used_at_mss_pct: number | null; signal_id: string | null;
};
type FateRow = { lookback: number; fate: string; n: number; med_internal_dist_pct: number | null; med_mfe20_pct: number | null; med_mae20_pct: number | null };
type EventRow = { lookback: number; typ: string; n: number };
type Payload = {
  ok: boolean; error?: string; runs: Run[]; runId: string; timeframe: Tf; grid: GridRow[]; trades: Trade[]; segments: SegRow[];
  audit: AuditRow[]; fates: FateRow[]; events: EventRow[]; signalCount: number;
  period?: string; split?: string; tinyRisk?: { n: number; max_r: number | null }; auditCounts?: Record<string, number>;
};
type Selected = { type: "trade"; row: Trade } | { type: "audit"; row: AuditRow } | null;

// ---------------------------------------------------------------- constants / helpers
const CATEGORIES: { id: string; label: string; tone: string; help: string }[] = [
  { id: "caught", label: "Caught", tone: "text-[#62d894] border-[#2fbf71]/30 bg-[#2fbf71]/10", help: "Sweep (or 2B) + MSS fired with the pivot as the sweep extreme" },
  { id: "sweep_but_no_mss", label: "Sweep, no MSS", tone: "text-[#f2c873] border-[#d9a441]/30 bg-[#d9a441]/10", help: "Wick swept 20/40/60D liquidity but no close through the internal swing within 10 bars" },
  { id: "break_then_reversed", label: "Body close break, then reversed", tone: "text-[#8edfff] border-[#64d2ff]/30 bg-[#64d2ff]/10", help: "Candle BODY closed beyond the external level (rule says continuation) and price reversed anyway" },
  { id: "no_external_liquidity", label: "No external liquidity taken", tone: "text-[#ff8b91] border-[#e5484d]/30 bg-[#e5484d]/10", help: "Reversal from a lower high / higher low: 20D+ high/low never traded" },
];
const MODELS = ["OTE62_limit", "FVG_CE_limit", "MSS_next_open"];
const TARGETS = ["1R", "2R", "3R", "4R", "5R", "extLiq"];
const MODEL_LABEL: Record<string, string> = { OTE62_limit: "OTE 62% limit", FVG_CE_limit: "FVG CE limit", MSS_next_open: "MSS next open" };
const TARGET_LABEL: Record<string, string> = { "1R": "1R", "2R": "2R", "3R": "3R", "4R": "4R", "5R": "5R", extLiq: "Opposite ext. liquidity" };
const FATE_LABEL: Record<string, string> = {
  mss: "MSS confirmed", expired: "No MSS in 10 bars", broken_by_close: "Later body close beyond level",
  break_not_reclaimed: "Break not reclaimed (2B failed)", no_internal_swing: "No internal swing found",
};

function cx(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(" ");
}
const f2 = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "–" : v.toFixed(d));
const pct = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? "–" : `${v.toFixed(d)}%`);
const signed = (v: number | null | undefined, d = 2, suffix = "") =>
  v == null || !Number.isFinite(v) ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(d)}${suffix}`;
const wr = (s: Stat) => (s.n ? (s.wins / s.n) * 100 : null);
const TF_LABEL: Record<Tf, string> = { "1d": "Daily", "1h": "1 hour", "30m": "30 minute" };
const lbUnit = (tf: Tf) => (tf === "1d" ? "D" : " bars");
// hold time = exit datetime - entry datetime; daily in days, intraday in hours (overnight gaps count as clock time)
const fmtHold = (h: number | null | undefined, tf: Tf) =>
  h == null || !Number.isFinite(h) ? "–" : tf === "1d" ? `${(h / 24).toFixed(1)}d` : h >= 24 ? `${Math.floor(h / 24)}d ${Math.round(h % 24)}h` : `${h.toFixed(1)}h`;
const PERIOD_LABEL: Record<string, string> = { "2026": "2026", FULL: "2017 → 2026", FX_FULL: "Forex 2017 → 2026" };
function shiftDate(iso: string, days: number) {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function toneR(v: number | null | undefined) {
  if (v == null) return "text-[#93a1b6]";
  return v > 0 ? "text-[#62d894]" : v < 0 ? "text-[#ff8b91]" : "text-[#d6deec]";
}
function downloadRows(rows: Record<string, unknown>[], filename: string) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- component
function HistoricalReversalDashboard({ mssResult }: { mssResult?: MssResult | null }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; error?: string }>({ key: "" });
  const [nonce, setNonce] = useState(0);
  const [tf, setTf] = useState<Tf>("1d");
  const [runId, setRunId] = useState<string>("");
  const [model, setModel] = useState("OTE62_limit");
  const [target, setTarget] = useState("2R");
  const [stopMode, setStopMode] = useState<"hard" | "close">("hard");
  const [primaryOnly, setPrimaryOnly] = useState(true);
  const [period, setPeriod] = useState<"2026" | "FULL" | "FX_FULL">("2026");
  const [riskOnly, setRiskOnly] = useState(true);
  const [view, setView] = useState<"trades" | "audit">("trades");
  const [fSym, setFSym] = useState("");
  const [fSide, setFSide] = useState("");
  const [fKind, setFKind] = useState("");
  const [fHtf, setFHtf] = useState("");
  const [fOutcome, setFOutcome] = useState("");
  const [fCat, setFCat] = useState("");
  const [selected, setSelected] = useState<Selected>(null);
  const [sort, setSort] = useState<{ k: SortKey; asc: boolean }>({ k: "entry_date", asc: true });
  const toggleSort = (k: SortKey) => setSort((cur) => (cur.k === k ? { k, asc: !cur.asc } : { k, asc: true }));

  const query = useMemo(() => {
    const qs = new URLSearchParams({ tf, period, model, target, stop_mode: stopMode, primary: String(primaryOnly), min_risk: String(riskOnly) });
    if (runId) qs.set("run", runId);
    return qs.toString();
  }, [tf, period, runId, model, target, stopMode, primaryOnly, riskOnly]);
  const reqKey = `${query}#${nonce}`;
  const loading = loaded.key !== reqKey;
  const error = loaded.key === reqKey ? loaded.error ?? null : null;
  const load = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/reversal?${query}`, { cache: "no-store", signal: controller.signal })
      .then((res) => res.json() as Promise<Payload>)
      .then((json) => {
        if (!json.ok) throw new Error(json.error || "Load failed");
        setData(json);
        setLoaded({ key: reqKey });
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setLoaded({ key: reqKey, error: e instanceof Error ? e.message : String(e) });
      });
    return () => controller.abort();
  }, [query, reqKey]);

  const run = data?.runs.find((r) => r.run_id === data.runId);
  const dtf: Tf = data?.timeframe ?? "1d";
  const unit = lbUnit(dtf);
  const tfRuns = useMemo(() => {
    const order = ["baseline", "reclaim3", "k1", "k1_reclaim3"];
    return (data?.runs ?? []).filter((r) => r.timeframe === dtf && (r.period ?? "2026") === (data?.period ?? "2026")).sort((a, b) => order.indexOf(a.config_name) - order.indexOf(b.config_name));
  }, [data, dtf]);
  const totals = useMemo(() => {
    const t = data?.grid.find((g) => g.model === model && g.target === target && g.stop_mode === stopMode);
    return t ?? null;
  }, [data, model, target, stopMode]);

  const auditCounts = useMemo(() => {
    if (data?.auditCounts) return data.auditCounts;
    const counts: Record<string, number> = {};
    for (const a of data?.audit ?? []) counts[a.category] = (counts[a.category] ?? 0) + 1;
    return counts;
  }, [data]);
  const auditTotal = Object.values(auditCounts).reduce((a, b) => a + b, 0);

  const trades = useMemo(() => {
    return (data?.trades ?? []).filter(
      (t) =>
        (!fSym || t.sym === fSym) &&
        (!fSide || t.side === fSide) &&
        (!fKind || t.kind === fKind) &&
        (!fOutcome || t.outcome === fOutcome) &&
        (!fHtf || (fHtf === "W_FVG" ? t.htf.includes("W_FVG") : fHtf === "W_OB" ? !t.htf.includes("W_FVG") && t.htf.includes("W_OB") : t.htf === "none")),
    );
  }, [data, fSym, fSide, fKind, fHtf, fOutcome]);
  const sortedTrades = useMemo(() => {
    const dir = sort.asc ? 1 : -1;
    return [...trades].sort((a, b) => {
      const va = a[sort.k] as unknown, vb = b[sort.k] as unknown;
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [trades, sort]);
  const filteredStat = useMemo(() => {
    const closed = trades.filter((t) => t.setup_valid === true && t.exit_verified === true && ["win", "loss", "timeout"].includes(t.outcome));
    const n = closed.length;
    const wins = closed.filter((t) => t.outcome === "win").length;
    const sumR = closed.reduce((a, t) => a + t.r, 0);
    const avgPct = n ? closed.reduce((a, t) => a + t.pct, 0) / n : null;
    return { n, wins, sumR, avgR: n ? sumR / n : null, avgPct, open: trades.filter(t => t.outcome === "open").length, unverified: trades.filter(t => t.outcome === "unverified").length, invalidSetups: trades.filter(t => t.setup_valid === false).length, unaudited: trades.filter(t => t.setup_valid == null).length };
  }, [trades]);
  const auditRows = useMemo(
    () => (data?.audit ?? []).filter((a) => (!fCat || a.category === fCat) && (!fSym || a.sym === fSym) && (!fSide || a.side === fSide)),
    [data, fCat, fSym, fSide],
  );
  const symbols = useMemo(() => Array.from(new Set((data?.audit ?? []).map((a) => a.sym).concat((data?.trades ?? []).map((t) => t.sym)))).sort(), [data]);

  const eventsByL = useMemo(() => {
    const m = new Map<number, Record<string, number>>();
    for (const e of data?.events ?? []) {
      const row = m.get(e.lookback) ?? {};
      row[e.typ] = e.n;
      m.set(e.lookback, row);
    }
    return Array.from(m.entries()).sort((a, b) => a[0] - b[0]);
  }, [data]);

  // ---------- chart spec for the selected row
  const chart = useMemo(() => {
    if (!selected) return null;
    if (selected.type === "trade") {
      const t = selected.row;
      const bear = t.side === "bear";
      const chartEnd = t.exit_date || t.entry_date;
      const lines: ChartLine[] = [
        { price: t.swept_level, label: `${t.lookback}${unit} ext. liquidity`, color: "#d9a441", dashed: true },
        { price: t.stop, label: "Sweep extreme / stop", color: "#e5484d" },
        { price: t.internal_level, label: "Internal swing (MSS)", color: "#64d2ff", dashed: true },
        { price: t.entry, label: `Entry (${MODEL_LABEL[t.model] ?? t.model})`, color: "#f5f7fb" },
        { price: t.tgt, label: `Target ${TARGET_LABEL[t.target] ?? t.target}`, color: "#2fbf71" },
      ];
      if (t.target !== "extLiq") lines.push({ price: t.opposite_liquidity, label: "Opposite ext. liquidity", color: "#2fbf71", dashed: true });
      const markers: ChartMarker[] = [
        { time: t.sweep_date, position: bear ? "aboveBar" : "belowBar", shape: bear ? "arrowDown" : "arrowUp", color: "#d9a441", text: t.kind === "2B" ? "Break (2B)" : "Sweep" },
        { time: t.mss_date, position: bear ? "belowBar" : "aboveBar", shape: "circle", color: "#64d2ff", text: "MSS" },
        { time: t.entry_date, position: bear ? "aboveBar" : "belowBar", shape: "square", color: "#f5f7fb", text: "Entry" },

      ];
      if (t.exit_date && t.outcome !== "unverified") markers.push({ time: t.exit_date, position: "inBar", shape: "circle", color: t.outcome === "win" ? "#2fbf71" : t.outcome === "loss" ? "#e5484d" : "#93a1b6", text: `Exit ${t.outcome} ${signed(t.r, 2, "R")}` });
      if (t.kind === "2B" && t.reclaim_date !== t.sweep_date) {
        markers.push({ time: t.reclaim_date, position: bear ? "aboveBar" : "belowBar", shape: "circle", color: "#d9a441", text: "Reclaim" });
      }
      return {
        sym: t.sym,
        from: shiftDate(t.sweep_date, dtf === "1d" ? -120 : -21), to: shiftDate(chartEnd, dtf === "1d" ? 30 : 5),
        focusFrom: shiftDate(t.sweep_date, dtf === "1d" ? -70 : -6), focusTo: shiftDate(chartEnd, dtf === "1d" ? 12 : 2), lines, markers,
        title: `${t.sym} · ${TF_LABEL[dtf]} · ${bear ? "Short" : "Long"} · ${t.lookback}${unit} ${t.kind === "2B" ? "failed break" : "wick sweep"} · ${t.outcome.toUpperCase()} ${signed(t.r, 2, "R")} (${signed(t.pct, 2, "%")})`,
      };
    }
    const a = selected.row;
    const bear = a.side === "bear";
    const sig = a.signal_id ? data?.trades.find((t) => t.signal_id === a.signal_id) : undefined;
    const lines: ChartLine[] = [{ price: a.pivot_price, label: bear ? "Reversal high" : "Reversal low", color: "#d9a441" }];
    if (sig) lines.push({ price: sig.internal_level, label: "Internal swing (MSS)", color: "#64d2ff", dashed: true });
    const markers: ChartMarker[] = [
      { time: a.pivot_date, position: bear ? "aboveBar" : "belowBar", shape: bear ? "arrowDown" : "arrowUp", color: "#d9a441", text: CATEGORIES.find((c) => c.id === a.category)?.label ?? a.category },
    ];
    if (sig) markers.push({ time: sig.mss_date, position: bear ? "belowBar" : "aboveBar", shape: "circle", color: "#64d2ff", text: "MSS" });
    return {
      sym: a.sym,
      from: shiftDate(a.pivot_date, dtf === "1d" ? -140 : -21), to: shiftDate(a.pivot_date, dtf === "1d" ? 60 : 10),
      focusFrom: shiftDate(a.pivot_date, dtf === "1d" ? -90 : -6), focusTo: shiftDate(a.pivot_date, dtf === "1d" ? 45 : 5), lines, markers,
      title: `${a.sym} · ${TF_LABEL[dtf]} · ${bear ? "Swing high" : "Swing low"} ${a.pivot_date} · ${pct(a.move_pct)} move · ${CATEGORIES.find((c) => c.id === a.category)?.label}`,
    };
  }, [selected, data, dtf, unit]);

  // setup evidence for the shared HTF ICT chart: listed as text above the chart (not plotted on it)
  const htfEvidence = useMemo<{ labels: EvLabel[]; notes: EvNote[] } | null>(() => {
    if (selected?.type !== "trade") return null;
    const t = selected.row;
    const bear = t.side === "bear";
    const tfk = dtf;
    const labels: EvLabel[] = [
      { tf: tfk, kind: "pool", price: t.swept_level, timeMs: etMs(t.sweep_date), label: `${t.lookback}${unit.trim() || "-bar"} ${bear ? "BSL" : "SSL"} ${t.kind === "2B" ? "BROKEN + RECLAIMED (2B)" : "SWEPT (WICK)"}` },
      { tf: tfk, kind: "sweep", price: t.stop, timeMs: etMs(t.sweep_date), label: "SWEEP EXTREME = STOP" },
      { tf: tfk, kind: "also", price: t.internal_level, timeMs: etMs(t.mss_date), label: `MSS ${bear ? "DOWN" : "UP"} · INTERNAL SWING` },
      { tf: tfk, kind: "target", price: t.opposite_liquidity, timeMs: etMs(t.sweep_date), label: `DRAW · OPPOSITE ${t.lookback}${unit.trim() || "-bar"} LIQUIDITY` },
    ];
    const htf = t.htf === "none" ? "no weekly/daily FVG or OB in play" : `${t.htf.replace(/,/g, " + ")} in play`;
    const notes: EvNote[] = [
      { tf: tfk, text: `Reversal found on ${TF_LABEL[dtf]}: ${t.lookback}${unit} ${bear ? "high" : "low"} ${t.kind === "2B" ? "closed through then reclaimed" : "wicked and closed back inside"} on ${t.sweep_date}, MSS ${bear ? "down" : "up"} on ${t.mss_date} (${t.bars_to_mss} bar(s)). HTF: ${htf}.` },
      { tf: tfk, text: `${MODEL_LABEL[t.model] ?? t.model} @ ${f2(t.entry)} · stop ${f2(t.stop)} (${pct(t.risk_pct, 2)}) · target ${TARGET_LABEL[t.target] ?? t.target} ${f2(t.tgt)} · result ${t.outcome} ${signed(t.r)}R` },
    ];
    if (t.pd_between) {
      const zs = t.pd_between;
      const fmtZ = (z: (typeof zs)[number]) => `${z.dir === "with" ? (bear ? "bearish" : "bullish") : (bear ? "bullish" : "bearish")} ${z.kind} ${f2(z.bottom)}–${f2(z.top)} (${z.time.slice(0, 16)})`;
      notes.push({ tf: tfk, text: `Sweep → entry arrays: ${zs.length ? zs.map(fmtZ).join(" · ") : "no FVG or OB formed"}. Entry ${t.entry_in_fvg && t.entry_in_ob ? "inside FVG + OB" : t.entry_in_fvg ? "inside FVG" : t.entry_in_ob ? "inside OB" : "not in an FVG / OB"}.` });
    }
    if (t.htf_bias != null) {
      const flow = t.htf_bias === 0 ? "neutral" : (t.htf_bias === 1) === !bear ? "WITH the trade" : "AGAINST the trade";
      notes.push({ tf: tfk, text: `${dtf === "1d" ? "Weekly" : "Daily"} order flow ${flow} · swept level was ${t.level_age ?? "–"} bar(s) old${t.kind === "2B" ? ` · 2B reclaim ${t.reclaim_by_gap ? "only by a gap" : "traded back in"}` : ""} · best excursion before stop ${signed(t.mfe_r ?? null)}R${t.post_stop_r != null ? ` · ran ${f2(t.post_stop_r)}R past the stop after exit` : ""}.` });
    }
    if (t.pd_beyond) {
      notes.push({ tf: tfk, text: t.pd_beyond.length
        ? `Open PD arrays PAST the stop (between the swept ${t.lookback}${unit.trim() || "-bar"} level and the next larger window, never traded into before the entry): ${t.pd_beyond.map((z) => `${z.kind} ${f2(z.bottom)}–${f2(z.top)} (${z.time.slice(0, 10)}, ${pct(z.dist_pct, 2)} past stop)`).join(" · ")} → continuation risk.`
        : "No open FVG / OB past the stop inside the next larger window." });
    }
    if (t.ltf_1h || t.ltf_30m) notes.push({ tf: tfk, text: `Lower timeframe at the fill (last BOS/CHoCH from the sweep day open to the fill bar): 1H ${t.ltf_1h ?? "–"} · 30m ${t.ltf_30m ?? "–"} the trade.` });
    if (dtf !== "1d") notes.push({ tf: "1d", text: `Setup detected on ${TF_LABEL[dtf]}; HTF arrays in play at the sweep: ${htf}.` });
    return { labels, notes };
  }, [selected, dtf, unit]);

  // ---------------------------------------------------------------- render
  return (
    <div className="space-y-5">
      {/* header + run picker */}
      <section className="rounded-md border border-white/10 bg-[#101620] p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="grid size-9 place-items-center rounded-md border border-[#d9a441]/30 bg-[#d9a441]/10">
            <GitBranch className="size-4 text-[#f2c873]" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-lg font-semibold">Trend Reversals · {TF_LABEL[dtf]}{data?.period === "FX_FULL" ? " · Forex" : ""}</h1>
              <div className="flex items-center gap-1 rounded-md border border-white/10 bg-[#0b0f16] p-1">
                {(["1d", "1h", "30m"] as Tf[]).map((x) => (
                  <button
                    key={x}
                    onClick={() => { setTf(x); setRunId(""); setSelected(null); }}
                    className={cx("rounded px-3 py-1 font-mono text-xs", tf === x ? "bg-[#d9a441]/20 text-[#f2c873]" : "text-[#93a1b6] hover:text-white")}
                  >
                    {x === "1d" ? "1D" : x}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1 rounded-md border border-white/10 bg-[#0b0f16] p-1">
                {(["2026", "FULL", "FX_FULL"] as const).map((x) => (
                  <button
                    key={x}
                    onClick={() => { setPeriod(x); setRunId(""); setSelected(null); }}
                    className={cx("rounded px-3 py-1 font-mono text-xs", period === x ? "bg-[#64d2ff]/15 text-[#8edfff]" : "text-[#93a1b6] hover:text-white")}
                  >
                    {PERIOD_LABEL[x]}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-1 text-xs leading-5 text-[#93a1b6]">
              Wick beyond the 20/40/60-{dtf === "1d" ? "day" : "bar"} high/low that closes back inside = sweep (reversal warning). Body close beyond = break.
              A close past the latest internal swing after the sweep = MSS (bias flip). HTF context: {dtf === "1d" ? "weekly FVG / order block" : "daily + weekly FVG / order block"} and 126-bar premium/discount. No ATR anywhere: distances are % of price.
            </p>
          </div>
          <button
            onClick={() => void load()}
            className="flex h-9 items-center gap-2 rounded-md border border-white/10 px-3 text-xs text-[#93a1b6] hover:text-white"
          >
            <RefreshCw className={cx("size-3.5", loading && "animate-spin")} /> Refresh
          </button>
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          {tfRuns.map((r) => {
            const caught = r.summary?.audit?.caught ?? 0;
            const total = r.summary?.audit_total ?? 0;
            const active = r.run_id === data?.runId;
            return (
              <button
                key={r.run_id}
                onClick={() => { setRunId(r.run_id); setSelected(null); }}
                className={cx(
                  "rounded-md border p-3 text-left transition",
                  active ? "border-[#d9a441]/60 bg-[#d9a441]/10" : "border-white/10 bg-[#0b0f16] hover:border-white/25",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={cx("font-mono text-xs font-semibold", active ? "text-[#f2c873]" : "text-white")}>{r.config_name}</span>
                  <span className="font-mono text-[11px] text-[#93a1b6]">{total ? `${caught}/${total} caught · ${((caught / total) * 100).toFixed(0)}%` : ""}</span>
                </div>
                <div className="mt-1 text-[11px] leading-4 text-[#93a1b6]">{r.notes}</div>
              </button>
            );
          })}
        </div>
        {run ? (
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-[#7f8ca3]">
            <span>run {run.run_id}</span>
            <span>window {run.data_start} → {run.data_end}</span>
            <span>{run.symbols} symbols · {run.params.native_source === "CANONICAL_RAW_5M_V1" ? "validated raw 5m rollups" : (run.params.sources ?? []).join(" + ")}</span>
            <span>internal swing = {run.params.piv_k}-bar fractal</span>
            <span>2B reclaim = {run.params.reclaim ? `${run.params.reclaim} bars` : "off"}</span>
            <span>{data?.signalCount} MSS signals</span>
          </div>
        ) : null}
        {run?.params.native_source !== "CANONICAL_RAW_5M_V1" && run?.params.data_quality?.length ? (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-[#d9a441]/30 bg-[#d9a441]/10 px-3 py-2 text-xs text-[#f2c873]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>Data quality: {run.params.data_quality.join(" · ")}</span>
          </div>
        ) : null}
        {error ? <div className="mt-3 rounded-md bg-[#e5484d]/10 px-3 py-2 text-sm text-[#ff9da2]">{error}</div> : null}
      </section>

      {/* reversal audit */}
      <section className="rounded-md border border-white/10 bg-[#101620]">
        <PanelTitle icon={Crosshair} title="Reversal audit — were the real turns identified?" note={`${auditTotal} swing points: ±10-bar extreme followed by ≥${run?.params.reversal_move_pct ?? 6}% move within 20 bars`} />
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
          {CATEGORIES.map((c) => {
            const n = auditCounts[c.id] ?? 0;
            const active = fCat === c.id;
            return (
              <button
                key={c.id}
                onClick={() => { setFCat(active ? "" : c.id); setView("audit"); }}
                className={cx("rounded-md border p-3 text-left transition", c.tone, active && "ring-1 ring-white/40")}
              >
                <div className="text-[11px] font-semibold uppercase">{c.label}</div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="font-mono text-3xl font-semibold">{n}</span>
                  <span className="font-mono text-xs opacity-80">{auditTotal ? `${((n / auditTotal) * 100).toFixed(0)}%` : ""}</span>
                </div>
                <div className="mt-2 text-[11px] leading-4 text-[#a9b5c9]">{c.help}</div>
              </button>
            );
          })}
        </div>
      </section>

      <p className="mb-3 rounded border border-amber-300/25 p-3 text-xs text-slate-300">Corrected exits: completed 5m close below SL for BUY or above SL for SELL; exit at that close and capture the full loss. Target high/low touches take profit before a closing stop breach. Setups regenerate from validated raw candles. ICT setup validation and exit replay are separate checks; only validated setups with verified 5m exits enter result statistics. Original cohorts remain archived.</p>
      {/* selection + KPIs */}
      <section className="rounded-md border border-white/10 bg-[#101620] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Seg label="Entry" value={model} options={MODELS} labels={MODEL_LABEL} onChange={setModel} />
          <Seg label="Target" value={target} options={TARGETS} labels={TARGET_LABEL} onChange={setTarget} />
          <Seg label="Original cohort" value={stopMode} options={["hard", "close"]} labels={{ hard: "Original touch cohort", close: "Original close cohort" }} onChange={(v) => setStopMode(v as "hard" | "close")} />
          <label className="ml-auto flex items-center gap-2 text-xs text-[#93a1b6]">
            <input type="checkbox" checked={primaryOnly} onChange={(e) => setPrimaryOnly(e.target.checked)} />
            One row per setup (keep largest lookback)
          </label>
          <label className="flex items-center gap-2 text-xs text-[#93a1b6]" title="Stops closer than this give meaningless R multiples (e.g. 0.004% risk -> +808R) and would be eaten by spread/slippage">
            <input type="checkbox" checked={riskOnly} onChange={(e) => setRiskOnly(e.target.checked)} />
            Exclude tiny risk (&lt; {String(run?.params.min_risk_pct ?? (dtf === "1d" ? 0.5 : 0.25))}%)
            {riskOnly && data?.tinyRisk?.n ? <span className="font-mono text-[#f2c873]">{data.tinyRisk.n} excluded · max {signed(data.tinyRisk.max_r, 0)}R</span> : null}
          </label>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-4 xl:grid-cols-7">
          <Kpi label="Closed trades" value={totals ? String(totals.n) : "–"} sub={totals ? `${totals.timeouts} timeouts` : ""} />
          <Kpi label="Win rate" value={totals ? pct(wr(totals)) : "–"} sub={totals ? `${totals.wins}W / ${totals.losses}L` : ""} tone={totals && (wr(totals) ?? 0) >= 50 ? "green" : "gold"} />
          <Kpi label="Avg R" value={totals ? signed(totals.avg_r) : "–"} sub={totals ? `no gap windfall ${signed(totals.avg_r_capped)}` : "per trade"} tone={(totals?.avg_r ?? 0) > 0 ? "green" : "red"} />
          <Kpi label="Total R" value={totals ? signed(totals.sum_r, 1) : "–"} sub="sum of R" tone={(totals?.sum_r ?? 0) > 0 ? "green" : "red"} />
          <Kpi label="Avg move" value={totals ? signed(totals.avg_pct, 2, "%") : "–"} sub="entry → exit, % of price" tone={(totals?.avg_pct ?? 0) > 0 ? "green" : "red"} />
          <Kpi label="Median risk" value={totals ? pct(totals.med_risk_pct, 2) : "–"} sub={totals ? `R median ${signed(totals.med_r)} · p05 ${signed(totals.p05_r)} · p95 ${signed(totals.p95_r)}` : ""} />
          <Kpi label="Avg hold" value={totals ? fmtHold(totals.avg_hold_h, dtf) : "–"} sub={totals ? `median ${fmtHold(totals.med_hold_h, dtf)} · ${f2(totals.med_bars, 0)} bars` : "exit − entry"} />
        </div>
      </section>

      {/* grid + segments */}
      <section className="grid gap-5 xl:grid-cols-2">
        <div className="rounded-md border border-white/10 bg-[#101620]">
          <PanelTitle icon={Target} title="All entry × target × stop combinations" note={`click a row to load it · walk-forward split ${data?.split ?? ""} (IS before, OOS from)`} />
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[#7f8ca3]">
                <tr className="border-b border-white/10">
                  <Th>Entry</Th><Th>Target</Th><Th>Stop</Th><Th right>N</Th><Th right>WR</Th><Th right>Avg R</Th><Th right>Avg R capped</Th><Th right>Median R</Th><Th right>p05 / p95</Th>
                  <Th right>Sum R</Th><Th right>Avg %</Th><Th right>Risk %</Th><Th right>Avg hold</Th><Th right>IS capped</Th><Th right>OOS capped</Th>
                </tr>
              </thead>
              <tbody>
                {(data?.grid ?? []).map((g) => {
                  const active = g.model === model && g.target === target && g.stop_mode === stopMode;
                  return (
                    <tr
                      key={`${g.model}-${g.target}-${g.stop_mode}`}
                      onClick={() => { setModel(g.model); setTarget(g.target); setStopMode(g.stop_mode as "hard" | "close"); }}
                      className={cx("cursor-pointer border-b border-white/5 hover:bg-white/5", active && "bg-[#d9a441]/10")}
                    >
                      <Td>{MODEL_LABEL[g.model] ?? g.model}</Td>
                      <Td>{TARGET_LABEL[g.target] ?? g.target}</Td>
                      <Td>{g.stop_mode === "hard" ? "Original touch cohort" : "Original close cohort"}</Td>
                      <Td right>{g.n}</Td>
                      <Td right>{pct(wr(g))}</Td>
                      <Td right className={toneR(g.avg_r)}>{signed(g.avg_r)}</Td>
                      <Td right className={toneR(g.avg_r_capped)}>{signed(g.avg_r_capped)}</Td>
                      <Td right className={toneR(g.med_r)}>{signed(g.med_r)}</Td>
                      <Td right>{signed(g.p05_r, 1)} / {signed(g.p95_r, 1)}</Td>
                      <Td right className={toneR(g.sum_r)}>{signed(g.sum_r, 1)}</Td>
                      <Td right className={toneR(g.avg_pct)}>{signed(g.avg_pct, 2, "%")}</Td>
                      <Td right>{pct(g.med_risk_pct, 2)}</Td>
                      <Td right>{fmtHold(g.avg_hold_h, dtf)}</Td>
                      <Td right className={toneR(g.capped_is)}>{signed(g.capped_is)} <span className="text-[#7f8ca3]">({g.n_is ?? 0})</span></Td>
                      <Td right className={toneR(g.capped_oos)}>{signed(g.capped_oos)} <span className="text-[#7f8ca3]">({g.n_oos ?? 0})</span></Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div className="rounded-md border border-white/10 bg-[#101620]">
          <PanelTitle icon={TrendingUp} title="What drives the selected combination" note={`${MODEL_LABEL[model]} · ${TARGET_LABEL[target]} · ${stopMode === "hard" ? "original touch cohort" : "original close cohort"}`} />
          <div className="max-h-[720px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[#101620] text-[#7f8ca3]">
                <tr className="border-b border-white/10">
                  <Th>Dimension</Th><Th>Bucket</Th><Th right>N</Th><Th right>WR</Th><Th right>Avg R</Th><Th right>Capped</Th><Th right>Median R</Th><Th right>Sum R</Th><Th right>Avg %</Th><Th right>Avg hold</Th>
                </tr>
              </thead>
              <tbody>
                {(data?.segments ?? []).map((s, i, arr) => (
                  <tr key={`${s.dim}-${s.key}`} className={cx("border-b border-white/5", i > 0 && arr[i - 1].dim !== s.dim && "border-t border-t-white/15")}>
                    <Td className="text-[#7f8ca3]">{i === 0 || arr[i - 1].dim !== s.dim ? s.dim : ""}</Td>
                    <Td>{s.dim === "Lookback" ? s.key.replace(/D$/, unit) : s.key}</Td>
                    <Td right>{s.n}</Td>
                    <Td right>{pct(wr(s))}</Td>
                    <Td right className={toneR(s.avg_r)}>{signed(s.avg_r)}</Td>
                    <Td right className={toneR(s.avg_r_capped)}>{signed(s.avg_r_capped)}</Td>
                    <Td right className={toneR(s.med_r)}>{signed(s.med_r)}</Td>
                    <Td right className={toneR(s.sum_r)}>{signed(s.sum_r, 1)}</Td>
                    <Td right className={toneR(s.avg_pct)}>{signed(s.avg_pct, 2, "%")}</Td>
                    <Td right>{fmtHold(s.avg_hold_h, dtf)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* liquidity events + sweep fates */}
      <section className="grid gap-5 xl:grid-cols-[1fr_1.4fr]">
        <div className="rounded-md border border-white/10 bg-[#101620]">
          <PanelTitle icon={TrendingDown} title={`External liquidity events (${PERIOD_LABEL[data?.period ?? "2026"]})`} note="wick sweep vs body-close break" />
          <table className="w-full text-xs">
            <thead className="text-[#7f8ca3]">
              <tr className="border-b border-white/10">
                <Th>Lookback</Th><Th right>High swept</Th><Th right>High broken</Th><Th right>Low swept</Th><Th right>Low broken</Th>
              </tr>
            </thead>
            <tbody>
              {eventsByL.map(([L, row]) => (
                <tr key={L} className="border-b border-white/5">
                  <Td>{L}{unit}</Td>
                  <Td right className="text-[#f2c873]">{row.bear_sweep ?? 0}</Td>
                  <Td right>{row.bull_break ?? 0}</Td>
                  <Td right className="text-[#f2c873]">{row.bull_sweep ?? 0}</Td>
                  <Td right>{row.bear_break ?? 0}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rounded-md border border-white/10 bg-[#101620]">
          <PanelTitle icon={Crosshair} title="What happened after each sweep" note="20-bar follow-through from the sweep close, % of price" />
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[#7f8ca3]">
                <tr className="border-b border-white/10">
                  <Th>Lookback</Th><Th>Fate</Th><Th right>N</Th><Th right>Dist. to internal swing</Th><Th right>Median favourable</Th><Th right>Median adverse</Th>
                </tr>
              </thead>
              <tbody>
                {(data?.fates ?? []).map((f) => (
                  <tr key={`${f.lookback}-${f.fate}`} className="border-b border-white/5">
                    <Td>{f.lookback}{unit}</Td>
                    <Td className={f.fate === "mss" ? "text-[#62d894]" : ""}>{FATE_LABEL[f.fate] ?? f.fate}</Td>
                    <Td right>{f.n}</Td>
                    <Td right>{pct(f.med_internal_dist_pct, 2)}</Td>
                    <Td right className="text-[#62d894]">{pct(f.med_mfe20_pct, 2)}</Td>
                    <Td right className="text-[#ff8b91]">{pct(f.med_mae20_pct, 2)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* chart */}
      <section className="rounded-md border border-white/10 bg-[#101620]">
        <PanelTitle icon={TrendingUp} title={chart ? chart.title : "Chart"} note={chart ? `${TF_LABEL[dtf]} candles, ET` : "select a trade or reversal point below"} />
        <div className="p-4">
          {chart ? (
            <>
              {selected?.type === "trade" ? (
                // Backtest tab's HTF ICT chart: Daily / 1H / 30m / 15m, ±20/40/60 bars, with the setup's evidence.
                <div>
                  <MssLinkBar t={selected.row} sel={mssResult?.selection} />
                  <div className="overflow-hidden rounded-md border border-white/10 bg-[#0b0f16]">
                    <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2 text-xs">
                      <span className="font-semibold text-[#d6deec]">HTF ICT · Daily / 1H / 30m / 15m · ±20 / 40 / 60 bars</span>
                      <span className="ml-auto font-mono text-[11px] text-[#7f8ca3]">
                        {selected.row.sym} · {selected.row.side === "bear" ? "SELL" : "BUY"} · fill {f2(selected.row.entry)}
                      </span>
                    </div>
                    <DailyForwardChart
                      key={selected.row.trade_id}
                      endpoint="/api/reversal/daily-forward"
                      initialTf={dtf}
                      evidence={htfEvidence}
                      plotEvidence={false}
                      anchorTs={selected.row.sweep_date ? new Date(etMs(selected.row.sweep_date)).toISOString() : null}
                      trade={{
                        symbol: selected.row.sym,
                        direction: selected.row.side === "bear" ? "SELL" : "BUY",
                        exitTs: selected.row.exit_date ? new Date(etMs(selected.row.exit_date)).toISOString() : null,
                        exitPrice: selected.row.exit_price ?? null,
                        exitLabel: selected.row.outcome,
                        entryTs: selected.row.filled_at ?? new Date(etMs(selected.row.entry_date)).toISOString(),
                        fill: selected.row.entry,
                        stop: selected.row.stop,
                        target: selected.row.tgt,
                      }}
                    />
                  </div>
                </div>
              ) : <ReversalChart sym={chart.sym} tf={dtf} from={chart.from} to={chart.to} lines={chart.lines} markers={chart.markers} focusFrom={chart.focusFrom} focusTo={chart.focusTo} />}
              {selected?.type === "trade" ? <TradeFacts t={selected.row} unit={unit} /> : null}
              {selected?.type === "audit" ? <AuditFacts a={selected.row} /> : null}
            </>
          ) : (
            <div className="grid h-[200px] place-items-center rounded-md border border-dashed border-white/10 text-sm text-[#93a1b6]">
              Click any row in the Trades or Reversal points list to plot it with the sweep, internal swing, entry, stop and target.
            </div>
          )}
        </div>
      </section>

      {/* lists */}
      <section className="rounded-md border border-white/10 bg-[#101620]">
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3">
          <button onClick={() => setView("trades")} className={cx("rounded-md px-3 py-1.5 text-xs", view === "trades" ? "bg-[#d9a441]/15 text-[#f2c873]" : "text-[#93a1b6]")}>
            Trades ({trades.length})
          </button>
          <button onClick={() => setView("audit")} className={cx("rounded-md px-3 py-1.5 text-xs", view === "audit" ? "bg-[#d9a441]/15 text-[#f2c873]" : "text-[#93a1b6]")}>
            Reversal points ({auditRows.length})
          </button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Select value={fSym} onChange={setFSym} options={symbols} placeholder="All symbols" />
            <Select value={fSide} onChange={setFSide} options={["bear", "bull"]} labels={{ bear: "Short / highs", bull: "Long / lows" }} placeholder="Both sides" />
            {view === "trades" ? (
              <>
                <Select value={fKind} onChange={setFKind} options={["wick", "2B"]} labels={{ wick: "Wick sweep", "2B": "Failed break (2B)" }} placeholder="Any trigger" />
                <Select value={fHtf} onChange={setFHtf} options={["W_FVG", "W_OB", "none"]} labels={{ W_FVG: "Weekly FVG", W_OB: "Weekly OB only", none: "No HTF array" }} placeholder="Any HTF" />
                <Select value={fOutcome} onChange={setFOutcome} options={["win", "loss", "timeout", "open", "unverified"]} placeholder="Any outcome" />
              </>
            ) : (
              <Select value={fCat} onChange={setFCat} options={CATEGORIES.map((c) => c.id)} labels={Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]))} placeholder="All categories" />
            )}
            <button
              onClick={() =>
                view === "trades"
                  ? downloadRows(sortedTrades as unknown as Record<string, unknown>[], `reversal_trades_${data?.runId}_${model}_${target}_${stopMode}.csv`)
                  : downloadRows(auditRows as unknown as Record<string, unknown>[], `reversal_audit_${data?.runId}.csv`)
              }
              className="flex h-8 items-center gap-1.5 rounded-md border border-white/10 px-2.5 text-xs text-[#93a1b6] hover:text-white"
            >
              <Download className="size-3.5" /> CSV
            </button>
          </div>
        </div>
        {view === "trades" ? (
          <>
            <div className="flex flex-wrap gap-x-5 gap-y-1 px-4 py-2 font-mono text-[11px] text-[#93a1b6]">
              <span>filtered: {filteredStat.n} closed{filteredStat.open ? ` + ${filteredStat.open} open` : ""}{filteredStat.unverified ? ` + ${filteredStat.unverified} unverified` : ""}{filteredStat.invalidSetups ? ` + ${filteredStat.invalidSetups} excluded setups` : ""}{filteredStat.unaudited ? ` + ${filteredStat.unaudited} unaudited setups` : ""}</span>
              <span>WR {filteredStat.n ? `${((filteredStat.wins / filteredStat.n) * 100).toFixed(1)}%` : "–"}</span>
              <span className={toneR(filteredStat.avgR)}>avg {signed(filteredStat.avgR, 2, "R")}</span>
              <span className={toneR(filteredStat.sumR)}>sum {signed(filteredStat.sumR, 1, "R")}</span>
              <span className={toneR(filteredStat.avgPct)}>avg {signed(filteredStat.avgPct, 2, "%")}</span>
              {trades.length > 2000 ? <span className="text-[#f2c873]">showing first 2000 rows · CSV has all {trades.length}</span> : null}
            </div>
            <div className="max-h-[560px] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[#101620] text-[#7f8ca3]">
                  <tr className="border-b border-white/10">
                    {([
                      ["sym", "Symbol"], ["side", "Side"], ["kind", "Trigger"], ["lookback", "LB"], ["sweep_date", "Sweep"], ["mss_date", "MSS"],
                      ["entry_date", "Entry date"], ["entry", "Entry", true], ["stop", "Stop", true], ["tgt", "Target", true], ["risk_pct", "Risk %", true],
                      ["htf", "HTF"], ["setup_valid", "Setup verdict"], ["exit_verified", "Exit path"], ["outcome", "Outcome"], ["r", "R", true], ["pct", "Move %", true], ["exit_date", "Exit date"], ["hold_h", "Hold", true],
                      ["bars_held", "Bars", true], ["pd_beyond_n", "Open PD past stop", true], ["ltf_1h", "1H at fill"], ["ltf_30m", "30m at fill"],
                    ] as [SortKey, string, boolean?][]).map(([k, label, right]) => (
                      <th key={k} onClick={() => toggleSort(k)} title="click to sort"
                        className={cx("cursor-pointer select-none whitespace-nowrap px-3 py-2 font-semibold hover:text-white", right ? "text-right" : "text-left", sort.k === k && "text-[#f2c873]")}>
                        {label}{sort.k === k ? (sort.asc ? " ▲" : " ▼") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedTrades.slice(0, 2000).map((t) => {
                    const active = selected?.type === "trade" && selected.row.trade_id === t.trade_id;
                    return (
                      <tr key={t.trade_id} onClick={() => setSelected({ type: "trade", row: t })} className={cx("cursor-pointer border-b border-white/5 hover:bg-white/5", active && "bg-[#d9a441]/10")}>
                        <Td className="font-semibold text-white">{t.sym}</Td>
                        <Td className={t.side === "bear" ? "text-[#ff8b91]" : "text-[#62d894]"}>{t.side === "bear" ? "Short" : "Long"}</Td>
                        <Td>{t.kind === "2B" ? "2B" : "Wick"}</Td>
                        <Td>{t.lookback}{unit}</Td>
                        <Td>{t.sweep_date}</Td>
                        <Td>{t.mss_date}</Td>
                        <Td>{t.entry_date}</Td>
                        <Td right>{f2(t.entry)}</Td>
                        <Td right>{f2(t.stop)}</Td>
                        <Td right>{f2(t.tgt)}</Td>
                        <Td right>{pct(t.risk_pct, 2)}</Td>
                        <Td>{t.htf === "none" ? "–" : t.htf.replace(/,/g, " + ")}</Td>
                        <Td><span title={String(t.setup_validation?.reason ?? "Pending setup validation")}>{String(t.setup_validation?.verdict ?? (t.setup_valid === true ? "Execution valid" : t.setup_valid === false ? "INVALID_SETUP" : "Pending setup validation"))}</span></Td>
                        <Td>{t.exit_verified === true ? "Verified 5m" : "Unverified"}</Td>
                        <Td className={t.outcome === "win" ? "text-[#62d894]" : t.outcome === "loss" ? "text-[#ff8b91]" : "text-[#93a1b6]"}>{t.outcome}</Td>
                        <Td right className={toneR(t.r)}>{signed(t.r)}</Td>
                        <Td right className={toneR(t.pct)}>{signed(t.pct, 2, "%")}</Td>
                        <Td>{t.exit_date}</Td>
                        <Td right>{fmtHold(t.hold_h, dtf)}</Td>
                        <Td right>{t.bars_held}</Td>
                        <Td right className={t.pd_beyond_n ? "text-[#f2c873]" : ""}>{t.pd_beyond_n == null ? "–" : t.pd_beyond_n ? `${t.pd_beyond_n} · ${pct(t.pd_beyond_near_pct, 1)}` : "0"}</Td>
                        <Td className={t.ltf_1h === "against" ? "text-[#ff8b91]" : t.ltf_1h === "with" ? "text-[#62d894]" : ""}>{t.ltf_1h ?? "–"}</Td>
                        <Td className={t.ltf_30m === "against" ? "text-[#ff8b91]" : t.ltf_30m === "with" ? "text-[#62d894]" : ""}>{t.ltf_30m ?? "–"}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[#101620] text-[#7f8ca3]">
                <tr className="border-b border-white/10">
                  <Th>Symbol</Th><Th>Pivot date</Th><Th>Type</Th><Th right>Price</Th><Th right>Move</Th><Th>Category</Th><Th>Sweep fate</Th><Th>Caught by</Th>
                  <Th>HTF array at pivot</Th><Th>Took internal swing</Th><Th right>MSS lag</Th><Th right>Move gone at MSS</Th>
                </tr>
              </thead>
              <tbody>
                {auditRows.map((a) => {
                  const active = selected?.type === "audit" && selected.row.sym === a.sym && selected.row.pivot_date === a.pivot_date && selected.row.side === a.side;
                  const cat = CATEGORIES.find((c) => c.id === a.category);
                  return (
                    <tr key={`${a.sym}-${a.pivot_date}-${a.side}`} onClick={() => setSelected({ type: "audit", row: a })} className={cx("cursor-pointer border-b border-white/5 hover:bg-white/5", active && "bg-[#d9a441]/10")}>
                      <Td className="font-semibold text-white">{a.sym}</Td>
                      <Td>{a.pivot_date}</Td>
                      <Td className={a.side === "bear" ? "text-[#ff8b91]" : "text-[#62d894]"}>{a.side === "bear" ? "Swing high" : "Swing low"}</Td>
                      <Td right>{f2(a.pivot_price)}</Td>
                      <Td right>{pct(a.move_pct)}</Td>
                      <Td><span className={cx("rounded border px-1.5 py-0.5 text-[10px]", cat?.tone)}>{cat?.label ?? a.category}</span></Td>
                      <Td>{a.sweep_fate ? a.sweep_fate.split(",").map((f) => FATE_LABEL[f] ?? f).join(", ") : "–"}</Td>
                      <Td>{a.lookbacks_caught ? a.lookbacks_caught.split(",").map((x) => `${x}${unit}`).join(", ") : "–"}</Td>
                      <Td>{a.htf === "none" ? "–" : a.htf.replace(/,/g, " + ")}</Td>
                      <Td>{a.internal_sweep ? "yes" : "no"}</Td>
                      <Td right>{a.mss_lag_bars ?? "–"}</Td>
                      <Td right>{pct(a.move_used_at_mss_pct, 0)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- small pieces
function PanelTitle({ icon: Icon, title, note }: { icon: React.ComponentType<{ className?: string }>; title: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-white/10 px-4 py-3">
      <Icon className="size-4 text-[#d9a441]" />
      <h2 className="text-sm font-semibold">{title}</h2>
      {note ? <span className="ml-auto font-mono text-[11px] text-[#7f8ca3]">{note}</span> : null}
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={cx("whitespace-nowrap px-3 py-2 font-semibold", right ? "text-right" : "text-left")}>{children}</th>;
}

function Td({ children, right, className }: { children: React.ReactNode; right?: boolean; className?: string }) {
  return <td className={cx("whitespace-nowrap px-3 py-1.5 font-mono text-[#d6deec]", right && "text-right", className)}>{children}</td>;
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "green" | "red" | "gold" }) {
  const tones = { green: "text-[#62d894]", red: "text-[#ff8b91]", gold: "text-[#f2c873]" };
  return (
    <div className="rounded-md border border-white/10 bg-[#0b0f16] p-3">
      <div className="text-[11px] font-semibold uppercase text-[#7f8ca3]">{label}</div>
      <div className={cx("mt-2 font-mono text-2xl font-semibold", tone ? tones[tone] : "text-white")}>{value}</div>
      {sub ? <div className="mt-1 font-mono text-[11px] text-[#93a1b6]">{sub}</div> : null}
    </div>
  );
}

function Seg({ label, value, options, labels, onChange }: { label: string; value: string; options: string[]; labels: Record<string, string>; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-white/10 bg-[#0b0f16] p-1">
      <span className="px-2 text-[11px] font-semibold uppercase text-[#7f8ca3]">{label}</span>
      {options.map((o) => (
        <button key={o} onClick={() => onChange(o)} className={cx("rounded px-2.5 py-1 text-xs", value === o ? "bg-[#d9a441]/20 text-[#f2c873]" : "text-[#93a1b6] hover:text-white")}>
          {labels[o] ?? o}
        </button>
      ))}
    </div>
  );
}

function Select({ value, onChange, options, labels, placeholder }: { value: string; onChange: (v: string) => void; options: string[]; labels?: Record<string, string>; placeholder: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="h-8 rounded-md border border-white/10 bg-[#0b0f16] px-2 text-xs text-[#d6deec] outline-none">
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o} value={o}>{labels?.[o] ?? o}</option>
      ))}
    </select>
  );
}

function Fact({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="rounded-md border border-white/10 bg-[#0b0f16] px-3 py-2">
      <div className="text-[10px] font-semibold uppercase text-[#7f8ca3]">{k}</div>
      <div className={cx("mt-0.5 font-mono text-xs text-[#d6deec]", tone)}>{v}</div>
    </div>
  );
}

function TradeFacts({ t, unit }: { t: Trade; unit: string }) {
  const bear = t.side === "bear";
  const pdOk = t.pd_pos == null ? null : bear ? t.pd_pos > 0.5 : t.pd_pos < 0.5;
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
      <Fact k={`${t.lookback}${unit} external level`} v={`${f2(t.swept_level)} ${t.kind === "2B" ? "(body closed beyond, reclaimed)" : "(wick only)"}`} />
      <Fact k="Sweep extreme = stop" v={`${f2(t.stop)} · risk ${pct(t.risk_pct, 2)}`} />
      <Fact k="Internal swing (MSS level)" v={`${f2(t.internal_level)} · ${t.bars_to_mss} bar(s) after ${t.kind === "2B" ? "reclaim" : "sweep"}`} />
      <Fact k="MSS candle" v={`body ${(t.mss_body_ratio * 100).toFixed(0)}% of range · range ${pct(t.mss_range_pct, 2)}`} />
      <Fact k="HTF PD array" v={t.htf === "none" ? "none" : t.htf.replace(/,/g, " + ")} tone={t.htf.includes("W_FVG") ? "text-[#62d894]" : undefined} />
      <Fact k="126-bar premium/discount" v={t.pd_pos == null ? "n/a" : `${(t.pd_pos * 100).toFixed(0)}% of range · ${pdOk ? (bear ? "premium ✓" : "discount ✓") : "wrong side"}`} />
      <Fact k="Entry" v={`${MODEL_LABEL[t.model] ?? t.model} @ ${f2(t.entry)} on ${t.entry_date}`} />
      <Fact k="Target" v={`${TARGET_LABEL[t.target] ?? t.target} @ ${f2(t.tgt)} · planned ${f2(t.plan_r)}R`} />
      <Fact k="Opposite ext. liquidity" v={f2(t.opposite_liquidity)} />
      <Fact k="ICT setup verdict" v={String(t.setup_validation?.verdict ?? (t.setup_valid === true ? "Validated execution setup" : t.setup_valid === false ? "INVALID_SETUP" : "Pending setup validation"))} />
      <Fact k="Setup verification reason" v={String(t.setup_validation?.reason ?? "Inspect exported setup_validation for step evidence")} />
      <Fact k="Exit replay coverage" v={t.exit_verified === true ? "Verified 5m execution path" : "Unverified execution path"} />
      <Fact k="Decision known / fill" v={`${t.decision_known_at ?? "Unproven"} / ${t.filled_at ?? "Unproven"}`} />
      <Fact k="Actual exit price" v={t.exit_price == null ? "Unverified / legacy" : f2(t.exit_price)} />
      <Fact k="Result" v={`${t.outcome} ${signed(t.r)}R · ${signed(t.pct, 2, "%")}`} tone={toneR(t.r)} />
      <Fact k="Exit" v={`${t.exit_date || "No verified exit"} · ${t.bars_held} bars · held ${t.hold_h == null ? "–" : t.hold_h >= 24 ? `${(t.hold_h / 24).toFixed(1)} days` : `${t.hold_h.toFixed(1)} h`}`} />
      <Fact k="Liquidity taken by the sweep bar" v={t.swept_windows == null ? "n/a" : `${["none", "20", "20+40", "20+40+60"][t.swept_windows]}${t.swept_windows > 1 ? (t.windows_same_level ? " · one pool" : " · distinct pools") : ""}${t.swept_252 ? " · +252-bar" : t.swept_120 ? " · +120-bar" : ""} · ${pct(t.sweep_depth_pct, 2)} past`} />
      <Fact k="Displacement FVGs in leg" v={String(t.fvg_count)} />
    </div>
  );
}

function AuditFacts({ a }: { a: AuditRow }) {
  const reason: Record<string, string> = {
    caught: `MSS fired ${a.mss_lag_bars ?? "?"} bar(s) after the pivot; ${pct(a.move_used_at_mss_pct, 0)} of the 20-bar move was already gone at the MSS close.`,
    sweep_but_no_mss: `Liquidity was swept (${a.sweep_fate ? a.sweep_fate.split(",").map((f) => FATE_LABEL[f] ?? f).join(", ") : "fate n/a"}) but the internal swing was not closed through in time.`,
    break_then_reversed: "A daily body closed beyond the external level, so the rule read it as continuation. Price reversed anyway (candidate for the 2B / failed-break rule).",
    no_external_liquidity: `No 20/40/60-bar high/low was taken. ${a.internal_sweep ? "It did take a recent internal swing." : ""} ${a.htf !== "none" ? `It turned at a ${a.htf.replace(/,/g, " + ")}.` : ""}`,
  };
  return (
    <div className="mt-3 rounded-md border border-white/10 bg-[#0b0f16] px-3 py-2 text-xs leading-5 text-[#a9b5c9]">{reason[a.category] ?? a.category}</div>
  );
}
