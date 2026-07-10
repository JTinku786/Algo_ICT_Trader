"use client";

import { Bell, RadioTower, Activity, CheckCircle2, AlertTriangle, Pause, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type OpenOrder = {
  order_id: string;
  symbol: string;
  market: string | null;
  direction: string | null;
  state: string;
  order_type: string | null;
  qty: number | string | null;
  entry_price: number | string | null;
  filled_price: number | string | null;
  stoploss: number | string | null;
  tp1: number | string | null;
  tp2: number | string | null;
  tp3: number | string | null;
  current_tp_index: number | null;
  filled_at: string | null;
  close_price: number | string | null;
  close_ts: string | null;
  updated_at: string | null;
};
type EventRow = {
  event_id: string;
  order_id: string | null;
  event_type: string;
  event_ts: string | null;
  price: number | string | null;
  state_before: string | null;
  state_after: string | null;
  symbol: string | null;
  direction: string | null;
};
type Alert = {
  alert_id: string;
  market: string | null;
  symbol: string | null;
  strategy_id: string | null;
  event_type: string | null;
  channel_id: string | null;
  delivery_status: string | null;
  message: string | null;
  created_at: string | null;
};
type Stats = {
  open_positions?: number;
  wins?: number;
  losses?: number;
  alerts_today?: number;
  alerts_failed?: number;
  last_order_update?: string | null;
  last_alert?: string | null;
};
type LiveResponse = {
  success: boolean;
  error?: string;
  server_time?: string;
  stats?: Stats;
  open_orders?: OpenOrder[];
  events?: EventRow[];
  alerts?: Alert[];
};

const POLL_MS = 5000;

function cx(...v: Array<string | false | null | undefined>) {
  return v.filter(Boolean).join(" ");
}
function n(v: number | string | null | undefined) {
  if (v === null || v === undefined) return "—";
  const x = Number(v);
  return Number.isFinite(x) ? x.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—";
}
function ago(v: string | null | undefined) {
  if (!v) return "—";
  const d = new Date(v).getTime();
  if (Number.isNaN(d)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - d) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function clock(v: string | null | undefined) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export default function LiveOrders() {
  const [data, setData] = useState<LiveResponse | null>(null);
  const [error, setError] = useState("");
  const [live, setLive] = useState(true);
  const [lastFetch, setLastFetch] = useState<number>(0);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const prevAlertIds = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/live", { cache: "no-store" });
      const payload = (await res.json()) as LiveResponse;
      if (!res.ok || !payload.success) throw new Error(payload.error || "Failed to load live feed");
      // flash newly-arrived alerts
      const newIds = new Set((payload.alerts || []).map((a) => a.alert_id));
      const flashed = new Set<string>();
      if (prevAlertIds.current.size > 0) {
        for (const id of newIds) if (!prevAlertIds.current.has(id)) flashed.add(id);
      }
      prevAlertIds.current = newIds;
      setData(payload);
      setError("");
      setLastFetch(Date.now());
      if (flashed.size) {
        setFlashIds(flashed);
        setTimeout(() => setFlashIds(new Set()), 2500);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load live feed");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [live, load]);

  const stats = data?.stats ?? {};
  const openOrders = useMemo(() => data?.open_orders ?? [], [data]);
  const alerts = useMemo(() => data?.alerts ?? [], [data]);
  const events = useMemo(() => data?.events ?? [], [data]);

  return (
    <section className="space-y-4">
      {/* Live header */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-white/10 bg-[#101620] px-4 py-3">
        <RadioTower className="size-4 text-[#d9a441]" />
        <h2 className="font-semibold">Live Orders &amp; Alerts</h2>
        <span className={cx("flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold", live ? "border-[#2fbf71]/40 bg-[#2fbf71]/10 text-[#62d894]" : "border-white/10 text-[#93a1b6]")}>
          <span className={cx("size-1.5 rounded-full", live ? "animate-pulse bg-[#2fbf71]" : "bg-[#93a1b6]")} />
          {live ? "LIVE" : "PAUSED"}
        </span>
        <span className="font-mono text-[11px] text-[#93a1b6]">refreshed {ago(new Date(lastFetch).toISOString())} · every {POLL_MS / 1000}s</span>
        <button
          onClick={() => setLive((v) => !v)}
          className="ml-auto flex h-8 items-center gap-2 rounded-md border border-white/10 px-3 text-xs font-semibold text-[#d6deec] hover:border-[#d9a441]/60 hover:text-[#f2c873]"
        >
          {live ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          {live ? "Pause" : "Resume"}
        </button>
      </div>

      {error ? (
        <div className="rounded-md border border-[#e5484d]/30 bg-[#e5484d]/10 p-3 text-sm text-[#ff9da2]">Live feed error: {error}</div>
      ) : null}

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <LiveKpi label="Open positions" value={String(stats.open_positions ?? 0)} tone="blue" />
        <LiveKpi label="Wins (closed)" value={String(stats.wins ?? 0)} tone="green" />
        <LiveKpi label="Losses (closed)" value={String(stats.losses ?? 0)} tone="red" />
        <LiveKpi label="Alerts today" value={String(stats.alerts_today ?? 0)} tone="gold" />
        <LiveKpi label="Failed alerts" value={String(stats.alerts_failed ?? 0)} tone={(stats.alerts_failed ?? 0) > 0 ? "red" : "green"} />
        <LiveKpi label="Last alert" value={ago(stats.last_alert)} />
      </div>

      {/* Open positions */}
      <div className="rounded-md border border-white/10 bg-[#101620]">
        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <Activity className="size-4 text-[#d9a441]" />
          <h2 className="font-semibold">Open Positions</h2>
          <span className="ml-auto font-mono text-[11px] text-[#93a1b6]">{openOrders.length} live</span>
        </div>
        <div className="max-h-[320px] overflow-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="sticky top-0 border-b border-white/10 bg-[#0b0f16] text-[11px] uppercase text-[#7f8ca3]">
              <tr>
                {["Symbol", "Dir", "State", "Entry", "Filled", "SL", "TP1", "TP idx", "Filled", "Updated"].map((h) => (
                  <th key={h} className="px-3 py-2.5 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10 font-mono">
              {openOrders.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-[#93a1b6]">No open positions right now.</td>
                </tr>
              ) : null}
              {openOrders.map((o) => (
                <tr key={o.order_id} className="hover:bg-white/[0.03]">
                  <td className="px-3 py-2 text-white">{o.symbol}</td>
                  <td className={cx("px-3 py-2", (o.direction || "").toUpperCase() === "BUY" ? "text-[#62d894]" : "text-[#ff8b91]")}>{o.direction}</td>
                  <td className="px-3 py-2"><span className="rounded bg-[#64d2ff]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#8edfff]">{o.state}</span></td>
                  <td className="px-3 py-2 text-[#d6deec]">{n(o.entry_price)}</td>
                  <td className="px-3 py-2 text-[#d6deec]">{n(o.filled_price)}</td>
                  <td className="px-3 py-2 text-[#ff8b91]">{n(o.stoploss)}</td>
                  <td className="px-3 py-2 text-[#62d894]">{n(o.tp1)}</td>
                  <td className="px-3 py-2 text-[#93a1b6]">{o.current_tp_index ?? "—"}</td>
                  <td className="px-3 py-2 text-[#93a1b6]">{ago(o.filled_at)}</td>
                  <td className="px-3 py-2 text-[#93a1b6]">{ago(o.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Notifications + event stream */}
      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <div className="rounded-md border border-white/10 bg-[#101620]">
          <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
            <Bell className="size-4 text-[#d9a441]" />
            <h2 className="font-semibold">Notification Feed</h2>
            <span className="rounded bg-[#5865F2]/20 px-1.5 py-0.5 text-[10px] font-semibold text-[#aab4ff]">Discord</span>
            <span className="ml-auto font-mono text-[11px] text-[#93a1b6]">{alerts.length} recent</span>
          </div>
          <div className="max-h-[420px] space-y-2 overflow-auto p-3">
            {alerts.length === 0 ? <div className="py-8 text-center text-sm text-[#93a1b6]">No alerts yet.</div> : null}
            {alerts.map((a) => {
              const sent = (a.delivery_status || "").toLowerCase() === "sent";
              const flash = flashIds.has(a.alert_id);
              return (
                <div
                  key={a.alert_id}
                  className={cx(
                    "rounded-md border p-2.5 text-sm transition",
                    flash ? "border-[#d9a441]/60 bg-[#d9a441]/10" : "border-white/10 bg-[#0b0f16]",
                  )}
                >
                  <div className="flex items-center gap-2">
                    {sent ? <CheckCircle2 className="size-3.5 text-[#62d894]" /> : <AlertTriangle className="size-3.5 text-[#ffb454]" />}
                    <span className="font-semibold text-white">{a.symbol || "—"}</span>
                    <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-[#93a1b6]">{a.event_type || "event"}</span>
                    {a.strategy_id ? <span className="font-mono text-[10px] text-[#8edfff]">{a.strategy_id}</span> : null}
                    <span className="ml-auto font-mono text-[10px] text-[#93a1b6]">{ago(a.created_at)}</span>
                  </div>
                  {a.message ? <div className="mt-1 line-clamp-2 text-[13px] leading-5 text-[#c7d1e0]">{a.message}</div> : null}
                  {!sent ? <div className="mt-1 text-[11px] text-[#ffb454]">delivery: {a.delivery_status}</div> : null}
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-md border border-white/10 bg-[#101620]">
          <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
            <Activity className="size-4 text-[#d9a441]" />
            <h2 className="font-semibold">Order Event Stream</h2>
            <span className="ml-auto font-mono text-[11px] text-[#93a1b6]">{events.length}</span>
          </div>
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 border-b border-white/10 bg-[#0b0f16] text-[11px] uppercase text-[#7f8ca3]">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">Time</th>
                  <th className="px-3 py-2.5 font-semibold">Symbol</th>
                  <th className="px-3 py-2.5 font-semibold">Event</th>
                  <th className="px-3 py-2.5 font-semibold">Transition</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10 font-mono">
                {events.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-[#93a1b6]">No events.</td>
                  </tr>
                ) : null}
                {events.map((e) => (
                  <tr key={e.event_id} className="hover:bg-white/[0.03]">
                    <td className="px-3 py-2 text-[#93a1b6]">{clock(e.event_ts)}</td>
                    <td className="px-3 py-2 text-white">{e.symbol || "—"}</td>
                    <td className="px-3 py-2 text-[#8edfff]">{e.event_type}</td>
                    <td className="px-3 py-2 text-[#93a1b6]">
                      {e.state_before || "—"} → <span className="text-[#d6deec]">{e.state_after || "—"}</span>
                    </td>
                    <td className="px-3 py-2 text-right text-[#d6deec]">{n(e.price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <p className="px-1 font-mono text-[11px] text-[#93a1b6]">
        Source: realtime_production_orders · realtime_production_order_events · realtime_production_discord_alerts (live Postgres over zrok). Slack feed will attach here once its alert table is populated.
      </p>
    </section>
  );
}

function LiveKpi({ label, value, tone }: { label: string; value: string; tone?: "blue" | "green" | "red" | "gold" }) {
  const color =
    tone === "green" ? "text-[#62d894]" : tone === "red" ? "text-[#ff8b91]" : tone === "gold" ? "text-[#f2c873]" : tone === "blue" ? "text-[#8edfff]" : "text-white";
  return (
    <div className="rounded-md border border-white/10 bg-[#101620] p-3">
      <div className="text-[10px] font-semibold uppercase text-[#7f8ca3]">{label}</div>
      <div className={cx("mt-1.5 font-mono text-xl font-semibold", color)}>{value}</div>
    </div>
  );
}
