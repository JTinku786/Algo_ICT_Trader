"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// ICT-style chart of one consolidation box (and optionally its trade), drawn in SVG like the Backtest / Reversal
// HTF ICT charts: light background, hollow-white up / grey down candles, NY-time axis with session separators.
// Everything drawn comes from the engine's stored levels (box edges, CE, EQH/EQL swings, sweep, break) except the
// FVG / order block of the displacement leg, which are read off the same candles here.

type Candle = { key: string; open: number; high: number; low: number; close: number };
export type IctBox = {
  sym: string; box_hi: number; box_lo: number; ce: number; start_date: string; confirm_date: string; end_date: string;
  eqh?: [string, number][] | null; eql?: [string, number][] | null; htf_bias?: number | null;
  sweep_side?: "up" | "dn" | null; sweep_kind?: "wick" | "2B" | null; sweep_date?: string | null; sweep_extreme?: number | null;
  break_dir?: "up" | "dn" | null; break_date?: string | null; fate?: string;
};
export type IctTrade = {
  side: "bull" | "bear"; model: string; target: string; entry_date: string; exit_date: string; entry: number; stop: number; tgt: number;
  outcome: string; r: number;
};

const W = 1000, H = 520, PL = 8, PR = 74, PT = 30, PB = 34;
const C = {
  bg: "#eceef2", grid: "#d9dde4", axis: "#64748b", ink: "#334155", up: "#ffffff", down: "#5b6472", wick: "#3f4754",
  box: "#475569", prem: "rgba(220,38,38,0.07)", disc: "rgba(22,163,74,0.08)", ce: "#64748b",
  bsl: "#1d4ed8", ssl: "#b45309", raid: "#dc2626", disp: "#0e7490", fvgBull: "rgba(37,99,235,0.18)", fvgBear: "rgba(220,38,38,0.16)",
  ob: "rgba(124,58,237,0.16)", tp: "rgba(21,128,61,0.16)", sl: "rgba(220,38,38,0.14)", entry: "#0f172a", sep: "#c3c9d3",
};
const TF_BARS_PER_DAY: Record<string, number> = { "1d": 1, "1h": 7, "30m": 13 };

function shiftDate(iso: string, days: number) {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const norm = (k: string) => k.slice(0, 16).replace("T", " ").replace(/ 00:00$/, "");
const f2 = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(1) : v.toFixed(2));

export default function ConsolidationIctChart({ tf, box, trade, targetLabel }: { tf: "1d" | "1h" | "30m"; box: IctBox; trade?: IctTrade | null; targetLabel?: string }) {
  const end = trade?.exit_date && trade.exit_date > box.end_date ? trade.exit_date : box.end_date;
  const padDays = tf === "1d" ? 70 : 6;
  const from = shiftDate(box.start_date, -padDays), to = shiftDate(end, tf === "1d" ? 45 : 5);
  const reqKey = `${box.sym}|${tf}|${from}|${to}`;
  const [res, setRes] = useState<{ key: string; candles?: Candle[]; error?: string }>({ key: "" });
  const [hover, setHover] = useState<number | null>(null);
  const [show, setShow] = useState({ pd: true, arrays: true, liq: true });
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/consolidation/chart?sym=${encodeURIComponent(box.sym)}&tf=${tf}&from=${from}&to=${to}`, { cache: "no-store", signal: ctl.signal })
      .then((r) => r.json())
      .then((j) => setRes(j.ok ? { key: reqKey, candles: j.candles } : { key: reqKey, error: j.error || "Chart load failed" }))
      .catch((e) => { if (e?.name !== "AbortError") setRes({ key: reqKey, error: String(e) }); });
    return () => ctl.abort();
  }, [reqKey, box.sym, tf, from, to]);
  const all = res.key === reqKey ? res.candles ?? null : null;
  const error = res.key === reqKey ? res.error : undefined;

  const view = useMemo(() => {
    if (!all?.length) return null;
    const idx = (k: string | null | undefined) => (k ? all.findIndex((c) => c.key === norm(k)) : -1);
    const s0 = idx(box.start_date), c0 = idx(box.confirm_date), e0 = Math.max(idx(end), idx(box.end_date));
    if (s0 < 0 || c0 < 0) return null;
    const pre = tf === "1d" ? 20 : TF_BARS_PER_DAY[tf] + 4, post = tf === "1d" ? 8 : 6;
    const a = Math.max(0, s0 - pre), b = Math.min(all.length - 1, Math.max(e0, c0) + post);
    const bars = all.slice(a, b + 1);
    const at = (k: string | null | undefined) => { const i = idx(k); return i < 0 ? -1 : i - a; };
    const s = s0 - a, c = c0 - a, sw = at(box.sweep_date), br = at(box.break_date);
    const te = trade ? at(trade.entry_date) : -1, tx = trade ? at(trade.exit_date) : -1;
    // displacement arrays: FVGs in the break direction from the break bar on (and in the fade direction after a sweep),
    // order block = last opposite-colour candle before the displacement
    type Zone = { i: number; lo: number; hi: number; bull: boolean; end: number; label: string };
    const fvgs: Zone[] = [];
    const scanFvg = (from: number, to: number, bull: boolean, label: string) => {
      for (let k = Math.max(2, from); k <= Math.min(bars.length - 1, to); k++) {
        const x = bars[k - 2], z = bars[k];
        const g = bull ? (x.high < z.low ? { lo: x.high, hi: z.low } : null) : (x.low > z.high ? { lo: z.high, hi: x.low } : null);
        if (!g) continue;
        let fill = bars.length - 1;
        for (let m = k + 1; m < bars.length; m++) if (bull ? bars[m].low <= g.lo : bars[m].high >= g.hi) { fill = m; break; }
        fvgs.push({ i: k - 1, ...g, bull, end: fill, label });
      }
    };
    const obs: Zone[] = [];
    if (br >= 0 && box.break_dir) {
      const up = box.break_dir === "up";
      scanFvg(br, br + 4, up, "FVG");
      for (let k = br; k >= Math.max(s, br - 8); k--) {
        const bk = bars[k];
        if (up ? bk.close < bk.open : bk.close > bk.open) {
          let e = bars.length - 1;
          for (let m = br + 1; m < bars.length; m++) if (up ? bars[m].close < bk.low : bars[m].close > bk.high) { e = m; break; }
          obs.push({ i: k, lo: bk.low, hi: bk.high, bull: up, end: e, label: up ? "+OB" : "-OB" }); break;
        }
      }
    }
    if (sw >= 0 && box.sweep_side) scanFvg(sw, sw + 5, box.sweep_side === "dn", "FVG");
    let lo = Math.min(...bars.map((x) => x.low)), hi = Math.max(...bars.map((x) => x.high));
    for (const v of [trade?.stop, trade?.tgt]) if (v != null && Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const padP = (hi - lo) * 0.06; lo -= padP; hi += padP;
    // a resting pool ends at the first bar that trades through it (the raid or the break)
    const taken = (up: boolean) => { for (let k = c + 1; k < bars.length; k++) if (up ? bars[k].high > box.box_hi : bars[k].low < box.box_lo) return k; return bars.length - 1; };
    return { bars, s, c, sw, br, te, tx, endI: Math.max(at(box.end_date), c), fvgs, obs, lo, hi, at, takenHi: taken(true), takenLo: taken(false) };
  }, [all, box, trade, end, tf]);

  if (error) return <div className="grid h-[420px] place-items-center rounded-md border border-white/10 text-sm text-[#ff8b91]">{error}</div>;
  if (!view) return <div className="grid h-[420px] place-items-center rounded-md border border-white/10 text-sm text-[#93a1b6]">{all ? "Box bars not in the candle feed" : `Loading ${box.sym} ${tf} candles…`}</div>;

  const { bars, s, c, sw, br, te, tx, endI, fvgs, obs, lo, hi, takenHi, takenLo } = view;
  const exitPrice = trade ? trade.entry + (trade.side === "bull" ? 1 : -1) * trade.r * Math.abs(trade.entry - trade.stop) : null;
  const n = bars.length, cw = (W - PL - PR) / n;
  const X = (i: number) => PL + (i + 0.5) * cw;
  const Y = (p: number) => PT + ((hi - p) / (hi - lo)) * (H - PT - PB);
  const bw = Math.max(1, cw * 0.62);
  const right = W - PR;
  const ticks = Array.from({ length: 7 }, (_, k) => lo + ((hi - lo) * k) / 6);
  // NY session separators (intraday) / month separators (daily)
  const seps: { i: number; label: string }[] = [];
  bars.forEach((b, i) => {
    const prev = bars[i - 1];
    if (tf === "1d") { if (!prev || prev.key.slice(5, 7) !== b.key.slice(5, 7)) seps.push({ i, label: new Date(`${b.key}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }) }); }
    else if (!prev || prev.key.slice(0, 10) !== b.key.slice(0, 10)) seps.push({ i, label: new Date(`${b.key.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric", timeZone: "UTC" }) });
  });
  const bEnd = Math.max(endI, c);
  const xs = X(s) - cw / 2, xc = X(c) + cw / 2, xe = X(Math.min(bEnd, n - 1)) + cw / 2;
  const bias = box.htf_bias === 1 ? "BULLISH" : box.htf_bias === -1 ? "BEARISH" : "NEUTRAL";
  const eqh = (box.eqh ?? []).map(([k, p]) => ({ i: view.at(k), p })).filter((q) => q.i >= 0);
  const eql = (box.eql ?? []).map(([k, p]) => ({ i: view.at(k), p })).filter((q) => q.i >= 0);
  const hb = hover != null ? bars[hover] : null;
  const label = (x: number, y: number, text: string, color: string, anchor: "start" | "end" | "middle" = "start", dy = 0) => (
    <text x={x} y={y + dy} fontSize={10} fontWeight={600} fill={color} textAnchor={anchor} style={{ paintOrder: "stroke", stroke: C.bg, strokeWidth: 3 }}>{text}</text>
  );

  return (
    <div className="rounded-md border border-white/10 bg-[#0b0f16] p-2">
      <div className="mb-2 flex flex-wrap items-center gap-2 px-1 text-[11px]">
        {([["pd", "Premium / discount"], ["liq", "EQH / EQL liquidity"], ["arrays", "FVG / OB"]] as const).map(([k, l]) => (
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

        {/* dealing range: box while it forms (solid) and while it is active (dashed), premium above CE, discount below */}
        {show.pd ? <>
          <rect x={xs} y={Y(box.box_hi)} width={xe - xs} height={Y(box.ce) - Y(box.box_hi)} fill={C.prem} />
          <rect x={xs} y={Y(box.ce)} width={xe - xs} height={Y(box.box_lo) - Y(box.ce)} fill={C.disc} />
        </> : null}
        <rect x={xs} y={Y(box.box_hi)} width={xc - xs} height={Y(box.box_lo) - Y(box.box_hi)} fill="none" stroke={C.box} strokeWidth={1.4} />
        {xe > xc ? <rect x={xc} y={Y(box.box_hi)} width={xe - xc} height={Y(box.box_lo) - Y(box.box_hi)} fill="none" stroke={C.box} strokeWidth={1} strokeDasharray="5 4" /> : null}
        <line x1={xs} x2={xe} y1={Y(box.ce)} y2={Y(box.ce)} stroke={C.ce} strokeDasharray="6 4" strokeWidth={1} />
        {label(xe + 3, Y(box.ce), "CE 50%", C.ce, "start", 3)}
        {show.pd ? <>{label(xc - 3, Y(box.box_hi) + 11, "PREMIUM", "#b91c1c", "end")}{label(xc - 3, Y(box.box_lo) - 4, "DISCOUNT", "#15803d", "end")}</> : null}
        {label(xs, Y(box.box_hi) - 5, `CONSOLIDATION · ${c - s + 1} bars`, C.box)}

        {/* liquidity: relative equal highs = buy stops, relative equal lows = sell stops, resting until taken */}
        {show.liq ? <>
          {eqh.length ? <><line x1={X(eqh[0].i)} x2={X(takenHi)} y1={Y(box.box_hi)} y2={Y(box.box_hi)} stroke={C.bsl} strokeWidth={1.2} />
            {eqh.map((q, k) => <circle key={k} cx={X(q.i)} cy={Y(q.p) - 4} r={2.6} fill={C.bsl} />)}
            {label(X(takenHi) - 4, Y(box.box_hi) - 4, "EQH · BSL $$$", C.bsl, "end")}</> : null}
          {eql.length ? <><line x1={X(eql[0].i)} x2={X(takenLo)} y1={Y(box.box_lo)} y2={Y(box.box_lo)} stroke={C.ssl} strokeWidth={1.2} />
            {eql.map((q, k) => <circle key={k} cx={X(q.i)} cy={Y(q.p) + 4} r={2.6} fill={C.ssl} />)}
            {label(X(takenLo) - 4, Y(box.box_lo) + 12, "EQL · SSL $$$", C.ssl, "end")}</> : null}
        </> : null}

        {show.arrays ? <>
          {fvgs.map((z, k) => <g key={`f${k}`}><rect x={X(z.i) - cw / 2} y={Y(z.hi)} width={X(z.end) - X(z.i) + cw / 2} height={Math.max(1, Y(z.lo) - Y(z.hi))} fill={z.bull ? C.fvgBull : C.fvgBear} />
            {label(X(z.i) - cw / 2 + 2, Y(z.hi) + 10, `${z.bull ? "+" : "-"}FVG`, z.bull ? "#1d4ed8" : "#b91c1c")}
            <line x1={X(z.i) - cw / 2} x2={X(z.end)} y1={Y((z.hi + z.lo) / 2)} y2={Y((z.hi + z.lo) / 2)} stroke={z.bull ? "#1d4ed8" : "#b91c1c"} strokeDasharray="2 3" strokeWidth={0.7} /></g>)}
          {obs.map((z, k) => <g key={`o${k}`}><rect x={X(z.i) - cw / 2} y={Y(z.hi)} width={X(z.end) - X(z.i) + cw / 2} height={Math.max(1, Y(z.lo) - Y(z.hi))} fill={C.ob} stroke="#7c3aed" strokeWidth={0.6} />
            {label(X(z.i) - cw / 2 + 2, Y(z.lo) - 3, z.label, "#6d28d9")}</g>)}
        </> : null}

        {/* trade: position tool from the fill to the exit */}
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
            <rect x={x - bw / 2} y={Y(Math.max(b.open, b.close))} width={bw} height={Math.max(1, Math.abs(Y(b.open) - Y(b.close)))} fill={up ? C.up : C.down} stroke={C.wick} strokeWidth={0.8} />
          </g>;
        })}

        {/* events */}
        {sw >= 0 && box.sweep_side ? (() => {
          const up = box.sweep_side === "up", b = bars[sw];
          return <g>
            <line x1={X(sw)} x2={X(sw)} y1={Y(up ? b.high : b.low)} y2={Y(up ? box.box_hi : box.box_lo)} stroke={C.raid} strokeWidth={2.4} />
            {label(X(sw) - cw / 2 - 3, Y(up ? b.high : b.low) + (up ? 0 : 8), `${up ? "BSL" : "SSL"} RAID${box.sweep_kind === "2B" ? " (2B)" : ""}`, C.raid, "end")}
          </g>;
        })() : null}
        {br >= 0 && box.break_dir ? label(X(br), box.break_dir === "up" ? Y(bars[br].high) - 8 : Y(bars[br].low) + 16, `DISPLACEMENT ${box.break_dir === "up" ? "▲" : "▼"} RANGE BREAK`, C.disp, "middle") : null}
        {label(X(c), H - PB - 6, "▲ box confirmed", C.box, "middle")}
        {trade && te >= 0 ? label(X(te), trade.side === "bull" ? Y(bars[te].low) + 28 : Y(bars[te].high) - 20, trade.side === "bull" ? "BUY" : "SELL", C.entry, "middle") : null}
        {trade && tx >= 0 && exitPrice != null ? <g><circle cx={X(tx)} cy={Y(exitPrice)} r={4} fill={trade.outcome === "win" ? "#15803d" : trade.outcome === "loss" ? "#dc2626" : "#64748b"} />
          {label(X(tx) + 6, Y(exitPrice) - 6, `${trade.outcome === "open" ? "MARK" : "EXIT"} ${trade.outcome.toUpperCase()} ${trade.r > 0 ? "+" : ""}${trade.r.toFixed(2)}R`, trade.outcome === "win" ? "#15803d" : "#b91c1c")}</g> : null}

        {hover != null ? <line x1={X(hover)} x2={X(hover)} y1={PT} y2={H - PB} stroke="#94a3b8" strokeWidth={0.6} /> : null}
        <rect x={PL} y={PT} width={right - PL} height={H - PT - PB} fill="none" stroke={C.grid} />
        <text x={PL + 4} y={16} fontSize={11} fill={C.ink} fontWeight={600}>
          {hb ? `${hb.key}  O ${f2(hb.open)}  H ${f2(hb.high)}  L ${f2(hb.low)}  C ${f2(hb.close)}` : `${box.sym} · range ${f2(box.box_lo)} – ${f2(box.box_hi)} · CE ${f2(box.ce)}`}
        </text>
      </svg>
    </div>
  );
}
