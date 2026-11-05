"use client";

import Image from "next/image";
import dynamic from "next/dynamic";
import {
  BarChart3,
  BookOpen,
  Bot,
  CircleDollarSign,
  Clock3,
  Cpu,
  IndianRupee,
  Layers,
  LineChart,
  LockKeyhole,
  LogOut,
  MonitorDot,
  Play,
  RadioTower,
  CalendarDays,
  GitBranch,
  Rows3,
  ActivitySquare,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  Triangle,
  WalletCards,
  UsersRound,
  Zap,
} from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import AssistantPanel from "./assistant-panel";
import BacktestDashboard from "./backtest-dashboard";
import ReversalDashboard from "./reversal-dashboard";
import ConsolidationDashboard from "./consolidation-dashboard";
import ExpansionDashboard from "./expansion-dashboard";
import AmdDashboard from "./amd-dashboard";
import LiveOrders from "./live-orders";
import StrategyWorkspace from "./strategy-workspace";
import RealtimeOrdersDashboard from "./realtime-orders-dashboard";
import SictStrategyBuilder from "./sict-strategy-builder";
import MlInsights from "./ml-insights";
import OptionsLab from "./options-lab";
import Blogs from "./blogs";
import { BlogNavProvider } from "./blog-context";
import type { TradePrefill } from "./trade-navigation";
import AccountManagement from "./account-management";
import DailyBiasDashboard from "./daily-bias-dashboard";
import MarketStructureShift, {type MssResult,type MssFocus} from "./market-structure-shift";

const FibCalculation = dynamic(() => import("./fib-calculation"), { ssr: false });
const ReversalsUpdated = dynamic(() => import("./reversals-updated"), { ssr: false });
const ScalpingLabs = dynamic(() => import("./scalping-labs"), { ssr: false });
const SmtDivergence = dynamic(() => import("./smt-divergence"), { ssr: false });
const TopDownAnalysis = dynamic(() => import("./top-down-analysis"), { ssr: false });
const IctCoreWorkspace = dynamic(() => import("./ict-core-workspace"), { ssr: false });
const AgentDesk = dynamic(() => import("./agent-desk"), { ssr: false });

type Tab = "agent-desk" | "reversals-updated" | "fib-calculation" | "scalping-labs" | "market-structure-shift" | "swing-trading" | "smt-divergence" | "top-down" | "ict-core" | "daily-bias" | "realtime-orders" | "account-management" | "strategy-builder" | "options-lab" | "tradezella" | "stonk" | "backtest" | "reversal" | "consolidation" | "expansion" | "amd" | "ml" | "blogs" | "monitoring" | "live-orders" | "deployments";

// Hidden on the public Vercel deployment (set NEXT_PUBLIC_HIDE_ACCOUNT_MGMT=true there; unset locally).
const HIDE_ACCOUNT_MGMT = process.env.NEXT_PUBLIC_HIDE_ACCOUNT_MGMT === "true";

const tabs: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "smt-divergence", label: "SMC Divergence", icon: GitBranch },
  { id: "fib-calculation", label: "Fib Calculation", icon: TrendingUp },
  { id: "scalping-labs", label: "Scalping Labs", icon: Zap },
  { id: "market-structure-shift", label: "Market Structure Shift", icon: ActivitySquare },
  { id: "top-down", label: "Top Down Analysis", icon: Layers },
  { id: "swing-trading", label: "Swing Trading", icon: TrendingUp },
  { id: "ict-core", label: "ICT Core", icon: BookOpen },
  { id: "agent-desk", label: "Agent Desk", icon: Bot },
  { id: "realtime-orders", label: "Realtime Orders", icon: ActivitySquare },
  ...(HIDE_ACCOUNT_MGMT ? [] : [{ id: "account-management" as Tab, label: "Account Management", icon: UsersRound }]),
  { id: "strategy-builder", label: "Strategy Builder", icon: SlidersHorizontal },
  { id: "options-lab", label: "Options Lab", icon: Layers },
  { id: "tradezella", label: "Trade Journal", icon: CalendarDays },
  { id: "stonk", label: "Stonk Ledger", icon: Rows3 },
  { id: "daily-bias", label: "Daily Bias", icon: TrendingUp },
  { id: "backtest", label: "Backtest", icon: BarChart3 },
  { id: "reversal", label: "Reversal", icon: GitBranch },
  { id: "reversals-updated", label: "Reversals updated", icon: GitBranch },
  { id: "consolidation", label: "Consolidation", icon: Layers },
  { id: "expansion", label: "Expansion", icon: TrendingUp },
  { id: "amd", label: "AMD", icon: Triangle },
  { id: "ml", label: "Machine Learning", icon: Cpu },
  { id: "blogs", label: "Strategy Blogs", icon: BookOpen },
  { id: "monitoring", label: "Monitoring", icon: MonitorDot },
  { id: "live-orders", label: "Live Orders", icon: RadioTower },
  { id: "deployments", label: "Deployments", icon: Play },
];

function classNames(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(" ");
}

export default function TradingLanding() {
  const [mssResult,setMssResult]=useState<MssResult|null>(null);
  const [mssFocus,setMssFocus]=useState<MssFocus|null>(null);
  const [isAuthed, setIsAuthed] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [activeTab, setActiveTab] = useState<Tab>("realtime-orders");
  // deep link: /?tab=<tab id>&... (e.g. Reversal -> Market Structure Shift links)
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t && tabs.some((x) => x.id === t)) setActiveTab(t as Tab); // eslint-disable-line react-hooks/set-state-in-effect
  }, []);
  const [selectedTrade, setSelectedTrade] = useState<TradePrefill | null>(null);
  const [selectedBlogId, setSelectedBlogId] = useState<string | null>(null);

  function openTrade(trade: TradePrefill, destination: "tradezella" | "stonk") {
    setSelectedTrade(trade);
    setActiveTab(destination);
  }

  function openBlog(blogId: string) {
    setSelectedBlogId(blogId);
    setActiveTab("blogs");
  }

  function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (email === "admin@gmail.com" && password === "Welcome@2026") {
      setIsAuthed(true);
      setLoginError("");
      return;
    }
    setLoginError("Invalid static credential");
  }

  if (isAuthed) {
    return (
      <BlogNavProvider openBlog={openBlog}>
      <main className="min-h-screen bg-[#080b10] text-[#f5f7fb]">
        <div className="flex min-h-screen">
          <aside className="hidden w-[248px] border-r border-white/10 bg-[#0d1118] px-4 py-5 lg:block">
            <div className="mb-8 flex items-center gap-3">
              <div className="grid size-9 place-items-center rounded-md bg-[#d9a441] text-sm font-black text-[#11100b]">
                ICT
              </div>
              <div>
                <div className="text-sm font-semibold">Algo ICT Trader</div>
                <div className="font-mono text-[11px] text-[#93a1b6]">CONTROL PLANE</div>
              </div>
            </div>
            <nav className="space-y-1">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={classNames(
                      "flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm transition",
                      activeTab === tab.id
                        ? "bg-[#d9a441]/15 text-[#f2c873]"
                        : "text-[#93a1b6] hover:bg-white/5 hover:text-white",
                    )}
                  >
                    <Icon className="size-4" />
                    {tab.label}
                  </button>
                );
              })}
            </nav>
            <AssistantPanel currentTab={activeTab} />
          </aside>

          <section className="flex min-w-0 flex-1 flex-col">
            <header className="flex min-h-16 items-center gap-3 border-b border-white/10 bg-[#0b0f16]/95 px-4 backdrop-blur md:px-6">
              <div>
                <div className="text-sm font-semibold md:text-base">Trading Workspace</div>
                <div className="font-mono text-[11px] text-[#93a1b6]">ICT Strategy Tester / backtest results</div>
              </div>
              <div className="ml-auto hidden items-center gap-2 rounded-md border border-[#2fbf71]/30 bg-[#2fbf71]/10 px-3 py-1.5 text-xs text-[#62d894] sm:flex">
                <span className="size-1.5 rounded-full bg-[#2fbf71]" />
                System online
              </div>
              <button
                onClick={() => setIsAuthed(false)}
                className="grid size-9 place-items-center rounded-md border border-white/10 text-[#93a1b6] transition hover:border-[#e5484d]/60 hover:text-[#ff8b91]"
                title="Sign out"
              >
                <LogOut className="size-4" />
              </button>
            </header>

            <div className="flex flex-wrap gap-2 border-b border-white/10 bg-[#0d1118] px-4 py-3 lg:hidden">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={classNames(
                      "flex items-center gap-2 rounded-md border px-3 py-2 text-xs",
                      activeTab === tab.id
                        ? "border-[#d9a441]/60 bg-[#d9a441]/15 text-[#f2c873]"
                        : "border-white/10 text-[#93a1b6]",
                    )}
                  >
                    <Icon className="size-3.5" />
                    {tab.label}
                  </button>
                );
              })}
            </div>

            <div className="flex-1 overflow-auto p-4 md:p-6">
              {activeTab === "agent-desk" ? <AgentDesk /> : null}
              {activeTab === "realtime-orders" ? <RealtimeOrdersDashboard onOpenTrade={openTrade} /> : null}
              {activeTab === "account-management" && !HIDE_ACCOUNT_MGMT ? <AccountManagement onOpenTrade={openTrade} /> : null}
              {activeTab === "strategy-builder" ? <SictStrategyBuilder onOpenBacktest={() => setActiveTab("backtest")} /> : null}
              {activeTab === "options-lab" ? <OptionsLab /> : null}
              {activeTab === "tradezella" ? <StrategyWorkspace mode="tradezella" initialSelection={selectedTrade} /> : null}
              {activeTab === "stonk" ? <StrategyWorkspace mode="stonk" initialSelection={selectedTrade} /> : null}
              {activeTab === "daily-bias" ? <DailyBiasDashboard /> : null}
              {activeTab === "market-structure-shift" ? <MarketStructureShift initialData={mssResult} initialFocus={mssFocus} onResult={result=>{setMssResult(result);setMssFocus(null);}} /> : null}
              {activeTab === "fib-calculation" ? <FibCalculation /> : null}
              {activeTab === "scalping-labs" ? <ScalpingLabs /> : null}
              {activeTab === "smt-divergence" ? <SmtDivergence /> : null}
              {activeTab === "top-down" ? <TopDownAnalysis key="top-down" /> : null}
              {activeTab === "swing-trading" ? <TopDownAnalysis key="swing-trading" mode="swing" /> : null}
              {activeTab === "ict-core" ? <IctCoreWorkspace onOpenModule={setActiveTab} /> : null}
              {activeTab === "backtest" ? <BacktestDashboard /> : null}
              {activeTab === "reversals-updated" ? <ReversalsUpdated /> : null}
              {activeTab === "consolidation" ? <ConsolidationDashboard /> : null}
              {activeTab === "expansion" ? <ExpansionDashboard /> : null}
              {activeTab === "amd" ? <AmdDashboard /> : null}
              {activeTab === "reversal" ? <ReversalDashboard mssResult={mssResult} onOpenTrade={openTrade} onInspect={focus=>{setMssFocus(focus);setActiveTab("market-structure-shift");}} onOpenMss={()=>setActiveTab("market-structure-shift")} /> : null}
              {activeTab === "ml" ? <MlInsights /> : null}
              {activeTab === "blogs" ? <Blogs selectedId={selectedBlogId} onSelect={setSelectedBlogId} /> : null}
              {activeTab === "monitoring" ? <MonitoringPanel /> : null}
              {activeTab === "live-orders" ? <LiveOrders /> : null}
              {activeTab === "deployments" ? <DeploymentsPanel /> : null}
            </div>
          </section>
        </div>
      </main>
      </BlogNavProvider>
    );
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[#080b10] text-[#f5f7fb]">
      <section className="relative mx-auto flex min-h-screen w-full max-w-[1480px] flex-col px-4 py-5 md:px-8">
        <header className="flex items-center gap-4">
          <div className="grid size-10 place-items-center rounded-md bg-[#d9a441] text-sm font-black text-[#11100b]">
            ICT
          </div>
          <div>
            <div className="text-sm font-semibold">Algo ICT Trader</div>
            <div className="font-mono text-[11px] text-[#93a1b6]">US / INDIA / FOREX</div>
          </div>
          <div className="ml-auto hidden items-center gap-2 rounded-md border border-white/10 px-3 py-2 text-xs text-[#93a1b6] sm:flex">
            <ShieldCheck className="size-4 text-[#2fbf71]" />
            Admin preview
          </div>
        </header>

        <div className="grid flex-1 items-center gap-8 py-8 lg:grid-cols-[1fr_410px] xl:gap-12">
          <section className="min-w-0">
            <div className="mb-5 inline-flex items-center gap-2 rounded-md border border-[#2fbf71]/25 bg-[#2fbf71]/10 px-3 py-2 text-xs font-semibold text-[#75dfa3]">
              <Sparkles className="size-4" />
              ICT strategy operations, built AI-first
            </div>
            <h1 className="max-w-4xl text-balance text-5xl font-semibold leading-[1.02] md:text-6xl xl:text-7xl">
              Lightweight algo trading control for ICT strategies.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-[#a9b5c9] md:text-lg">
              Backtest approved models, deploy market-specific strategies, monitor live positions, and connect the
              Postgres-backed execution layer through a clean Python API.
            </p>

            <div className="mt-8 grid max-w-3xl gap-3 sm:grid-cols-3">
              <Metric icon={LineChart} label="Backtests" value="4 strategy families" tone="gold" />
              <Metric icon={WalletCards} label="Markets" value="US, India, Forex" tone="blue" />
              <Metric icon={Cpu} label="Runtime" value="Python + Postgres" tone="green" />
            </div>

            <div className="mt-8 overflow-hidden rounded-md border border-white/10 bg-[#0d1118]">
              <Image
                src="/product-preview.png"
                width={1280}
                height={720}
                priority
                alt="Algo ICT Trader dashboard preview"
                className="h-auto w-full"
              />
            </div>
          </section>

          <aside className="rounded-md border border-white/10 bg-[#101620] p-5 shadow-2xl shadow-black/30">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold">Admin Login</h2>
                <p className="mt-1 text-sm text-[#93a1b6]">Static preview credential</p>
              </div>
              <div className="grid size-10 place-items-center rounded-md border border-white/10 bg-[#0b0f16]">
                <LockKeyhole className="size-5 text-[#d9a441]" />
              </div>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="mb-2 block text-xs font-semibold uppercase text-[#7f8ca3]">Email</label>
                <input
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="admin@gmail.com"
                  className="h-12 w-full rounded-md border border-white/10 bg-[#0b0f16] px-3 text-sm text-white outline-none transition placeholder:text-[#566176] focus:border-[#d9a441]/70"
                />
              </div>
              <div>
                <label className="mb-2 block text-xs font-semibold uppercase text-[#7f8ca3]">Password</label>
                <input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Welcome@2026"
                  type="password"
                  className="h-12 w-full rounded-md border border-white/10 bg-[#0b0f16] px-3 text-sm text-white outline-none transition placeholder:text-[#566176] focus:border-[#d9a441]/70"
                />
              </div>
              {loginError ? <div className="rounded-md bg-[#e5484d]/10 px-3 py-2 text-sm text-[#ff9da2]">{loginError}</div> : null}
              <button className="flex h-12 w-full items-center justify-center gap-2 rounded-md bg-[#d9a441] font-semibold text-[#151109] transition hover:bg-[#edbf5e]">
                Enter workspace
                <Zap className="size-4" />
              </button>
            </form>

            <div className="mt-5 grid grid-cols-2 gap-3 text-xs text-[#93a1b6]">
              <StatusItem icon={Clock3} label="Daily deploy ready" />
              <StatusItem icon={Bot} label="LLM module planned" />
              <StatusItem icon={IndianRupee} label="India enabled" />
              <StatusItem icon={CircleDollarSign} label="US enabled" />
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone: "gold" | "blue" | "green";
}) {
  const tones = {
    gold: "text-[#f2c873] bg-[#d9a441]/10 border-[#d9a441]/20",
    blue: "text-[#64d2ff] bg-[#64d2ff]/10 border-[#64d2ff]/20",
    green: "text-[#62d894] bg-[#2fbf71]/10 border-[#2fbf71]/20",
  };

  return (
    <div className="rounded-md border border-white/10 bg-[#101620] p-4">
      <div className={classNames("mb-4 grid size-9 place-items-center rounded-md border", tones[tone])}>
        <Icon className="size-4" />
      </div>
      <div className="text-xs font-semibold uppercase text-[#7f8ca3]">{label}</div>
      <div className="mt-1 text-sm font-semibold text-white">{value}</div>
    </div>
  );
}

function StatusItem({ icon: Icon, label }: { icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-white/10 bg-[#0b0f16] px-3 py-2">
      <Icon className="size-4 text-[#d9a441]" />
      {label}
    </div>
  );
}

function MonitoringPanel() {
  return (
    <section className="grid gap-4 xl:grid-cols-4">
      <Kpi label="Open positions" value="7" trend="+2 today" tone="blue" />
      <Kpi label="Realized P&L" value="+$4,260" trend="US session" tone="green" />
      <Kpi label="Risk used" value="2.8%" trend="6.0% limit" tone="gold" />
      <Kpi label="Rejected setups" value="14" trend="validator gate" tone="red" />
      <div className="rounded-md border border-white/10 bg-[#101620] xl:col-span-3">
        <PanelHeader icon={TrendingUp} title="Position Monitor" action="Auto refresh" />
        <div className="grid gap-3 p-4 md:grid-cols-3">
          {["HTF bias synced", "Broker ledger matched", "Discord alert queued", "Stop checks active", "India cron online", "US monitor online"].map(
            (item) => (
              <div key={item} className="flex items-center gap-3 rounded-md border border-white/10 bg-[#0b0f16] p-3 text-sm text-[#d6deec]">
                <span className="size-2 rounded-full bg-[#2fbf71]" />
                {item}
              </div>
            ),
          )}
        </div>
      </div>
      <div className="rounded-md border border-white/10 bg-[#101620]">
        <PanelHeader icon={Search} title="Anomaly Queue" action="LLM" />
        <div className="space-y-3 p-4 text-sm text-[#a9b5c9]">
          <div className="rounded-md bg-[#e5484d]/10 p-3 text-[#ff9da2]">TSLA S07 drawdown exceeds policy.</div>
          <div className="rounded-md bg-[#d9a441]/10 p-3 text-[#f2c873]">India order awaiting broker confirmation.</div>
          <div className="rounded-md bg-[#64d2ff]/10 p-3 text-[#8edfff]">New HTF cache refresh scheduled.</div>
        </div>
      </div>
    </section>
  );
}

function DeploymentsPanel() {
  return (
    <section className="grid gap-4 lg:grid-cols-3">
      {[
        ["US Production", "S16-only route", "Ready"],
        ["India Production", "S15/S16 policy", "Staged"],
        ["Forex Sandbox", "Research mode", "Draft"],
      ].map(([name, policy, state]) => (
        <div key={name} className="rounded-md border border-white/10 bg-[#101620] p-4">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-semibold">{name}</h3>
            <Badge tone={state === "Ready" ? "green" : state === "Staged" ? "gold" : "blue"}>{state}</Badge>
          </div>
          <div className="mb-5 text-sm text-[#93a1b6]">{policy}</div>
          <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-[#d9a441] text-sm font-semibold text-[#151109]">
            <Play className="size-4" />
            Deploy strategy
          </button>
        </div>
      ))}
    </section>
  );
}

function PanelHeader({
  icon: Icon,
  title,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  action: string;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
      <Icon className="size-4 text-[#d9a441]" />
      <h2 className="font-semibold">{title}</h2>
      <span className="ml-auto rounded-md border border-white/10 px-2 py-1 font-mono text-[11px] text-[#93a1b6]">{action}</span>
    </div>
  );
}

function Kpi({ label, value, trend, tone }: { label: string; value: string; trend: string; tone: "blue" | "green" | "gold" | "red" }) {
  const tones = {
    blue: "text-[#64d2ff]",
    green: "text-[#62d894]",
    gold: "text-[#f2c873]",
    red: "text-[#ff8b91]",
  };

  return (
    <div className="rounded-md border border-white/10 bg-[#101620] p-4">
      <div className="text-[11px] font-semibold uppercase text-[#7f8ca3]">{label}</div>
      <div className={classNames("mt-3 font-mono text-3xl font-semibold", tones[tone])}>{value}</div>
      <div className="mt-2 font-mono text-xs text-[#93a1b6]">{trend}</div>
    </div>
  );
}

function Badge({ tone, children }: { tone: "green" | "red" | "gold" | "blue"; children: React.ReactNode }) {
  const tones = {
    green: "bg-[#2fbf71]/10 text-[#62d894] border-[#2fbf71]/30",
    red: "bg-[#e5484d]/10 text-[#ff8b91] border-[#e5484d]/30",
    gold: "bg-[#d9a441]/10 text-[#f2c873] border-[#d9a441]/30",
    blue: "bg-[#64d2ff]/10 text-[#8edfff] border-[#64d2ff]/30",
  };

  return <span className={classNames("rounded-md border px-2 py-1 text-[11px] font-semibold", tones[tone])}>{children}</span>;
}
