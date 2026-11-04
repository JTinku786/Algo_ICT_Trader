"use client";

// ATM option leg chart for the Scalping Labs paper lanes (Scalping_OB_OB_V4, BPR_OB_V3).
// Shows the contract's 5-minute bars from the entry candle to the exit candle with entry / +2R half / exit markers.
import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, LineSeries, ColorType, LineStyle, createChart, createSeriesMarkers, type Time } from "lightweight-charts";

type Leg = {
  occ_symbol: string | null; option_type: string; expiration: string; strike: number | null; days_to_expiry: number | null; contract_rule: string | null;
  multiplier: number | null; underlying: string; direction: string; underlying_entry: number | null; entry_price: number | null; entry_bid: number | null;
  entry_ask: number | null; entry_mark: number | null; premium_per_contract: number | null; partial_price: number | null; exit_price: number | null;
  return_pct: number | null; underlying_r: number | null; state: string; execution_status: string | null; source_mode: string;
  same_bar_round_trip: boolean | null; bars_complete: boolean | null; data_quality?: string | null;
  underlying_entry_datetime?: string; underlying_exit_datetime?: string | null;
};
type Bar = { time: number; open: number; high: number; low: number; close: number; interpolated: boolean };
type Marker = { time: number; kind: string; price: number | null; label: string };
type PaperExecution = { status: string; reason: string; trigger_bar: string; filled_at: string | null; entry_quote_at: string | null;
  drift_r: number | null; entry_option_price: number | null; exit_at: string | null;
  exit_option_price: number | null; option_return_pct: number | null;
  contract: { strike: number; expiration: string; option_type: string } | null };
type Resp = { success: boolean; error?: string; strategy?: string; leg?: Leg; bars?: Bar[]; markers?: Marker[];
  paper_execution?: PaperExecution | null; price_basis?: string; execution_bars?: Bar[]; execution_markers?: Marker[];
  window?: { start: number; end: number; timezone: string }; execution_window?: { start: number; end: number; timezone: string } | null;
  timing_audit?: { earliest_decision_et: string | null; decision: string; underlying_drift_r: number | null; causal_plan_reconstructed: boolean } | null };

const money = (v: number | null | undefined) => (v === null || v === undefined ? "-" : `$${v.toFixed(2)}`);
const axisTime = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const preciseTime = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const formatChartTime = (time: Time, precise = false) => typeof time === "number" ? `${(precise ? preciseTime : axisTime).format(new Date(time * 1000))}${precise ? " ET" : ""}` : String(time);

export default function OptionLegChart({ orderId }: { orderId: string }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [data, setData] = useState<Resp | null>(null);
  const [chartMode, setChartMode] = useState<"reference" | "paper">("reference");
  const activeChartMode = chartMode === "paper" && data?.paper_execution?.filled_at ? "paper" : "reference";

  useEffect(() => {
    let alive = true;
    const load = () => fetch(`/api/realtime-analytics/option-chart?order_id=${encodeURIComponent(orderId)}`, { cache: "no-store" })
      .then((r) => r.json()).then((j: Resp) => { if (alive) setData(j); })
      .catch((e) => { if (alive) setData({ success: false, error: String(e) }); });
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [orderId]);

  useEffect(() => {
    const bars = activeChartMode === "paper" ? data?.execution_bars : data?.bars;
    const markers = activeChartMode === "paper" ? data?.execution_markers : data?.markers;
    const window = activeChartMode === "paper" ? data?.execution_window : data?.window;
    if (!host.current || !data?.success || !window) return;
    const boundedBars = (bars ?? []).filter((b) => b.time >= window.start && b.time + 300 <= window.end);
    const boundedMarkers = (markers ?? []).filter((m) => m.time >= window.start && m.time <= window.end && m.price !== null);
    if (!boundedBars.some((b) => !b.interpolated) && !boundedMarkers.length) return;
    const chart = createChart(host.current, {
      autoSize: true, height: 320,
      layout: { background: { type: ColorType.Solid, color: "#101620" }, textColor: "#93a1b6" },
      grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      localization: { timeFormatter: (time: Time) => formatChartTime(time, true) },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 0, fixLeftEdge: true, fixRightEdge: true, tickMarkFormatter: (time: Time) => formatChartTime(time) }, rightPriceScale: { borderColor: "rgba(255,255,255,0.1)" },
    });
    const series = chart.addSeries(CandlestickSeries, { upColor: "#34d399", downColor: "#fb7185", wickUpColor: "#34d399", wickDownColor: "#fb7185", borderVisible: false });
    const candles = new Map(boundedBars.map((b) => [b.time, b]));
    const times = [...new Set([window.start, window.end, ...boundedBars.map((b) => b.time), ...boundedMarkers.map((m) => m.time)])].sort((a, b) => a - b);
    series.setData(times.map((time) => {
      const b = candles.get(time);
      return !b || b.interpolated ? { time: time as Time } : { time: time as Time, open: b.open, high: b.high, low: b.low, close: b.close };
    }));
    const colorOf = (k: string) => (k === "ENTRY" ? "#38bdf8" : k === "PARTIAL" ? "#fbbf24" : k === "EXIT_WIN" ? "#34d399" : "#fb7185");
    for (const m of boundedMarkers) {
      if (m.price !== null) series.createPriceLine({ price: m.price, color: colorOf(m.kind), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: m.label });
    }
    // Event points keep exact entry/exit times instead of snapping them to candle opens.
    const eventSeries = chart.addSeries(LineSeries, { color: "#38bdf8", lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 4, lastValueVisible: false, priceLineVisible: false });
    const points = new Map(boundedMarkers.map((m) => [m.time, m.price as number]));
    eventSeries.setData([...points].sort(([a], [b]) => a - b).map(([time, value]) => ({ time: time as Time, value })));
    createSeriesMarkers(eventSeries, boundedMarkers.map((m) => ({
      time: m.time as Time, position: m.kind === "ENTRY" ? "belowBar" as const : "aboveBar" as const, color: colorOf(m.kind),
      shape: m.kind === "ENTRY" ? "arrowUp" as const : "circle" as const, text: m.label,
    })));
    chart.timeScale().setVisibleRange({ from: window.start as Time, to: window.end as Time });
    return () => chart.remove();
  }, [data, activeChartMode]);

  if (!data) return <div className="px-4 py-6 text-sm text-[#93a1b6]">Loading option leg…</div>;
  if (!data.success || !data.leg) return <div className="px-4 py-6 text-sm text-[#93a1b6]">{data.error ?? "No option leg recorded for this order."}</div>;
  const l = data.leg;
  const execution = data.paper_execution;
  const chartBars = activeChartMode === "paper" ? data.execution_bars : data.bars;
  const chartMarkers = activeChartMode === "paper" ? data.execution_markers : data.markers;
  const chartWindow = activeChartMode === "paper" ? data.execution_window : data.window;
  const hasPlot = chartBars?.some((b) => !b.interpolated) || chartMarkers?.some((m) => m.price !== null);
  const timestamp = (value: string | null | undefined) => value ? new Date(value).toLocaleString("en-US", { timeZone: "America/New_York" }) + " ET" : "—";
  const stats: [string, string][] = [
    ["Contract", l.occ_symbol ?? `${l.underlying} ${l.strike} ${l.option_type}`], ["Expiry", `${l.expiration} · ${l.days_to_expiry ?? "-"} DTE`],
    ["Strike / underlying", `${l.strike ?? "-"} / ${l.underlying_entry?.toFixed(2) ?? "-"}`], ["Premium / contract", money(l.premium_per_contract)],
    ["Entry", money(l.entry_price)], ["Bid / ask / mark", l.entry_bid !== null ? `${money(l.entry_bid)} / ${money(l.entry_ask)} / ${money(l.entry_mark)}` : "historical bar only"],
    ["+2R half", money(l.partial_price)], ["Exit", money(l.exit_price)],
    ["Option return", l.return_pct === null ? "-" : `${l.return_pct >= 0 ? "+" : ""}${l.return_pct.toFixed(1)}%`], ["Underlying R", l.underlying_r === null ? "open" : `${l.underlying_r.toFixed(2)}R`],
  ];
  return (
    <div className="overflow-hidden rounded-md border border-white/10 bg-[#101620]">
      <div className="flex flex-wrap items-center gap-3 border-b border-white/10 px-4 py-3">
        <h3 className="text-sm font-semibold">ATM Option · {l.option_type === "call" ? "Call" : "Put"} · entry to exit · ET</h3>
        <span className="ml-auto text-[10px] text-[#7f8ca3]">{data.strategy} · {l.execution_status ?? l.source_mode} · {l.contract_rule ?? ""}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 px-4 py-3 text-xs sm:grid-cols-5">
        {stats.map(([k, v]) => (<div key={k}><div className="text-[9px] uppercase tracking-wider text-[#657187]">{k}</div><div className="mt-0.5 font-mono text-white">{v}</div></div>))}
      </div>
      <div className="px-4 pb-2 text-[11px] text-[#93a1b6]">Reference chart · {timestamp(l.underlying_entry_datetime)} → {timestamp(l.underlying_exit_datetime)}. Prices are option candle closes, not broker fills.</div>
      {chartWindow ? <div className="px-4 pb-2 text-xs text-sky-200">Plotted period: {formatChartTime(chartWindow.start as Time, true)} → {formatChartTime(chartWindow.end as Time, true)} · {Math.floor((chartWindow.end-chartWindow.start)/3600)}h {Math.floor((chartWindow.end-chartWindow.start)%3600/60)}m</div> : null}
      {data.timing_audit ? <div className="mx-4 mb-3 rounded border border-amber-300/20 p-2 text-[11px] text-amber-100">
        Historical one-minute replay: {data.timing_audit.decision} · earliest decision {timestamp(data.timing_audit.earliest_decision_et)}
        {data.timing_audit.underlying_drift_r !== null ? ` · drift ${Number(data.timing_audit.underlying_drift_r).toFixed(3)}R` : ""}<br />
        Setup reconstructed before touch: {data.timing_audit.causal_plan_reconstructed ? "yes" : "no"}. This is a timing reconstruction; historical executable option quotes are unavailable.
      </div> : null}
      {execution ? <div className="mx-4 mb-3 rounded border border-sky-400/20 p-2 text-[11px] text-sky-200">
        One-minute paper execution: {execution.status} · {execution.reason}<br />
        Touch candle: {timestamp(execution.trigger_bar)} · Simulated entry: {timestamp(execution.filled_at)} at {money(execution.entry_option_price)}
        <br />Robinhood entry quote timestamp: {timestamp(execution.entry_quote_at)}
        {execution.drift_r !== null ? ` · drift ${Number(execution.drift_r).toFixed(3)}R` : ""}
        {execution.exit_at ? <><br />Simulated exit: {timestamp(execution.exit_at)} at {money(execution.exit_option_price)}</> : null}
        {execution.contract ? <><br />Fixed contract: {execution.contract.strike} {execution.contract.option_type} · expires {execution.contract.expiration}</> : null}
      </div> : null}
      {execution?.filled_at ? <div className="flex gap-2 px-4 pb-2 text-xs">
        <button type="button" aria-pressed={activeChartMode === "reference"} onClick={() => setChartMode("reference")} className="rounded border border-white/20 px-2 py-1">Reference activity</button>
        <button type="button" aria-pressed={activeChartMode === "paper"} onClick={() => setChartMode("paper")} className="rounded border border-white/20 px-2 py-1">Minute paper activity</button>
      </div> : null}
      {activeChartMode === "paper" ? <div className="px-4 pb-2 text-[11px] text-[#93a1b6]">Fixed paper-entry contract through its actual simulated exit. Only complete five-minute candles inside this interval are shown; entry and exit dots use the recorded fill timestamps and quote prices.</div> : null}
      {l.data_quality === "NO_REAL_DATA" ? <div className="px-4 pb-2 text-[11px] text-rose-300">The provider returned no real option prints for this interval. Placeholder bars are hidden; option prices and returns remain unavailable.</div> : null}
      {l.data_quality === "PARTIAL_INTERPOLATED" || l.data_quality === "MISSING_OR_INTERPOLATED" ? <div className="px-4 pb-2 text-[11px] text-amber-300">Some option candles are missing or interpolated. The chart leaves gaps; missing entry or exit prices are not substituted.</div> : null}
      {l.same_bar_round_trip ? <div className="px-4 pb-2 text-[11px] text-amber-300">Fill and exit fell in the same 5-minute candle: the option price cannot be split within that candle.</div> : null}
      {hasPlot ? <div ref={host} className="h-[320px] w-full" /> : <div className="px-4 py-6 text-sm text-[#93a1b6]">No real option bars available.</div>}
    </div>
  );
}
