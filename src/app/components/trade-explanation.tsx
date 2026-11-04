"use client";

import { useMemo, useState } from "react";
import { BookOpenCheck, ChevronDown, ChevronUp } from "lucide-react";

// Plain-language explanation of one realtime trade, built ONLY from the facts
// stored on the row (prices, timestamps, strategy_json). No model, no guessing.

export type ExplainRow = {
  ticker?: string | null;
  market?: string | null;
  strategy_id?: string | null;
  strategy?: string | null;
  signal_timeframe?: string | null;
  direction?: string | null;
  entry_datetime?: string | null;
  entry_price?: number | null;
  stoploss?: number | null;
  tp1?: number | null;
  tp2?: number | null;
  tp3?: number | null;
  risk_points?: number | null;
  planned_rr?: number | null;
  state?: string | null;
  outcome?: string | null;
  realized_r?: number | null;
  close_price?: number | null;
  close_ts?: string | null;
  close_reason?: string | null;
  order_id?: string | null;
  ict_session_ids?: string[];
  risk_probability?: number | null;
  strategy_json?: Record<string, unknown> | unknown[] | string | null;
};

type Line = { label: string; text: string; tone?: "good" | "bad" | "neutral" };

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}
function px(v: unknown) {
  const n = num(v);
  if (n === null) return "—";
  const abs = Math.abs(n);
  return n.toLocaleString(undefined, { maximumFractionDigits: abs >= 100 ? 2 : abs >= 1 ? 4 : 6 });
}
function when(v: unknown) {
  if (typeof v !== "string" || !v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " ET";
}
function words(v: unknown) {
  return String(v ?? "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
}
function parseJson(value: ExplainRow["strategy_json"]): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "string") {
    try { const p = JSON.parse(value); return p && typeof p === "object" && !Array.isArray(p) ? p : null; } catch { return null; }
  }
  return typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function pick(obj: Record<string, unknown> | null, ...keys: string[]): unknown {
  if (!obj) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
  }
  return undefined;
}

function buildStory(row: ExplainRow) {
  const json = parseJson(row.strategy_json);
  const p = (json && typeof json.pattern === "object" && json.pattern ? (json.pattern as Record<string, unknown>) : null) ?? json;
  const dir = String(row.direction ?? "").toUpperCase();
  const long = dir === "BUY" || dir === "LONG";
  const side = long ? "long (BUY)" : dir ? "short (SELL)" : "—";
  const entry = num(row.entry_price);
  const stop = num(row.stoploss);
  const risk = num(row.risk_points) ?? (entry !== null && stop !== null ? Math.abs(entry - stop) : null);
  const rr = (t: unknown) => {
    const tn = num(t);
    return risk && entry !== null && tn !== null ? ` (${(Math.abs(tn - entry) / risk).toFixed(2)}R)` : "";
  };

  const setup: Line[] = [];
  const bias = pick(p, "weekly_bias", "daily_bias", "htf_bias", "bias");
  if (bias !== undefined) setup.push({ label: "Higher-timeframe bias", text: `${words(bias)}${pick(p, "weekly_aligned") === true ? " · weekly aligned" : ""}${pick(p, "daily_aligned") === true ? " · daily aligned" : ""}` });
  const draw = pick(p, "macro_draw", "draw_on_liquidity", "dol");
  if (draw !== undefined) setup.push({ label: "Draw on liquidity", text: words(draw) });
  const sweepTs = pick(p, "sweep_ts", "sweep_time");
  const sweepPx = pick(p, "sweep_extreme", "sweep_price", "swept_level");
  if (sweepTs !== undefined || sweepPx !== undefined) setup.push({ label: "1 · Liquidity sweep", text: `Price ran ${long ? "sell-side liquidity below a low" : "buy-side liquidity above a high"}${sweepPx !== undefined ? ` to ${px(sweepPx)}` : ""}${sweepTs !== undefined ? ` on ${when(sweepTs)}` : ""}.` });
  const mssTs = pick(p, "mss_ts", "choch_ts", "bos_ts", "structure_ts");
  if (mssTs !== undefined) setup.push({ label: "2 · Market structure shift", text: `Structure shifted ${long ? "up" : "down"} on ${when(mssTs)}${pick(p, "displacement_fvg") === true ? ", with displacement leaving a fair value gap" : ""}.` });
  const zl = pick(p, "zone_low", "fvg_low", "ob_low");
  const zh = pick(p, "zone_high", "fvg_high", "ob_high");
  const arr = pick(p, "entry_array", "pd_array", "array_type");
  if (zl !== undefined || arr !== undefined) setup.push({ label: "3 · Entry array", text: `${arr !== undefined ? words(arr).toUpperCase() : "PD array"}${zl !== undefined && zh !== undefined ? ` between ${px(zl)} and ${px(zh)}` : ""}${pick(p, "price_location") !== undefined ? ` · price in ${words(pick(p, "price_location"))}` : ""}.` });
  const retest = pick(p, "retest_entry") as Record<string, unknown> | undefined;
  const method = (retest && pick(retest, "entry_method")) ?? pick(p, "entry_method", "entry_model");
  if (method !== undefined) setup.push({ label: "4 · Trigger", text: `${words(method)}${retest && pick(retest, "entry_ts") !== undefined ? ` at ${when(pick(retest, "entry_ts"))}` : ""}.` });
  const lo = pick(p, "dealing_range_low");
  const hi = pick(p, "dealing_range_high");
  if (lo !== undefined && hi !== undefined) setup.push({ label: "Dealing range", text: `${px(lo)} → ${px(hi)} (midpoint ${px(pick(p, "dealing_range_midpoint"))})` });

  const plan: Line[] = [
    { label: "Trade", text: `${side} ${row.ticker ?? ""} · ${row.strategy_id ?? row.strategy ?? "strategy"}${row.signal_timeframe ? ` · ${row.signal_timeframe}` : ""}` },
    { label: "Entry", text: `${px(entry)} on ${when(row.entry_datetime)}${row.ict_session_ids?.length ? ` · session: ${row.ict_session_ids.map(words).join(", ")}` : ""}` },
    { label: "Stop", text: `${px(stop)}${risk !== null ? ` · risk ${px(risk)} points` : ""}` },
    { label: "Targets", text: [row.tp1, row.tp2, row.tp3].filter((t) => num(t) !== null).map((t, i) => `TP${i + 1} ${px(t)}${rr(t)}`).join(" · ") || "—" },
  ];
  if (num(row.planned_rr) !== null) plan.push({ label: "Planned R:R", text: `${num(row.planned_rr)!.toFixed(2)}R to TP1` });
  const targets = pick(p, "preferred_targets");
  if (Array.isArray(targets) && targets.length) {
    plan.push({ label: "Liquidity targets", text: targets.slice(0, 4).map((t) => { const o = t as Record<string, unknown>; return `${px(o.price)} (${words(o.event_type ?? o.source)})`; }).join(" · ") });
  }

  const result: Line[] = [];
  const r = num(row.realized_r);
  const state = String(row.state ?? row.outcome ?? "").toUpperCase();
  if (row.close_ts || r !== null) {
    const win = r !== null ? r > 0 : /WIN|TARGET|TP/.test(state);
    result.push({ label: "Outcome", text: `${state || "Closed"}${r !== null ? ` · ${r >= 0 ? "+" : ""}${r.toFixed(2)}R` : ""}${row.close_price !== null && row.close_price !== undefined ? ` · exit ${px(row.close_price)}` : ""}${row.close_ts ? ` on ${when(row.close_ts)}` : ""}`, tone: r === null ? "neutral" : win ? "good" : "bad" });
    if (row.close_reason) result.push({ label: "Exit reason", text: words(row.close_reason) });
  } else {
    result.push({ label: "Status", text: `${state || "Open"} — ${row.order_id ? "order linked, still open" : "signal only, no order placed"}`, tone: "neutral" });
  }
  if (num(row.risk_probability) !== null) result.push({ label: "ML risk score", text: `${(num(row.risk_probability)! * 100).toFixed(1)}% loss probability (model estimate at signal time)` });

  // Any remaining simple facts from the strategy record, so nothing is hidden.
  const shown = new Set(["weekly_bias", "daily_bias", "htf_bias", "bias", "weekly_aligned", "daily_aligned", "macro_draw", "draw_on_liquidity", "dol", "sweep_ts", "sweep_time", "sweep_extreme", "sweep_price", "swept_level", "mss_ts", "choch_ts", "bos_ts", "structure_ts", "displacement_fvg", "zone_low", "zone_high", "fvg_low", "fvg_high", "ob_low", "ob_high", "entry_array", "pd_array", "array_type", "price_location", "retest_entry", "entry_method", "entry_model", "dealing_range_low", "dealing_range_high", "dealing_range_midpoint", "preferred_targets"]);
  const extra: Line[] = [];
  if (p) {
    for (const [k, v] of Object.entries(p)) {
      if (shown.has(k) || v === null || typeof v === "object") continue;
      extra.push({ label: words(k), text: typeof v === "boolean" ? (v ? "yes" : "no") : typeof v === "number" ? px(v) : /_ts$|time$/.test(k) ? when(v) : words(v) });
    }
  }
  return { setup, plan, result, extra };
}

function Section({ title, lines }: { title: string; lines: Line[] }) {
  if (!lines.length) return null;
  return (
    <div>
      <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#f2c873]">{title}</h4>
      <dl className="space-y-1.5">
        {lines.map((l) => (
          <div key={l.label + l.text} className="grid grid-cols-[150px_minmax(0,1fr)] gap-3 text-xs">
            <dt className="text-[#7f8ca3]">{l.label}</dt>
            <dd className={l.tone === "good" ? "font-semibold text-emerald-300" : l.tone === "bad" ? "font-semibold text-rose-300" : "text-[#d7deea]"}>{l.text}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function TradeExplanation({ row }: { row: ExplainRow }) {
  const [open, setOpen] = useState(false);
  const story = useMemo(() => (open ? buildStory(row) : null), [open, row]);
  return (
    <div className="rounded-xl border border-amber-300/30 bg-gradient-to-r from-amber-300/[0.07] to-transparent">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <BookOpenCheck className="size-5 shrink-0 text-amber-300" />
        <span className="flex-1">
          <span className="block text-sm font-semibold text-amber-100">{open ? "Detailed trade explanation" : "Click me for a detailed explanation of this trade"}</span>
          <span className="block text-[11px] text-[#93a1b6]">Why it was taken, the ICT sequence, the plan, and what happened — from the stored trade record only.</span>
        </span>
        {open ? <ChevronUp className="size-4 text-amber-200" /> : <ChevronDown className="size-4 text-amber-200" />}
      </button>
      {story ? (
        <div className="grid gap-5 border-t border-amber-300/15 px-4 py-4 lg:grid-cols-2">
          <Section title="Why this trade (ICT sequence)" lines={story.setup.length ? story.setup : [{ label: "Setup", text: "No detailed setup facts were stored for this strategy." }]} />
          <div className="space-y-5">
            <Section title="The plan" lines={story.plan} />
            <Section title="What happened" lines={story.result} />
          </div>
          {story.extra.length ? <div className="lg:col-span-2"><Section title="Other recorded facts" lines={story.extra} /></div> : null}
        </div>
      ) : null}
    </div>
  );
}
