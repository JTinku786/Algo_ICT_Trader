"use client";

import type { ChartFib, FibStudy, FibVisibility } from "@/lib/chart-fib";

const btn = "rounded border px-2 py-0.5 text-[11px] font-semibold";

/** Toggle buttons shared by every ICT chart. Shows "n/a" when no valid anchor set exists. */
export function FibToggleButtons({ fib, value, onChange, tone = "dark" }: { fib: ChartFib; value: FibVisibility; onChange: (next: FibVisibility) => void; tone?: "dark" | "light" }) {
  const offClass = tone === "light" ? "border-slate-400/60 bg-white/60 text-slate-600" : "border-white/10 text-[#7f8ca3]";
  const item = (key: keyof FibVisibility, label: string, baseColor: string) => {
    const color = tone === "light" ? (key === "retracement" ? "#0f766e" : "#6d28d9") : baseColor;
    const available = !!fib[key];
    const on = value[key] && available;
    return (
      <label key={key}
        title={available ? `${label} (anchors from confirmed swings up to the entry bar)` : `No valid ${label.toLowerCase()} anchors in the candles before entry`}
        className={`${btn} inline-flex cursor-pointer items-center gap-1 ${on ? "" : offClass} ${available ? "" : "cursor-not-allowed opacity-40"}`}
        style={on ? { borderColor: color, color, background: `${color}22` } : undefined}>
        <input type="checkbox" checked={value[key]} disabled={!available} aria-label={label}
          onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
          className="size-3" style={{ accentColor: color }} />
        {label}{available ? "" : " · n/a"}
      </label>
    );
  };
  return <span className="inline-flex flex-wrap gap-1">{item("retracement", "Fib retracement", "#14b8a6")}{item("extension", "Fib extension", "#a78bfa")}</span>;
}

/**
 * SVG overlay: one horizontal line per level from the study's start swing to the
 * right edge, the anchor legs, and the ICT OTE band (61.8–78.6%) on the retracement.
 * Levels outside the visible price range are skipped on the plot and listed in `offChart`.
 */
export function SvgFibOverlay({ studies, xAt, xRight, y, top, bottom, digits = 2, labelX }: {
  studies: FibStudy[];
  xAt: (t: number) => number;
  xRight: number;
  y: (price: number) => number;
  top: number;
  bottom: number;
  digits?: number;
  labelX?: number;
}) {
  const inside = (p: number) => { const v = y(p); return v >= top && v <= bottom; };
  const labels: { y: number; text: string; color: string }[] = [];
  const groups = studies.map((study) => {
    const x0 = Math.min(xAt(study.startT), xRight - 4);
    const dash = study.kind === "extension" ? "5 3" : undefined;
    const ote = study.kind === "retracement" ? study.levels.filter((l) => l.ratio === 0.618 || l.ratio === 0.786) : [];
    const legs = study.anchors.points;
    for (const level of study.levels) if (inside(level.price)) labels.push({ y: y(level.price), text: `${level.label} ${level.price.toFixed(digits)}`, color: level.color });
    return (
      <g key={study.kind} data-testid={`fib-${study.kind}`} pointerEvents="none">
        {ote.length === 2 ? (
          <rect x={x0} width={Math.max(0, xRight - x0)}
            y={Math.max(top, Math.min(y(ote[0].price), y(ote[1].price)))}
            height={Math.max(0, Math.min(bottom, Math.max(y(ote[0].price), y(ote[1].price))) - Math.max(top, Math.min(y(ote[0].price), y(ote[1].price))))}
            fill="#f59e0b" opacity="0.08" />
        ) : null}
        {study.levels.filter((l) => inside(l.price)).map((level) => (
          <line key={level.ratio} x1={x0} x2={xRight} y1={y(level.price)} y2={y(level.price)} stroke={level.color} strokeWidth={level.ratio === 0.5 || level.ratio === 1.618 ? 1.2 : 0.9} strokeDasharray={dash} opacity="0.9" />
        ))}
        <polyline points={legs.map((p) => `${xAt(p.t)},${Math.max(top, Math.min(bottom, y(p.price)))}`).join(" ")} fill="none"
          stroke={study.kind === "retracement" ? "#14b8a6" : "#8b5cf6"} strokeWidth="1.4" strokeDasharray="2 3" />
        {legs.map((p, i) => inside(p.price) ? (
          <text key={p.id} x={xAt(p.t)} y={y(p.price) + (p.kind === "SH" ? -5 : 12)} textAnchor="middle" fontSize="8.5" fontWeight="800" fill={study.kind === "retracement" ? "#0f766e" : "#6d28d9"}>
            {study.kind === "retracement" ? (i === 0 ? "R1" : "R0") : String.fromCharCode(65 + i)}
          </text>
        ) : null)}
      </g>
    );
  });
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 10) labels[i].y = labels[i - 1].y + 10;
  const lx = labelX ?? xRight - 3;
  return (
    <g pointerEvents="none">
      {groups}
      {labels.map((l) => (
        <text key={l.text} x={lx} y={l.y - 2} textAnchor="end" fontSize="8.5" fontWeight="700" fill={l.color} stroke="#ffffff" strokeWidth="2.5" paintOrder="stroke">{l.text}</text>
      ))}
    </g>
  );
}

/** One-line summary of every level, including ones outside the visible range. */
export function FibLevelsLegend({ studies, digits = 2, tone = "dark" }: { studies: FibStudy[]; digits?: number; tone?: "dark" | "light" }) {
  if (!studies.length) return null;
  return (
    <div className={`mt-1 space-y-0.5 rounded px-1 py-0.5 font-mono text-[10.5px] leading-4 ${tone === "light" ? "bg-slate-900/85" : ""}`}>
      {studies.map((study) => (
        <div key={study.kind} className="flex flex-wrap gap-x-3">
          <span className="font-semibold" style={{ color: study.kind === "retracement" ? "#2dd4bf" : "#c4b5fd" }}>
            {study.kind === "retracement" ? "Retracement" : "Extension"} ({study.anchors.points.map((p) => `${p.kind} ${p.price.toFixed(digits)}`).join(" → ")})
          </span>
          {study.levels.map((l) => <span key={l.ratio} style={{ color: l.color }}>{l.label.slice(2)} {l.price.toFixed(digits)}</span>)}
        </div>
      ))}
    </div>
  );
}
