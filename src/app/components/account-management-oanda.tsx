"use client";

import { Activity, Banknote, Download, Layers3, ListOrdered, RefreshCw, Scale, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import RealtimeOrdersDashboard from "./realtime-orders-dashboard";
import type { TradePrefill } from "./trade-navigation";
import { DataTable, EmptyRow, Panel, SideCell, SkeletonBlock, StatusPill, SummaryCard, cx, pnlTone, relativeAge } from "./account-management-ui";

/**
 * OANDA forex account (practice): every trade OANDA reports since the initial
 * funding, with the strategy that placed it. Broker truth from
 * scripts/broker_sync/oanda_sync.py — not the strategies' own logs.
 */

type Trade = {
  trade_id: string; instrument: string; local_symbol: string | null; side: string; units: number | string; state: string;
  open_ts: string; open_price: number | string | null; open_order_type: string | null; close_ts: string | null;
  close_price: number | string | null; close_reason: string | null; realized_pl: number | string | null;
  financing: number | string | null; unrealized_pl: number | string | null; take_profit: number | string | null;
  stop_loss: number | string | null; strategy_id: string; strategy_detail: string | null; strategy_source: string;
};
type Agg = { strategy_id: string; trades: number; closed: number; open: number; wins: number; losses: number; realized_pl: number; financing: number; net_pl: number; unrealized_pl: number; best: number | null; worst: number | null; first_trade: string | null; last_trade: string | null };
type Payload = {
  success: boolean; error?: string; schema_ready?: boolean; message?: string;
  account?: { account_id: string; environment: string; currency: string; balance: number | null; nav: number | null; unrealized_pl: number | null; open_trade_count: number | null; synced_at: string } | null;
  funding?: { deposits: number; initial_amount: number | null; initial_ts: string | null; return_pct: number | null };
  totals?: Agg | null; by_strategy?: Agg[];
  reconciliation?: { deposits: number; net_trade_pl: number; expected_balance: number; broker_balance: number; difference: number } | null;
  trades?: Trade[];
};

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const usd = (v: unknown) => { const x = num(v); return x === null ? "—" : USD.format(x); };
const signedUsd = (v: unknown) => { const x = num(v); return x === null ? "—" : `${x > 0 ? "+" : ""}${USD.format(x)}`; };
const px = (v: unknown, instrument: string) => { const x = num(v); return x === null ? "—" : x.toFixed(instrument.includes("JPY") ? 3 : 5); };
const et = (v: string | null | undefined) => {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) + " ET";
};
const netOf = (t: Trade) => (num(t.realized_pl) ?? 0) + (num(t.financing) ?? 0);
const strategyLabel = (id: string) => ({
  IGS01V2_LondonLiqGrab_SweepReversal: "IGS01V2 · London Liquidity Grab Sweep Reversal",
  REVERSAL_K1: "Reversal k1 · k1_reclaim3",
  UNATTRIBUTED: "Unattributed · manual / test",
} as Record<string, string>)[id] ?? id;
const reasonLabel = (v: string | null) => (v ? v.replace("_ORDER", "").replace("MARKET_TRADE_CLOSE", "MARKET CLOSE").replaceAll("_", " ") : "—");

function csvFor(rows: Trade[]) {
  const head = ["trade_id", "strategy_id", "strategy_detail", "instrument", "side", "units", "state", "open_ts", "open_price", "close_ts", "close_price", "close_reason", "realized_pl", "financing", "net_pl", "unrealized_pl", "take_profit", "stop_loss"];
  const esc = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
  return [head.join(","), ...rows.map((t) => [t.trade_id, t.strategy_id, t.strategy_detail, t.instrument, t.side, t.units, t.state, t.open_ts, t.open_price, t.close_ts, t.close_price, t.close_reason, t.realized_pl, t.financing, netOf(t).toFixed(4), t.unrealized_pl, t.take_profit, t.stop_loss].map(esc).join(","))].join("\n");
}

const noop = () => undefined;

export default function AccountManagementOanda({ active, onOpenTrade }: { active: boolean; onOpenTrade?: (trade: TradePrefill, destination: "tradezella" | "stonk") => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [strategy, setStrategy] = useState("ALL");

  const [reloadKey, setReloadKey] = useState(0);
  const [loadedKey, setLoadedKey] = useState(-1);

  // Fetch when the view is first shown and on every Reload click. State is only
  // set from the fetch callbacks, never synchronously inside the effect.
  useEffect(() => {
    if (!active || loadedKey === reloadKey) return;
    const abort = new AbortController();
    fetch("/api/account-management/oanda", { cache: "no-store", signal: abort.signal })
      .then(async (response) => {
        const payload = (await response.json()) as Payload;
        if (!response.ok || !payload.success) throw new Error(payload.error || `Request failed (${response.status})`);
        setData(payload);
        setError("");
        setLoadedKey(reloadKey);
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Unable to load the OANDA account");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [active, reloadKey, loadedKey]);

  const reload = () => {
    setLoading(true);
    setReloadKey((key) => key + 1);
  };

  const trades = useMemo(() => (data?.trades ?? []).filter((t) => strategy === "ALL" || t.strategy_id === strategy), [data, strategy]);

  if (error) return <div className="rounded-lg border border-[#e5484d]/30 bg-[#e5484d]/10 p-4 text-sm text-[#ff8b91]">{error}</div>;
  if (!data) return <div className="grid gap-3 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <SkeletonBlock key={i} className="h-28" />)}</div>;
  if (data.schema_ready === false) return <div className="rounded-lg border border-white/10 bg-[#101620] p-6 text-sm text-[#93a1b6]">{data.message}</div>;

  const account = data.account;
  const funding = data.funding;
  const totals = data.totals;
  const rec = data.reconciliation;
  const winRate = totals && totals.closed ? (100 * totals.wins) / totals.closed : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#93a1b6]">
        <span className="rounded border border-[#64d2ff]/30 bg-[#64d2ff]/10 px-2 py-0.5 font-mono font-bold uppercase text-[#64d2ff]">OANDA · {account?.environment ?? "—"}</span>
        <span className="font-mono">{account?.account_id}</span>
        <span>· synced {relativeAge(account?.synced_at)}</span>
        <button onClick={reload} disabled={loading} className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 font-semibold text-[#d6deec] hover:bg-white/5 disabled:opacity-50">
          <RefreshCw className={cx("size-3.5", loading && "animate-spin")} /> Reload
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <SummaryCard icon={Banknote} label="Initial funding" value={usd(funding?.initial_amount)} note={funding?.initial_ts ? `CLIENT_FUNDING · ${et(funding.initial_ts)}` : "no transfer recorded"} tone="blue" />
        <SummaryCard icon={Wallet} label="Balance / NAV" value={usd(account?.nav ?? account?.balance)} note={`balance ${usd(account?.balance)} · unrealized ${signedUsd(account?.unrealized_pl)}`} tone="gold" />
        <SummaryCard icon={Activity} label="Net P&L since funding" value={signedUsd(totals?.net_pl)} note={`${funding?.return_pct === null || funding?.return_pct === undefined ? "—" : `${funding.return_pct > 0 ? "+" : ""}${funding.return_pct.toFixed(2)}%`} on ${usd(funding?.deposits)} deposited · financing ${signedUsd(totals?.financing)}`} tone={pnlTone(totals?.net_pl)} />
        <SummaryCard icon={ListOrdered} label="Trades" value={String(totals?.trades ?? 0)} note={`${totals?.closed ?? 0} closed · ${totals?.open ?? 0} open · win rate ${winRate === null ? "—" : `${winRate.toFixed(1)}%`}`} tone="muted" />
      </div>

      {rec ? (
        <div className={cx("flex flex-wrap items-center gap-2 rounded-lg border px-4 py-2 text-[11px]", Math.abs(rec.difference) < 1 ? "border-[#2fbf71]/30 bg-[#2fbf71]/5 text-[#62d894]" : "border-[#d9a441]/30 bg-[#d9a441]/5 text-[#f2c873]")}>
          <Scale className="size-3.5" />
          Reconciliation: deposits {usd(rec.deposits)} + net trade P&L {signedUsd(rec.net_trade_pl)} = {usd(rec.expected_balance)} · OANDA balance {usd(rec.broker_balance)} · difference {signedUsd(rec.difference)}
        </div>
      ) : null}

      <Panel icon={Layers3} title="By strategy" note="net = realized P&L + financing, from OANDA">
        <DataTable headers={["Strategy", "Trades", "Closed", "Open", "Win rate", "Realized", "Financing", "Net P&L", "Best", "Worst", "First → last trade"]} minWidth={1100}>
          {(data.by_strategy ?? []).map((s) => (
            <tr key={s.strategy_id} onClick={() => setStrategy(strategy === s.strategy_id ? "ALL" : s.strategy_id)} className={cx("cursor-pointer hover:bg-white/[0.03]", strategy === s.strategy_id && "bg-[#d9a441]/10")}>
              <td className="px-4 py-3 font-semibold text-white">{strategyLabel(s.strategy_id)}</td>
              <td className="px-4 py-3 font-mono">{s.trades}</td>
              <td className="px-4 py-3 font-mono">{s.closed}</td>
              <td className="px-4 py-3 font-mono">{s.open}</td>
              <td className="px-4 py-3 font-mono">{s.closed ? `${((100 * s.wins) / s.closed).toFixed(1)}%` : "—"} <span className="text-[#657187]">({s.wins}W/{s.losses}L)</span></td>
              <td className="px-4 py-3 font-mono">{signedUsd(s.realized_pl)}</td>
              <td className="px-4 py-3 font-mono">{signedUsd(s.financing)}</td>
              <td className={cx("px-4 py-3 font-mono font-bold", s.net_pl >= 0 ? "text-[#62d894]" : "text-[#ff8b91]")}>{signedUsd(s.net_pl)}</td>
              <td className="px-4 py-3 font-mono text-[#62d894]">{signedUsd(s.best)}</td>
              <td className="px-4 py-3 font-mono text-[#ff8b91]">{signedUsd(s.worst)}</td>
              <td className="px-4 py-3 text-[#93a1b6]">{et(s.first_trade)} → {et(s.last_trade)}</td>
            </tr>
          ))}
        </DataTable>
      </Panel>

      {/* Realtime metrics, charts and ICT trade charts, scoped to the trades OANDA actually filled. */}
      <RealtimeOrdersDashboard brokerScope="OANDA" onOpenTrade={onOpenTrade ?? noop} />

      <Panel icon={ListOrdered} title="OANDA broker ledger · every trade since funding" note={
        <span className="flex items-center gap-2">
          <select value={strategy} onChange={(e) => setStrategy(e.target.value)} className="rounded border border-white/10 bg-[#0b0f16] px-2 py-1 text-[11px] text-[#d6deec]">
            <option value="ALL">All strategies ({data.trades?.length ?? 0})</option>
            {(data.by_strategy ?? []).map((s) => <option key={s.strategy_id} value={s.strategy_id}>{strategyLabel(s.strategy_id)} ({s.trades})</option>)}
          </select>
          <button
            onClick={() => { const blob = new Blob([csvFor(trades)], { type: "text/csv" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `oanda_trades_${strategy.toLowerCase()}.csv`; a.click(); URL.revokeObjectURL(url); }}
            className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11px] text-[#d6deec] hover:bg-white/5"
          ><Download className="size-3" />CSV</button>
        </span>
      }>
        <DataTable headers={["Opened", "Closed", "Strategy", "Instrument", "Side", "Units", "Entry", "Exit", "Exit reason", "Net P&L", "State", "Trade #"]} minWidth={1300}>
          {trades.length ? trades.map((t) => (
            <tr key={t.trade_id} className="hover:bg-white/[0.03]">
              <td className="whitespace-nowrap px-4 py-2 text-[#d6deec]">{et(t.open_ts)}</td>
              <td className="whitespace-nowrap px-4 py-2 text-[#93a1b6]">{et(t.close_ts)}</td>
              <td className="px-4 py-2"><div className="font-semibold text-white">{strategyLabel(t.strategy_id)}</div>{t.strategy_detail ? <div className="max-w-[280px] truncate text-[10px] text-[#657187]" title={t.strategy_detail}>{t.strategy_detail}</div> : null}</td>
              <td className="px-4 py-2 font-mono font-bold text-[#64d2ff]">{t.instrument.replace("_", "/")}</td>
              <td className="px-4 py-2"><SideCell side={t.side} /></td>
              <td className="px-4 py-2 font-mono">{Number(t.units).toLocaleString("en-US")}</td>
              <td className="px-4 py-2 font-mono">{px(t.open_price, t.instrument)}</td>
              <td className="px-4 py-2 font-mono">{px(t.close_price, t.instrument)}</td>
              <td className="px-4 py-2 text-[10px] uppercase text-[#93a1b6]">{reasonLabel(t.close_reason)}</td>
              <td className={cx("px-4 py-2 font-mono font-bold", t.state === "OPEN" ? "text-[#f2c873]" : netOf(t) >= 0 ? "text-[#62d894]" : "text-[#ff8b91]")}>{t.state === "OPEN" ? signedUsd(t.unrealized_pl) : signedUsd(netOf(t))}</td>
              <td className="px-4 py-2"><StatusPill value={t.state} /></td>
              <td className="px-4 py-2 font-mono text-[#657187]">{t.trade_id}</td>
            </tr>
          )) : <EmptyRow span={12} message="No OANDA trades for this strategy." />}
        </DataTable>
      </Panel>
    </div>
  );
}
