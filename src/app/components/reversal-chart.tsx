"use client";

import {anchorViewport,restoreViewport,viewportChanged,type AnchoredViewport} from "@/lib/replay-viewport";
import { useEffect, useMemo, useRef, useState } from "react";
import { computeChartFib, visibleFibStudies, FIB_VISIBILITY_DEFAULT, type FibVisibility } from "@/lib/chart-fib";
import { FibToggleButtons } from "./fib-overlay";
import {
  CandlestickSeries,
  LineSeries,
  ColorType,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";

export type ChartLine = { price: number; label: string; color: string; dashed?: boolean };
export type ChartMarker = {
  time: string;
  position: "aboveBar" | "belowBar" | "inBar";
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  color: string;
  text: string;
};
type Candle = { key: string; open: number; high: number; low: number; close: number };

// "YYYY-MM-DD" -> business day; "YYYY-MM-DD HH:MM" (ET wall clock) -> UTC-seconds of that wall-clock time,
// so the axis reads in New York time without any timezone conversion.
export function toChartTime(key: string): Time {
  if (key.length <= 10) return key as Time;
  const [d, t] = key.split(" ");
  const [y, m, dd] = d.split("-").map(Number);
  const [hh, mm] = t.split(":").map(Number);
  return (Date.UTC(y, m - 1, dd, hh, mm) / 1000) as Time;
}

// Numeric time for swing detection: intraday keys use the chart's ET wall-clock seconds, daily keys midnight UTC.
const fibTime = (key: string) => { const t = toChartTime(key); return typeof t === "number" ? t : Date.parse(key) / 1000; };

export default function ReversalChart({
  sym,
  tf,
  from,
  to,
  lines,
  markers,
  focusFrom,
  focusTo,
}: {
  sym: string;
  tf: string;
  from: string;
  to: string;
  lines: ChartLine[];
  markers: ChartMarker[];
  focusFrom?: string;
  focusTo?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const savedView=useRef<{scope:string;time:AnchoredViewport|null;price:{from:number;to:number}|null}|null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const reqKey = `${sym}|${tf}|${from}|${to}`;
  const [result, setResult] = useState<{ key: string; candles?: Candle[]; error?: string }>({ key: "" });
  const candles = result.key === reqKey ? result.candles ?? null : null;
  const error = result.key === reqKey ? result.error ?? null : null;

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/reversal/chart?sym=${encodeURIComponent(sym)}&tf=${tf}&from=${from}&to=${to}`, { cache: "no-store", signal: controller.signal })
      .then((r) => r.json())
      .then((j) => setResult(j.ok ? { key: reqKey, candles: j.candles } : { key: reqKey, error: j.error || "Chart load failed" }))
      .catch((e) => {
        if (e?.name !== "AbortError") setResult({ key: reqKey, error: String(e) });
      });
    return () => controller.abort();
  }, [reqKey, sym, tf, from, to]);

  // Fibonacci retracement / extension from confirmed swings up to the focus window end
  // (the setup), so swings that formed after it never move the anchors.
  const [fibShow, setFibShow] = useState<FibVisibility>(FIB_VISIBILITY_DEFAULT);
  const fib = useMemo(() => {
    const cutoff = focusTo ? (tf === "1d" ? focusTo : `${focusTo} 23:59`) : null;
    return computeChartFib((candles ?? []).filter((c) => !cutoff || c.key <= cutoff).map((c) => ({ t: fibTime(c.key), o: c.open, h: c.high, l: c.low, c: c.close })));
  }, [candles, focusTo, tf]);
  const fibStudies = useMemo(() => visibleFibStudies(fib, fibShow), [fib, fibShow]);

  useEffect(() => {
    if (!hostRef.current || !candles?.length) return;
    const chart = createChart(hostRef.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#0b0f16" }, textColor: "#93a1b6", fontSize: 11 },
      grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.1)" },
      timeScale: { borderColor: "rgba(255,255,255,0.1)", timeVisible: tf !== "1d", secondsVisible: false },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;
    const scope=`${sym}:${tf}`;
    const times=candles.map(c=>typeof toChartTime(c.key)==="number"?Number(toChartTime(c.key)):Date.parse(c.key));
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#2fbf71",
      downColor: "#e5484d",
      borderUpColor: "#2fbf71",
      borderDownColor: "#e5484d",
      wickUpColor: "#62d894",
      wickDownColor: "#ff8b91",
    });
    series.setData(candles.map((c) => ({ time: toChartTime(c.key), open: c.open, high: c.high, low: c.low, close: c.close })));
    for (const line of lines) {
      if (!Number.isFinite(line.price)) continue;
      series.createPriceLine({
        price: line.price,
        color: line.color,
        lineWidth: 1,
        lineStyle: line.dashed ? LineStyle.Dashed : LineStyle.Solid,
        axisLabelVisible: true,
        title: line.label,
      });
    }
    const keyByT = new Map(candles.map((c) => [fibTime(c.key), c.key]));
    for (const study of fibStudies) {
      for (const level of study.levels) {
        series.createPriceLine({ price: level.price, color: level.color, lineWidth: 1, lineStyle: study.kind === "extension" ? LineStyle.Dashed : LineStyle.Solid, axisLabelVisible: true, title: level.label });
      }
      const leg = chart.addSeries(LineSeries, { color: study.kind === "retracement" ? "#14b8a6" : "#8b5cf6", lineWidth: 2, lineStyle: LineStyle.Dotted, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: () => null });
      leg.setData(study.anchors.points.flatMap((p, i, all) => {
        const key = keyByT.get(p.t);
        return key && (i === all.length - 1 || p.t !== all[i + 1].t) ? [{ time: toChartTime(key), value: p.price }] : [];
      }));
    }
    const valid = new Set(candles.map((c) => c.key));
    const mk: SeriesMarker<Time>[] = markers
      .filter((m) => valid.has(m.time))
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((m) => ({ time: toChartTime(m.time), position: m.position, shape: m.shape, color: m.color, text: m.text }));
    createSeriesMarkers(series, mk);
    if (focusFrom && focusTo) {
      try {
        chart.timeScale().setVisibleRange({ from: toChartTime(tf === "1d" ? focusFrom : `${focusFrom} 09:30`), to: toChartTime(tf === "1d" ? focusTo : `${focusTo} 16:00`) });
      } catch {
        chart.timeScale().fitContent();
      }
    } else {
      chart.timeScale().fitContent();
    }
    const restored=savedView.current?.scope===scope && savedView.current.time ? restoreViewport(times,savedView.current.time) : null;
    if(restored)chart.timeScale().setVisibleLogicalRange(restored);
    if(savedView.current?.scope===scope && savedView.current.price)chart.priceScale("right").setVisibleRange(savedView.current.price);
    const initial=chart.timeScale().getVisibleLogicalRange();
    return () => {
      const visible=chart.timeScale().getVisibleLogicalRange();
      const priceScale=chart.priceScale("right");
      savedView.current={scope,time:visible && initial && (restored || viewportChanged(visible,initial)) ? anchorViewport(times,visible) : null,price:priceScale.options().autoScale ? null : priceScale.getVisibleRange()};
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, lines, markers, focusFrom, focusTo, tf, sym, fibStudies]);

  return (
    <div className="relative h-[460px] w-full overflow-hidden rounded-md border border-white/10 bg-[#0b0f16]">
      <div ref={hostRef} className="absolute inset-0" />
      {candles?.length ? <div className="absolute left-2 top-2 z-10"><FibToggleButtons fib={fib} value={fibShow} onChange={setFibShow} /></div> : null}
      {!candles && !error ? (
        <div className="absolute inset-0 grid place-items-center text-sm text-[#93a1b6]">Loading {sym} {tf} candles…</div>
      ) : null}
      {error ? <div className="absolute inset-0 grid place-items-center text-sm text-[#ff8b91]">{error}</div> : null}
    </div>
  );
}
