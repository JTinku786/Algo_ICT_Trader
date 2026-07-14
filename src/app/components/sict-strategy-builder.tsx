"use client";

import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCircle2,
  Clipboard,
  Code2,
  Download,
  FlaskConical,
  GitBranch,
  Layers3,
  LockKeyhole,
  Play,
  RefreshCcw,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Target,
  Waypoints,
} from "lucide-react";
import { useMemo, useState } from "react";

type Direction = "BUY" | "SELL";
type Market = "us" | "forex";
type OutputTarget = "updated" | "production_ready";
type EntryMode = "conservative" | "both";
type OutputView = "powershell" | "json" | "wiring";

type BuilderConfig = {
  market: Market;
  symbols: string;
  startDate: string;
  endDate: string;
  outputTarget: OutputTarget;
  workers: number;
  returnWindowBars: number;
  requireSweep: boolean;
  entryMode: EntryMode;
  productionAcknowledged: boolean;
  riskPerTradePct: number;
  maxDailyLossR: number;
  minSampleTrades: number;
  minProfitFactor: number;
  maxDrawdownR: number;
};

type Rule = {
  step: string;
  timeframe: string;
  title: string;
  detail: string;
  status: "fixed" | "wired";
};

const DEFAULT_CONFIG: BuilderConfig = {
  market: "us",
  symbols: "AAPL, MSFT, CVX",
  startDate: "2024-01-02",
  endDate: "2024-03-29",
  outputTarget: "updated",
  workers: 3,
  returnWindowBars: 260,
  requireSweep: true,
  entryMode: "conservative",
  productionAcknowledged: false,
  riskPerTradePct: 0.5,
  maxDailyLossR: 2,
  minSampleTrades: 100,
  minProfitFactor: 1.5,
  maxDrawdownR: 8,
};

const CANDLES = [
  [42, 210, 190, 221, 181],
  [62, 190, 202, 181, 212],
  [82, 202, 184, 211, 176],
  [102, 184, 170, 193, 160],
  [122, 170, 177, 160, 187],
  [142, 177, 160, 186, 151],
  [162, 160, 146, 169, 137],
  [182, 146, 153, 137, 164],
  [202, 153, 166, 143, 176],
  [222, 166, 181, 156, 191],
  [242, 181, 207, 171, 219],
  [262, 207, 226, 196, 239],
  [282, 226, 203, 239, 194],
  [302, 203, 194, 213, 184],
  [322, 194, 201, 184, 211],
  [342, 201, 188, 211, 178],
  [362, 188, 169, 199, 159],
  [382, 169, 151, 179, 141],
  [402, 151, 158, 141, 168],
  [422, 158, 137, 168, 127],
  [442, 137, 120, 147, 110],
  [462, 120, 128, 110, 138],
  [482, 128, 104, 138, 94],
  [502, 104, 87, 114, 77],
  [522, 87, 96, 77, 106],
  [542, 96, 72, 106, 62],
] as const;

function classNames(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(" ");
}

function normalizeSymbols(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\s,]+/)
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  );
}

function FieldLabel({ children, wired = false }: { children: React.ReactNode; wired?: boolean }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[#8190a7]">
      <span>{children}</span>
      {wired ? <span className="rounded-full bg-[#2fbf71]/10 px-2 py-0.5 text-[9px] text-[#62d894]">Runner wired</span> : null}
    </div>
  );
}

function StatusBadge({ children, tone }: { children: React.ReactNode; tone: "green" | "gold" | "blue" | "muted" }) {
  const tones = {
    green: "border-[#2fbf71]/30 bg-[#2fbf71]/10 text-[#62d894]",
    gold: "border-[#d9a441]/30 bg-[#d9a441]/10 text-[#f2c873]",
    blue: "border-[#3b82f6]/30 bg-[#3b82f6]/10 text-[#80b4ff]",
    muted: "border-white/10 bg-white/[0.035] text-[#93a1b6]",
  };
  return <span className={classNames("rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em]", tones[tone])}>{children}</span>;
}

function MetricCard({ label, value, note, tone = "neutral" }: { label: string; value: string; note: string; tone?: "neutral" | "green" | "gold" }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0d1118] p-4">
      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#718096]">{label}</div>
      <div className={classNames("mt-2 text-lg font-semibold", tone === "green" ? "text-[#62d894]" : tone === "gold" ? "text-[#f2c873]" : "text-white")}>{value}</div>
      <div className="mt-1 text-xs text-[#7f8ca3]">{note}</div>
    </div>
  );
}

function SetupPreview({ direction }: { direction: Direction }) {
  const flipY = (value: number) => (direction === "SELL" ? 300 - value : value);
  const levelLabels = [
    { y: 58, label: "T3 · external liquidity", color: "#2fbf71" },
    { y: 92, label: "T2 · 1H draw", color: "#2fbf71" },
    { y: 126, label: "T1 · intraday liquidity", color: "#2fbf71" },
    { y: 192, label: "Entry · confirmed FVG retest", color: "#f2c873" },
    { y: 238, label: "SL1 · 5M reaction", color: "#ff7378" },
    { y: 270, label: "SL2 · 30M / 1H structure", color: "#e5484d" },
  ];

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-[#090d14]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-white">ICT execution schematic</div>
          <div className="mt-0.5 text-[11px] text-[#7f8ca3]">Illustrative structure—not live market data</div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge tone="blue">30M setup</StatusBadge>
          <StatusBadge tone="green">5M entry</StatusBadge>
        </div>
      </div>
      <div className="relative overflow-x-auto p-3">
        <svg viewBox="0 0 720 310" className="h-auto w-full min-w-[560px]" role="img" aria-label={`${direction} S-ICT FVG execution schematic`}>
          <defs>
            <linearGradient id="chartFade" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#111a27" />
              <stop offset="100%" stopColor="#0a0f17" />
            </linearGradient>
            <marker id="arrowGold" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#d9a441" />
            </marker>
          </defs>
          <rect x="0" y="0" width="720" height="310" rx="10" fill="url(#chartFade)" />
          {[48, 96, 144, 192, 240, 288].map((y) => <line key={y} x1="20" x2="700" y1={y} y2={y} stroke="#263142" strokeWidth="1" />)}
          {[100, 200, 300, 400, 500, 600].map((x) => <line key={x} x1={x} x2={x} y1="16" y2="292" stroke="#1b2431" strokeWidth="1" strokeDasharray="3 5" />)}

          <rect x="214" y={Math.min(flipY(206), flipY(236))} width="166" height="30" rx="4" fill="#3b82f61c" stroke="#5597ff" strokeDasharray="5 4" />
          <text x="222" y={flipY(225)} fill="#80b4ff" fontSize="10" fontWeight="700">30M SWEEP-ORIGIN OB</text>
          <rect x="368" y={Math.min(flipY(164), flipY(188))} width="102" height="24" rx="4" fill="#2fbf711c" stroke="#2fbf71" strokeDasharray="5 4" />
          <text x="376" y={flipY(180)} fill="#62d894" fontSize="10" fontWeight="700">5M FVG</text>

          {CANDLES.map(([x, open, close, high, low]) => {
            const mappedOpen = flipY(open);
            const mappedClose = flipY(close);
            const mappedHigh = flipY(high);
            const mappedLow = flipY(low);
            const isUp = direction === "BUY" ? close < open : close > open;
            const top = Math.min(mappedOpen, mappedClose);
            const bottom = Math.max(mappedOpen, mappedClose);
            return (
              <g key={x}>
                <line x1={x + 4} x2={x + 4} y1={Math.min(mappedHigh, mappedLow)} y2={Math.max(mappedHigh, mappedLow)} stroke={isUp ? "#50d3a1" : "#8c9bb0"} strokeWidth="1" />
                <rect x={x} y={top} width="8" height={Math.max(3, bottom - top)} rx="1" fill={isUp ? "#35c98e" : "#718096"} />
              </g>
            );
          })}

          <line x1="270" y1={flipY(247)} x2="270" y2={flipY(221)} stroke="#d9a441" strokeWidth="2" />
          <circle cx="270" cy={flipY(247)} r="5" fill="#0a0f17" stroke="#d9a441" strokeWidth="2" />
          <text x="282" y={flipY(250)} fill="#f2c873" fontSize="10" fontWeight="700">Liquidity sweep</text>
          <path d={`M 318 ${flipY(205)} C 340 ${flipY(190)}, 350 ${flipY(178)}, 370 ${flipY(171)}`} fill="none" stroke="#d9a441" strokeWidth="1.5" strokeDasharray="4 4" markerEnd="url(#arrowGold)" />
          <text x="324" y={flipY(158)} fill="#f2c873" fontSize="10" fontWeight="700">MSS / BOS</text>

          {levelLabels.map((level) => {
            const y = flipY(level.y);
            return (
              <g key={level.label}>
                <line x1="470" x2="700" y1={y} y2={y} stroke={level.color} strokeWidth="1" strokeDasharray="5 4" />
                <rect x="534" y={y - 10} width="165" height="19" rx="4" fill="#0a0f17" stroke={level.color} strokeOpacity="0.65" />
                <text x="542" y={y + 3.5} fill={level.color} fontSize="9.5" fontWeight="700">{level.label}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="grid gap-px border-t border-white/10 bg-white/10 sm:grid-cols-3">
        <div className="bg-[#0d1118] px-4 py-3 text-xs text-[#93a1b6]"><span className="font-semibold text-white">Direction</span><br />Derived from Daily structure</div>
        <div className="bg-[#0d1118] px-4 py-3 text-xs text-[#93a1b6]"><span className="font-semibold text-white">Confirmation</span><br />5M MSS + fresh FVG</div>
        <div className="bg-[#0d1118] px-4 py-3 text-xs text-[#93a1b6]"><span className="font-semibold text-white">Fill</span><br />Next 5M bar open</div>
      </div>
    </div>
  );
}

export default function SictStrategyBuilder({ onOpenBacktest }: { onOpenBacktest: () => void }) {
  const [config, setConfig] = useState<BuilderConfig>(DEFAULT_CONFIG);
  const [direction, setDirection] = useState<Direction>("BUY");
  const [outputView, setOutputView] = useState<OutputView>("powershell");
  const [preflightRun, setPreflightRun] = useState(false);
  const [notice, setNotice] = useState("");

  function updateConfig<K extends keyof BuilderConfig>(key: K, value: BuilderConfig[K]) {
    setConfig((current) => ({ ...current, [key]: value }));
    setPreflightRun(false);
    setNotice("");
  }

  const symbols = useMemo(() => normalizeSymbols(config.symbols), [config.symbols]);
  const blockers = useMemo(() => {
    const items: string[] = [];
    if (symbols.length === 0) items.push("Add at least one symbol.");
    if (symbols.some((symbol) => !/^[A-Z0-9.^=\-]{1,20}$/.test(symbol))) items.push("Symbols may only contain letters, numbers, dots, dashes, ^, or =.");
    if (!config.startDate || !config.endDate || config.startDate > config.endDate) items.push("Choose a valid date range.");
    if (config.outputTarget === "production_ready" && !config.productionAcknowledged) items.push("Acknowledge the production-ready output target.");
    if (config.riskPerTradePct <= 0 || config.riskPerTradePct > 2) items.push("Review policy risk per trade must be greater than 0% and no more than 2%.");
    if (config.maxDailyLossR < 1) items.push("Review policy daily loss limit must be at least 1R.");
    if (config.minSampleTrades < 30) items.push("Promotion sample must contain at least 30 completed trades.");
    if (config.minProfitFactor < 1) items.push("Promotion profit factor must be at least 1.0.");
    if (config.maxDrawdownR <= 0) items.push("Maximum drawdown policy must be greater than 0R.");
    return items;
  }, [config, symbols]);

  const warnings = useMemo(() => {
    const items: string[] = [];
    if (!config.requireSweep) items.push("Sweep is disabled as a research override; this weakens the approved S-ICT contract.");
    if (config.entryMode === "both") items.push("Research mode also evaluates iFVG entries. The website chart remains FVG-only.");
    if (config.market === "forex") items.push("Confirm that the selected Forex symbols exist in the historical data source before running.");
    return items;
  }, [config.entryMode, config.market, config.requireSweep]);

  const rules: Rule[] = useMemo(
    () => [
      { step: "01", timeframe: "Weekly", title: "Macro context", detail: "Weekly structure remains optional context and never overrides the Daily gate.", status: "fixed" },
      { step: "02", timeframe: "Daily", title: "Directional bias", detail: "BUY or SELL is derived from completed Daily structure—not from this preview toggle.", status: "fixed" },
      { step: "03", timeframe: "1H", title: "Untapped liquidity draw", detail: "Require target-side liquidity using a 240-bar lookback with at least one valid draw.", status: "fixed" },
      { step: "04", timeframe: "30M", title: "Sweep-origin OB + BOS", detail: "Origin candle must show 1.5× average body displacement and structure break within 20 bars.", status: "fixed" },
      { step: "05", timeframe: "1H / 30M", title: config.requireSweep ? "Completed HTF sweep required" : "Sweep research override", detail: config.requireSweep ? "At least one completed 1H or 30M sweep must be present." : "Backend override ICT_SICT_REQUIRE_SWEEP=0 will allow unswept setups.", status: "wired" },
      { step: "06", timeframe: "5M", title: "Return to fresh OB", detail: `Search the most recent ${config.returnWindowBars} five-minute bars after BOS for a valid, non-invalidated return.`, status: "wired" },
      { step: "07", timeframe: "5M", title: config.entryMode === "conservative" ? "Local sweep + MSS + fresh FVG" : "FVG + iFVG research branches", detail: config.entryMode === "conservative" ? "Conservative FVG branch only; confirmation must occur within 48 bars." : "Backend evaluates both confirmed FVG and aggressive iFVG branches; visual preview remains FVG-only.", status: "wired" },
      { step: "08", timeframe: "5M", title: "Confirmed retest and executable fill", detail: "Entry is confirmed on the FVG retest close and filled at the next 5M bar open.", status: "fixed" },
      { step: "09", timeframe: "5M → 1H", title: "Structural risk and real targets", detail: "SL1 uses 5M reaction structure, SL2 uses 30M/1H structure, and T1–T3 use real untapped liquidity only.", status: "fixed" },
    ],
    [config.entryMode, config.requireSweep, config.returnWindowBars],
  );

  const generatedConfig = useMemo(
    () => ({
      schema_version: "sict.ui.v3",
      strategy_id: "S-ICT",
      family: "s21_s33",
      market: config.market,
      symbols,
      date_range: { start: config.startDate, end: config.endDate },
      output_target: config.outputTarget,
      runner: { workers: config.workers, no_resume: true, include_orders: true },
      connected_parameters: {
        require_sweep: config.requireSweep,
        return_window_bars: config.returnWindowBars,
        entry_mode: config.entryMode,
      },
      fixed_backend_contract: {
        direction: "derived_from_daily_bias",
        weekly_bias: "optional_context",
        daily_bias: "required",
        h1_target_liquidity: { required: true, lookback_bars: 240, min_draws: 1 },
        setup_timeframe: "30m",
        execution_timeframe: "5m",
        origin_body_avg20: 1.5,
        bos_lookback_bars: 20,
        mss_max_bars: 48,
        conservative_confirmation: "local_sweep_mss_fresh_fvg",
        entry_signal: "confirmed_fvg_retest_close",
        fill: "next_5m_bar_open",
        stop_model: "sl1_5m_reaction__sl2_30m_or_1h",
        targets: "three_real_untapped_liquidity_levels",
        synthetic_rr_projection: false,
      },
      review_policy_not_enforced_by_runner: {
        risk_per_trade_pct: config.riskPerTradePct,
        max_daily_loss_r: config.maxDailyLossR,
        promotion_min_completed_trades: config.minSampleTrades,
        promotion_min_profit_factor: config.minProfitFactor,
        promotion_max_drawdown_r: config.maxDrawdownR,
        requires_positive_expectancy: true,
        requires_walk_forward_validation: true,
      },
    }),
    [config, symbols],
  );

  const jsonOutput = useMemo(() => JSON.stringify(generatedConfig, null, 2), [generatedConfig]);
  const powershellOutput = useMemo(
    () => [
      `$env:ICT_OUTPUT_TARGET = "${config.outputTarget}"`,
      `$env:ICT_S21S33_STRATEGIES = "S-ICT"`,
      `$env:ICT_SICT_REQUIRE_SWEEP = "${config.requireSweep ? "1" : "0"}"`,
      `$env:ICT_SICT_RETURN_WINDOW_BARS = "${config.returnWindowBars}"`,
      `$env:ICT_SICT_ENTRY_MODE = "${config.entryMode}"`,
      "",
      `python .\\run_updated_backtest.py --market ${config.market} --start_date ${config.startDate} --end_date ${config.endDate} \``,
      `  --families s21_s33 --symbols ${symbols.join(",")} --workers ${config.workers} --no-resume`,
    ].join("\n"),
    [config, symbols],
  );
  const wiringOutput = [
    "CONNECTED TO BACKEND",
    "• Market, symbols, date range, workers → run_updated_backtest.py CLI",
    "• Output target → ICT_OUTPUT_TARGET",
    "• Strategy selection → ICT_S21S33_STRATEGIES=S-ICT",
    "• HTF sweep gate → ICT_SICT_REQUIRE_SWEEP",
    "• 5M return scan → ICT_SICT_RETURN_WINDOW_BARS",
    "• Entry branch → ICT_SICT_ENTRY_MODE",
    "",
    "FIXED BY S-ICT CONTRACT",
    "• Daily direction; 1H target liquidity; 30M OB/displacement/BOS",
    "• 48-bar MSS window; confirmed FVG retest; next-5M-open fill",
    "• SL1/SL2 structural stops; three real liquidity targets",
    "",
    "REVIEW POLICY ONLY",
    "• Risk %, daily loss, sample size, PF, drawdown, and walk-forward gates",
    "• These values travel in JSON but are not passed to the historical runner.",
  ].join("\n");
  const activeOutput = outputView === "powershell" ? powershellOutput : outputView === "json" ? jsonOutput : wiringOutput;

  function runPreflight() {
    setPreflightRun(true);
    setNotice(blockers.length === 0 ? "Preflight passed. Configuration is ready for a scratch backtest." : "Preflight found blocking issues.");
  }

  async function copyOutput() {
    await navigator.clipboard.writeText(activeOutput);
    setNotice(`${outputView === "powershell" ? "PowerShell" : outputView === "json" ? "JSON" : "Wiring map"} copied.`);
  }

  function downloadJson() {
    const blob = new Blob([jsonOutput], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "s-ict-backtest-config.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("Configuration JSON downloaded.");
  }

  function saveDraft() {
    localStorage.setItem("algo-ict-sict-builder", JSON.stringify(config));
    setNotice("Draft saved in this browser.");
  }

  function loadDraft() {
    const raw = localStorage.getItem("algo-ict-sict-builder");
    if (!raw) {
      setNotice("No saved Strategy Builder draft was found.");
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<BuilderConfig>;
      setConfig({ ...DEFAULT_CONFIG, ...parsed });
      setPreflightRun(false);
      setNotice("Saved draft loaded.");
    } catch {
      setNotice("The saved draft could not be read.");
    }
  }

  function resetBuilder() {
    setConfig(DEFAULT_CONFIG);
    setDirection("BUY");
    setOutputView("powershell");
    setPreflightRun(false);
    setNotice("Builder reset to the conservative S-ICT contract.");
  }

  const preflightLabel = !preflightRun ? "Not validated" : blockers.length === 0 ? "Ready for backtest" : `${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`;

  return (
    <div className="mx-auto max-w-[1580px] space-y-5">
      <section className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0d1118] p-5 md:p-6">
        <div className="pointer-events-none absolute right-0 top-0 size-72 -translate-y-1/2 translate-x-1/3 rounded-full bg-[#d9a441]/10 blur-3xl" />
        <div className="relative flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <StatusBadge tone="gold">S-ICT</StatusBadge>
              <StatusBadge tone="blue">30M → 5M</StatusBadge>
              <StatusBadge tone="muted">Backtest configuration</StatusBadge>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">Strategy Builder</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#93a1b6]">
              Build a reproducible sweep-origin order-block setup, validate its contract, and hand the exact configuration to the existing historical runner. The builder does not place live trades.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={loadDraft} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-semibold text-[#c8d0dc] transition hover:bg-white/[0.07]"><RefreshCcw className="size-3.5" />Load draft</button>
            <button onClick={saveDraft} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-semibold text-[#c8d0dc] transition hover:bg-white/[0.07]"><Save className="size-3.5" />Save draft</button>
            <button onClick={resetBuilder} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-semibold text-[#c8d0dc] transition hover:bg-white/[0.07]"><RefreshCcw className="size-3.5" />Reset</button>
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Preflight" value={preflightLabel} note={preflightRun ? (blockers.length === 0 ? "Contract and inputs passed" : "Resolve before execution") : "Run after final edits"} tone={preflightRun && blockers.length === 0 ? "green" : "neutral"} />
        <MetricCard label="Entry model" value={config.entryMode === "conservative" ? "FVG only" : "FVG + iFVG"} note={config.entryMode === "conservative" ? "Conservative branch" : "Research branch; chart stays FVG-only"} tone={config.entryMode === "conservative" ? "green" : "gold"} />
        <MetricCard label="Sweep contract" value={config.requireSweep ? "Required" : "Override"} note="Completed 1H or 30M liquidity event" tone={config.requireSweep ? "green" : "gold"} />
        <MetricCard label="Output" value={config.outputTarget === "updated" ? "Scratch tables" : "Production-ready"} note={config.outputTarget === "updated" ? "Safe A/B research destination" : "Protected destination"} tone={config.outputTarget === "updated" ? "neutral" : "gold"} />
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(360px,0.8fr)_minmax(640px,1.35fr)]">
        <div className="space-y-5">
          <div className="rounded-2xl border border-white/10 bg-[#0d1118]">
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
              <div className="flex items-center gap-2.5"><Settings2 className="size-4 text-[#f2c873]" /><div><h2 className="text-sm font-semibold text-white">Run configuration</h2><p className="text-[11px] text-[#718096]">Only controls supported by the runner</p></div></div>
              <StatusBadge tone="green">Wired</StatusBadge>
            </div>
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <label className="sm:col-span-2">
                <FieldLabel wired>Symbols</FieldLabel>
                <input value={config.symbols} onChange={(event) => updateConfig("symbols", event.target.value)} placeholder="AAPL, MSFT, CVX" className="w-full rounded-lg border border-white/10 bg-[#090d14] px-3 py-2.5 text-sm text-white outline-none transition placeholder:text-[#4f5c70] focus:border-[#d9a441]/60" />
                <span className="mt-1.5 block text-[11px] text-[#657187]">{symbols.length} normalized symbol{symbols.length === 1 ? "" : "s"}: {symbols.join(", ") || "none"}</span>
              </label>
              <label>
                <FieldLabel wired>Market</FieldLabel>
                <select value={config.market} onChange={(event) => updateConfig("market", event.target.value as Market)} className="w-full rounded-lg border border-white/10 bg-[#090d14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#d9a441]/60"><option value="us">US equities</option><option value="forex">Forex</option></select>
              </label>
              <label>
                <FieldLabel wired>Workers</FieldLabel>
                <select value={config.workers} onChange={(event) => updateConfig("workers", Number(event.target.value))} className="w-full rounded-lg border border-white/10 bg-[#090d14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#d9a441]/60"><option value={1}>1 · diagnostic</option><option value={3}>3 · standard</option><option value={8}>8 · high throughput</option></select>
              </label>
              <label>
                <FieldLabel wired>Start date</FieldLabel>
                <input type="date" value={config.startDate} onChange={(event) => updateConfig("startDate", event.target.value)} className="w-full rounded-lg border border-white/10 bg-[#090d14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#d9a441]/60" />
              </label>
              <label>
                <FieldLabel wired>End date</FieldLabel>
                <input type="date" value={config.endDate} onChange={(event) => updateConfig("endDate", event.target.value)} className="w-full rounded-lg border border-white/10 bg-[#090d14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#d9a441]/60" />
              </label>
              <label>
                <FieldLabel wired>Return window</FieldLabel>
                <select value={config.returnWindowBars} onChange={(event) => updateConfig("returnWindowBars", Number(event.target.value))} className="w-full rounded-lg border border-white/10 bg-[#090d14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#d9a441]/60"><option value={160}>160 bars</option><option value={200}>200 bars</option><option value={260}>260 bars · default</option><option value={320}>320 bars</option></select>
              </label>
              <label>
                <FieldLabel wired>Entry branch</FieldLabel>
                <select value={config.entryMode} onChange={(event) => updateConfig("entryMode", event.target.value as EntryMode)} className="w-full rounded-lg border border-white/10 bg-[#090d14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#d9a441]/60"><option value="conservative">Conservative · FVG</option><option value="both">Research · FVG + iFVG</option></select>
              </label>
              <label className="sm:col-span-2">
                <FieldLabel wired>Output target</FieldLabel>
                <select value={config.outputTarget} onChange={(event) => updateConfig("outputTarget", event.target.value as OutputTarget)} className="w-full rounded-lg border border-white/10 bg-[#090d14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#d9a441]/60"><option value="updated">updated · scratch A/B tables</option><option value="production_ready">production_ready · protected tables</option></select>
              </label>
              <button type="button" onClick={() => updateConfig("requireSweep", !config.requireSweep)} className={classNames("sm:col-span-2 flex items-center justify-between gap-4 rounded-xl border p-3 text-left transition", config.requireSweep ? "border-[#2fbf71]/30 bg-[#2fbf71]/[0.07]" : "border-[#d9a441]/35 bg-[#d9a441]/[0.07]") }>
                <span><span className="block text-xs font-semibold text-white">Require completed HTF sweep</span><span className="mt-1 block text-[11px] text-[#7f8ca3]">Approved contract expects a completed 1H or 30M sweep.</span></span>
                <span className={classNames("grid size-6 shrink-0 place-items-center rounded-full", config.requireSweep ? "bg-[#2fbf71] text-[#07130d]" : "border border-[#d9a441]/60 text-[#f2c873]")}>{config.requireSweep ? <Check className="size-4" /> : "0"}</span>
              </button>
              {config.outputTarget === "production_ready" ? (
                <label className="sm:col-span-2 flex cursor-pointer items-start gap-3 rounded-xl border border-[#d9a441]/35 bg-[#d9a441]/[0.07] p-3">
                  <input type="checkbox" checked={config.productionAcknowledged} onChange={(event) => updateConfig("productionAcknowledged", event.target.checked)} className="mt-0.5 size-4 accent-[#d9a441]" />
                  <span><span className="block text-xs font-semibold text-[#f2c873]">I understand this changes the database destination</span><span className="mt-1 block text-[11px] leading-5 text-[#9a8b6d]">This builder still only generates a command. It never launches the backend from the browser.</span></span>
                </label>
              ) : null}
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0d1118]">
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
              <div className="flex items-center gap-2.5"><ShieldCheck className="size-4 text-[#62d894]" /><div><h2 className="text-sm font-semibold text-white">Capital protection policy</h2><p className="text-[11px] text-[#718096]">Saved in JSON; not enforced by runner</p></div></div>
              <StatusBadge tone="muted">Review only</StatusBadge>
            </div>
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <label><FieldLabel>Risk / trade</FieldLabel><div className="relative"><input type="number" min="0.05" max="2" step="0.05" value={config.riskPerTradePct} onChange={(event) => updateConfig("riskPerTradePct", Number(event.target.value))} className="w-full rounded-lg border border-white/10 bg-[#090d14] px-3 py-2.5 pr-9 text-sm text-white outline-none focus:border-[#d9a441]/60" /><span className="absolute right-3 top-2.5 text-sm text-[#718096]">%</span></div></label>
              <label><FieldLabel>Daily stop</FieldLabel><div className="relative"><input type="number" min="1" max="10" step="0.5" value={config.maxDailyLossR} onChange={(event) => updateConfig("maxDailyLossR", Number(event.target.value))} className="w-full rounded-lg border border-white/10 bg-[#090d14] px-3 py-2.5 pr-9 text-sm text-white outline-none focus:border-[#d9a441]/60" /><span className="absolute right-3 top-2.5 text-sm text-[#718096]">R</span></div></label>
              <label><FieldLabel>Min sample</FieldLabel><input type="number" min="30" step="10" value={config.minSampleTrades} onChange={(event) => updateConfig("minSampleTrades", Number(event.target.value))} className="w-full rounded-lg border border-white/10 bg-[#090d14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#d9a441]/60" /></label>
              <label><FieldLabel>Min profit factor</FieldLabel><input type="number" min="1" step="0.1" value={config.minProfitFactor} onChange={(event) => updateConfig("minProfitFactor", Number(event.target.value))} className="w-full rounded-lg border border-white/10 bg-[#090d14] px-3 py-2.5 text-sm text-white outline-none focus:border-[#d9a441]/60" /></label>
              <label className="sm:col-span-2"><FieldLabel>Max acceptable drawdown</FieldLabel><div className="relative"><input type="number" min="1" step="0.5" value={config.maxDrawdownR} onChange={(event) => updateConfig("maxDrawdownR", Number(event.target.value))} className="w-full rounded-lg border border-white/10 bg-[#090d14] px-3 py-2.5 pr-9 text-sm text-white outline-none focus:border-[#d9a441]/60" /><span className="absolute right-3 top-2.5 text-sm text-[#718096]">R</span></div></label>
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <div className="rounded-2xl border border-white/10 bg-[#0d1118] p-4 md:p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5"><Waypoints className="size-4 text-[#80b4ff]" /><div><h2 className="text-sm font-semibold text-white">Setup preview</h2><p className="text-[11px] text-[#718096]">Direction toggle changes the illustration only</p></div></div>
              <div className="inline-flex rounded-lg border border-white/10 bg-[#090d14] p-1">
                <button onClick={() => setDirection("BUY")} className={classNames("inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition", direction === "BUY" ? "bg-[#2fbf71]/20 text-[#62d894]" : "text-[#718096] hover:text-white")}><ArrowUp className="size-3.5" />BUY</button>
                <button onClick={() => setDirection("SELL")} className={classNames("inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition", direction === "SELL" ? "bg-[#e5484d]/20 text-[#ff8b91]" : "text-[#718096] hover:text-white")}><ArrowDown className="size-3.5" />SELL</button>
              </div>
            </div>
            <SetupPreview direction={direction} />
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0d1118]">
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
              <div className="flex items-center gap-2.5"><Layers3 className="size-4 text-[#f2c873]" /><div><h2 className="text-sm font-semibold text-white">Execution contract</h2><p className="text-[11px] text-[#718096]">Required sequence from HTF draw to 5M fill</p></div></div>
              <div className="hidden items-center gap-1 text-[10px] font-semibold text-[#718096] sm:flex"><span className="text-[#62d894]">Wired</span><span>·</span><span>Fixed</span></div>
            </div>
            <div className="divide-y divide-white/[0.07]">
              {rules.map((rule) => (
                <div key={rule.step} className="grid gap-3 px-5 py-4 sm:grid-cols-[38px_74px_minmax(0,1fr)_auto] sm:items-start">
                  <div className="grid size-8 place-items-center rounded-lg border border-white/10 bg-[#090d14] font-mono text-[10px] font-bold text-[#718096]">{rule.step}</div>
                  <div className="pt-1 font-mono text-[11px] font-semibold text-[#80b4ff]">{rule.timeframe}</div>
                  <div><div className="text-xs font-semibold text-white">{rule.title}</div><p className="mt-1 text-[11px] leading-5 text-[#7f8ca3]">{rule.detail}</p></div>
                  <StatusBadge tone={rule.status === "wired" ? "green" : "muted"}>{rule.status}</StatusBadge>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(360px,0.72fr)_minmax(620px,1.28fr)]">
        <div className="rounded-2xl border border-white/10 bg-[#0d1118]">
          <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
            <div className="flex items-center gap-2.5"><FlaskConical className="size-4 text-[#80b4ff]" /><div><h2 className="text-sm font-semibold text-white">Preflight & promotion gates</h2><p className="text-[11px] text-[#718096]">Configuration first, profitability evidence second</p></div></div>
          </div>
          <div className="space-y-3 p-5">
            {blockers.length > 0 ? blockers.map((item) => <div key={item} className="flex gap-2.5 rounded-lg border border-[#e5484d]/25 bg-[#e5484d]/[0.06] p-3 text-xs leading-5 text-[#ff9a9e]"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{item}</div>) : <div className="flex gap-2.5 rounded-lg border border-[#2fbf71]/25 bg-[#2fbf71]/[0.06] p-3 text-xs leading-5 text-[#76dda2]"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />No configuration blockers detected.</div>}
            {warnings.map((item) => <div key={item} className="flex gap-2.5 rounded-lg border border-[#d9a441]/25 bg-[#d9a441]/[0.06] p-3 text-xs leading-5 text-[#dcbf82]"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{item}</div>)}
            <div className="mt-4 space-y-2 border-t border-white/10 pt-4">
              {[
                `${config.minSampleTrades}+ completed out-of-sample trades`,
                `Profit factor ≥ ${config.minProfitFactor.toFixed(1)} and positive expectancy`,
                `Maximum drawdown ≤ ${config.maxDrawdownR}R`,
                "Stable BUY/SELL and symbol-level contribution",
                "Walk-forward pass, then paper-trading fill audit",
              ].map((gate) => <div key={gate} className="flex items-center gap-2.5 text-xs text-[#93a1b6]"><span className="grid size-5 shrink-0 place-items-center rounded-full border border-white/10 bg-[#090d14] text-[10px] text-[#657187]">—</span>{gate}</div>)}
            </div>
            <button onClick={runPreflight} className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#d9a441] px-4 py-2.5 text-xs font-bold text-[#151108] transition hover:bg-[#e8b85a]"><ShieldCheck className="size-4" />Run configuration preflight</button>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#0d1118]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
            <div className="flex items-center gap-2.5"><Code2 className="size-4 text-[#62d894]" /><div><h2 className="text-sm font-semibold text-white">Generated handoff</h2><p className="text-[11px] text-[#718096]">Copy into the existing Backtesting_ICT_2017 workflow</p></div></div>
            <div className="flex flex-wrap gap-2">
              <button onClick={copyOutput} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-semibold text-[#c8d0dc] hover:bg-white/[0.07]"><Clipboard className="size-3.5" />Copy</button>
              <button onClick={downloadJson} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-semibold text-[#c8d0dc] hover:bg-white/[0.07]"><Download className="size-3.5" />JSON</button>
            </div>
          </div>
          <div className="flex gap-1 border-b border-white/10 px-4 pt-3">
            {(["powershell", "json", "wiring"] as OutputView[]).map((view) => <button key={view} onClick={() => setOutputView(view)} className={classNames("rounded-t-lg border-b-2 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.08em] transition", outputView === view ? "border-[#d9a441] text-[#f2c873]" : "border-transparent text-[#718096] hover:text-white")}>{view}</button>)}
          </div>
          <pre className="max-h-[420px] min-h-[330px] overflow-auto whitespace-pre-wrap break-words bg-[#090d14] p-5 font-mono text-[11px] leading-5 text-[#b8c3d2]">{activeOutput}</pre>
          <div className="grid gap-px border-t border-white/10 bg-white/10 sm:grid-cols-3">
            <div className="flex items-start gap-2 bg-[#0d1118] p-4"><GitBranch className="mt-0.5 size-4 shrink-0 text-[#80b4ff]" /><div><div className="text-xs font-semibold text-white">Scratch first</div><div className="mt-1 text-[11px] leading-4 text-[#718096]">Default writes to updated A/B tables.</div></div></div>
            <div className="flex items-start gap-2 bg-[#0d1118] p-4"><LockKeyhole className="mt-0.5 size-4 shrink-0 text-[#f2c873]" /><div><div className="text-xs font-semibold text-white">No browser launch</div><div className="mt-1 text-[11px] leading-4 text-[#718096]">Operator executes the generated command.</div></div></div>
            <div className="flex items-start gap-2 bg-[#0d1118] p-4"><Target className="mt-0.5 size-4 shrink-0 text-[#62d894]" /><div><div className="text-xs font-semibold text-white">Real targets</div><div className="mt-1 text-[11px] leading-4 text-[#718096]">No synthetic RR projections.</div></div></div>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-4 rounded-2xl border border-[#2fbf71]/20 bg-[#2fbf71]/[0.05] p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3"><div className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#2fbf71]/15 text-[#62d894]"><Sparkles className="size-5" /></div><div><h2 className="text-sm font-semibold text-white">Next: validate the generated package</h2><p className="mt-1 max-w-2xl text-xs leading-5 text-[#8da699]">A valid configuration is not evidence of an edge. Run it in the Backtest tab, inspect expectancy and drawdown, then promote only after the policy gates pass.</p></div></div>
        <button onClick={onOpenBacktest} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-[#2fbf71]/35 bg-[#2fbf71]/15 px-4 py-2.5 text-xs font-bold text-[#76dda2] transition hover:bg-[#2fbf71]/25"><Play className="size-4" />Open Backtest<ArrowRight className="size-3.5" /></button>
      </section>

      {notice ? <div className="fixed bottom-5 right-5 z-50 flex max-w-sm items-center gap-2 rounded-xl border border-white/10 bg-[#121823] px-4 py-3 text-xs text-white shadow-2xl"><CheckCircle2 className="size-4 shrink-0 text-[#62d894]" />{notice}</div> : null}
    </div>
  );
}
