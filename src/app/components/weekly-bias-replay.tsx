"use client";
import { dailyContext, defaultContextReferences } from "@/lib/daily-context";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WeeklyReplayChart from "./weekly-replay-chart";
import { frames, instruments, type Frame } from "@/lib/daily-bias";
import { buildWeeklyReplay, completedWeeklyBars, dailyExplanations, deriveIctOverlays, type ReplayData, type ReplayBar } from "@/lib/weekly-replay";
const kinds = ["FVG", "IFVG", "OB", "BREAKER", "EQH", "EQL", "BSL", "SSL", "BOS", "CHOCH"];
const price = (n: number | null | undefined) => n == null ? "—" : n.toFixed(2);
const colors: Record<string, string> = { FVG: "#34d399", IFVG: "#fbbf24", OB: "#a78bfa", BREAKER: "#fb923c", EQH: "#f472b6", EQL: "#60a5fa", BSL: "#f472b6", SSL: "#60a5fa", BOS: "#22d3ee", CHOCH: "#e879f9" };
export default function WeeklyBiasReplay({ symbol, onSymbolChange }: {
    symbol: string;
    onSymbolChange: (s: string) => void;
}) {
    const [frame, setFrame] = useState<Frame>("1d"), [data, setData] = useState<ReplayData>(), [error, setError] = useState(""), [cutoff, setCutoff] = useState<number>(0), [start, setStart] = useState("2026-01-06"), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(800), [enabled, setEnabled] = useState<string[]>([]), [selected, setSelected] = useState("");
    const startRef = useRef(start);
    const [showDailyReferences, setShowDailyReferences] = useState(true);
    const [showSwings, setShowSwings] = useState(true), [showEquilibrium, setShowEquilibrium] = useState(false), [selectedDay, setSelectedDay] = useState("");
    const selectDay = useCallback((day: string) => setSelectedDay(day), []);
    useEffect(() => {
        const ctrl = new AbortController();
        fetch(`/api/daily-bias/replay?symbol=${encodeURIComponent(symbol)}&tf=${frame}`, { signal: ctrl.signal, cache: "no-store" }).then(async (r) => {
            const d = await r.json();
            if (!r.ok)
                throw Error(d.error);
            setError("");
            setData(d);
            setCutoff(c => c || ((d.daily.find((b: ReplayBar) => b.day >= startRef.current)?.t ?? d.daily.at(-1)?.t ?? 0) - 1));
        }).catch(e => {
            if (e.name !== "AbortError")
                setError(e.message);
        });
        return () => ctrl.abort();
    }, [symbol, frame]);
    const loaded = data?.instrument.name === symbol && data.frame === frame ? data : undefined;
    const replay = useMemo(() => loaded ? buildWeeklyReplay(loaded, cutoff) : null, [loaded, cutoff]);
    const cursor = loaded?.bars.findLastIndex(b => b.knownAt <= cutoff) ?? -1, next = loaded?.bars[cursor + 1];
    useEffect(() => {
        if (!playing || !next)
            return;
        const id = setTimeout(() => {
            setCutoff(next.knownAt);
            if (loaded && cursor + 1 === loaded.bars.length - 1)
                setPlaying(false);
        }, speed);
        return () => clearTimeout(id);
    }, [playing, next, speed, loaded, cursor]);
    const weekly = useMemo(() => replay ? completedWeeklyBars(replay.daily, replay.bars.at(-1)?.day ?? replay.daily.at(-1)?.day ?? start, loaded?.invalidDailyDays) : [], [replay, start, loaded]);
    const weeklyZones = useMemo(() => loaded ? deriveIctOverlays(weekly, "1w", loaded.instrument.market, weekly) : [], [loaded, weekly]);
    const reasons = useMemo(() => replay && loaded ? dailyExplanations(replay.daily, loaded.instrument.market, loaded.invalidDailyDays) : [], [replay, loaded]);
    const shown = useMemo(() => [...(replay?.overlays ?? []), ...weeklyZones].filter(z => enabled.includes(z.kind)), [replay, weeklyZones, enabled]);
    const dailyShown = useMemo(() => shown.filter(z => z.tf !== "1w"), [shown]);
    const weeklyShown = useMemo(() => shown.filter(z => z.tf === "1w"), [shown]);
    const explanation = selectedDay ? reasons.find(r => r.day === selectedDay) : reasons.at(-1);
    const context = useMemo(() => loaded && explanation ? dailyContext(loaded, explanation.day) : null, [loaded, explanation]);
    const weeklyContext = useMemo(() => loaded && weekly.length ? dailyContext({ ...loaded, daily: weekly, bars: weekly }, weekly.at(-1)!.day, "1w") : null, [loaded, weekly]);
    const weeklyReferences = useMemo(() => weeklyContext && showDailyReferences ? defaultContextReferences(weeklyContext) : [], [weeklyContext, showDailyReferences]);
    const explanationReferences = useMemo(() => context && showDailyReferences ? defaultContextReferences(context) : [], [context, showDailyReferences]);
    const active = [...(replay?.overlays ?? []), ...weeklyZones].find(z => z.id === selected);
    const weeklyAlignment = weeklyZones.filter(z => z.status !== "SWEPT" && enabled.includes(z.kind) && replay?.bars.at(-1) && z.knownAt < replay.bars.at(-1)!.knownAt && replay.bars.at(-1)!.h >= z.low && replay.bars.at(-1)!.l <= z.high);
    const cls = "rounded border border-white/20 bg-[#182130] px-3 py-2";
    function reset() {
        if (!loaded)
            return;
        setPlaying(false);
        setCutoff((loaded.daily.find(b => b.day >= start)?.t ?? 0) - 1);
    }
    return <section className="space-y-4 rounded-xl border border-blue-400/30 bg-[#0d1118] p-4">

 <div><h2 className="text-2xl font-semibold">Previous week · ICT candle replay</h2><p className="mt-2 text-sm text-slate-400">Read the candles first: green closes up, black closes down. Blue lines show last week’s high and low. Play reveals one completed candle at a time.</p></div>

 <div className="flex flex-wrap items-end gap-3"><label>Symbol<select aria-label="Replay symbol" className={`${cls} block`} value={symbol} onChange={e => { setPlaying(false); setCutoff(0); onSymbolChange(e.target.value); }}>{instruments.map(i => <option key={i.name}>{i.name}</option>)}</select></label><label>Timeframe<select aria-label="Replay timeframe" className={`${cls} block`} value={frame} onChange={e => { setPlaying(false); setFrame(e.target.value as Frame); }}>{frames.map(f => <option key={f}>{f}</option>)}</select></label><label>Replay from<input aria-label="Replay from" className={`${cls} block`} type="date" value={start} onChange={e => { startRef.current = e.target.value; setStart(e.target.value); }}/></label><button className={cls} onClick={reset}>Reset to start</button><button className={cls} disabled={!loaded || cursor < 0} onClick={() => { setPlaying(false); setCutoff(cursor > 0 ? loaded!.bars[cursor - 1].knownAt : loaded!.bars[0].t - 1); }}>Previous candle</button><button className={cls} disabled={!next && !playing} onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Play"}</button><button className={cls} disabled={!next} onClick={() => { setPlaying(false); setCutoff(next!.knownAt); }}>Next candle</button><label>Speed<select aria-label="Replay speed" className={cls} value={speed} onChange={e => setSpeed(Number(e.target.value))}><option value={2000}>Slow</option><option value={800}>Normal</option><option value={250}>Fast</option></select></label></div>

 {error ? <p role="alert" className="text-red-300">{error}</p> : !loaded ? <p>Loading native candles…</p> : <>

 <input aria-label="Replay timeline" className="w-full" disabled={!loaded.bars.length} type="range" min={-1} max={Math.max(0, loaded.bars.length - 1)} value={cursor} onChange={e => { setPlaying(false); const i = Number(e.target.value); setCutoff(i < 0 ? (loaded.bars[0]?.t ?? 0) - 1 : loaded.bars[i].knownAt); }}/>

 <div className="grid gap-3 md:grid-cols-3"><div className="rounded border border-white/10 p-3">Replay clock<p className="mt-1 text-sm">{loaded.daily.length && cutoff ? new Date(cutoff).toLocaleString("en-US", { timeZone: loaded.instrument.zone }) : "—"} · {loaded.instrument.zone}</p></div><div className="rounded border border-white/10 p-3">Previous week {replay?.range?.referenceWeek ?? "unavailable"}<p>High {price(replay?.range?.high)} · Low {price(replay?.range?.low)} · Middle {price(replay?.range?.midpoint)}</p></div><div className="rounded border border-white/10 p-3">Intended direction <strong className="text-amber-300">{replay?.direction}{replay?.direction === "SELL" ? " · looking lower ↓" : replay?.direction === "BUY" ? " · looking higher ↑" : " · waiting"}</strong><p>Draw {price(replay?.target)} {replay?.intradayDrawHit ? "· touched intraday" : ""}</p></div></div>

 <p className="text-sm text-slate-300">{replay?.reason}</p>

 <div className="rounded border border-white/10 p-3 text-sm"><strong>Daily explanation · {explanation?.day ?? (selectedDay || "unavailable")}</strong><p className="mt-1">{explanation?.reasons.map(r => `${r.label}: ${r.evidence}`).join(" · ") || (explanation ? "No qualifying event" : "Selected daily candle is not complete or outside the explanation window.")}</p><p className="mt-1 text-slate-400">Earlier swings: {explanation?.structure}. This candle: {explanation?.closeEvidence}.</p></div>
 <p className="text-sm text-amber-200">Framework: {context?.primary ?? "unavailable"} · end-of-day local classification</p>
 <div className="flex flex-wrap gap-4 text-sm"><label><input type="checkbox" checked={showDailyReferences} onChange={e => setShowDailyReferences(e.target.checked)}/> Daily explanation reference levels (default on)</label><label><input type="checkbox" checked={showSwings} onChange={e => setShowSwings(e.target.checked)}/> Swing highs / lows</label><label><input type="checkbox" checked={showEquilibrium} onChange={e => setShowEquilibrium(e.target.checked)}/> 50% equilibrium</label><button className="text-xs text-blue-300" onClick={() => setSelectedDay("")}>Show latest daily explanation</button></div>
 <details className="rounded border border-white/10 p-3"><summary className="cursor-pointer text-sm">Optional ICT zones · {enabled.length ? `${enabled.length} categories selected` : "off for a clean view"}</summary><p className="my-2 text-xs text-slate-400">FVG, IFVG, OB and BREAKER are local candidate rules. Each chart draws two recent active events per enabled category. Use its zone browser to inspect any retained event, including historical events; counts explain what is hidden.</p><div className="flex flex-wrap gap-3">{kinds.map(k => <label key={k} className="text-xs" style={{ color: colors[k] }}><input type="checkbox" checked={enabled.includes(k)} onChange={e => setEnabled(e.target.checked ? [...enabled, k] : enabled.filter(x => x !== k))}/> {k}</label>)}</div></details>

 {!loaded.bars.length ? <p className="text-amber-300">No native {frame} data for {symbol}.</p> : !replay?.bars.length ? <p className="text-amber-300">No {frame} candles yet. First available: {loaded.bars[0].day}. No bars are fabricated.</p> : null}

 <div className="grid gap-4 xl:grid-cols-2"><WeeklyReplayChart viewKey={`${symbol}:${frame}`} market={loaded.instrument.market} bars={replay?.bars ?? []} title={`${symbol} · ${frame} replay`} referencePoints={explanationReferences} framework={context?.primary} frame={frame} invalidDays={loaded.invalidDailyDays} range={replay?.range ?? null} target={replay?.target ?? null} zones={dailyShown} showSwings={showSwings} showEquilibrium={showEquilibrium} selected={selected} onSelect={setSelected} onDaySelect={selectDay}/><WeeklyReplayChart viewKey={symbol} market={loaded.instrument.market} bars={weekly} title={`${symbol} · weekly reference`} framework={weeklyContext?.primary} referencePoints={weeklyReferences} frame="1w" invalidDays={loaded.invalidDailyDays} range={replay?.range ?? null} target={null} zones={weeklyShown} showSwings={showSwings} showEquilibrium={showEquilibrium} selected={selected} onSelect={setSelected} onDaySelect={selectDay}/></div>

 <details className="rounded border border-white/10 p-3"><summary className="cursor-pointer text-sm">Daily reasons and detailed ICT evidence</summary>
 <div className="grid gap-4 md:grid-cols-2"><div><h3 className="font-semibold">Current candle confluence / touches</h3><div className="mt-2 space-y-1 text-xs">{replay?.alignment.map(z => <button className="block text-left" key={z.id} onClick={() => setSelected(z.id)}>{z.tf} {z.kind} {price(z.low)}–{price(z.high)} · {z.alignment}</button>)}{shown.filter(z => z.lastTouch === replay?.bars.at(-1)?.t).map(z => <button className="block text-left text-amber-300" key={z.id} onClick={() => setSelected(z.id)}>{z.kind} touched · {z.status}</button>)}{weeklyAlignment.map(z => <button className="block text-left text-blue-300" key={z.id} onClick={() => setSelected(z.id)}>1w {z.kind} {price(z.low)}–{price(z.high)} · {replay?.direction === "NEUTRAL" || replay?.direction === "UNAVAILABLE" ? "CONTEXT" : ["BSL", "EQH"].includes(z.kind) ? replay?.direction === "BUY" ? "TARGET LIQUIDITY" : "OPPOSING LIQUIDITY" : ["SSL", "EQL"].includes(z.kind) ? replay?.direction === "SELL" ? "TARGET LIQUIDITY" : "OPPOSING LIQUIDITY" : z.direction === replay?.direction ? "ALIGNED" : "OPPOSES"} · current candle overlap</button>)}{!replay?.alignment.length && !weeklyAlignment.length ? <p className="text-slate-400">No active zone overlap.</p> : null}</div></div><div><h3 className="font-semibold">Selected event evidence</h3><p className="mt-2 text-xs text-slate-300">{active ? `${active.tf} ${active.kind}: ${active.description} Origin ${active.originDay}; known ${new Date(active.knownAt).toISOString()}; ${active.touches} later touches; ${active.status}.` : "Click a zone or event to inspect its rule and confirmation time."}</p><div className="mt-2 flex flex-wrap gap-2">{shown.slice(-14).map(z => <button className="rounded border border-white/10 p-1 text-xs" key={z.id} onClick={() => setSelected(z.id)}>{z.tf} {z.kind} {z.originDay}</button>)}</div></div></div>

 <div className="max-h-80 overflow-auto"><table className="w-full text-left text-xs"><thead><tr>{["Completed day", "Reason categories / evidence", "Daily swing structure", "Last confirmed H / L"].map(h => <th className="p-2" key={h}>{h}</th>)}</tr></thead><tbody>{reasons.slice(-40).reverse().map(r => <tr className="border-t border-white/10" key={r.day}><td className="p-2">{r.day}</td><td className="p-2">{r.reasons.length ? r.reasons.map(x => <p key={x.label}><strong>{x.label}</strong> · {x.evidence}</p>) : "No qualifying event"}</td><td className="p-2">{r.structure}<p className="text-slate-400">{r.closeEvidence}</p><p>HH support: {r.higherHighs === null ? "unknown" : r.higherHighs ? "Yes" : "No"} · LL support: {r.lowerLows === null ? "unknown" : r.lowerLows ? "Yes" : "No"}</p></td><td className="p-2">{price(r.swingHigh)} / {price(r.swingLow)}</td></tr>)}</tbody></table></div>

 </details>
 <details className="text-sm text-slate-400"><summary className="cursor-pointer">Detection rules and source limits</summary><p className="mt-2">Reason categories describe observed events, not proven algorithmic intent; several may apply and unqualified candles remain unclassified. Liquidity is a known swing or prior-week extreme; inefficiency is an existing FVG/IFVG overlap; generation is a newly confirmed pivot/equal pair; equilibrium is a weekly midpoint touch. Daily structure compares the last two alternating swing highs and lows known before that session (strict three-candle pattern, one neighbour on each side; consecutive same-type pivots retain the more extreme point). HH/LL describes swing progression, not a trade approval.</p><p className="mt-2">FVG: three consecutive candles and directional middle body. OB candidate: last opposite candle within six bars of a confirmed swing break whose body is at least prior 14-bar ATR. IFVG / breaker candidate: completed close through FVG / OB. Equal levels: confirmed pivots within 0.1 ATR. These local deterministic candidates do not constitute the complete ICT entry checklist. Detection uses the latest 240 candles per frame. Completed weeks roll at the next calendar week; observed sessions include holidays, with no exchange calendar completeness guarantee. Chart direction persists within a reference week until its draw is reached; the statistical table independently recalculates its daily signal.</p><p className="mt-2">{loaded.provenance} Invalid {loaded.audit.invalid}; duplicates {loaded.audit.duplicates}; conflicts {loaded.audit.conflicts}. Weekly chart excludes the forming week. Neutral sessions remain visible.</p></details>

 </>}

 </section>;
}
