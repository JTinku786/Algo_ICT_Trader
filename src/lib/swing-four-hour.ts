import type { ReplayBar } from "./weekly-replay";

/** Session-anchored, full four-hour OHLC windows. Missing / partial windows are withheld. */
export function swingFourHour(fiveMinute: ReplayBar[], hourly: ReplayBar[], market: string) {
  const anchor = market === "us" ? 570 : market === "india" ? 555 : 1020;
  const key = (b: ReplayBar) => `${b.day}:${Math.floor(((b.minute-anchor+1440)%1440)/240)}`;
  const groups = (source: ReplayBar[]) => {
    const out = new Map<string, ReplayBar[]>();
    for (const b of source) {
      if (market === "us" && (b.minute < 570 || b.minute >= 960) || market === "india" && (b.minute < 555 || b.minute >= 930)) continue;
      const id = key(b); const group = out.get(id) ?? []; group.push(b); out.set(id,group);
    }
    return out;
  };
  const fine = groups(fiveMinute), coarse = groups(hourly), bars: ReplayBar[] = [];
  let withheld = 0, hourlyWindows = 0;
  for (const id of new Set([...fine.keys(),...coarse.keys()])) {
    // Coarse data is used only where no finer rows exist, never to cover an observed fine-data hole.
    const rows = [...(fine.get(id) ?? coarse.get(id) ?? [])].sort((a,b)=>a.t-b.t);
    const duration = fine.has(id) ? 300000 : 3600000;
    const first = rows[0], last = rows.at(-1);
    if (!first || !last || ((first.minute-anchor+1440)%240) !== 0 || rows.length !== 14400000/duration || rows.some((b,i)=>b.knownAt-b.t!==duration || i>0 && b.t!==rows[i-1].knownAt) || last.knownAt-first.t!==14400000) { withheld++; continue; }
    if (!fine.has(id)) hourlyWindows++;
    bars.push({...first,h:Math.max(...rows.map(b=>b.h)),l:Math.min(...rows.map(b=>b.l)),c:last.c,knownAt:last.knownAt});
  }
  return { bars: bars.sort((a,b)=>a.t-b.t), withheld, hourlyWindows, anchor, policy: market === "forex" ? "New York clock: 17:00 / 21:00 / 01:00 / 05:00 / 09:00 / 13:00" : market === "us" ? "Regular-session anchor 09:30 New York; the 2.5-hour remainder is withheld" : "Regular-session anchor 09:15 Asia/Kolkata; the 2.25-hour remainder is withheld" };
}
