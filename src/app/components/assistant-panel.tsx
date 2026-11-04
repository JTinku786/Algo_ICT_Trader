"use client";

import { Bot, ChevronDown, ChevronRight, Loader2, Plus, Send, Square, X } from "lucide-react";
import Image from "next/image";
import { FormEvent, useEffect, useRef, useState } from "react";

const ASSISTANT_URL = "/api/assistant/chat";
const CHAT_STORAGE_KEY = "titania-assistant-chats.v1";
const MAX_SAVED_CHATS = 12;
const MAX_SAVED_MESSAGES = 80;
const TAB_LABELS: Record<string, string> = {
  "realtime-orders": "Realtime Orders", "strategy-builder": "Strategy Builder", "options-lab": "Options Lab",
  tradezella: "Trade Journal", stonk: "Stonk Ledger", backtest: "Backtest", ml: "Machine Learning",
  blogs: "Strategy Blogs", monitoring: "Monitoring", "live-orders": "Live Orders", deployments: "Deployments",
};

type Source = { label: string; kind: string; detail?: string };
type Decision = {
  kind: "recommendation" | "no_trade";
  reasons?: string[];
  account_risk_pct?: number | null;
  quantity?: number | null;
  candidates?: Array<{
    symbol: string; direction: "BUY" | "SELL"; strategy_id?: string | null;
    entry: number; stop_loss: number; take_profit: number; risk_r: number; score: number;
  }>;
};

type Msg = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  disclaimer?: string | null;
  unsupported?: boolean;
  latencyMs?: number;
  lane?: string;
  decision?: Decision | null;
};

type ChatSession = {
  id: string;
  title: string;
  messages: Msg[];
  language: string;
  mode: "standard" | "strict";
  updatedAt: number;
};

function newChatSession(): ChatSession {
  return {
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    title: "New chat", messages: [], language: "en", mode: "standard", updatedAt: Date.now(),
  };
}

function readSavedChats(): ChatSession[] {
  if (typeof window === "undefined") return [];
  try {
    const value = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((chat): chat is ChatSession =>
      chat && typeof chat.id === "string" && Array.isArray(chat.messages)
    ) : [];
  } catch {
    return [];
  }
}

export default function AssistantPanel({ currentTab }: { currentTab: string }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedChats, setSavedChats] = useState<ChatSession[]>(() => {
    const saved = readSavedChats();
    return saved.length ? saved : [newChatSession()];
  });
  const [activeChatId, setActiveChatId] = useState("");
  const [showChatHistory, setShowChatHistory] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeChat = savedChats.find((chat) => chat.id === activeChatId) ?? savedChats[0]!;
  const { messages, language, mode } = activeChat;

  useEffect(() => {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(savedChats));
  }, [savedChats]);

  function updateActiveChat(update: Partial<ChatSession>) {
    setSavedChats((previous) => previous
      .map((chat) => {
        if (chat.id !== activeChat.id) return chat;
        const messages = (update.messages || chat.messages).slice(-MAX_SAVED_MESSAGES);
        const title = messages.find((message) => message.role === "user")?.content.slice(0, 42) || chat.title;
        return { ...chat, ...update, title, messages, updatedAt: Date.now() };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SAVED_CHATS));
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, open]);

  useEffect(() => {
    function handleTradePrefill(event: Event) {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message;
      if (!message) return;
      setInput(message);
      setOpen(true);
    }
    window.addEventListener("titania:prefill", handleTradePrefill);
    return () => window.removeEventListener("titania:prefill", handleTradePrefill);
  }, []);

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    // The server retains the full scoped session. Send only the bounded recent
    // client fallback to satisfy its context and payload limits.
    const history = messages.slice(-20).map((m) => ({ role: m.role, content: m.content }));
    updateActiveChat({ messages: [...messages, { role: "user", content: text }, { role: "assistant", content: "" }] });

    try {
      const resp = await fetch(ASSISTANT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          message: text,
          mode,
          stream: true,
          history,
          session_id: activeChat.id,
          session_language: language,
          context: { current_tab: currentTab },
        }),
      });
      if (!resp.ok || !resp.body) throw new Error(`assistant ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let acc = "";
      const patch = (fn: (m: Msg) => Msg) => setSavedChats((previous) => previous.map((chat) => {
        if (chat.id !== activeChat.id) return chat;
        const next = [...chat.messages];
        next[next.length - 1] = fn(next[next.length - 1]);
        return { ...chat, messages: next, updatedAt: Date.now() };
      }));

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(data);
          } catch {
            continue;
          }
          if (evt.type === "delta") {
            acc += evt.text as string;
            const snapshot = acc;
            patch((m) => ({ ...m, content: snapshot }));
          } else if (evt.type === "replace") {
            acc = evt.text as string;
            const snapshot = acc;
            patch((m) => ({ ...m, content: snapshot }));
          } else if (evt.type === "final") {
            const r = evt.response as {
              answer: string;
              sources?: Source[];
              disclaimer?: string | null;
              unsupported?: boolean;
              latency?: { total_ms?: number; lane?: string };
              language?: string;
              decision?: Decision | null;
            };
            if (r.language) updateActiveChat({ language: r.language });
            patch((m) => ({
              ...m,
              content: r.answer,
              sources: r.sources,
              disclaimer: r.disclaimer,
              unsupported: r.unsupported,
              latencyMs: r.latency?.total_ms,
              lane: r.latency?.lane,
              decision: r.decision,
            }));
          } else if (evt.type === "error") {
            patch((m) => ({ ...m, content: `Assistant error: ${evt.message}` }));
          }
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setSavedChats((previous) => previous.map((chat) => {
        if (chat.id !== activeChat.id) return chat;
        const next = [...chat.messages];
        next[next.length - 1] = {
          role: "assistant",
          content:
            "Assistant backend is not reachable. Start it with: uvicorn backend.titania_assistant.main:app --port 8100",
        };
        return { ...chat, messages: next, updatedAt: Date.now() };
      }));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  function startNewChat() {
    if (busy) return;
    const next = newChatSession();
    setActiveChatId(next.id);
    setSavedChats((previous) => [next, ...previous].slice(0, MAX_SAVED_CHATS));
    setShowChatHistory(false);
  }

  function openChat(chat: ChatSession) {
    if (busy) return;
    setActiveChatId(chat.id);
    setShowChatHistory(false);
    setOpen(true);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="mt-8 w-full rounded-md border border-white/10 bg-white/[0.03] p-3 text-left transition hover:border-[#64d2ff]/40 hover:bg-white/[0.06]"
      >
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-white">
          <Bot className="size-4 text-[#64d2ff]" />
          Titania Assistant
        </div>
        <p className="text-xs leading-5 text-[#93a1b6]">
          Trade recommendations, ICT concepts, and execution summaries. Click to chat.
        </p>
      </button>

      {open && (
        <div className="fixed bottom-4 right-4 z-50 flex h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-h-[760px] max-w-[1080px] flex-col overflow-hidden rounded-xl border border-white/15 bg-[#0d1118] shadow-2xl">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <Bot className="size-4 text-[#64d2ff]" /> Titania Assistant
              <span className="rounded border border-[#64d2ff]/20 bg-[#64d2ff]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#bfeaff]">
                {TAB_LABELS[currentTab] || "Workspace"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowChatHistory((visible) => !visible)}
                  className="flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[10px] text-[#93a1b6] hover:text-white"
                  aria-expanded={showChatHistory}
                  aria-label="Open saved chat history"
                >
                  Chats <ChevronDown className="size-3" />
                </button>
                {showChatHistory && (
                  <div className="absolute right-0 top-8 z-10 max-h-56 w-56 overflow-y-auto rounded-md border border-white/15 bg-[#111722] p-1 shadow-xl">
                    {savedChats.map((chat) => (
                      <button
                        key={chat.id}
                        type="button"
                        disabled={busy}
                        onClick={() => openChat(chat)}
                        className={`block w-full truncate rounded px-2 py-1.5 text-left text-[11px] ${chat.id === activeChat.id ? "bg-[#64d2ff]/15 text-[#bfeaff]" : "text-[#93a1b6] hover:bg-white/[0.06] hover:text-white"}`}
                        title={chat.title}
                      >
                        {chat.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={startNewChat}
                disabled={busy}
                className="flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[10px] text-[#93a1b6] hover:text-white disabled:opacity-50"
              >
                <Plus className="size-3" /> New chat
              </button>
              <div className="flex overflow-hidden rounded border border-white/15 text-[10px]">
                {(["standard", "strict"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => updateActiveChat({ mode: m })}
                    className={
                      mode === m
                        ? "bg-[#64d2ff]/20 px-2 py-1 font-semibold text-[#64d2ff]"
                        : "px-2 py-1 text-[#93a1b6] hover:text-white"
                    }
                  >
                    {m}
                  </button>
                ))}
              </div>
              <button onClick={() => setOpen(false)} className="text-[#93a1b6] hover:text-white">
                <X className="size-4" />
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
            {messages.length > 0 && (
              <div className="text-[10px] text-[#5a6578]">
                Saved on this browser · scroll up for earlier messages
              </div>
            )}
            {messages.length === 0 && (
              <p className="text-xs leading-5 text-[#93a1b6]">
                Ask about strategies (FVG, BOS, S03…), metrics, your current tab, or request a
                trade idea. Answers are source-backed; unsupported questions return “not available
                in current Titania sources.”
              </p>
            )}
            {messages.map((m, i) => (
              <MessageBubble key={i} msg={m} />
            ))}
          </div>

              <form onSubmit={send} className="flex items-center gap-2 border-t border-white/10 p-3">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Ask about ${currentTab}…`}
              className="h-10 flex-1 rounded-md border border-white/15 bg-[#080b10] px-3 text-sm text-white outline-none placeholder:text-[#5a6578] focus:border-[#64d2ff]/50"
            />
            <button
              type="submit"
              disabled={busy}
              className="grid size-10 place-items-center rounded-md bg-[#64d2ff]/20 text-[#64d2ff] transition hover:bg-[#64d2ff]/30 disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            </button>
            {busy && (
              <button
                type="button"
                onClick={cancel}
                className="grid size-10 place-items-center rounded-md border border-white/15 text-[#93a1b6] hover:text-white"
                aria-label="Stop assistant response"
              >
                <Square className="size-3" />
              </button>
            )}
              </form>
            </div>

            <aside className="hidden w-[300px] shrink-0 flex-col border-l border-white/10 bg-[#090d14] lg:flex">
              <div className="relative h-72 overflow-hidden border-b border-white/10">
                <Image
                  src="/assistant/titania-agent.png"
                  alt="Titania AI trading assistant"
                  fill
                  priority
                  className="object-cover object-top opacity-90"
                />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#090d14] to-transparent px-4 pb-4 pt-12">
                  <div className="flex items-center gap-2 text-sm font-semibold text-white">
                    <span className="size-2 rounded-full bg-emerald-400 shadow-[0_0_10px_#34d399]" />
                    Titania AI Agent
                  </div>
                  <p className="mt-1 text-xs text-[#b2bfd2]">Context-aware trading copilot</p>
                </div>
              </div>
              <div className="space-y-3 p-4 text-xs leading-5 text-[#93a1b6]">
                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                  <p className="font-semibold text-white">Current context</p>
                  <p className="mt-1 capitalize">{currentTab.replaceAll("-", " ")}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                  <p className="font-semibold text-white">Working style</p>
                  <p className="mt-1">{mode === "strict" ? "Strict institutional analysis" : "Concise educational support"}</p>
                </div>
                <p className="text-[11px] text-[#5a6578]">Your saved chats stay on this browser. Sources remain attached to each response.</p>
              </div>
            </aside>
          </div>
        </div>
      )}
    </>
  );
}

function MessageBubble({ msg }: { msg: Msg }) {
  const [showSources, setShowSources] = useState(false);
  if (msg.role === "user") {
    return (
      <div className="ml-8 rounded-md bg-[#d9a441]/15 px-3 py-2 text-sm text-[#f2c873]">
        {msg.content}
      </div>
    );
  }
  return (
    <div className="mr-4 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="whitespace-pre-wrap text-sm leading-6 text-[#e7ecf5]">
        {msg.content || "…"}
      </div>
      {msg.decision && <DecisionCard decision={msg.decision} />}
      {msg.sources && msg.sources.length > 0 && (
        <div className="mt-2 border-t border-white/10 pt-1">
          <button
            onClick={() => setShowSources((s) => !s)}
            className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[#93a1b6] hover:text-white"
          >
            {showSources ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            Sources ({msg.sources.length})
          </button>
          {showSources && (
            <ul className="mt-1 space-y-0.5">
              {msg.sources.map((s, i) => (
                <li key={i} className="text-[11px] text-[#93a1b6]">
                  • {s.label}
                  {s.detail ? ` — ${s.detail}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {(msg.latencyMs || msg.lane) && (
        <div className="mt-1 text-[10px] text-[#5a6578]">
          {msg.lane ? `${msg.lane} · ` : ""}
          {msg.latencyMs ? `${Math.round(msg.latencyMs)} ms` : ""}
        </div>
      )}
    </div>
  );
}

function DecisionCard({ decision }: { decision: Decision }) {
  if (decision.kind === "no_trade") {
    return (
      <div className="mt-2 rounded border border-amber-300/20 bg-amber-300/5 px-2 py-1.5 text-[11px] text-amber-100">
        No-trade decision: {(decision.reasons || []).map((reason) => reason.replaceAll("_", " ")).join(", ") || "no qualified setup"}.
      </div>
    );
  }
  const primary = decision.candidates?.[0];
  if (!primary) return null;
  return (
    <div className="mt-2 rounded border border-[#64d2ff]/25 bg-[#64d2ff]/5 p-2 text-[11px] text-[#dbeeff]">
      <div className="font-semibold text-[#64d2ff]">
        {primary.direction} {primary.symbol}{primary.strategy_id ? ` · ${primary.strategy_id}` : ""}
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
        <span>Entry {primary.entry}</span><span>SL {primary.stop_loss}</span>
        <span>TP {primary.take_profit}</span><span>{primary.risk_r}R</span>
        {decision.quantity ? <span>Qty {decision.quantity}</span> : <span>Size unavailable</span>}
        {decision.account_risk_pct ? <span>Risk {decision.account_risk_pct}%</span> : null}
      </div>
    </div>
  );
}
