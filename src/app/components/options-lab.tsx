"use client";

import { BookOpen, FlaskConical, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/* ============================== pricing ==================================
   Black-Scholes (r=0, q=0) for default premiums and the T+0 curve.       */

function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

function bsPrice(kind: "CE" | "PE", S: number, K: number, ivPct: number, dteDays: number): number {
  const T = Math.max(dteDays, 0.01) / 365;
  const sigma = Math.max(ivPct, 1) / 100;
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const call = S * normCdf(d1) - K * normCdf(d2);
  return kind === "CE" ? Math.max(call, 0) : Math.max(call - S + K, 0); // put-call parity, r=0
}

/* ============================== types ==================================== */

type Leg = {
  id: number;
  kind: "CE" | "PE" | "FUT";
  side: 1 | -1; // 1 = buy, -1 = sell
  strike: number;
  premium: number; // per unit; FUT uses entry price in `strike`, premium 0
  lots: number;
  auto: boolean; // premium auto-priced from BS until user edits
};

type Preset = {
  id: string;
  name: string;
  view: "Bullish" | "Bearish" | "Neutral" | "Volatile" | "Hedge";
  summary: string;
  whenToUse: string;
  risk: string;
  reward: string;
  hedgeNote?: string;
  build: (atm: number, step: number) => Omit<Leg, "id" | "premium" | "auto">[];
};

/* ============================== course content =========================== */

const PRESETS: Preset[] = [
  {
    id: "long-call", name: "Long Call", view: "Bullish",
    summary: "Buy a call to profit from a rise. Loss capped at premium paid.",
    whenToUse: "Strong directional bullish view with defined risk; cheap way to express upside.",
    risk: "Limited to premium", reward: "Unlimited",
    build: (atm, s) => [{ kind: "CE", side: 1, strike: atm, lots: 1 }],
  },
  {
    id: "long-put", name: "Long Put", view: "Bearish",
    summary: "Buy a put to profit from a fall. Loss capped at premium paid.",
    whenToUse: "Directional bearish view, or as portfolio insurance against a drop.",
    risk: "Limited to premium", reward: "Large (down to zero)",
    hedgeNote: "The building block of most hedges: a put under a long portfolio caps downside.",
    build: (atm, s) => [{ kind: "PE", side: 1, strike: atm, lots: 1 }],
  },
  {
    id: "covered-call", name: "Covered Call", view: "Hedge",
    summary: "Hold the underlying, sell an OTM call. Premium income cushions small dips, caps upside.",
    whenToUse: "Mildly bullish/neutral on stock you already own; generate income.",
    risk: "Stock downside minus premium", reward: "Capped at strike + premium",
    hedgeNote: "First hedging course lesson: monetize holdings while accepting an upside cap.",
    build: (atm, s) => [
      { kind: "FUT", side: 1, strike: atm, lots: 1 },
      { kind: "CE", side: -1, strike: atm + 2 * s, lots: 1 },
    ],
  },
  {
    id: "protective-put", name: "Protective Put", view: "Hedge",
    summary: "Hold the underlying, buy a put. Classic insurance: downside capped, upside open.",
    whenToUse: "You want to stay invested but cap the damage of a crash or event risk.",
    risk: "Limited to (spot − strike) + premium", reward: "Unlimited upside minus premium",
    hedgeNote: "The core hedge. Cost of insurance = put premium; pick strike like a deductible.",
    build: (atm, s) => [
      { kind: "FUT", side: 1, strike: atm, lots: 1 },
      { kind: "PE", side: 1, strike: atm - 2 * s, lots: 1 },
    ],
  },
  {
    id: "collar", name: "Collar", view: "Hedge",
    summary: "Underlying + long put + short call. The short call pays for the put: cheap insurance, capped upside.",
    whenToUse: "Hedge a holding at near-zero cost ahead of uncertainty.",
    risk: "Capped below put strike", reward: "Capped above call strike",
    hedgeNote: "Zero-cost collars are the institutional standard for hedging concentrated positions.",
    build: (atm, s) => [
      { kind: "FUT", side: 1, strike: atm, lots: 1 },
      { kind: "PE", side: 1, strike: atm - 2 * s, lots: 1 },
      { kind: "CE", side: -1, strike: atm + 2 * s, lots: 1 },
    ],
  },
  {
    id: "bull-call-spread", name: "Bull Call Spread", view: "Bullish",
    summary: "Buy call, sell higher call. Cheaper than a naked call; both risk and reward defined.",
    whenToUse: "Moderately bullish to a target level; reduce premium outlay.",
    risk: "Net debit", reward: "Spread width − debit",
    build: (atm, s) => [
      { kind: "CE", side: 1, strike: atm, lots: 1 },
      { kind: "CE", side: -1, strike: atm + 2 * s, lots: 1 },
    ],
  },
  {
    id: "bear-put-spread", name: "Bear Put Spread", view: "Bearish",
    summary: "Buy put, sell lower put. Defined-risk bearish play to a downside target.",
    whenToUse: "Moderately bearish; cheaper than a naked put.",
    risk: "Net debit", reward: "Spread width − debit",
    build: (atm, s) => [
      { kind: "PE", side: 1, strike: atm, lots: 1 },
      { kind: "PE", side: -1, strike: atm - 2 * s, lots: 1 },
    ],
  },
  {
    id: "long-straddle", name: "Long Straddle", view: "Volatile",
    summary: "Buy ATM call + ATM put. Profits from a big move either way; bleeds theta if nothing happens.",
    whenToUse: "Ahead of binary events (earnings, budget, Fed) when a large move is expected.",
    risk: "Both premiums", reward: "Unlimited",
    build: (atm, s) => [
      { kind: "CE", side: 1, strike: atm, lots: 1 },
      { kind: "PE", side: 1, strike: atm, lots: 1 },
    ],
  },
  {
    id: "long-strangle", name: "Long Strangle", view: "Volatile",
    summary: "Buy OTM call + OTM put. Cheaper than a straddle, needs a bigger move.",
    whenToUse: "Expect a violent move but want lower cost than a straddle.",
    risk: "Both premiums", reward: "Unlimited",
    build: (atm, s) => [
      { kind: "CE", side: 1, strike: atm + 2 * s, lots: 1 },
      { kind: "PE", side: 1, strike: atm - 2 * s, lots: 1 },
    ],
  },
  {
    id: "short-straddle", name: "Short Straddle", view: "Neutral",
    summary: "Sell ATM call + put. Maximum theta collection; unlimited risk both sides — professionals hedge it.",
    whenToUse: "High IV, expecting a quiet expiry. Only with strict risk management.",
    risk: "Unlimited both sides", reward: "Both premiums",
    build: (atm, s) => [
      { kind: "CE", side: -1, strike: atm, lots: 1 },
      { kind: "PE", side: -1, strike: atm, lots: 1 },
    ],
  },
  {
    id: "iron-condor", name: "Iron Condor", view: "Neutral",
    summary: "Sell OTM call + put, buy further OTM wings. Defined-risk range play — the retail income workhorse.",
    whenToUse: "Range-bound market, elevated IV; you want short-straddle income with capped risk.",
    risk: "Wing width − net credit", reward: "Net credit",
    hedgeNote: "The wings ARE the hedge: they convert unlimited short-straddle risk into a fixed max loss.",
    build: (atm, s) => [
      { kind: "PE", side: 1, strike: atm - 4 * s, lots: 1 },
      { kind: "PE", side: -1, strike: atm - 2 * s, lots: 1 },
      { kind: "CE", side: -1, strike: atm + 2 * s, lots: 1 },
      { kind: "CE", side: 1, strike: atm + 4 * s, lots: 1 },
    ],
  },
  {
    id: "iron-butterfly", name: "Iron Butterfly", view: "Neutral",
    summary: "Sell ATM straddle, buy OTM wings. Bigger credit than a condor, narrower profit zone.",
    whenToUse: "Pin risk play: expect expiry very close to the ATM strike.",
    risk: "Wing width − net credit", reward: "Net credit",
    build: (atm, s) => [
      { kind: "PE", side: 1, strike: atm - 3 * s, lots: 1 },
      { kind: "PE", side: -1, strike: atm, lots: 1 },
      { kind: "CE", side: -1, strike: atm, lots: 1 },
      { kind: "CE", side: 1, strike: atm + 3 * s, lots: 1 },
    ],
  },
  {
    id: "call-butterfly", name: "Long Call Butterfly", view: "Neutral",
    summary: "Buy 1 lower call, sell 2 middle calls, buy 1 higher call. Cheap bet on expiry at the middle strike.",
    whenToUse: "Strong view that price pins a level at expiry; tiny debit, big payoff ratio.",
    risk: "Net debit", reward: "Wing width − debit",
    build: (atm, s) => [
      { kind: "CE", side: 1, strike: atm - 2 * s, lots: 1 },
      { kind: "CE", side: -1, strike: atm, lots: 2 },
      { kind: "CE", side: 1, strike: atm + 2 * s, lots: 1 },
    ],
  },
];

/* ============================== live chain =============================== */

type ChainStrike = {
  strike: number;
  ce: number | null;
  pe: number | null;
  ceMoneyness: string | null;
  peMoneyness: string | null;
  ceSymbol: string | null;
  peSymbol: string | null;
  ceToken: string | null;
  peToken: string | null;
};

type ChainData = {
  underlying: string;
  expiry: string | null;
  expiries: string[];
  asOf: string | null;
  spot: number | null;
  atm: number | null;
  step: number | null;
  lotSize: number | null;
  strikes: ChainStrike[];
  contracts: number;
  pricedContracts: number;
  source: string;
};

/* ============================== component ================================ */

let legSeq = 100;

export default function OptionsLab() {
  const [spot, setSpot] = useState(24000);
  const [lotSize, setLotSize] = useState(25);
  const [iv, setIv] = useState(15);
  const [dte, setDte] = useState(7);
  const [strikeStep, setStrikeStep] = useState(100);
  const [legs, setLegs] = useState<Leg[]>([]);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [showCourse, setShowCourse] = useState(true);

  // Live option-chain data (real premiums) with graceful fallback to BS pricing.
  const [chain, setChain] = useState<ChainData | null>(null);
  const [chainStatus, setChainStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [underlyingSym, setUnderlyingSym] = useState("ONGC");
  const [underlyingInput, setUnderlyingInput] = useState("ONGC");
  const [expiry, setExpiry] = useState("");

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({ underlying: underlyingSym, interval: "FIVE_MINUTE" });
    if (expiry) query.set("expiry", expiry);
    fetch(`/api/options-chain?${query.toString()}`)
      .then((r) => r.json())
      .then((data: ChainData & { error?: string }) => {
        if (cancelled) return;
        if (data.error || !data.strikes || data.strikes.length === 0) {
          setChainStatus("error");
          return;
        }
        setChain(data);
        setChainStatus("ready");
        // Seed the playground from real market data.
        if (data.spot != null) setSpot(data.spot);
        if (data.step != null && data.step > 0) setStrikeStep(data.step);
        if (data.lotSize != null && data.lotSize > 0) setLotSize(data.lotSize);
        if (!expiry && data.expiry) setExpiry(data.expiry);
        // Days to expiry from the real expiry date.
        if (data.expiry) {
          const days = Math.max(
            1,
            Math.round((new Date(data.expiry).getTime() - Date.now()) / 86400000),
          );
          setDte(days);
        }
      })
      .catch(() => {
        if (!cancelled) setChainStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [underlyingSym, expiry]);

  // Real premium lookup: strike+kind -> last traded close, when available.
  const realPremium = useMemo(() => {
    const map = new Map<string, number>();
    if (chain) {
      for (const s of chain.strikes) {
        if (s.ce != null) map.set(`CE:${s.strike}`, s.ce);
        if (s.pe != null) map.set(`PE:${s.strike}`, s.pe);
      }
    }
    return map;
  }, [chain]);

  const atm = chain?.atm ?? Math.round(spot / strikeStep) * strikeStep;

  function price(kind: "CE" | "PE" | "FUT", strike: number): number {
    if (kind === "FUT") return 0;
    // Prefer the real last-traded premium; fall back to Black-Scholes.
    const real = realPremium.get(`${kind}:${strike}`);
    if (real != null) return real;
    return Math.round(bsPrice(kind, spot, strike, iv, dte) * 100) / 100;
  }

  function loadPreset(p: Preset) {
    setActivePreset(p.id);
    setLegs(
      p.build(atm, strikeStep).map((l) => ({
        ...l,
        id: legSeq++,
        premium: price(l.kind, l.strike),
        auto: true,
      })),
    );
    setShowCourse(false);
  }

  function addLeg() {
    setLegs((prev) => [
      ...prev,
      { id: legSeq++, kind: "CE", side: 1, strike: atm, premium: price("CE", atm), lots: 1, auto: true },
    ]);
    setActivePreset(null);
  }

  function updateLeg(id: number, patch: Partial<Leg>) {
    setLegs((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;
        const next = { ...l, ...patch };
        if ((patch.strike !== undefined || patch.kind !== undefined) && next.auto && next.kind !== "FUT") {
          next.premium = price(next.kind, next.strike);
        }
        if (patch.premium !== undefined) next.auto = false;
        return next;
      }),
    );
  }

  /* ----------------------------- payoff math --------------------------- */

  const analysis = useMemo(() => {
    if (legs.length === 0) return null;
    const lo = spot * 0.85;
    const hi = spot * 1.15;
    const n = 240;
    const xs: number[] = [];
    const expiry: number[] = [];
    const t0: number[] = [];

    const pnlAt = (S: number, atExpiry: boolean): number => {
      let total = 0;
      for (const leg of legs) {
        const units = leg.lots * lotSize;
        if (leg.kind === "FUT") {
          total += leg.side * (S - leg.strike) * units;
          continue;
        }
        const value = atExpiry
          ? leg.kind === "CE"
            ? Math.max(0, S - leg.strike)
            : Math.max(0, leg.strike - S)
          : bsPrice(leg.kind, S, leg.strike, iv, Math.max(dte * 0.5, 0.5));
        total += leg.side * (value - leg.premium) * units;
      }
      return total;
    };

    for (let i = 0; i <= n; i++) {
      const S = lo + ((hi - lo) * i) / n;
      xs.push(S);
      expiry.push(pnlAt(S, true));
      t0.push(pnlAt(S, false));
    }

    const maxP = Math.max(...expiry);
    const maxL = Math.min(...expiry);
    // payoff still rising at either edge => profit unbounded; falling => loss unbounded
    const profitUnbounded = expiry[n] - expiry[n - 1] > 0.01 || expiry[0] - expiry[1] > 0.01;
    const lossUnbounded = expiry[n] - expiry[n - 1] < -0.01 || expiry[0] - expiry[1] < -0.01;
    const breakevens: number[] = [];
    for (let i = 1; i <= n; i++) {
      if ((expiry[i - 1] < 0 && expiry[i] >= 0) || (expiry[i - 1] > 0 && expiry[i] <= 0)) {
        const f = Math.abs(expiry[i - 1]) / (Math.abs(expiry[i - 1]) + Math.abs(expiry[i]));
        breakevens.push(xs[i - 1] + f * (xs[i] - xs[i - 1]));
      }
    }
    let netPremium = 0;
    for (const leg of legs) {
      if (leg.kind !== "FUT") netPremium += -leg.side * leg.premium * leg.lots * lotSize;
    }
    return { xs, expiry, t0, maxP, maxL, breakevens, netPremium, profitUnbounded, lossUnbounded, pnlAtSpot: pnlAt(spot, true) };
  }, [legs, spot, lotSize, iv, dte]);

  /* ------------------------------ chart -------------------------------- */

  const W = 760;
  const H = 300;
  const PAD = 46;

  function chartPaths() {
    if (!analysis) return null;
    const { xs, expiry, t0 } = analysis;
    const yAll = [...expiry, ...t0];
    const yMax = Math.max(...yAll, 1);
    const yMin = Math.min(...yAll, -1);
    const X = (s: number) => PAD + ((s - xs[0]) / (xs[xs.length - 1] - xs[0])) * (W - 2 * PAD);
    const Y = (p: number) => H - PAD - ((p - yMin) / (yMax - yMin)) * (H - 2 * PAD);
    const line = (ys: number[]) => ys.map((p, i) => `${i === 0 ? "M" : "L"}${X(xs[i]).toFixed(1)},${Y(p).toFixed(1)}`).join(" ");
    const zeroY = Y(0);
    const area =
      line(expiry) + ` L${X(xs[xs.length - 1]).toFixed(1)},${zeroY.toFixed(1)} L${X(xs[0]).toFixed(1)},${zeroY.toFixed(1)} Z`;
    return { X, Y, line, zeroY, area, yMax, yMin };
  }

  const chart = chartPaths();
  const fmt = (v: number) =>
    Math.abs(v) >= 1000 ? `${v < 0 ? "-" : ""}${(Math.abs(v) / 1000).toFixed(1)}k` : v.toFixed(0);

  /* ------------------------------ render -------------------------------- */

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="rounded-lg border border-white/10 bg-gradient-to-r from-[#1a1430] to-[#0d1118] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-wider text-[#b28ef7]">
              Options Lab · Hedging Course + Strategy Playground
            </div>
            <h2 className="mt-1 text-2xl font-bold text-white">Learn hedges. Then play with them.</h2>
            <p className="mt-1 max-w-2xl text-sm text-[#93a1b6]">
              Pick a strategy lesson — iron condor, butterfly, collar — load it into the builder, and drag
              spot / IV / expiry to see the payoff move. Nothing is placed.
            </p>
            <div className="mt-2 font-mono text-[11px]">
              {chainStatus === "ready" && chain ? (
                <span className="text-[#10b981]">
                  ● {chain.pricedContracts ? "PRICED" : "MAPPED"}: {chain.underlying} {chain.expiry} · spot≈{chain.spot} · ATM {chain.atm} · step{" "}
                  {chain.step} · {chain.contracts} contracts · {chain.pricedContracts}/{chain.contracts} premium candles
                  {chain.asOf ? ` (${new Date(chain.asOf).toLocaleDateString()})` : ""}
                </span>
              ) : chainStatus === "loading" ? (
                <span className="text-[#93a1b6]">● loading {underlyingSym} chain…</span>
              ) : (
                <span className="text-[#f5a524]">
                  ● SIMULATED: no live chain for {underlyingSym} — using Black-Scholes premiums
                </span>
              )}
            </div>
          </div>
          <button
            onClick={() => setShowCourse((s) => !s)}
            className="flex items-center gap-2 rounded-md border border-white/15 px-3 py-2 text-sm text-[#93a1b6] transition hover:text-white"
          >
            <BookOpen className="size-4" /> {showCourse ? "Hide course" : "Show course"}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-white/10 pt-3">
          <label className="text-[11px] text-[#93a1b6]">
            Underlying
            <input
              value={underlyingInput}
              onChange={(event) => setUnderlyingInput(event.target.value.toUpperCase())}
              onKeyDown={(event) => {
                if (event.key === "Enter" && underlyingInput.trim()) {
                  setChainStatus("loading");
                  setExpiry("");
                  setUnderlyingSym(underlyingInput.trim());
                }
              }}
              className="mt-1 block w-28 rounded border border-white/15 bg-[#080b10] px-2 py-1 text-xs text-white"
            />
          </label>
          <button
            onClick={() => { if (underlyingInput.trim()) { setChainStatus("loading"); setExpiry(""); setUnderlyingSym(underlyingInput.trim()); } }}
            className="rounded-md border border-[#b28ef7]/50 px-3 py-1.5 text-xs font-semibold text-[#b28ef7] hover:bg-[#b28ef7]/10"
          >
            Load map
          </button>
          <label className="text-[11px] text-[#93a1b6]">
            Expiry
            <select
              value={expiry || chain?.expiry || ""}
              onChange={(event) => { setChainStatus("loading"); setExpiry(event.target.value); }}
              disabled={!chain?.expiries.length}
              className="mt-1 block rounded border border-white/15 bg-[#080b10] px-2 py-1 text-xs text-white disabled:opacity-50"
            >
              {(chain?.expiries || []).map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          {chain && <span className="pb-1 text-[11px] text-[#7b8aa0]">{chain.source}</span>}
        </div>
      </div>

      {showCourse && (
        <section>
          <div className="mb-3 text-sm font-semibold text-white">
            Hedging &amp; Options Strategy Course <span className="text-[#93a1b6]">· {PRESETS.length} lessons</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {PRESETS.map((p) => (
              <div
                key={p.id}
                className={`rounded-lg border p-4 transition ${
                  activePreset === p.id ? "border-[#b28ef7]/60 bg-[#b28ef7]/10" : "border-white/10 bg-white/[0.03]"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-white">{p.name}</div>
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                      p.view === "Bullish"
                        ? "bg-emerald-500/15 text-emerald-300"
                        : p.view === "Bearish"
                          ? "bg-rose-500/15 text-rose-300"
                          : p.view === "Hedge"
                            ? "bg-[#64d2ff]/15 text-[#64d2ff]"
                            : p.view === "Volatile"
                              ? "bg-amber-500/15 text-amber-300"
                              : "bg-white/10 text-[#93a1b6]"
                    }`}
                  >
                    {p.view}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-[#93a1b6]">{p.summary}</p>
                <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                  <div className="rounded bg-white/[0.04] px-2 py-1">
                    <span className="text-[#5a6578]">Risk </span>
                    <span className="text-rose-300">{p.risk}</span>
                  </div>
                  <div className="rounded bg-white/[0.04] px-2 py-1">
                    <span className="text-[#5a6578]">Reward </span>
                    <span className="text-emerald-300">{p.reward}</span>
                  </div>
                </div>
                <p className="mt-2 text-[11px] leading-4 text-[#7b8aa0]">
                  <span className="font-semibold text-[#93a1b6]">When:</span> {p.whenToUse}
                </p>
                {p.hedgeNote && (
                  <p className="mt-1 text-[11px] leading-4 text-[#64d2ff]/80">🛡 {p.hedgeNote}</p>
                )}
                <button
                  onClick={() => loadPreset(p)}
                  className="mt-3 flex items-center gap-2 rounded-md bg-[#b28ef7]/20 px-3 py-1.5 text-xs font-semibold text-[#b28ef7] transition hover:bg-[#b28ef7]/30"
                >
                  <FlaskConical className="size-3.5" /> Load in playground
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ------------------------- playground ------------------------- */}
      <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
        <div className="mb-4 flex flex-wrap items-end gap-4">
          <div className="text-sm font-semibold text-white">
            Payoff Playground{" "}
            {activePreset && (
              <span className="text-[#b28ef7]">· {PRESETS.find((p) => p.id === activePreset)?.name}</span>
            )}
          </div>
          <div className="ml-auto flex flex-wrap gap-3">
            {[
              { label: "Spot", value: spot, set: setSpot, step: strikeStep / 2 },
              { label: "Lot size", value: lotSize, set: setLotSize, step: 1 },
              { label: "Strike step", value: strikeStep, set: setStrikeStep, step: 25 },
            ].map((f) => (
              <label key={f.label} className="text-[11px] text-[#93a1b6]">
                {f.label}
                <input
                  type="number"
                  value={f.value}
                  step={f.step}
                  onChange={(e) => f.set(Number(e.target.value) || 0)}
                  className="mt-1 block w-24 rounded border border-white/15 bg-[#080b10] px-2 py-1 text-xs text-white"
                />
              </label>
            ))}
            <label className="text-[11px] text-[#93a1b6]">
              IV {iv}%
              <input
                type="range" min={5} max={80} value={iv}
                onChange={(e) => setIv(Number(e.target.value))}
                className="mt-2 block w-28 accent-[#b28ef7]"
              />
            </label>
            <label className="text-[11px] text-[#93a1b6]">
              Expiry {dte}d
              <input
                type="range" min={1} max={45} value={dte}
                onChange={(e) => setDte(Number(e.target.value))}
                className="mt-2 block w-28 accent-[#64d2ff]"
              />
            </label>
          </div>
        </div>

        {/* legs table */}
        <div className="mb-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-xs">
            <thead>
              <tr className="text-left font-mono text-[10px] uppercase text-[#5a6578]">
                <th className="pb-1">Side</th><th>Type</th><th>Strike / Entry</th><th>Premium</th><th>Lots</th><th />
              </tr>
            </thead>
            <tbody>
              {legs.map((leg) => (
                <tr key={leg.id} className="border-t border-white/5">
                  <td className="py-1.5 pr-2">
                    <button
                      onClick={() => updateLeg(leg.id, { side: leg.side === 1 ? -1 : 1 })}
                      className={`rounded px-2 py-1 font-mono text-[11px] font-bold ${
                        leg.side === 1 ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"
                      }`}
                    >
                      {leg.side === 1 ? "BUY" : "SELL"}
                    </button>
                  </td>
                  <td className="pr-2">
                    <select
                      value={leg.kind}
                      onChange={(e) => updateLeg(leg.id, { kind: e.target.value as Leg["kind"] })}
                      className="rounded border border-white/15 bg-[#080b10] px-2 py-1 text-white"
                    >
                      <option value="CE">Call</option><option value="PE">Put</option><option value="FUT">Fut/Stock</option>
                    </select>
                  </td>
                  <td className="pr-2">
                    <input
                      type="number" value={leg.strike} step={strikeStep}
                      onChange={(e) => updateLeg(leg.id, { strike: Number(e.target.value) || 0 })}
                      className="w-24 rounded border border-white/15 bg-[#080b10] px-2 py-1 text-white"
                    />
                  </td>
                  <td className="pr-2">
                    <input
                      type="number" value={leg.premium} step={0.5} disabled={leg.kind === "FUT"}
                      onChange={(e) => updateLeg(leg.id, { premium: Number(e.target.value) || 0 })}
                      className={`w-20 rounded border px-2 py-1 text-white ${
                        leg.auto ? "border-white/15 bg-[#080b10]" : "border-[#d9a441]/50 bg-[#d9a441]/10"
                      }`}
                      title={leg.auto ? "Auto-priced (Black-Scholes). Edit to override." : "Manual premium"}
                    />
                  </td>
                  <td className="pr-2">
                    <input
                      type="number" min={1} value={leg.lots}
                      onChange={(e) => updateLeg(leg.id, { lots: Math.max(1, Number(e.target.value) || 1) })}
                      className="w-14 rounded border border-white/15 bg-[#080b10] px-2 py-1 text-white"
                    />
                  </td>
                  <td>
                    <button onClick={() => setLegs((p) => p.filter((l) => l.id !== leg.id))} className="text-[#5a6578] hover:text-rose-400">
                      <Trash2 className="size-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mb-4 flex gap-2">
          <button onClick={addLeg} className="flex items-center gap-1 rounded-md border border-white/15 px-3 py-1.5 text-xs text-[#93a1b6] hover:text-white">
            <Plus className="size-3.5" /> Add leg
          </button>
          {legs.length > 0 && (
            <button onClick={() => { setLegs([]); setActivePreset(null); }} className="flex items-center gap-1 rounded-md border border-white/15 px-3 py-1.5 text-xs text-[#93a1b6] hover:text-white">
              <RotateCcw className="size-3.5" /> Clear
            </button>
          )}
        </div>

        {analysis && chart ? (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
              <Metric label="Net premium" value={`${analysis.netPremium >= 0 ? "+" : ""}${fmt(analysis.netPremium)} ${analysis.netPremium >= 0 ? "credit" : "debit"}`} tone={analysis.netPremium >= 0 ? "up" : "down"} />
              <Metric label="Max profit" value={analysis.profitUnbounded ? "Unlimited*" : fmt(analysis.maxP)} tone="up" />
              <Metric label="Max loss" value={analysis.lossUnbounded ? "Unlimited*" : fmt(analysis.maxL)} tone="down" />
              <Metric label="Breakeven(s)" value={analysis.breakevens.length ? analysis.breakevens.map((b) => b.toFixed(0)).join(" / ") : "—"} />
              <Metric label="P&L if expires at spot" value={fmt(analysis.pnlAtSpot)} tone={analysis.pnlAtSpot >= 0 ? "up" : "down"} />
            </div>

            <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md border border-white/10 bg-[#080b10]">
              <defs>
                <clipPath id="above"><rect x={0} y={0} width={W} height={chart.zeroY} /></clipPath>
                <clipPath id="below"><rect x={0} y={chart.zeroY} width={W} height={H - chart.zeroY} /></clipPath>
              </defs>
              <path d={chart.area} fill="rgba(16,185,129,0.18)" clipPath="url(#above)" />
              <path d={chart.area} fill="rgba(244,63,94,0.18)" clipPath="url(#below)" />
              <line x1={PAD} x2={W - PAD} y1={chart.zeroY} y2={chart.zeroY} stroke="#5a6578" strokeWidth={1} strokeDasharray="3 3" />
              <path d={chart.line(analysis.t0)} fill="none" stroke="#64d2ff" strokeWidth={1.4} strokeDasharray="5 4" opacity={0.8} />
              <path d={chart.line(analysis.expiry)} fill="none" stroke="#10b981" strokeWidth={2} />
              <line x1={chart.X(spot)} x2={chart.X(spot)} y1={PAD / 2} y2={H - PAD} stroke="#d9a441" strokeWidth={1.2} strokeDasharray="4 3" />
              <text x={chart.X(spot) + 4} y={PAD / 2 + 10} fill="#d9a441" fontSize={11} fontFamily="monospace">spot {spot}</text>
              {analysis.breakevens.map((b, i) => (
                <g key={i}>
                  <circle cx={chart.X(b)} cy={chart.zeroY} r={3.5} fill="#f5f7fb" />
                  <text x={chart.X(b) + 5} y={chart.zeroY - 6} fill="#93a1b6" fontSize={10} fontFamily="monospace">BE {b.toFixed(0)}</text>
                </g>
              ))}
              <text x={PAD} y={H - 8} fill="#5a6578" fontSize={10} fontFamily="monospace">{fmt(analysis.xs[0])}</text>
              <text x={W - PAD - 30} y={H - 8} fill="#5a6578" fontSize={10} fontFamily="monospace">{fmt(analysis.xs[analysis.xs.length - 1])}</text>
              <text x={W - PAD - 150} y={20} fill="#10b981" fontSize={10} fontFamily="monospace">— expiry payoff</text>
              <text x={W - PAD - 150} y={34} fill="#64d2ff" fontSize={10} fontFamily="monospace">-- T+0 (BS est.)</text>
            </svg>
            <p className="mt-2 text-[11px] text-[#5a6578]">
              *Unlimited beyond the charted range. Captured premium candles are used when available; otherwise the
              leg uses the clearly-labelled Black-Scholes estimate (r=0). Gold-bordered premiums are manual overrides.
              Educational simulation only; not investment advice.
            </p>
          </>
        ) : (
          <div className="rounded-md border border-dashed border-white/15 p-8 text-center text-sm text-[#5a6578]">
            Load a course lesson above or add legs to see the payoff chart.
          </div>
        )}
      </section>

      {chain && (
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-white">Mapped option chain</div>
              <p className="text-[11px] text-[#7b8aa0]">Angel contract identity for hedge construction. A blank premium means its 5-minute price capture has not started yet.</p>
            </div>
            <span className="font-mono text-[11px] text-[#64d2ff]">lot size {chain.lotSize ?? "—"}</span>
          </div>
          <div className="max-h-64 overflow-auto rounded border border-white/10">
            <table className="w-full min-w-[620px] text-xs">
              <thead className="sticky top-0 bg-[#10151f] font-mono text-[10px] uppercase text-[#5a6578]">
                <tr><th className="px-3 py-2 text-left">Call</th><th className="px-3 py-2 text-right">CE price</th><th className="px-3 py-2 text-center">Strike</th><th className="px-3 py-2 text-left">Put</th><th className="px-3 py-2 text-right">PE price</th></tr>
              </thead>
              <tbody>
                {chain.strikes.map((row) => (
                  <tr key={row.strike} className={`border-t border-white/5 ${row.strike === chain.atm ? "bg-[#d9a441]/10" : ""}`}>
                    <td className="px-3 py-1.5 font-mono text-[#93a1b6]">{row.ceSymbol ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-emerald-300">{row.ce == null ? "—" : row.ce.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-center font-mono font-bold text-white">{row.strike.toFixed(2)}{row.strike === chain.atm ? " · ATM" : ""}</td>
                    <td className="px-3 py-1.5 font-mono text-[#93a1b6]">{row.peSymbol ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-rose-300">{row.pe == null ? "—" : row.pe.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-wide text-[#5a6578]">{label}</div>
      <div className={`mt-0.5 font-mono text-sm font-bold ${tone === "up" ? "text-emerald-300" : tone === "down" ? "text-rose-300" : "text-white"}`}>
        {value}
      </div>
    </div>
  );
}
