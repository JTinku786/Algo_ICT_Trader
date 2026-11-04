"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { smtPeer } from "@/lib/smt-signal";

export type SmtLinkTrade = { symbol: string | null | undefined; market?: string | null; direction?: string | null; entryTs?: string | null };

/** /?tab=smt-divergence deep link: the trade's ticker vs its SMT peer, replay clock at the entry. */
export function smtDeepLink(trade: SmtLinkTrade): { href: string; peerLabel: string; inverse: boolean } | null {
  const at = trade.entryTs ? Date.parse(trade.entryTs) : Number.NaN;
  const pairing = smtPeer(trade.symbol, trade.market);
  if (!trade.symbol || !pairing || !Number.isFinite(at)) return null;
  const qs = new URLSearchParams({ tab: "smt-divergence", smt_a: trade.symbol, smt_b: pairing.peer, tf: "5m", at: new Date(at).toISOString() });
  if (pairing.inverse) qs.set("inverse", "1");
  return { href: `/?${qs.toString()}`, peerLabel: pairing.label, inverse: pairing.inverse };
}

/**
 * "Open in SMT tab" strip + the trade's weekly profile, shown next to the MSS link bar
 * on the Realtime and Backtest trade charts.
 */
export function SmtLinkBar({ trade, label, smtText, weeklyText }: { trade: SmtLinkTrade; label?: string; smtText?: string | null; weeklyText?: string | null }) {
  const [copied, setCopied] = useState(false);
  const link = smtDeepLink(trade);
  return (
    <div data-testid="smt-link-bar" className="flex flex-wrap items-center gap-2 rounded-md border border-pink-400/30 bg-pink-400/5 px-3 py-2 text-xs">
      {link ? <>
        <span className="font-semibold text-pink-200">SMT · 5m</span>
        <span className="text-[#93a1b6]">{label ?? trade.symbol} vs {link.peerLabel}{smtText ? ` · ${smtText}` : ""}</span>
        <a href={link.href} className="rounded bg-pink-400 px-3 py-1 font-semibold text-black hover:bg-pink-300">Open in SMT tab</a>
        <a href={link.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded border border-white/15 px-3 py-1 text-[#d6deec] hover:bg-white/5">New window<ExternalLink className="size-3" /></a>
        <button type="button" className="rounded border border-white/15 px-3 py-1 text-[#d6deec] hover:bg-white/5"
          onClick={() => { void navigator.clipboard?.writeText(window.location.origin + link.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
          {copied ? "Copied" : "Copy link"}
        </button>
      </> : <span className="text-[#93a1b6]">SMT · no peer for {label ?? trade.symbol ?? "this symbol"}</span>}
      {weeklyText ? <span className="ml-auto rounded border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 font-semibold text-sky-200" title="ICT weekly profile known at the signal">Weekly profile: {weeklyText}</span> : null}
    </div>
  );
}
