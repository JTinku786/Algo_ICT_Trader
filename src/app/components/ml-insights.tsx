"use client";

import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  Database,
  Filter,
  Gauge,
  GitBranch,
  Layers,
  LineChart,
  ListChecks,
  Scale,
  ShieldAlert,
  Sparkles,
  Target,
  TrendingUp,
  Waypoints,
} from "lucide-react";
import { useEffect, useState } from "react";
import Image from "next/image";
import { StrategyLink } from "./blog-context";
import { S16StructuralPanel } from "./s16-structural-panel";

// ---------------------------------------------------------------------------
// ICT ML Risk Workbench — research + credit-risk analytics.
// The analytics view is LIVE: it queries /api/ml-insights over the scored order
// book (risk_probability + realised TP2 outcomes) filtered by source
// (backtest / realtime), market and ticker. Split + feature diagnostics are
// training artifacts computed offline. Probabilities are a pre-trade research
// score, not a live order command.
// ---------------------------------------------------------------------------

const GREEN = "#2fbf71";
const AMBER = "#e0a92b";
const RED = "#e5484d";
const BLUE = "#4c8dff";
const VIOLET = "#a78bfa";

function cx(...v: Array<string | false | null | undefined>) {
  return v.filter(Boolean).join(" ");
}
const pct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`;
const fp = (n: number | null | undefined, d = 1) => (n == null ? "—" : pct(n, d));

// ---- models -------------------------------------------------------------
type Model = {
  id: string;
  concept: string;
  family: string;
  target: string;
  scored: string;
  baseRate: number;
  testAuc: number;
  gini: number | null;
  ks: number | null;
  psi: number | null;
  features: number;
  status: "live" | "research";
  isNew?: boolean;
};

const MODELS: Model[] = [
  { id: "S03", concept: "ICT Breaker Block", family: "CatBoost · full-data TP2", target: "TP2 before SL", scored: "5,436 hist · 28 live", baseRate: 0.489, testAuc: 0.729, gini: 0.457, ks: 0.345, psi: 0.159, features: 19, status: "live", isNew: true },
  { id: "S16", concept: "ICT reversal · HTF→sweep→MSS (ICT-enhanced)", family: "CatBoost · ICT-enhanced 24 · 11 ICT feats", target: "TP2 before SL", scored: "2,682 hist · 16 live", baseRate: 0.636, testAuc: 0.788, gini: 0.577, ks: 0.439, psi: 0.069, features: 24, status: "live", isNew: true },
  { id: "S-CH10", concept: "SMT Divergence", family: "CatBoost · depth 3, L2 8", target: "TP1 before SL", scored: "research", baseRate: 0.799, testAuc: 0.846, gini: null, ks: null, psi: null, features: 24, status: "research" },
  { id: "S-CH08", concept: "MTF Fair Value Gap", family: "CatBoost · depth 3, L2 8", target: "TP1 before SL", scored: "research", baseRate: 0.867, testAuc: 0.791, gini: null, ks: null, psi: null, features: 22, status: "research" },
];

const SCORE_MODEL_OPTIONS = {
  S03: [
    { v: "incumbent", l: "Incumbent · TP2" },
    { v: "s03_catboost_v2_stable_tp1", l: "V2 Stable · TP1" },
    { v: "s03_catboost_v2_stable_tp2", l: "V2 Stable · TP2" },
  ],
  S16: [{ v: "incumbent", l: "Incumbent · TP2" }],
} as const;

const V2_MODELS: Record<string, Model> = {
  s03_catboost_v2_stable_tp1: { id: "S03 V2 Stable TP1", concept: "ICT Breaker Block · stable features", family: "CatBoost · three-seed raw ensemble", target: "TP1 before stop", scored: "905 research · 54 realtime", baseRate: 0.524, testAuc: 0.560, gini: 0.121, ks: 0.204, psi: null, features: 44, status: "research", isNew: true },
  s03_catboost_v2_stable_tp2: { id: "S03 V2 Stable TP2", concept: "ICT Breaker Block · stable features", family: "CatBoost · three-seed raw ensemble", target: "TP2 before stop", scored: "826 labeled research · 54 realtime", baseRate: 0.408, testAuc: 0.542, gini: 0.084, ks: 0.116, psi: null, features: 29, status: "research", isNew: true },
};

// ---- train / validation / test discrimination (offline, per model) -------
type Split = { n: number; base: number; auc: number; ks: number; gini: number; brier: number };
const SPLITS: Record<string, { train: Split; val: Split; test: Split }> = {
  S03: {
    train: { n: 3501, base: 0.49, auc: 0.81, ks: 0.469, gini: 0.619, brier: 0.182 },
    val: { n: 1144, base: 0.483, auc: 0.702, ks: 0.308, gini: 0.404, brier: 0.219 },
    test: { n: 789, base: 0.494, auc: 0.729, ks: 0.345, gini: 0.457, brier: 0.212 },
  },
  S16: {
    train: { n: 1699, base: 0.626, auc: 0.812, ks: 0.48, gini: 0.623, brier: 0.176 },
    val: { n: 578, base: 0.656, auc: 0.774, ks: 0.41, gini: 0.548, brier: 0.182 },
    test: { n: 398, base: 0.636, auc: 0.788, ks: 0.439, gini: 0.577, brier: 0.182 },
  },
  S03_V2_STABLE_TP1: {
    train: { n: 549, base: 0.474, auc: 0.790, ks: 0.429, gini: 0.580, brier: 0.230 },
    val: { n: 174, base: 0.477, auc: 0.680, ks: 0.297, gini: 0.360, brier: 0.236 },
    test: { n: 103, base: 0.524, auc: 0.560, ks: 0.204, gini: 0.121, brier: 0.244 },
  },
  S03_V2_STABLE_TP2: {
    train: { n: 549, base: 0.310, auc: 0.972, ks: 0.813, gini: 0.944, brier: 0.138 },
    val: { n: 174, base: 0.351, auc: 0.647, ks: 0.250, gini: 0.294, brier: 0.208 },
    test: { n: 103, base: 0.408, auc: 0.542, ks: 0.116, gini: 0.084, brier: 0.240 },
  },
};

// ---- fallback scorecard bands (used before the live fetch resolves) ------
type Band = { bin: number; n: number; avgProb: number | null; actual: number | null; expR: number | null };
const DECILES: Record<string, Band[]> = {
  S03: [
    { bin: 1, n: 544, avgProb: 0.2116, actual: 0.1213, expR: -0.599 },
    { bin: 2, n: 543, avgProb: 0.2609, actual: 0.2192, expR: -0.303 },
    { bin: 3, n: 543, avgProb: 0.2991, actual: 0.3076, expR: -0.023 },
    { bin: 4, n: 544, avgProb: 0.3469, actual: 0.3695, expR: 0.170 },
    { bin: 5, n: 543, avgProb: 0.4241, actual: 0.4475, expR: 0.408 },
    { bin: 6, n: 543, avgProb: 0.5112, actual: 0.4457, expR: 0.437 },
    { bin: 7, n: 544, avgProb: 0.5849, actual: 0.6085, expR: 0.927 },
    { bin: 8, n: 543, avgProb: 0.6557, actual: 0.6777, expR: 1.142 },
    { bin: 9, n: 543, avgProb: 0.7289, actual: 0.7864, expR: 1.462 },
    { bin: 10, n: 544, avgProb: 0.8289, actual: 0.9118, expR: 1.873 },
  ],
  S16: [
    { bin: 1, n: 269, avgProb: 0.2832, actual: 0.2565, expR: 0.252 },
    { bin: 2, n: 268, avgProb: 0.4114, actual: 0.4254, expR: 0.755 },
    { bin: 3, n: 268, avgProb: 0.4934, actual: 0.5149, expR: 0.967 },
    { bin: 4, n: 268, avgProb: 0.5624, actual: 0.5149, expR: 0.839 },
    { bin: 5, n: 268, avgProb: 0.6239, actual: 0.6381, expR: 1.227 },
    { bin: 6, n: 268, avgProb: 0.6803, actual: 0.6007, expR: 0.962 },
    { bin: 7, n: 268, avgProb: 0.7323, actual: 0.7351, expR: 1.382 },
    { bin: 8, n: 268, avgProb: 0.7775, actual: 0.8396, expR: 1.686 },
    { bin: 9, n: 268, avgProb: 0.8228, actual: 0.9067, expR: 2.04 },
    { bin: 10, n: 269, avgProb: 0.8711, actual: 0.9145, expR: 1.755 },
  ],
  S03_V2_STABLE_TP1: [
    { bin: 1, n: 35, avgProb: 0.455, actual: 0.371, expR: null },
    { bin: 2, n: 35, avgProb: 0.468, actual: 0.314, expR: null },
    { bin: 3, n: 34, avgProb: 0.479, actual: 0.471, expR: null },
    { bin: 4, n: 35, avgProb: 0.506, actual: 0.429, expR: null },
    { bin: 5, n: 35, avgProb: 0.563, actual: 0.800, expR: null },
  ],
  S03_V2_STABLE_TP2: [
    { bin: 1, n: 35, avgProb: 0.266, actual: 0.257, expR: null },
    { bin: 2, n: 35, avgProb: 0.299, actual: 0.229, expR: null },
    { bin: 3, n: 34, avgProb: 0.325, actual: 0.324, expR: null },
    { bin: 4, n: 35, avgProb: 0.371, actual: 0.314, expR: null },
    { bin: 5, n: 35, avgProb: 0.526, actual: 0.629, expR: null },
  ],
};

const PSI_CONTRIB: Record<string, number[]> = {
  S03: [0.0288, 0.0008, 0.006, 0.0003, 0.0067, 0.0324, 0.0157, 0.0039, 0.0001, 0.0641],
  S16: [0.0338, 0.0017, 0.0026, 0.0009, 0.0038, 0.0001, 0.0031, 0.0007, 0.0037, 0.019],
};

// ---- per-year drift & performance trend (score-bin PSI vs ’17–’22 baseline) --
type TrendPoint = { year: number; n: number; psi: number | null; ks: number | null; winRate: number | null };
const TREND: Record<string, TrendPoint[]> = {
  S03: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].map((year, i) => ({
    year,
    n: [641, 652, 611, 577, 543, 477, 610, 534, 572, 217][i],
    psi: [0.193, 0.0093, 0.0509, 0.0281, 0.0565, 0.1692, 0.1201, 0.1716, 0.2039, 0.2366][i],
    ks: [0.629, 0.48, 0.464, 0.488, 0.418, 0.349, 0.346, 0.267, 0.328, 0.434][i],
    winRate: [0.53, 0.46, 0.57, 0.487, 0.459, 0.417, 0.484, 0.483, 0.483, 0.525][i],
  })),
  S16: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].map((year, i) => ({
    year,
    n: [290, 252, 284, 298, 303, 275, 290, 289, 280, 121][i],
    psi: [0.0959, 0.0096, 0.042, 0.1286, 0.0116, 0.0284, 0.037, 0.1323, 0.0822, 0.3206][i],
    ks: [0.361, 0.381, 0.37, 0.315, 0.394, 0.491, 0.474, 0.348, 0.423, 0.475][i],
    winRate: [0.597, 0.631, 0.616, 0.705, 0.581, 0.629, 0.607, 0.706, 0.604, 0.719][i],
  })),
};

// ---- per-feature CSI drift trends (top drivers, vs ’17–’22 baseline) ------
type FeatTrend = { name: string; imp: number; csi: (number | null)[] };
const FEAT_TREND: Record<string, { years: number[]; rows: FeatTrend[] }> = {
  S03: {
    years: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026],
    rows: [
      { name: "tk_last", imp: 29.6, csi: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { name: "mins_since_midnight", imp: 10.9, csi: [0.046, 0.011, 0.024, 0.024, 0.013, 0.016, 0.021, 0.035, 0.037, 0.042] },
      { name: "tk_last_rr", imp: 9.7, csi: [0.019, 0.008, 0.018, 0.007, 0.007, 0.007, 0.021, 0.004, 0.006, 0.03] },
      { name: "log_risk", imp: 5.7, csi: [0.222, 0.065, 0.044, 0.036, 0.198, 0.174, 0.217, 0.384, 0.464, 0.349] },
      { name: "mon_sin", imp: 4.4, csi: [0.033, 0.019, 0.04, 0.051, 0.038, 0.028, 0.023, 0.063, 0.053, 6.384] },
      { name: "tp2_dist_pct", imp: 4.2, csi: [0.063, 0.011, 0.034, 0.085, 0.018, 0.062, 0.06, 0.035, 0.011, 0.06] },
      { name: "days_from_start", imp: 4.1, csi: [10.494, 9.144, 9.063, 9.303, 10.509, 10.64, 12.448, 12.448, 12.448, 12.448] },
      { name: "tp3_to_risk", imp: 3.6, csi: [0.137, 0.067, 0.013, 0.051, 0.035, 0.191, 0.204, 0.065, 0.077, 0.128] },
      { name: "tk_cnt", imp: 3.4, csi: [7.995, 4.422, 1.912, 1.924, 4.091, 5.62, 7.331, 9.661, 11.098, 12.435] },
      { name: "stop_dist_pct", imp: 3.1, csi: [0.023, 0.002, 0.011, 0.054, 0.013, 0.002, 0.007, 0.008, 0.014, 0.001] },
    ],
  },
  S16: {
    years: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026],
    rows: [
      { name: "direction_hist_prior_last_realized_r", imp: 17.0, csi: [0.027, 0.012, 0.021, 0.04, 0.014, 0.03, 0.015, 0.066, 0.032, 0.14] },
      { name: "entry_minutes_since_midnight", imp: 12.5, csi: [0.006, 0.083, 0.024, 0.026, 0.017, 0.046, 0.085, 0.056, 0.042, 0.126] },
      { name: "entry_hour", imp: 10.6, csi: [0.006, 0.013, 0.022, 0.004, 0.017, 0.043, 0.027, 0.018, 0.019, 0.057] },
      { name: "bias_consensus_strength", imp: 9.9, csi: [0.018, 0.003, 0.003, 0.004, 0.002, 0.008, 0.005, 0.003, 0.001, 0.02] },
      { name: "bias_direction_conflict_count", imp: 9.8, csi: [0.015, 0.005, 0.003, 0.005, 0.003, 0.009, 0.034, 0.008, 0.002, 0.033] },
      { name: "tp1_distance_pct", imp: 8.9, csi: [0.171, 0.017, 0.086, 0.162, 0.03, 0.048, 0.071, 0.054, 0.022, 0.1] },
      { name: "ticker_direction_hist_prior_last_realized_r", imp: 5.7, csi: [0.073, 0.018, 0.02, 0.028, 0.054, 0.039, 0.014, 0.032, 0.038, 0.06] },
      { name: "risk_to_price_pct", imp: 5.0, csi: [0.509, 0.078, 0.119, 0.283, 0.03, 0.252, 0.063, 0.02, 0.091, 0.236] },
      { name: "bias_bullish_count", imp: 5.0, csi: [0.135, 0.008, 0.028, 0.037, 0.028, 0.125, 0.097, 0.012, 0.019, 0.062] },
      { name: "tp3_to_tp2_ratio", imp: 4.4, csi: [0.102, 0.017, 0.032, 0.072, 0.029, 0.075, 0.039, 0.02, 0.064, 0.137] },
    ],
  },
};

// ---- final-model feature diagnostics (imp %, IV, KS, CSI drift, missing) --
type FeatRow = { name: string; imp: number; iv: number; ks: number; csi: number; miss: number };
const FEATMETRICS: Record<string, FeatRow[]> = {
  S03: [
    { name: "tk_last (ticker prior win)", imp: 29.6, iv: 0.5, ks: 0.346, csi: 16.92, miss: 0.0053 },
    { name: "mins_since_midnight", imp: 10.9, iv: 0.161, ks: 0.193, csi: 0.017, miss: 0 },
    { name: "tk_last_rr (ticker prior R)", imp: 9.7, iv: 0.487, ks: 0.345, csi: 9.3, miss: 0.0053 },
    { name: "log_risk", imp: 5.7, iv: 0.064, ks: 0.079, csi: 0.305, miss: 0 },
    { name: "mon_sin (seasonality)", imp: 4.4, iv: 0.021, ks: 0.053, csi: 0.182, miss: 0 },
    { name: "tp2_dist_pct", imp: 4.2, iv: 0.097, ks: 0.132, csi: 0.106, miss: 0 },
    { name: "days_from_start", imp: 4.1, iv: 0.013, ks: 0.048, csi: 21.782, miss: 0 },
    { name: "tp3_to_risk", imp: 3.6, iv: 0.019, ks: 0.042, csi: 2.656, miss: 0 },
    { name: "tk_cnt (ticker history depth)", imp: 3.4, iv: 0.023, ks: 0.043, csi: 8.797, miss: 0 },
    { name: "stop_dist_pct", imp: 3.1, iv: 0.05, ks: 0.066, csi: 14.643, miss: 0 },
    { name: "tp1_dist_pct", imp: 3.0, iv: 0.042, ks: 0.069, csi: 0.003, miss: 0 },
    { name: "tp2_to_risk", imp: 2.8, iv: 0.026, ks: 0.068, csi: 0.071, miss: 0 },
    { name: "tp3_dist_pct", imp: 2.7, iv: 0.073, ks: 0.06, csi: 2.112, miss: 0 },
    { name: "log_entry_price", imp: 2.6, iv: 0.003, ks: 0.017, csi: 0.411, miss: 0 },
    { name: "dir_rr_mean (direction prior R)", imp: 2.4, iv: 0.007, ks: 0.023, csi: 11.874, miss: 0.0004 },
    { name: "tp2_to_tp1", imp: 2.4, iv: 0.023, ks: 0.06, csi: 0.016, miss: 0 },
    { name: "tp1_to_risk", imp: 2.0, iv: 0.005, ks: 0.018, csi: 0.013, miss: 0 },
    { name: "tk_rr_mean (ticker prior R mean)", imp: 1.8, iv: 0.047, ks: 0.083, csi: 0.499, miss: 0.0053 },
    { name: "tk_tp2_rate (ticker hit-rate)", imp: 1.7, iv: 0.045, ks: 0.082, csi: 0.467, miss: 0.0053 },
  ],
  S16: [
    { name: "direction_hist_prior_last_realized_r", imp: 17.0, iv: 0.169, ks: 0.182, csi: 4.279, miss: 0 },
    { name: "entry_minutes_since_midnight", imp: 12.5, iv: 0.249, ks: 0.209, csi: 0.031, miss: 0 },
    { name: "entry_hour", imp: 10.6, iv: 0.261, ks: 0.208, csi: 6.25, miss: 0 },
    { name: "bias_consensus_strength", imp: 9.9, iv: 0.195, ks: 0.205, csi: 7.465, miss: 0 },
    { name: "bias_direction_conflict_count", imp: 9.8, iv: 0.193, ks: 0.212, csi: 2.882, miss: 0 },
    { name: "tp1_distance_pct", imp: 8.9, iv: 0.083, ks: 0.11, csi: 0.034, miss: 0 },
    { name: "ticker_direction_hist_prior_last_realized_r", imp: 5.7, iv: 0.073, ks: 0.112, csi: 4.265, miss: 0 },
    { name: "risk_to_price_pct", imp: 5.0, iv: 0.061, ks: 0.125, csi: 0.039, miss: 0 },
    { name: "bias_bullish_count", imp: 5.0, iv: 0.196, ks: 0.151, csi: 2.235, miss: 0 },
    { name: "tp3_to_tp2_ratio", imp: 4.4, iv: 0.044, ks: 0.065, csi: 0.019, miss: 0 },
    { name: "tp2_distance_pct", imp: 3.0, iv: 0.044, ks: 0.087, csi: 0.015, miss: 0 },
    { name: "tp3_to_risk_ratio", imp: 1.9, iv: 0.055, ks: 0.064, csi: 0.026, miss: 0 },
    { name: "stop_to_tp2_span_pct", imp: 1.9, iv: 0.038, ks: 0.07, csi: 0.032, miss: 0 },
    { name: "direction_hist_prior_count", imp: 1.5, iv: 0.051, ks: 0.078, csi: 14.477, miss: 0 },
    { name: "direction_hist_prior_realized_r_mean_50", imp: 1.3, iv: 0.032, ks: 0.09, csi: 0.187, miss: 0 },
    { name: "tp3_distance_pct", imp: 1.1, iv: 0.014, ks: 0.027, csi: 0.034, miss: 0 },
    { name: "entry_days_from_start", imp: 0.7, iv: 0.035, ks: 0.045, csi: 21.745, miss: 0 },
  ],
};

const FEATURE_FAMILIES = [
  { group: "Timing / seasonality", note: "hour, minute-of-day, day-from-start, cyclical sin/cos", tone: GREEN, share: 0.28 },
  { group: "Trade-plan geometry", note: "TP/stop distances, R:R ratios, log price & risk", tone: BLUE, share: 0.34 },
  { group: "Ticker & direction history", note: "leak-safe expanding prior hit-rate / realised-R", tone: VIOLET, share: 0.26 },
  { group: "Multi-timeframe bias", note: "weekly→5m bias agreement / conflict counts", tone: AMBER, share: 0.12 },
];

const DRIFT_POLICY = [
  { band: "Stable", range: "PSI < 0.10", action: "Business as usual — no action", tone: GREEN },
  { band: "Monitor", range: "0.10 ≤ PSI < 0.25", action: "Watch weekly, plan a refresh", tone: AMBER },
  { band: "Shift", range: "PSI ≥ 0.25", action: "Re-fit / re-bin before gating", tone: RED },
];

const KNOWLEDGE = [
  { icon: Scale, title: "Gini & AUC", body: "AUC is the probability a random winner scores above a random loser. Gini = 2·AUC − 1 restates it as rank-ordering power. >40% is strong on a trade scorecard." },
  { icon: Waypoints, title: "KS statistic", body: "Maximum gap between the cumulative winner and loser score distributions. It marks the score where separation peaks — the natural cut for a gate. >30% is a healthy separation." },
  { icon: Activity, title: "PSI (drift)", body: "Population Stability Index compares today's score mix vs the training mix, band by band. <0.10 stable, 0.10–0.25 monitor, >0.25 rebuild — the classic scorecard traffic-light." },
  { icon: GitBranch, title: "CSI (feature drift)", body: "Characteristic Stability Index is PSI applied to one driver's distribution, train vs recent. It localises drift to the exact feature that moved — even when overall PSI is calm." },
  { icon: ListChecks, title: "IV / WOE", body: "Weight-of-Evidence bins a driver by log good/bad odds; Information Value sums it. <0.02 useless · 0.1–0.3 medium · >0.3 strong. It ranks which drivers actually carry signal." },
  { icon: Gauge, title: "Calibration", body: "A score is calibrated when predicted probability ≈ realised hit-rate in every band. We check the reliability diagram and Brier score, not just ranking." },
];

// ---- primitives ---------------------------------------------------------
function Bar({ value, max, color, height = 8 }: { value: number; max: number; color: string; height?: number }) {
  const w = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="w-full rounded-full bg-white/[0.06]" style={{ height }}>
      <div className="rounded-full" style={{ width: `${w}%`, height, background: color }} />
    </div>
  );
}

function Rag({ tone, label }: { tone: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold" style={{ background: `${tone}22`, color: tone }}>
      <span className="size-1.5 rounded-full" style={{ background: tone }} />
      {label}
    </span>
  );
}

function Kpi({ icon: Icon, label, value, sub, tone = "#cbd5e1" }: { icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>; label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8a97ab]"><Icon className="size-4" style={{ color: tone }} />{label}</div>
      <div className="mt-2 font-mono text-2xl font-bold" style={{ color: tone }}>{value}</div>
      {sub ? <div className="mt-1 text-[11px] text-[#8a97ab]">{sub}</div> : null}
    </div>
  );
}

function ragForPsi(p: number) {
  if (p < 0.1) return { tone: GREEN, label: "Stable" };
  if (p < 0.25) return { tone: AMBER, label: "Monitor" };
  return { tone: RED, label: "Shift" };
}
function ragForKs(k: number) {
  if (k >= 0.4) return { tone: GREEN, label: "Excellent" };
  if (k >= 0.3) return { tone: GREEN, label: "Strong" };
  if (k >= 0.2) return { tone: AMBER, label: "Acceptable" };
  return { tone: RED, label: "Weak" };
}
function ragForSplitHealth(split: "train" | "val" | "test", current: Split, train: Split) {
  if (split === "train") return ragForKs(current.ks);
  const aucGap = train.auc - current.auc;
  if (aucGap >= 0.2) return { tone: RED, label: "Generalization gap" };
  if (aucGap >= 0.1) return { tone: AMBER, label: "AUC gap" };
  return ragForKs(current.ks);
}
function ragForIv(iv: number) {
  if (iv >= 0.3) return { tone: GREEN, label: "Strong" };
  if (iv >= 0.1) return { tone: BLUE, label: "Medium" };
  if (iv >= 0.02) return { tone: AMBER, label: "Weak" };
  return { tone: RED, label: "Noise" };
}
function ragForCsi(c: number) {
  if (c < 0.1) return { tone: GREEN, label: "Stable" };
  if (c < 0.25) return { tone: AMBER, label: "Monitor" };
  return { tone: RED, label: "Shift" };
}

// ---- KS curve mini viz --------------------------------------------------
function KsCurve({ deciles, ks }: { deciles: Band[]; ks: number }) {
  const valid = deciles.filter((b) => b.actual != null && b.n > 0) as { bin: number; n: number; actual: number }[];
  const totalWin = valid.reduce((s, b) => s + b.n * b.actual, 0);
  const totalLoss = valid.reduce((s, b) => s + b.n * (1 - b.actual), 0);
  if (valid.length < 3 || totalWin === 0 || totalLoss === 0) {
    return <div className="flex h-[120px] items-center justify-center text-[11px] text-[#7f8ca3]">Not enough closed trades in this selection to draw the KS curve.</div>;
  }
  const pts = valid.map((_, index) => {
    const prefix = valid.slice(0, index + 1);
    const wins = prefix.reduce((sum, b) => sum + b.n * b.actual, 0);
    const losses = prefix.reduce((sum, b) => sum + b.n * (1 - b.actual), 0);
    return { g: wins / totalWin, bd: losses / totalLoss };
  });
  const W = 260, H = 120, pad = 6;
  const x = (i: number) => pad + (i / (pts.length - 1)) * (W - pad * 2);
  const y = (v: number) => H - pad - v * (H - pad * 2);
  const line = (key: "g" | "bd") => pts.map((p, i) => `${x(i)},${y(p[key])}`).join(" ");
  let gi = 0, gmax = 0;
  pts.forEach((p, i) => { const d = Math.abs(p.bd - p.g); if (d > gmax) { gmax = d; gi = i; } });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <polyline points={line("bd")} fill="none" stroke={RED} strokeWidth="2" />
      <polyline points={line("g")} fill="none" stroke={GREEN} strokeWidth="2" />
      <line x1={x(gi)} x2={x(gi)} y1={y(pts[gi].g)} y2={y(pts[gi].bd)} stroke={VIOLET} strokeWidth="2" strokeDasharray="3 2" />
      <text x={x(gi) + 4} y={12} fill={VIOLET} fontSize="10" fontWeight="700">KS {pct(ks)}</text>
    </svg>
  );
}

// ---- drift & performance trend chart ------------------------------------
function DriftTrend({ data }: { data: TrendPoint[] }) {
  const W = 640, H = 210, padL = 34, padR = 34, padT = 14, padB = 24;
  const iw = W - padL - padR, ih = H - padT - padB;
  const xs = data.map((_, i) => padL + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw));
  const psiMax = Math.max(0.3, ...data.map((d) => d.psi ?? 0)) * 1.1;
  const yPsi = (v: number) => padT + ih - (v / psiMax) * ih;
  const yRate = (v: number) => padT + ih - v * ih; // 0..1 for ks & winRate
  const barW = Math.min(30, iw / data.length - 8);
  const linePts = (key: "ks" | "winRate") =>
    data.filter((d) => d[key] != null).map((d) => `${xs[data.indexOf(d)]},${yRate(d[key] as number)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {/* PSI threshold guides */}
      {[0.1, 0.25].map((t) => (
        t <= psiMax ? <g key={t}>
          <line x1={padL} x2={W - padR} y1={yPsi(t)} y2={yPsi(t)} stroke={t === 0.25 ? RED : AMBER} strokeWidth="1" strokeDasharray="4 3" opacity="0.6" />
          <text x={W - padR + 2} y={yPsi(t) + 3} fill={t === 0.25 ? RED : AMBER} fontSize="8">{t.toFixed(2)}</text>
        </g> : null
      ))}
      {/* PSI bars */}
      {data.map((d, i) => {
        if (d.psi == null) return null;
        const tone = ragForPsi(d.psi).tone;
        const h = padT + ih - yPsi(d.psi);
        return <rect key={i} x={xs[i] - barW / 2} y={yPsi(d.psi)} width={barW} height={Math.max(0, h)} rx={2} fill={tone} opacity="0.32" />;
      })}
      {/* KS + winRate lines */}
      <polyline points={linePts("ks")} fill="none" stroke={VIOLET} strokeWidth="2" />
      <polyline points={linePts("winRate")} fill="none" stroke={GREEN} strokeWidth="2" strokeDasharray="3 2" />
      {data.map((d, i) => (
        <g key={i}>
          {d.ks != null && <circle cx={xs[i]} cy={yRate(d.ks)} r="2.6" fill={VIOLET} />}
          {d.winRate != null && <circle cx={xs[i]} cy={yRate(d.winRate)} r="2.2" fill={GREEN} />}
          <text x={xs[i]} y={H - 8} fill="#7f8ca3" fontSize="8" textAnchor="middle">{`'${String(d.year).slice(2)}`}</text>
        </g>
      ))}
    </svg>
  );
}

// ---- feature CSI drift heatmap ------------------------------------------
function CsiHeat({ years, rows }: { years: number[]; rows: FeatTrend[] }) {
  const cell = (c: number | null) => {
    if (c == null) return { bg: "rgba(255,255,255,0.03)", txt: "#4b5563", label: "·" };
    const r = ragForCsi(c);
    const op = c >= 0.25 ? 0.85 : c >= 0.1 ? 0.55 : 0.22;
    return { bg: `${r.tone}${Math.round(op * 255).toString(16).padStart(2, "0")}`, txt: c >= 0.1 ? "#0b0f16" : "#93a1b6", label: c >= 10 ? "9+" : c >= 1 ? c.toFixed(1) : c.toFixed(2).slice(1) };
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate" style={{ borderSpacing: 2 }}>
        <thead>
          <tr>
            <th className="text-left text-[9px] font-normal uppercase text-[#7f8ca3]">Feature</th>
            {years.map((y) => <th key={y} className="text-center text-[8px] font-normal text-[#7f8ca3]">{`'${String(y).slice(2)}`}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.name}>
              <td className="pr-2 font-mono text-[10px] text-[#cbd5e1]"><span className="block max-w-[190px] truncate" title={`${f.name} · imp ${f.imp}`}>{f.name}</span></td>
              {f.csi.map((c, i) => {
                const s = cell(c);
                return <td key={i} className="text-center font-mono text-[8px] font-semibold" style={{ background: s.bg, color: s.txt, borderRadius: 3, minWidth: 22 }} title={c == null ? "n/a" : `${f.name} ${years[i]}: CSI ${c}`}>{s.label}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- live analytics payload ---------------------------------------------
type Live = {
  ok: boolean;
  n: number; closed: number; overall: number | null;
  auc: number | null; ks: number | null; gini: number | null; psi: number | null;
  deciles: Band[];
  baseDist: number[]; compDist: number[];
  trend: TrendPoint[];
  tickers: string[];
};

function perBandPsi(base: number[], comp: number[]) {
  const bs = base.reduce((a, x) => a + x, 0) || 1;
  const cs = comp.reduce((a, x) => a + x, 0) || 1;
  const eps = 1e-6;
  return Array.from({ length: Math.max(base.length, comp.length) }, (_, i) => {
    const bp = (base[i] || 0) / bs + eps;
    const cp = (comp[i] || 0) / cs + eps;
    return (cp - bp) * Math.log(cp / bp);
  });
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { v: string; l: string }[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-xs font-semibold text-[#cbd5e1] outline-none focus:border-violet-400/50"
    >
      {options.map((o) => (
        <option key={o.v} value={o.v} className="bg-[#0e1524]">{o.l}</option>
      ))}
    </select>
  );
}

export default function MlInsights() {
  const [view, setView] = useState<"research" | "analytics">("analytics");
  const [strat, setStrat] = useState<"S03" | "S16">("S03");
  const [featStrat, setFeatStrat] = useState<"S03" | "S16">("S03");
  const [splitStrat, setSplitStrat] = useState<"S03" | "S16">("S03");

  // live filters
  const [source, setSource] = useState<"backtest" | "realtime">("backtest");
  const [market, setMarket] = useState<"all" | "us" | "india">("all");
  const [ticker, setTicker] = useState("all");
  const [scoreModel, setScoreModel] = useState("incumbent");
  const [live, setLive] = useState<Live | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    const q = new URLSearchParams({ strategy: strat, model: scoreModel, source, market, ticker });
    fetch(`/api/ml-insights?${q.toString()}`)
      .then((r) => r.json())
      .then((d: Live & { error?: string }) => {
        if (cancel) return;
        if (d.ok) setLive(d);
        else { setLive(null); setErr(d.error || "no data"); }
      })
      .catch((e) => { if (!cancel) { setLive(null); setErr(String(e)); } })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [strat, scoreModel, source, market, ticker]);

  const model = scoreModel === "incumbent" ? MODELS.find((m) => m.id === strat)! : V2_MODELS[scoreModel];
  const splitKey = scoreModel === "incumbent"
    ? strat
    : scoreModel.endsWith("_tp1") ? "S03_V2_STABLE_TP1" : "S03_V2_STABLE_TP2";
  const activeSplits = SPLITS[splitKey];
  const staticDec = DECILES[splitKey];
  const liveHasBands = !!live && live.deciles?.some((d) => d.n > 0);
  const dec: Band[] = liveHasBands ? live!.deciles : staticDec;

  const overall = live?.overall ?? staticDec.reduce((s, b) => s + b.n * (b.actual ?? 0), 0) / staticDec.reduce((s, b) => s + b.n, 0);
  const mAuc = live?.auc ?? model.testAuc;
  const mKs = live?.ks ?? model.ks ?? 0;
  const mGini = live?.gini ?? model.gini ?? 0;
  const mPsi = live?.psi ?? model.psi ?? 0;
  const psiContrib = live?.baseDist && live?.compDist ? perBandPsi(live.baseDist, live.compDist) : (scoreModel === "incumbent" ? PSI_CONTRIB[strat] : new Array(staticDec.length).fill(0));
  const totalN = live?.n ?? staticDec.reduce((s, b) => s + b.n, 0);
  const closedN = live?.closed ?? totalN;
  const trend: TrendPoint[] = live?.trend && live.trend.length ? live.trend : TREND[strat];
  const psiTrendUp = (() => {
    const v = trend.filter((t) => t.psi != null).map((t) => t.psi as number);
    return v.length >= 2 ? v[v.length - 1] - v[0] : 0;
  })();

  const marketOpts = source === "realtime"
    ? [{ v: "all", l: "All markets" }, { v: "us", l: "US" }, { v: "india", l: "India" }]
    : [{ v: "all", l: "US (backtest)" }];
  const tickerOpts = [{ v: "all", l: "All tickers" }, ...(live?.tickers ?? []).map((t) => ({ v: t, l: t }))];

  const changeStrat = (s: "S03" | "S16") => { setStrat(s); setScoreModel("incumbent"); setTicker("all"); };
  const changeSource = (s: "backtest" | "realtime") => {
    if (scoreModel !== "incumbent" && s === "backtest") return;
    setSource(s); setTicker("all"); setMarket("all");
  };
  const changeScoreModel = (value: string) => {
    setScoreModel(value);
    setTicker("all");
    setLive(null);
    if (value !== "incumbent") { setSource("realtime"); setMarket("us"); }
  };

  return (
    <div className="space-y-6">
      {/* hero */}
      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-[#141b2e] via-[#0e1524] to-[#0b0f16] p-6">
        <div className="absolute -right-16 -top-16 size-56 rounded-full opacity-20 blur-3xl" style={{ background: VIOLET }} />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-violet-200"><BrainCircuit className="size-4" />ICT ML Risk Workbench</div>
            <h1 className="mt-3 text-2xl font-bold text-white">Probability scoring &amp; credit-risk analytics</h1>
            <p className="mt-1 max-w-2xl text-sm text-[#93a1b6]">Every ICT signal is scored for its probability of reaching target before stop, then bucketed into equal-population risk bands. Discrimination, calibration and drift are tracked with the same toolkit banks use for credit scorecards — live across backtest and realtime, per market and ticker.</p>
          </div>
          <div className="flex rounded-xl border border-white/10 bg-black/30 p-1 text-xs font-semibold">
            {(["analytics", "research"] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} className={cx("rounded-lg px-3 py-1.5 capitalize transition", view === v ? "bg-violet-500/25 text-violet-100" : "text-[#8a97ab] hover:text-white")}>{v === "analytics" ? "Analytics · credit-risk" : "Research"}</button>
            ))}
          </div>
        </div>
        <div className="relative mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi icon={Sparkles} label="Models live" value="2 + 2" sub="S03, S16 scored · S-CH research" tone={VIOLET} />
          <Kpi icon={Target} label="Orders scored" value="8,162" sub="S03 5,464 · S16 2,698 (US)" tone={BLUE} />
          <Kpi icon={Scale} label="Avg Gini" value="51.7%" sub="rank-ordering power (test)" tone={GREEN} />
          <Kpi icon={Waypoints} label="Avg KS" value="39.2%" sub="max good/bad separation (test)" tone={GREEN} />
        </div>
      </div>

      {view === "analytics" ? (
        <>
          {/* filter bar */}
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a97ab]"><Filter className="size-4 text-violet-300" />Filters</div>
            <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/30 p-0.5">
              {(["S03", "S16"] as const).map((s) => (
                <button key={s} onClick={() => changeStrat(s)} className={cx("rounded-md px-2.5 py-1 text-xs font-semibold transition", strat === s ? "bg-violet-500/25 text-violet-100" : "text-[#8a97ab] hover:text-white")}>
                  {s}{s === "S03" && <span className="ml-1 rounded bg-emerald-400/20 px-1 text-[9px] text-emerald-300">NEW</span>}
                </button>
              ))}
            </div>
            <Select value={scoreModel} onChange={changeScoreModel} options={[...SCORE_MODEL_OPTIONS[strat]]} />
            <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/30 p-0.5">
              {(["backtest", "realtime"] as const).map((s) => (
                <button key={s} onClick={() => changeSource(s)} className={cx("flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold capitalize transition", source === s ? "bg-blue-500/25 text-blue-100" : "text-[#8a97ab] hover:text-white")}>
                  <Database className="size-3" />{s}
                </button>
              ))}
            </div>
            <Select value={market} onChange={(v) => setMarket(v as typeof market)} options={marketOpts} />
            <Select value={ticker} onChange={setTicker} options={tickerOpts} />
            <div className="ml-auto text-[11px] text-[#8a97ab]">
              {loading ? <span className="text-violet-300">loading…</span> : err ? <span className="text-rose-300">live unavailable — showing reference</span> : <>scored <span className="font-mono text-[#cbd5e1]">{totalN.toLocaleString()}</span> · closed <span className="font-mono text-[#cbd5e1]">{closedN.toLocaleString()}</span></>}
            </div>
          </div>

          {strat === "S16" ? <S16StructuralPanel /> : null}

          {scoreModel !== "incumbent" ? (
            <div className="border-y border-white/10 bg-[#0f1720] p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-white">S03 CatBoost V2 Stable diagnostics</div>
                  <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[#93a1b6]">Three-seed raw probability · development feature PSI ≤ 0.10 · shadow only. A temporal capacity audit rejected larger fixed-tree and logloss-stopped refits: they raised training fit without improving forward discrimination. Validation-only isotonic calibration was also rejected after poor forward transfer.</p>
                </div>
                <a href="/reports/s03-catboost-v2-stable-final.pdf" target="_blank" rel="noreferrer" className="rounded-md border border-cyan-300/30 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-300/10">Open full V2 report</a>
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-3">
                {[
                  ["Calibration", "/reports/s03-v2-calibration.png"],
                  ["TP1 SHAP", "/reports/s03-v2-tp1-shap.png"],
                  ["TP1 PDP", "/reports/s03-v2-tp1-pdp.png"],
                ].map(([label, src]) => (
                  <a key={label} href={src} target="_blank" rel="noreferrer" className="overflow-hidden rounded-md border border-white/10 bg-black/20">
                    <Image src={src} alt={`${label} diagnostic`} width={960} height={640} className="h-48 w-full object-cover object-top" />
                    <div className="border-t border-white/10 px-3 py-2 text-xs font-medium text-[#cbd5e1]">{label}</div>
                  </a>
                ))}
              </div>
            </div>
          ) : null}

          {/* discrimination */}
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 lg:col-span-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a97ab]">Discrimination · {source}</div>
              <div className="mt-4 space-y-4">
                {[
                  { k: "AUC", v: mAuc, disp: mAuc.toFixed(3), rag: mAuc >= 0.7 ? { tone: GREEN, label: "Strong" } : { tone: AMBER, label: "Fair" } },
                  { k: "Gini", v: mGini, disp: pct(mGini), rag: mGini >= 0.4 ? { tone: GREEN, label: "Strong" } : { tone: AMBER, label: "Fair" } },
                  { k: "KS", v: mKs, disp: pct(mKs), rag: ragForKs(mKs) },
                ].map((r) => (
                  <div key={r.k}>
                    <div className="mb-1 flex items-center justify-between text-sm"><span className="text-[#cbd5e1]">{r.k}</span><span className="font-mono font-bold text-white">{r.disp}</span></div>
                    <Bar value={r.v} max={1} color={r.rag.tone} />
                  </div>
                ))}
              </div>
              <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-[#8a97ab]">Cumulative good vs bad capture</div>
                <KsCurve deciles={dec} ks={mKs} />
                <div className="flex gap-3 text-[10px] text-[#8a97ab]"><span style={{ color: GREEN }}>● winners</span><span style={{ color: RED }}>● losers</span><span style={{ color: VIOLET }}>● KS gap</span></div>
              </div>
            </div>

            {/* scorecard bands */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 lg:col-span-2">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a97ab]">Risk-probability scorecard · {dec.length} frozen probability bands</div>
                <span className="text-[11px] text-[#8a97ab]">win-rate {fp(overall)}</span>
              </div>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-[10px] uppercase tracking-wide text-[#7f8ca3]">
                    <tr>
                      <th className="py-2 pr-3">Band</th><th className="py-2 pr-3">Pred P</th><th className="py-2 pr-3">Actual</th>
                      <th className="py-2 pr-3">Lift</th><th className="py-2 pr-3 w-28">Calibration</th><th className="py-2 pr-3">E[R]</th><th className="py-2">n</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dec.slice().reverse().map((b) => {
                      const lift = b.actual != null && overall ? b.actual / overall : null;
                      const tone = b.expR == null ? "#7f8ca3" : b.expR >= 0.5 ? GREEN : b.expR >= 0 ? AMBER : RED;
                      return (
                        <tr key={b.bin} className="border-t border-white/5">
                          <td className="py-1.5 pr-3 font-mono font-bold text-white">B{b.bin}</td>
                          <td className="py-1.5 pr-3 font-mono text-[#93a1b6]">{fp(b.avgProb)}</td>
                          <td className="py-1.5 pr-3 font-mono" style={{ color: tone }}>{fp(b.actual)}</td>
                          <td className="py-1.5 pr-3 font-mono text-[#cbd5e1]">{lift == null ? "—" : `${lift.toFixed(2)}×`}</td>
                          <td className="py-1.5 pr-3">{b.actual == null ? <span className="text-[#7f8ca3]">—</span> : <Bar value={b.actual} max={1} color={BLUE} height={6} />}</td>
                          <td className="py-1.5 pr-3 font-mono font-semibold" style={{ color: tone }}>{b.expR == null ? "—" : `${b.expR >= 0 ? "+" : ""}${b.expR.toFixed(2)}R`}</td>
                          <td className="py-1.5 font-mono text-[#7f8ca3]">{b.n}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-[#8a97ab]">
                {liveHasBands
                  ? `Live scorecard for ${strat} · ${source}${ticker !== "all" ? ` · ${ticker}` : ""}. Predicted probability should track the realised hit-rate down each band (calibration); expectancy should climb monotonically toward the top band.`
                  : "Reference scorecard (full backtest). Predicted probability tracks the realised hit-rate band by band, and expectancy climbs from the negative-expectancy bottom band to the top — exactly what a gate should exploit."}
              </p>
            </div>
          </div>

          {/* train / val / test split */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a97ab]"><GitBranch className="size-4 text-violet-300" />Discrimination by split · train / validation / test</div>
              <span className="text-[11px] text-[#8a97ab]">temporal split — train ’17–’22 · val ’23–’24 · test ’25–’26 · <span className="font-mono text-[#cbd5e1]">{strat}</span></span>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wide text-[#7f8ca3]">
                  <tr><th className="py-2 pr-3">Split</th><th className="py-2 pr-3">n</th><th className="py-2 pr-3">Base rate</th><th className="py-2 pr-3">AUC</th><th className="py-2 pr-3">Gini</th><th className="py-2 pr-3">KS</th><th className="py-2 pr-3">Brier</th><th className="py-2">Health</th></tr>
                </thead>
                <tbody>
                  {(["train", "val", "test"] as const).map((s) => {
                    const d = activeSplits[s];
                    const rag = ragForSplitHealth(s, d, activeSplits.train);
                    return (
                      <tr key={s} className="border-t border-white/5">
                        <td className="py-1.5 pr-3 font-semibold capitalize text-white">{s === "val" ? "Validation" : s}</td>
                        <td className="py-1.5 pr-3 font-mono text-[#93a1b6]">{d.n.toLocaleString()}</td>
                        <td className="py-1.5 pr-3 font-mono text-[#93a1b6]">{pct(d.base)}</td>
                        <td className="py-1.5 pr-3 font-mono font-bold text-white">{d.auc.toFixed(3)}</td>
                        <td className="py-1.5 pr-3 font-mono text-[#cbd5e1]">{pct(d.gini)}</td>
                        <td className="py-1.5 pr-3 font-mono text-[#cbd5e1]">{pct(d.ks)}</td>
                        <td className="py-1.5 pr-3 font-mono text-[#93a1b6]">{d.brier.toFixed(3)}</td>
                        <td className="py-1.5"><Rag {...rag} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-[#8a97ab]">
              {scoreModel !== "incumbent"
                ? `${model.id} is a shadow comparison model. Test AUC is ${activeSplits.test.auc.toFixed(3)} with ${model.features} development-stable features; its forward uncertainty is too wide for order gating.`
                : strat === "S03"
                ? "Train→test AUC falls 0.810 → 0.729 (gap ≈ 0.081) with test KS 34.5% holding above the 30% bar — some optimism on train, but the out-of-time test still ranks strongly. Gap-penalised tuning keeps the slide contained."
                : "S16’s ICT-enhanced champion strengthens out-of-time — test AUC 0.788 tops the harder 2023–24 validation era (0.774) — after folding 11 engineered ICT price-action features (5-minute FVG distance is the single strongest driver, ~54% of gain) into the 174-feature base. That tightened the train→test AUC spread to 0.038 while shrinking the model from 48 to 24 features. Note: the live scorecard and drift panels below are driven by the calibrated 42-feature stable model — the deployable promotion candidate that scores the production order book in shadow mode."}
            </p>
          </div>

          {/* drift & performance trend */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a97ab]"><Activity className="size-4 text-violet-300" />Drift &amp; performance trend · by year</div>
              <div className="flex items-center gap-3 text-[10px] text-[#8a97ab]">
                <span style={{ color: VIOLET }}>▬ KS</span>
                <span style={{ color: GREEN }}>▬ win-rate</span>
                <span className="text-[#8a97ab]">▮ score PSI</span>
                <Rag tone={psiTrendUp >= 0.1 ? RED : psiTrendUp >= 0.03 ? AMBER : GREEN} label={psiTrendUp >= 0.1 ? "drift rising" : psiTrendUp >= 0.03 ? "drift creeping" : "drift flat"} />
              </div>
            </div>
            <div className="mt-3"><DriftTrend data={trend} /></div>
            <p className="mt-2 text-[11px] leading-relaxed text-[#8a97ab]">
              Score-bin PSI is measured each year against the frozen ’17–’22 training mix; KS and win-rate track live discrimination and outcome. {strat === "S03"
                ? "S03 drift climbs steadily from ≈0.03 (2019) to 0.24 by 2026 — crossing the 0.10 monitor line around 2022 and now brushing the 0.25 rebuild threshold. KS dipped to 0.27 in 2024 before recovering to 0.43, so ranking power held even as the population moved. A refresh is due; gating is unaffected in shadow mode."
                : "S16 sits stable (PSI < 0.13) for most of the window, then jumps to 0.32 in 2026 — driven by a small, part-year sample. KS stays strong throughout (0.35–0.49), so this reads as a distribution shift to watch, not decayed discrimination."}
              {" "}2026 is a partial year (through July), which exaggerates its stability reading.
            </p>
          </div>

          {/* calibration + PSI */}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a97ab]">Reliability · predicted vs realised</div>
              <div className="mt-4 flex items-end gap-1.5" style={{ height: 150 }}>
                {dec.map((b) => (
                  <div key={b.bin} className="flex flex-1 flex-col items-center justify-end gap-1">
                    <div className="flex w-full items-end justify-center gap-[2px]" style={{ height: 120 }}>
                      <div className="w-1/2 rounded-t" style={{ height: `${(b.avgProb ?? 0) * 120}px`, background: `${BLUE}99` }} title={`pred ${fp(b.avgProb)}`} />
                      <div className="w-1/2 rounded-t" style={{ height: `${(b.actual ?? 0) * 120}px`, background: GREEN }} title={`actual ${fp(b.actual)}`} />
                    </div>
                    <span className="text-[8px] text-[#7f8ca3]">B{b.bin}</span>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex gap-3 text-[10px] text-[#8a97ab]"><span style={{ color: BLUE }}>● predicted P</span><span style={{ color: GREEN }}>● realised hit-rate</span></div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a97ab]">Population Stability (PSI) · selection vs ’17–’22 training baseline</div>
                <Rag {...ragForPsi(mPsi)} />
              </div>
              <div className="mt-3 flex items-baseline gap-2"><span className="font-mono text-3xl font-bold text-white">{mPsi.toFixed(3)}</span><span className="text-[11px] text-[#8a97ab]">total PSI</span></div>
              <div className="mt-4 flex items-end gap-1.5" style={{ height: 90 }}>
                {psiContrib.map((c, i) => {
                  const mx = Math.max(...psiContrib, 0.001);
                  const tone = c >= 0.02 ? AMBER : GREEN;
                  return (
                    <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1">
                      <div className="w-full rounded-t" style={{ height: `${(c / mx) * 72}px`, background: tone }} title={`B${i + 1}: ${c.toFixed(4)}`} />
                      <span className="text-[8px] text-[#7f8ca3]">B{i + 1}</span>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-[#8a97ab]">Per-band contribution of the score distribution vs the training baseline. {source === "realtime" ? "Realtime is a small, recent sample — a high reading here flags production scores landing in different bands than training, not necessarily model decay." : strat === "S03" ? "The top band carries most of the shift — recent years fire fewer very-high-probability breakers, nudging PSI into the monitor zone." : "Distribution is stable across every band; the model generalises cleanly from 2017–22 to recent trades."}</p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {DRIFT_POLICY.map((d) => (
                  <div key={d.band} className="rounded-lg border border-white/10 bg-black/20 p-2"><div className="text-[10px] font-semibold" style={{ color: d.tone }}>{d.band}</div><div className="mt-0.5 font-mono text-[10px] text-[#cbd5e1]">{d.range}</div></div>
                ))}
              </div>
            </div>
          </div>

          {/* knowledge */}
          <div>
            <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#8a97ab]"><CheckCircle2 className="size-4 text-emerald-300" />Credit-risk methodology applied to trade scoring</div>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {KNOWLEDGE.map((k) => (
                <div key={k.title} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-white"><k.icon className="size-4 text-violet-300" />{k.title}</div>
                  <p className="mt-2 text-[12px] leading-relaxed text-[#93a1b6]">{k.body}</p>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          {/* model registry */}
          <div>
            <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#8a97ab]"><Layers className="size-4 text-violet-300" />Model registry</div>
            <div className="grid gap-3 md:grid-cols-2">
              {MODELS.map((m) => (
                <div key={m.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2"><StrategyLink code={m.id} label={m.id} className="font-mono text-sm font-bold text-cyan-300" />{m.isNew ? <span className="rounded bg-emerald-400/20 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300">NEW · {m.id === "S16" ? "ICT-enhanced" : "full-data"}</span> : null}<Rag tone={m.status === "live" ? GREEN : AMBER} label={m.status === "live" ? "scored" : "research"} /></div>
                      <div className="mt-1 text-sm text-white">{m.concept}</div>
                      <div className="text-[11px] text-[#8a97ab]">{m.family}</div>
                    </div>
                    <div className="text-right"><div className="font-mono text-lg font-bold text-white">{m.testAuc.toFixed(3)}</div><div className="text-[10px] text-[#8a97ab]">test AUC</div></div>
                  </div>
                  <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                    {[
                      { l: "Gini", v: m.gini != null ? pct(m.gini, 0) : "—" },
                      { l: "KS", v: m.ks != null ? pct(m.ks, 0) : "—" },
                      { l: "PSI", v: m.psi != null ? m.psi.toFixed(2) : "—" },
                      { l: "Feats", v: String(m.features) },
                    ].map((s) => (
                      <div key={s.l} className="rounded-lg bg-black/20 py-1.5"><div className="font-mono text-sm font-bold text-[#cbd5e1]">{s.v}</div><div className="text-[9px] uppercase text-[#7f8ca3]">{s.l}</div></div>
                    ))}
                  </div>
                  <div className="mt-2 flex justify-between text-[11px] text-[#8a97ab]"><span>Target: <span className="text-[#cbd5e1]">{m.target}</span></span><span>{m.scored}</span></div>
                </div>
              ))}
            </div>
          </div>

          {/* train / val / test (research context) */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a97ab]"><GitBranch className="size-4 text-violet-300" />Train / validation / test — no shuffling</div>
              <div className="flex gap-1">
                {(["S03", "S16"] as const).map((s) => (
                  <button key={s} onClick={() => setSplitStrat(s)} className={cx("rounded-lg px-2.5 py-1 text-xs font-semibold", splitStrat === s ? "bg-violet-500/20 text-violet-100" : "text-[#8a97ab] hover:text-white")}>{s}</button>
                ))}
              </div>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {(["train", "val", "test"] as const).map((s) => {
                const d = SPLITS[splitStrat][s];
                const label = s === "val" ? "Validation ’23–’24" : s === "train" ? "Train ’17–’22" : "Test ’25–’26";
                return (
                  <div key={s} className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <div className="flex items-center justify-between"><span className="text-[11px] font-semibold text-white">{label}</span><Rag {...ragForKs(d.ks)} /></div>
                    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                      <span className="text-[#8a97ab]">AUC</span><span className="text-right font-mono font-bold text-white">{d.auc.toFixed(3)}</span>
                      <span className="text-[#8a97ab]">Gini</span><span className="text-right font-mono text-[#cbd5e1]">{pct(d.gini)}</span>
                      <span className="text-[#8a97ab]">KS</span><span className="text-right font-mono text-[#cbd5e1]">{pct(d.ks)}</span>
                      <span className="text-[#8a97ab]">Brier</span><span className="text-right font-mono text-[#cbd5e1]">{d.brier.toFixed(3)}</span>
                      <span className="text-[#8a97ab]">n · base</span><span className="text-right font-mono text-[#93a1b6]">{d.n.toLocaleString()} · {pct(d.base, 0)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-[#8a97ab]">Strictly time-ordered — the validation era tunes the model and the untouched test era is the honest out-of-time estimate. The gap between train and test AUC is the overfit budget the gap-penalised tuner is minimising.</p>
          </div>

          {/* feature-level diagnostics table */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a97ab]"><ListChecks className="size-4 text-violet-300" />Feature diagnostics · importance · IV · KS · CSI drift · missing</div>
              <div className="flex gap-1">
                {(["S03", "S16"] as const).map((s) => (
                  <button key={s} onClick={() => setFeatStrat(s)} className={cx("rounded-lg px-2.5 py-1 text-xs font-semibold", featStrat === s ? "bg-violet-500/20 text-violet-100" : "text-[#8a97ab] hover:text-white")}>{s}</button>
                ))}
              </div>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wide text-[#7f8ca3]">
                  <tr>
                    <th className="py-2 pr-3">Feature</th>
                    <th className="py-2 pr-3 w-32">Importance</th>
                    <th className="py-2 pr-3">IV</th>
                    <th className="py-2 pr-3">KS</th>
                    <th className="py-2 pr-3">CSI</th>
                    <th className="py-2 pr-3">Miss</th>
                    <th className="py-2">Drift</th>
                  </tr>
                </thead>
                <tbody>
                  {FEATMETRICS[featStrat].map((f) => {
                    const iv = ragForIv(f.iv);
                    const csi = ragForCsi(f.csi);
                    return (
                      <tr key={f.name} className="border-t border-white/5">
                        <td className="py-1.5 pr-3 font-mono text-[11px] text-[#cbd5e1]"><span className="block max-w-[220px] truncate" title={f.name}>{f.name}</span></td>
                        <td className="py-1.5 pr-3">
                          <div className="flex items-center gap-2"><div className="w-16"><Bar value={f.imp} max={30} color={VIOLET} height={6} /></div><span className="font-mono text-[10px] text-[#8a97ab]">{f.imp.toFixed(1)}</span></div>
                        </td>
                        <td className="py-1.5 pr-3 font-mono" style={{ color: iv.tone }}>{f.iv.toFixed(3)}</td>
                        <td className="py-1.5 pr-3 font-mono text-[#cbd5e1]">{pct(f.ks)}</td>
                        <td className="py-1.5 pr-3 font-mono" style={{ color: csi.tone }}>{f.csi >= 10 ? f.csi.toFixed(1) : f.csi.toFixed(3)}</td>
                        <td className="py-1.5 pr-3 font-mono text-[#93a1b6]">{f.miss === 0 ? "0" : pct(f.miss, 1)}</td>
                        <td className="py-1.5"><Rag {...csi} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-[#8a97ab]">
              <span className="text-[#cbd5e1]">Importance</span> = model gain share · <span className="text-[#cbd5e1]">IV</span> = information value (predictive strength) · <span className="text-[#cbd5e1]">KS</span> = feature-vs-outcome separation · <span className="text-[#cbd5e1]">CSI</span> = characteristic stability (train→recent drift) · <span className="text-[#cbd5e1]">Miss</span> = null rate. Time-indexed drivers (<span className="font-mono">days_from_start</span>, cumulative history counts) show very high CSI <em>by construction</em> — their range shifts every year — so they are read together with importance rather than gated on CSI alone. The real signal carriers ({featStrat === "S03" ? "tk_last, mins_since_midnight" : "bias_consensus, entry timing"}) pair high IV with contained CSI.
              {featStrat === "S16" ? <> These diagnostics track the base ICT feature families that anchor the deployed 42-feature stable scorer. The 2026 ICT-Enhanced champion re-weights the model toward engineered price-action — <span className="font-mono">f_fvg_dist</span> (5-minute FVG distance) carries ~54% of its gain, with <span className="font-mono">f_ob_align</span> and <span className="font-mono">h_fvg_dist</span> next — lifting test AUC to 0.788 across 24 features (11 engineered ICT).</> : null}
            </p>
          </div>

          {/* feature CSI drift trend heatmap */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a97ab]"><Activity className="size-4 text-violet-300" />Feature drift trend · CSI by year (top drivers)</div>
              <div className="flex items-center gap-2 text-[10px]">
                <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm" style={{ background: `${GREEN}59` }} />stable</span>
                <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm" style={{ background: `${AMBER}8c` }} />monitor</span>
                <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm" style={{ background: `${RED}d9` }} />shift</span>
                <div className="ml-1 flex gap-1">
                  {(["S03", "S16"] as const).map((s) => (
                    <button key={s} onClick={() => setFeatStrat(s)} className={cx("rounded-lg px-2.5 py-1 text-xs font-semibold", featStrat === s ? "bg-violet-500/20 text-violet-100" : "text-[#8a97ab] hover:text-white")}>{s}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-3"><CsiHeat years={FEAT_TREND[featStrat].years} rows={FEAT_TREND[featStrat].rows} /></div>
            <p className="mt-3 text-[11px] leading-relaxed text-[#8a97ab]">
              Each cell is a driver&apos;s Characteristic Stability Index for that year vs the ’17–’22 baseline. The signal carriers stay green — {featStrat === "S03" ? <><span className="font-mono">mins_since_midnight</span>, <span className="font-mono">tk_last_rr</span></> : <><span className="font-mono">bias_consensus_strength</span>, entry timing</>} barely move. Persistent red rows ({featStrat === "S03" ? <><span className="font-mono">days_from_start</span>, <span className="font-mono">tk_cnt</span></> : <><span className="font-mono">direction_hist_prior_count</span></>}) are time-indexed counters that drift by construction; {featStrat === "S03" ? <><span className="font-mono">log_risk</span> genuinely widened in ’24–’25, and <span className="font-mono">mon_sin</span>’s ’26 spike is the partial-year calendar</> : <><span className="font-mono">risk_to_price_pct</span> is the one economic driver worth watching</>}. Read drift alongside importance — a red cell on a low-importance counter barely moves the score.
            </p>
          </div>

          {/* feature families */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a97ab]"><LineChart className="size-4 text-violet-300" />Feature families &amp; contribution</div>
            <div className="space-y-3">
              {FEATURE_FAMILIES.map((f) => (
                <div key={f.group}>
                  <div className="mb-1 flex items-center justify-between text-sm"><span className="text-[#cbd5e1]">{f.group}</span><span className="font-mono text-[#8a97ab]">{pct(f.share, 0)}</span></div>
                  <Bar value={f.share} max={0.4} color={f.tone} />
                  <div className="mt-0.5 text-[10px] text-[#7f8ca3]">{f.note}</div>
                </div>
              ))}
            </div>
          </div>

          {/* methodology + guardrails */}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a97ab]"><TrendingUp className="size-4 text-violet-300" />Modelling protocol</div>
              <ul className="space-y-2 text-[12px] leading-relaxed text-[#93a1b6]">
                <li>• Strict time-based split (train ’17–’22 · val ’23–’24 · test ’25–’26) — no shuffling, mirrors live deployment.</li>
                <li>• Leak-safe features only: everything is computed at-or-before the entry bar; realised R is used for economics, never as an input.</li>
                <li>• RFA feature selection → regularised, gap-penalised tuning — the objective rewards validation AUC and punishes the train–test gap.</li>
                <li>• {scoreModel === "incumbent" ? "10 equal-population" : "5 frozen development"} probability bands, re-checked on train/val/test for monotonic, calibrated lift.</li>
                <li>• Shadow-mode scoring: probabilities are attached to alerts and stored; they never auto-place or size orders.</li>
              </ul>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a97ab]"><ShieldAlert className="size-4 text-amber-300" />Risk guardrails &amp; roadmap</div>
              <ul className="space-y-2 text-[12px] leading-relaxed text-[#93a1b6]">
                <li>• Max drift score PSI ≤ 0.25 before any band is used to gate.</li>
                <li>• Fail-open: a scoring error logs and alerts without gating — never blocks a signal.</li>
                <li>• Kill-switch forces alert-only globally, falling back to raw signals.</li>
                <li>• <span className="text-emerald-300">Shipped (S16):</span> the ICT price-action expansion (5m/1h FVG &amp; order-block distance, CVD, ATR, IPDA premium-discount, 52-week range) lifted the champion test AUC 0.776→0.788 and cut max drawdown to −4.0R at the P≥0.60 gate — 11 of its 24 features are engineered ICT.</li>
                <li>• <span className="text-emerald-300">Next:</span> fold the same ICT expansion (IPDA, BOS/MSS/CHoCH, FVG lifecycle) into S03, then promote via the model-registry gate.</li>
                <li>• <span className="text-emerald-300">Next:</span> extend risk scoring to S-CH10 / S-CH08 and the A-series.</li>
              </ul>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
