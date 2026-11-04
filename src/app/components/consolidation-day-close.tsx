"use client";

import { useEffect, useState } from "react";

type Metric = {
  box_tf: string; config: string; model: string; target: string; policy: string; side: string;
  period: string; regime: string; entries: number; scored: number; gross_positive: number; gross_win_pct: number | null;
  net_win_pct: number | null; avg_r: number | null; avg_net_r: number | null; total_net_r: number;
  close_known_at_entry: number; closed_before_day_close: number;
};
type Example = {
  sym: string; box_tf: string; config: string; model: string; target: string; policy: string; side: string;
  raid_day: string; box_hi: number; box_lo: number; day_close: number; entry_at: number;
  day_close_known_at: number; close_known_at_entry: boolean; outcome: string; r: number | null;
};
type Report = {
  asof: string; symbols: string[]; unique_entry_events: number; variants: number;
  metrics: Metric[]; examples: Example[]; sources: { fingerprint_matches: boolean }[];
};

const MODELS = [
  ["RAID_FADE", "First 5m raid → fade"], ["CLOSE_BREAK_FADE", "5m close beyond edge → fade"],
  ["RECLAIM_FADE", "5m reclaim → fade"], ["MSS5_MARKET", "5m MSS → next open"],
  ["MSS15_MARKET", "15m MSS → next open"], ["MSS5_FVG_CE", "5m MSS → FVG midpoint"],
  ["PREARMED_EDGE_TOUCH", "Resting edge touch"], ["PREARMED_RAID_10PCT", "Resting 10% beyond edge"],
];
const REGIMES = [
  ["ALL", "Baseline · all closes"], ["PRESSURE_CONTINUES", "Close against the fade"],
  ["INSIDE_RANGE", "Close inside range"], ["THROUGH_OPPOSITE_EDGE", "Close through opposite edge"],
  ["AT_EDGE", "Close at an edge"], ["UNVERIFIED_DAY", "Daily evidence unavailable"],
];
const num = (value: number | null | undefined, suffix = "") => value == null ? "–" : `${value.toFixed(2)}${suffix}`;
const time = (value: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(value);

export default function ConsolidationDayClose({ timeframe, config }: { timeframe: string; config: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [model, setModel] = useState("RAID_FADE");
  const [target, setTarget] = useState("2R");
  const [policy, setPolicy] = useState("CLOSE5");
  const [side, setSide] = useState("ALL");
  const [period, setPeriod] = useState("ALL");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/reports/consolidation-day-close.json", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Daily-close analysis is unavailable. Run scripts/consolidation/analyze_daily_close.py.");
        return response.json() as Promise<Report>;
      })
      .then(setReport)
      .catch((reason: unknown) => { if (!(reason instanceof Error && reason.name === "AbortError")) setError(String(reason)); });
    return () => controller.abort();
  }, []);

  const rows = report?.metrics.filter((row) => row.box_tf === timeframe && row.config === config && row.model === model && row.target === target && row.policy === policy && row.side === side && row.period === period) ?? [];
  const pressure = rows.find((row) => row.regime === "PRESSURE_CONTINUES");
  const inside = rows.find((row) => row.regime === "INSIDE_RANGE");
  const baseline = rows.find((row) => row.regime === "ALL");
  const examples = report?.examples.filter((row) => row.box_tf === timeframe && row.config === config && row.model === model && row.target === target && row.policy === policy && (side === "ALL" || row.side === side) && (period === "ALL" || new Date(row.entry_at).getUTCFullYear() >= 2022)).sort((a, b) => b.entry_at - a.entry_at).slice(0, 6) ?? [];
  const selectClass = "rounded border border-white/15 bg-[#101620] px-2 py-1 text-xs text-[#d6deec]";

  return <section className="rounded-md border border-white/10 bg-[#101620]" aria-label="Breakout-day Daily close analysis">
    <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3">
      <h2 className="text-sm font-semibold">Does the breakout-day Daily close contradict the fade?</h2>
      <a className="ml-auto text-xs text-[#8edfff] underline" href="/reports/consolidation-day-close-events.csv.gz" download>Download candle evidence</a>
    </div>
    <div className="space-y-3 p-4 text-xs text-[#a9b5c9]">
      <p>SELL: the high is taken, then the Daily close finishes above the frozen consolidation high. BUY: the low is taken, then the Daily close finishes below the frozen consolidation low. These closes show pressure continuing against the reversal. A raid alone does not establish a reversal.</p>
      <p className="rounded border border-[#d9a441]/30 bg-[#d9a441]/10 p-2 text-[#f2c873]">The Daily close is known only at the official session close. Earlier entries use it as a retrospective diagnostic. It cannot invalidate an earlier setup at entry or erase a trade that already won. Waiting for the close changes entry timing and has not been backtested here.</p>
      <p>This panel follows the selected range timeframe ({timeframe}) and compression ({config}). It uses the separately audited raw 5m research ledger; its model, target, exit policy and side controls are independent of the legacy tables below. Symbol, fate and HTF-bias filters above do not apply here.</p>
      <div className="flex flex-wrap gap-3">
        <label className="space-x-2">Entry model<select aria-label="Daily-close entry model" className={selectClass} value={model} onChange={(event) => setModel(event.target.value)}>{MODELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="space-x-2">Target<select aria-label="Daily-close target" className={selectClass} value={target} onChange={(event) => setTarget(event.target.value)}><option value="2R">2R</option><option value="CE">Equilibrium</option><option value="OPPOSITE">Opposite edge</option></select></label>
        <label className="space-x-2">Exit policy<select aria-label="Daily-close exit policy" className={selectClass} value={policy} onChange={(event) => setPolicy(event.target.value)}><option value="CLOSE5">5m close SL / wick TP</option><option value="HARD5">5m wick SL / wick TP</option></select></label>
        <label className="space-x-2">Side<select aria-label="Daily-close side" className={selectClass} value={side} onChange={(event) => setSide(event.target.value)}><option value="ALL">Both sides</option><option value="SELL">SELL · high taken</option><option value="BUY">BUY · low taken</option></select></label>
        <label className="space-x-2">Period<select aria-label="Daily-close period" className={selectClass} value={period} onChange={(event) => setPeriod(event.target.value)}><option value="ALL">2017 onward</option><option value="2022_PLUS">2022 onward</option></select></label>
      </div>
      {error ? <p role="alert" className="text-[#ff9da2]">{error}</p> : !report ? <p role="status">Loading candle analysis…</p> : <>
        <p>{report.symbols.length} symbols · {report.unique_entry_events.toLocaleString()} distinct model-entry events · frozen through {time(Date.parse(report.asof))} ET. {report.sources.filter((source) => source.fingerprint_matches).length}/{report.sources.length} raw source fingerprints match the audited ledger.</p>
        <div className="overflow-x-auto"><table className="w-full text-left text-xs">
          <thead className="border-b border-white/10 text-[#7f8ca3]"><tr>{["Daily close", "Entries", "Scored", "Positive R %", "Avg R", "Avg R at 5bps", "Close known at entry", "Already closed by Daily close"].map((label) => <th key={label} className="px-2 py-2 font-normal">{label}</th>)}</tr></thead>
          <tbody>{REGIMES.map(([regime, label]) => { const row = rows.find((value) => value.regime === regime); return <tr key={regime} className={`border-b border-white/5 ${regime === "PRESSURE_CONTINUES" ? "bg-[#e5484d]/10" : ""}`}><td className="px-2 py-2">{label}</td><td className="px-2 py-2">{row?.entries.toLocaleString() ?? "0"}</td><td className="px-2 py-2">{row?.scored.toLocaleString() ?? "0"}</td><td className="px-2 py-2">{num(row?.gross_win_pct, "%")}</td><td className="px-2 py-2">{num(row?.avg_r, "R")}</td><td className="px-2 py-2">{num(row?.avg_net_r, "R")}</td><td className="px-2 py-2">{row?.close_known_at_entry.toLocaleString() ?? "0"} / {row?.entries.toLocaleString() ?? "0"}</td><td className="px-2 py-2">{row?.closed_before_day_close.toLocaleString() ?? "0"} / {row?.scored.toLocaleString() ?? "0"}</td></tr>; })}</tbody>
        </table></div>
        {baseline && pressure?.scored && inside?.scored ? <p>In this selection, continuing-pressure closes average <strong>{num(pressure.avg_r, "R")}</strong>, compared with <strong>{num(inside.avg_r, "R")}</strong> for inside-range closes. {pressure.gross_positive} of {pressure.scored} scored continuing-pressure trades still finished with positive R. This is an association, not a tested entry filter.</p> : <p>No scored comparison is available for this selection.</p>}
        <p>R is before costs; 5bps is a round-trip sensitivity. Unknown or incomplete Daily evidence is excluded from scored comparisons. Target and stop variants overlap and are not independent portfolio trades. The 2022+ split is historical research.</p>
        {examples.length ? <details><summary className="cursor-pointer text-[#8edfff]">Recent continuing-pressure examples · 2R / 5m close stop</summary><div className="overflow-x-auto"><table className="mt-2 w-full text-left"><thead><tr>{["Symbol / side", "Raid day", "Box low / high", "Daily close", "Entry ET", "Daily close known ET", "Outcome / R"].map((label) => <th key={label} className="px-2 py-2 font-normal">{label}</th>)}</tr></thead><tbody>{examples.map((row) => <tr key={`${row.sym}-${row.entry_at}-${row.model}`}><td className="px-2 py-1">{row.sym} {row.side}</td><td className="px-2 py-1">{row.raid_day}</td><td className="px-2 py-1">{num(row.box_lo)} / {num(row.box_hi)}</td><td className="px-2 py-1">{num(row.day_close)}</td><td className="px-2 py-1">{time(row.entry_at)}</td><td className="px-2 py-1">{time(row.day_close_known_at)} · {row.close_known_at_entry ? "known at entry" : "after decision"}</td><td className="px-2 py-1">{row.outcome} / {num(row.r, "R")}</td></tr>)}</tbody></table></div></details> : null}
      </>}
    </div>
  </section>;
}
