// Captures README screenshots of the live sites.
//   node scripts/docs-screenshots.mjs ict   -> docs/images/*.png in this repo
//   node scripts/docs-screenshots.mjs qt    -> quant-terminal/docs/images/*.png
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const which = process.argv[2] || "ict";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = which === "ict"
  ? "C:/Users/saite/OneDrive/Documents/Algo_ICT_Trader/docs/images"
  : "C:/Users/saite/Desktop/Trading view replica/quant-terminal/docs/images";
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function clickText(page, text, { exact = false, selector = "button, a, [role=tab], th, td, span, div" } = {}) {
  const ok = await page.evaluate(({ text, exact, selector }) => {
    const els = [...document.querySelectorAll(selector)].filter((e) => {
      const t = (e.innerText || e.textContent || "").trim();
      if (!t || e.offsetParent === null) return false;
      return exact ? t === text : t.startsWith(text);
    });
    // Prefer the deepest (most specific) match.
    els.sort((a, b) => (a.contains(b) ? 1 : b.contains(a) ? -1 : 0));
    const el = els[0];
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    el.click();
    return true;
  }, { text, exact, selector });
  log(ok ? "clicked" : "NOT FOUND", JSON.stringify(text));
  return ok;
}

async function waitText(page, text, timeout = 90000) {
  try {
    await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
    return true;
  } catch {
    log("timeout waiting for", JSON.stringify(text));
    return false;
  }
}

async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  log("saved", file);
}

async function shotElement(page, selectorOrHandle, name) {
  const el = typeof selectorOrHandle === "string" ? await page.$(selectorOrHandle) : selectorOrHandle;
  if (!el) { log("no element for", name); return; }
  await el.screenshot({ path: path.join(OUT, `${name}.png`) });
  log("saved element", name);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  args: ["--hide-scrollbars"],
});
const page = await browser.newPage();
page.setDefaultTimeout(90000);

try {
  if (which === "ict") {
    const BASE = "https://algo-ict-trader.vercel.app";

    // 1. Realtime Orders: filters -> Run -> decisions + feed.
    await page.goto(`${BASE}/?tab=realtime-orders`, { waitUntil: "networkidle2" });
    await sleep(2000);
    await shot(page, "01-realtime-filters");
    await clickText(page, "Run", { selector: "button" });
    await waitText(page, "Realtime ICT Signal", 150000);
    await sleep(4000);
    await shot(page, "02-realtime-decisions");
    // Scroll the feed into view.
    await page.evaluate(() => {
      const h = [...document.querySelectorAll("h2")].find((e) => e.innerText.includes("Realtime ICT Signal"));
      h?.scrollIntoView({ block: "start" });
    });
    await sleep(1500);
    await shot(page, "03-signal-order-feed");

    // 2. Click the first feed row -> explanation + charts.
    const rowClicked = await page.evaluate(() => {
      const h = [...document.querySelectorAll("h2")].find((e) => e.innerText.includes("Realtime ICT Signal"));
      const card = h?.closest("div.overflow-hidden") || h?.parentElement?.parentElement?.parentElement;
      const row = card?.querySelector("tbody tr");
      if (!row) return false;
      row.click();
      return true;
    });
    log("row clicked", rowClicked);
    await waitText(page, "Click me for a detailed explanation", 30000);
    await sleep(8000);
    await clickText(page, "Click me for a detailed explanation", { selector: "button" });
    await sleep(1500);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((e) => e.innerText.includes("Detailed trade explanation"));
      b?.scrollIntoView({ block: "start" });
    });
    await sleep(800);
    await shot(page, "04-trade-explanation");
    await page.evaluate(() => {
      const h = [...document.querySelectorAll("h2")].find((e) => e.innerText.startsWith("ICT Execution Chart"));
      h?.scrollIntoView({ block: "start" });
    });
    await sleep(4000);
    await shot(page, "05-execution-chart");

    // 3. Other tabs.
    for (const [tab, name, wait] of [
      ["backtest", "06-backtest", "Backtest"],
      ["reversal", "07-reversal", "Reversal"],
      ["daily-bias", "08-daily-bias", "Daily"],
      ["consolidation", "09-consolidation", "Consolidation"],
    ]) {
      await page.goto(`${BASE}/?tab=${tab}`, { waitUntil: "networkidle2" });
      await waitText(page, wait, 30000);
      await sleep(9000);
      await shot(page, name);
    }
  } else {
    const BASE = "https://quant-terminal-zeta.vercel.app";
    await page.goto(BASE, { waitUntil: "networkidle2" });
    await sleep(8000);
    await shot(page, "01-chart-indicators");

    // AAPL 5m from the Titania database.
    await page.keyboard.type("AAPL");
    await sleep(800);
    await page.keyboard.press("Enter");
    await sleep(5000);
    await clickText(page, "5m", { exact: true, selector: "button" });
    await sleep(6000);
    await shot(page, "02-aapl-5m-titania-db");

    for (const [label, name] of [
      ["Screener", "03-screener"],
      ["Heatmap", "04-heatmap"],
      ["Strategy tester", "05-strategy-tester"],
      ["Paper trading", "06-paper-trading"],
    ]) {
      await clickText(page, label, { exact: true, selector: "button, [role=tab], a, div, span" });
      await sleep(7000);
      await shot(page, name);
    }
  }
} catch (e) {
  log("ERROR", e.message);
} finally {
  await browser.close();
}
