"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { mssDeepLink, type MssLinkTrade } from "@/lib/mss-deep-link";

/** "Open in MSS tab" strip shared by the Backtest and Realtime trade charts. */
export function MssLinkBar({ trade, note, label }: { trade: MssLinkTrade; note?: string; /** display name when the stored symbol is encoded */ label?: string }) {
  const [copied, setCopied] = useState(false);
  const link = mssDeepLink(trade);
  if (!link) return null;
  return (
    <div data-testid="mss-link-bar" className="flex flex-wrap items-center gap-2 rounded-md border border-[#d9a441]/30 bg-[#d9a441]/5 px-3 py-2 text-xs">
      <span className="font-semibold text-[#f2c873]">MSS · {link.tf1.toUpperCase()} → {link.tf2}</span>
      <span className="text-[#93a1b6]">{label ?? trade.symbol} · entry {link.day} · {link.side}{note ? ` · ${note}` : ""}</span>
      <a href={link.href} className="rounded bg-[#d9a441] px-3 py-1 font-semibold text-black hover:bg-[#f2c873]">Open in MSS tab</a>
      <a href={link.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded border border-white/15 px-3 py-1 text-[#d6deec] hover:bg-white/5">New window<ExternalLink className="size-3" /></a>
      <button
        type="button"
        className="rounded border border-white/15 px-3 py-1 text-[#d6deec] hover:bg-white/5"
        onClick={() => { void navigator.clipboard?.writeText(window.location.origin + link.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}
