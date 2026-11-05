"use client";

// Agent Desk — the live trading system as six agents with hard handoffs
// (Scout → Filter → Analyst → Executor → Risk → Logger). Every event is a real row from
// the realtime tables (see /api/agent-desk). Replay steps through the window event by event.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, FileText, Filter, Pause, Play, Search, ShieldCheck, SkipForward, Zap, Radio, RotateCcw } from "lucide-react";

type Stage = "scout" | "filter" | "analyst" | "executor" | "risk" | "logger";
type Kind = "SIGNAL" | "PASS" | "KILL" | "SCORE" | "ARM" | "ENTER" | "CANCEL" | "BLOCK" | "WIN" | "LOSS" | "EXIT" | "ALERT";
type DeskEvent = {
  ts: string; stage: Stage; kind: Kind; lane: string; ticker: string; side?: string | null; text: string;
  r?: number | null; score?: number | null; rule?: string | null; live?: boolean;
  rules?: { key: string; label: string; pass: boolean }[];
  signals?: { label: string; value: string }[];
};
type Focus = {
  lane: string; strategy: string; ticker: string; side: string; state: string; entry: number | null; stop: number | null;
  target: number | null; entryAt: string | null; closeAt: string | null; r: number | null; planned_rr: number | null; mode: string;
  candles: { t: number | null; c: number | null; h: number | null; l: number | null }[];
};
type Desk = {
  generated_at: string; window: { from: string; to: string; hours: number };
  lanes: Record<string, { name: string; market: string; mode: string }>;
  runtime: { alive: number; total: number };
  scans: { lane: string; n: number | null; last: string | null }[];
  events: DeskEvent[]; focus: Focus | null;
};

const KIND_COLOR: Record<Kind, string> = {
  SIGNAL: "text-cyan-300", PASS: "text-emerald-300", KILL: "text-rose-400", SCORE: "text-violet-300", ARM: "text-amber-300",
  ENTER: "text-teal-300", CANCEL: "text-orange-300", BLOCK: "text-orange-400", WIN: "text-emerald-300", LOSS: "text-rose-400",
  EXIT: "text-slate-300", ALERT: "text-sky-300",
};
const STAGES: { id: Stage; label: string; color: string; ring: string; Icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "scout", label: "SCOUT", color: "text-teal-300", ring: "ring-teal-400/60 bg-teal-400/10", Icon: Search },
  { id: "filter", label: "FILTER", color: "text-rose-400", ring: "ring-rose-400/60 bg-rose-500/15", Icon: Filter },
  { id: "analyst", label: "ANALYST", color: "text-violet-300", ring: "ring-violet-400/60 bg-violet-500/15", Icon: BarChart3 },
  { id: "executor", label: "EXECUTOR", color: "text-emerald-300", ring: "ring-emerald-400/60 bg-emerald-500/10", Icon: Zap },
  { id: "risk", label: "RISK", color: "text-amber-300", ring: "ring-amber-400/60 bg-amber-500/15", Icon: ShieldCheck },
  { id: "logger", label: "LOGGER", color: "text-sky-300", ring: "ring-sky-400/60 bg-sky-500/15", Icon: FileText },
];

const etTime = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
const etDateTime = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const ago = (iso: string, now: number) => {
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const sR = (r: number) => `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`;
// Equities to 2 dp, FX to 5 (3 for JPY-size prices).
const px = (v: number | null) => (v === null ? "—" : Math.abs(v) >= 1000 || Math.abs(v) >= 20 ? v.toFixed(2) : Math.abs(v) >= 2 ? v.toFixed(3) : v.toFixed(5));
const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

function Panel({ title, right, children, className }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-xl border border-indigo-300/15 bg-[#0d1124]/90 p-4", className)}>
      <div className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-slate-300">
        <span>{title}</span>
        <span className="ml-auto normal-case tracking-normal">{right}</span>
      </div>
      {children}
    </section>
  );
}

export default function AgentDesk() {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<Desk | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"live" | "replay">("live");
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(350);
  const [now, setNow] = useState(() => Date.now());
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/agent-desk?hours=${hours}`, { cache: "no-store" });
      const j = (await r.json()) as Desk;
      if (!r.ok) throw new Error((j as unknown as { error?: string }).error || "Agent desk unavailable");
      setData(j);
      setError("");
      if (modeRef.current === "live") setCursor(j.events.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Agent desk unavailable");
    }
  }, [hours]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (mode !== "live") return;
    const id = window.setInterval(() => { void load(); setNow(Date.now()); }, 30000);
    return () => window.clearInterval(id);
  }, [mode, load]);
  useEffect(() => {
    if (!playing || !data) return;
    const id = window.setInterval(() => {
      setCursor((c) => {
        if (c >= data.events.length) { setPlaying(false); return c; }
        return c + 1;
      });
    }, speed);
    return () => window.clearInterval(id);
  }, [playing, speed, data]);

  const events = useMemo(() => data?.events ?? [], [data]);
  const shown = useMemo(() => events.slice(0, cursor), [events, cursor]);
  const clockIso = shown.at(-1)?.ts ?? data?.window.from ?? new Date().toISOString();
  const clock = mode === "live" ? now : new Date(clockIso).getTime();

  const m = useMemo(() => {
    const count = (k: Kind) => shown.filter((e) => e.kind === k).length;
    const lastOf = (pred: (e: DeskEvent) => boolean) => { for (let i = shown.length - 1; i >= 0; i--) if (pred(shown[i])) return shown[i]; return undefined; };
    const results = shown.filter((e) => (e.kind === "WIN" || e.kind === "LOSS") && typeof e.r === "number");
    let cum = 0;
    const curve = results.map((e) => (cum += e.r as number));
    const killsByRule = new Map<string, number>();
    shown.filter((e) => e.kind === "KILL" && e.rule).forEach((e) => killsByRule.set(e.rule!, (killsByRule.get(e.rule!) ?? 0) + 1));
    const signals = count("SIGNAL"), kills = count("KILL");
    return {
      signals, kills, passes: count("PASS"), scores: count("SCORE"), arms: count("ARM"), enters: count("ENTER"),
      cancels: count("CANCEL"), blocks: count("BLOCK"), wins: count("WIN"), losses: count("LOSS"), alerts: count("ALERT"),
      net: cum, curve, killsByRule,
      worst: results.length ? Math.min(...results.map((e) => e.r as number)) : null,
      best: results.length ? Math.max(...results.map((e) => e.r as number)) : null,
      killPct: signals ? Math.round((kills / signals) * 100) : 0,
      last: Object.fromEntries(STAGES.map((s) => [s.id, lastOf((e) => e.stage === s.id)])) as Record<Stage, DeskEvent | undefined>,
      lastRules: lastOf((e) => Boolean(e.rules?.length)),
      lastScore: lastOf((e) => e.kind === "SCORE"),
      candidates: shown.filter((e) => e.kind === "SIGNAL").slice(-6).reverse(),
      current: shown.at(-1),
    };
  }, [shown]);

  if (error && !data) return <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-6 text-sm text-rose-200">{error}</div>;
  if (!data) return <div className="grid h-96 place-items-center rounded-xl border border-indigo-300/15 bg-[#0d1124] font-mono text-sm text-indigo-200">booting six agents…</div>;

  const verdictOf = (c: DeskEvent) => {
    const after = shown.find((e) => e.ts >= c.ts && e.ticker === c.ticker && e.lane === c.lane && (e.kind === "KILL" || e.kind === "PASS"));
    return after?.kind;
  };
  const scoutStat = data.scans.reduce((a, s) => a + (s.n ?? 0), 0);
  const stageCount: Record<Stage, string> = {
    scout: `${m.signals} seen`, filter: `${m.kills} killed`, analyst: `${m.scores} scored`,
    executor: `${m.enters} trades`, risk: `${m.cancels + m.blocks + m.losses} actions`, logger: `#${shown.length}`,
  };
  const running = data.runtime.alive > 0;

  return (
    <div className="space-y-4 rounded-2xl border border-indigo-300/15 bg-[radial-gradient(ellipse_at_top,_#1b1745_0%,_#090c1a_55%)] p-4 font-sans text-slate-200 md:p-5">
      {/* ---------- header ---------- */}
      <header className="flex flex-col gap-4 lg:flex-row lg:items-center">
        <div className="flex items-center gap-4">
          <div className="grid size-20 shrink-0 place-items-center rounded-full bg-[radial-gradient(circle_at_35%_30%,#e9d5ff,#a855f7_45%,#4c1d95)] shadow-[0_0_40px_rgba(168,85,247,0.45)]">
            {playing || mode === "live" ? <Pause className="size-9 fill-slate-900 text-slate-900" /> : <Play className="size-9 fill-slate-900 text-slate-900" />}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-mono text-3xl font-bold"><span className="text-sky-400">Titania</span> Agent Desk</h1>
              <span className="rounded bg-gradient-to-r from-violet-500/80 to-emerald-500/80 px-2 py-0.5 font-mono text-xs text-white">ict-desk v1</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-sm">
              <span className={cx("flex items-center gap-1.5", running ? "text-emerald-300" : "text-rose-300")}>
                <span className={cx("size-2 rounded-full", running ? "bg-emerald-400 animate-pulse" : "bg-rose-400")} />
                {mode === "live" ? (running ? "running" : "stalled") : "replay"} · {data.runtime.alive}/{data.runtime.total} jobs alive
              </span>
              {m.current ? (
                <span className="rounded border border-rose-300/40 px-2 py-0.5 text-xs uppercase text-rose-200">
                  {m.current.stage} · {m.current.kind.toLowerCase()} {m.current.ticker}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-slate-400">six agents · hard handoffs · every number from the live tables · no trade picked by hand</p>
          </div>
        </div>
        <div className="lg:ml-auto lg:text-right">
          <div className={cx("font-mono text-5xl font-bold", m.net >= 0 ? "text-white" : "text-rose-300")}>{sR(m.net)}</div>
          <div className="font-mono text-xs text-slate-400">net result · last {hours}h · R = risk units</div>
          <div className="mt-1 font-mono text-sm">{m.wins + m.losses} closed · <span className="text-emerald-300">{m.wins} W</span> · <span className="text-rose-300">{m.losses} L</span></div>
          <Spark values={m.curve} />
        </div>
      </header>

      {/* ---------- controls ---------- */}
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
        {[24, 72, 168].map((h) => (
          <button key={h} onClick={() => { setHours(h); setMode("live"); setPlaying(false); }}
            className={cx("rounded border px-2.5 py-1", hours === h ? "border-violet-300/60 bg-violet-500/20 text-violet-100" : "border-white/10 text-slate-400 hover:text-slate-200")}>
            {h === 24 ? "24h" : h === 72 ? "3 days" : "7 days"}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-white/10" />
        <button onClick={() => { setMode("live"); setPlaying(false); setCursor(events.length); void load(); }}
          className={cx("flex items-center gap-1 rounded border px-2.5 py-1", mode === "live" ? "border-emerald-300/60 bg-emerald-500/15 text-emerald-200" : "border-white/10 text-slate-400")}>
          <Radio className="size-3.5" /> live · 30s
        </button>
        <button onClick={() => { setMode("replay"); setCursor(0); setPlaying(true); }}
          className={cx("flex items-center gap-1 rounded border px-2.5 py-1", mode === "replay" ? "border-amber-300/60 bg-amber-500/15 text-amber-200" : "border-white/10 text-slate-400")}>
          <RotateCcw className="size-3.5" /> replay the window
        </button>
        {mode === "replay" ? (
          <>
            <button onClick={() => setPlaying((p) => !p)} className="rounded border border-white/10 px-2 py-1 text-slate-200">{playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}</button>
            <button onClick={() => setCursor((c) => Math.min(events.length, c + 1))} className="rounded border border-white/10 px-2 py-1 text-slate-200"><SkipForward className="size-3.5" /></button>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="rounded border border-white/10 bg-transparent px-2 py-1 text-slate-300">
              <option value={700}>slow</option><option value={350}>normal</option><option value={90}>fast</option>
            </select>
            <input type="range" min={0} max={events.length} value={cursor} onChange={(e) => { setPlaying(false); setCursor(Number(e.target.value)); }} className="w-48 accent-violet-400" />
            <span className="text-slate-400">{cursor}/{events.length} · {etDateTime(clockIso)} ET</span>
          </>
        ) : <span className="text-slate-500">updated {etTime(data.generated_at)} ET</span>}
      </div>

      <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        {/* ---------- agent cards ---------- */}
        <div className="space-y-3">
          <AgentCard stage="scout" name="SCOUT" role="finds ICT setups" badge="SCAN" desc="6 strategy lanes · US, India, FX · every 2–5 min"
            foot={`${scoutStat.toLocaleString()} scans · seen ${m.signals}${m.last.scout ? ` · new ${m.last.scout.ticker}` : ""}`} />
          <AgentCard stage="filter" name="FILTER" role="kills what fails the rules" badge="CHECK" desc="hard rules · one fail = killed"
            foot={`killed ${m.kills} · said no to ~${m.killPct}%`} />
          <AgentCard stage="analyst" name="ANALYST" role="scores what's left, 0–100" badge={m.last.analyst ? "SCORING" : "IDLE"} desc="ML probability (ICT, IGS01V2) · rules score (scalping)"
            foot={m.lastScore ? `last ${m.lastScore.ticker} ${m.lastScore.score ?? "—"}` : "no scores in window"} />
          <AgentCard stage="executor" name="EXECUTOR" role="places the trades" badge="LIVE" desc="paper options · OANDA FX · India brokers"
            foot={m.last.executor ? m.last.executor.text.slice(0, 44) : "waiting"} />
          <AgentCard stage="risk" name="RISK" role="guards every entry" badge="ARMED" desc="stop set before entry · 5m close beyond SL · live gate"
            foot={m.last.risk ? m.last.risk.text.slice(0, 44) : "no actions"} />
          <AgentCard stage="logger" name="LOGGER" role="writes everything down" badge="WRITE" desc="every kill and every trade · Discord alerts"
            foot={`line #${shown.length}${m.current ? ` · ${m.current.kind.toLowerCase()} ${m.current.ticker}` : ""}`} />
        </div>

        <div className="min-w-0 space-y-4">
          {/* ---------- live flow ---------- */}
          <Panel title="Live flow · hard handoffs · one job each" right={<span className="font-mono text-xs text-slate-400">{m.signals} candidates · {hours}h</span>}>
            <div className="flex gap-2 overflow-x-auto pb-2">
              {m.candidates.length ? m.candidates.map((c, i) => {
                const v = verdictOf(c);
                return (
                  <div key={`${c.ts}-${c.ticker}-${i}`} className={cx("min-w-[130px] rounded-lg border px-3 py-2", v === "KILL" ? "border-rose-400/30 opacity-60" : "border-white/10 bg-white/[0.03]")}>
                    <div className="flex items-center justify-between font-mono text-sm font-semibold text-white">${c.ticker}<span className={cx("size-1.5 rounded-full", v === "KILL" ? "bg-rose-400" : v === "PASS" ? "bg-emerald-400" : "bg-slate-500")} /></div>
                    <div className="font-mono text-[10px] text-slate-400">{c.lane} · {c.side} · {ago(c.ts, clock)}</div>
                  </div>
                );
              }) : <div className="font-mono text-xs text-slate-500">no candidates yet</div>}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-y-4 sm:grid-cols-6">
              {STAGES.map((s) => {
                const last = m.last[s.id];
                const active = m.current?.stage === s.id;
                return (
                  <div key={s.id} className="flex flex-col items-center text-center">
                    <div className="h-5 font-mono text-[10px] text-slate-300">{last ? <span className="rounded border border-white/15 px-1">${last.ticker}</span> : null}</div>
                    <div className={cx("mt-1 grid size-14 place-items-center rounded-full ring-2 transition", s.ring, active && "scale-110 shadow-[0_0_24px_rgba(167,139,250,0.6)]")}>
                      <s.Icon className={cx("size-6", s.color)} />
                    </div>
                    <div className={cx("mt-1 font-mono text-[10px] font-bold", s.color)}>{s.label}</div>
                    <div className="font-mono text-xs text-slate-400">{stageCount[s.id]}</div>
                  </div>
                );
              })}
            </div>
          </Panel>

          {/* ---------- filter + analyst ---------- */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title={`Filter · ${m.lastRules?.rules?.length ?? 0} hard rules`} right={m.lastRules ? <span className="rounded border border-rose-300/40 px-1.5 font-mono text-xs text-rose-200">${m.lastRules.ticker} · {m.lastRules.lane}</span> : null}>
              {m.lastRules?.rules?.length ? (
                <ul className="space-y-2">
                  {m.lastRules.rules.map((r) => (
                    <li key={r.key} className="flex items-center gap-2 text-sm">
                      <span className={cx("grid size-4 place-items-center rounded-full text-[10px]", r.pass ? "bg-emerald-500 text-slate-900" : "bg-rose-500/80 text-white")}>{r.pass ? "✓" : "✕"}</span>
                      <span className={r.pass ? "text-slate-200" : "text-rose-200"}>{r.label}</span>
                      <span className="ml-auto font-mono text-xs text-slate-500">×{m.killsByRule.get(r.label) ?? 0} killed</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-slate-500">No rule checks in this window yet.</p>}
              {[...m.killsByRule.entries()].filter(([k]) => !m.lastRules?.rules?.some((r) => r.label === k)).slice(0, 4).map(([k, n]) => (
                <div key={k} className="mt-2 flex text-xs text-slate-400"><span>{k}</span><span className="ml-auto font-mono">×{n}</span></div>
              ))}
              <div className="mt-3 rounded-lg border border-white/10 py-2 text-center font-mono text-xs text-slate-300">
                {m.last.filter ? m.last.filter.text : "waiting for a candidate"}
              </div>
            </Panel>

            <Panel title="Analyst · score 0–100" right={m.lastScore ? <span className="rounded border border-violet-300/40 px-1.5 font-mono text-xs text-violet-200">${m.lastScore.ticker} · {m.lastScore.lane}</span> : null}>
              <div className="flex gap-4">
                <div className="flex-1 space-y-2">
                  {(m.lastScore?.signals ?? []).map((s) => (
                    <div key={s.label}>
                      <div className="flex text-sm"><span className="text-slate-300">{s.label}</span><span className="ml-auto font-mono text-slate-200">{s.value}</span></div>
                      <div className="mt-1 h-1 rounded bg-white/5"><div className="h-1 rounded bg-violet-400/70" style={{ width: `${Math.min(100, Math.abs(parseFloat(s.value)) || 0)}%` }} /></div>
                    </div>
                  ))}
                  {!m.lastScore ? <p className="text-sm text-slate-500">No scored setups in this window yet.</p> : null}
                </div>
                <Gauge value={m.lastScore?.score ?? null} />
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-slate-500">ICT lanes: ML score is shown in shadow mode (it does not block trades). IGS01V2: the ML score is a real gate. Scalping: share of hard rules passed.</p>
            </Panel>
          </div>

          {/* ---------- executor + risk ---------- */}
          <Panel title="Executor + Risk · position" right={<span className="font-mono text-xs text-slate-500">{data.focus?.state === "OPEN" ? "open trade" : "latest trade"}</span>}>
            {data.focus ? <Position f={data.focus} /> : <p className="text-sm text-slate-500">No position in this window.</p>}
          </Panel>

          {/* ---------- stats + log ---------- */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Stats from the window" right={<span className="font-mono text-xs text-slate-500">{mode === "live" ? "live" : "replay"} ✓</span>}>
              <StatRow label="candidates scanned" value={m.signals} max={m.signals} color="bg-teal-400" />
              <StatRow label={`killed · ${m.killPct}%`} value={m.kills} max={m.signals} color="bg-rose-400" />
              <StatRow label="scored by analyst" value={m.scores} max={m.signals} color="bg-violet-400" />
              <StatRow label="limits armed" value={m.arms} max={m.signals} color="bg-amber-400" />
              <StatRow label="trades taken" value={m.enters} max={m.signals} color="bg-emerald-400" />
              <div className="mt-3 space-y-1.5 font-mono text-sm">
                <div className="flex"><span className="text-slate-400">wins / losses</span><span className="ml-auto">{m.wins} W / {m.losses} L</span></div>
                <div className="flex"><span className="text-slate-400">risk actions (cancels · blocks)</span><span className="ml-auto">{m.cancels} · {m.blocks}</span></div>
                <div className="flex"><span className="text-slate-400">worst trade</span><span className="ml-auto text-rose-300">{m.worst !== null ? sR(m.worst) : "—"}</span></div>
                <div className="flex"><span className="text-slate-400">best trade</span><span className="ml-auto text-emerald-300">{m.best !== null ? sR(m.best) : "—"}</span></div>
              </div>
              <p className="mt-3 text-[11px] text-slate-500">Mostly paper trading · past results are not typical · trading is high risk · not financial advice.</p>
            </Panel>

            <Panel title="$ tail -f desk.log" right={<span className="font-mono text-xs text-slate-500">line #{shown.length}</span>}>
              <div className="h-[300px] space-y-1 overflow-y-auto font-mono text-[11px] leading-5">
                {shown.slice(-40).reverse().map((e, i) => (
                  <div key={`${e.ts}-${i}`} className={cx("flex gap-2", i === 0 && "rounded bg-white/[0.04]")}>
                    <span className="shrink-0 text-slate-500">{etTime(e.ts)}</span>
                    <span className={cx("w-12 shrink-0 font-bold", KIND_COLOR[e.kind])}>{e.kind}</span>
                    <span className="shrink-0 text-slate-500">{e.lane}</span>
                    <span className="truncate text-slate-300">{e.text}{e.live ? " · LIVE" : ""}</span>
                  </div>
                ))}
                {!shown.length ? <div className="text-slate-500">no events yet</div> : null}
              </div>
            </Panel>
          </div>

          {/* ---------- lanes ---------- */}
          <div className="flex flex-wrap gap-2">
            {Object.entries(data.lanes).map(([id, l]) => {
              const n = shown.filter((e) => e.lane === id && e.kind === "SIGNAL").length;
              return (
                <div key={id} className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-1.5 font-mono text-[11px]">
                  <span className="font-bold text-violet-200">{id}</span> <span className="text-slate-300">{l.name}</span>
                  <span className="text-slate-500"> · {l.market} · {l.mode} · {n} seen</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );

  function AgentCard({ stage, name, role, badge, desc, foot }: { stage: Stage; name: string; role: string; badge: string; desc: string; foot: string }) {
    const s = STAGES.find((x) => x.id === stage)!;
    const active = m.current?.stage === stage;
    return (
      <div className={cx("rounded-xl border bg-[#0d1124]/90 p-3 transition", active ? "border-violet-300/50 shadow-[0_0_18px_rgba(139,92,246,0.25)]" : "border-indigo-300/15")}>
        <div className="flex items-start gap-2">
          <s.Icon className={cx("mt-0.5 size-5", s.color)} />
          <div className="min-w-0">
            <div className={cx("font-mono text-base font-bold", s.color)}>{name}</div>
            <div className="text-xs text-slate-300">{role}</div>
          </div>
          <span className={cx("ml-auto rounded border px-1.5 py-0.5 font-mono text-[10px]", s.color, "border-current/40")}>{badge}</span>
        </div>
        <div className={cx("mt-2 text-xs font-semibold", s.color)}>{desc}</div>
        <div className="mt-2 truncate font-mono text-[11px] text-slate-400">{foot}</div>
      </div>
    );
  }
}

function StatRow({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div className="mb-2 flex items-center gap-3 text-sm">
      <span className="w-40 shrink-0 text-slate-400">{label}</span>
      <div className="h-1.5 flex-1 rounded bg-white/5"><div className={cx("h-1.5 rounded", color)} style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%` }} /></div>
      <span className="w-12 text-right font-mono">{value}</span>
    </div>
  );
}

function Gauge({ value }: { value: number | null }) {
  const v = value ?? 0;
  const r = 38, c = 2 * Math.PI * r;
  const color = v >= 70 ? "#a78bfa" : v >= 50 ? "#fbbf24" : "#fb7185";
  return (
    <div className="flex w-32 shrink-0 flex-col items-center">
      <svg viewBox="0 0 100 100" className="size-28 -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" />
        <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} />
      </svg>
      <div className="-mt-[78px] mb-[38px] font-mono text-3xl font-bold" style={{ color }}>{value ?? "—"}</div>
      <div className="text-center font-mono text-[10px] leading-4 text-slate-500">70+ is strong<br />below 50 is weak</div>
    </div>
  );
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="mt-2 h-8 font-mono text-[10px] text-slate-600 lg:text-right">equity curve appears after 2 closed trades</div>;
  const w = 260, h = 36;
  const min = Math.min(0, ...values), max = Math.max(0, ...values), span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / span) * h}`).join(" ");
  const zero = h - ((0 - min) / span) * h;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-2 h-9 w-64 lg:ml-auto">
      <line x1="0" x2={w} y1={zero} y2={zero} stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
      <polyline points={pts} fill="none" stroke="#5eead4" strokeWidth="2" />
    </svg>
  );
}

function Position({ f }: { f: Focus }) {
  const pts = f.candles.filter((c) => c.t !== null && c.c !== null) as { t: number; c: number; h: number | null; l: number | null }[];
  const levels = [f.entry, f.stop, f.target].filter((x): x is number => x !== null);
  const prices = pts.map((p) => p.c).concat(levels);
  const lo = prices.length ? Math.min(...prices) : 0, hi = prices.length ? Math.max(...prices) : 1;
  const pad = (hi - lo) * 0.08 || 1;
  const W = 640, H = 220, y = (p: number) => H - ((p - (lo - pad)) / (hi - lo + 2 * pad)) * H;
  const t0 = pts[0]?.t ?? 0, t1 = pts.at(-1)?.t ?? 1, x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W;
  const line = pts.map((p) => `${x(p.t)},${y(p.c)}`).join(" ");
  const entryT = f.entryAt ? Date.parse(f.entryAt) / 1000 : null;
  const won = (f.r ?? 0) >= 0;
  const stopRule: Record<string, string> = {
    V4: "exit all at +2R or the target, whichever is nearer · stop on a 5m close beyond SL",
    BPR: "exit all at +2R or the target, whichever is nearer · stop on a 5m close beyond SL",
    IFVG: "hold to target · stop on a 5m close beyond SL",
    K1: "target on a wick touch · stop on a 5m close beyond SL",
    ICT: "target 1 on touch · stop on a completed 5m close beyond SL",
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px]">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-56 w-full">
        <defs><linearGradient id="adfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#5eead4" stopOpacity="0.25" /><stop offset="100%" stopColor="#5eead4" stopOpacity="0" /></linearGradient></defs>
        {pts.length > 1 ? <polygon points={`0,${H} ${line} ${W},${H}`} fill="url(#adfill)" /> : null}
        {pts.length > 1 ? <polyline points={line} fill="none" stroke="#5eead4" strokeWidth="2" /> : null}
        {f.target !== null ? <><line x1="0" x2={W} y1={y(f.target)} y2={y(f.target)} stroke="#34d399" strokeDasharray="4 4" /><text x={W - 4} y={y(f.target) - 4} textAnchor="end" fill="#34d399" fontSize="11" fontFamily="monospace">target {px(f.target)}</text></> : null}
        {f.entry !== null ? <><line x1="0" x2={W} y1={y(f.entry)} y2={y(f.entry)} stroke="#cbd5e1" strokeDasharray="2 4" /><text x={W - 4} y={y(f.entry) - 4} textAnchor="end" fill="#cbd5e1" fontSize="11" fontFamily="monospace">entry {px(f.entry)}</text></> : null}
        {f.stop !== null ? <><line x1="0" x2={W} y1={y(f.stop)} y2={y(f.stop)} stroke="#fb7185" strokeDasharray="4 4" /><text x={W - 4} y={y(f.stop) + 13} textAnchor="end" fill="#fb7185" fontSize="11" fontFamily="monospace">stop {px(f.stop)}</text></> : null}
        {entryT && pts.length > 1 ? <line x1={x(entryT)} x2={x(entryT)} y1="0" y2={H} stroke="rgba(167,139,250,0.4)" /> : null}
        {pts.length > 1 ? <circle cx={x(pts.at(-1)!.t)} cy={y(pts.at(-1)!.c)} r="5" fill="#5eead4" /> : null}
        {pts.length < 2 ? <text x={W / 2} y={H / 2} textAnchor="middle" fill="#64748b" fontSize="13">no 5m candles stored for this symbol</text> : null}
      </svg>
      <div>
        <div className="font-mono text-2xl font-bold text-white">${f.ticker}</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <span className="rounded border border-white/20 px-1.5 font-mono text-xs">{f.state}</span>
          <span className={cx("rounded px-1.5 font-mono text-xs", f.side === "SELL" ? "bg-rose-500/20 text-rose-200" : "bg-emerald-500/20 text-emerald-200")}>{f.side}</span>
        </div>
        <dl className="mt-3 space-y-1 font-mono text-sm">
          <div className="flex"><dt className="text-slate-400">strategy</dt><dd className="ml-auto truncate pl-2 text-right">{f.strategy}</dd></div>
          <div className="flex"><dt className="text-slate-400">entry</dt><dd className="ml-auto">{px(f.entry)}</dd></div>
          <div className="flex"><dt className="text-slate-400">stop</dt><dd className="ml-auto text-rose-300">{px(f.stop)}</dd></div>
          <div className="flex"><dt className="text-slate-400">target</dt><dd className="ml-auto text-emerald-300">{px(f.target)}</dd></div>
          {f.planned_rr !== null ? <div className="flex"><dt className="text-slate-400">planned R:R</dt><dd className="ml-auto">{f.planned_rr.toFixed(2)}</dd></div> : null}
          <div className="flex"><dt className="text-slate-400">mode</dt><dd className="ml-auto">{String(f.mode).toLowerCase().replace(/_/g, " ")}</dd></div>
        </dl>
        <div className={cx("mt-3 font-mono text-3xl font-bold", won ? "text-emerald-300" : "text-rose-300")}>{f.r !== null ? sR(f.r) : "—"}</div>
        <p className="mt-2 text-[11px] text-slate-500">{stopRule[f.lane] ?? stopRule.ICT}</p>
      </div>
    </div>
  );
}
