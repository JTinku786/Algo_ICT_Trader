"use client";

import { Database, Scale, ShieldAlert, Target, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Snapshot = {
  metricVersion: string;
  identityDefinition: string;
  calculatedAt: string;
  sourceRowCount: number;
  uniqueSetups: number;
  fullyResolved: number;
  missedEntries: number;
  openOrders: number;
  status: string;
  sourceHash: string;
  metadata: { cost_model?: string; replacement_model_status?: string };
};

type Metric = {
  metricGroup: string;
  metricKey: string;
  period: string;
  target: string | null;
  status: string | null;
  n: number | null;
  wins: number | null;
  hitRate: number | null;
  medianPlannedWinR: number | null;
  plannedExpectancyR: number | null;
  fillAdjustedExpectancyR: number | null;
  net10BpsR: number | null;
  positivePayoffRate: number | null;
  payoffStdR: number | null;
};

type Payload = {
  ok: boolean;
  error?: string;
  snapshot: Snapshot;
  targets: Metric[];
  candidates: Metric[];
  scaleouts: Metric[];
};

const PERIOD_LABELS: Record<string, string> = {
  development_2017_2022: "Development 2017-22",
  validation_2023_2024: "Validation 2023-24",
  pseudo_holdout_2025_2026: "Pseudo-holdout 2025-26",
};

const CANDIDATE_LABELS: Record<string, string> = {
  buy_ob_or_overlap_tp2: "BUY + OB/overlap to TP2",
  ob_or_overlap_tp2: "OB/overlap to TP2",
  ob_or_overlap_tp2_2_50_to_3_00r: "OB/overlap TP2 at 2.5-3R",
  ob_or_overlap_tp2_2_00_to_2_25r: "OB/overlap TP2 at 2-2.25R",
  all_s16_tp3_5_00_to_6_00r: "S16 TP3 runner at 5-6R",
  buy_ob_or_overlap_tp3_5_00_to_6_00r: "BUY + OB/overlap TP3 at 5-6R",
};

const CANDIDATE_ORDER = Object.keys(CANDIDATE_LABELS);
const pct = (value: number | null) => value == null ? "-" : `${(value * 100).toFixed(2)}%`;
const r = (value: number | null) => value == null ? "-" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}R`;

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="border-l border-white/10 pl-3">
      <div className="text-[10px] font-semibold uppercase text-[#7f8ca3]">{label}</div>
      <div className="mt-1 font-mono text-xl font-bold text-white">{value}</div>
      <div className="mt-0.5 text-[11px] text-[#8a97ab]">{sub}</div>
    </div>
  );
}

export function S16StructuralPanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/s16-structural-metrics")
      .then((response) => response.json())
      .then((payload: Payload) => {
        if (cancelled) return;
        if (!payload.ok) throw new Error(payload.error || "S16 structural metrics unavailable");
        setData(payload);
      })
      .catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, []);

  const primaryTemporal = useMemo(
    () => data?.candidates.filter((row) => row.metricKey === "buy_ob_or_overlap_tp2" && row.period !== "overall") ?? [],
    [data],
  );

  if (error) {
    return (
      <section className="border-y border-rose-300/20 bg-rose-500/[0.04] px-5 py-4 text-xs text-rose-200">
        S16 structural snapshot unavailable: {error}
      </section>
    );
  }
  if (!data) {
    return <section className="border-y border-white/10 px-5 py-4 text-xs text-[#8a97ab]">Loading canonical S16 structural metrics...</section>;
  }

  const targets = data.targets.filter((row) => row.period === "overall").sort((a, b) => (a.target || "").localeCompare(b.target || ""));
  const candidates = data.candidates
    .filter((row) => row.period === "overall" && CANDIDATE_ORDER.includes(row.metricKey))
    .sort((a, b) => CANDIDATE_ORDER.indexOf(a.metricKey) - CANDIDATE_ORDER.indexOf(b.metricKey));
  const snapshot = data.snapshot;

  return (
    <section className="border-y border-emerald-300/20 bg-[#0d1716] px-5 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-white"><TrendingUp className="size-4 text-emerald-300" />S16 canonical structural research</div>
          <p className="mt-1 max-w-4xl text-xs leading-relaxed text-[#9fb0ad]">
            Corrected setup identity across pool, sweep, MSS, PD-array, retest and entry price. This is strategy evidence, not replacement model performance or a live order gate.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase text-amber-200"><ShieldAlert className="size-4" />Research only</div>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Unique setups" value={snapshot.uniqueSetups.toLocaleString()} sub={`${snapshot.sourceRowCount.toLocaleString()} persisted rows`} />
        <Kpi label="Fully closed" value={snapshot.fullyResolved.toLocaleString()} sub="target outcomes resolved" />
        <Kpi label="Missed entries" value={snapshot.missedEntries.toLocaleString()} sub={`${((snapshot.missedEntries / snapshot.uniqueSetups) * 100).toFixed(2)}% of setups`} />
        <Kpi label="Open" value={snapshot.openOrders.toLocaleString()} sub="not used for final TP3" />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <div className="overflow-x-auto">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase text-[#8fa19d]"><Target className="size-4 text-emerald-300" />Target economics</div>
          <table className="min-w-[620px] w-full text-left text-xs">
            <thead className="text-[10px] uppercase text-[#71817e]"><tr><th className="py-2">Target</th><th>N</th><th>Hit</th><th className="whitespace-nowrap">Median win</th><th className="whitespace-nowrap">Fill gross</th><th className="whitespace-nowrap">10 bps</th></tr></thead>
            <tbody>
              {targets.map((row) => (
                <tr key={row.metricKey} className="border-t border-white/5">
                  <td className="py-2 font-mono font-bold text-white">{row.target}</td>
                  <td className="font-mono text-[#aebbb8]">{row.n?.toLocaleString()}</td>
                  <td className="font-mono text-emerald-200">{pct(row.hitRate)}</td>
                  <td className="font-mono text-[#cbd5d1]">{row.medianPlannedWinR?.toFixed(2)}R</td>
                  <td className="font-mono text-emerald-200">{r(row.fillAdjustedExpectancyR)}</td>
                  <td className="font-mono text-amber-200">{r(row.net10BpsR)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="overflow-x-auto">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase text-[#8fa19d]"><Scale className="size-4 text-cyan-300" />Structural candidates</div>
          <table className="min-w-[600px] w-full text-left text-xs">
            <thead className="text-[10px] uppercase text-[#71817e]"><tr><th className="w-[46%] py-2">Order structure</th><th>N</th><th>Hit</th><th className="whitespace-nowrap">Win R</th><th className="whitespace-nowrap">10 bps</th></tr></thead>
            <tbody>
              {candidates.map((row) => (
                <tr key={row.metricKey} className="border-t border-white/5">
                  <td className="py-2 pr-3 text-[#d7e0dd]">{CANDIDATE_LABELS[row.metricKey]}</td>
                  <td className="font-mono text-[#aebbb8]">{row.n?.toLocaleString()}</td>
                  <td className="font-mono text-emerald-200">{pct(row.hitRate)}</td>
                  <td className="font-mono text-[#cbd5d1]">{row.medianPlannedWinR?.toFixed(2)}R</td>
                  <td className="font-mono text-amber-200">{r(row.net10BpsR)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-5 overflow-x-auto border-t border-white/10 pt-4">
        <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase text-[#8fa19d]"><Database className="size-4 text-blue-300" />Primary candidate through time</div>
        <table className="min-w-[560px] w-full max-w-3xl text-left text-xs">
          <thead className="text-[10px] uppercase text-[#71817e]"><tr><th className="w-[38%] py-2">Period</th><th>N</th><th className="whitespace-nowrap">TP2 hit</th><th className="whitespace-nowrap">Fill gross</th><th className="whitespace-nowrap">10 bps</th></tr></thead>
          <tbody>
            {primaryTemporal.sort((a, b) => Object.keys(PERIOD_LABELS).indexOf(a.period) - Object.keys(PERIOD_LABELS).indexOf(b.period)).map((row) => (
              <tr key={row.period} className="border-t border-white/5">
                <td className="py-2 text-[#d7e0dd]">{PERIOD_LABELS[row.period]}</td>
                <td className="font-mono text-[#aebbb8]">{row.n?.toLocaleString()}</td>
                <td className="font-mono text-emerald-200">{pct(row.hitRate)}</td>
                <td className="font-mono text-emerald-200">{r(row.fillAdjustedExpectancyR)}</td>
                <td className="font-mono text-amber-200">{r(row.net10BpsR)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3 text-[10px] text-[#71817e]">
        <span>10 bps is an underlying-price sensitivity, not an option-fill cost model.</span>
        <span className="font-mono">{snapshot.metricVersion} | {snapshot.sourceHash.slice(0, 12)}</span>
      </div>
    </section>
  );
}
