"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// ICT Power of Three chart, same SVG house style as the Consolidation / Expansion charts
// (light background, hollow-white up / grey down candles, NY-time axis, session separators).
// Everything is drawn from the levels the engine stored; nothing is re-detected here.
//  Structural: Accumulation box (EQH = BSL, EQL = SSL, CE) -> Manipulation (raid beyond an edge that returns) ->
//              MSS through the internal swing + displacement FVG -> Distribution toward the opposite pool.
//  Session:    equity RTH open (09:30), not the ICT midnight open; prior-day liquidity and completed-candle deadlines.

type Candle = { key: string; open: number; high: number; low: number; close: number };
type Pt = [string, number];
export type AmdCycle = {
  family: "structural" | "session"; sym: string; outcome: string; htf_bias?: number | null;
  acc_start: string; acc_confirm: string; acc_hi: number | null; acc_lo: number | null; ce: number | null; atr: number | null;
  eqh?: Pt[] | string | null; eql?: Pt[] | string | null; end_date: string; breakout_dir?: string | null;
  manip_side?: "up" | "dn" | null; manip_kind?: string | null; pierce_date?: string | null; return_date?: string | null;
  sweep_extreme?: number | null; mss_date?: string | null; mss_level?: number | null; mss_swing_date?: string | null;
  fvg?: [string, number, number] | string | null; true_open?: number | null; pdh?: number | null; pdl?: number | null; day?: string | null;
};
export type AmdTrade = {
  side: "bull" | "bear"; model: string; target: string; decision_date: string; entry_date: string; exit_date: string;
  decision_known_at?: string; mss_known_at?: string | null; fvg_known_at?: string | null; order_active_at?: string; entry_not_before?: string;
  fvg_evidence?: AmdCycle["fvg"];
  entry: number; stop: number; tgt: number | null; outcome: string; r: number; pools?: number[] | string | null;
};

const W = 1000, H = 560, PL = 8, PR = 64, PT = 40, PB = 34;
const C = {
  bg: "#eceef2", grid: "#d9dde4", axis: "#64748b", ink: "#334155", up: "#ffffff", down: "#5b6472", wick: "#3f4754", sep: "#c3c9d3",
  acc: "rgba(37,99,235,0.10)", accLine: "#1d4ed8", manip: "rgba(217,119,6,0.18)", manipLine: "#b45309", dist: "rgba(13,148,136,0.10)",
  distLine: "#0f766e", mss: "#7c3aed", fvgBull: "rgba(37,99,235,0.20)", fvgBear: "rgba(220,38,38,0.18)", bsl: "#b91c1c", ssl: "#15803d",
  tp: "rgba(21,128,61,0.16)", sl: "rgba(220,38,38,0.14)", entry: "#0f172a", open: "#0f172a", window: "rgba(217,119,6,0.09)", trig: "rgba(100,116,139,0.08)",
};
const norm = (k: string) => k.slice(0, 16).replace("T", " ").replace(/ 00:00$/, "");
const f2 = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(1) : v.toFixed(2));
const parse = <T,>(v: T | string | null | undefined): T | null => (v == null ? null : typeof v === "string" ? (JSON.parse(v) as T) : v);
function shiftDate(iso: string, days: number) {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function AmdIctChart({ tf, cycle, trade, targetLabel }: { tf: "1d" | "1h" | "30m"; cycle: AmdCycle; trade?: AmdTrade | null; targetLabel?: string }) {
  const session = cycle.family === "session";
  const first = session ? (cycle.day ?? cycle.acc_start) : cycle.acc_start;
  const last = [cycle.end_date, trade?.exit_date].filter(Boolean).sort().pop() as string;
  const from = shiftDate(first, session ? -3 : tf === "1d" ? -45 : -3);
  const to = shiftDate(last, session ? 1 : tf === "1d" ? 25 : 2);
  const reqKey = `${cycle.sym}|${tf}|${from}|${to}`;
  const [res, setRes] = useState<{ key: string; candles?: Candle[]; error?: string }>({ key: "" });
  const [hover, setHover] = useState<number | null>(null);
  const [show, setShow] = useState({ phases: true, liq: true, arrays: true });
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/amd/chart?sym=${encodeURIComponent(cycle.sym)}&tf=${tf}&from=${from}&to=${to}`, { cache: "no-store", signal: ctl.signal })
      .then((r) => r.json())
      .then((j) => setRes(j.ok ? { key: reqKey, candles: j.candles } : { key: reqKey, error: j.error || "Chart load failed" }))
      .catch((e) => { if (e?.name !== "AbortError") setRes({ key: reqKey, error: String(e) }); });
    return () => ctl.abort();
  }, [reqKey, cycle.sym, tf, from, to]);
  const all = res.key === reqKey ? res.candles ?? null : null;

  const view = useMemo(() => {
    if (!all?.length) return null;
    const idx = (k: string | null | undefined) => (k ? all.findIndex((c) => c.key === norm(k)) : -1);
    let a: number, b: number;
    if (session) {
      const dk = (cycle.day ?? cycle.acc_start).slice(0, 10);
      const dayIdx = all.map((c, i) => (c.key.slice(0, 10) === dk ? i : -1)).filter((i) => i >= 0);
      if (!dayIdx.length) return null;
      const d0 = dayIdx[0];
      const prevDay = all[d0 - 1]?.key.slice(0, 10);
      a = prevDay ? all.findIndex((c) => c.key.slice(0, 10) === prevDay) : d0;   // show the prior session (PDH / PDL)
      b = Math.min(all.length - 1, dayIdx[dayIdx.length - 1] + 2);
    } else {
      const s = idx(cycle.acc_start);
      if (s < 0) return null;
      const endI = Math.max(idx(cycle.end_date), trade ? idx(trade.exit_date) : -1);
      const pre = tf === "1d" ? 15 : 10, post = tf === "1d" ? 8 : 6;
      a = Math.max(0, s - pre); b = Math.min(all.length - 1, (endI < 0 ? s + 40 : endI) + post);
    }
    const bars = all.slice(a, b + 1);
    const at = (k: string | null | undefined) => { const i = idx(k); return i < a || i > b ? -1 : i - a; };
    const eqh = parse<Pt[]>(cycle.eqh) ?? [], eql = parse<Pt[]>(cycle.eql) ?? [];
    const fvg = parse<[string, number, number]>(cycle.fvg);
    const pools = parse<number[]>(trade?.pools) ?? [];
    const levels: number[] = [];
    for (const v of [cycle.acc_hi, cycle.acc_lo, cycle.sweep_extreme, cycle.true_open, cycle.pdh, cycle.pdl, trade?.stop, trade?.entry, trade?.tgt, ...pools.slice(0, 2)])
      if (v != null && Number.isFinite(v)) levels.push(v);
    let lo = Math.min(...bars.map((x) => x.low), ...levels), hi = Math.max(...bars.map((x) => x.high), ...levels);
    const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
    return { bars, at, eqh, eql, fvg, pools, lo, hi };
  }, [all, cycle, trade, tf, session]);

  if (res.key === reqKey && res.error) return <div className="grid h-[420px] place-items-center rounded-md border border-white/10 text-sm text-[#ff8b91]">{res.error}</div>;
  if (!view) return <div className="grid h-[420px] place-items-center rounded-md border border-white/10 text-sm text-[#93a1b6]">{all ? "Cycle bars not in the candle feed" : `Loading ${cycle.sym} ${tf} candles…`}</div>;

  const { bars, at, eqh, eql, fvg, pools, lo, hi } = view;
  const n = bars.length, cw = (W - PL - PR) / n, right = W - PR;
  const X = (i: number) => PL + (i + 0.5) * cw;
  const Y = (p: number) => PT + ((hi - p) / (hi - lo)) * (H - PT - PB);
  const bw = Math.max(1, cw * 0.62);
  const xl = (i: number) => X(i) - cw / 2, xr = (i: number) => X(i) + cw / 2;
  const ticks = Array.from({ length: 7 }, (_, k) => lo + ((hi - lo) * k) / 6);
  const seps: { i: number; label: string }[] = [];
  bars.forEach((b, i) => {
    const prev = bars[i - 1];
    if (tf === "1d") { if (!prev || prev.key.slice(5, 7) !== b.key.slice(5, 7)) seps.push({ i, label: new Date(`${b.key}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }) }); }
    else if (!prev || prev.key.slice(0, 10) !== b.key.slice(0, 10)) seps.push({ i, label: new Date(`${b.key.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric", timeZone: "UTC" }) });
  });
  const label = (x: number, y: number, text: string, color: string, anchor: "start" | "end" | "middle" = "start", dy = 0, size = 10) => (
    <text x={x} y={y + dy} fontSize={size} fontWeight={600} fill={color} textAnchor={anchor} style={{ paintOrder: "stroke", stroke: C.bg, strokeWidth: 3 }}>{text}</text>
  );
  const rayLabel = (p: number, text: string, color: string) => label(right - 4, Y(p), text, color, "end", -3, 9);   // inside the plot, above its line

  const bull = (cycle.manip_side ?? (trade?.side === "bull" ? "dn" : "up")) === "dn";
  const iS = at(cycle.acc_start), iC = at(cycle.acc_confirm), iP = at(cycle.pierce_date), iR = at(cycle.return_date);
  const iM = at(cycle.mss_date), iMs = at(cycle.mss_swing_date), iE = Math.max(at(cycle.end_date), 0);
  const te = trade ? at(trade.entry_date) : -1, tx = trade ? at(trade.exit_date) : -1, td = trade ? at(trade.decision_date) : -1;
  const hb = hover != null ? bars[hover] : null;
  const biasTxt = cycle.htf_bias === 1 ? "BULLISH" : cycle.htf_bias === -1 ? "BEARISH" : "NEUTRAL";

  // phase ribbon (A / M / D) along the top
  const ribbon: { a: number; b: number; t: string; fill: string; col: string }[] = [];
  if (!session && iS >= 0) {
    const accEnd = iP >= 0 ? iP - 1 : iE;
    ribbon.push({ a: iS, b: Math.max(iS, accEnd), t: "ACCUMULATION", fill: C.acc, col: C.accLine });
    if (iP >= 0 && iR >= 0) ribbon.push({ a: iP, b: iR, t: "MANIPULATION", fill: C.manip, col: C.manipLine });
    if (iR >= 0 && iE > iR) ribbon.push({ a: iR + 1, b: iE, t: cycle.outcome === "manipulation_failed" ? "FAILED" : "DISTRIBUTION", fill: cycle.outcome === "manipulation_failed" ? "rgba(220,38,38,0.12)" : C.dist, col: cycle.outcome === "manipulation_failed" ? "#b91c1c" : C.distLine });
  }
  const dayIdx = session ? bars.map((b, i) => (b.key.slice(0, 10) === (cycle.day ?? "").slice(0, 10) ? i : -1)).filter((i) => i >= 0) : [];
  const tIdx = (hhmm: string) => dayIdx.find((i) => bars[i].key.slice(11, 16) >= hhmm) ?? -1;
  if (session && dayIdx.length) {
    const i0 = dayIdx[0], i11 = tIdx("11:00"), iEnd = dayIdx[dayIdx.length - 1];
    ribbon.push({ a: i0, b: i0, t: "A · OPEN", fill: C.acc, col: C.accLine });
    if (i11 > i0) ribbon.push({ a: i0 + 1, b: i11 - 1, t: "M · JUDAS WINDOW", fill: C.manip, col: C.manipLine });
    if (iR >= 0) ribbon.push({ a: iR + 1, b: iEnd, t: "D · DISTRIBUTION", fill: C.dist, col: C.distLine });
  }

  return (
    <div className="rounded-md border border-white/10 bg-[#0b0f16] p-2">
      <div className="mb-2 flex flex-wrap items-center gap-2 px-1 text-[11px]">
        {([["phases", "A · M · D phases"], ["liq", "Liquidity (EQH/EQL, PDH/PDL, pools)"], ["arrays", "MSS / FVG"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setShow((v) => ({ ...v, [k]: !v[k] }))} className={`rounded border px-2 py-0.5 ${show[k] ? "border-[#d9a441]/60 text-[#f2c873]" : "border-white/15 text-[#7f8ca3]"}`}>{l}</button>
        ))}
        <span className="ml-auto font-mono text-[#93a1b6]">{tf === "1d" ? "Daily" : tf} · NY time · HTF order flow {biasTxt}</span>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full select-none rounded" style={{ background: C.bg }}
        onMouseMove={(e) => { const r = svgRef.current!.getBoundingClientRect(); const x = ((e.clientX - r.left) / r.width) * W; const i = Math.floor((x - PL) / cw); setHover(i >= 0 && i < n ? i : null); }}
        onMouseLeave={() => setHover(null)}>
        {ticks.map((p, k) => <g key={k}><line x1={PL} x2={right} y1={Y(p)} y2={Y(p)} stroke={C.grid} strokeWidth={0.6} /><text x={right + 6} y={Y(p) + 3} fontSize={9} fill={C.axis}>{f2(p)}</text></g>)}
        {seps.map((q) => <g key={q.i}><line x1={xl(q.i)} x2={xl(q.i)} y1={PT} y2={H - PB} stroke={C.sep} strokeDasharray="3 3" strokeWidth={0.8} /><text x={xl(q.i) + 3} y={H - PB + 14} fontSize={10} fill={C.axis}>{q.label}</text></g>)}
        {tf !== "1d" ? bars.map((b, i) => b.key.endsWith("09:30") ? <text key={`o${i}`} x={X(i)} y={H - PB + 26} fontSize={9} fill={C.axis} textAnchor="middle">09:30</text> : null) : null}

        {show.phases ? ribbon.map((r) => <g key={r.t}>
          <rect x={xl(r.a)} y={PT - 16} width={xr(r.b) - xl(r.a)} height={12} fill={r.fill} stroke={r.col} strokeWidth={0.6} />
          {label((xl(r.a) + xr(r.b)) / 2, PT - 7, xr(r.b) - xl(r.a) >= r.t.length * 6 ? r.t : r.t.slice(0, 1), r.col, "middle", 0, 9)}
        </g>) : null}

        {/* ------------------------------------------------ structural AMD */}
        {!session && cycle.acc_hi != null && cycle.acc_lo != null && iS >= 0 ? (() => {
          const boxEnd = iP >= 0 ? iP : iE;
          const rayEnd = iE >= 0 ? iE : n - 1;
          return <g>
            {/* accumulation box, frozen at confirmation; dashed continuation until the raid */}
            <rect x={xl(iS)} y={Y(cycle.acc_hi)} width={xr(Math.max(iC, iS)) - xl(iS)} height={Math.max(1, Y(cycle.acc_lo) - Y(cycle.acc_hi))} fill={C.acc} stroke={C.accLine} strokeWidth={1} />
            {boxEnd > iC ? <rect x={xr(iC)} y={Y(cycle.acc_hi)} width={xl(boxEnd) - xr(iC)} height={Math.max(1, Y(cycle.acc_lo) - Y(cycle.acc_hi))} fill={C.acc} stroke={C.accLine} strokeWidth={0.6} strokeDasharray="4 3" /> : null}
            {cycle.ce != null ? <line x1={xl(iS)} x2={xr(rayEnd)} y1={Y(cycle.ce)} y2={Y(cycle.ce)} stroke={C.accLine} strokeDasharray="2 3" strokeWidth={0.8} /> : null}
            {cycle.ce != null ? rayLabel(cycle.ce, "CE 50%", C.accLine) : null}
            {label(xl(iS) + 3, Y(cycle.acc_hi) + 12, "ACCUMULATION", C.accLine)}
            {iC >= 0 ? label(X(iC), Y(cycle.acc_lo) + 22, "▲ range confirmed", C.axis, "middle", 0, 9) : null}
            {show.liq ? <>
              <line x1={xl(iS)} x2={xr(rayEnd)} y1={Y(cycle.acc_hi)} y2={Y(cycle.acc_hi)} stroke={C.bsl} strokeWidth={1} />
              <line x1={xl(iS)} x2={xr(rayEnd)} y1={Y(cycle.acc_lo)} y2={Y(cycle.acc_lo)} stroke={C.ssl} strokeWidth={1} />
              {rayLabel(cycle.acc_hi, "EQH · BSL", C.bsl)}
              {rayLabel(cycle.acc_lo, "EQL · SSL", C.ssl)}
              {eqh.map(([k, p]) => { const i = at(k); return i < 0 ? null : <g key={`h${k}`}><line x1={X(i) - 5} x2={X(i) + 5} y1={Y(p) - 3} y2={Y(p) - 3} stroke={C.bsl} strokeWidth={1.4} /><line x1={X(i) - 5} x2={X(i) + 5} y1={Y(p) - 6} y2={Y(p) - 6} stroke={C.bsl} strokeWidth={1.4} /></g>; })}
              {eql.map(([k, p]) => { const i = at(k); return i < 0 ? null : <g key={`l${k}`}><line x1={X(i) - 5} x2={X(i) + 5} y1={Y(p) + 3} y2={Y(p) + 3} stroke={C.ssl} strokeWidth={1.4} /><line x1={X(i) - 5} x2={X(i) + 5} y1={Y(p) + 6} y2={Y(p) + 6} stroke={C.ssl} strokeWidth={1.4} /></g>; })}
            </> : null}
            {/* manipulation: the raid beyond the edge that came back */}
            {iP >= 0 && iR >= 0 && cycle.sweep_extreme != null ? (() => {
              const edge = bull ? cycle.acc_lo! : cycle.acc_hi!;
              return <g>
                <rect x={xl(iP)} y={Math.min(Y(edge), Y(cycle.sweep_extreme))} width={xr(iR) - xl(iP)} height={Math.max(2, Math.abs(Y(cycle.sweep_extreme) - Y(edge)))} fill={C.manip} stroke={C.manipLine} strokeWidth={1} />
                <line x1={xl(iP)} x2={xr(rayEnd)} y1={Y(cycle.sweep_extreme)} y2={Y(cycle.sweep_extreme)} stroke={C.manipLine} strokeDasharray="5 3" strokeWidth={0.9} />
                {rayLabel(cycle.sweep_extreme, bull ? "SWEEP LOW" : "SWEEP HIGH", C.manipLine)}
                {label(X(iP), bull ? Y(cycle.sweep_extreme) + 14 : Y(cycle.sweep_extreme) - 6, `${bull ? "SSL" : "BSL"} RAID · ${cycle.manip_kind === "2B" ? "2B / JUDAS" : "WICK"}`, C.manipLine, "middle")}
                {label(X(iR), bull ? Y(edge) - 6 : Y(edge) + 14, "returned inside", C.manipLine, "middle", 0, 9)}
              </g>;
            })() : null}
            {iP >= 0 && iR < 0 ? label(X(iP), Y(cycle.breakout_dir === "up" ? cycle.acc_hi : cycle.acc_lo) + (cycle.breakout_dir === "up" ? -8 : 16), "BREAKOUT · no return (not AMD)", "#475569", "middle") : null}
            {/* distribution: MSS + displacement FVG */}
            {show.arrays && iM >= 0 && cycle.mss_level != null ? <g>
              <line x1={X(Math.max(0, iMs))} x2={X(iM)} y1={Y(cycle.mss_level)} y2={Y(cycle.mss_level)} stroke={C.mss} strokeWidth={1.4} />
              {label((X(Math.max(0, iMs)) + X(iM)) / 2, Y(cycle.mss_level) + (bull ? -5 : 13), "MSS", C.mss, "middle")}
              {label(X(iM), bull ? Y(bars[iM].high) - 6 : Y(bars[iM].low) + 14, "DISPLACEMENT", C.mss, "middle", 0, 9)}
            </g> : null}
            {show.arrays && fvg ? (() => {
              const i = at(fvg[0]); if (i < 0) return null;
              const [, fb, ft] = fvg; const ceF = (fb + ft) / 2;
              const end = te >= 0 ? te : Math.min(n - 1, i + 12);
              return <g>
                <rect x={xl(i)} y={Y(ft)} width={xr(end) - xl(i)} height={Math.max(1, Y(fb) - Y(ft))} fill={bull ? C.fvgBull : C.fvgBear} stroke={bull ? "#1d4ed8" : "#b91c1c"} strokeWidth={0.7} />
                <line x1={xl(i)} x2={xr(end)} y1={Y(ceF)} y2={Y(ceF)} stroke={bull ? "#1d4ed8" : "#b91c1c"} strokeDasharray="2 3" strokeWidth={0.8} />
                {label(xr(end) + 2, Y(ceF) + 3, `${bull ? "+" : "-"}FVG · CE`, bull ? "#1d4ed8" : "#b91c1c")}
              </g>;
            })() : null}
            {/* external draw on liquidity known at the decision bar */}
            {show.liq && trade ? pools.slice(0, 2).map((p, k) => <g key={`p${k}`}>
              <line x1={td >= 0 ? X(td) : xl(0)} x2={right} y1={Y(p)} y2={Y(p)} stroke={bull ? C.bsl : C.ssl} strokeDasharray="1 3" strokeWidth={1.1} />
              {rayLabel(p, k === 0 ? (bull ? "EXT BSL (draw)" : "EXT SSL (draw)") : "next pool", bull ? C.bsl : C.ssl)}
            </g>) : null}
          </g>;
        })() : null}

        {/* ------------------------------------------------ session Po3 */}
        {session && dayIdx.length && cycle.true_open != null ? (() => {
          const i0 = dayIdx[0], iEnd = dayIdx[dayIdx.length - 1], i11 = tIdx("11:00"), i12 = tIdx("12:00");
          return <g>
            {i11 > i0 ? <rect x={xl(i0)} y={PT} width={xl(i11) - xl(i0)} height={H - PT - PB} fill={C.window} /> : null}
            {i12 > i11 && i11 >= 0 ? <rect x={xl(i11)} y={PT} width={xl(i12) - xl(i11)} height={H - PT - PB} fill={C.trig} /> : null}
            {i11 > i0 ? label((xl(i0) + xl(i11)) / 2, H - PB - 6, "09:30–11:00 Judas window", C.manipLine, "middle", 0, 9) : null}
            <line x1={xl(i0)} x2={xr(iEnd)} y1={Y(cycle.true_open)} y2={Y(cycle.true_open)} stroke={C.open} strokeWidth={1.3} />
            {rayLabel(cycle.true_open, "TRUE DAY OPEN", C.open)}
            {show.liq && cycle.pdh != null ? <><line x1={xl(0)} x2={xr(iEnd)} y1={Y(cycle.pdh)} y2={Y(cycle.pdh)} stroke={C.bsl} strokeDasharray="6 3" strokeWidth={1} />{rayLabel(cycle.pdh, "PDH · BSL", C.bsl)}</> : null}
            {show.liq && cycle.pdl != null ? <><line x1={xl(0)} x2={xr(iEnd)} y1={Y(cycle.pdl)} y2={Y(cycle.pdl)} stroke={C.ssl} strokeDasharray="6 3" strokeWidth={1} />{rayLabel(cycle.pdl, "PDL · SSL", C.ssl)}</> : null}
            {iP >= 0 && cycle.sweep_extreme != null ? <g>
              <circle cx={X(iP)} cy={Y(cycle.sweep_extreme)} r={4} fill="none" stroke={C.manipLine} strokeWidth={1.5} />
              {label(X(iP), bull ? Y(cycle.sweep_extreme) + 16 : Y(cycle.sweep_extreme) - 8, `JUDAS ${bull ? "LOW" : "HIGH"}${cycle.manip_kind === "swept_PDL" ? " · took PDL" : cycle.manip_kind === "swept_PDH" ? " · took PDH" : cycle.manip_kind === "opened_outside_prior_range" ? " · gap day" : ""}`, C.manipLine, "middle")}
            </g> : null}
            {iR >= 0 ? label(X(iR), bull ? Y(bars[iR].high) - 6 : Y(bars[iR].low) + 14, "close back through open", C.mss, "middle", 0, 9) : null}
          </g>;
        })() : null}

        {/* position tool */}
        {trade && te >= 0 ? (() => {
          const x1 = xl(te), x2 = xr(tx >= 0 ? tx : n - 1);
          const tgt = trade.tgt;
          return <g>
            {tgt != null ? <rect x={x1} y={Math.min(Y(trade.entry), Y(tgt))} width={x2 - x1} height={Math.abs(Y(tgt) - Y(trade.entry))} fill={C.tp} /> : null}
            <rect x={x1} y={Math.min(Y(trade.entry), Y(trade.stop))} width={x2 - x1} height={Math.abs(Y(trade.stop) - Y(trade.entry))} fill={C.sl} />
            <line x1={x1} x2={x2} y1={Y(trade.entry)} y2={Y(trade.entry)} stroke={C.entry} strokeWidth={1.2} />
            {label(x1 - 3, Y(trade.entry), `ENTRY ${f2(trade.entry)}`, C.entry, "end", 3)}
            {label(x1 - 3, Y(trade.stop), `SL ${f2(trade.stop)}`, "#b91c1c", "end", 3)}
            {tgt != null ? label(x1 - 3, Y(tgt), `TP ${targetLabel ?? trade.target} ${f2(tgt)}`, "#15803d", "end", 3) : null}
          </g>;
        })() : null}
        {trade && td >= 0 ? <g>
          <line x1={xr(td)} x2={xr(td)} y1={PT} y2={H - PB} stroke="#0f172a" strokeDasharray="2 4" strokeWidth={0.8} />
          {label(xr(td) + 3, PT + 10, "decision · levels frozen", "#0f172a", "start", 0, 9)}
        </g> : null}

        {bars.map((b, i) => {
          const up = b.close >= b.open, x = X(i);
          const hl = i === iM || i === iR;
          return <g key={b.key}>
            <line x1={x} x2={x} y1={Y(b.high)} y2={Y(b.low)} stroke={C.wick} strokeWidth={1} />
            <rect x={x - bw / 2} y={Y(Math.max(b.open, b.close))} width={bw} height={Math.max(1, Math.abs(Y(b.open) - Y(b.close)))} fill={up ? C.up : C.down} stroke={hl ? C.mss : C.wick} strokeWidth={hl ? 1.6 : 0.8} />
          </g>;
        })}

        {trade && te >= 0 ? label(X(te), trade.side === "bull" ? Y(bars[te].low) + 26 : Y(bars[te].high) - 18, trade.side === "bull" ? "BUY" : "SELL", C.entry, "middle") : null}
        {trade && tx >= 0 ? (() => {
          const py = trade.outcome === "win" && trade.tgt != null ? trade.tgt : trade.outcome === "loss" ? trade.stop : bars[tx].close;
          const col = trade.r > 0 ? "#15803d" : trade.r < 0 ? "#dc2626" : "#64748b";
          return <g><circle cx={X(tx)} cy={Y(py)} r={4} fill={col} />{label(X(tx) + 6, Y(py) + ((py <= trade.entry) === (trade.side === "bull") ? 14 : -6), `EXIT ${trade.outcome.toUpperCase()} ${trade.r > 0 ? "+" : ""}${trade.r.toFixed(2)}R`, col)}</g>;
        })() : null}

        {hover != null ? <line x1={X(hover)} x2={X(hover)} y1={PT} y2={H - PB} stroke="#94a3b8" strokeWidth={0.6} /> : null}
        <rect x={PL} y={PT} width={right - PL} height={H - PT - PB} fill="none" stroke={C.grid} />
        <text x={PL + 4} y={14} fontSize={11} fill={C.ink} fontWeight={600}>
          {hb ? `${hb.key}  O ${f2(hb.open)}  H ${f2(hb.high)}  L ${f2(hb.low)}  C ${f2(hb.close)}`
            : session ? `${cycle.sym} · session Po3 ${(cycle.day ?? "").slice(0, 10)} · open ${f2(cycle.true_open ?? 0)} · PDH ${f2(cycle.pdh ?? 0)} · PDL ${f2(cycle.pdl ?? 0)}`
              : `${cycle.sym} · AMD · range ${f2(cycle.acc_lo ?? 0)}–${f2(cycle.acc_hi ?? 0)} · CE ${f2(cycle.ce ?? 0)}${cycle.sweep_extreme != null ? ` · sweep ${f2(cycle.sweep_extreme)}` : ""}`}
        </text>
      </svg>
    </div>
  );
}
