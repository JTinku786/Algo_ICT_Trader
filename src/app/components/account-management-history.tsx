"use client";

import {
  Activity as ActivityIcon, AlertTriangle, CalendarDays, CircleDollarSign, DatabaseZap,
  Layers, ReceiptText, ShieldCheck, TrendingDown, TrendingUp, UserRound, WalletCards, XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  DataTable, EmptyRow, FeedBadge, Panel, SideCell, SkeletonBlock, SourceBadge, StatusPill, SummaryCard,
  cx, fmtDateTime, money, monthLabel, pnlTone, price, qty, relativeAge, signedMoney,
} from "./account-management-ui";

/** Historical view: the broker-truth tables filled by the daily sync. */

type Funds = {
  trade_date: string; available_cash: number | null; opening_balance: number | null;
  utilised_margin: number | null; collateral: number | null; withdrawable_balance: number | null;
  net_balance: number | null;
};

type Account = {
  id: string; customer_key: string; display_name: string; broker: string; account_label: string;
  environment: string; active: boolean; strategies: string[]; risk_config: Record<string, unknown>;
  auth_status: string; last_verified_at: string | null; linked_customer: boolean; funds: Funds | null;
  metrics: {
    open_positions: number; closed_positions: number; orders: number; rejected: number; cancelled: number;
    working: number; algo_orders: number; manual_orders: number; trades: number;
    realized_pnl: number; unrealized_pnl: number; charges: number; turnover: number;
  };
};

type CalendarDay = {
  date: string; realized_pnl: number; charges: number; net_pnl: number;
  closed_positions: number; open_positions: number; orders: number; rejected: number; trades: number;
};

type Position = {
  account_id: string; broker: string; account_label: string; trade_date: string; tradingsymbol: string;
  product: string; position_type: string; net_quantity: number | null; buy_quantity: number | null;
  sell_quantity: number | null; buy_avg_price: number | null; sell_avg_price: number | null;
  last_price: number | null; realized_pnl: number | null; unrealized_pnl: number | null;
  source_feed: string;
};

type Order = {
  order_uid: string; account_id: string; broker: string; account_label: string; broker_order_id: string;
  trade_date: string; status: string; status_raw: string; is_open: boolean; reject_reason: string;
  tradingsymbol: string; product: string; order_type: string; side: string; quantity: number | null;
  filled_quantity: number | null; price: number | null; average_price: number | null;
  order_ts: string; source: string; source_feed: string;
};

type Trade = {
  trade_uid: string; account_id: string; broker: string; account_label: string; broker_order_id: string;
  trade_date: string; tradingsymbol: string; side: string; quantity: number | null; price: number | null;
  trade_value: number | null; trade_ts: string; charges_total: number | null; source_feed: string;
};

type SyncStatus = {
  account_id: string; broker: string; account_label: string; dataset: string;
  last_trade_date: string; last_success_at: string | null; last_status: string; last_error: string; rows_total: number;
};

type Issue = {
  issue_uid: string; broker: string; account_label: string; trade_date: string; issue_type: string;
  severity: string; broker_order_id: string; tradingsymbol: string; message: string;
};

type Payload = {
  success: boolean; error?: string; schema_ready: boolean; message: string | null; generated_at: string;
  query: { month: string; from: string; to: string };
  filters: { brokers: string[]; accounts: { id: string; label: string }[]; months: string[] };
  summary: {
    accounts: number; active: number; attention: number; realized_pnl: number; charges: number;
    net_pnl: number; unrealized_pnl: number; open_positions: number; closed_positions: number;
    orders: number; rejected: number; trades: number; manual_orders: number;
    available_cash: number; open_issues: number;
    provenance: { broker_api: number; derived_trades: number; execution_audit: number };
  };
  accounts: Account[]; calendar: CalendarDay[]; open_positions: Position[]; closed_positions: Position[];
  rejected_orders: Order[]; orders: Order[]; trades: Trade[]; sync_status: SyncStatus[]; issues: Issue[];
  warnings: string[];
};

type LedgerTab = "closed" | "open" | "rejected" | "orders" | "trades";

const TABS: { id: LedgerTab; label: string }[] = [
  { id: "closed", label: "Closed positions" },
  { id: "open", label: "Open positions" },
  { id: "rejected", label: "Rejected orders" },
  { id: "orders", label: "All orders" },
  { id: "trades", label: "Fills" },
];

export default function AccountManagementHistory({
  broker,
  account,
  month,
  onFiltersLoaded,
}: {
  broker: string;
  account: string;
  month: string;
  onFiltersLoaded?: (filters: Payload["filters"]) => void;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<LedgerTab>("closed");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ broker, account, month });
      const response = await fetch(`/api/account-management/history?${params}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || payload.success === false) throw new Error(payload.error || "Account history unavailable");
      setData(payload);
      onFiltersLoaded?.(payload.filters);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Account history unavailable");
    } finally {
      setLoading(false);
    }
  }, [account, broker, month, onFiltersLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  const calendar = useMemo(() => buildCalendar(month, data?.calendar ?? []), [month, data?.calendar]);
  const series = useMemo(() => buildSeries(month, data?.calendar ?? []), [month, data?.calendar]);
  const summary = data?.summary;

  if (data && !data.schema_ready) {
    return (
      <div className="rounded-lg border border-[#d9a441]/30 bg-[#d9a441]/10 p-6 text-sm text-[#f2c873]">
        <AlertTriangle className="mr-2 inline size-4" />
        {data.message ?? "Broker-truth tables are not created yet."}
        <pre className="mt-3 overflow-x-auto rounded bg-black/40 p-3 font-mono text-[11px] text-[#d6deec]">
{`python scripts/broker_sync/sync_broker_accounts.py --schema-only
python scripts/broker_sync/sync_broker_accounts.py`}
        </pre>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <div className="rounded-md border border-[#e5484d]/30 bg-[#e5484d]/10 p-4 text-sm text-[#ff9da2]">
          <AlertTriangle className="mr-2 inline size-4" />
          {error}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryCard
          icon={(summary?.net_pnl ?? 0) >= 0 ? TrendingUp : TrendingDown}
          label="Net P&L"
          value={signedMoney(summary?.net_pnl)}
          note={`${monthLabel(month)} · after charges`}
          tone={pnlTone(summary?.net_pnl)}
        />
        <SummaryCard
          icon={CircleDollarSign}
          label="Gross realized"
          value={signedMoney(summary?.realized_pnl)}
          note={`${money(summary?.charges)} charges`}
          tone={pnlTone(summary?.realized_pnl)}
        />
        <SummaryCard
          icon={Layers}
          label="Positions"
          value={`${summary?.closed_positions ?? 0} / ${summary?.open_positions ?? 0}`}
          note="closed / still open"
          tone="blue"
        />
        <SummaryCard
          icon={XCircle}
          label="Rejected orders"
          value={String(summary?.rejected ?? 0)}
          note={`of ${summary?.orders ?? 0} orders`}
          tone={(summary?.rejected ?? 0) > 0 ? "red" : "green"}
        />
        <SummaryCard
          icon={ShieldCheck}
          label="Open issues"
          value={String(summary?.open_issues ?? 0)}
          note={`${summary?.manual_orders ?? 0} manual orders seen`}
          tone={(summary?.open_issues ?? 0) > 0 ? "gold" : "green"}
        />
      </div>

      <ProvenanceNote provenance={summary?.provenance} />

      <div className="grid gap-4 xl:grid-cols-[1.45fr_1fr]">
        <NetPnlChart month={month} points={series} />
        <Panel icon={WalletCards} title="Accounts" note={`${data?.accounts.length ?? 0} shown`}>
          <div className="max-h-[320px] space-y-3 overflow-auto p-3">
            {loading && !data ? <SkeletonBlock className="h-32" /> : null}
            {!loading && (data?.accounts.length ?? 0) === 0 ? (
              <div className="grid min-h-32 place-items-center text-center text-sm text-[#657187]">
                <div>
                  <UserRound className="mx-auto size-7 text-[#657187]" />
                  <div className="mt-2">No accounts match these filters.</div>
                </div>
              </div>
            ) : null}
            {data?.accounts.map((item) => <AccountCard key={item.id} account={item} />)}
          </div>
        </Panel>
      </div>

      <Panel icon={CalendarDays} title={`P&L calendar · ${monthLabel(month)}`} note="broker-confirmed, IST">
        <div className="p-3">
          <div className="grid grid-cols-7 gap-1 pb-1 text-center font-mono text-[9px] font-bold uppercase text-[#657187]">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
              <div key={day}>{day}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {calendar.map((day, index) => (
              <CalendarCell key={`${day.date}-${index}`} day={day} />
            ))}
          </div>
        </div>
      </Panel>

      <div className="overflow-hidden rounded-lg border border-white/10 bg-[#101620]">
        <div className="flex flex-wrap items-center gap-1 border-b border-white/10 px-3 py-2">
          {TABS.map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={cx(
                "rounded-md px-3 py-1.5 text-[11px] font-semibold transition",
                tab === item.id ? "bg-[#d9a441]/15 text-[#f2c873]" : "text-[#93a1b6] hover:text-white",
              )}
            >
              {item.label}
            </button>
          ))}
          <span className="ml-auto font-mono text-[10px] text-[#657187]">
            {data?.query.from} → {data?.query.to}
          </span>
        </div>
        {tab === "closed" || tab === "open" ? (
          <PositionTable rows={tab === "closed" ? data?.closed_positions ?? [] : data?.open_positions ?? []} closed={tab === "closed"} />
        ) : tab === "trades" ? (
          <TradeTable rows={data?.trades ?? []} />
        ) : (
          <OrderTable rows={tab === "rejected" ? data?.rejected_orders ?? [] : data?.orders ?? []} rejected={tab === "rejected"} />
        )}
      </div>

      <div className="grid gap-4 2xl:grid-cols-[1fr_1fr]">
        <Panel icon={DatabaseZap} title="Sync freshness" note="max update time per dataset">
          <DataTable headers={["Account", "Dataset", "Through", "Last success", "Status", "Rows"]} minWidth={720}>
            {(data?.sync_status ?? []).length === 0 ? (
              <EmptyRow span={6} message="The daily sync has not run for these accounts yet." />
            ) : (
              (data?.sync_status ?? []).map((row) => (
                <tr key={`${row.account_id}-${row.dataset}`} className="text-[#c8d1df] hover:bg-white/[0.025]">
                  <td className="px-4 py-2.5 text-[10px]">{row.account_label}</td>
                  <td className="px-4 py-2.5 font-mono text-[10px] uppercase">{row.dataset}</td>
                  <td className="px-4 py-2.5 font-mono text-[10px]">{row.last_trade_date || "—"}</td>
                  <td className="px-4 py-2.5 text-[10px] text-[#7f8ca3]" title={row.last_success_at ?? ""}>
                    {relativeAge(row.last_success_at)}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusPill value={row.last_status} />
                    {row.last_error ? (
                      <div className="mt-1 max-w-[220px] truncate text-[9px] text-[#ff9da2]" title={row.last_error}>
                        {row.last_error}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[10px]">{row.rows_total.toLocaleString("en-IN")}</td>
                </tr>
              ))
            )}
          </DataTable>
        </Panel>

        <Panel icon={ReceiptText} title="Reconciliation" note={`${data?.issues.length ?? 0} open`}>
          <div className="max-h-[340px] space-y-2 overflow-auto p-3">
            {(data?.issues ?? []).length === 0 ? (
              <div className="grid min-h-32 place-items-center text-center text-[11px] text-[#62d894]">
                Broker records and algo records agree for this range.
              </div>
            ) : null}
            {(data?.issues ?? []).map((issue) => (
              <div
                key={issue.issue_uid}
                className={cx(
                  "rounded-md border px-3 py-2 text-[11px]",
                  issue.severity === "error"
                    ? "border-[#e5484d]/30 bg-[#e5484d]/10 text-[#ff9da2]"
                    : issue.severity === "warning"
                      ? "border-[#d9a441]/30 bg-[#d9a441]/10 text-[#f2c873]"
                      : "border-white/10 bg-white/5 text-[#93a1b6]",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[9px] font-bold uppercase">{issue.issue_type.replaceAll("_", " ")}</span>
                  <span className="ml-auto font-mono text-[9px] opacity-70">
                    {issue.account_label} · {issue.trade_date || "—"}
                  </span>
                </div>
                <div className="mt-1 leading-snug">{issue.message}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid gap-2 text-[11px] text-[#7f8ca3] md:grid-cols-3">
        {(data?.warnings ?? []).map((warning) => (
          <div key={warning} className="rounded-md border border-white/10 bg-[#0b0f16] px-3 py-2">
            • {warning}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProvenanceNote({ provenance }: { provenance?: Payload["summary"]["provenance"] }) {
  const live = provenance?.broker_api ?? 0;
  const derived = provenance?.derived_trades ?? 0;
  const rebuilt = provenance?.execution_audit ?? 0;
  if (!derived && !rebuilt) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-white/10 bg-[#0b0f16] px-3 py-2 text-[11px] text-[#93a1b6]">
      <FeedBadge feed="broker_api" />
      <span>{live} day(s) straight from the broker API</span>
      {derived ? (
        <>
          <span>·</span>
          <FeedBadge feed="derived_trades" />
          <span>{derived} computed from broker-returned fills</span>
        </>
      ) : null}
      {rebuilt ? (
        <>
          <span>·</span>
          <FeedBadge feed="execution_audit" />
          <span>{rebuilt} rebuilt from the algo audit trail</span>
        </>
      ) : null}
      <span className="ml-auto text-[10px] text-[#657187]">
        Angel One and Groww publish no historical endpoint, so anything before the first sync is reconstructed.
      </span>
    </div>
  );
}

function AccountCard({ account }: { account: Account }) {
  const healthy = ["verified", "live", "healthy"].includes(account.auth_status.toLowerCase());
  const net = account.metrics.realized_pnl - account.metrics.charges;
  return (
    <article className="rounded-md border border-white/10 bg-[#0b0f16] p-4">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-md bg-[#d9a441]/10 text-[#f2c873]">
          <UserRound className="size-4" />
        </div>
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-white">{account.display_name}</h3>
          <div className="truncate font-mono text-[10px] text-[#657187]">{account.account_label}</div>
        </div>
        <span className="ml-auto rounded border border-white/10 px-2 py-1 font-mono text-[9px] font-bold uppercase text-[#93a1b6]">
          {account.broker}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
        <div>
          <div className="uppercase text-[#657187]">Net P&L</div>
          <div className={cx("font-mono text-sm font-bold", net >= 0 ? "text-[#62d894]" : "text-[#ff8b91]")}>
            {signedMoney(net)}
          </div>
        </div>
        <div>
          <div className="uppercase text-[#657187]">Cash</div>
          <div className="font-mono text-sm font-bold text-[#d6deec]">{money(account.funds?.available_cash)}</div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-1.5 text-center">
        <Mini label="Closed" value={account.metrics.closed_positions} />
        <Mini label="Open" value={account.metrics.open_positions} />
        <Mini label="Rejected" value={account.metrics.rejected} tone={account.metrics.rejected ? "red" : undefined} />
        <Mini label="Manual" value={account.metrics.manual_orders} tone={account.metrics.manual_orders ? "gold" : undefined} />
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-white/5 pt-3 text-[10px]">
        <span className={cx("flex items-center gap-1", healthy ? "text-[#62d894]" : "text-[#f2c873]")}>
          <ShieldCheck className="size-3" />
          {account.auth_status.replaceAll("_", " ")}
        </span>
        <span className="ml-auto text-[#657187]" title={account.last_verified_at ?? ""}>
          {account.strategies.join(", ") || "Unassigned"}
        </span>
      </div>
    </article>
  );
}

function Mini({ label, value, tone }: { label: string; value: number; tone?: "red" | "gold" }) {
  return (
    <div className="rounded border border-white/5 bg-white/[0.02] p-1.5">
      <div className={cx("font-mono text-xs font-bold", tone === "red" ? "text-[#ff8b91]" : tone === "gold" ? "text-[#f2c873]" : "text-white")}>
        {value}
      </div>
      <div className="text-[8px] uppercase text-[#657187]">{label}</div>
    </div>
  );
}

function PositionTable({ rows, closed }: { rows: Position[]; closed: boolean }) {
  return (
    <DataTable headers={["Date", "Account", "Contract", "Product", "Buy qty", "Sell qty", "Buy avg", "Sell avg", closed ? "Realized" : "Unrealized", "Data"]} minWidth={1080}>
      {rows.length === 0 ? (
        <EmptyRow span={10} message={closed ? "No closed positions in this range." : "No open positions on the latest synced day."} />
      ) : (
        rows.map((row, index) => (
          <tr key={`${row.account_id}-${row.trade_date}-${row.tradingsymbol}-${index}`} className="text-[#c8d1df] hover:bg-white/[0.025]">
            <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-[#7f8ca3]">{row.trade_date}</td>
            <td className="px-4 py-3 text-[10px]">
              {row.account_label}
              <div className="font-mono text-[9px] uppercase text-[#657187]">{row.broker}</div>
            </td>
            <td className="px-4 py-3 font-mono text-[10px]">{row.tradingsymbol}</td>
            <td className="px-4 py-3 text-[10px] uppercase text-[#93a1b6]">{row.product || "—"}</td>
            <td className="px-4 py-3 font-mono">{qty(row.buy_quantity)}</td>
            <td className="px-4 py-3 font-mono">{qty(row.sell_quantity)}</td>
            <td className="px-4 py-3 font-mono">{price(row.buy_avg_price)}</td>
            <td className="px-4 py-3 font-mono">{price(row.sell_avg_price)}</td>
            <td
              className={cx(
                "px-4 py-3 text-right font-mono font-semibold",
                ((closed ? row.realized_pnl : row.unrealized_pnl) ?? 0) >= 0 ? "text-[#62d894]" : "text-[#ff8b91]",
              )}
            >
              {signedMoney(closed ? row.realized_pnl : row.unrealized_pnl)}
            </td>
            <td className="px-4 py-3"><FeedBadge feed={row.source_feed} /></td>
          </tr>
        ))
      )}
    </DataTable>
  );
}

function OrderTable({ rows, rejected }: { rows: Order[]; rejected: boolean }) {
  return (
    <DataTable headers={["Time", "Account", "Contract", "Side", "Qty", "Price", "Avg fill", "Status", "By", "Data", ...(rejected ? ["Reason"] : [])]} minWidth={1180}>
      {rows.length === 0 ? (
        <EmptyRow span={rejected ? 11 : 10} message={rejected ? "No rejected orders in this range." : "No orders in this range."} />
      ) : (
        rows.map((row) => (
          <tr key={row.order_uid} className="text-[#c8d1df] hover:bg-white/[0.025]">
            <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-[#7f8ca3]">{fmtDateTime(row.order_ts) }</td>
            <td className="px-4 py-3 text-[10px]">
              {row.account_label}
              <div className="font-mono text-[9px] uppercase text-[#657187]">{row.broker}</div>
            </td>
            <td className="px-4 py-3 font-mono text-[10px]">{row.tradingsymbol || "—"}</td>
            <td className="px-4 py-3"><SideCell side={row.side} /></td>
            <td className="px-4 py-3 font-mono">
              {qty(row.filled_quantity)}<span className="text-[#657187]">/{qty(row.quantity)}</span>
            </td>
            <td className="px-4 py-3 font-mono">{price(row.price)}</td>
            <td className="px-4 py-3 font-mono">{price(row.average_price)}</td>
            <td className="px-4 py-3"><StatusPill value={row.status_raw || row.status} /></td>
            <td className="px-4 py-3"><SourceBadge source={row.source} /></td>
            <td className="px-4 py-3"><FeedBadge feed={row.source_feed} /></td>
            {rejected ? (
              <td className="max-w-[260px] px-4 py-3 text-[10px] text-[#ff9da2]">{row.reject_reason || "Broker gave no reason"}</td>
            ) : null}
          </tr>
        ))
      )}
    </DataTable>
  );
}

function TradeTable({ rows }: { rows: Trade[] }) {
  return (
    <DataTable headers={["Time", "Account", "Contract", "Side", "Qty", "Price", "Value", "Charges", "Data"]} minWidth={980}>
      {rows.length === 0 ? (
        <EmptyRow span={9} message="No fills in this range." />
      ) : (
        rows.map((row) => (
          <tr key={row.trade_uid} className="text-[#c8d1df] hover:bg-white/[0.025]">
            <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-[#7f8ca3]">{fmtDateTime(row.trade_ts)}</td>
            <td className="px-4 py-3 text-[10px]">{row.account_label}</td>
            <td className="px-4 py-3 font-mono text-[10px]">{row.tradingsymbol}</td>
            <td className="px-4 py-3"><SideCell side={row.side} /></td>
            <td className="px-4 py-3 font-mono">{qty(row.quantity)}</td>
            <td className="px-4 py-3 font-mono">{price(row.price)}</td>
            <td className="px-4 py-3 font-mono">{money(row.trade_value)}</td>
            <td className="px-4 py-3 text-right font-mono text-[#f2c873]">{row.charges_total === null ? "—" : money(row.charges_total)}</td>
            <td className="px-4 py-3"><FeedBadge feed={row.source_feed} /></td>
          </tr>
        ))
      )}
    </DataTable>
  );
}

type Point = { date: string; daily: number; cumulative: number; active: boolean };

function buildSeries(month: string, rows: CalendarDay[]): Point[] {
  const [year, monthNumber] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const byDate = new Map(rows.map((row) => [row.date, row]));
  let cumulative = 0;
  return Array.from({ length: days }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, "0")}`;
    const row = byDate.get(date);
    const daily = row?.net_pnl ?? 0;
    cumulative += daily;
    return { date, daily, cumulative, active: Boolean(row) };
  });
}

function NetPnlChart({ month, points }: { month: string; points: Point[] }) {
  const width = 760;
  const height = 230;
  const padX = 26;
  const padY = 24;
  const values = points.map((point) => point.cumulative);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = Math.max(max - min, 1);
  const coords = points.map((point, index) => ({
    x: padX + (index / Math.max(points.length - 1, 1)) * (width - padX * 2),
    y: padY + ((max - point.cumulative) / span) * (height - padY * 2),
  }));
  const line = coords.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const zeroY = padY + ((max - 0) / span) * (height - padY * 2);
  const activeDays = points.filter((point) => point.active).length;
  const ending = points.at(-1)?.cumulative ?? 0;
  const positive = ending >= 0;

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-[#101620]">
      <div className="flex items-start gap-3 border-b border-white/10 px-4 py-3">
        <div className="grid size-8 place-items-center rounded-md bg-[#2fbf71]/10 text-[#62d894]">
          <ActivityIcon className="size-4" />
        </div>
        <div>
          <h2 className="font-semibold text-white">Net P&amp;L trajectory</h2>
          <p className="text-[10px] text-[#657187]">Broker realized P&amp;L less charges · {monthLabel(month)}</p>
        </div>
        <div className={cx("ml-auto font-mono text-lg font-bold", positive ? "text-[#62d894]" : "text-[#ff8b91]")}>
          {signedMoney(ending)}
        </div>
      </div>
      <div className="p-4">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-56 w-full" role="img" aria-label={`Cumulative net profit and loss for ${monthLabel(month)}`}>
          <defs>
            <linearGradient id="hist-pnl-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={positive ? "#2fbf71" : "#e5484d"} stopOpacity="0.28" />
              <stop offset="100%" stopColor={positive ? "#2fbf71" : "#e5484d"} stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((ratio) => (
            <line
              key={ratio}
              x1={padX}
              x2={width - padX}
              y1={padY + ratio * (height - padY * 2)}
              y2={padY + ratio * (height - padY * 2)}
              stroke="rgba(255,255,255,.06)"
            />
          ))}
          <line x1={padX} x2={width - padX} y1={zeroY} y2={zeroY} stroke="rgba(217,164,65,.24)" strokeDasharray="5 5" />
          {coords.length ? (
            <>
              <path d={`${line} L${coords.at(-1)?.x},${height - padY} L${coords[0].x},${height - padY} Z`} fill="url(#hist-pnl-fill)" />
              <path d={line} fill="none" stroke={positive ? "#62d894" : "#ff8b91"} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </>
          ) : null}
        </svg>
        <div className="flex items-center justify-between text-[10px] text-[#657187]">
          <span>Day 1</span>
          <span>{activeDays ? `${activeDays} trading day(s) with broker activity` : "No broker activity synced for this month"}</span>
          <span>Day {points.length}</span>
        </div>
      </div>
    </div>
  );
}

type CellDay = CalendarDay & { day: number; inMonth: boolean };

function buildCalendar(month: string, rows: CalendarDay[]): CellDay[] {
  const [year, monthNumber] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, monthNumber - 1, 1));
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7;
  const map = new Map(rows.map((row) => [row.date, row]));
  const blank = (key: string): CellDay => ({
    date: key, day: 0, inMonth: false, realized_pnl: 0, charges: 0, net_pnl: 0,
    closed_positions: 0, open_positions: 0, orders: 0, rejected: 0, trades: 0,
  });
  const result: CellDay[] = [];
  for (let index = 0; index < offset; index += 1) result.push(blank(`lead-${index}`));
  for (let day = 1; day <= days; day += 1) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    result.push({ ...blank(date), date, day, inMonth: true, ...map.get(date) });
  }
  while (result.length % 7) result.push(blank(`tail-${result.length}`));
  return result;
}

function CalendarCell({ day }: { day: CellDay }) {
  if (!day.inMonth) return <div className="min-h-20 rounded border border-transparent bg-black/10" />;
  const active = day.orders > 0 || day.trades > 0 || day.closed_positions > 0 || day.open_positions > 0;
  const positive = day.net_pnl >= 0;
  return (
    <div
      className={cx(
        "min-h-20 rounded-md border p-2",
        active
          ? positive
            ? "border-[#2fbf71]/25 bg-[#2fbf71]/[0.06]"
            : "border-[#e5484d]/25 bg-[#e5484d]/[0.06]"
          : "border-white/5 bg-[#0b0f16]",
      )}
    >
      <div className="flex items-center font-mono text-[10px] text-[#657187]">
        {day.day}
        {day.rejected ? <span className="ml-auto text-[#ff8b91]">{day.rejected}✕</span> : null}
      </div>
      {active ? (
        <>
          <div className={cx("mt-2 font-mono text-xs font-bold", positive ? "text-[#62d894]" : "text-[#ff8b91]")}>
            {signedMoney(day.net_pnl)}
          </div>
          <div className="mt-1 text-[8px] text-[#657187]">
            {day.closed_positions} closed · {day.trades} fills
          </div>
          {day.charges ? <div className="mt-0.5 text-[8px] text-[#f2c873]">{money(day.charges)} charges</div> : null}
        </>
      ) : null}
    </div>
  );
}
