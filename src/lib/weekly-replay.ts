import { liquiditySweeps } from "./liquidity-sweeps";
import type { Candle, Frame as DailyFrame } from "./daily-bias";
export type ReplayFrame = DailyFrame | "10m" | "1m" | "2m" | "3m";
type Frame = ReplayFrame;
export const WEEKLY_REPLAY_VERSION = "weekly-replay-v1";
export type ReplayBar = Candle & {
    knownAt: number;
    v?: number;
};
export type Direction = "BUY" | "SELL" | "NEUTRAL" | "UNAVAILABLE";
export type WeeklyRange = {
    week: string;
    referenceWeek: string;
    first: string;
    last: string;
    high: number;
    low: number;
    midpoint: number;
    sessions: number;
};
export type WeeklyDecision = {
    day: string;
    knownAt: number;
    range: WeeklyRange | null;
    entering: Direction;
    direction: Direction;
    target: number | null;
    reason: string;
    highSwept: boolean;
    lowSwept: boolean;
    previousDrawHit: boolean;
};
export type IctKind = "VI" | "MITIGATION" | "PROPULSION" | "WICK" | "REJECTION" | "GAP" | "NYOPEN" | "BPR" | "FVG" | "IFVG" | "OB" | "BREAKER" | "EQH" | "EQL" | "BSL" | "SSL" | "BOS" | "CHOCH";
export type IctOverlay = {
    id: string;
    kind: IctKind;
    tf: Frame | "4h" | "1w" | "1mo";
    direction: "BUY" | "SELL";
    low: number;
    high: number;
    origin: number;
    knownAt: number;
    originDay: string;
    touches: number;
    lastTouch: number | null;
    status: "ACTIVE" | "TOUCHED" | "SWEPT";
    description: string;
    lineage?: string;
};
export type ReplayData = {
    version: string;
    instrument: {
        name: string;
        symbol: string;
        market: string;
        zone: string;
    };
    frame: Frame;
    daily: ReplayBar[];
    bars: ReplayBar[];
    invalidDailyDays: string[];
    audit: {
        invalid: number;
        duplicates: number;
        conflicts: number;
        sources: string[];
        missingDailyContext: boolean;
    };
    generatedAt: string;
    provenance: string;
};
export function weekStart(day: string) {
    const date = new Date(`${day}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    return date.toISOString().slice(0, 10);
}
export function previousWeek(day: string) {
    const date = new Date(`${weekStart(day)}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 7);
    return date.toISOString().slice(0, 10);
}
export function weeklyReference(daily: ReplayBar[], day: string, invalidDays: string[] = []): WeeklyRange | null {
    const referenceWeek = previousWeek(day);
    if (invalidDays.some(d => weekStart(d) === referenceWeek))
        return null;
    const completedWeek = daily.filter(b => weekStart(b.day) === referenceWeek);
    if (!completedWeek.length)
        return null;
    const high = Math.max(...completedWeek.map(b => b.h)), low = Math.min(...completedWeek.map(b => b.l));
    return { week: weekStart(day), referenceWeek, first: completedWeek[0].day, last: completedWeek.at(-1)!.day, high, low, midpoint: (high + low) / 2, sessions: completedWeek.length };
}
// A chart narrative persists within its reference week until its draw is reached.
// It is explanatory and does not replace the independently scored table variant.
export function weeklyDecisions(daily: ReplayBar[], invalidDays: string[] = []): WeeklyDecision[] {
    const out: WeeklyDecision[] = [];
    let direction: Direction = "NEUTRAL", target: number | null = null, activeWeek = "";
    for (let i = 0; i < daily.length; i++) {
        const b = daily[i], range = weeklyReference(daily.slice(0, i), b.day, invalidDays);
        if (activeWeek !== weekStart(b.day)) {
            direction = "NEUTRAL";
            target = null;
            activeWeek = weekStart(b.day);
        }
        const entering = direction;
        const previousDrawHit = target !== null && (direction === "BUY" ? b.h >= target : b.l <= target);
        let reason = "Inside weekly range; no fresh weekly rejection or breakout.";
        let highSwept = false, lowSwept = false;
        if (!range || invalidDays.some(d => d > (daily[i - 1]?.day ?? b.day) && d <= b.day)) {
            direction = "UNAVAILABLE";
            target = null;
            reason = "Prior-week range or daily context is missing/invalid.";
        }
        else {
            highSwept = b.h > range.high;
            lowSwept = b.l < range.low;
            if (b.c > range.high) {
                direction = "BUY";
                target = b.h;
                reason = "Daily close above PWH: bullish continuation toward the latest daily high.";
            }
            else if (b.c < range.low) {
                direction = "SELL";
                target = b.l;
                reason = "Daily close below PWL: bearish continuation toward the latest daily low.";
            }
            else if (highSwept && lowSwept) {
                direction = "NEUTRAL";
                target = null;
                reason = "Both weekly extremes swept and close inside: conflicting rejection.";
            }
            else if (lowSwept && b.c > range.low) {
                direction = "BUY";
                target = range.high;
                reason = "PWL swept, daily close back above: draw toward PWH.";
            }
            else if (highSwept && b.c < range.high) {
                direction = "SELL";
                target = range.low;
                reason = "PWH swept, daily close back below: draw toward PWL.";
            }
            else if (previousDrawHit) {
                direction = "NEUTRAL";
                target = null;
                reason = "Existing draw reached; no fresh directional weekly event.";
            }
            else if ((direction === "BUY" || direction === "SELL") && target !== null) {
                reason = "No fresh weekly event: retain the established narrative while its draw is unmet.";
            }
            else {
                direction = "NEUTRAL";
                target = null;
            }
        }
        out.push({ day: b.day, knownAt: b.knownAt, range, entering, direction, target, reason, highSwept, lowSwept, previousDrawHit });
    }
    return out;
}
type Pivot = {
    price: number;
    index: number;
    knownAt: number;
    high: boolean;
    broken: boolean;
};
function atr(bars: ReplayBar[], end: number) {
    const start = Math.max(1, end - 14), sample = bars.slice(start, end);
    if (!sample.length)
        return bars[end]?.h - bars[end]?.l || 0;
    return sample.reduce((sum, b, n) => {
        const prev = bars[start + n - 1];
        return sum + Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c));
    }, 0) / sample.length;
}
export function deriveIctOverlays(input: ReplayBar[], tf: Frame | "4h" | "1w" | "1mo", market: string, daily: ReplayBar[]): IctOverlay[] {
    // Bounded, deterministic replay context. No post-cursor bars are passed here.
    // Keep source history: an older untouched imbalance remains a valid chart reference.
    const bars = input, zones: IctOverlay[] = [], pivots: Pivot[] = [];
    const dailyIndex = new Map(daily.map((b, i) => [b.day, i]));
    const minutes = { "1mo": 0, "1w": 0, "1d": 0, "4h": 240, "1h": 60, "30m": 30, "15m": 15, "5m": 5, "10m":10, "1m": 1, "2m": 2, "3m": 3 }[tf];
    const open = market === "india" ? 555 : market === "us" ? 570 : 0;
    const close = market === "india" ? 930 : market === "us" ? 960 : 1440;
    const consecutive = (a: ReplayBar, b: ReplayBar) => {
        if (tf === "1mo") return new Date(b.day).getUTCFullYear() * 12 + new Date(b.day).getUTCMonth() === new Date(a.day).getUTCFullYear() * 12 + new Date(a.day).getUTCMonth() + 1;
        if (tf === "1w")
            return new Date(`${b.day}T12:00:00Z`).getTime() - new Date(`${a.day}T12:00:00Z`).getTime() === 7 * 86400000;
        if (tf === "1d")
            return dailyIndex.get(b.day) === dailyIndex.get(a.day)! + 1;
        if (a.day === b.day || market === "forex")
            return b.t - a.t === minutes * 60000;
        return b.minute === open && a.minute === open + (Math.ceil((close - open) / minutes) - 1) * minutes
            && dailyIndex.has(a.day) && dailyIndex.get(b.day) === dailyIndex.get(a.day)! + 1;
    };
    let lastBreak: "BUY" | "SELL" | null = null;
    const add = (kind: IctKind, direction: "BUY" | "SELL", low: number, high: number, originIndex: number, knownIndex: number, description: string, lineage?: string) => {
        const origin = bars[originIndex], known = bars[knownIndex];
        const zone: IctOverlay = { id: `${tf}-${kind}-${known.t}-${origin.t}-${direction}`, kind, tf, direction, low, high, origin: origin.t, originDay: origin.day, knownAt: known.knownAt, touches: 0, lastTouch: null, status: "ACTIVE", description, lineage };
        if (!zones.some(z => z.id === zone.id))
            zones.push(zone);
    };
    for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        // Replay touches/invalidation only AFTER detection; never backdate a breaker.
        for (const z of [...zones]) {
            if (z.knownAt >= b.knownAt || z.status === "SWEPT")
                continue;
            const line = z.kind === "EQH" || z.kind === "EQL" || z.kind === "BSL" || z.kind === "SSL";
            const touched = line ? (z.direction === "SELL" ? b.h >= z.high : b.l <= z.low) : b.h >= z.low && b.l <= z.high;
            if (touched) {
                z.touches++;
                z.lastTouch = b.t;
                z.status = "TOUCHED";
            }
            const invalidated = line ? touched : z.direction === "BUY" ? b.c < z.low : b.c > z.high;
            if (!invalidated)
                continue;
            z.status = "SWEPT";
            if (z.kind === "FVG") {
                add("IFVG", z.direction === "BUY" ? "SELL" : "BUY", z.low, z.high, i, i, `${z.kind === "FVG" ? "Inverse FVG" : "Breaker candidate"}: close through the original ${z.direction} zone; original formed ${z.originDay}.`, z.id);
            }
        }
        if (i >= 4 && [i - 3, i - 2, i - 1, i].every(j => consecutive(bars[j - 1], bars[j]))) {
            const p = i - 2, neighbors = [bars[p - 2], bars[p - 1], bars[p + 1], bars[p + 2]];
            for (const high of [true, false]) {
                const price = high ? bars[p].h : bars[p].l;
                if (!neighbors.every(x => high ? x.h < price : x.l > price))
                    continue;
                const tolerance = Math.max(atr(bars, i) * 0.1, Math.abs(price) * 0.00001);
                const older = [...pivots].reverse().find(x => x.high === high && !x.broken && Math.abs(x.price - price) <= tolerance && i - x.index <= 120
                    && !bars.slice(x.index + 1, p).some(xb => high ? xb.h > Math.max(price, x.price) : xb.l < Math.min(price, x.price)));
                pivots.push({ price, index: p, knownAt: b.knownAt, high, broken: false });
                add(high ? "BSL" : "SSL", high ? "SELL" : "BUY", price, price, p, i, `Confirmed swing ${high ? "high / buyside" : "low / sellside"}; two completed candles on each side.`);
                if (older)
                    add(high ? "EQH" : "EQL", high ? "SELL" : "BUY", Math.min(price, older.price), Math.max(price, older.price), p, i, `Two confirmed ${high ? "highs" : "lows"} within 0.1 × prior 14-bar ATR (${tolerance.toFixed(4)}); older pivot ${bars[older.index].day}.`);
            }
        }
        const high = [...pivots].reverse().find(p => p.high && !p.broken && p.knownAt < b.knownAt);
        const low = [...pivots].reverse().find(p => !p.high && !p.broken && p.knownAt < b.knownAt);
        const broken = high && b.c > high.price ? high : low && b.c < low.price ? low : null;
        if (broken) {
            const direction = broken.high ? "BUY" : "SELL";
            add(lastBreak && lastBreak !== direction ? "CHOCH" : "BOS", direction, broken.price, broken.price, i, i, `Completed close through a confirmed swing; ${lastBreak && lastBreak !== direction ? "opposes" : "matches / establishes"} last observed break direction.`);
            lastBreak = direction;
            for (const p of pivots)
                if (p.high === broken.high && (broken.high ? b.c > p.price : b.c < p.price))
                    p.broken = true;
            if (Math.abs(b.c - b.o) >= atr(bars, i) && i >= 14) {
                for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
                    if (direction === "BUY" ? bars[j].c < bars[j].o : bars[j].c > bars[j].o) {
                        add("OB", direction, bars[j].l, bars[j].h, j, i, "OB candidate: last opposite candle within six bars before a confirmed swing break; break body ≥ prior 14-bar ATR. Full wick range.");
                        break;
                    }
                }
            }
        }
        if (i >= 1 && bars[i - 1].day === b.day && consecutive(bars[i - 1], b)) {
            const a = bars[i - 1];
            const ah = Math.max(a.o, a.c), al = Math.min(a.o, a.c), bh = Math.max(b.o, b.c), bl = Math.min(b.o, b.c);
            if (Math.max(a.l, b.l) <= Math.min(a.h, b.h)) {
                if (bl > ah) add("VI", "BUY", ah, bl, i - 1, i, "Volume imbalance: non-overlapping adjacent candle bodies with overlapping wicks; confirmed at second candle close. OHLC geometry, not bid/ask volume delta.");
                if (bh < al) add("VI", "SELL", bh, al, i - 1, i, "Volume imbalance: non-overlapping adjacent candle bodies with overlapping wicks; confirmed at second candle close. OHLC geometry, not bid/ask volume delta.");
            }
        }
        if (i >= 2 && consecutive(bars[i - 2], bars[i - 1]) && consecutive(bars[i - 1], b)) {
            const a = bars[i - 2], middle = bars[i - 1];
            if (b.l > a.h && middle.c > middle.o)
                add("FVG", "BUY", a.h, b.l, i-2, i, "Bullish three-candle imbalance with a bullish middle body; anchored to the first candle, known at third candle close.");
            if (b.h < a.l && middle.c < middle.o)
                add("FVG", "SELL", b.h, a.l, i-2, i, "Bearish three-candle imbalance with a bearish middle body; anchored to the first candle, known at third candle close.");
        }
    }
    return [...zones,...liquiditySweeps(bars,tf).breakers];
}
export function buildWeeklyReplay(data: ReplayData, cutoff: number) {
    const daily = data.daily.filter(b => b.knownAt <= cutoff), bars = data.bars.filter(b => b.knownAt <= cutoff);
    const decisions = weeklyDecisions(daily, data.invalidDailyDays), last = bars.at(-1), latest = decisions.at(-1);
    const day = last?.day ?? daily.at(-1)?.day;
    const range = day ? weeklyReference(daily, day, data.invalidDailyDays) : null;
    const rolled = latest && range && latest.range?.week !== range.week;
    const direction: Direction = !range ? "UNAVAILABLE" : rolled ? "NEUTRAL" : latest?.direction ?? "NEUTRAL";
    const target = rolled ? null : latest?.target ?? null;
    const selectedOverlays = deriveIctOverlays(bars, data.frame, data.instrument.market, daily);
    const dailyOverlays = data.frame === "1d" ? [] : deriveIctOverlays(daily, "1d", data.instrument.market, daily);
    const overlays = [...selectedOverlays, ...dailyOverlays];
    const previousDay = daily.filter(b => !day || b.day < day).at(-1) ?? null;
    const intradayDrawHit = data.frame !== "1d" && target !== null && latest && bars.some(b => b.knownAt > latest.knownAt && (direction === "BUY" ? b.h >= target : b.l <= target));
    const alignment = overlays.filter(z => z.status !== "SWEPT" && z.kind !== "BOS" && z.kind !== "CHOCH")
        .filter(z => last && z.knownAt < last.knownAt && last.h >= z.low && last.l <= z.high)
        .map(z => ({ ...z, alignment: direction === "NEUTRAL" || direction === "UNAVAILABLE" ? "CONTEXT" : z.kind === "EQH" || z.kind === "BSL" ? direction === "BUY" ? "TARGET LIQUIDITY" : "OPPOSING LIQUIDITY" : z.kind === "EQL" || z.kind === "SSL" ? direction === "SELL" ? "TARGET LIQUIDITY" : "OPPOSING LIQUIDITY" : z.direction === direction ? "ALIGNED" : "OPPOSES" }));
    return { cutoff, daily, bars, decisions, range, direction, target, latest, previousDay, overlays, alignment, intradayDrawHit,
        reason: rolled ? "New reference week: wait for a completed daily event against the new range." : latest?.reason ?? "No completed daily context available." };
}
// Only weeks strictly before the replay week are completed; never expose a forming week.
export function completedWeeklyBars(daily: ReplayBar[], replayDay: string, invalidDays: string[] = []): ReplayBar[] {
    const groups = new Map<string, ReplayBar[]>();
    for (const b of daily) {
        const w = weekStart(b.day);
        if (w >= weekStart(replayDay) || invalidDays.some(d => weekStart(d) === w))
            continue;
        groups.set(w, [...(groups.get(w) ?? []), b]);
    }
    return [...groups].map(([day, bs]) => ({ ...bs[0], day, o: bs[0].o, h: Math.max(...bs.map(b => b.h)), l: Math.min(...bs.map(b => b.l)), c: bs.at(-1)!.c, v: bs.reduce((n,b)=>n+(b.v??0),0), knownAt: bs.at(-1)!.knownAt }));
}
export function dailyExplanations(daily: ReplayBar[], market: string, invalidDays: string[] = []) {
    return daily.slice(-40).map((b, n) => {
        const i = Math.max(0, daily.length - 40) + n;
        const prefix = daily.slice(0, i + 1), before = daily.slice(0, i);
        const zones = deriveIctOverlays(before, "1d", market, before);
        const path = confirmedSwingPath(before, "1d", invalidDays);
        const highs = path.filter(z => z.kind === "HIGH").map(z => ({ ...z, high: z.price })), lows = path.filter(z => z.kind === "LOW").map(z => ({ ...z, low: z.price }));
        const hh = highs.length >= 2 ? highs.at(-1)!.high > highs.at(-2)!.high : null;
        const ll = lows.length >= 2 ? lows.at(-1)!.low < lows.at(-2)!.low : null;
        const higherLow = lows.length >= 2 && lows.at(-1)!.low > lows.at(-2)!.low;
        const lowerHigh = highs.length >= 2 && highs.at(-1)!.high < highs.at(-2)!.high;
        const range = weeklyReference(before, b.day, invalidDays);
        const swingPools = path.filter(s => !before.some(x => x.knownAt > s.knownAt && (s.kind === "HIGH" ? x.h >= s.price : x.l <= s.price))).map(s => ({ kind: s.kind === "HIGH" ? "BSL" : "SSL", high: s.price, low: s.price, direction: s.kind === "HIGH" ? "SELL" : "BUY" }));
        const hunted = [...zones.filter(z => ["EQH", "EQL"].includes(z.kind) && z.status !== "SWEPT"), ...swingPools].filter(z => z.direction === "SELL" ? b.h >= z.high : b.l <= z.low);
        const rebalanced = zones.filter(z => ["FVG", "IFVG"].includes(z.kind) && z.status !== "SWEPT" && b.h >= z.low && b.l <= z.high);
        const fresh = [...deriveIctOverlays(prefix, "1d", market, prefix).filter(z => z.knownAt === b.knownAt && ["EQH", "EQL"].includes(z.kind)), ...confirmedSwingPath(prefix, "1d", invalidDays).filter(s => s.knownAt === b.knownAt).map(s => ({ kind: s.kind === "HIGH" ? "BSL" : "SSL", high: s.price }))];
        const reasons: {
            label: string;
            evidence: string;
        }[] = [];
        if (hunted.length || (range && (b.h > range.high || b.l < range.low)))
            reasons.push({ label: "Hunt Liquidity", evidence: [...hunted.map(z => `${z.kind} ${z.high.toFixed(2)}`), ...(range && b.h > range.high ? [`PWH ${range.high.toFixed(2)}`] : []), ...(range && b.l < range.low ? [`PWL ${range.low.toFixed(2)}`] : [])].join("; ") });
        if (rebalanced.length)
            reasons.push({ label: "Rebalanced inefficiencies", evidence: rebalanced.map(z => `${z.kind} ${z.low.toFixed(2)}–${z.high.toFixed(2)}`).join("; ") });
        if (fresh.length)
            reasons.push({ label: "generate liquidity", evidence: fresh.map(z => `${z.kind} confirmed today at ${z.high.toFixed(2)}`).join("; ") });
        if (range && b.l <= range.midpoint && b.h >= range.midpoint)
            reasons.push({ label: "rebalance equilibrium", evidence: `Weekly midpoint ${range.midpoint.toFixed(2)} traded` });
        return { day: b.day, reasons, structure: hh === null || ll === null ? "Insufficient confirmed swings" : hh && higherLow ? "Higher highs / higher lows" : lowerHigh && ll ? "Lower highs / lower lows" : hh && ll ? "Expanding: higher highs and lower lows" : lowerHigh && higherLow ? "Contracting: lower highs and higher lows" : "Mixed / equal swings", higherHighs: hh, lowerLows: ll, closeEvidence: highs.length && b.c > highs.at(-1)!.high ? "Close above last confirmed swing high" : lows.length && b.c < lows.at(-1)!.low ? "Close below last confirmed swing low" : "No close through last confirmed swings", swingHigh: highs.at(-1)?.high ?? null, swingLow: lows.at(-1)?.low ?? null };
    });
}
export type ReplaySwing = {
    kind: "HIGH" | "LOW";
    price: number;
    origin: number;
    day: string;
    knownAt: number;
};
// Strict three-candle pivots. Same-type extremes are consolidated on the revealed
// prefix, like SMC's cleanup, without fabricated first/last endpoint swings.
export function confirmedSwingPath(input: ReplayBar[], tf: Frame | "4h" | "1w" | "1mo" = "1d", invalidDays: string[] = []): ReplaySwing[] {
    const out: ReplaySwing[] = [];
    for (let i = 2; i < input.length; i++) {
        const a = input[i - 2], p = input[i - 1], r = input[i];
        if (tf === "1mo") {
            const serial = (day: string) => new Date(day).getUTCFullYear() * 12 + new Date(day).getUTCMonth();
            if (serial(p.day) !== serial(a.day) + 1 || serial(r.day) !== serial(p.day) + 1) continue;
        }
        if (tf === "1w" && (previousWeek(p.day) !== weekStart(a.day) || previousWeek(r.day) !== weekStart(p.day)))
            continue;
        if (tf !== "1d" && tf !== "1w" && tf !== "1mo") {
            const duration = { "4h": 240, "1h": 60, "30m": 30, "15m": 15, "5m": 5, "10m":10, "1m": 1, "2m": 2, "3m": 3 }[tf] * 60000;
            if (p.t - a.t !== duration || r.t - p.t !== duration)
                continue;
        }
        if (tf === "1d" && invalidDays.some(d => d > a.day && d < r.day))
            continue;
        const high = p.h > a.h && p.h > r.h, low = p.l < a.l && p.l < r.l;
        // An outside bar can meet both tests. OHLC does not establish its price order.
        if (high === low)
            continue;
        const swing: ReplaySwing = { kind: high ? "HIGH" : "LOW", price: high ? p.h : p.l, origin: p.t, day: p.day, knownAt: r.knownAt };
        const last = out.at(-1);
        if (last?.kind === swing.kind) {
            if (swing.kind === "HIGH" ? swing.price > last.price : swing.price < last.price)
                out[out.length - 1] = swing;
        }
        else
            out.push(swing);
    }
    return out;
}
