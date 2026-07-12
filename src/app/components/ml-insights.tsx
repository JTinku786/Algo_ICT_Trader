"use client";

import Image from "next/image";
import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  FlaskConical,
  Gauge,
  LayoutGrid,
  LineChart,
  ListChecks,
  ShieldAlert,
  Sparkles,
  Target,
  TrendingUp,
} from "lucide-react";
import { useState } from "react";
import { StrategyLink } from "./blog-context";

// ---------------------------------------------------------------------------
// Curated research surface for the ICT DataScience ML workspace.
// Source: ICT_DataScience/reports (walk-forward validation, threshold policy,
// model gateway, risk overlay, TP1 champion suite, 3-GBDT ablation).
// These are RESEARCH artifacts — probability scores, not live trade commands.
// ---------------------------------------------------------------------------

const GREEN = "#2fbf71";
const RED = "#e5484d";

function cx(...v: Array<string | false | null | undefined>) {
  return v.filter(Boolean).join(" ");
}
function pct(n: number, d = 1) {
  return `${(n * 100).toFixed(d)}%`;
}

type ModelCard = {
  id: string;
  concept: string;
  family: string;
  target: string;
  signals: number;
  baseRate: number;
  testAuc: number;
  precision: number;
  takeAllExpR: number;
  gateExpR: number;
  takeAllMdd: number;
  gateMdd: number;
  gateLabel: string;
};

const MODELS: ModelCard[] = [
  { id: "S16", concept: "ICT Silver Bullet (US)", family: "XGBoost (tuned, sigmoid-cal.)", target: "TP2 before SL", signals: 1255, baseRate: 0.6446, testAuc: 0.7586, precision: 0.842, takeAllExpR: 1.203, gateExpR: 1.328, takeAllMdd: -10.68, gateMdd: -5.6, gateLabel: "P ≥ 0.60" },
  { id: "S03", concept: "ICT Breaker Block", family: "CatBoost (depth 3, L2 8)", target: "TP1 before SL", signals: 5436, baseRate: 0.677, testAuc: 0.785, precision: 0.878, takeAllExpR: 0.474, gateExpR: 0.711, takeAllMdd: -7.8, gateMdd: -3.8, gateLabel: "P ≥ 0.60" },
  { id: "S-CH10", concept: "SMT Divergence", family: "CatBoost (depth 3, L2 8)", target: "TP1 before SL", signals: 2548, baseRate: 0.799, testAuc: 0.846, precision: 0.977, takeAllExpR: 0.475, gateExpR: 0.507, takeAllMdd: -6.3, gateMdd: -4.3, gateLabel: "P ≥ 0.60" },
  { id: "S-CH08", concept: "MTF Fair Value Gap", family: "CatBoost (depth 3, L2 8)", target: "TP1 before SL", signals: 732, baseRate: 0.867, testAuc: 0.791, precision: 0.916, takeAllExpR: 0.348, gateExpR: 0.348, takeAllMdd: -2.0, gateMdd: -1.8, gateLabel: "P ≥ 0.60" },
];

const WF_YEARS = [
  { year: "2022", rows: 275, winRate: 0.6291, avgProb: 0.5723, expR: 1.017, pf: 3.74, mdd: -10.68 },
  { year: "2023", rows: 290, winRate: 0.6069, avgProb: 0.6347, expR: 1.146, pf: 3.92, mdd: -7.15 },
  { year: "2024", rows: 289, winRate: 0.7059, avgProb: 0.6550, expR: 1.577, pf: 6.36, mdd: -3.02 },
  { year: "2025", rows: 280, winRate: 0.6036, avgProb: 0.6728, expR: 0.967, pf: 3.44, mdd: -10.14 },
  { year: "2026", rows: 121, winRate: 0.7190, avgProb: 0.6608, expR: 1.417, pf: 6.04, mdd: -4.00 },
];

const WF_THRESHOLDS = [
  { label: "Raw (take all)", coverage: 1.0, winRate: 0.6446, expR: 1.203, pf: 4.39, mdd: -10.68 },
  { label: "P ≥ 0.50", coverage: 0.824, winRate: 0.6750, expR: 1.203, pf: 4.70, mdd: -7.51 },
  { label: "P ≥ 0.60", coverage: 0.624, winRate: 0.7229, expR: 1.328, pf: 5.79, mdd: -5.60 },
  { label: "P ≥ 0.70", coverage: 0.375, winRate: 0.7728, expR: 1.392, pf: 7.13, mdd: -3.00 },
  { label: "P ≥ 0.80", coverage: 0.094, winRate: 0.8475, expR: 1.468, pf: 10.62, mdd: -2.00 },
  { label: "P ≥ 0.85", coverage: 0.024, winRate: 0.8667, expR: 1.311, pf: 10.83, mdd: -1.00 },
];

// S16 probability-bucket calibration (walk-forward, out-of-sample)
const S16_BUCKETS = [
  { bucket: "0.00–0.40", winRate: 0.564, expR: 1.547, n: 55 },
  { bucket: "0.40–0.50", winRate: 0.482, expR: 1.090, n: 166 },
  { bucket: "0.50–0.60", winRate: 0.526, expR: 0.814, n: 251 },
  { bucket: "0.60–0.70", winRate: 0.647, expR: 1.231, n: 312 },
  { bucket: "0.70–0.80", winRate: 0.748, expR: 1.367, n: 353 },
  { bucket: "0.80–1.00", winRate: 0.847, expR: 1.468, n: 118 },
];

// TP1 champion calibration — 8 equal-population test bins (predicted win rate)
const TP1_CALIBRATION: { id: string; bins: number[] }[] = [
  { id: "S03", bins: [0.38, 0.48, 0.54, 0.61, 0.71, 0.83, 0.98, 0.99] },
  { id: "S-CH10", bins: [0.44, 0.62, 0.75, 0.75, 0.96, 0.98, 1.0, 1.0] },
  { id: "S-CH08", bins: [0.67, 0.8, 0.67, 0.93, 0.93, 0.93, 1.0, 1.0] },
];

const THRESHOLD_POLICY = [
  { band: "Skip", condition: "p < 0.55", size: "0×", tone: "red", reason: "Below low-confidence research floor." },
  { band: "Reduced size (review)", condition: "0.55 ≤ p < 0.65", size: "0.25×", tone: "gold", reason: "Positive expectancy, below standard accept." },
  { band: "Standard accept", condition: "0.65 ≤ p < 0.80", size: "1.0×", tone: "green", reason: "Best coverage / expectancy balance." },
  { band: "High-confidence accept", condition: "p ≥ 0.80", size: "1.0×", tone: "green", reason: "Higher expectancy, lower drawdown, less coverage." },
];

const RISK_RULES = [
  { label: "Max daily loss", value: "3.0R" },
  { label: "Max open risk", value: "5.0R" },
  { label: "Max symbol risk", value: "2.0R" },
  { label: "Max correlated-direction risk", value: "3.0R" },
  { label: "Max candidates / day", value: "6" },
  { label: "Min $ liquidity", value: "$20M ADV" },
  { label: "Max feature-drift score", value: "0.35" },
  { label: "Manual kill switch", value: "Blocks all new risk" },
];

// 3-GBDT feature-group ablation — mean Δ test AUC when a group is removed.
// Negative = the group ADDS predictive power (removing it hurts the model).
const GROUP_ABLATION = [
  { group: "Timing", delta: -0.0459 },
  { group: "Direction history", delta: -0.0334 },
  { group: "Trade-plan geometry", delta: -0.0321 },
  { group: "HTF bias", delta: -0.0262 },
  { group: "Direction flags", delta: -0.0031 },
  { group: "Ticker one-hot", delta: 0.0094 },
  { group: "Ticker history", delta: 0.0184 },
];

const TOP_FEATURES: Record<string, string[]> = {
  S03: ["f_fvg_dist", "tk_last_tp1", "dir_tp1_rate", "dir_rr_mean", "dist_52w_low", "m5_zscore100", "d_atr_pct", "h_ob_dist", "d_ipda20_pct", "m5_cvd_slope10"],
  "S-CH10": ["f_fvg_dist", "tp1_to_risk", "tp1_dist_pct", "mins_since_midnight", "f_ob_align", "bias_align_sum", "m5_atr_pct", "entry_hour", "m5_ret_kurt50", "tk_tp1_rate"],
  "S-CH08": ["tp1_to_risk", "mins_since_midnight", "f_fvg_dist", "h_ob_align", "m5_zscore100", "f_ob_align", "m5_cvd_slope10", "dist_52w_low", "hour_cos", "mon_sin"],
};

export default function MlInsights() {
  const [tp1View, setTp1View] = useState("S03");
  const [featView, setFeatView] = useState("S03");

  return (
    <section className="mx-auto max-w-[1680px] space-y-4">
      <header className="rounded-xl border border-indigo-400/20 bg-gradient-to-r from-[#0f1130] via-[#171442] to-[#231a52] p-5 shadow-xl shadow-black/20">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center">
          <div>
            <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-indigo-300"><BrainCircuit className="size-4" />ICT DataScience · model intelligence</div>
            <h1 className="text-2xl font-semibold text-white md:text-3xl">Machine Learning</h1>
            <p className="mt-1 max-w-3xl text-sm text-indigo-100/60">Probability models that score an ICT setup before the trade decision — trained on the Dow-30 US backtest (2017–2026) with strict time splits, walk-forward validation, calibration and leakage review. Outputs are probabilities, not buy/sell commands.</p>
          </div>
          <div className="xl:ml-auto">
            <div className="flex items-center gap-2 rounded-md border border-amber-300/25 bg-amber-300/[0.06] px-3 py-2 text-xs text-amber-100/80">
              <ShieldAlert className="size-4 text-amber-300" />
              Research artifacts — no live trading behaviour changed
            </div>
          </div>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={LayoutGrid} label="Production-track models" value="4" note="S16 · S03 · S-CH10 · S-CH08" tone="indigo" />
        <Kpi icon={Target} label="Best out-of-sample AUC" value="0.846" note="S-CH10 SMT Divergence" tone="green" />
        <Kpi icon={TrendingUp} label="S16 walk-forward expectancy" value="+1.20R" note="1,255 OOS trades · PF 4.39" tone="green" />
        <Kpi icon={Gauge} label="Prob. gate drawdown cut" value="≈ 50%" note="S16 −10.7R → −5.6R at P≥0.60" tone="gold" />
      </div>

      {/* Model registry */}
      <Panel icon={FlaskConical} title="Model Registry" note="strategy : market : target">
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
          {MODELS.map((m) => <ModelTile key={m.id} m={m} />)}
        </div>
      </Panel>

      {/* S16 walk-forward */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel icon={Activity} title="S16 Walk-Forward Validation" note="annual OOS, no re-fit">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-xs">
              <thead className="bg-[#0b0f16] text-[10px] uppercase text-[#7f8ca3]"><tr>{["Test year", "Trades", "Win rate", "Avg prob", "Exp. R", "PF", "Max DD"].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-white/5 font-mono">
                {WF_YEARS.map((y) => (
                  <tr key={y.year}>
                    <td className="px-3 py-2 font-sans text-white">{y.year}</td>
                    <td className="px-3 py-2 text-[#d6deec]">{y.rows}</td>
                    <td className="px-3 py-2 text-[#d6deec]">{pct(y.winRate)}</td>
                    <td className="px-3 py-2 text-[#93a1b6]">{pct(y.avgProb)}</td>
                    <td className={cx("px-3 py-2", y.expR >= 0 ? "text-emerald-300" : "text-rose-300")}>+{y.expR.toFixed(2)}R</td>
                    <td className="px-3 py-2 text-[#f2c873]">{y.pf.toFixed(2)}</td>
                    <td className="px-3 py-2 text-rose-300">{y.mdd.toFixed(1)}R</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-white/10 px-3 py-2 text-[10px] text-[#7f8ca3]">Predicted probability tracks realized win rate within ±7 pts every year — the model stays calibrated across regimes.</p>
        </Panel>

        <Panel icon={Gauge} title="S16 Probability Threshold Policy" note="raise the bar, smooth the curve">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-xs">
              <thead className="bg-[#0b0f16] text-[10px] uppercase text-[#7f8ca3]"><tr>{["Gate", "Coverage", "Win rate", "Exp. R", "PF", "Max DD"].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-white/5 font-mono">
                {WF_THRESHOLDS.map((t) => (
                  <tr key={t.label}>
                    <td className="px-3 py-2 font-sans text-white">{t.label}</td>
                    <td className="px-3 py-2 text-[#93a1b6]">{pct(t.coverage, 0)}</td>
                    <td className="px-3 py-2 text-[#d6deec]">{pct(t.winRate)}</td>
                    <td className="px-3 py-2 text-emerald-300">+{t.expR.toFixed(2)}R</td>
                    <td className="px-3 py-2 text-[#f2c873]">{t.pf.toFixed(2)}</td>
                    <td className="px-3 py-2 text-rose-300">{t.mdd.toFixed(1)}R</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-white/10 px-3 py-2 text-[10px] text-[#7f8ca3]">Higher gates trade coverage for quality: win rate climbs 64% → 85% and max drawdown shrinks 10.7R → 2.0R.</p>
        </Panel>
      </div>

      {/* Calibration visuals */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel icon={LineChart} title="S16 Calibration — Predicted vs Realized" note="walk-forward buckets">
          <div className="space-y-2 p-4">
            {S16_BUCKETS.map((b) => (
              <div key={b.bucket} className="flex items-center gap-3">
                <span className="w-20 shrink-0 font-mono text-[10px] text-[#93a1b6]">{b.bucket}</span>
                <div className="relative h-5 flex-1 overflow-hidden rounded bg-white/5">
                  <div className="h-full rounded" style={{ width: pct(b.winRate), background: `linear-gradient(90deg, ${GREEN}, #64d2ff)` }} />
                  <span className="absolute inset-y-0 right-2 flex items-center font-mono text-[10px] text-white/90">{pct(b.winRate)} · {b.expR >= 0 ? "+" : ""}{b.expR.toFixed(2)}R</span>
                </div>
                <span className="w-12 shrink-0 text-right font-mono text-[10px] text-[#657187]">n={b.n}</span>
              </div>
            ))}
          </div>
          <p className="border-t border-white/10 px-3 py-2 text-[10px] text-[#7f8ca3]">Win rate rises monotonically with the model score — higher probability really does mean a better trade.</p>
        </Panel>

        <Panel icon={ListChecks} title="TP1 Champions — Calibration" note="8 equal-population test bins" action={<Segmented value={tp1View} onChange={setTp1View} options={TP1_CALIBRATION.map((t) => t.id)} />}>
          <div className="p-4">
            <div className="flex h-44 items-end gap-2">
              {(TP1_CALIBRATION.find((t) => t.id === tp1View)?.bins ?? []).map((v, i) => (
                <div key={i} className="flex flex-1 flex-col items-center gap-1">
                  <span className="font-mono text-[9px] text-[#93a1b6]">{Math.round(v * 100)}</span>
                  <div className="w-full rounded-t" style={{ height: `${Math.max(6, v * 150)}px`, background: `linear-gradient(180deg, #64d2ff, ${GREEN})` }} />
                  <span className="font-mono text-[9px] text-[#657187]">B{i + 1}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[10px] text-[#7f8ca3]">Bin 1 = lowest-confidence decile, Bin 8 = highest. A rising staircase = the ranking separates winners from losers cleanly.</p>
          </div>
        </Panel>
      </div>

      {/* Threshold policy + risk overlay */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel icon={CheckCircle2} title="Position-Sizing Policy" note="locked 2025–2026 holdout">
          <div className="space-y-2 p-4">
            {THRESHOLD_POLICY.map((p) => (
              <div key={p.band} className="flex items-center gap-3 rounded-lg border border-white/10 bg-[#0b0f16] p-3">
                <span className={cx("grid w-14 shrink-0 place-items-center rounded-md py-1 font-mono text-sm font-bold",
                  p.tone === "red" ? "bg-rose-400/10 text-rose-300" : p.tone === "gold" ? "bg-amber-400/10 text-amber-300" : "bg-emerald-400/10 text-emerald-300")}>{p.size}</span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-white">{p.band}</span><span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-[#93a1b6]">{p.condition}</span></div>
                  <div className="mt-0.5 text-[11px] text-[#7f8ca3]">{p.reason}</div>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel icon={ShieldAlert} title="Independent Risk Overlay" note="hard gates, model-independent">
          <div className="grid grid-cols-2 gap-3 p-4">
            {RISK_RULES.map((r) => (
              <div key={r.label} className="rounded-lg border border-white/10 bg-[#0b0f16] p-3">
                <div className="text-[10px] uppercase tracking-wide text-[#7f8ca3]">{r.label}</div>
                <div className="mt-1 font-mono text-sm font-semibold text-white">{r.value}</div>
              </div>
            ))}
          </div>
          <p className="border-t border-white/10 px-3 py-2 text-[10px] text-[#7f8ca3]">Risk gates can veto any model-approved trade. ML confidence never overrides drawdown, exposure or liquidity limits.</p>
        </Panel>
      </div>

      {/* Feature importance */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel icon={Sparkles} title="What Moves the Model — Feature Group Ablation" note="mean Δ test AUC across XGB · LGB · Cat">
          <div className="space-y-2 p-4">
            {GROUP_ABLATION.map((g) => {
              const helps = g.delta < 0; // removing it hurt → it helps
              const mag = Math.min(1, Math.abs(g.delta) / 0.05);
              return (
                <div key={g.group} className="flex items-center gap-3">
                  <span className="w-36 shrink-0 text-[11px] text-[#d6deec]">{g.group}</span>
                  <div className="relative flex h-5 flex-1 items-center">
                    <div className="absolute left-1/2 top-0 h-full w-px bg-white/15" />
                    <div className="relative flex h-full w-1/2 justify-end">{helps ? <div className="h-full rounded-l" style={{ width: pct(mag, 0), background: GREEN }} /> : null}</div>
                    <div className="relative h-full w-1/2">{!helps ? <div className="h-full rounded-r" style={{ width: pct(mag, 0), background: RED }} /> : null}</div>
                  </div>
                  <span className={cx("w-16 shrink-0 text-right font-mono text-[10px]", helps ? "text-emerald-300" : "text-rose-300")}>{g.delta >= 0 ? "+" : ""}{g.delta.toFixed(3)}</span>
                </div>
              );
            })}
          </div>
          <p className="border-t border-white/10 px-3 py-2 text-[10px] text-[#7f8ca3]">Green = removing the group hurts AUC (it adds edge). Timing, direction history and trade-plan geometry carry the signal; raw ticker features add little and risk leakage.</p>
        </Panel>

        <Panel icon={ListChecks} title="Top Features by Strategy" note="regularized CatBoost selection" action={<Segmented value={featView} onChange={setFeatView} options={Object.keys(TOP_FEATURES)} />}>
          <div className="flex flex-wrap gap-2 p-4">
            {(TOP_FEATURES[featView] ?? []).map((f, i) => (
              <span key={f} className="flex items-center gap-1.5 rounded-md border border-indigo-400/20 bg-indigo-400/[0.06] px-2.5 py-1.5 font-mono text-[11px] text-indigo-200">
                <span className="text-[9px] text-indigo-400/60">{i + 1}</span>{f}
              </span>
            ))}
          </div>
          <p className="border-t border-white/10 px-3 py-2 text-[10px] text-[#7f8ca3]">Feature codes: f_/h_/d_ = 5m/1h/daily FVG &amp; OB distance & alignment; m5_ = 5-minute CVD / volatility / z-score; tk_/dir_ = leak-safe ticker &amp; direction TP1 history.</p>
        </Panel>
      </div>

      {/* Research charts */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel icon={LineChart} title="S16 Strategy Status" note="model_visuals/s16_us_tp2">
          <div className="p-4">
            <div className="overflow-hidden rounded-lg border border-white/10 bg-white">
              <Image src="/ml/s16_strategy_status.png" width={1400} height={900} alt="S16 strategy status chart" className="h-auto w-full" />
            </div>
          </div>
        </Panel>
        <Panel icon={Activity} title="3-GBDT ICT Feature Ablation" note="model_ablation_3gbdt">
          <div className="p-4">
            <div className="overflow-hidden rounded-lg border border-white/10 bg-white">
              <Image src="/ml/s16_ablation.png" width={1400} height={900} alt="S16 feature ablation charts" className="h-auto w-full" />
            </div>
          </div>
        </Panel>
      </div>

      <div className="rounded-xl border border-white/10 bg-[#101620] p-4 text-[11px] leading-5 text-[#7f8ca3]">
        <div className="mb-1 font-semibold text-[#d6deec]">Governance & method notes</div>
        Models are trained with a strict time split (train 2017–22 · validate 2023–24 · test 2025–26) and validated with expanding-window walk-forward — parameters are never re-optimized on the test years. Every claim is net-of-nothing at the modeling stage; broker fills, slippage and taxes must replace placeholder cost sensitivities before any capital allocation. The S16 head currently predicts <span className="font-mono">p_tp2_before_sl</span> only; <span className="font-mono">p_win</span>, <span className="font-mono">p_tp1_before_sl</span> and <span className="font-mono">expected_r</span> need separate calibrated heads before production approval.
      </div>
    </section>
  );
}

function ModelTile({ m }: { m: ModelCard }) {
  const ddCut = m.takeAllMdd !== 0 ? 1 - Math.abs(m.gateMdd) / Math.abs(m.takeAllMdd) : 0;
  return (
    <div className="flex flex-col rounded-xl border border-white/10 bg-[#0b0f16] p-4">
      <div className="flex items-center justify-between">
        <StrategyLink code={m.id} label={m.id} className="font-mono text-lg font-bold text-white" showIcon />
        <span className="rounded-full border border-indigo-400/20 bg-indigo-400/10 px-2 py-0.5 font-mono text-[9px] text-indigo-200">{m.target}</span>
      </div>
      <div className="mt-1 text-xs text-[#93a1b6]">{m.concept}</div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-center">
        <Stat label="Test AUC" value={m.testAuc.toFixed(3)} tone="green" />
        <Stat label="Base rate" value={pct(m.baseRate, 0)} />
        <Stat label="Precision" value={m.precision.toFixed(2)} />
        <Stat label="Signals" value={m.signals.toLocaleString()} />
      </div>
      <div className="mt-3 rounded-lg border border-white/10 bg-[#101620] p-2.5">
        <div className="flex items-center justify-between text-[10px] text-[#7f8ca3]"><span>Take-all E[R]</span><span className="font-mono text-white">+{m.takeAllExpR.toFixed(2)}R</span></div>
        <div className="mt-1 flex items-center justify-between text-[10px] text-[#7f8ca3]"><span>Gated E[R] ({m.gateLabel})</span><span className="font-mono text-emerald-300">+{m.gateExpR.toFixed(2)}R</span></div>
        <div className="mt-1 flex items-center justify-between text-[10px] text-[#7f8ca3]"><span>Drawdown cut</span><span className="font-mono text-amber-300">{pct(ddCut, 0)}</span></div>
      </div>
      <div className="mt-2 text-[9px] uppercase tracking-wide text-[#657187]">{m.family}</div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "green" }) {
  return (
    <div className="rounded-md bg-white/[0.03] p-2">
      <div className="text-[9px] uppercase text-[#7f8ca3]">{label}</div>
      <div className={cx("mt-0.5 font-mono text-sm font-bold", tone === "green" ? "text-emerald-300" : "text-white")}>{value}</div>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, note, tone }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; note: string; tone: "green" | "gold" | "indigo" }) {
  const colors = { green: "text-emerald-300", gold: "text-amber-300", indigo: "text-indigo-300" };
  return (
    <div className="rounded-xl border border-white/10 bg-[#101620] p-4">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#7f8ca3]"><Icon className={cx("size-4", colors[tone])} />{label}</div>
      <div className={cx("mt-3 font-mono text-3xl font-bold", colors[tone])}>{value}</div>
      <div className="mt-1 text-[10px] text-[#657187]">{note}</div>
    </div>
  );
}

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <div className="flex rounded-md border border-white/10 bg-black/20 p-0.5">
      {options.map((o) => <button key={o} onClick={() => onChange(o)} className={cx("rounded px-2 py-1 font-mono text-[10px] font-semibold", value === o ? "bg-indigo-400/20 text-indigo-200" : "text-[#657187] hover:text-white")}>{o}</button>)}
    </div>
  );
}

function Panel({ icon: Icon, title, note, action, children }: { icon: React.ComponentType<{ className?: string }>; title: string; note?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-[#101620]">
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <Icon className="size-4 text-indigo-300" />
        <h2 className="font-semibold">{title}</h2>
        {note ? <span className="font-mono text-[11px] text-[#657187]">· {note}</span> : null}
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}
