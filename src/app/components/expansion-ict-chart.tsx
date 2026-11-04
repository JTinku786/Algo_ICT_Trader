"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// ICT chart of one expansion leg (and optionally its trade), drawn in the same SVG style as the Consolidation chart:
// light background, hollow-white up / grey down candles, NY-time axis with session separators.
// Plotted from the engine's stored levels: broken swing (BOS), origin, leg extreme, equilibrium, OTE band, the leg's FVGs,
// fib extensions. The order block (last opposite candle before the displacement) is read off the same candles here.

type Candle = { key: string; open: number; high: number; low: number; close: number };
export type IctLeg = {
  sym: string; side: "bull" | "bear"; origin: number; ext: number; eq: number; ote: number; broken_level: number;
  origin_date: string; disp_date: string; ext_date: string; confirm_date: string; end_date: string; broken_swing_date: string;
  fvgs?: [string, number, number][] | null; entry_fvg?: [string, number, number] | null; origin_sweep?: boolean | null;
  htf_bias?: number | null; outcome?: string;
};
export type IctTrade = {
  side: "bull" | "bear"; model: string; target: string; trigger_date: string; entry_date: string; exit_date: string;
  entry: number; stop: number; tgt: number; outcome: string; r: number;
};

const W = 1000, H = 540, PL = 8, PR = 92, PT = 30, PB = 34;
const C = {
  bg: "#eceef2", grid: "#d9dde4", axis: "#64748b", ink: "#334155", up: "#ffffff", down: "#5b6472", wick: "#3f4754",
  prem: "rgba(220,38,38,0.07)", disc: "rgba(22,163,74,0.08)", ote: "rgba(217,119,6,0.16)", fib: "#64748b",
  bos: "#0e7490", origin: "#7c2d12", ext: "#1d4ed8", fvgBull: "rgba(37,99,235,0.18)", fvgBear: "rgba(220,38,38,0.16)",
  ob: "rgba(124,58,237,0.16)", tp: "rgba(21,128,61,0.16)", sl: "rgba(220,38,38,0.14)", entry: "#0f172a", sep: "#c3c9d3",
};
const PER_DAY: Record<string, number> = { "1d": 1, "1h": 7, "30m": 13 };
const norm = (k: string) => k.slice(0, 16).replace("T", " ").replace(/ 00:00$/, "");
const f2 = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(1) : v.toFixed(2));
function shiftDate(iso: string, days: number) {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function ExpansionIctChart({ tf, leg, trade, targetLabel }: { tf: "1d" | "1h" | "30m"; leg: IctLeg; trade?: IctTrade | null; targetLabel?: string }) {
  const lastDate = [leg.end_date, trade?.exit_date].filter(Boolean).sort().pop() as string;
  const from = shiftDate(leg.broken_swing_date < leg.origin_date ? leg.broken_swing_date : leg.origin_date, tf === "1d" ? -60 : -5);
  const to = shiftDate(lastDate, tf === "1d" ? 40 : 4);
  const reqKey = `${leg.sym}|${tf}|${from}|${to}`;
  const [res, setRes] = useState<{ key: string; candles?: Candle[]; error?: string }>({ key: "" });
  const [hover, setHover] = useState<number | null>(null);
  const [show, setShow] = useState({ fib: true, arrays: true, pd: true });
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/reversal/chart?sym=${encodeURIComponent(leg.sym)}&tf=${tf}&from=${from}&to=${to}`, { cache: "no-store", signal: ctl.signal })
      .then((r) => r.json())
      .then((j) => setRes(j.ok ? { key: reqKey, candles: j.candles } : { key: reqKey, error: j.error || "Chart load failed" }))
      .catch((e) => { if (e?.name !== "AbortError") setRes({ key: reqKey, error: String(e) }); });
    return () => ctl.abort();
  }, [reqKey, leg.sym, tf, from, to]);
  const all = res.key === reqKey ? res.candles ?? null : null;

  const view = useMemo(() => {
    if (!all?.length) return null;
    const idx = (k: string | null | undefined) => (k ? all.findIndex((c) => c.key === norm(k)) : -1);
    const bs = idx(leg.broken_swing_date), oi = idx(leg.origin_date), di = idx(leg.disp_date), ei = idx(leg.ext_date), ci = idx(leg.confirm_date);
    const endI = Math.max(idx(leg.end_date), trade ? idx(trade.exit_date) : -1, ci);
    if (oi < 0 || di < 0 || ei < 0) return null;
    const pre = tf === "1d" ? 15 : PER_DAY[tf] + 3, post = tf === "1d" ? 8 : 6;
    const a = Math.max(0, Math.min(bs < 0 ? oi : bs, oi) - pre), b = Math.min(all.length - 1, endI + post);
    const bars = all.slice(a, b + 1);
    const at = (k: string | null | undefined) => { const i = idx(k); return i < 0 ? -1 : i - a; };
    const bull = leg.side === "bull";
    // order block: last opposite-colour candle at or before the displacement, from the origin on
    let ob: { i: number; lo: number; hi: number; end: number } | null = null;
    for (let k = di - a; k >= Math.max(0, oi - a); k--) {
      const x = bars[k];
      if (bull ? x.close < x.open : x.close > x.open) {
        let e = bars.length - 1;
        for (let m = di - a + 1; m < bars.length; m++) if (bull ? bars[m].close < x.low : bars[m].close > x.high) { e = m; break; }
        ob = { i: k, lo: x.low, hi: x.high, end: e }; break;
      }
    }
    const fvgs = (leg.fvgs ?? []).map(([k, lo, hi]) => {
      const i = at(k);
      let fill = bars.length - 1;
      for (let m = i + 2; m < bars.length; m++) if (bull ? bars[m].low <= lo : bars[m].high >= hi) { fill = m; break; }
      const isEntry = !!leg.entry_fvg && leg.entry_fvg[0] === k;
      return { i, lo, hi, fill, isEntry };
    }).filter((z) => z.i >= 0);
    const L = Math.abs(leg.ext - leg.origin), sg = bull ? 1 : -1;
    const fib = [
      { p: 0, label: "0 · LEG " + (bull ? "HIGH" : "LOW") }, { p: 0.5, label: "0.5 · EQUILIBRIUM" }, { p: 0.62, label: "0.62" },
      { p: 0.705, label: "0.705 · OTE" }, { p: 0.79, label: "0.79" }, { p: 1, label: "1 · ORIGIN" },
      { p: -0.27, label: "-0.27 · TARGET" }, { p: -0.62, label: "-0.62 · TARGET" },
    ].map((f) => ({ ...f, price: leg.ext - sg * f.p * L }));
    let lo = Math.min(...bars.map((x) => x.low)), hi = Math.max(...bars.map((x) => x.high));
    for (const v of [trade?.stop, trade?.tgt, ...fib.map((f) => f.price)]) if (v != null && Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const pad = (hi - lo) * 0.04; lo -= pad; hi += pad;
    return { bars, bs: bs - a, oi: oi - a, di: di - a, ei: ei - a, ci: ci - a, endI: endI - a, at, ob, fvgs, fib, lo, hi, bull };
  }, [all, leg, trade, tf]);

  if (res.key === reqKey && res.error) return <div className="grid h-[420px] place-items-center rounded-md border border-white/10 text-sm text-[#ff8b91]">{res.error}</div>;
  if (!view) return <div className="grid h-[420px] place-items-center rounded-md border border-white/10 text-sm text-[#93a1b6]">{all ? "Leg bars not in the candle feed" : `Loading ${leg.sym} ${tf} candles…`}</div>;

  const { bars, bs, oi, di, ei, ci, endI, at, ob, fvgs, fib, lo, hi, bull } = view;
  const n = bars.length, cw = (W - PL - PR) / n;
  const X = (i: number) => PL + (i + 0.5) * cw;
  const Y = (p: number) => PT + ((hi - p) / (hi - lo)) * (H - PT - PB);
  const bw = Math.max(1, cw * 0.62), right = W - PR;
  const ticks = Array.from({ length: 7 }, (_, k) => lo + ((hi - lo) * k) / 6);
  const seps: { i: number; label: string }[] = [];
  bars.forEach((b, i) => {
    const prev = bars[i - 1];
    if (tf === "1d") { if (!prev || prev.key.slice(5, 7) !== b.key.slice(5, 7)) seps.push({ i, label: new Date(`${b.key}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }) }); }
    else if (!prev || prev.key.slice(0, 10) !== b.key.slice(0, 10)) seps.push({ i, label: new Date(`${b.key.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric", timeZone: "UTC" }) });
  });
  const label = (x: number, y: number, text: string, color: string, anchor: "start" | "end" | "middle" = "start", dy = 0) => (
    <text x={x} y={y + dy} fontSize={10} fontWeight={600} fill={color} textAnchor={anchor} style={{ paintOrder: "stroke", stroke: C.bg, strokeWidth: 3 }}>{text}</text>
  );
  const xFib = X(ei) - cw / 2, xEnd = X(Math.min(n - 1, Math.max(endI, ci))) + cw / 2;
  const eqY = Y(leg.eq), extY = Y(leg.ext), oriY = Y(leg.origin);
  const bias = leg.htf_bias === 1 ? "BULLISH" : leg.htf_bias === -1 ? "BEARISH" : "NEUTRAL";
  const te = trade ? at(trade.entry_date) : -1, tx = trade ? at(trade.exit_date) : -1, tt = trade ? at(trade.trigger_date) : -1;
  const hb = hover != null ? bars[hover] : null;
  const fibP = (p: number) => fib.find((f) => f.p === p)!.price;

  return (
    <div className="rounded-md border border-white/10 bg-[#0b0f16] p-2">
      <div className="mb-2 flex flex-wrap items-center gap-2 px-1 text-[11px]">
        {([["pd", "Premium / discount"], ["fib", "Fib (OTE + extensions)"], ["arrays", "FVG / OB"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setShow((v) => ({ ...v, [k]: !v[k] }))} className={`rounded border px-2 py-0.5 ${show[k] ? "border-[#d9a441]/60 text-[#f2c873]" : "border-white/15 text-[#7f8ca3]"}`}>{l}</button>
        ))}
        <span className="ml-auto font-mono text-[#93a1b6]">{tf === "1d" ? "Daily" : tf} · NY time · HTF order flow {bias}</span>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full select-none rounded" style={{ background: C.bg }}
        onMouseMove={(e) => { const r = svgRef.current!.getBoundingClientRect(); const x = ((e.clientX - r.left) / r.width) * W; const i = Math.floor((x - PL) / cw); setHover(i >= 0 && i < n ? i : null); }}
        onMouseLeave={() => setHover(null)}>
        {ticks.map((p, k) => <g key={k}><line x1={PL} x2={right} y1={Y(p)} y2={Y(p)} stroke={C.grid} strokeWidth={0.6} /><text x={right + 6} y={Y(p) + 3} fontSize={10} fill={C.axis}>{f2(p)}</text></g>)}
        {seps.map((q) => <g key={q.i}><line x1={X(q.i) - cw / 2} x2={X(q.i) - cw / 2} y1={PT} y2={H - PB} stroke={C.sep} strokeDasharray="3 3" strokeWidth={0.8} /><text x={X(q.i) - cw / 2 + 3} y={H - PB + 14} fontSize={10} fill={C.axis}>{q.label}</text></g>)}
        {tf !== "1d" ? bars.map((b, i) => b.key.endsWith("09:30") ? <text key={`o${i}`} x={X(i)} y={H - PB + 26} fontSize={9} fill={C.axis} textAnchor="middle">09:30</text> : null) : null}

        {/* the expansion leg as a dealing range: premium / discount of origin -> extreme, from the extreme onward */}
        {show.pd ? <>
          <rect x={xFib} y={Math.min(extY, eqY)} width={xEnd - xFib} height={Math.abs(eqY - extY)} fill={bull ? C.prem : C.disc} />
          <rect x={xFib} y={Math.min(eqY, oriY)} width={xEnd - xFib} height={Math.abs(oriY - eqY)} fill={bull ? C.disc : C.prem} />
          {label(xFib + 3, (extY + eqY) / 2 + 3, bull ? "PREMIUM" : "DISCOUNT", bull ? "#b91c1c" : "#15803d")}
          {label(xFib + 3, (eqY + oriY) / 2 + 3, bull ? "DISCOUNT · buy zone" : "PREMIUM · sell zone", bull ? "#15803d" : "#b91c1c")}
        </> : null}
        {show.fib ? <>
          <rect x={xFib} y={Math.min(Y(fibP(0.62)), Y(fibP(0.79)))} width={xEnd - xFib} height={Math.abs(Y(fibP(0.79)) - Y(fibP(0.62)))} fill={C.ote} />
          {fib.map((f) => <g key={f.p}>
            <line x1={xFib} x2={right} y1={Y(f.price)} y2={Y(f.price)} stroke={f.p === 1 ? C.origin : f.p === 0 ? C.ext : C.fib}
              strokeWidth={f.p === 0 || f.p === 1 || f.p === 0.5 ? 1.2 : 0.8} strokeDasharray={f.p < 0 ? "6 4" : f.p === 0 || f.p === 1 ? undefined : "3 3"} />
            {label(right + 3, Y(f.price), f.label.split(" · ")[0], f.p === 1 ? C.origin : f.p === 0 ? C.ext : C.fib, "start", 3)}
            {f.label.includes("·") ? label(right - 4, Y(f.price) - 3, f.label.split(" · ")[1], f.p === 1 ? C.origin : f.p === 0 ? C.ext : C.fib, "end") : null}
          </g>)}
        </> : null}

        {/* structure: the swing the displacement closed through (BOS) */}
        {bs >= 0 ? <><line x1={X(bs)} x2={X(di)} y1={Y(leg.broken_level)} y2={Y(leg.broken_level)} stroke={C.bos} strokeWidth={1.3} />
          {label((X(bs) + X(di)) / 2, Y(leg.broken_level) + (bull ? -4 : 12), "BOS", C.bos, "middle")}</> : null}

        {show.arrays ? <>
          {fvgs.map((z, k) => <g key={`f${k}`}>
            <rect x={X(z.i) - cw / 2} y={Y(z.hi)} width={X(z.fill) - X(z.i) + cw / 2} height={Math.max(1, Y(z.lo) - Y(z.hi))} fill={bull ? C.fvgBull : C.fvgBear} stroke={z.isEntry ? (bull ? "#1d4ed8" : "#b91c1c") : "none"} strokeWidth={z.isEntry ? 1 : 0} />
            <line x1={X(z.i) - cw / 2} x2={X(z.fill)} y1={Y((z.hi + z.lo) / 2)} y2={Y((z.hi + z.lo) / 2)} stroke={bull ? "#1d4ed8" : "#b91c1c"} strokeDasharray="2 3" strokeWidth={0.7} />
            {label(X(z.i) + cw / 2 + 2, Y(bull ? z.lo : z.hi) + (bull ? -2 : 10), `${bull ? "+" : "-"}FVG${z.isEntry ? " · entry (CE)" : ""}`, bull ? "#1d4ed8" : "#b91c1c")}
          </g>)}
          {ob ? <g><rect x={X(ob.i) - cw / 2} y={Y(ob.hi)} width={X(ob.end) - X(ob.i) + cw / 2} height={Math.max(1, Y(ob.lo) - Y(ob.hi))} fill={C.ob} stroke="#7c3aed" strokeWidth={0.6} />
            {label(X(ob.i) - cw / 2 - 2, Y(bull ? ob.lo : ob.hi) + (bull ? 10 : -3), bull ? "+OB" : "-OB", "#6d28d9", "end")}</g> : null}
        </> : null}

        {trade && te >= 0 ? (() => {
          const x1 = X(te) - cw / 2, x2 = X(tx >= 0 ? tx : n - 1) + cw / 2;
          return <g>
            <rect x={x1} y={Math.min(Y(trade.entry), Y(trade.tgt))} width={x2 - x1} height={Math.abs(Y(trade.tgt) - Y(trade.entry))} fill={C.tp} />
            <rect x={x1} y={Math.min(Y(trade.entry), Y(trade.stop))} width={x2 - x1} height={Math.abs(Y(trade.stop) - Y(trade.entry))} fill={C.sl} />
            <line x1={x1} x2={x2} y1={Y(trade.entry)} y2={Y(trade.entry)} stroke={C.entry} strokeWidth={1.2} />
            {label(x2 + 3, Y(trade.entry), `ENTRY ${f2(trade.entry)}`, C.entry, "start", 3)}
            {label(x2 + 3, Y(trade.stop), `SL ${f2(trade.stop)}`, "#b91c1c", "start", 3)}
            {label(x2 + 3, Y(trade.tgt), `TP ${targetLabel ?? trade.target} ${f2(trade.tgt)}`, "#15803d", "start", 3)}
          </g>;
        })() : null}

        {bars.map((b, i) => {
          const up = b.close >= b.open, x = X(i);
          return <g key={b.key}>
            <line x1={x} x2={x} y1={Y(b.high)} y2={Y(b.low)} stroke={C.wick} strokeWidth={1} />
            <rect x={x - bw / 2} y={Y(Math.max(b.open, b.close))} width={bw} height={Math.max(1, Math.abs(Y(b.open) - Y(b.close)))} fill={up ? C.up : C.down} stroke={i === di ? C.bos : C.wick} strokeWidth={i === di ? 1.8 : 0.8} />
          </g>;
        })}

        {label(X(di), bull ? Y(bars[di].low) + 14 : Y(bars[di].high) - 6, "DISPLACEMENT", C.bos, "middle")}
        {label(X(oi), bull ? oriY + 14 : oriY - 6, leg.origin_sweep ? "ORIGIN · swept liquidity" : "ORIGIN", C.origin, "middle")}
        {label(X(ei), bull ? extY - 6 : extY + 14, bull ? "SWING HIGH · BSL" : "SWING LOW · SSL", C.ext, "middle")}
        {ci >= 0 ? label(X(ci), H - PB - 6, "▲ leg confirmed", C.axis, "middle") : null}
        {trade && tt >= 0 && trade.model === "SWEEP_MSS" ? label(X(tt), bull ? Y(bars[tt].low) + 14 : Y(bars[tt].high) - 6, bull ? "SSL SWEEP + REJECTION" : "BSL SWEEP + REJECTION", "#dc2626", "middle") : null}
        {trade && te >= 0 ? label(X(te), bull ? Y(bars[te].low) + 26 : Y(bars[te].high) - 18, bull ? "BUY" : "SELL", C.entry, "middle") : null}
        {trade && tx >= 0 ? (() => {
          const py = trade.outcome === "win" ? trade.tgt : trade.outcome === "loss" ? trade.stop : bars[tx].close;
          const col = trade.outcome === "win" ? "#15803d" : trade.outcome === "loss" ? "#dc2626" : "#64748b";
          return <g><circle cx={X(tx)} cy={Y(py)} r={4} fill={col} />{label(X(tx) + 6, Y(py) - 6, `EXIT ${trade.outcome.toUpperCase()} ${trade.r > 0 ? "+" : ""}${trade.r.toFixed(2)}R`, col)}</g>;
        })() : null}

        {hover != null ? <line x1={X(hover)} x2={X(hover)} y1={PT} y2={H - PB} stroke="#94a3b8" strokeWidth={0.6} /> : null}
        <rect x={PL} y={PT} width={right - PL} height={H - PT - PB} fill="none" stroke={C.grid} />
        <text x={PL + 4} y={16} fontSize={11} fill={C.ink} fontWeight={600}>
          {hb ? `${hb.key}  O ${f2(hb.open)}  H ${f2(hb.high)}  L ${f2(hb.low)}  C ${f2(hb.close)}` : `${leg.sym} · ${bull ? "bullish" : "bearish"} expansion ${f2(leg.origin)} → ${f2(leg.ext)} · EQ ${f2(leg.eq)} · OTE ${f2(leg.ote)}`}
        </text>
      </svg>
    </div>
  );
}
