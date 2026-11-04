"use client";

import { useEffect, useState } from "react";
import { schwabRegistration } from "@/lib/schwab-registration";

export default function AccountManagementSchwab() {
  const [status, setStatus] = useState<{credentialsConfigured: boolean; callbackMatchesRegistration: boolean} | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/account-management/schwab", {cache: "no-store", signal: controller.signal})
      .then(async response => {
        if (!response.ok) throw new Error("Could not check local Schwab configuration.");
        return response.json();
      })
      .then(setStatus)
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Configuration check failed."); });
    return () => controller.abort();
  }, []);
  return <section aria-label="Charles Schwab connection" className="space-y-3 rounded-lg border border-white/10 bg-[#0d1118] p-4 text-sm text-[#93a1b6]">
    <h2 className="text-lg font-semibold text-white">Charles Schwab · {schwabRegistration.name}</h2>
    <p>App registration: <span className="text-emerald-300">{schwabRegistration.portalStatus}</span> · {schwabRegistration.environment} · portal record {schwabRegistration.portalCreatedDate}</p>
    <p>{schwabRegistration.products.join(" · ")}</p>
    <p>Private credentials: {status ? status.credentialsConfigured ? "Configured on this server" : "Missing on this server" : error || "Checking…"}</p>
    <p>Registered callback: <code>{schwabRegistration.callbackUrl}</code>{status && !status.callbackMatchesRegistration ? " · local callback configuration missing or different" : ""}</p>
    <p>Order limit: {schwabRegistration.orderLimitPerMinute} requests/minute. Trading disabled in this integration.</p>
    <p className="text-amber-200">OAuth not connected. Account balances, positions, history and market data have not been fetched or verified.</p>
    <p>Next: implement the OAuth return flow for the registered callback, authorize the brokerage account and verify a read-only API request.</p>
  </section>;
}
