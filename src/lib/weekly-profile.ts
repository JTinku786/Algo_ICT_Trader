/**
 * ICT weekly profiles at signal time (Realtime + Backtest).
 * Source: Goldhunter weekly-profile thread (slides 067-076), see the
 * ict-goldhunter-playbook skill. Numeric definitions below are LOCAL_ADAPTATION.
 *
 * Two separate answers per trade:
 *  - `live`      what the week looked like AT THE SIGNAL: only trading-day bars
 *                known before the signal (hourly for earlier days, 5m for the
 *                signal day). Safe as a filter / feature.
 *  - `hindsight` which profile the completed week actually printed. A LABEL for
 *                research only (it uses the week's eventual high/low) - never a
 *                filter for live trading.
 *
 * Pre-identified array (LOCAL_ADAPTATION): the prior week's dealing range.
 * Discount = at/below its equilibrium (50%), premium = at/above it.
 * Consolidation = Mon-Wed range <= 50% of the prior week's range.
 *
 * Profiles (bullish; bearish mirrors with the high / premium):
 *  CLASSIC_TUE   Monday holds above discount, Tuesday reaches it and sets the low of week.
 *  WED           Monday + Tuesday never reach discount, Wednesday does and sets the low.
 *  CONSOL_THU    Mon-Wed consolidation, Thursday raids below it into discount (news / ~2 PM).
 *  MIDWEEK       Mon-Wed consolidation, low at an intraweek extreme, then expansion out of the range into Friday.
 *  WED_REVERSAL  Wednesday sweep after a strong Mon-Tue trend the other way (weekly reversal).
 *  SEEK_DESTROY  Mon-Thu shallow, two-sided raids, Friday's final sweep then reversal (bull/bear).
 *                Low probability per Goldhunter - "Exclude Seek & Destroy" filter.
 * Plus the user's "ICT Weekly market manipulation strategies" sheet (sweep of the prior day's extreme,
 * stop beyond the sweep, T1 Monday/range opposite side, T2 prior-week extreme).
 * Weekly page 10 of the source is missing; nothing is invented for it.
 */
import type { Pool } from "pg";

export const WEEKLY_PROFILE_VERSION = "weekly-profile-v3";
const HOUR_MS = 3_600_000;
const STEP_5M = 300_000;
const CONSOL_RATIO = 0.5;
const SHALLOW_RATIO = 0.6;
const MIDWEEK_RATIO = 0.4;
const WED_TREND_RATIO = 0.3;

export type ProfileCode =
  | "CLASSIC_TUE_LOW" | "CLASSIC_TUE_HIGH" | "WED_LOW" | "WED_HIGH"
  | "CONSOL_THU_REVERSAL_BULL" | "CONSOL_THU_REVERSAL_BEAR" | "MIDWEEK_RALLY" | "MIDWEEK_DECLINE"
  | "WED_REVERSAL_BULL" | "WED_REVERSAL_BEAR" | "SEEK_DESTROY_BULL" | "SEEK_DESTROY_BEAR"
  | "SEEK_DESTROY" | "MONDAY_FORMING" | "NO_PROFILE" | "MONDAY_EXTREME" | "OTHER" | "NO_DATA" | "UNSUPPORTED";

export const PROFILE_LABELS: Record<ProfileCode, string> = {
  CLASSIC_TUE_LOW: "Classic Tuesday Low of the Week", CLASSIC_TUE_HIGH: "Classic Tuesday High of the Week",
  WED_LOW: "Wednesday Low of the Week", WED_HIGH: "Wednesday High of the Week",
  CONSOL_THU_REVERSAL_BULL: "Consolidation Thursday Reversal (bull)", CONSOL_THU_REVERSAL_BEAR: "Consolidation Thursday Reversal (bear)",
  MIDWEEK_RALLY: "Consolidation Midweek Rally", MIDWEEK_DECLINE: "Consolidation Midweek Decline",
  WED_REVERSAL_BULL: "Wednesday Weekly Reversal (bull)", WED_REVERSAL_BEAR: "Wednesday Weekly Reversal (bear)",
  SEEK_DESTROY_BULL: "Seek & Destroy Bullish Friday", SEEK_DESTROY_BEAR: "Seek & Destroy Bearish Friday",
  SEEK_DESTROY: "Seek & Destroy Friday (no sweep yet)", MONDAY_FORMING: "Monday - profile forming",
  NO_PROFILE: "No profile", MONDAY_EXTREME: "Monday extreme (not in the sheet)", OTHER: "Other week",
  NO_DATA: "No data", UNSUPPORTED: "Unsupported",
};

type Bias = "BULLISH" | "BEARISH" | "NEUTRAL" | null;
/** Source trade plan: stop beyond the sweep, T1 = Monday's / range's opposite side, T2 = prior-week extreme. */
export type Plan = { swept: string; stop_ref: number; t1: number; t1_label: string; t2: number; t2_label: string };
export type WeeklyProfileResult = {
  week: string | null;                // Monday of the signal's trading week (YYYY-MM-DD)
  signal_day: string | null;          // MON..FRI
  live: { profile: ProfileCode; bias: Bias; aligned: boolean | null; plan?: Plan | null };
  hindsight: { profile: ProfileCode; bias: Bias; aligned: boolean | null; low_day: string | null; high_day: string | null } | null;
  levels: null | { pwh: number; pwl: number; eq: number; wtd_high: number; wtd_low: number; wtd_high_day: string; wtd_low_day: string; mon_wed_ratio: number | null };
  version: string;
};
export type WeeklyProfileTrade = { key: string; symbol: string | null; market: string | null; signalTs: string | Date | null; direction: string | null };

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
type DayBar = { date: string; dow: number; o: number; h: number; l: number; c: number; firstT: number };
type Bar = { t: number; o: number; h: number; l: number; c: number; src: number };

function marketOf(symbol: string, market: string | null): "us" | "india" | "forex" | null {
  const m = String(market ?? "").toLowerCase();
  if (m === "forex" || symbol.startsWith("^") && !/^\^NSE/i.test(symbol)) return "forex";
  if (m === "india" || /\.NS$/i.test(symbol) || /^%5ENSE/i.test(symbol)) return "india";
  if (m === "us" || m === "") return "us";
  return null;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function localParts(t: number, tz: string): { date: string; minutes: number } {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const dowOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
function mondayOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Trading date of a bar (null = outside the session). Forex days roll at 17:00 New York. */
function tradingDate(t: number, mkt: "us" | "india" | "forex", fiveMin: boolean): string | null {
  if (mkt === "forex") {
    const { date } = localParts(t + 7 * HOUR_MS, "America/New_York");
    const dow = dowOf(date);
    return dow === 0 || dow === 6 ? null : date;
  }
  const tz = mkt === "india" ? "Asia/Kolkata" : "America/New_York";
  const { date, minutes } = localParts(t, tz);
  const dow = dowOf(date);
  if (dow === 0 || dow === 6) return null;
  const [open, close] = mkt === "india" ? [fiveMin ? 555 : 540, 930] : [fiveMin ? 570 : 540, 960];
  return minutes >= open && minutes < close ? date : null;
}

function toDays(bars: Bar[], mkt: "us" | "india" | "forex", fiveMin: boolean): DayBar[] {
  const byDay = new Map<string, Bar[]>();
  for (const b of bars) {
    const d = tradingDate(b.t, mkt, fiveMin);
    if (!d) continue;
    byDay.set(d, [...(byDay.get(d) ?? []), b]);
  }
  const out: DayBar[] = [];
  for (const [date, list] of byDay) {
    // One source per day (live table preferred) so opens/closes are not mixed.
    const src = Math.min(...list.map((b) => b.src));
    const xs = list.filter((b) => b.src === src).sort((a, b) => a.t - b.t);
    out.push({ date, dow: dowOf(date), o: xs[0].o, c: xs[xs.length - 1].c, h: Math.max(...xs.map((b) => b.h)), l: Math.min(...xs.map((b) => b.l)), firstT: xs[0].t });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

type Row = { yahoo_symbol: string; candle_ts: Date; open_price: number; high_price: number; low_price: number; close_price: number; pri: number };
function rowsToBars(rows: Row[]): Map<string, Bar[]> {
  const out = new Map<string, Bar[]>();
  for (const r of rows) {
    const o = Number(r.open_price), h = Number(r.high_price), l = Number(r.low_price), c = Number(r.close_price);
    if (![o, h, l, c].every(Number.isFinite) || l > h) continue;
    const list = out.get(r.yahoo_symbol) ?? [];
    list.push({ t: new Date(r.candle_ts).getTime(), o, h, l, c, src: Number(r.pri) });
    out.set(r.yahoo_symbol, list);
  }
  return out;
}

async function loadHourly(pool: Pool, symbol: string, from: Date, to: Date): Promise<Bar[]> {
  const { rows } = await pool.query<Row>(
    `SELECT yahoo_symbol, candle_ts, open_price, high_price, low_price, close_price, 0 AS pri FROM candles_1h
       WHERE yahoo_symbol = $1 AND candle_ts >= $2::timestamptz AND candle_ts < $3::timestamptz
     UNION ALL
     SELECT yahoo_symbol, candle_ts, open_price, high_price, low_price, close_price, 1 AS pri FROM historical_candles_1h
       WHERE yahoo_symbol = $1 AND candle_ts >= $2::timestamptz AND candle_ts < $3::timestamptz`,
    [symbol, from.toISOString(), to.toISOString()]);
  return rowsToBars(rows).get(symbol) ?? [];
}

async function loadDaily(pool: Pool, symbol: string, from: Date, to: Date, tz: string): Promise<DayBar[]> {
  const { rows } = await pool.query<Row>(
    `SELECT yahoo_symbol, candle_ts, open_price, high_price, low_price, close_price, 0 AS pri FROM candles_1d
       WHERE yahoo_symbol = $1 AND candle_ts >= $2::timestamptz AND candle_ts < $3::timestamptz
     UNION ALL
     SELECT yahoo_symbol, candle_ts, open_price, high_price, low_price, close_price, 1 AS pri FROM historical_candles_1d
       WHERE yahoo_symbol = $1 AND candle_ts >= $2::timestamptz AND candle_ts < $3::timestamptz`,
    [symbol, from.toISOString(), to.toISOString()]);
  const byDate = new Map<string, DayBar & { src: number }>();
  for (const b of rowsToBars(rows).get(symbol) ?? []) {
    // Daily bars are stamped at local midnight (+/- a few hours): take the local date of mid-bar.
    const date = localParts(b.t + 6 * HOUR_MS, tz).date;
    const dow = dowOf(date);
    if (dow === 0 || dow === 6) continue;
    const prev = byDate.get(date);
    if (prev && prev.src <= b.src) continue;
    byDate.set(date, { date, dow, o: b.o, h: b.h, l: b.l, c: b.c, firstT: b.t, src: b.src });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function loadFiveMin(pool: Pool, symbol: string, from: Date, to: Date, forex: boolean): Promise<Bar[]> {
  const base = (table: string, pri: number) => `SELECT yahoo_symbol, candle_ts, open_price, high_price, low_price, close_price, ${pri} AS pri FROM ${table}
      WHERE yahoo_symbol = $1 AND candle_ts >= $2::timestamptz AND candle_ts < $3::timestamptz`;
  const rollup = `SELECT yahoo_symbol, to_timestamp(floor(extract(epoch FROM candle_ts) / 300) * 300) AS candle_ts,
        (array_agg(open_price ORDER BY candle_ts))[1] AS open_price, max(high_price) AS high_price, min(low_price) AS low_price,
        (array_agg(close_price ORDER BY candle_ts DESC))[1] AS close_price, 2 AS pri
      FROM historical_candles_1m WHERE yahoo_symbol = $1 AND market = 'forex'
        AND candle_ts >= $2::timestamptz AND candle_ts < $3::timestamptz GROUP BY 1, 2`;
  const sql = `${base("candles_5m", 0)} UNION ALL ${base("historical_candles_5m", 1)}${forex ? ` UNION ALL ${rollup}` : ""}`;
  const { rows } = await pool.query<Row>(sql, [symbol, from.toISOString(), to.toISOString()]);
  return rowsToBars(rows).get(symbol) ?? [];
}

const rangeOf = (days: DayBar[]) => days.length ? { h: Math.max(...days.map((d) => d.h)), l: Math.min(...days.map((d) => d.l)) } : null;
function extremeDay(days: DayBar[], side: "low" | "high"): DayBar {
  return days.reduce((best, d) => (side === "low" ? d.l < best.l : d.h > best.h) ? d : best, days[0]);
}

type Candidate = { profile: ProfileCode; bias: Bias; extremeDow: number; plan: Plan | null };

/**
 * Profile of the week. `days` = this week's trading days known at the decision (last may be partial);
 * `complete` = the whole week is known (hindsight label: the week must also have closed in the profile's direction).
 * Rules follow the user's "ICT Weekly market manipulation strategies" sheet + Goldhunter slides 067-076:
 *  CLASSIC_TUE   Tuesday sweeps Monday's low into discount (prior-week EQ) and is the low of week.
 *  WED           Wednesday sweeps Tuesday's low into discount; Mon-Tue respected it.
 *  WED_REVERSAL  same sweep, but after a strong Mon-Tue trend the other way (>= 30% of prior range).
 *  MIDWEEK       Mon-Tue tight range (<= 40% of prior range); Wednesday sweeps below it, rally out of the range.
 *  CONSOL_THU    Mon-Wed tight range (<= 50%); Thursday fakes out one side - trade the opposite way.
 *  SEEK_DESTROY  Mon-Thu shallow (<= 60%) and two-sided; Friday's final sweep of Thursday's low (bull) / high (bear).
 */
function classifyWeek(days: DayBar[], prior: { h: number; l: number }, complete: boolean): Candidate {
  const eq = (prior.h + prior.l) / 2;
  const priorRange = prior.h - prior.l;
  const today = days[days.length - 1].dow;
  if (!complete && today === 1) return { profile: "MONDAY_FORMING", bias: null, extremeDow: 1, plan: null };
  const day = (dow: number) => days.find((x) => x.dow === dow);
  const [mon, tue, wed, thu, fri] = [1, 2, 3, 4, 5].map(day);
  const mt = rangeOf(days.filter((x) => x.dow <= 2));
  const mw = rangeOf(days.filter((x) => x.dow <= 3));
  const mth = rangeOf(days.filter((x) => x.dow <= 4));
  const tight = (r: { h: number; l: number } | null, ratio: number) => !!r && priorRange > 0 && (r.h - r.l) <= ratio * priorRange;
  const lowDay = extremeDay(days, "low");
  const highDay = extremeDay(days, "high");
  const weekBull = days[days.length - 1].c > days[0].o;
  const out: Candidate[] = [];

  for (const side of ["BULLISH", "BEARISH"] as const) {
    const bull = side === "BULLISH";
    if (complete && bull !== weekBull) continue;
    const ext = bull ? lowDay : highDay;
    const lv = (x: { h: number; l: number }) => bull ? x.l : x.h;           // swept side
    const op = (x: { h: number; l: number }) => bull ? x.h : x.l;           // target side
    const beyond = (a: number, b: number) => bull ? a < b : a > b;
    const reached = (x: DayBar) => complete || (bull ? x.l <= eq : x.h >= eq);
    const pw = bull ? prior.h : prior.l;
    const pwLabel = bull ? "prior-week high" : "prior-week low";
    const mk = (profile: ProfileCode, extremeDow: number, swept: string, stop: number, t1: number, t1Label: string) =>
      out.push({ profile, bias: side, extremeDow, plan: { swept, stop_ref: stop, t1, t1_label: t1Label, t2: pw, t2_label: pwLabel } });

    if (thu && ext === thu && mw && tight(mw, CONSOL_RATIO) && beyond(lv(thu), lv(mw))) {
      mk(bull ? "CONSOL_THU_REVERSAL_BULL" : "CONSOL_THU_REVERSAL_BEAR", 4, `Mon-Wed range ${bull ? "low" : "high"}`, lv(thu), op(mw), `Mon-Wed range ${bull ? "high" : "low"}`);
      continue;
    }
    if (wed && ext === wed && mt && tight(mt, MIDWEEK_RATIO) && beyond(lv(wed), lv(mt))) {
      const expanded = !complete || days.some((x) => x.dow >= 4 && (bull ? x.h > mt.h : x.l < mt.l));
      if (expanded) {
        mk(bull ? "MIDWEEK_RALLY" : "MIDWEEK_DECLINE", 3, `Mon-Tue range ${bull ? "low" : "high"}`, lv(wed), op(mt), `Mon-Tue range ${bull ? "high" : "low"}`);
        continue;
      }
    }
    if (tue && mon && ext === tue && beyond(lv(tue), lv(mon)) && reached(tue)) {
      mk(bull ? "CLASSIC_TUE_LOW" : "CLASSIC_TUE_HIGH", 2, `Monday ${bull ? "low" : "high"}`, lv(tue), op(mon), `Monday ${bull ? "high" : "low"}`);
      continue;
    }
    if (wed && tue && mon && ext === wed && beyond(lv(wed), lv(tue)) && reached(wed)) {
      const trend = (tue.c - mon.o) / (priorRange || 1);                    // Mon-Tue drift as a share of the prior range
      const reversal = bull ? trend <= -WED_TREND_RATIO : trend >= WED_TREND_RATIO;
      mk(reversal ? (bull ? "WED_REVERSAL_BULL" : "WED_REVERSAL_BEAR") : (bull ? "WED_LOW" : "WED_HIGH"), 3,
        `Tuesday ${bull ? "low" : "high"}`, lv(wed), op(mon), `Monday ${bull ? "high" : "low"}`);
      continue;
    }
  }
  if (out.length) return out.sort((a, b) => b.extremeDow - a.extremeDow)[0];

  // Seek & Destroy: Mon-Thu shallow and two-sided (both sides of the prior EQ traded), Friday's final sweep.
  if (today === 5 && fri && thu && mth && tight(mth, SHALLOW_RATIO) && mth.l <= eq && mth.h >= eq) {
    const sweptLow = fri.l < thu.l, sweptHigh = fri.h > thu.h;
    const bull = sweptLow && (!sweptHigh || fri.c > fri.o);
    const bear = sweptHigh && (!sweptLow || fri.c < fri.o);
    if ((bull || bear) && (!complete || (bull ? weekBull || fri.c > fri.o : !weekBull || fri.c < fri.o))) {
      return bull
        ? { profile: "SEEK_DESTROY_BULL", bias: "BULLISH", extremeDow: 5, plan: { swept: "Thursday low", stop_ref: fri.l, t1: mon?.h ?? mth.h, t1_label: "Monday high", t2: prior.h, t2_label: "prior-week high" } }
        : { profile: "SEEK_DESTROY_BEAR", bias: "BEARISH", extremeDow: 5, plan: { swept: "Thursday high", stop_ref: fri.h, t1: mon?.l ?? mth.l, t1_label: "Monday low", t2: prior.l, t2_label: "prior-week low" } };
    }
    if (!complete) return { profile: "SEEK_DESTROY", bias: "NEUTRAL", extremeDow: 5, plan: null };
  }
  if (complete && (weekBull ? lowDay : highDay).dow === 1) return { profile: "MONDAY_EXTREME", bias: weekBull ? "BULLISH" : "BEARISH", extremeDow: 1, plan: null };
  return { profile: complete ? "OTHER" : "NO_PROFILE", bias: null, extremeDow: today, plan: null };
}

function isSell(direction: string | null) { return String(direction ?? "").toUpperCase().startsWith("S"); }
function alignedWith(bias: Bias, direction: string | null): boolean | null {
  if (bias !== "BULLISH" && bias !== "BEARISH") return null;
  return (bias === "BULLISH") === !isSell(direction);
}

export async function computeWeeklyProfile(pool: Pool, trade: WeeklyProfileTrade): Promise<WeeklyProfileResult> {
  const empty = (profile: ProfileCode, week: string | null = null, day: string | null = null): WeeklyProfileResult =>
    ({ week, signal_day: day, live: { profile, bias: null, aligned: null }, hindsight: null, levels: null, version: WEEKLY_PROFILE_VERSION });
  const symbol = String(trade.symbol ?? "").trim();
  const signal = trade.signalTs ? new Date(trade.signalTs) : null;
  const mkt = symbol ? marketOf(symbol, trade.market) : null;
  if (!symbol || !mkt || !signal || Number.isNaN(signal.getTime())) return empty("UNSUPPORTED");
  const cutoff = signal.getTime();

  const span = [new Date(cutoff - 16 * 86_400_000), new Date(cutoff + 8 * 86_400_000)] as const;
  const hourly = await loadHourly(pool, symbol, span[0], span[1]);
  const hourDays = toDays(hourly, mkt, false);
  // Equities: official daily bars first (hourly feeds have gaps); forex days roll at 17:00 NY so they come from hourly.
  const dayMap = new Map(hourDays.map((x) => [x.date, x]));
  if (mkt !== "forex") {
    for (const x of await loadDaily(pool, symbol, span[0], span[1], mkt === "india" ? "Asia/Kolkata" : "America/New_York")) dayMap.set(x.date, x);
  }
  // Last resort for symbols with only intraday data (e.g. SPY loaded for SMT): build missing days from 5m.
  const recentDays = [...dayMap.values()].filter((x) => x.firstT >= cutoff - 10 * 86_400_000 && x.firstT <= cutoff).length;
  if (recentDays < 5) {
    const fiveSpan = await loadFiveMin(pool, symbol, span[0], span[1], mkt === "forex");
    for (const x of toDays(fiveSpan, mkt, true)) if (!dayMap.has(x.date)) dayMap.set(x.date, x);
  }
  const allDays = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  // Signal's trading day: the session the signal falls in, else the next one.
  const sigDate = tradingDate(cutoff, mkt, true) ?? (() => {
    // Outside the session: pre-market belongs to today, after the close to the next session.
    const tz = mkt === "india" ? "Asia/Kolkata" : "America/New_York";
    const { date, minutes } = localParts(cutoff, tz);
    const afterClose = minutes >= (mkt === "india" ? 930 : 960);
    return allDays.find((x) => afterClose ? x.date > date : x.date >= date)?.date ?? null;
  })();
  if (!sigDate) return empty("NO_DATA");
  const week = mondayOf(sigDate);
  const dayName = DOW[dowOf(sigDate)];
  const priorMonday = mondayOf(new Date(new Date(`${week}T12:00:00Z`).getTime() - 3 * 86_400_000).toISOString().slice(0, 10));
  const priorDays = allDays.filter((x) => mondayOf(x.date) === priorMonday);
  const prior = rangeOf(priorDays);
  if (!prior || prior.h <= prior.l) return empty("NO_DATA", week, dayName);

  // Known at the signal: whole earlier days of this week from hourly bars, the signal day from completed 5m bars.
  const known = allDays.filter((x) => mondayOf(x.date) === week && x.date < sigDate);
  const dayStart = cutoff - 30 * HOUR_MS;
  const five = (await loadFiveMin(pool, symbol, new Date(dayStart), signal, mkt === "forex")).filter((b) => b.t + STEP_5M <= cutoff);
  const today = toDays(five, mkt, true).find((x) => x.date === sigDate)
    ?? toDays(hourly.filter((b) => b.t + HOUR_MS <= cutoff), mkt, false).find((x) => x.date === sigDate);
  if (today) known.push(today);
  if (!known.length) return empty("MONDAY_FORMING", week, dayName);
  // Signal before the day's first completed bar: classify as of the signal day with a flat placeholder bar.
  const last = known[known.length - 1];
  const asOf: DayBar[] = last.date === sigDate ? known
    : [...known, { ...last, date: sigDate, dow: dowOf(sigDate), o: last.c, h: last.c, l: last.c }];
  const live = classifyWeek(asOf, prior, false);

  const weekDays = allDays.filter((x) => mondayOf(x.date) === week);
  const nextMonday = new Date(new Date(`${week}T12:00:00Z`).getTime() + 7 * 86_400_000).getTime();
  const weekComplete = Date.now() > nextMonday && weekDays.length >= 3 && weekDays.some((x) => x.dow >= 4);
  let hindsight: WeeklyProfileResult["hindsight"] = null;
  if (weekComplete) {
    const h = classifyWeek(weekDays, prior, true);
    hindsight = { profile: h.profile, bias: h.bias, aligned: alignedWith(h.bias, trade.direction), low_day: DOW[extremeDay(weekDays, "low").dow], high_day: DOW[extremeDay(weekDays, "high").dow] };
  }
  const wtd = rangeOf(known)!;
  const mw = rangeOf(known.filter((x) => x.dow <= 3));
  return {
    week, signal_day: dayName,
    live: { profile: live.profile, bias: live.bias, aligned: alignedWith(live.bias, trade.direction), plan: live.plan },
    hindsight,
    levels: {
      pwh: prior.h, pwl: prior.l, eq: (prior.h + prior.l) / 2, wtd_high: wtd.h, wtd_low: wtd.l,
      wtd_high_day: DOW[extremeDay(known, "high").dow], wtd_low_day: DOW[extremeDay(known, "low").dow],
      mon_wed_ratio: mw && dowOf(sigDate) >= 4 ? Math.round(((mw.h - mw.l) / (prior.h - prior.l)) * 1000) / 1000 : null,
    },
    version: WEEKLY_PROFILE_VERSION,
  };
}

let schemaReady: Promise<void> | null = null;
function ensureSchema(pool: Pool) {
  schemaReady ??= pool.query(`CREATE TABLE IF NOT EXISTS ict_trade_weekly_profile (
      trade_key text PRIMARY KEY, symbol text, signal_ts timestamptz, direction text, week date,
      live_profile text NOT NULL, live_aligned boolean, hindsight_profile text, hindsight_aligned boolean,
      result jsonb NOT NULL, version text NOT NULL, computed_at timestamptz NOT NULL DEFAULT now())`)
    .then(() => undefined).catch((error) => { schemaReady = null; throw error; });
  return schemaReady;
}

/**
 * Weekly profiles for many trades: cached rows first, then up to `computeLimit` missing ones.
 * Only finished weeks (hindsight known) are cached; the current week is recomputed each request.
 */
export async function weeklyProfilesForTrades(pool: Pool, trades: WeeklyProfileTrade[], computeLimit = 150): Promise<Map<string, WeeklyProfileResult>> {
  const out = new Map<string, WeeklyProfileResult>();
  if (!trades.length) return out;
  await ensureSchema(pool);
  const keys = [...new Set(trades.map((t) => t.key))];
  const cached = await pool.query<{ trade_key: string; result: WeeklyProfileResult }>(
    `SELECT trade_key, result FROM ict_trade_weekly_profile WHERE trade_key = ANY($1) AND version = $2`, [keys, WEEKLY_PROFILE_VERSION]);
  for (const row of cached.rows) out.set(row.trade_key, row.result);
  const missing = trades.filter((t, i, all) => !out.has(t.key) && all.findIndex((x) => x.key === t.key) === i).slice(0, computeLimit);
  for (let i = 0; i < missing.length; i += 6) {
    const batch = missing.slice(i, i + 6);
    const results = await Promise.all(batch.map((t) => computeWeeklyProfile(pool, t).catch(() => null)));
    for (let j = 0; j < batch.length; j += 1) {
      const t = batch[j], r = results[j];
      if (!r) continue;
      out.set(t.key, r);
      if (!r.hindsight && r.live.profile !== "UNSUPPORTED") continue; // week still running (or data still arriving)
      await pool.query(`INSERT INTO ict_trade_weekly_profile (trade_key, symbol, signal_ts, direction, week, live_profile, live_aligned, hindsight_profile, hindsight_aligned, result, version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) ON CONFLICT (trade_key) DO UPDATE SET live_profile=EXCLUDED.live_profile, live_aligned=EXCLUDED.live_aligned,
        hindsight_profile=EXCLUDED.hindsight_profile, hindsight_aligned=EXCLUDED.hindsight_aligned, result=EXCLUDED.result, version=EXCLUDED.version, computed_at=now()`,
        [t.key, t.symbol, t.signalTs, t.direction, r.week, r.live.profile, r.live.aligned, r.hindsight?.profile ?? null, r.hindsight?.aligned ?? null, JSON.stringify(r), WEEKLY_PROFILE_VERSION]);
    }
  }
  return out;
}

/* ---------- filters / grouping shared by the APIs and dashboards ---------- */
export const WEEKLY_FILTERS = ["ALL", "ALIGNED", "OPPOSED", "ANY", "NONE", "AVOID_SD",
  "CLASSIC_TUE", "WED", "WED_REVERSAL", "CONSOL_THU", "MIDWEEK", "SEEK_DESTROY"] as const;
export type WeeklyFilter = (typeof WEEKLY_FILTERS)[number];
export function parseWeeklyFilter(value: string | null): WeeklyFilter {
  const v = String(value ?? "ALL").toUpperCase();
  return (WEEKLY_FILTERS as readonly string[]).includes(v) ? (v as WeeklyFilter) : "ALL";
}
const FAMILY: Partial<Record<ProfileCode, string>> = {
  CLASSIC_TUE_LOW: "CLASSIC_TUE", CLASSIC_TUE_HIGH: "CLASSIC_TUE", WED_LOW: "WED", WED_HIGH: "WED",
  CONSOL_THU_REVERSAL_BULL: "CONSOL_THU", CONSOL_THU_REVERSAL_BEAR: "CONSOL_THU",
  MIDWEEK_RALLY: "MIDWEEK", MIDWEEK_DECLINE: "MIDWEEK", WED_REVERSAL_BULL: "WED_REVERSAL", WED_REVERSAL_BEAR: "WED_REVERSAL",
  SEEK_DESTROY: "SEEK_DESTROY", SEEK_DESTROY_BULL: "SEEK_DESTROY", SEEK_DESTROY_BEAR: "SEEK_DESTROY",
};
export const isNamedProfile = (p: ProfileCode | undefined) => !!p && !!FAMILY[p];
/** Filters use the LIVE (known-at-signal) profile only. */
export function passesWeeklyFilter(result: WeeklyProfileResult | undefined, filter: WeeklyFilter): boolean {
  if (filter === "ALL") return true;
  const p = result?.live.profile;
  if (filter === "AVOID_SD") return !String(p ?? "").startsWith("SEEK_DESTROY");
  if (filter === "NONE") return !!result && !isNamedProfile(p);
  if (!isNamedProfile(p)) return false;
  if (filter === "ANY") return true;
  if (filter === "ALIGNED") return result?.live.aligned === true;
  if (filter === "OPPOSED") return result?.live.aligned === false;
  return FAMILY[p!] === filter;
}
export function weeklyLiveGroup(r: WeeklyProfileResult | undefined): string {
  if (!r) return "Pending";
  const p = r.live.profile;
  if (!isNamedProfile(p)) return p === "MONDAY_FORMING" ? "Monday - forming" : p === "NO_PROFILE" ? "No profile yet" : PROFILE_LABELS[p];
  const tag = r.live.aligned === true ? " · with trade" : r.live.aligned === false ? " · against trade" : "";
  return `${PROFILE_LABELS[p]}${tag}`;
}
export function weeklyHindsightGroup(r: WeeklyProfileResult | undefined): string {
  if (!r) return "Pending";
  if (!r.hindsight) return "Week not finished";
  const p = r.hindsight.profile;
  const tag = r.hindsight.aligned === true ? " · with trade" : r.hindsight.aligned === false ? " · against trade" : "";
  return `${PROFILE_LABELS[p]}${tag}`;
}
