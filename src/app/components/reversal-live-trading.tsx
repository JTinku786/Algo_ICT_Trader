"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

type Row = Record<string, unknown>;
type Payload = {
  success: boolean;
  error?: string;
  generated_at?: string;
  summary?: Record<string, number | null>;
  skip_reasons?: { reason: string; count: number }[];
  equity?: { ts: string; ticker: string; r: number | null; equity_r: number; pl_usd: number }[];
  rows?: Row[];
};

const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const sym = (v: unknown) => String(v ?? "").replace("^", "");
const px = (v: unknown, inst: unknown) => {
  const x = n(v);
  return x === null ? "—" : x.toFixed(String(inst ?? "").includes("JPY") ? 3 : 5);
};
const fmtR = (v: unknown) => {
  const x = n(v);
  return x === null ? "—" : `${x > 0 ? "+" : ""}${x.toFixed(2)}R`;
};
const usd = (v: unknown) => {
  const x = n(v);
  return x === null ? "—" : `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
};
const et = (v: unknown) => {
  if (!v) return "—";
  const d = new Date(String(v));
  return Number.isFinite(d.getTime())
    ? d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) + " ET"
    : "—";
};
const tone = (v: unknown) => ((n(v) ?? 0) > 0 ? "text-emerald-300" : (n(v) ?? 0) < 0 ? "text-rose-300" : "text-slate-200");
const tf = (v: unknown) => (v === "1d" ? "Daily" : v === "1h" ? "1H" : v === "30m" ? "30m" : String(v ?? ""));

function Card({ label, value, note, className = "" }: { label: string; value: string; note?: string; className?: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-[#0d131c] p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[#7f8ca3]">{label}</div>
      <div className={`mt-1 font-mono text-xl font-semibold ${className}`}>{value}</div>
      {note ? <div className="mt-0.5 text-[11px] text-[#7f8ca3]">{note}</div> : null}
    </div>
  );
}

function EquitySpark({ points }: { points: { equity_r: number }[] }) {
  if (points.length < 2) return <div className="grid h-28 place-items-center text-xs text-[#7f8ca3]">Equity curve appears after two closed trades.</div>;
  const values = [0, ...points.map((p) => p.equity_r)];
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const d = values.map((v, i) => `${i ? "L" : "M"}${(i / (values.length - 1)) * 100},${100 - ((v - min) / span) * 100}`).join(" ");
  const zero = 100 - ((0 - min) / span) * 100;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-28 w-full" role="img" aria-label="Cumulative R">
      <line x1="0" x2="100" y1={zero} y2={zero} stroke="rgba(255,255,255,0.15)" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
      <path d={d} fill="none" stroke="#d9a441" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function ReversalLiveTrading() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/reversal-live", { cache: "no-store" });
      setData((await res.json()) as Payload);
    } catch (e) {
      setData({ success: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const s = data?.summary ?? {};
  const rows = data?.rows ?? [];
  const open = rows.filter((r) => r.status === "OPEN");
  const closed = rows.filter((r) => String(r.status).startsWith("CLOSED"));
  const skipped = rows.filter((r) => !r.oanda_trade_id);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-amber-300/20 p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong>Live trading · Reversal k1 forex · OANDA practice account</strong>
          <button onClick={() => void load()} disabled={loading} className="flex items-center gap-2 rounded-md border border-white/10 px-3 py-1.5 text-xs hover:bg-white/[0.06]">
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh · auto 30s
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          Market order when a live k1 forex signal fires on the 1H timeframe (30m and Daily stay paper-only); stops tighter than 0.083% of price are skipped. Stop: a completed 5-minute candle closing beyond the stop, then closed at market.
          Target: the 2R level touched (OANDA take-profit). Skips PM Silver Bullet and Macro 5 (10:50–11:10 ET), planned R:R at the market price below 0.786,
          and any second order on the same setup. Size: 0.5% of NAV ÷ stop distance, as IGS01V2 did. R is measured on the risk actually taken (fill → stop).
        </p>
      </div>

      {data && !data.success ? <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">{data.error}</div> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        <Card label="Closed trades" value={String(s.closed ?? 0)} note={`${s.open ?? 0} open · ${s.traded ?? 0} filled`} />
        <Card label="Win rate" value={s.win_rate_pct === null || s.win_rate_pct === undefined ? "—" : `${s.win_rate_pct}%`} note={`${s.wins ?? 0} W / ${s.losses ?? 0} L`} />
        <Card label="Net result" value={fmtR(s.net_r)} className={tone(s.net_r)} />
        <Card label="Net P&L" value={usd(s.net_pl_usd)} className={tone(s.net_pl_usd)} note="incl. financing" />
        <Card label="Profit factor" value={s.profit_factor === null || s.profit_factor === undefined ? "—" : String(s.profit_factor)} />
        <Card label="Expectancy" value={fmtR(s.expectancy_r)} className={tone(s.expectancy_r)} />
        <Card label="Max drawdown" value={fmtR(s.max_drawdown_r)} className={(s.max_drawdown_r ?? 0) < 0 ? "text-rose-300" : ""} />
        <Card label="Signals skipped" value={String(s.skipped ?? 0)} note={`of ${s.decisions ?? 0} decisions`} />
      </div>

      <div className="rounded-xl border border-white/10 bg-[#101620] p-3">
        <div className="mb-1 text-sm font-semibold">Cumulative R (closed trades)</div>
        <EquitySpark points={data?.equity ?? []} />
      </div>

      <TradeTable title={`Open positions (${open.length})`} rows={open} empty="No open positions." open />
      <TradeTable title={`Closed trades (${closed.length})`} rows={closed} empty="No closed trades yet." />

      <div className="rounded-xl border border-white/10 bg-[#101620] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold">Signals not traded ({skipped.length})</div>
          <button onClick={() => setShowSkipped((v) => !v)} className="text-xs text-amber-200 underline">{showSkipped ? "Hide" : "Show"} each signal</button>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {(data?.skip_reasons ?? []).map((x) => (
            <span key={x.reason} className="rounded border border-white/10 px-2 py-1 font-mono text-[11px] text-[#aeb9ca]">{x.reason} · {x.count}</span>
          ))}
          {!(data?.skip_reasons ?? []).length ? <span className="text-xs text-[#7f8ca3]">None yet.</span> : null}
        </div>
        {showSkipped ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="text-[10px] uppercase text-[#7f8ca3]"><tr><th className="py-1">Signal</th><th>Pair</th><th>TF</th><th>Side</th><th>Stop</th><th>Target</th><th>R:R at market</th><th>Reason</th></tr></thead>
              <tbody>
                {skipped.map((r) => (
                  <tr key={String(r.id)} className="border-t border-white/5">
                    <td className="py-1">{et(r.observed_at)}</td><td>{sym(r.ticker)}</td><td>{tf(r.timeframe)}</td><td>{String(r.direction)}</td>
                    <td className="font-mono">{px(r.stoploss, r.instrument ?? r.ticker)}</td><td className="font-mono">{px(r.tp1, r.instrument ?? r.ticker)}</td>
                    <td className="font-mono">{n(r.planned_rr_at_market) === null ? "—" : n(r.planned_rr_at_market)!.toFixed(2)}</td>
                    <td className="text-[#aeb9ca]">{String(r.skip_reason ?? r.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
      <div className="font-mono text-[10px] text-[#7f8ca3]">Updated {et(data?.generated_at)} · source reversal_k1_live_orders (OANDA practice)</div>
    </div>
  );
}

function TradeTable({ title, rows, empty, open = false }: { title: string; rows: Row[]; empty: string; open?: boolean }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#101620] p-3">
      <div className="mb-2 text-sm font-semibold">{title}</div>
      {!rows.length ? <div className="text-xs text-[#7f8ca3]">{empty}</div> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-xs">
            <thead className="text-[10px] uppercase text-[#7f8ca3]">
              <tr><th className="py-1">Filled</th><th>Pair</th><th>TF</th><th>Side</th><th>Units</th><th>Fill</th><th>Stop (5m close)</th><th>Target</th><th>R:R</th><th>Risk</th>
                {open ? <th>OANDA trade</th> : <><th>Closed</th><th>Exit</th><th>Exit price</th><th>R</th><th>P&L</th></>}</tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const inst = r.instrument ?? r.ticker;
                return (
                  <tr key={String(r.id)} className="border-t border-white/5">
                    <td className="py-1">{et(r.fill_ts)}</td><td className="font-semibold">{sym(r.ticker)}</td><td>{tf(r.timeframe)}</td>
                    <td className={r.direction === "BUY" ? "text-emerald-300" : "text-rose-300"}>{String(r.direction)}</td>
                    <td className="font-mono">{(n(r.units) ?? 0).toLocaleString()}</td>
                    <td className="font-mono">{px(r.fill_price, inst)}</td><td className="font-mono">{px(r.stoploss, inst)}</td><td className="font-mono">{px(r.tp1, inst)}</td>
                    <td className="font-mono">{n(r.planned_rr_at_market) === null ? "—" : n(r.planned_rr_at_market)!.toFixed(2)}</td>
                    <td className="font-mono">{usd(r.risk_usd)}</td>
                    {open ? <td className="font-mono">{String(r.oanda_trade_id ?? "—")}</td> : <>
                      <td>{et(r.close_ts)}</td>
                      <td>{r.exit_reason === "TARGET" ? "Target touched" : r.exit_reason === "STOP_5M_CLOSE" ? "5m close beyond SL" : r.exit_reason === "DISASTER_STOP" ? "Disaster stop" : String(r.exit_reason ?? "—")}</td>
                      <td className="font-mono">{px(r.close_price, inst)}</td>
                      <td className={`font-mono ${tone(r.realized_r)}`}>{fmtR(r.realized_r)}</td>
                      <td className={`font-mono ${tone(r.realized_pl)}`}>{usd((n(r.realized_pl) ?? 0) + (n(r.financing) ?? 0))}</td>
                    </>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
