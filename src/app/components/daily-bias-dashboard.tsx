"use client";

import { useEffect, useState } from "react";

import DailyContextPanel from "./daily-context-panel";

import TopDownAnalysis from "./top-down-analysis";

import { concepts } from "@/lib/daily-bias";

import type { DailyBiasReport } from "@/lib/daily-bias-data";

const pct = (n:number,d:number) => d ? `${(100*n/d).toFixed(1)}%` : "—";

const num = (n:number|null|undefined) => n == null ? "—" : n.toFixed(2);

export default function DailyBiasDashboard() {

 const [report,setReport]=useState<DailyBiasReport>(); const [error,setError]=useState("");

 const [concept,setConcept]=useState(concepts[0]); const [symbol,setSymbol]=useState("AAPL"); const [cost,setCost]=useState("0.05"); const [page,setPage]=useState(0);

 useEffect(()=>{const ctrl=new AbortController();fetch("/api/daily-bias",{signal:ctrl.signal}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error);setReport(d);}).catch(e=>{if(e.name!=="AbortError")setError(e.message);});return ()=>ctrl.abort();},[]);

 const summaries=report?.results.flatMap(r=>r.summaries).filter(s=>s.concept===concept)??[];

 const selected=report?.results.find(r=>r.instrument.name===symbol);

 const monthly=selected?.monthly.filter(r=>r.concept===concept)??[];

 const rows=report?.results.find(r=>r.instrument.name===symbol)?.rows.filter(r=>r.concept===concept)??[];

 function download(){if(!report)return;const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download="daily-bias-2026.json";a.click();URL.revokeObjectURL(url);}

 async function refresh(){setReport(undefined);setError("");try{const r=await fetch("/api/daily-bias?refresh=1",{cache:"no-store"});const data=await r.json();if(!r.ok)throw new Error(data.error);setReport(data);}catch(e){setError(e instanceof Error?e.message:"Research refresh failed");}}

 return <section className="space-y-6">

 <div className="flex flex-wrap justify-between gap-4"><div><p className="text-xs tracking-widest text-amber-300">CANDLE RESEARCH · 2026</p><h1 className="mt-2 text-3xl font-semibold">Daily Bias</h1><p className="mt-2 text-sm text-slate-400">Three liquidity narratives, from daily context to a causal five-minute entry.</p></div><div className="flex gap-2"><button disabled={!report && !error} onClick={refresh} className="rounded border border-amber-300/40 px-4 py-2 disabled:opacity-40">Rerun analysis</button><button disabled={!report} onClick={download} className="rounded border border-white/20 px-4 py-2 disabled:opacity-40">Export full research JSON</button></div></div>

 <div className="grid gap-3 md:grid-cols-3">{concepts.map((name,i)=><button key={name} onClick={()=>{setConcept(name);setPage(0);}} className={`rounded-lg border p-4 text-left ${name===concept?"border-amber-400/60 bg-amber-400/10":"border-white/10 bg-white/5"}`}><p className="font-semibold">{name}</p><p className="mt-2 text-sm text-slate-400">{["Prior-day sweep and rejection, or a close beyond the range.","Previous completed week provides reversal levels and liquidity targets.","Confirmed swing rejection frames the next candle and opposing draw."][i]}</p></button>)}</div>

 <DailyContextPanel symbol={symbol} onSymbolChange={value=>{setSymbol(value);setPage(0);}}/>

 {concept==="Previous week"?<TopDownAnalysis symbol={symbol} onSymbolChange={value=>{setSymbol(value);setPage(0);}}/>:null}

 <details className="rounded-lg border border-white/10 bg-[#0d1118] p-4"><summary className="cursor-pointer font-semibold">Strategy rules, evidence and assumptions</summary><div className="mt-4 space-y-3 text-sm leading-6 text-slate-300">

 <p>Video evidence: <a className="text-amber-300 underline" href="https://youtu.be/g3oDYq4P9ZE?t=53">daily levels 00:53</a> · <a className="text-amber-300 underline" href="https://youtu.be/g3oDYq4P9ZE?t=270">weekly levels 04:30</a> · <a className="text-amber-300 underline" href="https://youtu.be/g3oDYq4P9ZE?t=472">next-day model 07:52</a> · <a className="text-amber-300 underline" href="https://youtu.be/g3oDYq4P9ZE?t=856">entries 14:16</a>.</p>

 <p>1d: Yesterday closes above/below its reference range → continuation. A single-sided sweep closes back inside → reversal. Inside bars and two-sided rejected sweeps are neutral. Weekly levels use the week completed before the signal day. Swing pivots require two candles on each side, a 60-day lookback, and retirement after a sweep. Swing bias is recomputed daily; discretionary carry-forward and order blocks are not modeled.</p>

 <p>Research adaptation: require a same-direction, uninvalidated FVG overlapping the signal on EACH native 1h, 30m and 15m frame. These extra filters are not specified in the video. The 5m three-candle FVG needs a directional middle body. Entry is its midpoint after the third candle closes; stop is the extreme of the last six 5m bars. The liquidity draw must offer at least 2R and must not already have been reached. Target is fixed 2R. One setup per concept/symbol/day, six-bar limit expiry, session-close exit.</p>

 <p>Equities: regular sessions, signals in the first 150 minutes (US 09:30 ET; India 09:15 IST). FX: native New York calendar days, London 02:00–05:00 and NY 07:00–10:00 ET; different from a 17:00 rollover feed. Current date excluded. Replay requires complete intraday grids on all four frames; early closes are excluded. Daily/intraday corporate-action price adjustments have not been reconciled.</p>

 <p>FVGs require consecutive trading candles. Missing bars during an open session are excluded; a scheduled session boundary is allowed only between its final candle and the next observed daily session’s first candle. OHLC cannot establish touched-limit fill ordering: stop wins if both levels touch; touched-limit fill-bar targets wait for the next bar. Marketable opening fills can hit the target during the fill bar. Gap stops use the worse opening price; opening gaps through the stop count as losses. Limit fills assume the midpoint price conservatively even if the open would improve the price. Pending limits cancel if the draw is reached before the fill. Costs are hypothetical R sensitivity. Concepts overlap: do not sum their R as a portfolio. This is a mechanical research variant of a discretionary lesson.</p>

 </div></details>

 {error?<p role="alert" className="text-red-300">{error}</p>:!report?<p role="status" className="text-amber-300">Analyzing nine symbols across five candle tables…</p>:<>

 <p className="text-sm text-slate-400">{report.start} to {report.endExclusive} exclusive · Run {report.version} · Generated {new Date(report.generatedAt).toLocaleString("en-US", {timeZone:"America/New_York"})} ET. Coverage includes 2025 warmup; performance is 2026 only.</p>

 <label className="block">Execution cost sensitivity <select aria-label="Execution cost sensitivity" className="ml-3 rounded bg-[#182130] p-2" value={cost} onChange={e=>setCost(e.target.value)}><option value="0">Gross</option><option value="0.05">0.05R / trade</option><option value="0.1">0.10R / trade</option></select></label>

 <div className="overflow-x-auto rounded-lg border border-white/10"><table className="w-full text-left text-sm"><thead className="bg-white/5 text-slate-400"><tr>{["Symbol","Bias days","Draw hit","Close beyond draw","Body aligned","Trades","Win rate gross","Net R*","Expectancy*","PF gross","DD gross","Ambiguous"].map(h=><th className="p-3" key={h}>{h}</th>)}</tr></thead><tbody>{summaries.map(s=><tr key={s.symbol} className="border-t border-white/10"><td className="p-3"><button className="text-amber-300 underline" onClick={()=>{setSymbol(s.symbol);setPage(0);}}>{s.symbol}</button></td><td className="p-3">{s.days}</td><td className="p-3">{pct(s.drawHit,s.days)}</td><td className="p-3">{pct(s.closeBeyondDraw,s.days)}</td><td className="p-3">{pct(s.candleAligned,s.days)}</td><td className="p-3">{s.trades}</td><td className="p-3">{pct(s.wins,s.trades)}</td><td className="p-3">{s.trades?num(s.totalR-s.trades*Number(cost)):"—"}</td><td className="p-3">{s.expectancy===null?"—":num(s.expectancy-Number(cost))}</td><td className="p-3">{num(s.profitFactor)}</td><td className="p-3">{s.trades?num(s.drawdown):"—"}</td><td className="p-3">{s.ambiguous}</td></tr>)}</tbody></table></div>

 <p className="text-xs text-slate-400">*Net R uses the selected hypothetical cost. Draw hit = the day touches the liquidity draw. Close beyond draw = BUY closes above that draw; SELL closes below it. Body aligned = close vs the same day’s open, shown separately. Equality is not a confirmed close.</p>

 <details className="rounded border border-white/10 p-4"><summary>Data coverage and exclusions</summary><div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th className="p-2">Symbol</th>{["1d","1h","30m","15m","5m"].map(f=><th className="p-2" key={f}>{f}</th>)}<th>Incomplete days</th></tr></thead><tbody>{report.results.map(r=><tr key={r.instrument.name} className="border-t border-white/10"><td className="p-2">{r.instrument.name}</td>{r.coverage.map(c=><td className="p-2" key={c.frame}>{c.count?`${c.count} · ${c.first} → ${c.last}`:"No data"}</td>)}<td>{r.incomplete}</td></tr>)}</tbody></table><p className="mt-3 text-slate-400">Conflicting candle timestamps excluded: {report.results.flatMap(r=>r.audits).reduce((s,a)=>s+a.conflicts,0)} · Invalid daily contexts excluded: {report.results.reduce((s,r)=>s+r.invalidDailyContext,0)} · Duplicate candles excluded: {report.results.flatMap(r=>r.audits).reduce((s,a)=>s+a.duplicates,0)} · Invalid candles: {report.results.flatMap(r=>r.audits).reduce((s,a)=>s+a.invalid,0)}. Per-frame source audits are in the export.</p></div></details>

 <div className="flex items-center gap-3"><h2 className="text-xl font-semibold">Daily evidence</h2><select aria-label="Evidence symbol" value={symbol} onChange={e=>{setSymbol(e.target.value);setPage(0);}} className="rounded bg-[#182130] p-2">{report.results.map(r=><option key={r.instrument.name}>{r.instrument.name}</option>)}</select><span className="text-sm text-slate-400">{rows.length} bias days</span></div>

 <div className="rounded-lg border border-white/10 bg-white/5 p-4"><h3 className="font-semibold">{symbol} · monthly stability</h3><p className="mt-2 text-sm text-slate-400">Unconditional baseline across {selected?.baseline.days??0} days: bullish body {pct(selected?.baseline.bullishClose??0,selected?.baseline.days??0)} · prior high reached {pct(selected?.baseline.previousHighHit??0,selected?.baseline.days??0)} · prior low reached {pct(selected?.baseline.previousLowHit??0,selected?.baseline.days??0)}. Close above prior high {pct(selected?.baseline.closeAbovePreviousHigh??0,selected?.baseline.days??0)} · close below prior low {pct(selected?.baseline.closeBelowPreviousLow??0,selected?.baseline.days??0)}. These populations differ from selected bias days.</p><div className="mt-4 flex flex-wrap gap-3">{monthly.map(m=><div key={m.month} className="min-w-24 rounded border border-white/10 p-3"><p className="text-xs text-slate-400">{m.month}</p><p className="mt-2 text-xl text-amber-300">{m.trades?num(m.totalR-m.trades*Number(cost))+"R":"—"}</p><p className="mt-1 text-xs">{m.trades} trades · {pct(m.hits,m.days)} draw hit</p></div>)}</div></div>

 <div className="overflow-x-auto rounded-lg border border-white/10"><table className="w-full text-left text-xs"><thead className="bg-white/5"><tr>{["Date","Bias / reason","Prior day high / low","Draw","Day open / close","Reached","Close beyond draw","Body aligned","Replay","Entry / stop","Known at / fill UTC","R gross"].map(h=><th className="p-3" key={h}>{h}</th>)}</tr></thead><tbody>{rows.slice(page*25,page*25+25).map(r=><tr key={r.day} className="border-t border-white/10"><td className="p-3">{r.day}</td><td className="max-w-xs p-3">{r.direction}<p className="mt-1 text-slate-400">{r.reason}</p></td><td className="p-3">{num(r.previousHigh)} / {num(r.previousLow)}</td><td className="p-3">{num(r.target)}</td><td className="p-3">{num(r.dayOpen)} / {num(r.dayClose)}</td><td className="p-3">{r.hit?"Yes":"No"}</td><td className="p-3">{r.closeBeyondDraw?"Yes":"No"}</td><td className="p-3">{r.candleAligned?"Yes":"No"}</td><td className="p-3">{r.status}{r.ambiguous?" · both touched":""}</td><td className="p-3">{num(r.entry)} / {num(r.stop)}</td><td className="p-3">{r.knownAt??"—"}<br/>{r.entryTime??"—"}</td><td className="p-3">{num(r.r)}</td></tr>)}</tbody></table>{!rows.length&&<p className="p-5 text-slate-400">No evaluable observations for this selection.</p>}</div>

 <div className="flex gap-3"><button disabled={!page} onClick={()=>setPage(page-1)} className="rounded border border-white/20 px-3 py-2 disabled:opacity-30">Previous</button><span className="py-2">{page+1} / {Math.max(1,Math.ceil(rows.length/25))}</span><button disabled={(page+1)*25>=rows.length} onClick={()=>setPage(page+1)} className="rounded border border-white/20 px-3 py-2 disabled:opacity-30">Next</button></div>

 </>}

 </section>;

}



