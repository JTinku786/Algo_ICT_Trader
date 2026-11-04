"use client";

import {
  AlertTriangle, BriefcaseBusiness, CircleDollarSign, Layers, Pause, Play, RefreshCw,
  ShieldCheck, TrendingDown, TrendingUp, UserRound, WalletCards, XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  DataTable, EmptyRow, Panel, SideCell, SkeletonBlock, SourceBadge, StatusPill, SummaryCard,
  cx, fmtTime, money, pnlTone, price, qty, relativeAge, signedMoney,
} from "./account-management-ui";

/** Live view: state pulled straight from Angel One, Dhan and Groww on each poll. */

type LivePosition = {
  tradingsymbol: string; underlying: string | null; exchange: string | null; product: string | null;
  option_type: string | null; strike: number | null; expiry_date: string | null; position_type: string;
  net_quantity: number | null; buy_quantity: number | null; sell_quantity: number | null;
  buy_avg_price: number | null; sell_avg_price: number | null; last_price: number | null;
  realized_pnl: number | null; unrealized_pnl: number | null; total_pnl: number | null;
};

type LiveOrder = {
  broker_order_id: string; tradingsymbol: string | null; exchange: string | null; product: string | null;
  side: string | null; order_type: string | null; status: string; status_raw: string | null;
  is_open: boolean; reject_reason: string | null; quantity: number | null; filled_quantity: number | null;
  pending_quantity: number | null; price: number | null; average_price: number | null;
  order_ts: string | null; trade_date: string | null; source: string;
};

type LiveFunds = {
  available_cash: number | null; opening_balance: number | null; utilised_margin: number | null;
  collateral: number | null; withdrawable_balance: number | null; net_balance: number | null;
};

type LiveTotals = {
  open_positions: number; closed_positions_today: number; working_orders: number; rejected_today: number;
  orders_today: number; realized_pnl: number; unrealized_pnl: number; total_pnl: number;
};

type LiveAccount = {
  id: string; broker: string; broker_account: string; display_name: string; environment: string;
  strategies: string[]; auth_status: string; token_expires_at?: string | null;
  errors: Record<string, string>; positions: LivePosition[]; orders: LiveOrder[];
  funds: LiveFunds | null; totals?: LiveTotals;
};

type LivePayload = {
  success: boolean; error?: string; generated_at: string; cached?: boolean;
  summary: {
    accounts: number; reachable: number; open_positions: number; working_orders: number;
    rejected_today: number; realized_pnl: number; unrealized_pnl: number; total_pnl: number; available_cash: number;
  };
  accounts: LiveAccount[];
};

const REFRESH_OPTIONS = [15, 30, 60, 120];

// How old the last snapshot may be before re-opening the tab refetches it.
const STALE_AFTER_MS = 60_000;

export default function AccountManagementLive({
  broker,
  account,
  active = true,
}: {
  broker: string;
  account: string;
  active?: boolean;
}) {
  const [data, setData] = useState<LivePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Manual by default: one fetch when the tab is opened, then only when the
  // user asks. Each fetch talks to all three brokers, so it is not something
  // to do on a timer unless the user opts in.
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [intervalSeconds, setIntervalSeconds] = useState(30);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(
    async (force = false) => {
      // A poll that lands while the previous one is still waiting on a broker
      // would queue up logins behind each other, so skip instead of stacking.
      if (inFlight.current) return;
      inFlight.current = true;
      setLoading(true);
      try {
        const params = new URLSearchParams({ broker, account });
        if (force) params.set("force", "1");
        const response = await fetch(`/api/account-management/live?${params}`, { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok || payload.success === false) throw new Error(payload.error || "Live broker data unavailable");
        setData(payload);
        setFetchedAt(new Date().toISOString());
        setError("");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Live broker data unavailable");
      } finally {
        inFlight.current = false;
        setLoading(false);
      }
    },
    [account, broker],
  );

  useEffect(() => {
    // Hitting three brokers is expensive; do not do it for a hidden tab, and do
    // not re-fetch on every tab switch when what we have is still current.
    if (!active) return;
    const age = fetchedAt ? Date.now() - new Date(fetchedAt).getTime() : Infinity;
    if (age < STALE_AFTER_MS) return;
    void load();
    // fetchedAt is deliberately not a dependency: including it would re-run this
    // effect on every successful load and fetch forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, load]);

  useEffect(() => {
    if (!active || !autoRefresh) return;
    const timer = setInterval(() => void load(), intervalSeconds * 1000);
    return () => clearInterval(timer);
  }, [active, autoRefresh, intervalSeconds, load]);

  const summary = data?.summary;
  const accounts = data?.accounts ?? [];
  const openPositions = accounts.flatMap((item) =>
    item.positions.filter((row) => row.position_type === "OPEN").map((row) => ({ ...row, account: item })),
  );
  const workingOrders = accounts.flatMap((item) =>
    item.orders.filter((row) => row.is_open).map((row) => ({ ...row, account: item })),
  );
  const rejectedOrders = accounts.flatMap((item) =>
    item.orders.filter((row) => row.status === "REJECTED").map((row) => ({ ...row, account: item })),
  );
  const unreachable = accounts.filter((item) => item.auth_status !== "verified");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-[#0d1118] px-4 py-3">
        <span className="flex items-center gap-2 text-[11px] font-semibold text-[#d6deec]">
          <span
            className={cx(
              "size-2 rounded-full",
              error ? "bg-[#e5484d]" : loading ? "animate-pulse bg-[#d9a441]" : "bg-[#2fbf71]",
            )}
          />
          {error ? "Broker call failed" : loading ? "Asking the brokers…" : "Live from Angel One, Dhan and Groww"}
        </span>
        <span className="font-mono text-[10px] text-[#657187]">
          {fetchedAt ? `Fetched ${relativeAge(fetchedAt)}` : "Not fetched yet"}
          {data?.cached ? " · cached" : ""}
          {autoRefresh ? "" : " · manual refresh"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh((value) => !value)}
            className="flex h-9 items-center gap-1.5 rounded-md border border-white/10 bg-[#101620] px-3 text-[11px] font-semibold text-[#d6deec] hover:border-[#d9a441]/50"
          >
            {autoRefresh ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            {autoRefresh ? "Stop auto" : "Auto refresh"}
          </button>
          <select
            aria-label="Refresh interval"
            value={intervalSeconds}
            onChange={(event) => setIntervalSeconds(Number(event.target.value))}
            className="h-9 rounded-md border border-white/10 bg-[#080b10] px-2 text-[11px] font-semibold text-[#d6deec] outline-none focus:border-[#d9a441]/60"
          >
            {REFRESH_OPTIONS.map((value) => (
              <option key={value} value={value}>
                every {value}s
              </option>
            ))}
          </select>
          <button
            onClick={() => void load(true)}
            disabled={loading}
            className="flex h-9 items-center gap-1.5 rounded-md border border-white/10 bg-[#101620] px-3 text-[11px] font-semibold text-[#d6deec] hover:border-[#d9a441]/50 disabled:opacity-50"
          >
            <RefreshCw className={cx("size-3.5", loading && "animate-spin")} /> Refresh
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-[#e5484d]/30 bg-[#e5484d]/10 p-4 text-sm text-[#ff9da2]">
          <AlertTriangle className="mr-2 inline size-4" />
          <span className="whitespace-pre-wrap">{error}</span>
        </div>
      ) : null}

      {loading && !data ? (
        <div className="rounded-md border border-[#d9a441]/25 bg-[#d9a441]/10 p-3 text-[11px] text-[#f2c873]">
          Logging in to Angel One, Dhan and Groww. The first call after a session expires takes
          around 15-20 seconds; later refreshes reuse the cached sessions and are quick.
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryCard
          icon={Layers}
          label="Open positions"
          value={String(summary?.open_positions ?? 0)}
          note={`${summary?.reachable ?? 0}/${summary?.accounts ?? 0} accounts reachable`}
          tone="blue"
        />
        <SummaryCard
          icon={(summary?.unrealized_pnl ?? 0) >= 0 ? TrendingUp : TrendingDown}
          label="Unrealized P&L"
          value={signedMoney(summary?.unrealized_pnl)}
          note="open exposure, marked to market"
          tone={pnlTone(summary?.unrealized_pnl)}
        />
        <SummaryCard
          icon={CircleDollarSign}
          label="Booked today"
          value={signedMoney(summary?.realized_pnl)}
          note="broker realized P&L"
          tone={pnlTone(summary?.realized_pnl)}
        />
        <SummaryCard
          icon={BriefcaseBusiness}
          label="Working orders"
          value={String(summary?.working_orders ?? 0)}
          note="live at the exchange"
          tone={(summary?.working_orders ?? 0) > 0 ? "gold" : "muted"}
        />
        <SummaryCard
          icon={WalletCards}
          label="Available cash"
          value={money(summary?.available_cash)}
          note="across all accounts"
          tone="blue"
        />
      </div>

      {unreachable.length ? (
        <div className="rounded-md border border-[#d9a441]/30 bg-[#d9a441]/10 p-3 text-[11px] text-[#f2c873]">
          <AlertTriangle className="mr-2 inline size-3.5" />
          {unreachable.map((item) => `${item.display_name} (${item.broker.toUpperCase()}): ${item.errors.login || item.auth_status}`).join(" · ")}
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {loading && !data ? <SkeletonBlock className="h-44" /> : null}
        {accounts.map((item) => (
          <AccountCard key={item.id} account={item} />
        ))}
        {!loading && accounts.length === 0 && !error ? (
          <div className="rounded-md border border-dashed border-white/10 p-8 text-center text-sm text-[#657187]">
            No broker accounts are configured for the live lane.
          </div>
        ) : null}
      </div>

      <Panel icon={Layers} title="Open positions" note={`${openPositions.length} live`}>
        <DataTable
          headers={["Account", "Contract", "Product", "Net qty", "Avg buy", "LTP", "Unrealized", "Booked"]}
          minWidth={950}
        >
          {openPositions.length === 0 ? (
            <EmptyRow span={8} message="No open positions at any broker right now." />
          ) : (
            openPositions.map((row, index) => (
              <tr key={`${row.account.id}-${row.tradingsymbol}-${index}`} className="text-[#c8d1df] hover:bg-white/[0.025]">
                <td className="px-4 py-3">
                  <div className="font-semibold text-white">{row.account.display_name}</div>
                  <div className="font-mono text-[9px] uppercase text-[#657187]">{row.account.broker}</div>
                </td>
                <td className="px-4 py-3 font-mono text-[10px]">{row.tradingsymbol}</td>
                <td className="px-4 py-3 text-[10px] uppercase text-[#93a1b6]">{row.product || "—"}</td>
                <td className={cx("px-4 py-3 font-mono font-semibold", (row.net_quantity ?? 0) >= 0 ? "text-[#62d894]" : "text-[#ff8b91]")}>
                  {qty(row.net_quantity)}
                </td>
                <td className="px-4 py-3 font-mono">{price(row.buy_avg_price)}</td>
                <td className="px-4 py-3 font-mono">{price(row.last_price)}</td>
                <td className={cx("px-4 py-3 font-mono font-semibold", (row.unrealized_pnl ?? 0) >= 0 ? "text-[#62d894]" : "text-[#ff8b91]")}>
                  {signedMoney(row.unrealized_pnl)}
                </td>
                <td className={cx("px-4 py-3 font-mono", (row.realized_pnl ?? 0) >= 0 ? "text-[#62d894]" : "text-[#ff8b91]")}>
                  {signedMoney(row.realized_pnl)}
                </td>
              </tr>
            ))
          )}
        </DataTable>
      </Panel>

      <div className="grid gap-4 2xl:grid-cols-2">
        <Panel icon={BriefcaseBusiness} title="Working orders" note={`${workingOrders.length} live`}>
          <DataTable headers={["Time", "Account", "Contract", "Side", "Qty", "Price", "Status", "By"]} minWidth={760}>
            {workingOrders.length === 0 ? (
              <EmptyRow span={8} message="Nothing pending at the exchange." />
            ) : (
              workingOrders.map((row) => (
                <tr key={`${row.account.id}-${row.broker_order_id}`} className="text-[#c8d1df] hover:bg-white/[0.025]">
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-[#7f8ca3]">{fmtTime(row.order_ts)}</td>
                  <td className="px-4 py-3 text-[10px]">{row.account.display_name}</td>
                  <td className="px-4 py-3 font-mono text-[10px]">{row.tradingsymbol || "—"}</td>
                  <td className="px-4 py-3"><SideCell side={row.side || ""} /></td>
                  <td className="px-4 py-3 font-mono">
                    {qty(row.filled_quantity)}<span className="text-[#657187]">/{qty(row.quantity)}</span>
                  </td>
                  <td className="px-4 py-3 font-mono">{price(row.price)}</td>
                  <td className="px-4 py-3"><StatusPill value={row.status_raw || row.status} /></td>
                  <td className="px-4 py-3"><SourceBadge source={row.source} /></td>
                </tr>
              ))
            )}
          </DataTable>
        </Panel>

        <Panel icon={XCircle} title="Rejected orders today" note={`${rejectedOrders.length} rejected`}>
          <DataTable headers={["Time", "Account", "Contract", "Side", "Qty", "Reason"]} minWidth={760}>
            {rejectedOrders.length === 0 ? (
              <EmptyRow span={6} message="No rejections today." />
            ) : (
              rejectedOrders.map((row) => (
                <tr key={`${row.account.id}-${row.broker_order_id}`} className="text-[#c8d1df] hover:bg-white/[0.025]">
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-[#7f8ca3]">{fmtTime(row.order_ts)}</td>
                  <td className="px-4 py-3 text-[10px]">{row.account.display_name}</td>
                  <td className="px-4 py-3 font-mono text-[10px]">{row.tradingsymbol || "—"}</td>
                  <td className="px-4 py-3"><SideCell side={row.side || ""} /></td>
                  <td className="px-4 py-3 font-mono">{qty(row.quantity)}</td>
                  <td className="px-4 py-3 text-[10px] text-[#ff9da2]">{row.reject_reason || "Broker gave no reason"}</td>
                </tr>
              ))
            )}
          </DataTable>
        </Panel>
      </div>
    </div>
  );
}

function AccountCard({ account }: { account: LiveAccount }) {
  const totals = account.totals;
  const healthy = account.auth_status === "verified";
  const errors = Object.entries(account.errors ?? {});
  return (
    <article className="rounded-lg border border-white/10 bg-[#101620] p-4">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-md bg-[#d9a441]/10 text-[#f2c873]">
          <UserRound className="size-4" />
        </div>
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-white">{account.display_name}</h3>
          <div className="truncate font-mono text-[10px] text-[#657187]">{account.broker_account}</div>
        </div>
        <span className="ml-auto rounded border border-white/10 px-2 py-1 font-mono text-[9px] font-bold uppercase text-[#93a1b6]">
          {account.broker}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <Metric label="Open" value={String(totals?.open_positions ?? 0)} />
        <Metric label="Working" value={String(totals?.working_orders ?? 0)} tone={(totals?.working_orders ?? 0) > 0 ? "gold" : undefined} />
        <Metric label="Rejected" value={String(totals?.rejected_today ?? 0)} tone={(totals?.rejected_today ?? 0) > 0 ? "red" : undefined} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-white/5 pt-3 text-[10px]">
        <div>
          <div className="uppercase text-[#657187]">Day P&L</div>
          <div className={cx("font-mono text-sm font-bold", (totals?.total_pnl ?? 0) >= 0 ? "text-[#62d894]" : "text-[#ff8b91]")}>
            {signedMoney(totals?.total_pnl)}
          </div>
        </div>
        <div>
          <div className="uppercase text-[#657187]">Available cash</div>
          <div className="font-mono text-sm font-bold text-[#d6deec]">{money(account.funds?.available_cash)}</div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-white/5 pt-3 text-[10px]">
        <span className={cx("flex items-center gap-1", healthy ? "text-[#62d894]" : "text-[#f2c873]")}>
          <ShieldCheck className="size-3" />
          {account.auth_status.replaceAll("_", " ")}
        </span>
        <span className="ml-auto text-[#657187]">{account.strategies.join(", ") || "Unassigned"}</span>
      </div>

      {errors.length ? (
        <div className="mt-2 space-y-1">
          {errors.map(([key, message]) => (
            <div key={key} className="rounded bg-[#e5484d]/10 px-2 py-1 text-[9px] text-[#ff9da2]">
              {key}: {message}
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "gold" | "red" }) {
  return (
    <div className="rounded border border-white/5 bg-white/[0.02] p-2">
      <div className={cx("font-mono text-sm font-bold", tone === "gold" ? "text-[#f2c873]" : tone === "red" ? "text-[#ff8b91]" : "text-white")}>
        {value}
      </div>
      <div className="text-[8px] uppercase text-[#657187]">{label}</div>
    </div>
  );
}
