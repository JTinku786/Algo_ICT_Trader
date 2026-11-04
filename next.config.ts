import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Chromium resolves its compressed binaries relative to its package folder;
  // keep it external so Vercel preserves that directory layout.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  outputFileTracingIncludes: {
    "/api/slack/s03-chart": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
  // Chart candle data: let Vercel's edge cache serve repeat views instantly
  // (fresh for 60s, then served stale while it refreshes in the background).
  async headers() {
    const cache = [{ key: "Cache-Control", value: "public, s-maxage=60, stale-while-revalidate=600" }];
    return [
      "/api/realtime-analytics/order-chart",
      "/api/backtest/order-chart",
      "/api/reversal/daily-forward",
      "/api/backtest/daily-forward",
      "/api/daily-bias/replay",
    ].map((source) => ({ source, headers: cache }));
  },
};

export default nextConfig;
