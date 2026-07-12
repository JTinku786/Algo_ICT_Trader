"use client";

import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Clock3,
  Info,
  Layers3,
  Search,
  Sparkles,
  Tag,
} from "lucide-react";
import { useMemo, useState } from "react";
import { BLOG_CATEGORIES, STRATEGY_BLOGS, getBlogById, type BlogBlock, type StrategyBlog } from "../data/strategy-blogs";

function cx(...v: Array<string | false | null | undefined>) {
  return v.filter(Boolean).join(" ");
}

const CATEGORY_TONE: Record<StrategyBlog["category"], string> = {
  "Core Automation": "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  "A-Series · Futures": "border-cyan-400/30 bg-cyan-400/10 text-cyan-300",
  "ICT Concept Library": "border-violet-400/30 bg-violet-400/10 text-violet-300",
};

export default function Blogs({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string | null) => void }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"ALL" | StrategyBlog["category"]>("ALL");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return STRATEGY_BLOGS.filter((b) => {
      if (category !== "ALL" && b.category !== category) return false;
      if (!q) return true;
      return [b.title, b.subtitle, b.code, b.markets, ...b.tags].join(" ").toLowerCase().includes(q);
    });
  }, [query, category]);

  const selected = getBlogById(selectedId);
  if (selected) return <BlogReader blog={selected} onBack={() => onSelect(null)} onSelect={onSelect} />;

  return (
    <section className="mx-auto max-w-[1680px] space-y-4">
      <header className="rounded-xl border border-amber-300/20 bg-gradient-to-r from-[#1c1608] via-[#231a0b] to-[#2a1f0d] p-5 shadow-xl shadow-black/20">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center">
          <div>
            <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-amber-300"><BookOpen className="size-4" />Strategy library</div>
            <h1 className="text-2xl font-semibold text-white md:text-3xl">Strategy Blogs</h1>
            <p className="mt-1 max-w-3xl text-sm text-amber-100/60">Every ICT/SMC strategy in the system, documented. {STRATEGY_BLOGS.length} articles across core automation, futures A-series, and the ICT concept library. Any strategy code shown elsewhere in the app links straight to its article.</p>
          </div>
          <div className="flex flex-col gap-2 xl:ml-auto xl:items-end">
            <label className="flex h-10 w-full items-center gap-2 rounded-md border border-white/10 bg-black/30 px-3 text-sm text-white xl:w-72">
              <Search className="size-4 text-amber-300" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search strategies, concepts, tags…" className="w-full bg-transparent outline-none placeholder:text-[#7f8ca3]" />
            </label>
          </div>
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        {(["ALL", ...BLOG_CATEGORIES] as const).map((c) => (
          <button key={c} onClick={() => setCategory(c)} className={cx("rounded-md border px-3 py-1.5 text-xs font-semibold transition", category === c ? "border-amber-300/50 bg-amber-300/15 text-amber-200" : "border-white/10 text-[#93a1b6] hover:text-white")}>
            {c === "ALL" ? "All strategies" : c}
            <span className="ml-2 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-[#93a1b6]">{c === "ALL" ? STRATEGY_BLOGS.length : STRATEGY_BLOGS.filter((b) => b.category === c).length}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((b) => <BlogCard key={b.id} blog={b} onOpen={() => onSelect(b.id)} />)}
      </div>
      {filtered.length === 0 ? <div className="grid h-40 place-items-center rounded-xl border border-white/10 bg-[#101620] text-sm text-[#93a1b6]">No strategies match “{query}”.</div> : null}
    </section>
  );
}

function BlogCard({ blog, onOpen }: { blog: StrategyBlog; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="group flex h-full flex-col rounded-xl border border-white/10 bg-[#101620] p-4 text-left transition hover:border-amber-300/40 hover:bg-[#141a24]">
      <div className="flex items-center gap-2">
        {blog.code ? <span className="rounded-md border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 font-mono text-xs font-bold text-amber-200">{blog.code}</span> : <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[10px] text-[#93a1b6]">MODEL</span>}
        <span className={cx("rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide", CATEGORY_TONE[blog.category])}>{blog.category.replace(" · Futures", "").replace(" Library", "")}</span>
        <span className="ml-auto flex items-center gap-1 text-[10px] text-[#657187]"><Clock3 className="size-3" />{blog.readMins}m</span>
      </div>
      <h2 className="mt-3 font-semibold text-white group-hover:text-amber-100">{blog.title}</h2>
      <p className="mt-1.5 line-clamp-3 text-xs leading-5 text-[#93a1b6]">{blog.subtitle}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {blog.tags.slice(0, 4).map((t) => <span key={t} className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] text-[#8ea0ba]">{t}</span>)}
      </div>
      <div className="mt-3 flex items-center gap-1.5 border-t border-white/5 pt-2 text-[10px] text-[#657187]"><Layers3 className="size-3" /><span className="truncate">{blog.markets}</span></div>
    </button>
  );
}

function BlogReader({ blog, onBack, onSelect }: { blog: StrategyBlog; onBack: () => void; onSelect: (id: string | null) => void }) {
  const related = STRATEGY_BLOGS.filter((b) => b.id !== blog.id && b.category === blog.category).slice(0, 4);
  return (
    <section className="mx-auto max-w-[900px] space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-2 rounded-md border border-white/10 px-3 py-2 text-xs text-[#93a1b6] transition hover:text-white"><ArrowLeft className="size-4" />All strategies</button>

      <article className="overflow-hidden rounded-xl border border-white/10 bg-[#101620]">
        <div className="border-b border-white/10 bg-gradient-to-r from-[#141a24] to-[#101620] p-6">
          <div className="flex flex-wrap items-center gap-2">
            {blog.code ? <span className="rounded-md border border-amber-300/30 bg-amber-300/10 px-2.5 py-1 font-mono text-sm font-bold text-amber-200">{blog.code}</span> : null}
            <span className={cx("rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", CATEGORY_TONE[blog.category])}>{blog.category}</span>
            <span className="ml-auto flex items-center gap-1 text-[11px] text-[#657187]"><Clock3 className="size-3.5" />{blog.readMins} min read</span>
          </div>
          <h1 className="mt-3 text-2xl font-semibold text-white md:text-3xl">{blog.title}</h1>
          <p className="mt-2 text-sm leading-6 text-[#a9b5c9]">{blog.subtitle}</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Fact icon={Layers3} label="Markets" value={blog.markets} />
            <Fact icon={Clock3} label="Session" value={blog.session} />
            <Fact icon={Sparkles} label="Timeframes" value={blog.timeframes} />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {blog.tags.map((t) => <span key={t} className="inline-flex items-center gap-1 rounded bg-white/5 px-2 py-0.5 text-[10px] text-[#8ea0ba]"><Tag className="size-2.5" />{t}</span>)}
          </div>
        </div>

        <div className="space-y-4 p-6">
          {blog.blocks.map((block, i) => <Block key={i} block={block} />)}
        </div>

        <div className="border-t border-white/10 bg-black/20 px-6 py-3 text-[11px] text-[#657187]">
          Educational and research documentation only. Not financial advice. Validate every model with backtesting before any live use.
        </div>
      </article>

      {related.length ? (
        <div className="rounded-xl border border-white/10 bg-[#101620] p-4">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-[#7f8ca3]">More in {blog.category}</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {related.map((b) => (
              <button key={b.id} onClick={() => onSelect(b.id)} className="flex items-center gap-3 rounded-lg border border-white/10 bg-[#0b0f16] p-3 text-left transition hover:border-amber-300/40">
                {b.code ? <span className="rounded border border-amber-300/25 bg-amber-300/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-amber-200">{b.code}</span> : <BookOpen className="size-4 text-[#657187]" />}
                <span className="min-w-0"><span className="block truncate text-sm text-white">{b.title}</span><span className="block truncate text-[10px] text-[#657187]">{b.subtitle}</span></span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Fact({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-[#0b0f16] p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#7f8ca3]"><Icon className="size-3.5 text-amber-300/80" />{label}</div>
      <div className="mt-1 text-xs leading-5 text-[#d6deec]">{value}</div>
    </div>
  );
}

function Block({ block }: { block: BlogBlock }) {
  switch (block.t) {
    case "p":
      return <p className="text-sm leading-7 text-[#c4cee0]">{block.text}</p>;
    case "h":
      return <h3 className="pt-1 text-base font-semibold text-white">{block.text}</h3>;
    case "ul":
      return (
        <ul className="space-y-2">
          {block.items.map((it, i) => (
            <li key={i} className="flex gap-2.5 text-sm leading-6 text-[#c4cee0]"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-amber-300/70" />{it}</li>
          ))}
        </ul>
      );
    case "steps":
      return (
        <ol className="space-y-2">
          {block.items.map((it, i) => (
            <li key={i} className="flex gap-3 text-sm leading-6 text-[#c4cee0]">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-amber-300/15 font-mono text-[10px] font-bold text-amber-200">{i + 1}</span>
              {it}
            </li>
          ))}
        </ol>
      );
    case "kv":
      return (
        <div className="overflow-hidden rounded-lg border border-white/10">
          {block.rows.map(([k, v], i) => (
            <div key={i} className={cx("grid grid-cols-[130px_1fr] gap-3 p-3 text-sm", i % 2 ? "bg-black/20" : "bg-white/[0.02]")}>
              <div className="font-semibold text-amber-200/90">{k}</div>
              <div className="leading-6 text-[#c4cee0]">{v}</div>
            </div>
          ))}
        </div>
      );
    case "callout": {
      const tone = block.tone;
      const cfg = tone === "warn"
        ? { icon: AlertTriangle, cls: "border-rose-400/25 bg-rose-400/[0.07] text-rose-100/90", ic: "text-rose-300" }
        : tone === "key"
          ? { icon: Sparkles, cls: "border-amber-300/25 bg-amber-300/[0.07] text-amber-100/90", ic: "text-amber-300" }
          : { icon: Info, cls: "border-cyan-400/25 bg-cyan-400/[0.06] text-cyan-100/90", ic: "text-cyan-300" };
      const Icon = cfg.icon;
      return (
        <div className={cx("flex gap-3 rounded-lg border p-3.5 text-sm leading-6", cfg.cls)}>
          <Icon className={cx("mt-0.5 size-4 shrink-0", cfg.ic)} />
          <span>{block.text}</span>
        </div>
      );
    }
    default:
      return null;
  }
}
