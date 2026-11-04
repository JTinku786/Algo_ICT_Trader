import { ArrowDown, CheckCircle2, ShieldAlert } from "lucide-react";

const panel = "rounded-2xl border border-white/10 bg-[#101722] p-6";
export function ReversalWalkthrough() {
  const steps = [
    ["Prior range", "20 / 40 / 60 completed bars of the chosen timeframe; the current bar is excluded."],
    ["Sweep & reclaim", "A wick closes inside the range, or a body breakout reclaims it within three bars. This establishes price behavior, not participant intent."],
    ["Confirm structure", "A completed close crosses the relevant internal pivot. k1 uses a one-bar fractal with right-hand confirmation; MSS has a ten-bar window."],
    ["Plan the retracement", "OTE62 is a 62% retracement of the reclaim-to-MSS leg. Stop reference is the accumulated sweep extreme. The limit window is ten native bars."],
    ["Separate execution contracts", "Paper reconstructs an OTE limit. OANDA practice sends a later market order. A projected 2R target does not guarantee 2R from that market fill."],
    ["Measure the actual exit", "M5_CLOSE_SL_WICK_TP_V1: target touch, otherwise a strict 5m close beyond stop; no timeout. Losses can exceed the planned risk distance."],
  ];
  return <section className={panel}><p className="text-xs uppercase tracking-widest text-amber-200">Bird’s-eye view</p><h2 className="mt-2 text-xl font-semibold text-white">From failed breakout to recorded outcome</h2><div className="mx-auto mt-6 max-w-3xl">{steps.map(([title, text], i) => <div key={title}><div className="flex gap-4 rounded-xl border border-white/10 p-4"><span className="font-mono text-lg text-amber-200/70">0{i + 1}</span><div><h3 className="text-sm font-semibold text-white">{title}</h3><p className="mt-1 text-sm leading-6 text-slate-400">{text}</p></div></div>{i < steps.length - 1 && <ArrowDown size={18} className="mx-auto my-2 text-slate-600" />}</div>)}</div><p className="mt-6 text-sm leading-6 text-slate-400">FVG, order-block and higher-timeframe annotations are context unless the contract makes them gates. The 2R target is a synthetic projection. This exact rule combination is a local adaptation.</p></section>;
}

export function ReversalValidation() {
  const checks = [
    ["Established · recorded policy", "The effective exit rule is exposed from persisted evidence. Legacy hard cohort labels do not establish hard-stop behavior."],
    ["Open · opportunity completeness", "A parallel corrected detector now retains entry-and-stop-touch candidates, and its replay checks the fill candle’s closing stop. Stored historical cohorts have not yet been regenerated; the full omitted population and five-minute chronology still require reconciliation."],
    ["Open · first discovery", "Candle completion is not wall-clock first detection. Do not infer scanner latency from observed_at alone."],
    ["Open · economic validation", "Gross R excludes a reconstructed spread, commission and financing model. A cost sensitivity assumption cannot certify net profitability."],
    ["Open · risk enforcement", "A declared leverage cap does not prove an enforced account-wide limit. Check deployed gates, existing positions and pending exposure."],
    ["Open · paired exit study", "Compare hard-stop and close-stop policies on identical entries. Overnight holding is an explicit exposure policy; size for gaps."],
  ];
  return <div className="space-y-5"><section className={panel}><h2 className="text-xl font-semibold text-white">Evidence before promotion</h2><div className="mt-5 grid gap-4 md:grid-cols-2">{checks.map(([title,text],i) => <div key={title} className="rounded-xl border border-white/10 p-4"><h3 className={`flex items-center gap-2 text-sm font-semibold ${i ? "text-amber-200" : "text-emerald-300"}`}>{i ? <ShieldAlert size={15} /> : <CheckCircle2 size={15} />}{title}</h3><p className="mt-2 text-sm leading-6 text-slate-400">{text}</p></div>)}</div></section><section className={`${panel} overflow-x-auto`}><h2 className="mb-4 text-lg font-semibold text-white">Execution contracts</h2><table className="w-full min-w-[650px] text-left text-sm"><thead className="text-slate-500"><tr><th className="pb-3">Property</th><th>Historical / paper</th><th>OANDA practice adapter</th></tr></thead><tbody className="divide-y divide-white/10 text-slate-300">{[
    ["Entry", "OTE62 reconstructed limit", "Market at the later quote"],
    ["Target", "Synthetic 2R from planned entry", "Existing target; quote R:R floor 0.786"],
    ["Strategy stop", "Completed 5m close beyond level", "Observed 5m breach → market close request"],
    ["Disaster protection", "Not in the shared paper exit policy", "Ordinary broker stop, extra risk distance beyond stop"],
    ["Holding", "No timeout; overnight exposure allowed", "No guaranteed gap-loss bound"],
    ["Results", "Research / reconstructed outcomes", "Practice records; not real-money performance"],
  ].map(([a,b,c]) => <tr key={a}><th className="py-3 pr-4 font-medium text-slate-400">{a}</th><td className="pr-5">{b}</td><td>{c}</td></tr>)}</tbody></table><p className="mt-4 text-xs leading-5 text-slate-500">Adapter settings describe inspected October 16 code, not a live configuration service. Earlier decisions may use different filters. No trading settings are changed by this workspace.</p></section><section className={panel}><h2 className="font-semibold text-white">Myth versus fact</h2><dl className="mt-4 space-y-4 text-sm">{[
    ["A sweep proves who traded.", "OHLC shows a breach and reclaim; participant intent is unknown."],
    ["2R means the maximum loss is 1R.", "2R describes the target projection. Close stops and gaps can produce larger losses."],
    ["More timeframes mean independent evidence.", "One market move can generate correlated daily, hourly and 30m setups."],
    ["Positive historical R proves a live edge.", "Completeness, costs, selection bias and actual execution still need validation."],
  ].map(([myth,fact]) => <div key={myth}><dt className="text-slate-500">Myth · {myth}</dt><dd className="mt-1 text-slate-200">Fact · {fact}</dd></div>)}</dl></section></div>;
}
