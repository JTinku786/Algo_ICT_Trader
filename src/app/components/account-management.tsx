"use client";

import { Building2, ChevronLeft, ChevronRight, Globe2, History, Radio } from "lucide-react";
import { useCallback, useState, type ComponentProps } from "react";

import AccountManagementHistory from "./account-management-history";
import AccountManagementLive from "./account-management-live";
import AccountManagementOanda from "./account-management-oanda";
import AccountManagementSchwab from "./account-management-schwab";
import { SelectField, cx, monthLabel, monthOptions, shiftMonth } from "./account-management-ui";

/**
 * Account Management workspace.
 *
 * Two lanes over the same accounts:
 *   Live       — calls Angel One, Dhan and Groww through the local REST bridge
 *                on every poll: open positions, working and rejected orders, funds.
 *   Historical — reads the broker-truth tables that the daily sync
 *                (scripts/broker_sync) fills from those same brokers.
 */

type View = "live" | "historical" | "oanda" | "schwab";

type Filters = { brokers: string[]; accounts: { id: string; label: string }[]; months: string[] };

const EMPTY_FILTERS: Filters = { brokers: [], accounts: [], months: [] };

export default function AccountManagement({ onOpenTrade }: { onOpenTrade?: ComponentProps<typeof AccountManagementOanda>["onOpenTrade"] } = {}) {
  const [view, setView] = useState<View>("live");
  const [broker, setBroker] = useState("ALL");
  const [account, setAccount] = useState("ALL");
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  // Mount the OANDA view on first open only (it runs its own analytics query), then keep it mounted.
  const [oandaOpened, setOandaOpened] = useState(false);

  // Stable identity: the history view lists this in its fetch dependencies, so
  // an inline arrow here would re-trigger the fetch on every render.
  const handleFilters = useCallback((next: Filters) => setFilters(next), []);

  return (
    <section className="space-y-4" aria-label="Account management workspace">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#d9a441]">
            <Building2 className="size-4" /> Business operations
          </div>
          <h1 className="text-2xl font-semibold text-white md:text-3xl">Account Management</h1>
          <p className="mt-1 max-w-3xl text-sm text-[#93a1b6]">
            Every open position, closed position and rejected order across the Angel One, Dhan and Groww accounts, plus
            the OANDA forex account — taken from the brokers themselves, not inferred from the algo&apos;s own log.
          </p>
        </div>

        <div className="flex rounded-lg border border-white/10 bg-[#0d1118] p-1">
          <ViewTab icon={Radio} label="Realtime" active={view === "live"} onClick={() => setView("live")} />
          <ViewTab icon={History} label="Historical" active={view === "historical"} onClick={() => setView("historical")} />
          <ViewTab icon={Globe2} label="OANDA forex" active={view === "oanda"} onClick={() => { setView("oanda"); setOandaOpened(true); }} />
          <ViewTab icon={Building2} label="Schwab" active={view === "schwab"} onClick={() => setView("schwab")} />
        </div>
      </div>

      <div
        className={cx(
          "grid gap-3 rounded-lg border border-white/10 bg-[#0d1118] p-3",
          (view === "oanda" || view === "schwab") && "hidden",
          view === "historical" ? "md:grid-cols-[1fr_1.2fr_1fr_auto]" : "md:grid-cols-[1fr_1.2fr]",
        )}
      >
        <SelectField
          label="Broker"
          value={broker}
          onChange={(value) => {
            setBroker(value);
            setAccount("ALL");
          }}
          options={[
            { value: "ALL", label: "All brokers" },
            ...filters.brokers.map((value) => ({ value, label: value.toUpperCase() })),
          ]}
        />
        <SelectField
          label="Client account"
          value={account}
          onChange={setAccount}
          options={[{ value: "ALL", label: "All client accounts" }, ...filters.accounts.map(({ id, label }) => ({ value: id, label }))]}
        />
        {view === "historical" ? (
          <>
            <SelectField
              label="P&L month"
              value={month}
              onChange={setMonth}
              options={monthOptions(month, filters.months).map((value) => ({ value, label: monthLabel(value) }))}
            />
            <div className="flex items-end gap-1">
              <button
                onClick={() => setMonth((value) => shiftMonth(value, -1))}
                className="grid size-10 place-items-center rounded-md border border-white/10 text-[#93a1b6] hover:text-white"
                title="Previous month"
              >
                <ChevronLeft className="size-4" />
              </button>
              <button
                onClick={() => setMonth((value) => shiftMonth(value, 1))}
                className="grid size-10 place-items-center rounded-md border border-white/10 text-[#93a1b6] hover:text-white"
                title="Next month"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          </>
        ) : null}
      </div>

      {/* The historical view stays mounted so its filter list survives a tab
          switch, and so switching back does not re-fetch a whole month. */}
      <div className={view === "live" ? "block" : "hidden"}>
        <AccountManagementLive broker={broker} account={account} active={view === "live"} />
      </div>
      <div className={view === "historical" ? "block" : "hidden"}>
        <AccountManagementHistory broker={broker} account={account} month={month} onFiltersLoaded={handleFilters} />
      </div>
      <div className={view === "oanda" ? "block" : "hidden"}>
        {view === "oanda" || oandaOpened ? <AccountManagementOanda active={view === "oanda"} onOpenTrade={onOpenTrade} /> : null}
      </div>
      {view === "schwab" ? <AccountManagementSchwab /> : null}
    </section>
  );
}

function ViewTab({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "flex h-9 items-center gap-2 rounded-md px-4 text-xs font-semibold transition",
        active ? "bg-[#d9a441]/15 text-[#f2c873]" : "text-[#93a1b6] hover:text-white",
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}
