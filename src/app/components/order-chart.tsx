"use client";

import { Download, Maximize2, Minimize2, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Shared, self-contained ICT order chart used by both the Backtest dashboard and
// the Realtime Orders dashboard. Features:
//   - a gap-free ordinal (index-based) time axis, so non-trading hours never
//     open empty stretches in the candle series;
//   - wheel / button zoom and drag-to-pan;
//   - EVERY label is draggable (price lines AND ICT context labels) with an
//     arrow-marker handle; the drag uses exact SVG matrix mapping and captures
//     the pointer on the SVG root so it tracks the cursor precisely up / down /
//     left / right;
//   - a timeframe selector (5m / 15m / 30m / 1h) that only offers timeframes the
//     signal actually has ICT labels for; higher timeframes are aggregated from
//     the 5m base client-side;
//   - lazy loading of older candles when you pan/drag to the left edge;
//   - a maximise (fullscreen) toggle and a one-click PNG export that captures the
//     current zoom and label positions.

const GREEN = "#2fbf71";
const RED = "#e5484d";
const GOLD = "#d9a441";

export type Candle = { time: number; open: number; high: number; low: number; close: number };
export type OverlayZone = { kind: string; top: number; bottom: number; time: number; direction: string | null; broken: boolean; mitigated: boolean; filled: boolean; label: string };
export type OverlayLevel = { kind: string; level: number; time: number; side: string | null; direction: string | null; label: string };
export type BiasInfo = { weekly: string | null; daily: string | null; one_hour: string | null };

export type OrderChartResponse = {
  success: boolean;
  error?: string;
  timeframe?: string;
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
  overlays?: {
    order_blocks: OverlayZone[];
    fvgs: OverlayZone[];
    liquidity: OverlayLevel[];
    swings: OverlayLevel[];
    structure: OverlayZone[];
    bias: BiasInfo | null;
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

function isIfvgZone(zone: OverlayZone) {
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
    .map((zone) => ({ ...zone, kind: "fvg" }))
    .sort((a, b) => a.time - b.time);
  const groups: OverlayZone[][] = [];
  for (const zone of fvgZones) {
    const group = groups.find((items) => items.some((item) => zonesRepresentSameArea(zone, item)));
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
  { key: "5m", label: "5m", sec: 300, overlayKey: "timeframe_5m" },
  { key: "15m", label: "15m", sec: 900, overlayKey: "timeframe_15m" },
  { key: "30m", label: "30m", sec: 1800, overlayKey: "timeframe_30m" },
  { key: "1h", label: "1h", sec: 3600, overlayKey: "timeframe_1h" },
];
type TfKey = "5m" | "15m" | "30m" | "1h";

function aggregateCandles(cs: Candle[], sec: number): Candle[] {
  if (!cs.length || sec <= 300) return cs;
  const buckets = new Map<number, Candle>();
  const order: number[] = [];
  for (const c of cs) {
    const b = Math.floor(c.time / sec) * sec;
    const existing = buckets.get(b);
    if (!existing) {
      buckets.set(b, { time: b, open: c.open, high: c.high, low: c.low, close: c.close });
      order.push(b);
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
    }
  }
  return order.sort((a, b) => a - b).map((b) => buckets.get(b)!);
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="flex items-center gap-1"><span className="h-0.5 w-4 shrink-0" style={{ backgroundColor: color }} />{label}</span>;
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
  onClose,
  height = 520,
}: {
  order: OrderChartMeta;
  targetNo: string;
  endpoint: string;
  identifierParam?: string;
  identifier?: string;
  onClose: () => void;
  height?: number;
}) {
  const [data, setData] = useState<OrderChartResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const idValue = identifier ?? order.order_id;

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      const url = `${endpoint}?${identifierParam}=${encodeURIComponent(idValue)}&target_no=${targetNo}`;
      fetch(url, { cache: "no-store" })
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
  }, [endpoint, identifierParam, idValue, targetNo]);

  const bias = data?.overlays?.bias;
  const r = order.r ?? data?.order?.realized_r ?? null;

  return (
    <div className="p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-[#93a1b6]">
        <Legend color={GOLD} label="Entry" />
        <Legend color={RED} label="Stop" />
        <Legend color={GREEN} label="TPs" />
        <Legend color="#0284c7" label="FVG" />
        <Legend color="#9333ea" label="OB" />
        <Legend color="#2563eb" label="Liquidity / structure" />
        {bias ? (
          <span className="ml-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white/80">
            W: <BiasBadge v={bias.weekly} /> | D: <BiasBadge v={bias.daily} /> | 1h: <BiasBadge v={bias.one_hour} />
          </span>
        ) : null}
        <span className="ml-auto font-mono text-[10px] text-white/50">Labels auto-space · scroll to zoom · drag to pan or fine-tune labels</span>
        {r !== null ? <span className={cx("font-mono", r >= 0 ? "text-[#62d894]" : "text-[#ff8b91]")}>{r >= 0 ? "+" : ""}{fmt(r)}R</span> : null}
        <button onClick={onClose} className="grid size-6 place-items-center rounded border border-white/10 text-[#93a1b6] hover:text-white" title="Close chart"><X className="size-3.5" /></button>
      </div>

      {loading ? <div className="grid place-items-center text-sm text-[#93a1b6]" style={{ height }}>Loading candles...</div> : null}
      {error ? <div className="grid place-items-center text-sm text-[#ff9da2]" style={{ height }}>{error}</div> : null}

      {!loading && !error ? (
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
    </div>
  );
}

type LabelOffset = { dx: number; dy: number };
type ViewRange = { start: number; end: number };
type DragState =
  | { kind: "label"; id: string; startX: number; startY: number; base: LabelOffset }
  | { kind: "pan"; startX: number; startView: ViewRange }
  | null;

function ToolButton({ onClick, title, active, children }: { onClick: () => void; title: string; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cx(
        "grid h-7 min-w-7 place-items-center rounded border px-1.5 text-[10px] font-semibold shadow-sm transition",
        active ? "border-amber-500 bg-amber-100 text-amber-900" : "border-slate-400/40 bg-white/80 text-slate-700 hover:bg-white hover:text-slate-900",
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
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState>(null);
  const loadingOlderRef = useRef(false);
  const exhaustedLeftRef = useRef(false);

  const [maximized, setMaximized] = useState(false);
  const [labelOffsets, setLabelOffsets] = useState<Record<string, LabelOffset>>({});
  const [view, setView] = useState<ViewRange | null>(null);
  const [panning, setPanning] = useState(false);
  const [tf, setTf] = useState<TfKey>("5m");
  const [loadingOlder, setLoadingOlder] = useState(false);

  const [baseCandles, setBaseCandles] = useState<Candle[]>(
    () => (data?.candles ?? []).filter((c) => c && Number.isFinite(c.time)).sort((a, b) => a.time - b.time),
  );

  const overlays = data?.overlays;

  // Exchange timezone for this order — all datetimes below render in it.
  const tz = marketTimeZone(data?.order?.market, symbol);
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
  const is5mBase = baseStep > 0 && baseStep <= 600;

  const tfHasLabels = useCallback((overlayKey: string) => {
    const o = overlays ? (overlays as Record<string, unknown>)[overlayKey] as Record<string, unknown> | undefined : undefined;
    if (!o) return false;
    return Object.values(o).some((arr) => Array.isArray(arr) && arr.length > 0);
  }, [overlays]);

  // 5m is always available (execution base). Higher TFs only when the strategy
  // json actually recorded labels for that timeframe.
  const availableTfs = useMemo(
    () => TF_ORDER.filter((t) => (t.key === "5m" ? true : is5mBase && tfHasLabels(t.overlayKey))),
    [is5mBase, tfHasLabels],
  );
  const activeTf = availableTfs.some((t) => t.key === tf) ? tf : "5m";
  const activeTfMeta = TF_ORDER.find((t) => t.key === activeTf)!;

  const candles = useMemo(
    () => (activeTf === "5m" || !is5mBase ? baseCandles : aggregateCandles(baseCandles, activeTfMeta.sec)),
    [baseCandles, activeTf, is5mBase, activeTfMeta.sec],
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

  const tfOverlays = overlays ? ((overlays as Record<string, unknown>)[activeTfMeta.overlayKey] as Record<string, OverlayZone[] | OverlayLevel[]> | undefined) : undefined;

  const visLo = clamp(Math.floor(start), 0, lastIdx);
  const visHi = clamp(Math.ceil(end), 0, lastIdx);

  // Only show ICT context that formed at or before the entry — nothing after we
  // are in the trade. (Post-entry review labels can be added back later.)
  const beforeEntry = (t: number | null | undefined) => t === null || t === undefined || t <= entryTime;
  const showZones = tfOverlays ? {
    order_blocks: (tfOverlays["order_blocks"] as OverlayZone[] ?? []).filter((z) => beforeEntry(z.time)).sort((a, b) => a.time - b.time).slice(-2),
    fvgs: fvgOnlyZones((tfOverlays["fvgs"] as OverlayZone[] ?? []).filter((z) => beforeEntry(z.time))).slice(-4),
    structure: (tfOverlays["structure"] as OverlayZone[] ?? []).filter((z) => beforeEntry(z.time)).sort((a, b) => a.time - b.time).slice(-2),
    liquidity: (tfOverlays["liquidity"] as OverlayLevel[] ?? []).filter((l) => beforeEntry(l.time)).sort((a, b) => a.time - b.time).slice(-2),
    swings: (tfOverlays["swings"] as OverlayLevel[] ?? []).filter((l) => beforeEntry(l.time)).sort((a, b) => a.time - b.time).slice(-2),
  } : null;

  // ----- Price extremes over the visible window -----------------------------
  const allPrices: number[] = [];
  for (let i = visLo; i <= visHi && i < slotCount; i += 1) allPrices.push(candles[i].low, candles[i].high);
  const orderPrices = [data?.order?.filled_price ?? data?.order?.entry_price, data?.order?.stoploss, data?.order?.tp1, data?.order?.tp2, data?.order?.tp3, data?.order?.close_price].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
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
  if (!allPrices.length) allPrices.push(100, 101);
  const min = Math.min(...allPrices);
  const max = Math.max(...allPrices);
  const priceRange = Math.max(max - min, 0.0001);
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
  const loadOlder = useCallback(() => {
    if (loadingOlderRef.current || exhaustedLeftRef.current || !is5mBase || !endpoint || baseCandles.length === 0) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const earliest = baseCandles[0].time;
    const chunk = baseStep * 1500;
    const fromTs = earliest - chunk;
    const toTs = earliest - baseStep;
    const url = `${endpoint}?${identifierParam}=${encodeURIComponent(identifier)}&target_no=${targetNo}&from_ts=${fromTs}&to_ts=${toTs}&step=${baseStep}`;
    const displayedBefore = candles.length;
    fetch(url, { cache: "no-store" })
      .then((r) => r.json())
      .then((payload: OrderChartResponse) => {
        const older = (payload.candles ?? []).filter((c) => c && Number.isFinite(c.time) && c.time < earliest);
        if (!older.length) {
          exhaustedLeftRef.current = true;
          return;
        }
        const seen = new Set(baseCandles.map((c) => c.time));
        const merged = [...older.filter((c) => !seen.has(c.time)), ...baseCandles].sort((a, b) => a.time - b.time);
        setBaseCandles(merged);
        const displayedAfter = activeTf === "5m" ? merged : aggregateCandles(merged, activeTfMeta.sec);
        const delta = displayedAfter.length - displayedBefore;
        if (delta > 0) {
          // When panning while zoomed, keep the same bars in view (shift by the
          // number of newly-prepended bars). When at full view, reveal the newly
          // loaded older history on the left so the drag visibly goes back in time.
          setView((v) => (v
            ? { start: v.start + delta, end: v.end + delta }
            : { start: 0, end: Math.max(displayedBefore - 1, 0) }));
        }
      })
      .catch(() => { /* keep what we have */ })
      .finally(() => {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      });
  }, [baseCandles, baseStep, is5mBase, endpoint, identifierParam, identifier, targetNo, candles.length, activeTf, activeTfMeta.sec]);

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
    svgRef.current?.setPointerCapture?.(event.pointerId);
  }, [toUser, labelOffsets]);

  const onSvgPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    // Started on empty chart area -> begin panning.
    if (dragRef.current) return;
    const p = toUser(event.clientX, event.clientY);
    if (p.x < pad || p.x > width - pad || p.y < pad || p.y > vbHeight - pad) return;
    dragRef.current = { kind: "pan", startX: p.x, startView: { start, end } };
    setPanning(true);
    svgRef.current?.setPointerCapture?.(event.pointerId);
  };
  const onSvgPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = toUser(event.clientX, event.clientY);
    if (drag.kind === "label") {
      setLabelOffsets((cur) => ({ ...cur, [drag.id]: { dx: drag.base.dx + (p.x - drag.startX), dy: drag.base.dy + (p.y - drag.startY) } }));
      return;
    }
    // pan
    const dxBars = ((p.x - drag.startX) / plotW) * span;
    let ns = drag.startView.start - dxBars;
    let ne = drag.startView.end - dxBars;
    if (ns < 0) { ne -= ns; ns = 0; }
    if (ne > lastIdx) { ns -= ne - lastIdx; ne = lastIdx; }
    ns = Math.max(0, ns);
    setView({ start: ns, end: ne });
    if (ns <= 5) loadOlder();
  };
  const onSvgPointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    setPanning(false);
    svgRef.current?.releasePointerCapture?.(event.pointerId);
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
  pushLine("price:entry", entryPrice, "#b7791f", `ENTRY ${entryPrice != null ? entryPrice.toFixed(2) : "?"}`);
  pushLine("price:sl", data?.order?.stoploss, "#dc2626", `SL ${data?.order?.stoploss?.toFixed(2) ?? "?"}`);
  pushLine("price:tp1", data?.order?.tp1, "#15803d", `TP1 ${data?.order?.tp1?.toFixed(2) ?? "?"}`);
  pushLine("price:tp2", data?.order?.tp2, "#15803d", `TP2 ${data?.order?.tp2?.toFixed(2) ?? "?"}`, true);
  pushLine("price:tp3", data?.order?.tp3, "#15803d", `TP3 ${data?.order?.tp3?.toFixed(2) ?? "?"}`, true);

  // ICT overlay geometry. Order Blocks & Fair Value Gaps render as boxes that
  // extend from where they formed across to the entry. Structure (BOS/MSS/CHoCH),
  // liquidity and swings render as single horizontal lines; near-equal levels are
  // de-duplicated so there is one clean line each instead of a cluster.
  type BoxItem = { id: string; x: number; yTop: number; yBot: number; color: string; label: string; opacity: number };
  type LineItem = { id: string; x: number; y: number; color: string; label: string };
  const boxItems: BoxItem[] = [];
  const lineItems: LineItem[] = [];
  if (showZones) {
    const zones = [...showZones.order_blocks, ...showZones.fvgs];
    zones.forEach((zone, index) => {
      const kind = zone.kind.toLowerCase();
      const isFvg = kind === "fvg";
      const color = isFvg ? "#0284c7" : "#9333ea";
      boxItems.push({
        id: `box:${activeTf}:${kind}:${index}`,
        x: xByTime(zone.time),
        yTop: y(Math.max(zone.top, zone.bottom)),
        yBot: y(Math.min(zone.top, zone.bottom)),
        color,
        label: isFvg ? "FVG" : "ORDER BLOCK",
        opacity: isFvg ? 0.11 : 0.1,
      });
    });
    const side = (value: string | null) => (value === "buyside" ? "↑" : value === "sellside" ? "↓" : "");
    const rawLines: { level: number; time: number; color: string; label: string; priority: number }[] = [];
    for (const z of showZones.structure) rawLines.push({ level: (z.top + z.bottom) / 2, time: z.time, color: "#1d4ed8", label: (z.kind || "MSS").toUpperCase(), priority: 2 });
    for (const l of showZones.liquidity) rawLines.push({ level: l.level, time: l.time, color: "#2563eb", label: `${side(l.side)} LIQUIDITY`.trim(), priority: 3 });
    for (const l of showZones.swings) rawLines.push({ level: l.level, time: l.time, color: "#1e40af", label: `${side(l.side)} SWING`.trim(), priority: 1 });
    const tol = priceRange * 0.004;
    const kept: typeof rawLines = [];
    for (const item of rawLines.filter((row) => Number.isFinite(row.level)).sort((a, b) => b.priority - a.priority || b.time - a.time)) {
      if (kept.some((k) => Math.abs(k.level - item.level) <= tol)) continue;
      kept.push(item);
    }
    kept.slice(0, 5).sort((a, b) => a.time - b.time).forEach((item, index) => lineItems.push({ id: `line:${activeTf}:${index}`, x: xByTime(item.time), y: y(item.level), color: item.color, label: item.label }));
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
            {availableTfs.map((t) => (
              <ToolButton key={t.key} title={`${t.label} context`} active={t.key === activeTf} onClick={() => { setTf(t.key); setView(null); }}>{t.label}</ToolButton>
            ))}
            {loadingOlder ? <span className="ml-1 text-[9px] text-slate-500">loading history…</span> : null}
          </div>
          <div className="flex items-center gap-1.5">
            <ToolButton onClick={() => zoomBy(1 / 1.35)} title="Zoom in"><ZoomIn className="size-3.5" /></ToolButton>
            <ToolButton onClick={() => zoomBy(1.35)} title="Zoom out"><ZoomOut className="size-3.5" /></ToolButton>
            <ToolButton onClick={() => { setView(null); setLabelOffsets({}); }} title="Reset view & labels"><RotateCcw className="size-3.5" /></ToolButton>
            <ToolButton onClick={downloadPng} title="Download PNG"><Download className="size-3.5" /></ToolButton>
            <ToolButton onClick={() => setMaximized((m) => !m)} title={maximized ? "Exit fullscreen" : "Maximise"}>{maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}</ToolButton>
          </div>
        </div>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${vbHeight}`}
          className="w-full touch-none select-none rounded-md bg-[#e5e7eb]"
          style={{ height: maximized ? "calc(100vh - 96px)" : `${vbHeight}px`, maxHeight: maximized ? undefined : `${vbHeight}px`, cursor: panning ? "grabbing" : "grab" }}
          aria-label="Interactive five minute ICT order chart"
          onPointerDown={onSvgPointerDown}
          onPointerMove={onSvgPointerMove}
          onPointerUp={onSvgPointerUp}
          onPointerCancel={onSvgPointerUp}
        >
          <defs>
            <clipPath id="afterEntry-order"><polygon points={`${entryX},0 ${width},0 ${width},${vbHeight} ${entryX},${vbHeight}`} /></clipPath>
            <clipPath id="plot-order"><rect x={pad} y={pad} width={plotW} height={plotH} /></clipPath>
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
            return <text key={`p-${i}`} x={pad - 4} y={pad + (i / 4) * plotH + 3} fill="rgba(15,23,42,0.6)" fontSize="9" textAnchor="end">{price.toFixed(2)}</text>;
          })}

          {/* Clipped plot contents (candles, zones, price lines) */}
          <g clipPath="url(#plot-order)">
            <line x1={entryX} x2={entryX} y1={pad} y2={vbHeight - pad} stroke="#b7791f" strokeWidth="1" strokeDasharray="3 4" opacity="0.75" />

            {/* Order Blocks & FVGs — boxes extended from formation to the entry line */}
            {boxItems.map((b) => (
              <rect key={b.id} x={b.x} y={b.yTop} width={Math.max(2, entryX - b.x)} height={Math.max(1, b.yBot - b.yTop)} fill={b.color} opacity={b.opacity} stroke={b.color} strokeWidth="0.7" />
            ))}

            {/* Structure / liquidity / swings — one clean horizontal line each,
                drawn only up to the entry (no context past the entry datetime) */}
            {lineItems.map((l) => (
              <line key={l.id} x1={Math.max(pad, Math.min(l.x, entryX))} x2={entryX} y1={l.y} y2={l.y} stroke={l.color} strokeWidth="0.9" strokeDasharray="5 4" opacity="0.65" />
            ))}

            {slotCount > 0 ? (
              <>
                <g clipPath="url(#afterEntry-order)">
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
              {entryDateStr} {tzLabel} @ {entryPrice !== null && entryPrice !== undefined ? entryPrice.toFixed(2) : "?"}
            </text>
          </g>

          {/* ICT context labels — draggable */}
          {slotCount > 0 ? ictLabels.map((lbl) => (
            <DraggableLabel key={lbl.id} id={lbl.id} anchorX={lbl.anchorX} anchorY={lbl.anchorY} color={lbl.color} text={lbl.text} offset={{ dx: lbl.autoOffset.dx + (labelOffsets[lbl.id]?.dx ?? 0), dy: lbl.autoOffset.dy + (labelOffsets[lbl.id]?.dy ?? 0) }} onStart={startLabelDrag} variant="ict" />
          )) : null}

          {/* Price labels — draggable, anchored at the right axis */}
          {slotCount > 0 ? priceLines.map((line) => (
            <DraggableLabel key={`lbl-${line.id}`} id={line.id} anchorX={width - pad} anchorY={y(line.price)} color={line.color} text={line.label} offset={{ dx: labelOffsets[line.id]?.dx ?? 0, dy: (priceAutoOffsets.get(line.id) ?? 0) + (labelOffsets[line.id]?.dy ?? 0) }} onStart={startLabelDrag} variant="price" />
          )) : null}
        </svg>
      </div>
      {isZoomed ? <div className="pointer-events-none absolute left-6 top-11 rounded bg-black/50 px-1.5 py-0.5 font-mono text-[9px] text-white/80">zoom {Math.round((lastIdx / span) * 100) / 100}x</div> : null}
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
  variant,
}: {
  id: string;
  anchorX: number;
  anchorY: number;
  color: string;
  text: string;
  offset: LabelOffset;
  onStart: (id: string, event: React.PointerEvent) => void;
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
      <g style={{ cursor: "grab" }} onPointerDown={(e) => onStart(id, e)}>
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
