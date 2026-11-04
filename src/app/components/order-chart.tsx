"use client";
import { ictChartContext } from "@/lib/ict-chart-context";
import type { SmtResult } from "@/lib/smt-signal";

import { Download, Frame, Maximize2, MessageSquareQuote, Minimize2, RotateCcw, Type, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { cachedFetch } from "@/lib/fetch-cache";
import { SimilarTrades } from "./similar-trades";
import { computeChartFib, visibleFibStudies, FIB_VISIBILITY_DEFAULT, type FibVisibility } from "@/lib/chart-fib";
import { FibLevelsLegend, FibToggleButtons, SvgFibOverlay } from "./fib-overlay";

// Shared, self-contained ICT order chart used by both the Backtest dashboard and
// the Realtime Orders dashboard. Features:
//   - a gap-free ordinal (index-based) time axis, so non-trading hours never
//     open empty stretches in the candle series;
//   - wheel / button zoom and drag-to-pan;
//   - EVERY label is draggable (price lines AND ICT context labels) with an
//     arrow-marker handle; the drag uses exact SVG matrix mapping and captures
//     the pointer on the SVG root so it tracks the cursor precisely up / down /
//     left / right;
//   - a timeframe selector (5m / 15m / 30m / 1h / 1D) that only offers timeframes the
//     signal actually has ICT labels for; higher timeframes are aggregated from
//     the 5m base client-side;
//   - lazy loading of older candles when you drag right past the left boundary;
//   - a maximise (fullscreen) toggle and a one-click PNG export that captures the
//     current zoom and label positions.

const GREEN = "#2fbf71";
const RED = "#e5484d";
const GOLD = "#d9a441";

export type Candle = { time: number; open: number; high: number; low: number; close: number };
export type OverlayZone = { kind: string; top: number; bottom: number; time: number; end_time?: number | null; direction: string | null; broken: boolean; mitigated: boolean; filled: boolean; label: string; primary?: boolean; zone_role?: "source_fvg" | "ifvg"; polarity?: "bullish" | "bearish" };
export type OverlayLevel = { kind: string; level: number; time: number; end_time?: number | null; side: string | null; direction: string | null; label: string };
export type BiasInfo = { weekly: string | null; daily: string | null; one_hour: string | null };
export type IpdaRange = { low: number; q25: number; eq50: number; q75: number; high: number; start_time: number | null; end_time: number | null; sessions: number; selected_level: string | null;
  /** true: draw from start_time (leg start) to the entry, not from the chart's left edge */
  anchored?: boolean; title?: string };

export type OrderChartResponse = {
  success: boolean;
  error?: string;
  /** SMT divergence vs the index / correlated peer at signal time (lib/smt-signal). */
  smt?: SmtResult | null;
  timeframe?: string;
  saved_evidence?: boolean;
  order?: {
    order_id: string;
    symbol: string;
    market: string;
    direction: string | null;
    entry_price: number | null;
    filled_price: number | null;
    stoploss: number | null;
    tp1: number | null;
    tp2: number | null;
    tp3: number | null;
    filled_at: string | null;
    close_ts: string | null;
    close_price: number | null;
    close_reason: string | null;
    realized_r: number | null;
    outcome: string | null;
  };
  candles?: Candle[];
  markers?: {
    entry: { time: number; price: number | null };
    exit: { time: number; price: number | null; outcome: string };
  };
  rejection?: {
    run_id: string;
    cost_bps_per_side: number | null;
    parent_direction: string;
    parent_filled_at: string;
    parent_entry: number | null;
    parent_stop: number | null;
    parent_targets: Array<number | null>;
    parent_close_at: string | null;
    rejection_direction: string;
    stop_touch_candle_at: string;
    rejection_entry_at: string;
    rejection_entry: number | null;
    rejection_stop: number | null;
    rejection_risk: number | null;
    parent_favorable_extreme_at: string | null;
    parent_favorable_extreme_price: number | null;
    parent_max_favorable_points: number | null;
    parent_max_favorable_pct: number | null;
    parent_max_favorable_r: number | null;
    parent_tp1_progress_pct: number | null;
    parent_pre_rejection_lesson: string | null;
    analysis_status: string;
    outcomes: Array<{
      target_no: number | null;
      original_rr: number | null;
      target_price: number | null;
      outcome: string;
      exit_price: number | null;
      exit_at: string | null;
      gross_r: number | null;
      cost_r: number | null;
      net_r: number | null;
      cycle_net_r: number | null;
    }>;
  } | null;
  overlays?: {
    order_blocks: OverlayZone[];
    fvgs: OverlayZone[];
    liquidity: OverlayLevel[];
    swings: OverlayLevel[];
    structure: OverlayZone[];
    ipda?: IpdaRange | null;
    bias: BiasInfo | null;
    strategy_timeframe?: string | null;
    timeframe_5m: Record<string, OverlayZone[] | OverlayLevel[]>;
    timeframe_15m: Record<string, OverlayZone[] | OverlayLevel[]>;
    timeframe_30m: Record<string, OverlayZone[] | OverlayLevel[]>;
    timeframe_1h: Record<string, OverlayZone[] | OverlayLevel[]>;
    timeframe_daily: Record<string, OverlayZone[] | OverlayLevel[]>;
    timeframe_weekly: Record<string, OverlayZone[] | OverlayLevel[]>;
  };
  window?: { from: number; to: number };
};

export type OrderChartMeta = {
  order_id: string;
  symbol: string;
  strategy_id?: string | null;
  direction?: string | null;
  r?: number | null;
};

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}
function fmt(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return Number(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function endpointUrl(endpoint: string, params: Record<string, string | number>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) query.set(key, String(value));
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}${query}`;
}

// Price precision follows the instrument. Equities quote to 2dp, but FX majors
// quote to 5 and JPY crosses to 3 — rendering EURUSD at 2dp collapses an entire
// setup ("1.16") and makes a 2.8-pip stop indistinguishable from its target.
function isForexSymbol(symbol?: string | null) {
  const s = (symbol || "").toUpperCase();
  return s.startsWith("^") && /EUR|USD|GBP|JPY|CHF|AUD|NZD|CAD/.test(s);
}
function priceDigits(symbol?: string | null, market?: string | null) {
  const s = (symbol || "").toUpperCase();
  if (/XAU|XAG/.test(s)) return 2;                       // metals quote like equities
  if ((market || "").toLowerCase() === "forex" || isForexSymbol(s)) return /JPY/.test(s) ? 3 : 5;
  return 2;
}

function clamp(value: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, value));
}

// Resolve the exchange timezone for an order so every datetime in the chart is
// shown in the market's local time — IST for Indian stocks, ET for US stocks —
// matching the dashboard table and the rest of the app. Falls back to the
// symbol suffix (.NS/.BO, NSE:/BSE:) when the market field is missing.
function marketTimeZone(market: string | null | undefined, symbol?: string | null): string {
  const m = (market || "").trim().toLowerCase();
  if (m === "india" || m === "in" || m === "nse" || m === "bse") return "Asia/Kolkata";
  if (m === "us" || m === "usa" || m === "united states" || m.includes("nasdaq") || m.includes("nyse")) return "America/New_York";
  const s = (symbol || "").trim().toUpperCase();
  if (s.endsWith(".NS") || s.endsWith(".BO") || s.startsWith("NSE:") || s.startsWith("BSE:")) return "Asia/Kolkata";
  return "America/New_York";
}
function tzShortLabel(tz: string): string {
  return tz === "Asia/Kolkata" ? "IST" : "ET";
}

// FVG palette. Green = bullish imbalance, red = bearish imbalance, violet =
// the inverted gap (the entry array). Kept distinct from the liquidity-grab
// box, which is a sweep region rather than an imbalance.
const FVG_BULLISH = "#16a34a";
const FVG_BEARISH = "#ef4444";
const FVG_INVERTED = "#7c3aed";

function isIfvgZone(zone: OverlayZone) {
  // A zone flagged `primary` is the strategy's OWN entry array, not incidental
  // context. IGS01 enters on the inversion itself, so suppressing it here would
  // erase the whole setup — the exclusion below is for pipelines where an
  // inverted gap is merely leftover noise beside the real array.
  if (zone.primary) return false;
  const hint = `${zone.kind || ""} ${zone.label || ""}`.toLowerCase();
  return zone.broken || hint.includes("ifvg") || hint.includes("inverse fair value gap") || hint.includes("inverse_fvg");
}

function zonesRepresentSameArea(a: OverlayZone, b: OverlayZone) {
  const aTop = Math.max(a.top, a.bottom);
  const aBottom = Math.min(a.top, a.bottom);
  const bTop = Math.max(b.top, b.bottom);
  const bBottom = Math.min(b.top, b.bottom);
  const overlap = Math.max(0, Math.min(aTop, bTop) - Math.max(aBottom, bBottom));
  const smallerHeight = Math.max(Math.min(aTop - aBottom, bTop - bBottom), Number.EPSILON);
  return overlap / smallerHeight >= 0.55;
}

function fvgOnlyZones(zones: OverlayZone[]) {
  const fvgZones = zones
    .filter((zone) => Number.isFinite(zone.top) && Number.isFinite(zone.bottom) && Number.isFinite(zone.time))
    .filter((zone) => !isIfvgZone(zone))
    .map((zone) => ({ ...zone, kind: zone.zone_role === "ifvg" ? "ifvg" : "fvg" }))
    .sort((a, b) => a.time - b.time);
  const groups: OverlayZone[][] = [];
  for (const zone of fvgZones) {
    // S10-V2's BPR is defined by opposing FVG legs. Keep BUY and SELL legs
    // distinct even when their price areas overlap.
    const group = groups.find((items) => items.some((item) => (item.direction || "").toUpperCase() === (zone.direction || "").toUpperCase()
      && (item.zone_role ?? "") === (zone.zone_role ?? "")
      && zonesRepresentSameArea(zone, item)));
    if (group) group.push(zone);
    else groups.push([zone]);
  }
  return groups
    .map((group) => [...group].sort((a, b) => b.time - a.time)[0])
    .sort((a, b) => a.time - b.time);
}

function spreadLabelYs(items: Array<{ id: string; anchorY: number }>, minY: number, maxY: number, preferredGap = 20) {
  const result = new Map<string, number>();
  if (!items.length) return result;
  const gap = Math.min(preferredGap, Math.max(12, (maxY - minY) / Math.max(items.length - 1, 1)));
  const placed = items
    .map((item) => ({ ...item, y: clamp(item.anchorY, minY, maxY) }))
    .sort((a, b) => a.y - b.y);
  for (let index = 1; index < placed.length; index += 1) {
    placed[index].y = Math.max(placed[index].y, placed[index - 1].y + gap);
  }
  if (placed.at(-1)!.y > maxY) {
    placed[placed.length - 1].y = maxY;
    for (let index = placed.length - 2; index >= 0; index -= 1) {
      placed[index].y = Math.min(placed[index].y, placed[index + 1].y - gap);
    }
  }
  if (placed[0].y < minY) {
    placed[0].y = minY;
    for (let index = 1; index < placed.length; index += 1) {
      placed[index].y = Math.max(placed[index].y, placed[index - 1].y + gap);
    }
  }
  for (const item of placed) result.set(item.id, item.y - item.anchorY);
  return result;
}

function placeIctLabels(
  items: Array<{ id: string; anchorX: number; anchorY: number; text: string }>,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
) {
  const result = new Map<string, LabelOffset>();
  const placed: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const item of [...items].sort((a, b) => a.anchorX - b.anchorX || a.anchorY - b.anchorY)) {
    const width = Math.max(30, item.text.length * 5.4 + 16);
    const height = 16;
    const lane = width + 12;
    const candidates = [
      { dx: 0, dy: 0 }, { dx: 0, dy: -20 }, { dx: 0, dy: 20 },
      { dx: -lane, dy: 0 }, { dx: -lane, dy: -20 }, { dx: -lane, dy: 20 },
      { dx: lane, dy: 0 }, { dx: lane, dy: -20 }, { dx: lane, dy: 20 },
      { dx: -lane * 2, dy: 0 }, { dx: -lane * 2, dy: -20 }, { dx: -lane * 2, dy: 20 },
      { dx: 0, dy: -40 }, { dx: 0, dy: 40 },
    ];
    let chosen = { x: clamp(item.anchorX, minX, Math.max(minX, maxX - width)), y: clamp(item.anchorY, minY, maxY) };
    let found = false;
    for (const candidate of candidates) {
      const x = clamp(item.anchorX + candidate.dx, minX, Math.max(minX, maxX - width));
      const y = clamp(item.anchorY + candidate.dy, minY, maxY);
      const collides = placed.some((label) => x < label.x + label.width + 6 && x + width + 6 > label.x && y - height / 2 < label.y + label.height / 2 + 4 && y + height / 2 + 4 > label.y - label.height / 2);
      if (!collides) {
        chosen = { x, y };
        found = true;
        break;
      }
    }
    if (!found) {
      for (let y = minY; y <= maxY && !found; y += 20) {
        for (let x = minX; x <= Math.max(minX, maxX - width); x += lane) {
          const collides = placed.some((label) => x < label.x + label.width + 6 && x + width + 6 > label.x && y - height / 2 < label.y + label.height / 2 + 4 && y + height / 2 + 4 > label.y - label.height / 2);
          if (!collides) {
            chosen = { x, y };
            found = true;
            break;
          }
        }
      }
    }
    placed.push({ ...chosen, width, height });
    result.set(item.id, { dx: chosen.x - item.anchorX, dy: chosen.y - item.anchorY });
  }
  return result;
}

const TF_ORDER: { key: TfKey; label: string; sec: number; overlayKey: string }[] = [
  // 1m is the IGS forex execution base. It is never offered for the equity
  // pipelines because no 1m rows exist for them.
  { key: "1m", label: "1m", sec: 60, overlayKey: "timeframe_1m" },
  { key: "5m", label: "5m", sec: 300, overlayKey: "timeframe_5m" },
  { key: "15m", label: "15m", sec: 900, overlayKey: "timeframe_15m" },
  { key: "30m", label: "30m", sec: 1800, overlayKey: "timeframe_30m" },
  { key: "1h", label: "1h", sec: 3600, overlayKey: "timeframe_1h" },
  { key: "1D", label: "1D", sec: 86400, overlayKey: "timeframe_daily" },
  { key: "1W", label: "1W", sec: 604800, overlayKey: "timeframe_weekly" },
];
type TfKey = "1m" | "5m" | "15m" | "30m" | "1h" | "1D" | "1W";

function normalizeTfKey(value: string | null | undefined): TfKey | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "1m") return "1m";
  if (normalized === "5m") return "5m";
  if (normalized === "15m") return "15m";
  if (normalized === "30m") return "30m";
  if (normalized === "1h" || normalized === "60m") return "1h";
  if (normalized === "1d" || normalized === "daily") return "1D";
  if (normalized === "1w" || normalized === "weekly") return "1W";
  return null;
}

function aggregateCandles(cs: Candle[], sec: number, timeZone = "America/New_York", baseSec = 300): Candle[] {
  // Guard against aggregating to the base granularity or finer. Previously
  // hardcoded to 300, which made 1m -> 5m a no-op and returned raw 1m candles
  // under a "5m" label.
  if (!cs.length || sec <= baseSec) return cs;
  const buckets = new Map<string, Candle>();
  const sessionFormatter = sec >= 86400
    ? new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    : null;
  for (const c of cs) {
    // Daily and weekly candles must respect the exchange session, not UTC
    // midnight. Keep the first intraday candle as each bucket's x-coordinate.
    let b = String(Math.floor(c.time / sec) * sec);
    if (sessionFormatter) {
      const localDate = sessionFormatter.format(c.time * 1000);
      if (sec === 604800) {
        const [year, month, day] = localDate.split("-").map(Number);
        const utcDate = new Date(Date.UTC(year, month - 1, day));
        const daysFromMonday = (utcDate.getUTCDay() + 6) % 7;
        utcDate.setUTCDate(utcDate.getUTCDate() - daysFromMonday);
        b = utcDate.toISOString().slice(0, 10);
      } else {
        b = localDate;
      }
    }
    const existing = buckets.get(b);
    if (!existing) {
      buckets.set(b, { time: sessionFormatter ? c.time : Number(b), open: c.open, high: c.high, low: c.low, close: c.close });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="flex items-center gap-1"><span className="h-0.5 w-4 shrink-0" style={{ backgroundColor: color }} />{label}</span>;
}
const SMT_COLOR = "#db2777";

/** Header chip: SMT at signal time and whether it agrees with the trade. */
function SmtChip({ smt }: { smt: SmtResult | null | undefined }) {
  if (!smt) return null;
  const has = smt.status === "BULLISH_SMT" || smt.status === "BEARISH_SMT";
  const text = has
    ? `${smt.status === "BULLISH_SMT" ? "Bullish" : "Bearish"} SMT vs ${smt.peer_label} · ${smt.aligned ? "with trade" : "against trade"}`
    : smt.status === "NO_SMT" ? `No SMT vs ${smt.peer_label}` : smt.status === "NO_PEER_DATA" ? `SMT: no ${smt.peer_label} data` : "SMT n/a";
  const tone = has ? (smt.aligned ? "border-[#db2777]/50 bg-[#db2777]/15 text-[#f9a8d4]" : "border-[#f59e0b]/40 bg-[#f59e0b]/10 text-[#fcd34d]") : "border-white/10 bg-white/5 text-white/60";
  const title = smt.event ? `Confirmed ${new Date(smt.event.confirmed_at).toLocaleString()} · swing ${smt.event.previous_price} → ${smt.event.price} vs peer ${smt.event.previous_peer_price} → ${smt.event.peer_price} · last ${12} bars before the signal` : `Compared ${smt.bars_compared} shared 5m bars in the hour before the signal`;
  return <span title={title} className={cx("ml-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold", tone)}>{text}</span>;
}

function BiasBadge({ v }: { v: string | null | undefined }) {
  if (!v) return <span className="text-[#93a1b6]">-</span>;
  const c = v.toLowerCase().startsWith("bull") ? "#62d894" : v.toLowerCase().startsWith("bear") ? "#ff8b91" : "#93a1b6";
  return <span style={{ color: c }}>{v.substring(0, 3).toUpperCase()}</span>;
}

export function OrderChart({
  order,
  targetNo,
  endpoint,
  identifierParam = "order_id",
  identifier,
  similaritySource,
  onClose,
  height = 520,
  showSimilarTrades = true,
  snapshot,
}: {
  order: OrderChartMeta;
  targetNo: string;
  endpoint: string;
  identifierParam?: string;
  identifier?: string;
  similaritySource?: "realtime" | "backtest";
  onClose: () => void;
  height?: number;
  showSimilarTrades?: boolean;
  /** Immutable caller-owned candles/evidence, rendered with the same Backtest controls. */
  snapshot?: OrderChartResponse;
}) {
  const [fetchedData, setData] = useState<OrderChartResponse | null>(null);
  const data = snapshot ?? fetchedData;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const idValue = identifier ?? order.order_id;

  useEffect(() => {
    if (snapshot) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      const url = endpointUrl(endpoint, { [identifierParam]: idValue, target_no: targetNo });
      cachedFetch(url)
        .then((response) => response.json())
        .then((payload: OrderChartResponse) => {
          if (cancelled) return;
          if (!payload.success) throw new Error(payload.error || "Chart request failed");
          setData(payload);
        })
        .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Chart request failed"))
        .finally(() => !cancelled && setLoading(false));
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [endpoint, identifierParam, idValue, targetNo, snapshot]);

  const bias = data?.overlays?.bias;
  const r = order.r ?? data?.order?.realized_r ?? null;
  const resolvedSimilaritySource = similaritySource ?? (endpoint.includes("/backtest/") ? "backtest" : "realtime");

  return (
    <div className="p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-[#93a1b6]">
        <Legend color={GOLD} label="Entry" />
        <Legend color={RED} label="Stop" />
        <Legend color={GREEN} label="TPs" />
        {data?.rejection ? <Legend color="#0891b2" label="Rejection entry / outcomes" /> : null}
        {data?.rejection ? <Legend color="#ea580c" label="Parent stop-touch candle" /> : null}
        {data?.rejection ? <Legend color="#0f766e" label="Parent pre-rejection lesson" /> : null}
        <Legend color={FVG_BULLISH} label="Bullish FVG" />
        <Legend color={FVG_BEARISH} label="Bearish FVG" />
        <Legend color={FVG_INVERTED} label="IFVG" />
        <Legend color="#9333ea" label="OB" />
        <Legend color="#2563eb" label="Liquidity / structure" />
        {data?.overlays?.ipda ? <Legend color="#c2410c" label={data.overlays.ipda.title ? `${data.overlays.ipda.title} premium / discount` : "20D IPDA premium / discount"} /> : null}
        <SmtChip smt={data?.smt} />
        {bias ? (
          <span className="ml-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white/80">
            W: <BiasBadge v={bias.weekly} /> | D: <BiasBadge v={bias.daily} /> | 1h: <BiasBadge v={bias.one_hour} />
          </span>
        ) : null}
        <span className="ml-auto font-mono text-[10px] text-white/50">Drag labels to move · right-click to remove · Text/Callout then click to add</span>
        {r !== null ? <span className={cx("font-mono", r >= 0 ? "text-[#62d894]" : "text-[#ff8b91]")}>{r >= 0 ? "+" : ""}{fmt(r)}R</span> : null}
        <button onClick={onClose} className="grid size-6 place-items-center rounded border border-white/10 text-[#93a1b6] hover:text-white" title="Close chart"><X className="size-3.5" /></button>
      </div>

      {!snapshot && loading ? <div className="grid place-items-center text-sm text-[#93a1b6]" style={{ height }}>Loading candles...</div> : null}
      {error ? <div className="grid place-items-center text-sm text-[#ff9da2]" style={{ height }}>{error}</div> : null}

      {(snapshot || !loading) && !error ? (
        <InteractiveChart
          key={idValue}
          data={data}
          baseHeight={height}
          symbol={order.symbol}
          endpoint={endpoint}
          identifierParam={identifierParam}
          identifier={idValue}
          targetNo={targetNo}
        />
      ) : null}
      {!showSimilarTrades ? null : order.strategy_id === "TS01-TB" ? (
        <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-xs leading-5 text-[#b9c4d6]">
          Historical-similarity ranking is intentionally unavailable for the frozen TS01 textbook baseline. Its exact qualification evidence is shown in the adjacent <span className="font-semibold text-white">Strategy JSON Evidence</span> panel; no cross-strategy feature mapping is invented.
        </div>
      ) : (
        <SimilarTrades
          source={resolvedSimilaritySource}
          identifierParam={identifierParam === "signal_hash" ? "signal_hash" : "order_id"}
          identifier={idValue}
        />
      )}
    </div>
  );
}

type LabelOffset = { dx: number; dy: number };
type AnnotationTool = "text" | "callout" | null;
type ChartAnnotation = { id: string; kind: Exclude<AnnotationTool, null>; text: string; x: number; y: number };
type ViewRange = { start: number; end: number };
// Explicit price window. Null = auto-fit to whatever is visible (the original
// behaviour); set = the user framed a zone and we hold that band.
type PriceRange = { lo: number; hi: number };
type ZoneBox = { x0: number; y0: number; x1: number; y1: number };
type ZoneReport = {
  from: number; to: number; bars: number;
  hi: number; lo: number; rangePips: number;
  open: number; close: number; changePips: number;
  volume: number;   // reserved: Candle carries no volume on this surface yet
  items: { label: string; price: number; group: string }[];
};
type DragState =
  | { kind: "label"; id: string; startX: number; startY: number; base: LabelOffset }
  | { kind: "annotation"; id: string; startX: number; startY: number; base: { x: number; y: number } }
  | { kind: "pan"; startX: number; startView: ViewRange; requestedOlder: boolean }
  | { kind: "zone"; x0: number; y0: number }
  | null;


function capturePointer(el: Element | null | undefined, pointerId: number) {
  try { (el as Element & { setPointerCapture?: (id: number) => void })?.setPointerCapture?.(pointerId); } catch { /* capture is best-effort */ }
}
function releasePointer(el: Element | null | undefined, pointerId: number) {
  try { (el as Element & { releasePointerCapture?: (id: number) => void })?.releasePointerCapture?.(pointerId); } catch { /* already released */ }
}

function ToolButton({ onClick, title, active, disabled = false, children }: { onClick: () => void; title: string; active?: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      disabled={disabled}
      className={cx(
        "grid h-7 min-w-7 place-items-center rounded border px-1.5 text-[10px] font-semibold shadow-sm transition",
        disabled
          ? "cursor-not-allowed border-slate-300/40 bg-slate-100/70 text-slate-400"
          : active
            ? "border-amber-500 bg-amber-100 text-amber-900"
            : "border-slate-400/40 bg-white/80 text-slate-700 hover:bg-white hover:text-slate-900",
      )}
    >
      {children}
    </button>
  );
}

function InteractiveChart({
  data,
  baseHeight,
  symbol,
  endpoint,
  identifierParam,
  identifier,
  targetNo,
}: {
  data: OrderChartResponse | null;
  baseHeight: number;
  symbol: string;
  endpoint: string;
  identifierParam: string;
  identifier: string;
  targetNo: string;
}) {
  const clipId = useId().replaceAll(":", "");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState>(null);
  const loadingOlderRef = useRef(false);
  const exhaustedLeftRef = useRef(false);
  const ipdaContextLoadedRef = useRef<string | null>(null);

  const [maximized, setMaximized] = useState(false);
  const [labelOffsets, setLabelOffsets] = useState<Record<string, LabelOffset>>({});
  const [hiddenLabels, setHiddenLabels] = useState<Set<string>>(() => new Set());
  const [annotations, setAnnotations] = useState<ChartAnnotation[]>([]);
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>(null);
  const [pendingAnnotation, setPendingAnnotation] = useState<{ kind: Exclude<AnnotationTool, null>; x: number; y: number } | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState("");
  const [view, setView] = useState<ViewRange | null>(null);
  const [priceView, setPriceView] = useState<PriceRange | null>(null);
  const [zoneTool, setZoneTool] = useState(false);
  const [zoneBox, setZoneBox] = useState<ZoneBox | null>(null);
  // The committed geometry lives in a ref as well as state: on a quick drag the
  // pointerup handler runs before the last pointermove's state has flushed, so
  // reading `zoneBox` from the render closure sees an empty box and silently
  // discards the selection. State drives the marquee; the ref drives the commit.
  const zoneBoxRef = useRef<ZoneBox | null>(null);
  const [zoneReport, setZoneReport] = useState<ZoneReport | null>(null);
  const [panning, setPanning] = useState(false);
  const strategyTf = normalizeTfKey(data?.overlays?.strategy_timeframe);
  const [tf, setTf] = useState<TfKey>(() => strategyTf ?? normalizeTfKey(data?.timeframe) ?? "5m");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyExhausted, setHistoryExhausted] = useState(false);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);

  const [baseCandles, setBaseCandles] = useState<Candle[]>(
    () => (data?.candles ?? []).filter((c) => c && Number.isFinite(c.time)).sort((a, b) => a.time - b.time),
  );

  const overlays = data?.overlays;
  const ipda = overlays?.ipda;
  const rejection = data?.rejection;

  // Exchange timezone for this order — all datetimes below render in it.
  const tz = marketTimeZone(data?.order?.market, symbol);
  const pxDigits = priceDigits(symbol, data?.order?.market);
  const tzLabel = tzShortLabel(tz);

  // Base granularity (median spacing). Higher-timeframe aggregation and lazy
  // history are only offered for a 5-minute base series.
  const baseStep = useMemo(() => {
    if (baseCandles.length < 2) return 300;
    const deltas: number[] = [];
    for (let i = 1; i < Math.min(baseCandles.length, 30); i += 1) deltas.push(baseCandles[i].time - baseCandles[i - 1].time);
    deltas.sort((a, b) => a - b);
    return deltas[Math.floor(deltas.length / 2)] || 300;
  }, [baseCandles]);
  // The execution base follows the series actually returned: 1m for the IGS
  // forex series, 5m for every equity pipeline.
  const returnedTf=normalizeTfKey(data?.timeframe);
  const baseTfKey: TfKey = baseStep > 0 && baseStep <= 60 ? "1m" : returnedTf && returnedTf!=="5m" ? returnedTf : "5m";
  const is5mBase = baseTfKey==="1m" || baseTfKey==="5m";
  const baseTfIndex = TF_ORDER.findIndex((t) => t.key === baseTfKey);

  const tfHasLabels = useCallback((overlayKey: string) => {
    const o = overlays ? (overlays as Record<string, unknown>)[overlayKey] as Record<string, unknown> | undefined : undefined;
    if (!o) return false;
    return Object.values(o).some((arr) => Array.isArray(arr) && arr.length > 0);
  }, [overlays]);

  // 5m is always available (execution base). Higher TFs only appear when the
  // strategy json recorded labels, except 1D: a persisted IPDA range is itself
  // daily evidence and makes the Daily/Fib view meaningful.
  const availableTfs = useMemo(
    () => TF_ORDER.filter((t, i) => {
      if (t.key === baseTfKey) return true;          // execution base, always on
      if (data?.saved_evidence) return false;       // immutable native-timeframe snapshot
      if (i < baseTfIndex) return false;             // finer than the data we have
      return is5mBase && (t.key === "1D" ? Boolean(ipda) || tfHasLabels(t.overlayKey) : tfHasLabels(t.overlayKey));
    }),
    [is5mBase, tfHasLabels, ipda, baseTfKey, baseTfIndex, data?.saved_evidence],
  );
  const activeTf = availableTfs.some((t) => t.key === tf) ? tf : baseTfKey;
  const activeTfMeta = TF_ORDER.find((t) => t.key === activeTf)!;

  const candles = useMemo(
    () => (activeTf === baseTfKey || !is5mBase ? baseCandles : aggregateCandles(baseCandles, activeTfMeta.sec, tz, baseStep)),
    [baseCandles, activeTf, is5mBase, activeTfMeta.sec, tz, baseTfKey, baseStep],
  );
  const slotCount = candles.length;

  const width = 960;
  const vbHeight = maximized ? 620 : baseHeight;
  const pad = 42;
  const plotW = width - pad * 2;
  const plotH = vbHeight - pad * 2;

  const times = useMemo(() => candles.map((c) => c.time), [candles]);
  const lastIdx = Math.max(slotCount - 1, 1);

  const start = clamp(view?.start ?? 0, 0, lastIdx);
  const end = clamp(view?.end ?? lastIdx, start + 0.5, lastIdx);
  const span = Math.max(end - start, 0.5);

  const xByIndex = useCallback((index: number) => pad + ((index - start) / span) * plotW, [pad, plotW, start, span]);
  const fracIndex = useCallback((t: number) => {
    if (!slotCount) return 0;
    if (t <= times[0]) return 0;
    if (t >= times[slotCount - 1]) return slotCount - 1;
    let lo = 0;
    let hi = slotCount - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid;
    }
    const gap = times[hi] - times[lo] || 1;
    return lo + (t - times[lo]) / gap;
  }, [slotCount, times]);
  const xByTime = useCallback((t: number) => xByIndex(fracIndex(t)), [xByIndex, fracIndex]);

  const entryTime = data?.markers?.entry?.time ?? 0;
  const entryPrice = data?.markers?.entry?.price ?? data?.order?.filled_price ?? data?.order?.entry_price;

  // Fibonacci retracement / extension from confirmed swings in the candles up to the entry
  // (all candles when the entry time is unknown). Recomputed per active timeframe.
  const [fibShow, setFibShow] = useState<FibVisibility>(FIB_VISIBILITY_DEFAULT);
  const fib = useMemo(
    () => computeChartFib(candles.filter((c) => !entryTime || c.time <= entryTime).map((c) => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close }))),
    [candles, entryTime],
  );
  const fibStudies = visibleFibStudies(fib, fibShow);

  const [contextLayers, setContextLayers] = useState({ imbalances: false, liquidity: false, periods: false });
  const derivedContext = useMemo(() => !Object.values(contextLayers).some(Boolean) ? [] : ictChartContext(
    candles.filter(c => !entryTime || c.time + activeTfMeta.sec <= entryTime), activeTfMeta.sec, tz,
  ).filter(m => !entryTime || m.time <= entryTime), [candles, entryTime, activeTfMeta.sec, tz, contextLayers]);

  const tfOverlays = overlays ? ((overlays as Record<string, unknown>)[activeTfMeta.overlayKey] as Record<string, OverlayZone[] | OverlayLevel[]> | undefined) : undefined;

  const visLo = clamp(Math.floor(start), 0, lastIdx);
  const visHi = clamp(Math.ceil(end), 0, lastIdx);

  // Only show ICT context that formed at or before the entry — nothing after we
  // are in the trade. (Post-entry review labels can be added back later.)
  const showZones = useMemo(() => {
    const enabled = derivedContext.filter(m => m.kind === "period" ? contextLayers.periods : ["vi", "fvg"].includes(m.kind) ? contextLayers.imbalances : contextLayers.liquidity);
    const extraZones: OverlayZone[] = enabled.filter(m => m.low !== m.high).slice(-16).map(m => ({ kind: m.kind, label: m.label, top: m.high, bottom: m.low, time: m.time, end_time: m.end_time, direction: m.direction, polarity: m.direction === "BUY" ? "bullish" : "bearish", broken: false, mitigated: false, filled: false }));
    const levels = enabled.filter(m => m.low === m.high);
    const recentLevels = levels.filter(m => levels.filter(other => other.label.split(" ")[0] === m.label.split(" ")[0] && other.time > m.time).length < 3);
    const extraLevels: OverlayLevel[] = recentLevels.map(m => ({ kind: m.kind, label: m.label, level: m.low, time: m.time, end_time: m.end_time, direction: m.direction, side: m.direction === "BUY" ? "sellside" : "buyside" }));
    const beforeEntry = (t: number | null | undefined) => t === null || t === undefined || t <= entryTime;
    const retain = <T,>(items:T[], count:number) => data?.saved_evidence ? items : items.slice(-count);
    return {
      order_blocks: retain((tfOverlays?.["order_blocks"] as OverlayZone[] ?? []).filter((z) => beforeEntry(z.time)).sort((a, b) => a.time - b.time),2),
      fvgs: retain(data?.saved_evidence ? (tfOverlays?.["fvgs"] as OverlayZone[] ?? []) : fvgOnlyZones((tfOverlays?.["fvgs"] as OverlayZone[] ?? []).filter((z) => beforeEntry(z.time))),4),
      structure: [...extraZones, ...retain((tfOverlays?.["structure"] as OverlayZone[] ?? []).filter((z) => data?.saved_evidence || beforeEntry(z.time)).sort((a, b) => a.time - b.time),2)],
      liquidity: [...extraLevels, ...retain((tfOverlays?.["liquidity"] as OverlayLevel[] ?? []).filter((l) => data?.saved_evidence || beforeEntry(l.time)).sort((a, b) => a.time - b.time),2)],
      swings: retain((tfOverlays?.["swings"] as OverlayLevel[] ?? []).filter((l) => beforeEntry(l.time)).sort((a, b) => a.time - b.time),2),
    };
  }, [entryTime, tfOverlays, data?.saved_evidence, derivedContext, contextLayers]);

  // ----- Price extremes over the visible window -----------------------------
  const allPrices: number[] = [];
  for (let i = visLo; i <= visHi && i < slotCount; i += 1) allPrices.push(candles[i].low, candles[i].high);
  const rejectionPrices = rejection
    ? [rejection.rejection_entry, rejection.rejection_stop, rejection.parent_favorable_extreme_price, ...rejection.outcomes.map((row) => row.target_price)]
    : [];
  const orderPrices = [data?.order?.filled_price ?? data?.order?.entry_price, data?.order?.stoploss, data?.order?.tp1, data?.order?.tp2, data?.order?.tp3, data?.order?.close_price, ...rejectionPrices].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  allPrices.push(...orderPrices);
  if (showZones) {
    const inView = (t: number | null | undefined) => t === null || t === undefined || (fracIndex(t) >= start - 1 && fracIndex(t) <= end + 1);
    for (const zone of [...showZones.order_blocks, ...showZones.fvgs, ...showZones.structure]) {
      if (inView(zone.time) && Number.isFinite(zone.top)) allPrices.push(zone.top, zone.bottom);
    }
    for (const level of [...showZones.liquidity, ...showZones.swings]) {
      if (inView(level.time) && Number.isFinite(level.level)) allPrices.push(level.level);
    }
  }
  if (ipda) allPrices.push(ipda.low, ipda.q25, ipda.eq50, ipda.q75, ipda.high);
  if (!allPrices.length) allPrices.push(100, 101);
  // A framed zone pins the price axis; otherwise auto-fit as before.
  const min = priceView ? priceView.lo : Math.min(...allPrices);
  const max = priceView ? priceView.hi : Math.max(...allPrices);
  const priceRange = Math.max(max - min, 0.0000001);
  const y = useCallback((price: number) => pad + ((max - price) / priceRange) * plotH, [pad, plotH, max, priceRange]);

  // Exact client-px -> SVG user-space mapping (handles scale + aspect letterbox).
  const toUser = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }, []);

  // ----- Lazy older-candle loading ------------------------------------------
  const loadOlder = useCallback((revealOlder = false) => {
    if (loadingOlderRef.current || !is5mBase || !endpoint || baseCandles.length === 0) return;
    if (exhaustedLeftRef.current) {
      setHistoryNotice("No earlier candles available");
      return;
    }
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setHistoryNotice(null);
    const earliest = baseCandles[0].time;
    const chunk = baseStep * 1500;
    const fromTs = earliest - chunk;
    const toTs = earliest - baseStep;
    const url = endpointUrl(endpoint, { [identifierParam]: identifier, target_no: targetNo, from_ts: fromTs, to_ts: toTs, step: baseStep });
    const displayedBefore = candles.length;
    fetch(url, { cache: "no-store" })
      .then((r) => r.json())
      .then((payload: OrderChartResponse) => {
        const older = (payload.candles ?? []).filter((c) => c && Number.isFinite(c.time) && c.time < earliest);
        if (!older.length) {
          exhaustedLeftRef.current = true;
          setHistoryExhausted(true);
          setHistoryNotice("No earlier candles available");
          return;
        }
        const seen = new Set(baseCandles.map((c) => c.time));
        const merged = [...older.filter((c) => !seen.has(c.time)), ...baseCandles].sort((a, b) => a.time - b.time);
        setBaseCandles(merged);
        const displayedAfter = activeTf === baseTfKey ? merged : aggregateCandles(merged, activeTfMeta.sec, tz, baseStep);
        const delta = displayedAfter.length - displayedBefore;
        if (delta > 0) {
          if (revealOlder) {
            // Newly prepended bars end immediately before the previously earliest
            // candle. Show that adjacent historical page so a right-drag visibly
            // moves backward in time instead of preserving the old full-range view.
            const revealSpan = Math.min(Math.max(span, 3), Math.max(displayedAfter.length - 1, 3));
            const revealEnd = Math.min(delta, Math.max(displayedAfter.length - 1, 0));
            setView({ start: Math.max(0, revealEnd - revealSpan), end: revealEnd });
          } else {
            setView((v) => (v
              ? { start: v.start + delta, end: v.end + delta }
              : { start: 0, end: Math.max(displayedBefore - 1, 0) }));
          }
          setHistoryNotice(`${delta} earlier candles loaded`);
        }
      })
      .catch(() => setHistoryNotice("Could not load earlier candles"))
      .finally(() => {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      });
  }, [baseCandles, baseStep, is5mBase, endpoint, identifierParam, identifier, targetNo, candles.length, activeTf, activeTfMeta.sec, tz, span, baseTfKey]);

  // An IPDA range needs its full 20-session context on the Daily chart. Fetch
  // that pre-entry history once when the signal actually carries an IPDA range,
  // rather than bloating every non-IPDA order-chart request.
  useEffect(() => {
    const startTime = ipda?.start_time;
    const earliest = baseCandles[0]?.time;
    if (!startTime || !earliest || earliest <= startTime || !is5mBase || !endpoint) return;
    const key = `${identifier}:${startTime}`;
    if (ipdaContextLoadedRef.current === key) return;
    ipdaContextLoadedRef.current = key;
    const url = endpointUrl(endpoint, { [identifierParam]: identifier, target_no: targetNo, from_ts: startTime, to_ts: earliest - baseStep, step: baseStep });
    fetch(url, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: OrderChartResponse) => {
        const older = (payload.candles ?? []).filter((c) => c && Number.isFinite(c.time) && c.time < earliest);
        if (!older.length) return;
        setBaseCandles((current) => {
          const seen = new Set(current.map((c) => c.time));
          return [...older.filter((c) => !seen.has(c.time)), ...current].sort((a, b) => a.time - b.time);
        });
      })
      .catch(() => { /* the chart remains usable with the execution window */ });
  }, [ipda?.start_time, baseCandles, baseStep, endpoint, identifierParam, identifier, targetNo, is5mBase]);

  // ----- Wheel zoom (native listener so we can preventDefault) --------------
  useEffect(() => {
    const el = svgRef.current;
    if (!el || slotCount < 2) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { x } = toUser(event.clientX, event.clientY);
      const cursorFrac = start + clamp((x - pad) / plotW, 0, 1) * span;
      const factor = event.deltaY > 0 ? 1.18 : 1 / 1.18;
      const newSpan = clamp(span * factor, 3, lastIdx);
      let ns = cursorFrac - ((cursorFrac - start) / span) * newSpan;
      let ne = ns + newSpan;
      if (ns < 0) { ne -= ns; ns = 0; }
      if (ne > lastIdx) { ns -= ne - lastIdx; ne = lastIdx; }
      ns = Math.max(0, ns);
      if (ne - ns >= lastIdx - 0.01) { setView(null); return; }
      setView({ start: ns, end: ne });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [toUser, start, span, plotW, pad, lastIdx, slotCount]);

  const zoomBy = (factor: number) => {
    const center = (start + end) / 2;
    const newSpan = clamp(span * factor, 3, lastIdx);
    let ns = center - newSpan / 2;
    let ne = center + newSpan / 2;
    if (ns < 0) { ne -= ns; ns = 0; }
    if (ne > lastIdx) { ns -= ne - lastIdx; ne = lastIdx; }
    ns = Math.max(0, ns);
    if (ne - ns >= lastIdx - 0.01) { setView(null); return; }
    setView({ start: ns, end: ne });
  };

  // ----- Unified pointer handling (labels + pan) on the SVG root ------------
  const startLabelDrag = useCallback((id: string, event: React.PointerEvent) => {
    event.stopPropagation();
    const p = toUser(event.clientX, event.clientY);
    dragRef.current = { kind: "label", id, startX: p.x, startY: p.y, base: labelOffsets[id] ?? { dx: 0, dy: 0 } };
    capturePointer(svgRef.current, event.pointerId);
  }, [toUser, labelOffsets]);

  const startAnnotationDrag = useCallback((id: string, event: React.PointerEvent) => {
    event.stopPropagation();
    const annotation = annotations.find((item) => item.id === id);
    if (!annotation) return;
    const p = toUser(event.clientX, event.clientY);
    dragRef.current = { kind: "annotation", id, startX: p.x, startY: p.y, base: { x: annotation.x, y: annotation.y } };
    capturePointer(svgRef.current, event.pointerId);
  }, [annotations, toUser]);

  const deleteLabel = useCallback((id: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setHiddenLabels((current) => new Set(current).add(id));
  }, []);

  const deleteAnnotation = useCallback((id: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setAnnotations((current) => current.filter((item) => item.id !== id));
  }, []);

  // Turn a dragged rectangle into a time+price window and a summary of exactly
  // what falls inside it.
  const commitZone = useCallback((box: ZoneBox) => {
    const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1);
    const y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);
    if (x1 - x0 < 6 || y1 - y0 < 6) return false;          // a click, not a drag

    const idxAt = (x: number) => clamp(start + ((x - pad) / plotW) * span, 0, lastIdx);
    const priceAt = (yy: number) => max - ((yy - pad) / plotH) * priceRange;

    const ns = idxAt(x0), ne = idxAt(x1);
    const hiP = priceAt(y0), loP = priceAt(y1);
    if (!(ne > ns) || !(hiP > loP)) return false;

    const loI = Math.max(0, Math.floor(ns));
    const hiI = Math.min(slotCount - 1, Math.ceil(ne));
    const inside = candles.slice(loI, hiI + 1);

    const digits = pxDigits;
    const scale = digits >= 4 ? 10000 : 100;               // pips vs points
    const highs = inside.map((c) => c.high), lows = inside.map((c) => c.low);
    const barHi = highs.length ? Math.max(...highs) : hiP;
    const barLo = lows.length ? Math.min(...lows) : loP;

    const items: ZoneReport["items"] = [];
    const within = (price: number, t?: number | null) => price >= loP && price <= hiP
      && (t === null || t === undefined || (fracIndex(t) >= ns - 0.5 && fracIndex(t) <= ne + 0.5));
    const push = (label: string, price: number | null | undefined, group: string, t?: number | null) => {
      if (typeof price === "number" && Number.isFinite(price) && within(price, t)) items.push({ label, price, group });
    };
    push("Entry", data?.order?.filled_price ?? data?.order?.entry_price, "order");
    push("Stop", data?.order?.stoploss, "order");
    push("TP1", data?.order?.tp1, "order");
    push("TP2", data?.order?.tp2, "order");
    push("TP3", data?.order?.tp3, "order");
    push("Exit", data?.order?.close_price, "order");
    if (data?.rejection) {
      push("Rejection entry", data.rejection.rejection_entry, "rejection");
      push("Rejection stop", data.rejection.rejection_stop, "rejection");
      for (const target of data.rejection.outcomes) push(`Rejection TP${target.target_no}`, target.target_price, "rejection");
    }
    if (showZones) {
      for (const z of [...showZones.order_blocks, ...showZones.fvgs, ...showZones.structure]) {
        const mid = (z.top + z.bottom) / 2;
        if (within(mid, z.time) || within(z.top, z.time) || within(z.bottom, z.time)) {
          items.push({ label: z.label || z.kind, price: mid, group: "zone" });
        }
      }
      for (const l of [...showZones.liquidity, ...showZones.swings]) push(l.label || l.kind, l.level, "level", l.time);
    }

    setView(ne - ns >= lastIdx - 0.01 ? null : { start: ns, end: ne });
    setPriceView({ lo: loP, hi: hiP });
    setZoneReport({
      from: inside.length ? inside[0].time : 0,
      to: inside.length ? inside[inside.length - 1].time : 0,
      bars: inside.length,
      hi: barHi, lo: barLo,
      rangePips: (barHi - barLo) * scale,
      open: inside.length ? inside[0].open : 0,
      close: inside.length ? inside[inside.length - 1].close : 0,
      changePips: inside.length ? (inside[inside.length - 1].close - inside[0].open) * scale : 0,
      volume: 0,
      items,
    });
    return true;
  }, [start, span, pad, plotW, plotH, lastIdx, max, priceRange, slotCount, candles, data, showZones, fracIndex, pxDigits]);

  const endDrag = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    setPanning(false);
    zoneBoxRef.current = null;
    setZoneBox(null);
    releasePointer(svgRef.current, event.pointerId);
  }, []);

  const onSvgPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    // A stale drag (a pointerup we never saw) would otherwise wedge the chart:
    // every later gesture bails here. If no button is down, it is stale.
    if (dragRef.current && event.buttons === 0) dragRef.current = null;
    // Started on empty chart area -> begin panning.
    if (dragRef.current) return;
    const p = toUser(event.clientX, event.clientY);
    if (p.x < pad || p.x > width - pad || p.y < pad || p.y > vbHeight - pad) return;
    if (annotationTool) return;
    if (zoneTool) {
      dragRef.current = { kind: "zone", x0: p.x, y0: p.y };
      zoneBoxRef.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      setZoneBox(zoneBoxRef.current);
      capturePointer(svgRef.current, event.pointerId);
      return;
    }
    dragRef.current = { kind: "pan", startX: p.x, startView: { start, end }, requestedOlder: false };
    setPanning(true);
    capturePointer(svgRef.current, event.pointerId);
  };
  const onSvgPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = toUser(event.clientX, event.clientY);
    if (drag.kind === "label") {
      setLabelOffsets((cur) => ({ ...cur, [drag.id]: { dx: drag.base.dx + (p.x - drag.startX), dy: drag.base.dy + (p.y - drag.startY) } }));
      return;
    }
    if (drag.kind === "zone") {
      zoneBoxRef.current = { x0: drag.x0, y0: drag.y0, x1: clamp(p.x, pad, width - pad), y1: clamp(p.y, pad, vbHeight - pad) };
      setZoneBox(zoneBoxRef.current);
      return;
    }
    if (drag.kind === "annotation") {
      setAnnotations((current) => current.map((item) => item.id === drag.id
        ? { ...item, x: drag.base.x + (p.x - drag.startX), y: drag.base.y + (p.y - drag.startY) }
        : item));
      return;
    }
    // pan
    const dxBars = ((p.x - drag.startX) / plotW) * span;
    let ns = drag.startView.start - dxBars;
    let ne = drag.startView.end - dxBars;
    const wantsOlder = ns < -0.01;
    if (wantsOlder && !drag.requestedOlder) {
      drag.requestedOlder = true;
      loadOlder(true);
    }
    if (ns < 0) { ne -= ns; ns = 0; }
    if (ne > lastIdx) { ns -= ne - lastIdx; ne = lastIdx; }
    ns = Math.max(0, ns);
    if (ne - ns >= lastIdx - 0.01) setView(null);
    else setView({ start: ns, end: ne });
  };
  const onSvgPointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (drag?.kind === "zone") {
      // A drag that ends without an intervening move still has the pointerup
      // position, so fall back to it rather than dropping the gesture.
      const p = toUser(event.clientX, event.clientY);
      const box = zoneBoxRef.current
        ? { ...zoneBoxRef.current, x1: clamp(p.x, pad, width - pad), y1: clamp(p.y, pad, vbHeight - pad) }
        : null;
      const framed = box ? commitZone(box) : false;
      zoneBoxRef.current = null;
      setZoneBox(null);
      if (framed) setZoneTool(false);      // one frame per activation
    }
    dragRef.current = null;
    setPanning(false);
    releasePointer(svgRef.current, event.pointerId);
  };

  const onSvgClick = (event: React.MouseEvent<SVGElement>) => {
    if (!annotationTool) return;
    event.stopPropagation();
    const p = toUser(event.clientX, event.clientY);
    if (p.x < pad || p.x > width - pad || p.y < pad || p.y > vbHeight - pad) return;
    setPendingAnnotation({ kind: annotationTool, x: p.x, y: p.y });
    setAnnotationDraft("");
  };

  const submitAnnotation = (event: React.FormEvent) => {
    event.preventDefault();
    if (pendingAnnotation && annotationDraft.trim()) {
      setAnnotations((current) => [...current, { id: `annotation:${Date.now()}:${current.length}`, ...pendingAnnotation, text: annotationDraft.trim() }]);
    }
    setPendingAnnotation(null);
    setAnnotationDraft("");
    setAnnotationTool(null);
  };

  const cancelAnnotation = () => {
    setPendingAnnotation(null);
    setAnnotationDraft("");
    setAnnotationTool(null);
  };

  // ----- PNG export ---------------------------------------------------------
  const downloadPng = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("width", String(width));
    clone.setAttribute("height", String(vbHeight));
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const xml = new XMLSerializer().serializeToString(clone);
    const src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));
    const image = new Image();
    image.onload = () => {
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = width * scale;
      canvas.height = vbHeight * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(scale, scale);
      ctx.fillStyle = "#e5e7eb";
      ctx.fillRect(0, 0, width, vbHeight);
      ctx.drawImage(image, 0, 0, width, vbHeight);
      const link = document.createElement("a");
      const stamp = data?.order?.filled_at ? new Date(data.order.filled_at).toLocaleDateString("en-CA", { timeZone: tz }) : "chart";
      link.download = `${(symbol || "order").replace(/[^A-Za-z0-9_.-]/g, "_")}-${activeTf}-${stamp}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    };
    image.src = src;
  };

  const entryX = xByTime(entryTime);
  const zoneClock = useCallback((t: number) => (t
    ? new Date(t * 1000).toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    : "—"), [tz]);

  const entryDateStr = data?.order?.filled_at
    ? new Date(data.order.filled_at).toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";

  const ticks: { x: number; label: string; major: boolean }[] = [];
  if (slotCount > 0) {
    const step = Math.max(1, Math.round((visHi - visLo) / 8) || 1);
    let prevDay = "";
    for (let i = visLo; i <= visHi; i += step) {
      if (i >= slotCount) break;
      const d = new Date(times[i] * 1000);
      const dayKey = d.toLocaleDateString("en-US", { timeZone: tz });
      const dayChanged = dayKey !== prevDay;
      prevDay = dayKey;
      ticks.push({
        x: xByIndex(i),
        major: dayChanged,
        label: dayChanged
          ? d.toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric" })
          : d.toLocaleString("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }),
      });
    }
  }

  const cw = Math.max(2, Math.min(16, (plotW / Math.max(span, 1)) * 0.7));

  const priceLines: { id: string; price: number; color: string; label: string; dashed: boolean }[] = [];
  const pushLine = (id: string, price: number | null | undefined, color: string, label: string, dashed = false) => {
    if (price === null || price === undefined || !Number.isFinite(price)) return;
    priceLines.push({ id, price, color, label, dashed });
  };
  pushLine("price:entry", entryPrice, "#b7791f", `${rejection ? "P-ENTRY / R-SL" : "ENTRY"} ${entryPrice != null ? entryPrice.toFixed(pxDigits) : "?"}`);
  pushLine("price:sl", data?.order?.stoploss, rejection ? "#ea580c" : "#dc2626", `${rejection ? "P-SL" : "SL"} ${data?.order?.stoploss?.toFixed(pxDigits) ?? "?"}`);
  pushLine("price:tp1", data?.order?.tp1, rejection ? "#64748b" : "#15803d", `${rejection ? "P-TP1" : "TP1"} ${data?.order?.tp1?.toFixed(pxDigits) ?? "?"}`, Boolean(rejection));
  pushLine("price:tp2", data?.order?.tp2, rejection ? "#64748b" : "#15803d", `${rejection ? "P-TP2" : "TP2"} ${data?.order?.tp2?.toFixed(pxDigits) ?? "?"}`, true);
  pushLine("price:tp3", data?.order?.tp3, rejection ? "#64748b" : "#15803d", `${rejection ? "P-TP3" : "TP3"} ${data?.order?.tp3?.toFixed(pxDigits) ?? "?"}`, true);
  if (rejection) {
    pushLine("price:rejection-entry", rejection.rejection_entry, "#0891b2", `R-ENTRY ${rejection.rejection_entry?.toFixed(pxDigits) ?? "?"}`);
    rejection.outcomes.forEach((target) => {
      const number = target.target_no ?? "?";
      pushLine(
        `price:rejection-tp${number}`,
        target.target_price,
        target.outcome === "WIN" ? "#15803d" : target.outcome === "LOSS" ? "#be123c" : "#0891b2",
        `R-TP${number} ${target.outcome} ${target.target_price?.toFixed(pxDigits) ?? "?"}`,
        number !== 1,
      );
    });
  }

  const eventEpoch = (value: string | null | undefined) => {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  };
  const rawRejectionEvents: Array<{ id: string; time: number; label: string; color: string }> = [];
  const stopTouchTime = eventEpoch(rejection?.stop_touch_candle_at);
  const rejectionEntryTime = eventEpoch(rejection?.rejection_entry_at);
  const parentExtremeTime = eventEpoch(rejection?.parent_favorable_extreme_at);
  const parentExtremePrice = rejection?.parent_favorable_extreme_price;
  const hasParentExtreme = parentExtremeTime !== null
    && parentExtremePrice !== null
    && parentExtremePrice !== undefined
    && Number.isFinite(parentExtremePrice);
  const parentExtremeX = hasParentExtreme ? xByTime(parentExtremeTime) : 0;
  const parentExtremeY = hasParentExtreme ? y(parentExtremePrice) : 0;
  const parentExtremeKind = rejection?.parent_direction === "BUY" ? "MAX HIGH" : "MIN LOW";
  const parentLessonTitle = rejection?.parent_pre_rejection_lesson === "TP1_TOUCHED_BEFORE_REJECTION"
    ? "TARGET TOUCHED BEFORE REJECTION"
    : "SETUP FAILED BEFORE TP1";
  const parentMovePct = rejection?.parent_max_favorable_pct;
  const parentMoveR = rejection?.parent_max_favorable_r;
  const parentTp1Progress = rejection?.parent_tp1_progress_pct;
  const parentLessonDetail = hasParentExtreme
    ? `${parentExtremeKind} ${parentExtremePrice.toFixed(pxDigits)} · +${(parentMovePct ?? 0).toFixed(2)}% · +${(parentMoveR ?? 0).toFixed(2)}R · ${(parentTp1Progress ?? 0).toFixed(0)}% OF TP1`
    : "";
  const parentLessonWidth = 278;
  const parentLessonX = hasParentExtreme ? clamp(parentExtremeX - parentLessonWidth / 2, pad + 4, width - pad - parentLessonWidth - 4) : 0;
  const parentLessonY = hasParentExtreme
    ? clamp(parentExtremeY + (rejection?.parent_direction === "BUY" ? 12 : -44), pad + 70, vbHeight - pad - 38)
    : 0;
  if (stopTouchTime !== null) rawRejectionEvents.push({ id: "rejection:touch", time: stopTouchTime, label: "PARENT SL TOUCH", color: "#ea580c" });
  if (rejectionEntryTime !== null) rawRejectionEvents.push({ id: "rejection:entry", time: rejectionEntryTime, label: "REJECTION ENTRY", color: "#0891b2" });
  const groupedOutcomeEvents = new Map<string, { time: number; labels: string[]; color: string }>();
  for (const target of rejection?.outcomes ?? []) {
    const time = eventEpoch(target.exit_at);
    if (time === null) continue;
    const key = `${time}:${target.exit_price ?? ""}:${target.outcome}`;
    const item = groupedOutcomeEvents.get(key) ?? {
      time,
      labels: [],
      color: target.outcome === "WIN" ? "#15803d" : target.outcome === "LOSS" ? "#be123c" : "#d97706",
    };
    item.labels.push(`TP${target.target_no} ${target.outcome}`);
    groupedOutcomeEvents.set(key, item);
  }
  for (const [id, item] of groupedOutcomeEvents) {
    rawRejectionEvents.push({ id: `rejection:outcome:${id}`, time: item.time, label: item.labels.join(" / "), color: item.color });
  }
  const markerLaneEnds = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const rejectionEvents = rawRejectionEvents
    .sort((a, b) => a.time - b.time)
    .map((event) => {
      const anchorX = xByTime(event.time);
      const labelWidth = Math.max(72, event.label.length * 5.2 + 12);
      const labelX = clamp(anchorX - labelWidth / 2, pad, width - pad - labelWidth);
      let lane = markerLaneEnds.findIndex((endX) => labelX > endX + 4);
      if (lane < 0) lane = markerLaneEnds.indexOf(Math.min(...markerLaneEnds));
      markerLaneEnds[lane] = labelX + labelWidth;
      return { ...event, anchorX, labelX, labelWidth, lane };
    });

  // ICT overlay geometry. Order Blocks & Fair Value Gaps render as boxes that
  // extend from where they formed across to the entry. Structure (BOS/MSS/CHoCH),
  // liquidity and swings render as single horizontal lines; near-equal levels are
  // de-duplicated so there is one clean line each instead of a cluster.
  type BoxItem = { id: string; x: number; xEnd: number | null; yTop: number; yBot: number; color: string; label: string; opacity: number };
  type LineItem = { id: string; x: number; xEnd: number | null; y: number; color: string; label: string };
  const boxItems: BoxItem[] = [];
  const lineItems: LineItem[] = [];
  if (showZones) {
    // Structure zones that carry a real price band (a liquidity grab spans the
    // pool level to the sweep extreme) belong with the boxes, not as a line.
    const bandedStructure = showZones.structure.filter((z) => Number.isFinite(z.top) && Number.isFinite(z.bottom) && z.top !== z.bottom);
    const zones = [...showZones.order_blocks, ...showZones.fvgs, ...bandedStructure];
    zones.forEach((zone, index) => {
      const kind = zone.kind.toLowerCase();
      const isFvg = kind === "fvg" || kind === "ifvg";
      const isGrab = kind === "liquidity_grab";
      const isGeneration = kind === "liquidity_generation";
      const color = kind === "ifvg" || zone.zone_role === "ifvg"
        ? FVG_INVERTED
        : isFvg
          ? (zone.polarity === "bullish" ? FVG_BULLISH : zone.polarity === "bearish" ? FVG_BEARISH : "#0284c7")
          : kind === "vi" ? "#d97706" : isGrab ? "#b91c1c" : isGeneration ? "#64748b" : "#9333ea";
      boxItems.push({
        id: `box:${activeTf}:${kind}:${index}`,
        x: xByTime(zone.time),
        // A zone with a recorded end stops there. Only open-ended zones run on
        // to the entry, which is how the equity pipelines have always drawn.
        xEnd: zone.end_time === null || zone.end_time === undefined ? null : xByTime(zone.end_time),
        yTop: y(Math.max(zone.top, zone.bottom)),
        yBot: y(Math.min(zone.top, zone.bottom)),
        color,
        label: zone.label || (isFvg ? "FVG" : "ORDER BLOCK"),
        opacity: isGeneration ? 0.14 : isGrab ? 0.12 : kind === "ifvg" ? 0.24 : isFvg ? 0.2 : 0.1,
      });
    });
    const side = (value: string | null) => (value === "buyside" ? "↑" : value === "sellside" ? "↓" : "");
    const rawLines: { level: number; time: number; endTime: number | null; color: string; label: string; priority: number }[] = [];
    const rawLinesPush = (row: { level: number; time: number; endTime: number | null; color: string; label: string; priority: number }) => rawLines.push(row);
    for (const z of showZones.structure) {
      if (bandedStructure.includes(z)) continue;   // already drawn as a box
      rawLinesPush({ level: (z.top + z.bottom) / 2, time: z.time, endTime: z.end_time ?? null, color: "#1d4ed8", label: z.label || (z.kind || "MSS").toUpperCase(), priority: 2 });
    }
    for (const l of showZones.liquidity) rawLinesPush({ level: l.level, time: l.time, endTime: l.end_time ?? null, color: "#2563eb", label: l.label || `${side(l.side)} LIQUIDITY`.trim(), priority: 3 });
    for (const l of showZones.swings) rawLinesPush({ level: l.level, time: l.time, endTime: l.end_time ?? null, color: "#1e40af", label: l.label || `${side(l.side)} SWING`.trim(), priority: 1 });
    // SMT: the traded symbol's two compared swings (prior and the one that diverged from the peer).
    const smtEvent = data?.smt?.event;
    if (smtEvent && data?.smt) {
      const name = `${data.smt.status === "BULLISH_SMT" ? "BULLISH" : "BEARISH"} SMT vs ${data.smt.peer_label}`;
      const toSec = (value: string) => Math.floor(Date.parse(value) / 1000);
      const end = toSec(smtEvent.confirmed_at);
      rawLinesPush({ level: smtEvent.previous_price, time: toSec(smtEvent.previous_swing_at), endTime: end, color: SMT_COLOR, label: "SMT · prior swing", priority: 5 });
      rawLinesPush({ level: smtEvent.price, time: toSec(smtEvent.swing_at), endTime: end, color: SMT_COLOR, label: `${name} · ${smtEvent.symbol_broke ? "swept, peer held" : "held, peer swept"}`, priority: 6 });
    }
    const tol = priceRange * 0.004;
    const kept: typeof rawLines = [];
    for (const item of rawLines.filter((row) => Number.isFinite(row.level)).sort((a, b) => b.priority - a.priority || b.time - a.time)) {
      if (!data?.saved_evidence && kept.some((k) => Math.abs(k.level - item.level) <= tol)) continue;
      kept.push(item);
    }
    (data?.saved_evidence ? kept : kept.slice(0, 10)).sort((a, b) => a.time - b.time).forEach((item, index) => lineItems.push({ id: `line:${activeTf}:${index}`, x: xByTime(item.time), xEnd: item.endTime === null ? null : xByTime(item.endTime), y: y(item.level), color: item.color, label: item.label }));
  }
  const rawIctLabels = [
    ...boxItems.map((b) => ({ id: b.id, anchorX: b.x + 4, anchorY: Math.max(12, b.yTop - 4), color: b.color, text: b.label })),
    ...lineItems.map((l) => ({ id: l.id, anchorX: Math.max(pad, l.x + 3), anchorY: Math.max(10, l.y - 4), color: l.color, text: l.label })),
  ];
  const ictAutoOffsets = placeIctLabels(rawIctLabels, pad + 6, Math.max(pad + 120, entryX - 8), pad + 12, vbHeight - pad - 12);
  const priceAutoOffsets = spreadLabelYs(priceLines.map((line) => ({ id: line.id, anchorY: y(line.price) })), pad + 10, vbHeight - pad - 10, 19);
  const ictLabels = rawIctLabels.map((label) => ({ ...label, autoOffset: ictAutoOffsets.get(label.id) ?? { dx: 0, dy: 0 } }));

  const isZoomed = view !== null;

  return (
    <div className={cx("relative", maximized && "fixed inset-0 z-[60] flex flex-col bg-[#0b0f16]/97 p-4")}>
      <div className="rounded-lg border border-white/10 bg-[#dfe3ea] p-2 shadow-inner">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-1 font-mono text-[10px] text-slate-600">
          <div className="flex items-center gap-1.5">
            <span className="mr-1">TF</span>
            {strategyTf ? <span data-strategy-timeframe={strategyTf} className="mr-1 rounded border border-violet-400/50 bg-violet-100 px-1.5 py-0.5 font-semibold text-violet-800" title="Selected from strategy_json.identification_timeframe">Strategy JSON: {strategyTf}</span> : null}
            {availableTfs.map((t) => (
              <ToolButton key={t.key} title={`${t.label} context`} active={t.key === activeTf} onClick={() => { setTf(t.key); setView(null); }}>{t.label}</ToolButton>
            ))}
            <ToolButton
              onClick={() => loadOlder(true)}
              title="Load and show earlier historical candles"
              disabled={loadingOlder || historyExhausted || !is5mBase || !endpoint}
            >
              &larr; Earlier
            </ToolButton>
            {!loadingOlder && historyNotice ? <span className="ml-1 text-[9px] text-slate-500">{historyNotice}</span> : null}
            {loadingOlder ? <span className="ml-1 text-[9px] text-slate-500">loading history…</span> : null}
            <span className="ml-1"><FibToggleButtons fib={fib} value={fibShow} onChange={setFibShow} tone="light" /></span>
          </div>
          <div className="flex items-center gap-1.5">
            {([ ["imbalances", "VI / BISI / SIBI"], ["liquidity", "Swing / EQH / EQL"], ["periods", "PDH/L · PWH/L"] ] as const).map(([key, label]) => <ToolButton key={key} active={contextLayers[key]} onClick={() => setContextLayers(v => ({...v, [key]: !v[key]}))} title="Completed-candle context; observed periods depend on loaded history">{label}</ToolButton>)}
            <ToolButton onClick={() => zoomBy(1 / 1.35)} title="Zoom in"><ZoomIn className="size-3.5" /></ToolButton>
            <ToolButton onClick={() => zoomBy(1.35)} title="Zoom out"><ZoomOut className="size-3.5" /></ToolButton>
            <ToolButton
              onClick={() => { setZoneTool((v) => !v); setAnnotationTool(null); }}
              title="Zone select: drag a box to frame a time and price window and read what is inside"
              active={zoneTool}
            ><Frame className="size-3.5" /></ToolButton>
            <ToolButton onClick={() => setAnnotationTool((tool) => tool === "text" ? null : "text")} title="Add text: select, then click the chart" active={annotationTool === "text"}><Type className="size-3.5" /></ToolButton>
            <ToolButton onClick={() => setAnnotationTool((tool) => tool === "callout" ? null : "callout")} title="Add callout: select, then click the chart" active={annotationTool === "callout"}><MessageSquareQuote className="size-3.5" /></ToolButton>
            <ToolButton onClick={() => { setView(null); setPriceView(null); setZoneReport(null); setZoneBox(null); setZoneTool(false); setLabelOffsets({}); setHiddenLabels(new Set()); setAnnotationTool(null); setPendingAnnotation(null); }} title="Reset view & restore labels"><RotateCcw className="size-3.5" /></ToolButton>
            <ToolButton onClick={downloadPng} title="Download PNG"><Download className="size-3.5" /></ToolButton>
            <ToolButton onClick={() => setMaximized((m) => !m)} title={maximized ? "Exit fullscreen" : "Maximise"}>{maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}</ToolButton>
          </div>
        </div>
        {Object.values(contextLayers).some(Boolean) ? <p className="px-1 pb-1 text-[10px] text-slate-600">Candle context: VI = body gap with overlapping wicks; BISI / SIBI = bullish / bearish three-candle FVG. Swings confirm after two right candles; EQH/EQL tolerance = 10% of the local maximum candle range. IRL marks swings inside the prior confirmed swing range. PDH/L and PWH/L use observed market-local periods; missing sessions can limit coverage. First loaded day/week withheld. Lines stop at sweep; gaps stop at full fill.</p> : null}
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${vbHeight}`}
          className="w-full touch-none select-none rounded-md bg-[#e5e7eb]"
          style={{ height: maximized ? "calc(100vh - 96px)" : `${vbHeight}px`, maxHeight: maximized ? undefined : `${vbHeight}px`, cursor: annotationTool || zoneTool ? "crosshair" : panning ? "grabbing" : "grab" }}
          aria-label={`Interactive ${activeTf} ICT order chart`}
          data-timeframe={activeTf}
          data-candle-count={slotCount}
          data-visible-from={times[visLo] ?? ""}
          data-visible-to={times[visHi] ?? ""}
          onPointerDown={onSvgPointerDown}
          onPointerMove={onSvgPointerMove}
          onPointerUp={onSvgPointerUp}
          onPointerCancel={endDrag}
          onClick={onSvgClick}
        >
          <defs>
            <clipPath id={`afterEntry-${clipId}`}><polygon points={`${entryX},0 ${width},0 ${width},${vbHeight} ${entryX},${vbHeight}`} /></clipPath>
            <clipPath id={`plot-${clipId}`}><rect x={pad} y={pad} width={plotW} height={plotH} /></clipPath>
          </defs>

          <rect width={width} height={vbHeight} fill="#e5e7eb" />

          {/* Timezone caption — all datetimes on this chart are market-local */}
          <text x={pad} y={16} fill="rgba(15,23,42,0.55)" fontSize="9" fontWeight="600" textAnchor="start">
            Times in {tzLabel} · {tz}
          </text>

          {[0, 1, 2, 3, 4].map((i) => (
            <line key={`g-${i}`} x1={pad} x2={width - pad} y1={pad + (i / 4) * plotH} y2={pad + (i / 4) * plotH} stroke="rgba(15,23,42,0.10)" />
          ))}

          {ticks.map((tick, i) => (
            <g key={`tl-${i}`}>
              {tick.major ? <line x1={tick.x} x2={tick.x} y1={pad} y2={vbHeight - pad} stroke="rgba(15,23,42,0.10)" strokeDasharray="2 4" /> : null}
              <text x={tick.x} y={vbHeight - 6} fill="rgba(15,23,42,0.6)" fontSize="8.5" textAnchor="middle" fontWeight={tick.major ? 700 : 400}>{tick.label}</text>
            </g>
          ))}

          {[0, 1, 2, 3, 4].map((i) => {
            const price = max - (i / 4) * priceRange;
            return <text key={`p-${i}`} x={pad - 4} y={pad + (i / 4) * plotH + 3} fill="rgba(15,23,42,0.6)" fontSize="9" textAnchor="end">{price.toFixed(pxDigits)}</text>;
          })}

          {/* Clipped plot contents (candles, zones, price lines) */}
          <g clipPath={`url(#plot-${clipId})`}>
            <line x1={entryX} x2={entryX} y1={pad} y2={vbHeight - pad} stroke="#b7791f" strokeWidth="1" strokeDasharray="3 4" opacity="0.75" />

            {stopTouchTime !== null ? (
              <rect
                data-rejection-stop-candle="true"
                x={xByTime(stopTouchTime) - Math.max(cw + 8, plotW / Math.max(span, 1)) / 2}
                y={pad}
                width={Math.max(cw + 8, plotW / Math.max(span, 1))}
                height={plotH}
                fill="#ea580c"
                opacity="0.09"
                stroke="#ea580c"
                strokeWidth="1.2"
              />
            ) : null}

            {hasParentExtreme ? (
              <g data-parent-favorable-candle="true">
                <rect
                  x={parentExtremeX - Math.max(cw + 8, plotW / Math.max(span, 1)) / 2}
                  y={pad}
                  width={Math.max(cw + 8, plotW / Math.max(span, 1))}
                  height={plotH}
                  fill="#0f766e"
                  opacity="0.08"
                  stroke="#0f766e"
                  strokeWidth="1.2"
                  strokeDasharray="3 3"
                />
                <line x1={Math.min(entryX, parentExtremeX)} x2={Math.max(entryX, parentExtremeX)} y1={parentExtremeY} y2={parentExtremeY} stroke="#0f766e" strokeWidth="1.2" strokeDasharray="5 3" />
                <circle cx={parentExtremeX} cy={parentExtremeY} r="4" fill="#f8fafc" stroke="#0f766e" strokeWidth="2" />
              </g>
            ) : null}

            {rejectionEvents.map((event) => (
              <line
                key={`event-line:${event.id}`}
                x1={event.anchorX}
                x2={event.anchorX}
                y1={pad}
                y2={vbHeight - pad}
                stroke={event.color}
                strokeWidth="1"
                strokeDasharray="4 4"
                opacity="0.72"
              />
            ))}

            {/* ICT Gems IPDA dealing range: lower half = discount, upper half = premium.
                The detector persists only completed 20-session range data, so these bands
                never depend on post-entry price action. */}
            {ipda ? (() => {
              const anchored = Boolean(ipda.anchored && ipda.start_time);
              const fx1 = anchored ? clamp(xByTime(ipda.start_time as number), pad, entryX) : pad;
              const fx2 = Math.max(fx1 + 2, entryX);   // start at the leg's first candle, extend right to the entry
              const fw = Math.max(2, fx2 - fx1);
              return (
              <g opacity="0.88">
                <rect x={fx1} y={y(ipda.q25)} width={fw} height={Math.max(1, y(ipda.low) - y(ipda.q25))} fill="#16a34a" opacity="0.10" />
                <rect x={fx1} y={y(ipda.eq50)} width={fw} height={Math.max(1, y(ipda.q25) - y(ipda.eq50))} fill="#65a30d" opacity="0.07" />
                <rect x={fx1} y={y(ipda.q75)} width={fw} height={Math.max(1, y(ipda.eq50) - y(ipda.q75))} fill="#f59e0b" opacity="0.07" />
                <rect x={fx1} y={y(ipda.high)} width={fw} height={Math.max(1, y(ipda.q75) - y(ipda.high))} fill="#dc2626" opacity="0.10" />
                {[
                  { price: ipda.high, label: `0.00 · HIGH ${fmt(ipda.high,pxDigits)}` },
                  { price: ipda.q75, label: `0.25 · PREMIUM ${fmt(ipda.q75,pxDigits)}` },
                  { price: ipda.eq50, label: `0.50 · EQ ${fmt(ipda.eq50,pxDigits)}` },
                  { price: ipda.q25, label: `0.75 · DISCOUNT ${fmt(ipda.q25,pxDigits)}` },
                  { price: ipda.low, label: `1.00 · LOW ${fmt(ipda.low,pxDigits)}` },
                ].map((level) => (
                  <g key={`ipda-${level.label}`}>
                    <line x1={fx1} x2={fx2} y1={y(level.price)} y2={y(level.price)} stroke={level.price === ipda.eq50 ? "#7c2d12" : "#c2410c"} strokeWidth={level.price === ipda.eq50 ? "1.15" : "0.7"} strokeDasharray={level.price === ipda.eq50 ? "4 3" : "2 4"} opacity="0.78" />
                    <text x={fx1 + 4} y={y(level.price) - 3} fill="#9a3412" fontSize="8" fontWeight="700">{level.label}</text>
                  </g>
                ))}
                <text x={pad + 4} y={pad + 12} fill="#9a3412" fontSize="8.5" fontWeight="700">{ipda.title ? ipda.title.toUpperCase() : `${ipda.sessions}D IPDA FIB`} · {activeTf === "1D" ? "DAILY" : "EXECUTION"} · {ipda.selected_level?.toUpperCase() || "QUADRANT"} SELECTED</text>
              </g>
              );
            })() : null}

            {/* Fibonacci retracement / extension (anchors known at the entry) */}
            <SvgFibOverlay studies={fibStudies} xAt={xByTime} xRight={width - pad} y={y} top={pad} bottom={vbHeight - pad} digits={pxDigits} />

            {/* Order Blocks & FVGs — boxes extended from formation to the entry line */}
            {boxItems.map((b) => (
              <rect key={b.id} x={b.x} y={b.yTop} width={Math.max(2, (b.xEnd ?? entryX) - b.x)} height={Math.max(1, b.yBot - b.yTop)} fill={b.color} opacity={b.opacity} stroke={b.color} strokeWidth="0.7" />
            ))}

            {/* Structure / liquidity / swings — one clean horizontal line each,
                drawn only up to the entry (no context past the entry datetime) */}
            {lineItems.map((l) => (
              <line key={l.id} x1={Math.max(pad, Math.min(l.x, entryX))} x2={l.xEnd ?? entryX} y1={l.y} y2={l.y} stroke={l.color} strokeWidth="0.9" strokeDasharray="5 4" opacity="0.65" />
            ))}

            {slotCount > 0 ? (
              <>
                <g clipPath={`url(#afterEntry-${clipId})`}>
                  {candles.map((candle, index) => {
                    if (index < visLo - 1 || index > visHi + 1) return null;
                    if ((candle.time ?? 0) < entryTime) return null;
                    const up = candle.close >= candle.open;
                    const cxp = xByIndex(index);
                    const top = y(Math.max(candle.open, candle.close));
                    const bodyHeight = Math.max(1, Math.abs(y(candle.open) - y(candle.close)));
                    return (
                      <g key={`c-${index}`}>
                        <line x1={cxp} x2={cxp} y1={y(candle.high)} y2={y(candle.low)} stroke="#111827" />
                        <rect x={cxp - cw / 2} y={top} width={cw} height={bodyHeight} fill={up ? "#f8fafc" : "#111827"} stroke="#111827" strokeWidth="0.8" />
                      </g>
                    );
                  })}
                </g>
                <g opacity="0.3">
                  {candles.map((candle, index) => {
                    if (index < visLo - 1 || index > visHi + 1) return null;
                    if ((candle.time ?? 0) >= entryTime) return null;
                    const up = candle.close >= candle.open;
                    const cxp = xByIndex(index);
                    const top = y(Math.max(candle.open, candle.close));
                    const bodyHeight = Math.max(1, Math.abs(y(candle.open) - y(candle.close)));
                    return (
                      <g key={`cp-${index}`}>
                        <line x1={cxp} x2={cxp} y1={y(candle.high)} y2={y(candle.low)} stroke="#475569" />
                        <rect x={cxp - cw / 2} y={top} width={cw} height={bodyHeight} fill={up ? "#f8fafc" : "#475569"} stroke="#475569" strokeWidth="0.6" />
                      </g>
                    );
                  })}
                </g>

                {priceLines.map((line) => (
                  <line key={`pl-${line.id}`} x1={entryX} x2={width - pad} y1={y(line.price)} y2={y(line.price)} stroke={line.color} strokeDasharray={line.dashed ? "5 5" : undefined} strokeWidth="1" opacity="0.9" />
                ))}
              </>
            ) : (
              <text x={width / 2} y={vbHeight / 2} fill="rgba(15,23,42,0.5)" fontSize="12" textAnchor="middle">No candle data available for this order window.</text>
            )}
          </g>

          {/* Entry datetime box (above plot) */}
          <g>
            <rect x={clamp(entryX - 75, pad, width - pad - 150)} y={pad - 8} width={150} height={16} rx={3} fill="#f8fafc" stroke="#b7791f" />
            <text x={clamp(entryX, pad + 75, width - pad - 75)} y={pad + 4} fill="#713f12" fontSize="9" textAnchor="middle" fontWeight="bold">
              {rejection ? "PARENT ENTRY · " : ""}{entryDateStr} {tzLabel} @ {entryPrice !== null && entryPrice !== undefined ? entryPrice.toFixed(pxDigits) : "?"}
            </text>
          </g>

          {hasParentExtreme ? (
            <g data-parent-pre-rejection-lesson={rejection?.parent_pre_rejection_lesson ?? "UNKNOWN"}>
              <line x1={parentExtremeX} y1={parentExtremeY} x2={clamp(parentExtremeX, parentLessonX + 8, parentLessonX + parentLessonWidth - 8)} y2={parentLessonY + (parentExtremeY < parentLessonY ? 0 : 32)} stroke="#0f766e" strokeWidth="1" />
              <rect x={parentLessonX} y={parentLessonY} width={parentLessonWidth} height={32} rx={4} fill="#f8fafc" stroke="#0f766e" strokeWidth="1.1" />
              <text x={parentLessonX + 8} y={parentLessonY + 12} fill="#0f766e" fontSize="8" fontWeight="800">{parentLessonTitle}</text>
              <text x={parentLessonX + 8} y={parentLessonY + 24} fill="#115e59" fontSize="7.5" fontWeight="700">{parentLessonDetail}</text>
            </g>
          ) : null}

          {rejectionEvents.map((event) => {
            const labelY = pad + 30 + event.lane * 17;
            return (
              <g key={`event-label:${event.id}`} data-rejection-event={event.label}>
                <rect x={event.labelX} y={labelY - 10} width={event.labelWidth} height={14} rx={3} fill="#f8fafc" stroke={event.color} strokeWidth="0.9" />
                <text x={event.labelX + event.labelWidth / 2} y={labelY} fill={event.color} fontSize="7.5" textAnchor="middle" fontWeight="700">{event.label}</text>
              </g>
            );
          })}

          {zoneBox ? (
            <g pointerEvents="none">
              <rect
                x={Math.min(zoneBox.x0, zoneBox.x1)} y={Math.min(zoneBox.y0, zoneBox.y1)}
                width={Math.abs(zoneBox.x1 - zoneBox.x0)} height={Math.abs(zoneBox.y1 - zoneBox.y0)}
                fill="#2563eb" opacity="0.12" stroke="#2563eb" strokeWidth="1" strokeDasharray="4 3"
              />
            </g>
          ) : null}

          {/* ICT context labels — draggable */}
          {slotCount > 0 ? ictLabels.filter((lbl) => !hiddenLabels.has(lbl.id)).map((lbl) => (
            <DraggableLabel key={lbl.id} id={lbl.id} anchorX={lbl.anchorX} anchorY={lbl.anchorY} color={lbl.color} text={lbl.text} offset={{ dx: lbl.autoOffset.dx + (labelOffsets[lbl.id]?.dx ?? 0), dy: lbl.autoOffset.dy + (labelOffsets[lbl.id]?.dy ?? 0) }} onStart={startLabelDrag} onDelete={deleteLabel} variant="ict" />
          )) : null}

          {/* Price labels — draggable, anchored at the right axis */}
          {slotCount > 0 ? priceLines.filter((line) => !hiddenLabels.has(line.id)).map((line) => (
            <DraggableLabel key={`lbl-${line.id}`} id={line.id} anchorX={width - pad} anchorY={y(line.price)} color={line.color} text={line.label} offset={{ dx: labelOffsets[line.id]?.dx ?? 0, dy: (priceAutoOffsets.get(line.id) ?? 0) + (labelOffsets[line.id]?.dy ?? 0) }} onStart={startLabelDrag} onDelete={deleteLabel} variant="price" />
          )) : null}

          {annotations.map((annotation) => (
            <ChartAnnotationLabel key={annotation.id} annotation={annotation} onStart={startAnnotationDrag} onDelete={deleteAnnotation} />
          ))}

          {annotationTool ? (
            <rect
              data-annotation-placement="true"
              x={pad}
              y={pad}
              width={plotW}
              height={plotH}
              fill="transparent"
              style={{ cursor: "crosshair" }}
              onClick={onSvgClick}
            />
          ) : null}
        </svg>
        <FibLevelsLegend studies={fibStudies} digits={pxDigits} tone="light" />

        {zoneReport ? (
          <div className="mt-1 rounded border border-blue-300/60 bg-white/85 px-2 py-1.5 font-mono text-[10px] text-slate-700">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-semibold text-blue-800">
                ZONE · {zoneClock(zoneReport.from)} – {zoneClock(zoneReport.to)} {tzLabel} · {zoneReport.bars} bars
              </span>
              <button
                type="button"
                onClick={() => { setZoneReport(null); setPriceView(null); setView(null); }}
                className="rounded px-1 text-slate-500 hover:bg-slate-200 hover:text-slate-900"
                title="Clear zone and restore the full view"
              >clear</button>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5">
              <span>High <b>{zoneReport.hi.toFixed(pxDigits)}</b></span>
              <span>Low <b>{zoneReport.lo.toFixed(pxDigits)}</b></span>
              <span>Range <b>{zoneReport.rangePips.toFixed(1)}</b> {pxDigits >= 4 ? "pips" : "pts"}</span>
              <span>Open <b>{zoneReport.open.toFixed(pxDigits)}</b></span>
              <span>Close <b>{zoneReport.close.toFixed(pxDigits)}</b></span>
              <span className={zoneReport.changePips >= 0 ? "text-emerald-700" : "text-rose-700"}>
                Change <b>{zoneReport.changePips >= 0 ? "+" : ""}{zoneReport.changePips.toFixed(1)}</b> {pxDigits >= 4 ? "pips" : "pts"}
              </span>
              {zoneReport.volume > 0 ? <span>Volume <b>{Math.round(zoneReport.volume).toLocaleString("en-US")}</b></span> : null}
            </div>
            {zoneReport.items.length ? (
              <div className="mt-1 border-t border-slate-200 pt-1">
                <span className="text-slate-500">In this zone:</span>
                <ul className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                  {zoneReport.items.map((item, i) => (
                    <li key={`zi-${i}`} className={item.group === "order" ? "text-amber-800" : item.group === "zone" ? "text-orange-800" : "text-blue-800"}>
                      {item.label} <b>{item.price.toFixed(pxDigits)}</b>
                    </li>
                  ))}
                </ul>
              </div>
            ) : <div className="mt-1 border-t border-slate-200 pt-1 text-slate-500">No ICT levels or order prices inside this zone.</div>}
          </div>
        ) : null}
      </div>
      {pendingAnnotation ? (
        <form onSubmit={submitAnnotation} className="absolute left-1/2 top-12 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-md border border-slate-400 bg-white p-1.5 shadow-xl">
          <input
            autoFocus
            aria-label={pendingAnnotation.kind === "callout" ? "Callout text" : "Annotation text"}
            value={annotationDraft}
            onChange={(event) => setAnnotationDraft(event.target.value)}
            placeholder={pendingAnnotation.kind === "callout" ? "Enter callout…" : "Enter text…"}
            className="h-7 w-56 rounded border border-slate-300 px-2 font-sans text-xs text-slate-900 outline-none focus:border-violet-500"
          />
          <button type="submit" className="h-7 rounded bg-violet-600 px-2.5 text-[10px] font-bold text-white hover:bg-violet-700">Add</button>
          <button type="button" onClick={cancelAnnotation} className="h-7 rounded border border-slate-300 px-2 text-[10px] font-bold text-slate-600 hover:bg-slate-100">Cancel</button>
        </form>
      ) : null}
      {annotationTool ? <div className="pointer-events-none absolute left-1/2 top-11 -translate-x-1/2 rounded bg-slate-950/85 px-2 py-1 font-mono text-[9px] text-white">Click the chart to place {annotationTool === "callout" ? "a callout" : "text"}</div> : null}
      {isZoomed ? <div className="pointer-events-none absolute left-6 top-11 rounded bg-black/50 px-1.5 py-0.5 font-mono text-[9px] text-white/80">zoom {Math.round((lastIdx / span) * 100) / 100}x</div> : null}
      {!annotationTool ? <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/45 px-2 py-0.5 font-mono text-[9px] text-white/85">{data?.saved_evidence?"Saved snapshot · drag to pan":"Drag right for earlier data"}</div> : null}
    </div>
  );
}

// A draggable label with an arrow-marker handle and a connector back to its
// anchor. Drag is initiated here; movement is tracked on the SVG root so it
// keeps following the cursor even outside the label's own bounds.
function DraggableLabel({
  id,
  anchorX,
  anchorY,
  color,
  text,
  offset,
  onStart,
  onDelete,
  variant,
}: {
  id: string;
  anchorX: number;
  anchorY: number;
  color: string;
  text: string;
  offset: LabelOffset;
  onStart: (id: string, event: React.PointerEvent) => void;
  onDelete: (id: string, event: React.MouseEvent) => void;
  variant: "price" | "ict";
}) {
  const boxWidth = Math.max(variant === "price" ? 40 : 30, text.length * 5.4 + 16);
  const labelX = anchorX + (variant === "price" ? -boxWidth - 8 : 0) + offset.dx;
  const labelY = anchorY + offset.dy;
  const fontSize = variant === "price" ? 9.5 : 8.5;
  const connectorX = variant === "price" ? labelX + boxWidth - 2 : labelX + 2;
  const textX = variant === "price" ? labelX + 6 : labelX + 11;

  return (
    <g>
      <line x1={anchorX} y1={anchorY} x2={connectorX} y2={labelY} stroke={color} strokeWidth="0.75" strokeDasharray="2 2" opacity="0.85" />
      <circle cx={anchorX} cy={anchorY} r="2" fill={color} />
      <g style={{ cursor: "grab" }} onPointerDown={(e) => onStart(id, e)} onContextMenu={(e) => onDelete(id, e)}>
        {/* transparent, larger grab area */}
        <rect x={labelX - 2} y={labelY - 10} width={boxWidth + 6} height={20} fill="transparent" />
        <rect x={labelX} y={labelY - 8} width={boxWidth} height={16} rx={3} fill="#ffffff" stroke={color} strokeWidth="0.9" opacity="0.97" />
        {variant === "price"
          ? <polygon points={`${labelX + boxWidth - 7},${labelY - 3} ${labelX + boxWidth - 7},${labelY + 3} ${labelX + boxWidth - 3},${labelY}`} fill={color} />
          : <polygon points={`${labelX + 3},${labelY - 3} ${labelX + 3},${labelY + 3} ${labelX + 7},${labelY}`} fill={color} />}
        <text x={textX} y={labelY + 3} fill={color} fontSize={fontSize} fontWeight="700">{text}</text>
      </g>
    </g>
  );
}

function ChartAnnotationLabel({
  annotation,
  onStart,
  onDelete,
}: {
  annotation: ChartAnnotation;
  onStart: (id: string, event: React.PointerEvent) => void;
  onDelete: (id: string, event: React.MouseEvent) => void;
}) {
  const boxWidth = Math.max(42, annotation.text.length * 6.1 + 18);
  const isCallout = annotation.kind === "callout";
  return (
    <g style={{ cursor: "grab" }} onPointerDown={(event) => onStart(annotation.id, event)} onContextMenu={(event) => onDelete(annotation.id, event)}>
      {isCallout ? <line x1={annotation.x - 24} y1={annotation.y + 20} x2={annotation.x} y2={annotation.y + 7} stroke="#7c3aed" strokeWidth="1.2" /> : null}
      {isCallout ? <circle cx={annotation.x - 24} cy={annotation.y + 20} r="2.5" fill="#7c3aed" /> : null}
      <rect x={annotation.x} y={annotation.y - 10} width={boxWidth} height={20} rx={isCallout ? 5 : 2} fill={isCallout ? "#f5f3ff" : "#ffffff"} stroke={isCallout ? "#7c3aed" : "#334155"} strokeWidth="1" opacity="0.97" />
      <text x={annotation.x + 9} y={annotation.y + 4} fill={isCallout ? "#5b21b6" : "#0f172a"} fontSize="10" fontWeight="700">{annotation.text}</text>
    </g>
  );
}
