// Re-captures the ICT screenshots that need a Run click or a long load.
import puppeteer from "puppeteer-core";
import path from "node:path";

const OUT = "C:/Users/saite/OneDrive/Documents/Algo_ICT_Trader/docs/images";
const BASE = "https://algo-ict-trader.vercel.app";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function gone(page, text, timeout) {
  try {
    await page.waitForFunction((t) => !document.body.innerText.includes(t), { timeout }, text);
    return true;
  } catch { log("still showing", text); return false; }
}
async function has(page, text, timeout) {
  try {
    await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
    return true;
  } catch { log("never showed", text); return false; }
}
async function clickButton(page, starts) {
  return page.evaluate((s) => {
    const b = [...document.querySelectorAll("button")].find((e) => e.offsetParent && e.innerText.trim().startsWith(s));
    if (!b) return false;
    b.scrollIntoView({ block: "center" });
    b.click();
    return true;
  }, starts);
}
const shot = async (page, name) => { await page.screenshot({ path: path.join(OUT, `${name}.png`) }); log("saved", name); };

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
  args: ["--hide-scrollbars"],
});
const page = await browser.newPage();
try {
  // Execution chart: open a row and wait until both charts finish loading.
  await page.goto(`${BASE}/?tab=realtime-orders`, { waitUntil: "networkidle2" });
  await sleep(1500);
  log("run", await clickButton(page, "Run"));
  await has(page, "Realtime ICT Signal", 150000);
  await sleep(3000);
  log("row", await page.evaluate(() => {
    const h = [...document.querySelectorAll("h2")].find((e) => e.innerText.includes("Realtime ICT Signal"));
    let n = h; for (let i = 0; i < 6 && n && !n.querySelector("tbody tr"); i++) n = n.parentElement;
    const row = n?.querySelector("tbody tr");
    row?.click();
    return Boolean(row);
  }));
  await has(page, "ICT Execution Chart", 30000);
  await gone(page, "Loading candles", 90000);
  await gone(page, "Loading daily candles", 60000);
  await sleep(4000);
  await page.evaluate(() => {
    const h = [...document.querySelectorAll("h2")].find((e) => e.innerText.startsWith("ICT Execution Chart"));
    h?.scrollIntoView({ block: "start" });
  });
  await sleep(1500);
  await shot(page, "05-execution-chart");

  // Backtest: press Run, wait for metrics.
  await page.goto(`${BASE}/?tab=backtest`, { waitUntil: "networkidle2" });
  await sleep(3000);
  log("backtest run", await clickButton(page, "Run"));
  await gone(page, "Run a backtest to populate metrics", 120000);
  await sleep(6000);
  await page.evaluate(() => window.scrollTo(0, 520));
  await sleep(1500);
  await shot(page, "06-backtest");

  // Reversal: wait for the initial load.
  await page.goto(`${BASE}/?tab=reversal`, { waitUntil: "networkidle2" });
  await sleep(2000);
  await gone(page, "Loading realtime signals and orders", 150000);
  await sleep(4000);
  await page.evaluate(() => window.scrollTo(0, 560));
  await sleep(1500);
  await shot(page, "07-reversal");
} catch (e) {
  log("ERROR", e.message);
} finally {
  await browser.close();
}
