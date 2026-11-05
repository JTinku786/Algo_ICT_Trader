// Agent Desk: the real-time trading system shown as six agents with hard handoffs.
//   SCOUT    finds candidates      (strategy scans → signals)
//   FILTER   kills what fails rules (scalping f_* rule flags, eligibility)
//   ANALYST  scores what's left    (Titania ML probability where a lane has a model)
//   EXECUTOR places the trades     (armed limits, paper/live entries)
//   RISK     guards every entry    (stop-before-entry cancels, live-gate blocks, stops)
//   LOGGER   writes everything     (every event, Discord alerts)
// Read-only. Every number comes from the realtime_production_* / live tables.
import { getPostgresPool } from "@/lib/db";

export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;
export type DeskStage = "scout" | "filter" | "analyst" | "executor" | "risk" | "logger";
export type DeskEvent = {
  ts: string;
  stage: DeskStage;
  kind: "SIGNAL" | "PASS" | "KILL" | "SCORE" | "ARM" | "ENTER" | "CANCEL" | "BLOCK" | "WIN" | "LOSS" | "EXIT" | "ALERT";
  lane: string;
  ticker: string;
  side?: string | null;
  text: string;
  r?: number | null;
  score?: number | null;
  rule?: string | null;
  rules?: { key: string; label: string; pass: boolean }[];
  signals?: { label: string; value: string }[];
  live?: boolean;
};

const LANES: Record<string, { name: string; market: string; mode: string }> = {
  V4: { name: "Scalping OB×OB V4", market: "US options", mode: "paper" },
  BPR: { name: "BPR×OB V3", market: "US options", mode: "paper" },
  IFVG: { name: "IFVG×OB V1", market: "US options", mode: "paper" },
  K1: { name: "Reversal k1", market: "US + FX", mode: "paper · FX 1H live" },
  ICT: { name: "ICT S16 · S03 · S-CH08 · S-CH10", market: "India + US", mode: "live + paper" },
  IGS: { name: "IGS01V2 London sweep", market: "FX", mode: "OANDA practice" },
};

const RULE_LABELS: Record<string, string> = {
  f_session: "entry inside the lane's session window",
  f_not_repeat: "not a repeat setup",
  f_open_price: "entry on the right side of today's open",
  f_quiet_or_nested: "quiet open or 5m OB nested in 1h OB",
};
const ruleLabel = (k: string) => RULE_LABELS[k] ?? k.replace(/^f_/, "").replace(/_/g, " ");

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const iso = (v: unknown): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const obj = (v: unknown): Row => {
  if (!v) return {};
  if (typeof v === "string") { try { return JSON.parse(v) as Row; } catch { return {}; } }
  return typeof v === "object" ? (v as Row) : {};
};
const fmt = (v: unknown, d = 2) => { const n = num(v); return n === null ? "—" : n.toFixed(d); };
const short = (s: unknown) => String(s ?? "").replace(/^%5E/i, "^");

async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  try {
    const res = await getPostgresPool().query(sql, params);
    return res.rows as Row[];
  } catch (e) {
    console.error("[agent-desk]", (e as Error).message);
    return [];
  }
}

const SCALP = [
  { lane: "V4", t: "scalping_ob_ob_v4" },
  { lane: "BPR", t: "bpr_ob_v3" },
  { lane: "IFVG", t: "ifvg_ob_v1" },
];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("hours")) || 24));
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3600e3);
  const p = [from.toISOString()];

  const signalsSql = SCALP.map(({ lane, t }) =>
    `SELECT '${lane}' lane, symbol, side, entry, stop, target, entry_at, eligible, features, source, created_at
       FROM realtime_production_${t}_signals WHERE created_at >= $1`).join(" UNION ALL ") + " ORDER BY created_at DESC LIMIT 800";
  const armedSql = SCALP.map(({ lane, t }) =>
    `SELECT '${lane}' lane, ticker, direction, entry_price, stoploss, tp1, planned_rr, first_armed_at, state, cancel_reason, updated_at
       FROM realtime_production_${t}_armed WHERE greatest(first_armed_at, updated_at) >= $1`).join(" UNION ALL ") + " LIMIT 600";
  const scalpOrdersSql = SCALP.map(({ lane, t }) =>
    `SELECT '${lane}' lane, ticker, direction, entry_datetime, entry_price, stoploss, tp1, planned_rr, state, close_ts, close_price,
            close_reason, realized_r, source_mode, execution_mode
       FROM realtime_production_${t}_orders
      WHERE entry_datetime >= $1 OR close_ts >= $1 OR state IN ('OPEN','FILLED','PARTIAL')`).join(" UNION ALL ") + " LIMIT 400";

  const [signals, armed, scalpOrders, k1, k1Live, ictSignals, ictOrders, igs, beats, runs, alerts] = await Promise.all([
    q(signalsSql, p),
    q(armedSql, p),
    q(scalpOrdersSql, p),
    q(`SELECT ticker, market, timeframe, direction, entry_datetime, observed_at, entry_price, stoploss, tp1, state, close_ts, close_price, realized_r
         FROM realtime_production_reversal_k1_orders
        WHERE source_mode = 'REALTIME' AND (observed_at >= $1 OR close_ts >= $1) ORDER BY observed_at DESC LIMIT 400`, p),
    q(`SELECT ticker, timeframe, direction, signal_entry, stoploss, tp1, decided_at, status, skip_reason, fill_price, fill_ts, close_ts,
              close_price, realized_r, exit_reason, planned_rr_at_market
         FROM reversal_k1_live_orders WHERE decided_at >= $1 OR close_ts >= $1 ORDER BY decided_at DESC LIMIT 200`, p),
    q(`SELECT market, ticker, direction, strategy_id, entry_datetime, entry_price, stoploss, target_1, signal_hash,
              coalesce(updated_timestamp, as_of_ts) ts
         FROM realtime_production_ict_ltf_signals WHERE coalesce(updated_timestamp, as_of_ts) >= $1
        ORDER BY 10 DESC LIMIT 500`, p),
    q(`SELECT o.symbol, o.market, o.direction, o.state, o.entry_price, o.filled_price, o.stoploss, o.tp1, o.close_price, o.close_ts,
              o.close_reason, o.created_at, o.filled_at, o.risk_probability, o.risk_bin, s.strategy_id
         FROM realtime_production_orders o
         LEFT JOIN realtime_production_ict_strategy_met_execution s ON s.signal_hash = o.signal_id
        WHERE o.created_at >= $1 OR o.close_ts >= $1 OR o.state = 'OPEN' ORDER BY o.created_at DESC LIMIT 400`, p),
    q(`SELECT symbol, side, entry_ts, signal_entry, stop, tp1, probability, risk_bin, tradeable, skip_reason, fill_state, fill_price,
              fill_ts, close_ts, realized_r, exit_reason, created_at
         FROM igs01v2_live_signals WHERE created_at >= $1 OR close_ts >= $1 ORDER BY created_at DESC LIMIT 200`, p),
    q(`SELECT role, at, status FROM realtime_production_runtime_heartbeats ORDER BY role`),
    q(SCALP.map(({ lane, t }) => `SELECT '${lane}' lane, count(*)::int n, max(finished_at) last FROM realtime_production_${t}_runs WHERE started_at >= $1`)
        .join(" UNION ALL ") + ` UNION ALL SELECT 'K1', count(*)::int, max(finished_at) FROM realtime_production_reversal_k1_runs WHERE started_at >= $1`, p),
    q(`SELECT event_type, symbol, strategy_id, delivery_status, created_at FROM realtime_production_discord_alerts
        WHERE created_at >= $1 ORDER BY created_at DESC LIMIT 300`, p),
  ]);

  const ev: DeskEvent[] = [];
  const push = (e: DeskEvent | null) => { if (e && e.ts) ev.push(e); };

  // ---- Scalping lanes: candidate → rule checks → armed limit → fill → exit
  for (const s of signals) {
    const ts = iso(s.created_at); if (!ts) continue;
    const lane = String(s.lane); const t = short(s.symbol); const f = obj(s.features);
    const rules = Object.entries(f).filter(([k, v]) => k.startsWith("f_") && typeof v === "boolean")
      .map(([k, v]) => ({ key: k, label: ruleLabel(k), pass: v as boolean }));
    const failed = rules.find((r) => !r.pass);
    const signalsList = [
      { label: "planned R:R", value: fmt(f.rr) },
      { label: "move since open %", value: fmt(f.move_pct) },
      { label: "range so far (× 20d)", value: fmt(f.range_so_far_rel) },
      { label: "nested OB", value: f.nested ? "yes" : "no" },
    ];
    push({ ts, stage: "scout", kind: "SIGNAL", lane, ticker: t, side: String(s.side ?? ""), text: `${t} ${s.side} candidate · entry ${fmt(s.entry)}`, rules, signals: signalsList });
    if (s.eligible) {
      const passed = rules.filter((r) => r.pass).length;
      push({ ts, stage: "filter", kind: "PASS", lane, ticker: t, side: String(s.side ?? ""), text: `${t} ${rules.length}/${rules.length} rules → executor`, rules });
      push({ ts, stage: "analyst", kind: "SCORE", lane, ticker: t, side: String(s.side ?? ""), score: rules.length ? Math.round((passed / rules.length) * 100) : null,
        text: `${t} R:R ${fmt(f.rr)} · rules ${passed}/${rules.length}`, signals: signalsList });
    } else {
      push({ ts, stage: "filter", kind: "KILL", lane, ticker: t, side: String(s.side ?? ""), rule: failed?.label ?? "R:R / move limits",
        text: `${t} killed · ${failed?.label ?? "R:R / move limits"}`, rules });
    }
  }
  for (const a of armed) {
    const lane = String(a.lane); const t = short(a.ticker);
    const at = iso(a.first_armed_at);
    if (at && at >= p[0]) push({ ts: at, stage: "executor", kind: "ARM", lane, ticker: t, side: String(a.direction ?? ""),
      text: `${t} limit armed @ ${fmt(a.entry_price)} · stop ${fmt(a.stoploss)} · R:R ${fmt(a.planned_rr)}` });
    const end = iso(a.updated_at);
    if (a.state === "CANCELLED" && end) push({ ts: end, stage: "risk", kind: "CANCEL", lane, ticker: t, side: String(a.direction ?? ""),
      rule: String(a.cancel_reason ?? ""), text: `${t} limit cancelled · ${String(a.cancel_reason ?? "").toLowerCase().replace(/_/g, " ")}` });
  }
  const closeEvent = (lane: string, t: string, side: string, ts: string | null, r: number | null, reason: string, live = false) => {
    if (!ts) return;
    const kind = r === null ? "EXIT" : r > 0 ? "WIN" : "LOSS";
    push({ ts, stage: kind === "LOSS" ? "risk" : "logger", kind, lane, ticker: t, side, r, live,
      text: `${t} ${kind === "WIN" ? "win" : kind === "LOSS" ? "stopped" : "closed"}${r !== null ? ` ${r >= 0 ? "+" : ""}${r.toFixed(2)}R` : ""}${reason ? ` · ${reason}` : ""}` });
  };
  for (const o of scalpOrders) {
    const lane = String(o.lane); const t = short(o.ticker); const side = String(o.direction ?? "");
    const at = iso(o.entry_datetime);
    if (at && at >= p[0]) push({ ts: at, stage: "executor", kind: "ENTER", lane, ticker: t, side,
      text: `${t} ${side} filled @ ${fmt(o.entry_price)} · ATM option · ${String(o.execution_mode ?? "paper").toLowerCase()}` });
    closeEvent(lane, t, side, iso(o.close_ts), num(o.realized_r), String(o.close_reason ?? "").toLowerCase());
  }

  // ---- Reversal k1 (paper) and its OANDA live gate
  for (const o of k1) {
    const t = short(o.ticker); const side = String(o.direction ?? ""); const lane = "K1";
    const at = iso(o.observed_at);
    if (at && at >= p[0]) {
      push({ ts: at, stage: "scout", kind: "SIGNAL", lane, ticker: t, side, text: `${t} ${o.timeframe} reversal setup · OTE 62% limit` });
      if (o.state === "INVALID_EXECUTION" || o.state === "UNVERIFIED")
        push({ ts: at, stage: "filter", kind: "KILL", lane, ticker: t, side, rule: String(o.state).toLowerCase().replace(/_/g, " "), text: `${t} killed · ${String(o.state).toLowerCase().replace(/_/g, " ")}` });
      else {
        push({ ts: at, stage: "filter", kind: "PASS", lane, ticker: t, side, text: `${t} k1 rules passed → executor` });
        push({ ts: iso(o.entry_datetime) ?? at, stage: "executor", kind: "ENTER", lane, ticker: t, side, text: `${t} ${side} paper entry @ ${fmt(o.entry_price, 5)}` });
      }
    }
    if (o.state === "CLOSED_TP" || o.state === "CLOSED_SL") closeEvent(lane, t, side, iso(o.close_ts), num(o.realized_r), o.state === "CLOSED_TP" ? "target" : "5m close beyond stop");
  }
  for (const o of k1Live) {
    const t = short(o.ticker); const side = String(o.direction ?? ""); const lane = "K1";
    const at = iso(o.decided_at);
    if (at && at >= p[0]) {
      if (o.status === "SKIPPED") push({ ts: at, stage: "risk", kind: "BLOCK", lane, ticker: t, side, live: true, rule: String(o.skip_reason ?? ""),
        text: `${t} OANDA live blocked · ${String(o.skip_reason ?? "").toLowerCase().replace(/_/g, " ")}` });
      else push({ ts: iso(o.fill_ts) ?? at, stage: "executor", kind: "ENTER", lane, ticker: t, side, live: true,
        text: `${t} ${side} LIVE on OANDA @ ${fmt(o.fill_price ?? o.signal_entry, 5)} · R:R ${fmt(o.planned_rr_at_market)}` });
    }
    if (o.close_ts) closeEvent(lane, t, side, iso(o.close_ts), num(o.realized_r), String(o.exit_reason ?? "").toLowerCase(), true);
  }

  // ---- ICT lane (S16 / S03 / S-CH08 / S-CH10): signal → order (ML score) → stop / target
  for (const s of ictSignals) {
    const ts = iso(s.ts); if (!ts) continue;
    const t = short(s.ticker);
    push({ ts, stage: "scout", kind: "SIGNAL", lane: "ICT", ticker: t, side: String(s.direction ?? ""), text: `${t} ${s.strategy_id} checklist met · entry ${fmt(s.entry_price)}` });
    push({ ts, stage: "filter", kind: "PASS", lane: "ICT", ticker: t, side: String(s.direction ?? ""), text: `${t} ${s.strategy_id} checklist passed → executor` });
  }
  for (const o of ictOrders) {
    const t = short(o.symbol); const side = String(o.direction ?? ""); const strat = String(o.strategy_id ?? "ICT");
    const at = iso(o.created_at);
    const prob = num(o.risk_probability);
    if (at && at >= p[0]) {
      if (prob !== null) push({ ts: at, stage: "analyst", kind: "SCORE", lane: "ICT", ticker: t, side, score: Math.round(prob * 100),
        text: `${t} ${strat} ML score ${Math.round(prob * 100)} · bin ${o.risk_bin ?? "—"}/10`,
        signals: [{ label: "ML probability (target before stop)", value: `${(prob * 100).toFixed(1)}%` }, { label: "risk bin", value: `${o.risk_bin ?? "—"}/10` }, { label: "strategy", value: strat }] });
      push({ ts: iso(o.filled_at) ?? at, stage: "executor", kind: "ENTER", lane: "ICT", ticker: t, side,
        text: `${t} ${strat} ${side} order @ ${fmt(o.filled_price ?? o.entry_price)} · stop ${fmt(o.stoploss)} · TP1 ${fmt(o.tp1)}` });
    }
    const close = num(o.close_price), fill = num(o.filled_price) ?? num(o.entry_price), stop = num(o.stoploss), entry = num(o.entry_price);
    let r: number | null = null;
    if (close !== null && fill !== null && stop !== null && entry !== null && Math.abs(entry - stop) > 0)
      r = ((close - fill) * (side === "SELL" ? -1 : 1)) / Math.abs(entry - stop);
    if (o.close_ts && o.state !== "OPEN")
      closeEvent("ICT", t, side, iso(o.close_ts), o.state === "CLOSED_MANUAL" ? null : r,
        o.state === "CLOSED_TP" ? "target 1" : o.state === "CLOSED_SL" ? "stop" : String(o.close_reason ?? o.state ?? "").toLowerCase().replace(/_/g, " "));
  }

  // ---- IGS01V2: ML probability is a real gate here (tradeable / skip_reason)
  for (const s of igs) {
    const at = iso(s.created_at); const t = short(s.symbol); const side = String(s.side ?? ""); const lane = "IGS";
    const prob = num(s.probability);
    if (at && at >= p[0]) {
      push({ ts: at, stage: "scout", kind: "SIGNAL", lane, ticker: t, side, text: `${t} London killzone sweep reversal` });
      push({ ts: at, stage: "analyst", kind: "SCORE", lane, ticker: t, side, score: prob !== null ? Math.round(prob * 100) : null,
        text: `${t} ML ${prob !== null ? Math.round(prob * 100) : "—"} · ${s.tradeable ? "tradeable" : "below gate"}`,
        signals: [{ label: "ML probability", value: prob !== null ? `${(prob * 100).toFixed(1)}%` : "—" }, { label: "risk bin", value: `${s.risk_bin ?? "—"}` }] });
      if (!s.tradeable) push({ ts: at, stage: "filter", kind: "KILL", lane, ticker: t, side, rule: "ML score below gate", text: `${t} killed · ML score below gate` });
      else if (s.skip_reason) push({ ts: at, stage: "risk", kind: "BLOCK", lane, ticker: t, side, live: true, rule: String(s.skip_reason), text: `${t} blocked · ${s.skip_reason}` });
      else if (s.fill_ts) push({ ts: iso(s.fill_ts) ?? at, stage: "executor", kind: "ENTER", lane, ticker: t, side, live: true, text: `${t} ${side} OANDA fill @ ${fmt(s.fill_price, 5)}` });
    }
    if (s.close_ts) closeEvent(lane, t, side, iso(s.close_ts), num(s.realized_r), String(s.exit_reason ?? "").toLowerCase(), true);
  }

  // ---- Logger: alert deliveries
  for (const a of alerts) {
    const ts = iso(a.created_at); if (!ts) continue;
    push({ ts, stage: "logger", kind: "ALERT", lane: "ICT", ticker: short(a.symbol), text: `alert ${String(a.event_type).replace(/_/g, " ")} → Discord (${a.delivery_status})` });
  }

  ev.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const inWindow = ev.filter((e) => e.ts >= p[0]);

  // Focus position for the Executor + Risk panel: newest open trade, else newest closed one.
  const openScalp = scalpOrders.find((o) => ["OPEN", "FILLED", "PARTIAL"].includes(String(o.state)));
  const openIct = ictOrders.find((o) => o.state === "OPEN");
  const lastClosed = [...scalpOrders, ...ictOrders].filter((o) => o.close_ts).sort((a, b) => String(iso(b.close_ts)).localeCompare(String(iso(a.close_ts))))[0];
  const f = openScalp ?? openIct ?? lastClosed ?? null;
  let focus: Row | null = null;
  if (f) {
    const ticker = String(f.ticker ?? f.symbol);
    const entryAt = iso(f.entry_datetime ?? f.filled_at ?? f.created_at);
    const closeAt = iso(f.close_ts);
    const candles = entryAt ? await q(
      `SELECT extract(epoch from candle_ts)::float8 t, open_price o, high_price h, low_price l, close_price c
         FROM candles_5m WHERE yahoo_symbol = $1 AND candle_ts >= $2::timestamptz - interval '2 hours'
          AND candle_ts <= coalesce($3::timestamptz, now()) + interval '30 minutes' ORDER BY candle_ts LIMIT 400`,
      [ticker, entryAt, closeAt]) : [];
    const entry = num(f.filled_price) ?? num(f.entry_price), stop = num(f.stoploss), tp = num(f.tp1);
    const last = num(candles.at(-1)?.c);
    const side = String(f.direction ?? "");
    const ref = num(f.close_price) ?? last;
    const r = num(f.realized_r) ?? (entry !== null && stop !== null && ref !== null && Math.abs(entry - stop) > 0
      ? ((ref - entry) * (side === "SELL" ? -1 : 1)) / Math.abs(entry - stop) : null);
    focus = {
      lane: f.lane ?? "ICT", strategy: f.strategy_id ?? (f.lane ? LANES[String(f.lane)]?.name : "ICT"),
      ticker: short(ticker), side, state: f.state, entry, stop, target: tp, entryAt, closeAt, r,
      planned_rr: num(f.planned_rr), mode: f.execution_mode ?? (f.lane ? "PAPER_ONLY" : "live/paper"),
      candles: candles.map((c) => ({ t: num(c.t), c: num(c.c), h: num(c.h), l: num(c.l) })),
    };
  }

  const now = Date.now();
  const heartbeat = beats.map((b) => ({ role: String(b.role), status: String(b.status), age_s: Math.round((now - new Date(String(b.at)).getTime()) / 1000) }));
  const alive = heartbeat.filter((b) => b.age_s < 180).length;

  return Response.json({
    generated_at: to.toISOString(),
    window: { from: p[0], to: to.toISOString(), hours },
    lanes: LANES,
    runtime: { alive, total: heartbeat.length, heartbeat },
    scans: runs.map((r) => ({ lane: r.lane, n: num(r.n), last: iso(r.last) })),
    events: inWindow,
    focus,
  }, { headers: { "Cache-Control": "public, s-maxage=20, stale-while-revalidate=60" } });
}
