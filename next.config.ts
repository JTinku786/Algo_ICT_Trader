import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Chromium resolves its compressed binaries relative to its package folder;
  // keep it external so Vercel preserves that directory layout.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  outputFileTracingIncludes: {
    "/api/slack/s03-chart": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
};

export default nextConfig;
