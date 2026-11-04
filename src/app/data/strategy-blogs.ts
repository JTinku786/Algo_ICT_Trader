// Strategy blog library. Each entry is a self-contained article derived from the
// strategy documentation. Blogs are keyed by a unique `id` (slug) and expose a
// `code` badge (e.g. "S01", "A01") used to deep-link every strategy mention in
// the app to its article.

export type BlogBlock =
  | { t: "p"; text: string }
  | { t: "h"; text: string }
  | { t: "ul"; items: string[] }
  | { t: "steps"; items: string[] }
  | { t: "kv"; rows: [string, string][] }
  | { t: "callout"; tone: "info" | "warn" | "key"; text: string };

export type StrategyBlog = {
  id: string;
  code: string; // display + link code; "" when the strategy is not referenced by an id in the app
  title: string;
  subtitle: string;
  category: "Core Automation" | "ICT Concept Library" | "A-Series · Futures";
  markets: string;
  session: string;
  timeframes: string;
  tags: string[];
  readMins: number;
  blocks: BlogBlock[];
};

const seq = (items: string[]): BlogBlock => ({ t: "steps", items });
const ul = (items: string[]): BlogBlock => ({ t: "ul", items });
const p = (text: string): BlogBlock => ({ t: "p", text });
const h = (text: string): BlogBlock => ({ t: "h", text });

export const STRATEGY_BLOGS: StrategyBlog[] = [
  {
    id: "s01-v3-weekly-daily-bias", code: "S01-V3", title: "S01 V3 — Daily HTF Bias",
    subtitle: "An isolated S01 V2 execution engine with confirmed Daily directional permission.",
    category: "Core Automation", markets: "Available US stocks plus SPY and QQQ",
    session: "Inherited S01 V2 execution sessions", timeframes: "Daily bias · Weekly/Monthly context · 5m execution",
    tags: ["Daily Bias", "Causal", "Research"], readMins: 3,
    blocks: [
      p("Daily direction alone authorizes BUY or SELL. Weekly and Monthly direction are descriptive context and cannot authorize or veto a trade. Neutral Daily evidence blocks new setups."),
      h("Completed Daily evidence"),
      ul(["Use the latest known confirmed Daily structure break, or confirmed swing progression when no structure break exists.", "Pivots use two bars on each side and become available only after confirmation. Candle colour alone does not supply direction.", "Daily direction is frozen at the session open; no forming Daily candle or future confirmation enters the decision.", "No additional HTF array, Daily reaction, opposing-array failure or HTF objective condition gates entry."]),
      p("S01 V2 sweep, displacement, MSS, 5m PD-array entry, 1H/30m execution trend veto, stops, targets, next-bar fills and exits remain intact. Weekly/Monthly conflict alone cannot block a Daily-permitted setup."),
      h("Research scope"),
      p("The initial Weekly/Daily V3 smoke produced 19 sweep candidates and zero orders. Revision s01v3-daily-spec-1.1 replaces that permission policy with Daily direction only. The Backtest card identifies the published revision and shows its actual run counts. A separate V2 control uses identical source history for a fair comparison; this control is not a change to the original published V2 run."),
    ],
  },
  {
    id: "ts01-2022-mentorship", code: "TS01-TB", title: "2022 ICT Mentorship — Textbook Baseline",
    subtitle: "A frozen, causal implementation of the 2022 mentorship sequence, retained exactly as the research baseline even though it failed promotion metrics.",
    category: "Core Automation", markets: "SPY · QQQ · Nifty50 · BankNifty spot-index study",
    session: "US 09:30–11:00 ET · India 09:15–11:00 IST", timeframes: "Weekly/Daily context · 15M/5M liquidity · 5M execution",
    tags: ["2022 Mentorship", "Liquidity Raid", "MSS", "FVG", "Consequent Encroachment"], readMins: 6,
    blocks: [
      p("TS01-TB is the approved textbook-first baseline for the ICT 2022 Mentorship. It is intentionally frozen at revision 2: the website reports what the deterministic backtest produced and does not rewrite rules after seeing the result."),
      h("The causal sequence"),
      seq([
        "Use completed Daily candles to establish direction from a confirmed Daily swing break that also creates a same-direction Daily FVG.",
        "Select one unique nearest, still-unraided Daily/Weekly swing-liquidity objective in that direction.",
        "Require price to raid a fresh opposing liquidity pool during the approved local session window.",
        "After the raid, require a completed 5m close through the last confirmed pre-raid swing plus a same-direction, non-zero 5m FVG.",
        "Activate the FVG midpoint (CE) only after candle three closes; the first later 5m retracement may fill it.",
        "Place the stop one analysis tick beyond the raid extreme and select three distinct, pre-activation real-liquidity targets.",
      ]),
      h("Target and outcome contract"),
      ul([
        "T1 is the nearest real liquidity target in [1R, 2R), with a 1.5R minimum.",
        "T2 is the nearest real liquidity target in [2R, 4R).",
        "T3 is the nearest real liquidity target at 4R or greater; projected target prices are forbidden.",
        "Allocation is one third per target. The original stop remains; no breakeven move or trailing rule is added.",
        "Same-bar ambiguity is resolved stop-first. Open legs are UNRESOLVED_SESSION_END and are not fabricated as wins or losses.",
      ]),
      { t: "callout", tone: "warn", text: "Research verdict: this exact baseline completed successfully but failed the promotion gate. Forty-eight fully resolved fills produced -30.7432R. It is displayed for audit and research, not as a live-ready claim." },
      { t: "callout", tone: "info", text: "Nifty50 and BankNifty results are spot-index signal studies using approved analysis increments; they are not simulated broker-instrument fills." },
    ],
  },
  {
    id: "igs01v2-london-sweep-reversal", code: "IGS01V2", title: "IGS01 V2 — London Killzone Sweep Reversal",
    subtitle: "Forex 1m. A liquidity pool is raided, the raid fails, and you enter on the candle that closes back inside. No FVG, no inversion, no retrace, no clock.",
    category: "Core Automation", markets: "12 FX pairs · 1-minute Barchart data stored in New York time",
    session: "London killzone 02:00–05:00 America/New_York · one setup per killzone",
    timeframes: "1m detection · 1m execution",
    tags: ["Liquidity Pool", "Sweep Reversal", "London Killzone", "Forex", "Close-Confirmed Stop"], readMins: 8,
    blocks: [
      p("IGS01 V2 is the sweep-reversal build of the London liquidity-grab family. One instrument, one session, one setup — or nothing. Two filters, a stop that never moves, and three targets measured independently. It is a backtest specification: nothing here is validated for live capital."),
      h("The trade"),
      seq([
        "Find resting liquidity — a cluster of roughly equal highs (or equal lows) on the 1-minute chart. Everyone positioned against that level holds a stop just beyond it. That is the pool.",
        "Wait for the raid — price pushes through the level and takes those stops out.",
        "Wait for the raid to fail — a candle closes back inside the pool. Whoever pushed through could not hold it.",
        "Enter on that candle's close, in the direction of the failure. An upward raid that fails is a sell.",
        "Stop at the extreme of the raid — the furthest point price reached. If price returns there, liquidity was taken and held, and the premise is dead.",
      ]),
      p("No fair value gaps, no inversions, no retracement. V1 required an IFVG retrace and measurement showed that step was inverting the signal: it returned −3.54R against a +14.44R mirror, while entering on the rejection close returned +30.12R against a −14.59R mirror, sign-stable in both halves of the year. Demanding a retrace into the inverted gap selects the sweeps price came BACK toward, and a real raid leaves and does not look back."),
      h("The two filters"),
      { t: "kv", rows: [
        ["MIN_REJECTION_PIPS", "5.0 pips. The failure candle must close at least 5 pips back inside the pool, measured from the raid's extreme. That distance does two jobs: it measures how decisively price rejected, and — because the stop sits at that extreme — it is also the stop distance, so it refuses trades too tight to survive the spread."],
        ["KZ_ENTRY_DEADLINE", "04:45 New York. No entry after 04:45. The killzone closes at 05:00; a setup confirming at 04:52 is structurally valid but has no session left to deliver, and the next real participation is the NY open two hours later. Measured at the FILL, not at the raid."],
      ] },
      p("Both cleared the same bar before going in: the cohort each one removes was negative in both halves of the year. For the deadline that was six out of six across the three targets. These are the only two fitted parameters, and they were fitted on the 2026 population."),
      h("The stop — and it never moves"),
      { t: "kv", rows: [
        ["Placement", "The raid extreme. Structural, not a percentage. Its violation means liquidity was taken and held, so the reason for the trade no longer exists. No percentage floor: 2% of price is roughly 233 pips on EURUSD."],
        ["Trigger and fill", "Close-confirmed. A bar must CLOSE beyond the stop, and you exit at that close, not at the stop price. More realistic than assuming a clean fill, but it means the loss is NOT capped at 1R: roughly 44% of trades lose more than their nominal risk."],
      ] },
      { t: "callout", tone: "warn", text: "Never move it to breakeven. This contradicts standard advice, so it was measured: moving to breakeven after the first target raised the win rate by 13 points and lost 16R while increasing drawdown. Trailing was worse still. The return lives in the trades that reach the far target, and a breakeven stop scratches those out during the pullback that precedes the move — so the curve loses the upward drift that was absorbing the losses. It is a worse strategy that feels better." },
      h("The three targets"),
      ul([
        "TP1 — 1–2R, the near target.",
        "TP2 — 2–4R, the middle target.",
        "TP3 — 4R+, the runner.",
      ]),
      p("Chosen from the PD arrays sitting in front of the trade and bucketed by reward-to-risk. Each is measured separately, against the same entry and the same stop — there is no fitted split of the position across them. An earlier build carried one and it was removed: the “best” split moved depending on which spread assumption was used, and a parameter that swings on an unmeasured assumption is not a finding. Scaling out is a decision for whoever trades it, with all three numbers in view. There is no time limit: a trade ends only when a target or a stop is hit, never on a clock."),
      h("Money management"),
      { t: "kv", rows: [
        ["Risk per trade", "0.50% of equity. Argued from the drawdown distribution, not from expectancy. At 1.00% a 1-in-100 stretch runs past 21% — which is where people stop following the plan, and a strategy abandoned at the bottom of a drawdown has a negative expectancy no backtest will show."],
        ["Daily risk cap", "3% per session. Insurance, not a correction. Same-day trades are near-independent (pairwise outcome correlation +0.019, sign agreement 48.2% against 50%). But on 72.5% of sessions every USD-legged trade points the same way against the dollar, so one dollar shock could hit the whole book. It has never happened in this sample — which is why it is insured rather than assumed away."],
        ["Concurrent trades", "No cap. Every count cap tested (5, 4, 3 per session) lowered return more than it lowered drawdown. Once outcomes are uncorrelated, cutting trades cuts the sample, not the risk."],
      ] },
      h("Deliberately not in the strategy"),
      { t: "kv", rows: [
        ["IFVG / inversion / retrace entry", "Measured −3.54R against a +14.44R mirror — the step was inverting the signal."],
        ["Noise-sweep screen", "Rejected shallow-and-fast raids. Its sign flipped between the two halves of the year, and the cohort it removed was worth roughly nothing (+3.2R over 81 trades) rather than being negative. A rule that cannot be defended in both halves of its own sample will surprise you live."],
        ["Target allocation", "A fitted split of the position across TP1/TP2/TP3. At a flat 0.5-pip spread the choice looked like pure noise; at per-symbol realistic spreads it looked decisive. The answer depended on an assumption nobody has measured, so it was removed rather than defended."],
        ["Breakeven and trailing stops", "Both measured worse on return AND on drawdown at every allocation and every cost level."],
        ["Dropping the weak pairs", "GBPUSD, USDCHF and EURGBP look bad and cutting them lifts per-trade R from 0.46 to 0.58. But the variance ratio is 1.34 (borderline), the label-shuffle p-value is 0.11 (not significant), and GBPUSD's sign flips between halves. That is selection bias, not edge."],
        ["Metals (XAUUSD / XAGUSD)", "Not quoted in pips, so MIN_REJECTION_PIPS has no meaning on them and every R multiple would be nonsense."],
      ] },
      h("The 2017–2025 held-out result"),
      p("Both fitted parameters were chosen on the 2026 population, so 2017–2025 is genuinely out of sample: 9,044 trades across 9 years and 12 pairs, net of assumed costs, with unresolved legs excluded rather than booked."),
      { t: "kv", rows: [
        ["TP1", "50.9% win · +1,118.3R · +0.124R per trade · profit factor 1.205"],
        ["TP2", "36.7% win · +2,071.0R · +0.229R per trade · profit factor 1.293"],
        ["TP3", "22.2% win · +3,064.6R · +0.339R per trade · profit factor 1.350"],
      ] },
      ul([
        "All nine years positive, and all twelve pairs positive.",
        "Executability holds: none of the 9,044 stops is under 2 pips, median 8.5 — the edge is not hiding inside the spread.",
        "Per-trade R decays 39–44% against the fitted 2026 sample. That is the size of the fitting premium, and it is the number to plan against, not the 2026 one.",
      ]),
      { t: "callout", tone: "warn", text: "The mirror test has not been run. Replay every setup with the direction reversed — same bar, same entry price, same risk distance, targets reflected — and see whether the flipped book also makes money. If it does, the profit belongs to the payoff geometry (a stop at the raid extreme, a close-confirmed exit, targets in multiples of a small risk unit) and not to the ICT sequence. This is not hypothetical: it is precisely how V1 was parked. V1 returned −7.37R against a mirror of +29.25R, and the sign of the difference flipped between halves of the sample." },
      ul([
        "Drawdown is real. The TP2 book gives back 69R peak to trough with a 19-trade losing streak — about 34% of the account at 0.5% risk per trade. The TP3 book is over 50%.",
        "TP3 is outlier-sensitive. Removing its fifty best winners leaves 56% of the total; doing the same to TP2 leaves 91%. TP2 is the robust column.",
        "Costs are assumptions. Spreads are per-symbol estimates, not the broker's own history, and the JPY crosses — roughly 60% of the population — carry both the widest assumed cost and the weakest results.",
      ]),
      { t: "callout", tone: "info", text: "Provenance: detection igs01v2_london_liqgrab_sweepreversal.detect(), execution igs01v2_execution_updated (next-bar-open fill, monitoring from the bar after the fill, static close-confirmed structural stop, 2R touch hard stop, no time limit, 30-day forward search). Source table public.igs01v2_backtest_legs, run tags hist_2017_2025 and tieout_2026, republished to the dashboard's updated pipeline. 1-minute Barchart data stored in New York time. Nothing here is validated for live capital." },
    ],
  },
  {
    id: "s01", code: "S01", title: "Bread & Butter Buy/Sell",
    subtitle: "Weekly/Daily bias + a Judas raid around the True Session Open, displacement, MSS, and a PD-array retracement entry.",
    category: "Core Automation", markets: "US indices & equities · Indian equities/indices",
    session: "US 09:30 ET · India 09:15 IST — first opening hour", timeframes: "Weekly/Daily/1H bias · 30M/15M structure · 5M (3m/1m) execution",
    tags: ["Judas Swing", "Displacement", "MSS", "PD Array", "Liquidity"], readMins: 6,
    blocks: [
      p("S01 is the flagship intraday model. It only trades when the Weekly and Daily narrative agree on a clear draw on liquidity and the session prints a Judas-style manipulation against that bias around the True Session Open (TSO). The TSO is treated as the intraday zero-line: BUY setups need manipulation below it into discount, SELL setups need manipulation above it into premium."),
      h("The sequence"),
      seq([
        "Establish Weekly + Daily bias and the next draw on liquidity (buy-side or sell-side).",
        "Mark the True Session Open (US 09:30 ET / India 09:15 IST) as the zero-line.",
        "Wait for an early-session Judas raid against bias that sweeps a liquidity pool.",
        "Require forceful displacement back through the TSO with imbalance + a local BOS/MSS.",
        "Enter on retracement into one clean PD array left by the displacement leg.",
        "Target the next logical liquidity pools for T1/T2/T3 — never fixed R multiples.",
      ]),
      h("Displacement quality filters"),
      ul([
        "Candle body ≥ 1.5× the average body of the previous 10 candles.",
        "Candle range ≥ 1.3× the average range of the previous 10 candles.",
        "Close in the top 25% of range (bullish) or bottom 25% (bearish).",
        "The move must leave at least one valid imbalance and/or break nearby structure.",
      ]),
      h("Valid PD arrays for entry"),
      ul([
        "Fair Value Gap (FVG) — primary retracement entry after the sweep and impulse.",
        "Order Block — last opposing candle before expansion, used on a return to origin.",
        "Breaker Block — a failed OB that flips role after the structure shift.",
        "Mitigation Block / Inverse-FVG / Rejection Block — secondary reaction zones.",
      ]),
      { t: "callout", tone: "key", text: "A sweep without displacement is not an S01 trade. The edge is time-of-day behaviour + a real liquidity event + forceful repricing, not a level touch." },
      p("Targets are liquidity-based: the next internal pool (T1), the range extreme (T2), and the higher-timeframe draw (T3). Stops sit beyond the swept extreme that created the setup."),
    ],
  },
  {
    id: "s02", code: "S02", title: "Inducement & Liquidity Sweep",
    subtitle: "Separate the engineered 'inducement' move from the real higher-timeframe sweep, then enter the true leg.",
    category: "Core Automation", markets: "US indices & equities · Indian equities/indices",
    session: "US 09:30–11:00 ET · India 09:15–10:45 IST", timeframes: "Weekly/Daily/1H bias · 30M/15M sweep · 5M execution",
    tags: ["Inducement", "Liquidity Sweep", "MSS", "PD Array"], readMins: 5,
    blocks: [
      p("S02 is built around the difference between inducement and a true sweep. Inducement is an engineered move that baits retail into an obvious level (support/resistance, equal highs/lows, mid-range) that is not the real higher-timeframe objective. The true sweep is the deeper raid of the key pool that aligns with the Weekly/Daily draw and leads to displacement."),
      h("The sequence"),
      seq([
        "Define the Weekly/Daily draw on liquidity.",
        "Watch price engineer inducement into an obvious retail level against bias.",
        "Wait for the deeper, true sweep of the real pool in line with bias.",
        "Confirm the new leg with displacement + MSS/CHOCH.",
        "Enter from a clean PD array formed by that displacement — not by the inducement move.",
      ]),
      { t: "callout", tone: "info", text: "The first move to a visible level is treated as suspect (inducement) until the subsequent sweep and displacement confirm the real side." },
      h("Hard constraints"),
      ul([
        "The PD array must be created by the displacement after the true sweep, in the correct premium/discount.",
        "It must remain fresh — no full body close through it before entry.",
        "One clean boundary and invalidation; cluttered, overlapping zones are skipped.",
        "Displacement filters match S01 (body ≥1.5×, range ≥1.3×, close in the extreme 25%).",
      ]),
    ],
  },
  {
    id: "s03", code: "S03", title: "ICT Breaker Block",
    subtitle: "Trade failed order blocks that flip into new support/resistance after a liquidity sweep and MSS.",
    category: "Core Automation", markets: "US indices & equities · Indian equities/indices",
    session: "US 09:30–11:00 & 13:00–15:00 ET · India 09:15–10:45 & 13:30–15:00 IST", timeframes: "Weekly/Daily/4H bias · 1H/30M OB · 15M sweep · 5M entry",
    tags: ["Breaker Block", "Order Block", "MSS", "Displacement"], readMins: 6,
    blocks: [
      p("A Breaker Block is a failed order block that flips into a new PD array after price sweeps liquidity at the OB extreme, closes with body beyond that extreme (not just a wick), and prints an MSS/CHOCH with displacement in the new direction. S03 uses the flipped OB as the execution venue for the retracement entry."),
      h("Bullish vs bearish breakers"),
      ul([
        "Bullish Breaker — price closes above a prior bearish OB after sweeping a low and shifting structure up; the failed bearish OB becomes bullish support.",
        "Bearish Breaker — price closes below a prior bullish OB after sweeping a high and shifting structure down; the failed bullish OB becomes bearish resistance.",
      ]),
      h("The sequence"),
      seq([
        "Align with Weekly/Daily bias (continuation vs reversal day).",
        "Identify a clearly defined higher-timeframe order block.",
        "Require a liquidity sweep through the OB extreme (stop hunt).",
        "Confirm OB failure with a full body close beyond the extreme + MSS.",
        "Enter on retracement into the flipped OB (the Breaker) in the correct premium/discount.",
        "Target the opposite liquidity; stop beyond the Breaker's origin.",
      ]),
      { t: "callout", tone: "key", text: "A Breaker is always born from a stop hunt: sweep → body-close failure → structure shift → retest. A wick through an OB with no body close and no MSS is not a Breaker." },
    ],
  },
  {
    id: "s05", code: "S05", title: "Asian Range & Session Liquidity Sweep",
    subtitle: "Use the Asian range as the overnight liquidity base and trade London/NY killzone sweeps of its extremes.",
    category: "Core Automation", markets: "US & Indian indices/equities · FX proxies for context",
    session: "London KZ ~02:00–05:00 ET · NY KZ ~08:30–11:00 ET", timeframes: "Weekly/Daily/4H bias · 30M range · 15M sweep · 5M entry",
    tags: ["Asian Range", "Killzone", "Liquidity Sweep", "PD Array"], readMins: 5,
    blocks: [
      p("S05 exploits how London and New York redistribute the liquidity that accumulates during the Asian session. The Asian range (the high/low between roughly 19:00–00:00 NY time) is the primary overnight pool — stops cluster above the Asian high and below the Asian low."),
      h("The sequence"),
      seq([
        "Mark the Asian range high and low.",
        "Use Weekly/Daily bias to decide which side is the higher-probability sweep.",
        "Wait for a London or NY killzone sweep of that level.",
        "Require displacement + MSS/CHOCH after the sweep.",
        "Enter on retracement into a PD array created by the sweep leg.",
        "Target the opposite side of the Asian range or the next session pool.",
      ]),
      { t: "callout", tone: "info", text: "In bullish conditions an early sweep below the Asian low into discount often sets up longs; in bearish conditions an early sweep above the Asian high into premium sets up shorts." },
    ],
  },
  {
    id: "s07", code: "S07", title: "HTF Bias + Silver Bullet",
    subtitle: "Higher-timeframe narrative combined with the time-boxed Silver Bullet execution window.",
    category: "Core Automation", markets: "US & Indian indices/equities · FX",
    session: "NY AM Silver Bullet ~10:00–11:00 ET (time is part of the edge)", timeframes: "Daily/1H bias · 30M/15M confirmation · 5M PD array",
    tags: ["Silver Bullet", "Killzone", "Displacement", "PD Array"], readMins: 5,
    blocks: [
      p("S07 trades only when the higher-timeframe narrative and intraday session delivery point the same way, and it concentrates execution into a specific intraday window rather than trading continuously. The Silver Bullet is a time-based model: the NY AM window (~10:00–11:00 ET) is where the strategy looks for its sweep-displacement-retest sequence."),
      h("The sequence"),
      seq([
        "Read Daily + 1H structure, external liquidity, draw on liquidity and premium/discount for bias.",
        "Inside the Silver Bullet window, wait for a liquidity sweep aligned with the draw.",
        "Confirm with displacement and a 15M structure shift.",
        "Select a 5M PD array (FVG/OB) for the retest entry.",
        "Target the next liquidity pool; stop beyond the sweep.",
      ]),
      { t: "callout", tone: "key", text: "Timing is the edge. A valid signal outside the window is not a Silver Bullet trade." },
    ],
  },
  {
    id: "s16", code: "S16", title: "HTF Bias · Liquidity Sweep · MSS · OB/FVG Retest (Automation)",
    subtitle: "The session-independent, automation-ready ICT reversal model — the backbone of the live system and the first ML-scored strategy.",
    category: "Core Automation", markets: "US equities (Dow-30 universe) — automation ready",
    session: "No fixed window — the sweep can occur any time", timeframes: "Weekly/Daily bias · 1H/15M liquidity · 5M execution",
    tags: ["Automation", "MSS", "OB/FVG", "Premium/Discount", "ML-scored"], readMins: 6,
    blocks: [
      p("S16 is the automation-ready ICT reversal model and the first strategy wired into the machine-learning probability layer. It deliberately excludes session-specific rules so it can run any time the setup appears. The one-line model: bias gives permission → HTF liquidity gives the target for the sweep → the sweep forms a new extreme → displacement creates an MSS → the OB/FVG inside the sweep-to-MSS leg becomes the entry → premium/discount validates quality → opposite liquidity is the target."),
      h("The sequence"),
      seq([
        "Confirm Daily/Weekly bias and the HTF liquidity pool to be raided.",
        "Wait for price to sweep that pool in the direction opposite the intended trade.",
        "Require displacement out of the new extreme that prints a Market Structure Shift.",
        "Locate the OB or FVG created inside the sweep-to-MSS displacement leg.",
        "Enter on the retest of that OB/FVG in the correct premium/discount.",
        "Stop beyond the sweep extreme; target the opposing liquidity.",
      ]),
      { t: "callout", tone: "info", text: "S16 is what the Machine Learning tab scores: a CatBoost model estimates p(TP2 before SL) so trades can be gated by probability. The 2026 ICT-Enhanced champion folds 11 engineered ICT price-action features (5-minute FVG/order-block distance, CVD, ATR, IPDA premium-discount, 52-week range) into the model — the 5-minute FVG distance alone is its single strongest driver. It lifts out-of-sample AUC to 0.788 and, gated at P≥0.60, raises the TP2 hit-rate to 83% while cutting max drawdown from −12.3R to −4.0R. A calibrated 42-feature stable model scores the live order book in shadow mode." },
    ],
  },
  {
    id: "core", code: "", title: "ICT Liquidity Sweep + Displacement + PD Array",
    subtitle: "The corrected, mechanical automation base: one sequence, strict displacement, and a valid FVG/OB — no hard CHOCH/BOS requirement.",
    category: "Core Automation", markets: "US & Indian indices/equities · Silver-Bullet compatible",
    session: "Session filter optional", timeframes: "HTF bias/location · LTF sweep + displacement + PD array",
    tags: ["Automation", "Displacement", "FVG", "Order Block", "State machine"], readMins: 4,
    blocks: [
      p("This is the corrected, Silver-Bullet-compatible automation base model. It uses exactly one mechanical sequence and validates trades on strict displacement plus a valid FVG or Order Block, rather than requiring CHOCH/MSS/BOS as hard conditions (those are logged as optional diagnostics)."),
      h("The one mechanical sequence"),
      seq([
        "HTF bias and location.",
        "Liquidity sweep.",
        "Strict displacement.",
        "FVG or OB creation.",
        "Retracement into the PD array → entry.",
        "Stop beyond the sweep → target the opposite liquidity.",
      ]),
      { t: "callout", tone: "warn", text: "Deliberate correction: CHOCH, MSS and BOS are optional diagnostics here. The trade is validated by strict displacement + a valid FVG/OB, which keeps the state machine unambiguous for backtesting and live execution." },
    ],
  },

  // ---- A-Series (NQ/ES futures) --------------------------------------------
  {
    id: "a01", code: "A01", title: "iFVG — Inverted Fair Value Gap",
    subtitle: "The flagship precision-entry model: a fresh inverted FVG as the execution zone after bias, sweep, displacement and retest.",
    category: "A-Series · Futures", markets: "NQ · MNQ · ES · MES",
    session: "NY AM 09:30–11:00 ET", timeframes: "Weekly/Daily/1H bias · 15M structure · 5M iFVG · 1M confirmation",
    tags: ["iFVG", "Inversion", "Retest", "Precision Entry"], readMins: 5,
    blocks: [
      p("A Fair Value Gap that is decisively closed through from the opposing side can invert — resistance becomes support, or support becomes resistance. A01 takes the trade only after that inverted zone retests in the direction of the higher-timeframe draw. It is a precision execution layer, not a standalone bias engine."),
      { t: "callout", tone: "key", text: "A01 is a post-inversion FVG retest entry — not a reason to trade every FVG, and never a chase entry on the inversion candle itself. Freshness and clean invalidation are required." },
      h("The sequence"),
      seq([
        "Define the HTF draw on liquidity and premium/discount context.",
        "Wait for a liquidity sweep and a displacement leg that leaves an FVG.",
        "Require the opposing side to close decisively through that FVG (the inversion).",
        "Enter on the retest of the fresh inverted FVG (iFVG) in line with bias.",
        "Confirm on 1M; stop beyond the inversion; target the next pool.",
      ]),
    ],
  },
  {
    id: "a02", code: "A02", title: "AMD × iFVG — Power of Three with Inverted FVG",
    subtitle: "AMD gives the story, the iFVG gives the entry, liquidity gives the target.",
    category: "A-Series · Futures", markets: "NQ · MNQ · ES · MES",
    session: "NY AM 09:30–11:00 ET · London/NY handoff optional", timeframes: "Daily/1H bias · 15M AMD block · 5M iFVG · 1M confirmation",
    tags: ["AMD", "Power of Three", "iFVG", "Judas"], readMins: 5,
    blocks: [
      p("A02 combines the Power of Three / AMD cycle with the iFVG entry. The accumulation block provides the dealing range, manipulation sweeps liquidity, and the inverted FVG provides the sniper entry into distribution. Its unique rule: the entry must come from the iFVG formed and inverted during the manipulation-to-distribution transition."),
      h("The sequence: range → sweep → inversion → retest → delivery"),
      seq([
        "Mark the accumulation range (the dealing range).",
        "Wait for the manipulation Judas sweep of one side.",
        "Require displacement into distribution that leaves an FVG which then inverts.",
        "Enter on the iFVG retest in the HTF bias direction.",
        "Target BSL/SSL per the daily draw.",
      ]),
      { t: "callout", tone: "warn", text: "Do not enter during the manipulation candle, and don't force it — not every day produces a clean AMD cycle." },
    ],
  },
  {
    id: "a03", code: "A03", title: "Unfilled FVG + iFVG Confluence Scalp",
    subtitle: "A dual-imbalance scalp: an older unfilled FVG must overlap with a freshly inverted iFVG.",
    category: "A-Series · Futures", markets: "NQ · MNQ · ES · MES",
    session: "NY AM 09:30–11:00 ET", timeframes: "1H/15M UFVG · 5M iFVG · 1M confirmation",
    tags: ["UFVG", "iFVG", "Confluence", "Scalp"], readMins: 4,
    blocks: [
      p("A03 filters iFVG trades by requiring them to overlap a pre-existing unfilled FVG (UFVG) from a higher or prior-session timeframe. The overlap creates a double-imbalance confluence zone. The trade is taken from the overlap — not from either zone alone — for fewer but higher-conviction NY AM scalps."),
      h("Imbalance quality"),
      ul([
        "Untouched FVG — price has not traded into the gap at all (highest quality).",
        "Partially mitigated FVG — price wicked in but did not rebalance or close through; usable with care.",
        "The fresh iFVG confirms current-session order flow agrees with the old imbalance.",
      ]),
    ],
  },
  {
    id: "a08", code: "A08", title: "Trendline Liquidity + iFVG Reversal",
    subtitle: "Fade false breaks of a 3-touch trendline, using the iFVG created during the diagonal-liquidity sweep as the entry.",
    category: "A-Series · Futures", markets: "NQ · MNQ · ES · MES",
    session: "NY AM primary · London optional", timeframes: "1H/15M trendline · 5M sweep/iFVG · 1M confirmation",
    tags: ["Trendline Liquidity", "iFVG", "False Break", "Reversal"], readMins: 4,
    blocks: [
      p("A08 adapts the iFVG model to diagonal (trendline) liquidity. Retail stops cluster beyond obvious 3-touch trendlines; a false break of that line sweeps that liquidity. When the FVG created or reclaimed during the event inverts, the iFVG becomes the retest entry into the post-sweep delivery leg."),
      { t: "callout", tone: "key", text: "This is not a trendline-breakout strategy — it fades false breaks with confirmation, and the line must not be redrawn after the sweep." },
      h("Requirements"),
      ul([
        "A genuine trendline with clustered liquidity (≈3 touches).",
        "A sweep of that diagonal liquidity followed by a failed break.",
        "A fresh iFVG for the retest, aligned with HTF bias and premium/discount.",
      ]),
    ],
  },
  {
    id: "a13", code: "A13", title: "RTH Gap + Standard Deviation Confluence",
    subtitle: "Combine RTH gap boundaries with ICT standard-deviation expansion levels; trigger on an iFVG/OB/CISD at the confluence.",
    category: "A-Series · Futures", markets: "NQ · MNQ · ES · MES",
    session: "NY AM 09:30–11:00 ET (RTH 09:30–16:00)", timeframes: "Daily/RTH gap · 1H SD map · 15M/5M entry · 1M confirmation",
    tags: ["RTH Gap", "Standard Deviation", "Confluence", "CISD"], readMins: 4,
    blocks: [
      p("A13 is a confluence framework, not a blind gap-fill. The Regular Trading Hours (RTH) gap creates a reference imbalance; ICT-style standard-deviation expansion levels project likely delivery/extension zones. When a gap boundary aligns with a key SD level and a valid iFVG/OB/CISD forms there, the confluence zone becomes an entry, target, or reversal area."),
      h("How it fits together"),
      ul([
        "RTH gap — the imbalance reference between yesterday's close and today's 09:30 open.",
        "SD levels — projected delivery zones (−2/−1/0/+1/+2 std) from a defined leg.",
        "Entry trigger — an iFVG, order block, or change-in-state-of-delivery (CISD) at the confluence.",
      ]),
      { t: "callout", tone: "warn", text: "SD ranges must be defined before the move — not fitted after price has already expanded." },
    ],
  },

  // ---- ICT Concept Library --------------------------------------------------
  {
    id: "s04", code: "S04", title: "IPDA Premium/Discount Matrix (Nested Arrays)",
    subtitle: "Read where institutions buy and sell using nested premium/discount ranges across timeframes.",
    category: "ICT Concept Library", markets: "US & Indian indices/equities",
    session: "Context model (all sessions)", timeframes: "Monthly/Weekly macro range · nested Daily/4H/1H sub-ranges",
    tags: ["IPDA", "Premium/Discount", "Equilibrium", "Nested Arrays"], readMins: 5,
    blocks: [
      p("The Interbank Price Delivery Algorithm (IPDA) does not move price randomly — it delivers price from liquidity pool to liquidity pool, from discount to premium (bullish) or premium to discount (bearish), always within a defined range. S04 formalizes the Premium/Discount Matrix across nested timeframes: identify the macro range (Monthly/Weekly), then nest lower-timeframe ranges inside it."),
      h("Defining an IPDA range"),
      ul([
        "Use the highest high / lowest low over the last 20, 40, or 60 candles on the reference timeframe.",
        "Buy-Side Liquidity rests above the range high; Sell-Side Liquidity rests below the range low.",
        "Equilibrium is the 50% of the range — above is premium (sell zone), below is discount (buy zone).",
      ]),
      { t: "callout", tone: "info", text: "Nesting is the point: a discount on the weekly can contain its own premium/discount on the daily. Trades are highest quality when the nested arrays agree." },
    ],
  },
  {
    id: "s06", code: "S06", title: "ICT 2022 Mentorship Model",
    subtitle: "The full-sequence flagship framework that unifies IPDA ranges, liquidity, structure, PD arrays and session timing.",
    category: "ICT Concept Library", markets: "US & Indian indices/equities — intraday & swing",
    session: "Session-aware (killzones)", timeframes: "Top-down HTF narrative → LTF OTE execution",
    tags: ["2022 Model", "OTE", "Daily Profile", "Draw on Liquidity"], readMins: 5,
    blocks: [
      p("The ICT 2022 Mentorship Model synthesizes the core ICT concepts — IPDA ranges, liquidity pools, market structure, PD arrays and session timing — into one repeatable, top-down sequence. It is the unifying framework from which many of the other S-series strategies are refinements or subsets."),
      h("The workflow"),
      seq([
        "Determine the HTF draw on liquidity (where price is being delivered to).",
        "Determine the Daily Profile — the expected intraday narrative (accumulation, manipulation, distribution).",
        "Wait for the session manipulation / liquidity raid.",
        "Enter at the Optimal Trade Entry (OTE) inside a valid PD array in the correct premium/discount.",
        "Manage with liquidity-based targets: T1 internal pool, T2 range extreme, T3 HTF draw.",
      ]),
    ],
  },
  {
    id: "s08", code: "S08", title: "High-Probability Order Flow Continuation (BISI / SIBI)",
    subtitle: "Continuation entries from an unfilled BISI/SIBI imbalance left by the most recent institutional displacement.",
    category: "ICT Concept Library", markets: "US & Indian indices/equities",
    session: "Session-flexible", timeframes: "Weekly/Daily bias · LTF imbalance execution",
    tags: ["BISI", "SIBI", "Order Flow", "Continuation", "Imbalance"], readMins: 4,
    blocks: [
      p("S08 trades continuation, not reversal. Once institutional order flow is already established through a displacement leg, price often returns to rebalance an unfilled imbalance — a Buy-Side Imbalance/Sell-Side Inefficiency (BISI) for longs, or a Sell-Side Imbalance/Buy-Side Inefficiency (SIBI) for shorts — before continuing in the original direction. Entry is strictly from within the imbalance zone."),
      h("Requirements"),
      ul([
        "Align with Weekly/Daily bias and a clear draw on liquidity.",
        "A recent displacement leg that created the BISI/SIBI.",
        "Entry only from inside the imbalance — never from arbitrary levels.",
        "Continuation target: the next liquidity pool in the trend direction.",
      ]),
    ],
  },
  {
    id: "s09", code: "S09", title: "HTF Dealing Range Reversion (Failure to Displace)",
    subtitle: "Mean-reversion back to equilibrium when price raids a range extreme but fails to displace beyond it.",
    category: "ICT Concept Library", markets: "US & Indian indices/equities",
    session: "HTF context · LTF execution", timeframes: "Weekly/Daily range · 4H failure · LTF MSS+FVG/OB entry",
    tags: ["Dealing Range", "Failure to Displace", "Reversion", "Equilibrium"], readMins: 4,
    blocks: [
      p("S09 targets reversion inside a higher-timeframe dealing range. When price raids liquidity at a premium or discount boundary but cannot sustain displacement beyond it, ICT treats this as a high-probability signal back toward equilibrium (50%) or the opposite boundary. The strategy exploits the gap between retail breakout expectations and institutional order-flow reality."),
      h("The sequence"),
      seq([
        "Define the HTF dealing range (swing high = premium, swing low = discount) on Weekly/Daily.",
        "Confirm a failed displacement attempt at the extreme (the raid can't sustain).",
        "Align with HTF bias for a reversion trade.",
        "Execute on an LTF MSS + FVG/OB after the failure confirms.",
        "Take profit in stages at equilibrium (50%) and the opposing boundary.",
      ]),
    ],
  },
  {
    id: "s10", code: "S10", title: "BISI / SIBI Merged Imbalance (Imbalance Alias)",
    subtitle: "Trade the high-confluence zone where opposing BISI and SIBI imbalances overlap or stack.",
    category: "ICT Concept Library", markets: "US & Indian indices/equities",
    session: "Session-flexible", timeframes: "Same-timeframe imbalance mapping · LTF execution",
    tags: ["Merged Imbalance", "BISI", "SIBI", "Imbalance Alias"], readMins: 4,
    blocks: [
      p("S10 identifies the Merged Imbalance — a zone where a Buy-Side Imbalance/Sell-Side Inefficiency (BISI) and a Sell-Side Imbalance/Buy-Side Inefficiency (SIBI) overlap or stack within close proximity on the same timeframe. ICT calls these overlapping inefficiency zones Imbalance Aliases; when two opposing imbalances merge they create an exceptionally strong area of institutional interest."),
      { t: "callout", tone: "info", text: "The merged zone acts as a magnet and a battleground: price is drawn to rebalance it, and the reaction out of it is often sharp — making it a high-quality entry or target area with bias + confirmation." },
    ],
  },
  {
    id: "s11", code: "S11", title: "SMT Divergence (Smart Money Tool Confirmation)",
    subtitle: "A confirmation filter, not a standalone entry: correlated instruments failing to confirm each other's extremes.",
    category: "ICT Concept Library", markets: "Correlated pairs (e.g. ES/NQ, NIFTY/BANKNIFTY)",
    session: "Applied on top of any entry model", timeframes: "Any — measured at the swing extreme",
    tags: ["SMT", "Divergence", "Confirmation", "Correlation"], readMins: 4,
    blocks: [
      p("SMT (Smart Money Technique) Divergence is ICT's premier confirmation and filter tool. It is not a standalone entry strategy — it is a high-conviction confirmation applied on top of any S01–S10 entry. SMT occurs when two highly correlated instruments fail to confirm each other's price extremes at the same time, revealing that smart money is not supporting the move."),
      h("How to read it"),
      ul([
        "Bullish SMT — one instrument makes a lower low while its correlated partner makes a higher low (sell-side is being defended).",
        "Bearish SMT — one instrument makes a higher high while its partner makes a lower high (buy-side is being distributed).",
        "Use it to confirm a sweep/MSS entry, size up conviction, or veto a setup when the correlation agrees with the raid.",
      ]),
      { t: "callout", tone: "key", text: "In the ML models, SMT-style logic is one of the strongest strategies out-of-sample (S-CH10 / SMT Divergence posts the highest test AUC in the suite)." },
    ],
  },
  {
    id: "s12", code: "S12", title: "Asian Range AMD (London Open Raid)",
    subtitle: "Apply Accumulation–Manipulation–Distribution to the Asian range, executing on the London Open raid.",
    category: "ICT Concept Library", markets: "US/Indian indices/equities · FX",
    session: "Asian accumulation → London Open manipulation → distribution", timeframes: "Asian range · 15M sweep · 5M entry",
    tags: ["AMD", "Asian Range", "London Open", "Judas"], readMins: 4,
    blocks: [
      p("S12 applies the AMD framework specifically to the Asian session range with the London Open as the execution window. During Asia, algorithms build a consolidation range (accumulation). At the London Open, price raids one side of the Asian range — sweeping BSL above the high or SSL below the low (manipulation) — then reverses and delivers toward the draw (distribution)."),
      h("The sequence"),
      seq([
        "Mark the Asian range high/low (accumulation).",
        "At London Open, wait for the raid of one extreme (manipulation / Judas).",
        "Require the failure + displacement back inside the range with an MSS.",
        "Enter from the PD array of the displacement leg.",
        "Target the opposite Asian extreme / next session pool (distribution).",
      ]),
    ],
  },
  {
    id: "s13", code: "S13", title: "Judas Swing (Phase Only)",
    subtitle: "A precision refinement of S01 that trades only the opening liquidity raid — the manipulation move itself.",
    category: "ICT Concept Library", markets: "US & Indian indices/equities",
    session: "Opening session raid window", timeframes: "15M manipulation · 5M/1M execution",
    tags: ["Judas Swing", "Manipulation", "Scalp"], readMins: 4,
    blocks: [
      p("S13 isolates the Judas Swing phase — the opening-session liquidity raid — and trades it directly. Where S01 captures the full Accumulation–Manipulation–Distribution cycle, S13 strips the model down to the manipulation move: enter as price sweeps one extreme and take profit quickly as it reverts, rather than holding for the full distribution leg."),
      { t: "callout", tone: "warn", text: "This is a fast, precision play. It needs tight execution and disciplined profit-taking on the reversion; it is not a hold-for-the-day model." },
    ],
  },
  {
    id: "s14", code: "S14", title: "ICT Market Maker Buy/Sell Model (MMBM / MMSM)",
    subtitle: "The full market-maker sequence — engineered sweep, displacement, consolidation, and final delivery to a PD target.",
    category: "ICT Concept Library", markets: "US & Indian indices/equities",
    session: "Full-cycle (multi-session)", timeframes: "HTF sequence map · LTF execution",
    tags: ["MMBM", "MMSM", "Market Maker", "Full Cycle"], readMins: 5,
    blocks: [
      p("The Market Maker Buy/Sell Model reads the complete institutional sequence — from an engineered liquidity sweep through displacement, consolidation and final delivery to a premium or discount target. The MMBM frames long setups; the MMSM frames shorts. It is anticipatory: it maps the full accumulation → manipulation → distribution arc rather than reacting bar-by-bar."),
      h("The market-maker sequence"),
      seq([
        "Original consolidation and engineered liquidity build.",
        "Smart-money reversal after the stop raid.",
        "Displacement that establishes the new order flow.",
        "Re-accumulation / re-distribution consolidation.",
        "Final delivery to the opposing premium/discount PD array target.",
      ]),
    ],
  },
  {
    id: "s17", code: "S17", title: "AMD Model — Accumulation · Manipulation · Distribution",
    subtitle: "The foundational full-cycle intraday framework every other S-series model refines.",
    category: "ICT Concept Library", markets: "NIFTY · BANKNIFTY · S&P 500 · NASDAQ · EURUSD · GBPUSD",
    session: "Per-session AMD mapping (India/London/NY)", timeframes: "HTF bias · session AMD · MSS displacement FVG retest",
    tags: ["AMD", "Power of Three", "Judas", "MSS"], readMins: 5,
    blocks: [
      p("S17 codifies the complete Accumulation–Manipulation–Distribution cycle — the foundational ICT intraday framework governing how institutional algorithms deliver price in three phases every session. Many other S-series strategies are refinements or subsets of this master framework."),
      { t: "kv", rows: [
        ["Accumulation", "Pre-session range building; institutions engineer a consolidation trapping retail. Mark range high/low + BSL/SSL. Do not enter."],
        ["Manipulation", "Session opens and price moves opposite the intended direction — a Judas sweep. Wait for the candle to close back inside the range."],
        ["Distribution", "Price reverses and delivers in the HTF-bias direction toward the draw. MSS fires, an FVG/OB forms — enter on that displacement-FVG retest."],
      ] },
      p("Manage to TP1 (internal liquidity) and TP2 (the HTF draw). Session windows map the three phases onto India, London and New York opens."),
    ],
  },
  {
    id: "s21", code: "S21", title: "New Week Opening Gap (NWOG)",
    subtitle: "Turn the Friday-close to Sunday-open gap into a weekly reference level and execution framework.",
    category: "ICT Concept Library", markets: "US & Indian indices/equities · FX",
    session: "Sunday open marks the gap · London/NY execution", timeframes: "Monthly/Weekly context · 4H/1H planning · 15M/5M execution",
    tags: ["NWOG", "Weekly Gap", "Narrative", "PD Array"], readMins: 5,
    blocks: [
      p("S21 converts the New Week Opening Gap — the space between Friday's close and Sunday's open — into a weekly reference level. It does not assume every gap fills immediately; instead it classifies the gap as a draw, support/resistance zone, failure level, or continuation reference depending on how price reacts around it. The NWOG is the map; a lower-timeframe sweep/MSS/PD-array is the trigger."),
      h("What it is not"),
      ul([
        "Not a blind gap-fill trade — the bot must not trade every Sunday gap just because one exists.",
        "Not a news-prediction model — execution still comes from price behaviour.",
        "Not a standalone LTF signal — the NWOG sets levels/bias; S16-style confirmation executes.",
      ]),
    ],
  },
  {
    id: "s26", code: "S26", title: "Mitigation Block",
    subtitle: "Retest unmitigated institutional origin zones after price returns to rebalance them.",
    category: "ICT Concept Library", markets: "US & Indian indices/equities",
    session: "Session-flexible · best after London/NY delivery", timeframes: "Weekly/Daily context · 4H/1H mitigation map · 15M/5M entry",
    tags: ["Mitigation Block", "Order Block", "Origin Retest"], readMins: 4,
    blocks: [
      p("S26 converts unmitigated institutional origin zones into structured trade plans. It tracks order blocks / origin candles that produced displacement but have not yet been revisited. When price later returns to rebalance that origin, the zone becomes either a target or an entry. Because mitigation status is objective, it is scanner-friendly: each origin is fresh, partially mitigated, fully mitigated, violated, or expired."),
      { t: "callout", tone: "warn", text: "Not permission to trade every old order block. Price must deliver into the zone with liquidity context and confirm a reaction; a clean full-body close through it in the wrong direction invalidates it." },
    ],
  },
  {
    id: "s28", code: "S28", title: "Rejection Block",
    subtitle: "A wick-based reaction zone created when price sweeps liquidity and closes back away from the extreme.",
    category: "ICT Concept Library", markets: "US & Indian indices/equities",
    session: "Best around opens, news reactions, HTF sweeps", timeframes: "Daily/4H context · 1H/15M zones · 5M/3M execution",
    tags: ["Rejection Block", "Wick", "Liquidity Sweep"], readMins: 4,
    blocks: [
      p("S28 defines a Rejection Block as a tradable wick-based reaction zone: price sweeps liquidity at a significant level and closes back away from the extreme. The wick is the evidence of rejection; the sweep is the reason the wick matters. A valid Rejection Block forms at a liquidity pool, HTF PD array, session extreme, or round number, and is confirmed by displacement or a structure shift."),
      h("What it is not"),
      ul([
        "Not any candle with a large wick — a wick without liquidity context is only volatility.",
        "Not the same as a Breaker Block — Breakers are failed OB flips; Rejection Blocks are wick-based.",
        "Not a news-spike chase — spikes need a close-back and confirmation.",
      ]),
    ],
  },
  {
    id: "s29", code: "S29", title: "Unicorn Model (Breaker + FVG Overlap)",
    subtitle: "A high-confluence entry where a valid Breaker Block and a Fair Value Gap overlap.",
    category: "ICT Concept Library", markets: "US & Indian indices/equities",
    session: "Session-flexible · best after London/NY sweep", timeframes: "Daily/4H context · 1H/15M structure · 5M/3M execution",
    tags: ["Unicorn", "Breaker Block", "FVG", "Confluence"], readMins: 4,
    blocks: [
      p("S29 defines the Unicorn Model as a high-confluence overlap between a valid Breaker Block and a Fair Value Gap. It is not merely a deep retracement — it requires a failed order block, a structure shift, displacement, and an overlapping imbalance that creates a precise entry. The Breaker supplies the structural flip; the FVG supplies displacement evidence; the overlap is the Unicorn zone."),
      h("The sequence"),
      seq([
        "Liquidity sweep at a key level.",
        "A failed OB / Breaker after the sweep.",
        "A displacement FVG in the new direction.",
        "The Breaker–FVG overlap forms the entry zone.",
        "Retest entry → target the opposing liquidity.",
      ]),
    ],
  },
  {
    id: "s32", code: "S32", title: "Algorithmic Price Delivery & 3-Day Cycle",
    subtitle: "A multi-day delivery framework labelling the market as accumulation, manipulation, or expansion across a three-session cycle.",
    category: "ICT Concept Library", markets: "US & Indian indices/equities",
    session: "Multi-day · entries during London/NY", timeframes: "Weekly/Daily narrative · 4H/1H cycle map · 15M/5M entries",
    tags: ["3-Day Cycle", "Price Delivery", "Context", "Regime"], readMins: 4,
    blocks: [
      p("S32 organizes price delivery across a recurring three-day narrative. It is not a rigid calendar prediction — it is a framework for reading when the market is accumulating, manipulating liquidity, and expanding toward a higher-timeframe draw. A scanner can label the current day as accumulation, manipulation, expansion, reversal, or balanced, and then enable only the entry models that match that state."),
      h("The cycle"),
      seq([
        "HTF draw defines the multi-day objective.",
        "Day 1 — range / accumulation.",
        "Day 2 — liquidity manipulation.",
        "Day 3 — expansion / delivery, executed via an LTF PD-array entry toward the HTF target.",
      ]),
      { t: "callout", tone: "warn", text: "Not a promise that every market moves in exact three-day cycles, and not a reason to hold trades blindly for three days — entries still require a sweep, displacement and a PD-array retest." },
    ],
  },
  {
    id: "s33", code: "S33", title: "Multi-Day Swing Framework",
    subtitle: "The position-trading layer: weekly narrative, daily liquidity, PD arrays and scaled, multi-day trade management.",
    category: "ICT Concept Library", markets: "US & Indian indices/equities",
    session: "Position trading · London/NY confirmation", timeframes: "Monthly/Weekly/Daily planning · 4H/1H entries · 15M refinement",
    tags: ["Swing", "Position Trading", "PD Array", "Multi-Day"], readMins: 4,
    blocks: [
      p("S33 is the position-trading layer of the strategy library. It uses Monthly, Weekly and Daily charts to build a multi-day plan, then executes through 4H/1H (or lower) retests of valid PD arrays. It is built for fewer trades, wider context, and larger targets — prioritizing narrative quality, liquidity hierarchy and trade management over frequent entries."),
      { t: "callout", tone: "key", text: "Targets come from liquidity and PD arrays, not a fixed R/R. It is not a scalping model and requires a defined higher-timeframe draw on liquidity." },
    ],
  },
  {
    id: "turtle-soup", code: "", title: "Turtle Soup — False Break Reversal",
    subtitle: "Fade false breakouts beyond a key swing that hunt retail stops and fail to sustain.",
    category: "ICT Concept Library", markets: "NIFTY · BANKNIFTY · S&P 500 · NASDAQ · Dow Jones",
    session: "Session-aware · killzone raids", timeframes: "HTF bias · LTF MSS + FVG/OB entry",
    tags: ["Turtle Soup", "False Break", "Reversal", "Liquidity"], readMins: 4,
    blocks: [
      p("Turtle Soup exploits false breakouts: price spikes beyond a key swing high/low (or prior day/week high/low, equal highs/lows, 20-day high/low) to hunt retail breakout orders, then fails to sustain and reverses back inside the prior range."),
      h("The sequence"),
      seq([
        "Align with Weekly/Daily bias and identifiable liquidity pools.",
        "Require a confirmed false sweep of a key level.",
        "Confirm the false nature — price returns inside the range (no sustained close beyond).",
        "Take the MSS/CHOCH with displacement opposite the sweep.",
        "Enter on retracement into an FVG/OB from the displacement leg, in the correct premium/discount.",
        "Derive T1/T2/T3 from the next liquidity pools, not fixed R:R.",
      ]),
    ],
  },
];

// ---- Lookup helpers --------------------------------------------------------

// Known equivalences between app strategy ids and blog codes.
const CODE_ALIASES: Record<string, string> = {
  "S-CH10": "S11", // SMT Divergence champion
  SCH10: "S11",
  // The IGS family carries its full engine name as its strategy_id, so every
  // mention of it in the dashboard has to alias back to the short blog code.
  // Renamed to IGS01V2 on the dashboard side; the blog keeps its original
  // `igs01v2` slug so existing links stay valid.
  IGS01V2_LONDONLIQGRAB_SWEEPREVERSAL: "IGS01V2",
};

function normalizeCode(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

const BLOG_BY_CODE: Record<string, StrategyBlog> = {};
for (const blog of STRATEGY_BLOGS) {
  if (blog.code) BLOG_BY_CODE[normalizeCode(blog.code)] = blog;
}

export function getBlogForCode(code: string | null | undefined): StrategyBlog | null {
  const key = normalizeCode(code);
  if (!key) return null;
  return BLOG_BY_CODE[key] ?? BLOG_BY_CODE[normalizeCode(CODE_ALIASES[key])] ?? null;
}

export function hasBlogForCode(code: string | null | undefined): boolean {
  return getBlogForCode(code) !== null;
}

export function getBlogById(id: string | null | undefined): StrategyBlog | null {
  if (!id) return null;
  return STRATEGY_BLOGS.find((b) => b.id === id) ?? null;
}

export const BLOG_CATEGORIES: StrategyBlog["category"][] = ["Core Automation", "A-Series · Futures", "ICT Concept Library"];
