export type IctSessionClock = "NEW_YORK" | "INDIA";

export type IctSessionDefinition = {
  id: string;
  label: string;
  displayLabel: string;
  clock: IctSessionClock;
  startMinute: number;
  endMinute: number;
  marker?: boolean;
  market?: "INDIA";
};

const minutes = (hour: number, minute = 0) => hour * 60 + minute;

// ICT windows are defined in New York wall-clock time. America/New_York makes
// the UTC conversion follow the real EDT/EST transition dates automatically.
// NSE is the exception: it is fixed to Asia/Kolkata throughout the year.
export const ICT_SESSION_DEFINITIONS = [
  { id: "asian_range", label: "Asian Range", displayLabel: "Asian Range · 19:00–00:00 ET", clock: "NEW_YORK", startMinute: minutes(19), endMinute: minutes(0) },
  { id: "asian_killzone", label: "Asian Killzone", displayLabel: "Asian Killzone · 20:00–00:00 ET", clock: "NEW_YORK", startMinute: minutes(20), endMinute: minutes(0) },
  { id: "ny_midnight_open", label: "NY Midnight Open", displayLabel: "NY Midnight Open · 00:00 ET", clock: "NEW_YORK", startMinute: minutes(0), endMinute: minutes(0, 1), marker: true },
  { id: "macro_london_midnight", label: "Macro 1: London Midnight", displayLabel: "Macro 1: London Midnight · 02:33–03:00 ET", clock: "NEW_YORK", startMinute: minutes(2, 33), endMinute: minutes(3) },
  { id: "london_open_killzone", label: "London Open Killzone", displayLabel: "London Open Killzone · 02:00–05:00 ET", clock: "NEW_YORK", startMinute: minutes(2), endMinute: minutes(5) },
  { id: "london_silver_bullet", label: "London Silver Bullet", displayLabel: "London Silver Bullet · 03:00–04:00 ET", clock: "NEW_YORK", startMinute: minutes(3), endMinute: minutes(4) },
  { id: "macro_london_am", label: "Macro 2: London AM", displayLabel: "Macro 2: London AM · 04:03–04:30 ET", clock: "NEW_YORK", startMinute: minutes(4, 3), endMinute: minutes(4, 30) },
  { id: "london_lunch", label: "London Lunch (Dead Zone)", displayLabel: "London Lunch (Dead Zone) · 05:00–07:00 ET", clock: "NEW_YORK", startMinute: minutes(5), endMinute: minutes(7) },
  { id: "new_york_open_killzone", label: "New York Open Killzone", displayLabel: "New York Open Killzone · 07:00–10:00 ET", clock: "NEW_YORK", startMinute: minutes(7), endMinute: minutes(10) },
  { id: "macro_ny_pre_market", label: "Macro 3: NY Pre-Market", displayLabel: "Macro 3: NY Pre-Market · 08:30–09:15 ET", clock: "NEW_YORK", startMinute: minutes(8, 30), endMinute: minutes(9, 15) },
  { id: "nse_india_market", label: "NSE India Market", displayLabel: "NSE India Market · 09:15–15:30 IST", clock: "INDIA", startMinute: minutes(9, 15), endMinute: minutes(15, 30), market: "INDIA" },
  { id: "ny_am_session", label: "NY AM Session", displayLabel: "NY AM Session · 09:30–12:00 ET", clock: "NEW_YORK", startMinute: minutes(9, 30), endMinute: minutes(12) },
  { id: "opening_range_equities", label: "Opening Range (Equities)", displayLabel: "Opening Range (Equities) · 09:30–10:30 ET", clock: "NEW_YORK", startMinute: minutes(9, 30), endMinute: minutes(10, 30) },
  { id: "macro_ny_opening_drive", label: "Macro 4: NY Opening Drive", displayLabel: "Macro 4: NY Opening Drive · 09:50–10:10 ET", clock: "NEW_YORK", startMinute: minutes(9, 50), endMinute: minutes(10, 10) },
  { id: "am_silver_bullet", label: "AM Silver Bullet", displayLabel: "AM Silver Bullet · 10:00–11:00 ET", clock: "NEW_YORK", startMinute: minutes(10), endMinute: minutes(11) },
  { id: "macro_ny_mid_morning", label: "Macro 5: NY Mid-Morning", displayLabel: "Macro 5: NY Mid-Morning · 10:50–11:10 ET", clock: "NEW_YORK", startMinute: minutes(10, 50), endMinute: minutes(11, 10) },
  { id: "london_close_killzone", label: "London Close Killzone", displayLabel: "London Close Killzone · 10:00–12:00 ET", clock: "NEW_YORK", startMinute: minutes(10), endMinute: minutes(12) },
  { id: "macro_london_close_lunch", label: "Macro 6: London Close / Lunch", displayLabel: "Macro 6: London Close / Lunch · 11:50–12:10 ET", clock: "NEW_YORK", startMinute: minutes(11, 50), endMinute: minutes(12, 10) },
  { id: "new_york_lunch", label: "New York Lunch", displayLabel: "New York Lunch · 12:00–13:30 ET", clock: "NEW_YORK", startMinute: minutes(12), endMinute: minutes(13, 30) },
  { id: "new_york_pm_session", label: "New York PM Session", displayLabel: "New York PM Session · 13:30–16:00 ET", clock: "NEW_YORK", startMinute: minutes(13, 30), endMinute: minutes(16) },
  { id: "macro_pm_true_drive", label: "Macro 6b: PM True Drive", displayLabel: "Macro 6b: PM True Drive · 13:50–14:10 ET", clock: "NEW_YORK", startMinute: minutes(13, 50), endMinute: minutes(14, 10) },
  { id: "pm_silver_bullet", label: "PM Silver Bullet", displayLabel: "PM Silver Bullet · 14:00–15:00 ET", clock: "NEW_YORK", startMinute: minutes(14), endMinute: minutes(15) },
  { id: "cbdr", label: "CBDR (True 6-Hour Block)", displayLabel: "CBDR (True 6-Hour Block) · 14:00–20:00 ET", clock: "NEW_YORK", startMinute: minutes(14), endMinute: minutes(20) },
  { id: "macro_ny_late_pm", label: "Macro 7: NY Late PM", displayLabel: "Macro 7: NY Late PM · 15:15–15:45 ET", clock: "NEW_YORK", startMinute: minutes(15, 15), endMinute: minutes(15, 45) },
  { id: "power_hour_equities", label: "Power Hour (Equities)", displayLabel: "Power Hour (Equities) · 15:00–16:00 ET", clock: "NEW_YORK", startMinute: minutes(15), endMinute: minutes(16) },
  { id: "ny_close", label: "NY Close (Algorithmic Cutoff)", displayLabel: "NY Close (Algorithmic Cutoff) · 16:00 ET", clock: "NEW_YORK", startMinute: minutes(16), endMinute: minutes(16, 1), marker: true },
] as const satisfies readonly IctSessionDefinition[];

export type IctSessionId = (typeof ICT_SESSION_DEFINITIONS)[number]["id"];

export const ICT_SESSION_IDS: IctSessionId[] = ICT_SESSION_DEFINITIONS.map((session) => session.id);

const ICT_SESSION_ID_SET = new Set<string>(ICT_SESSION_IDS);
const NEW_YORK_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const INDIA_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function minuteOfDay(date: Date, formatter: Intl.DateTimeFormat) {
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return Number.isFinite(hour) && Number.isFinite(minute) ? (hour % 24) * 60 + minute : null;
}

function isWithinWindow(minute: number, definition: IctSessionDefinition) {
  if (definition.marker) return minute === definition.startMinute;
  if (definition.endMinute > definition.startMinute) {
    return minute >= definition.startMinute && minute < definition.endMinute;
  }
  return minute >= definition.startMinute || minute < definition.endMinute;
}

function isIndiaMarket(market?: string | null, symbol?: string | null) {
  const normalizedMarket = (market || "").toUpperCase();
  const normalizedSymbol = (symbol || "").toUpperCase();
  return normalizedMarket === "INDIA"
    || ["NIFTY50", "BANKNIFTY"].includes(normalizedSymbol)
    || normalizedSymbol.endsWith(".NS")
    || normalizedSymbol.endsWith(".BO")
    || /^NSE:|^BSE:/.test(normalizedSymbol);
}

export function getIctSessionIds(timestamp: string | Date | null | undefined, market?: string | null, symbol?: string | null): IctSessionId[] {
  if (!timestamp) return [];
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return [];
  const newYorkMinute = minuteOfDay(date, NEW_YORK_CLOCK);
  const indiaMinute = isIndiaMarket(market, symbol) ? minuteOfDay(date, INDIA_CLOCK) : null;
  return ICT_SESSION_DEFINITIONS
    .filter((definition) => {
      if (definition.clock === "INDIA" && indiaMinute === null) return false;
      const minute = definition.clock === "INDIA" ? indiaMinute : newYorkMinute;
      return minute !== null && isWithinWindow(minute, definition);
    })
    .map((definition) => definition.id);
}

export function parseIctSessionSelection(raw: string | null | undefined): IctSessionId[] | null {
  if (!raw || raw.trim().toUpperCase() === "ALL") return null;
  if (raw.trim().toUpperCase() === "NONE") return [];
  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is IctSessionId => ICT_SESSION_ID_SET.has(value));
}

// Sessions overlap (e.g. a 14:30 entry is PM Silver Bullet + NY PM Session + CBDR).
// A trade passes only if it sits in at least one selected session AND in no
// deselected one, so unticking a session removes every trade inside its window.
export function passesIctSessionFilter(tradeSessions: readonly string[], selected: ReadonlySet<string> | null) {
  if (selected === null) return true;
  return tradeSessions.some((id) => selected.has(id)) && tradeSessions.every((id) => selected.has(id));
}

export function ictSessionDisplayLabel(id: string) {
  return ICT_SESSION_DEFINITIONS.find((session) => session.id === id)?.displayLabel ?? id;
}
