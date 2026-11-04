import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_TABS = new Set([
  "realtime-orders",
  "strategy-builder",
  "options-lab",
  "tradezella",
  "stonk",
  "backtest",
  "ml",
  "live-orders",
  "monitoring",
  "blogs",
  "deployments",
]);

type AssistantIdentity = {
  user_id: string;
  role: "external" | "internal" | "support";
  profile: {
    account_size?: number;
    risk_tolerance?: "low" | "medium" | "high";
    preferred_markets: string[];
    watchlist: string[];
    max_risk_pct?: number;
  };
};

function envNumber(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Production integration seam: replace this development-only resolver with the
 * platform session/JWT lookup. Client-provided roles and profiles are ignored.
 */
function resolveIdentity(): AssistantIdentity | null {
  const devEnabled = process.env.NODE_ENV !== "production" && process.env.TITANIA_DEV_AUTH_ENABLED !== "false";
  if (!devEnabled) return null;
  const risk = process.env.TITANIA_DEV_RISK_TOLERANCE;
  return {
    user_id: process.env.TITANIA_DEV_USER_ID || "local-development-user",
    role: (process.env.TITANIA_DEV_ROLE as AssistantIdentity["role"]) || "internal",
    profile: {
      account_size: envNumber("TITANIA_DEV_ACCOUNT_SIZE"),
      risk_tolerance: risk === "low" || risk === "medium" || risk === "high" ? risk : undefined,
      preferred_markets: (process.env.TITANIA_DEV_PREFERRED_MARKETS || "").split(",").filter(Boolean),
      watchlist: (process.env.TITANIA_DEV_WATCHLIST || "").split(",").filter(Boolean),
      max_risk_pct: envNumber("TITANIA_DEV_MAX_RISK_PCT"),
    },
  };
}

export async function POST(request: NextRequest) {
  const identity = resolveIdentity();
  if (!identity) {
    return Response.json({ detail: "Assistant authentication is not configured." }, { status: 503 });
  }
  let incoming: Record<string, unknown>;
  try {
    incoming = await request.json();
  } catch {
    return Response.json({ detail: "Invalid assistant request." }, { status: 400 });
  }
  const message = typeof incoming.message === "string" ? incoming.message.trim() : "";
  if (!message || message.length > 4000) {
    return Response.json({ detail: "Invalid assistant message." }, { status: 400 });
  }
  const clientContext = (incoming.context || {}) as Record<string, unknown>;
  const currentTab = typeof clientContext.current_tab === "string" && ALLOWED_TABS.has(clientContext.current_tab)
    ? clientContext.current_tab
    : undefined;
  const body = JSON.stringify({
    message,
    mode: incoming.mode === "strict" ? "strict" : "standard",
    stream: incoming.stream !== false,
    history: Array.isArray(incoming.history) ? incoming.history.slice(-20) : [],
    session_id: typeof incoming.session_id === "string" ? incoming.session_id.slice(0, 128) : undefined,
    session_language: typeof incoming.session_language === "string" ? incoming.session_language.slice(0, 8) : undefined,
    context: { ...identity, current_tab: currentTab },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = process.env.TITANIA_ASSISTANT_SHARED_SECRET || "";
  const headers = new Headers({ "Content-Type": "application/json" });
  if (secret) {
    headers.set("x-titania-timestamp", timestamp);
    headers.set("x-titania-signature", createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex"));
  }
  const baseUrl = process.env.TITANIA_ASSISTANT_URL || "http://127.0.0.1:8100";
  try {
    const upstream = await fetch(`${baseUrl}/assistant/v1/chat`, {
      method: "POST", headers, body, cache: "no-store", signal: request.signal,
    });
    const responseHeaders = new Headers();
    responseHeaders.set("Cache-Control", "no-store");
    responseHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return Response.json({ detail: "Assistant backend is unavailable." }, { status: 503 });
  }
}
