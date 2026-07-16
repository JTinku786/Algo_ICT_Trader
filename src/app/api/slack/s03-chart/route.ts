import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function chromeExecutable() {
  return process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
}

export async function GET(request: NextRequest) {
  const signalHash = (request.nextUrl.searchParams.get("signal_hash") || "").trim();
  const ticker = (request.nextUrl.searchParams.get("ticker") || "S03").trim();
  if (!signalHash) {
    return Response.json({ success: false, error: "signal_hash is required" }, { status: 400 });
  }

  const captureUrl = new URL("/slack-chart", request.nextUrl.origin);
  captureUrl.searchParams.set("signal_hash", signalHash);
  captureUrl.searchParams.set("ticker", ticker);

  let browser: Awaited<ReturnType<(typeof import("puppeteer-core"))["default"]["launch"]>> | null = null;
  try {
    const puppeteer = (await import("puppeteer-core")).default;
    const onVercel = Boolean(process.env.VERCEL);
    const chromium = onVercel ? (await import("@sparticuz/chromium")).default : null;
    browser = await puppeteer.launch({
      executablePath: chromium ? await chromium.executablePath() : chromeExecutable(),
      args: chromium ? chromium.args : ["--no-first-run", "--no-default-browser-check"],
      headless: true,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 820, deviceScaleFactor: 1.5 });
    // The chart page fetches its order payload client-side. Waiting for
    // `networkidle0` can stall on framework/dev-server connections even after
    // the ICT chart is ready. The SVG is the actual readiness contract.
    await page.goto(captureUrl.toString(), { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForSelector('svg[aria-label="Interactive five minute ICT order chart"]', { timeout: 20000 });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const png = await page.screenshot({ type: "png", fullPage: false });
    const body = new Uint8Array(png).buffer as ArrayBuffer;
    return new Response(body, {
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": `inline; filename="S03-${ticker.replace(/[^A-Za-z0-9_.-]/g, "_")}.png"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chart capture failed";
    return Response.json({ success: false, error: message }, { status: 500 });
  } finally {
    await browser?.close();
  }
}
