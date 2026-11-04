// Captures every tab of the local site (http://localhost:3000) plus the Titania Assistant,
// for the README. Account Management is skipped on purpose (real broker balances).
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.SHOT_BASE || "http://localhost:3000";
const OUT = "C:/Users/saite/OneDrive/Documents/Algo_ICT_Trader/docs/images/tabs";
fs.mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
const TABS = [
  "smt-divergence", "fib-calculation", "scalping-labs", "market-structure-shift", "top-down",
  "swing-trading", "ict-core", "strategy-builder", "options-lab", "tradezella", "stonk",
  "reversal", "reversals-updated", "expansion", "amd", "ml", "blogs", "monitoring",
  "live-orders", "deployments",
].filter((t) => !only.length || only.includes(t));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const summary = {};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
  args: ["--hide-scrollbars"],
});
const page = await browser.newPage();

async function settle(timeout = 45000) {
  const end = Date.now() + timeout;
  await sleep(3000);
  while (Date.now() < end) {
    const busy = await page.evaluate(() => /Loading|Refreshing|Running…|Computing/i.test(document.querySelector("main")?.innerText || document.body.innerText));
    if (!busy) break;
    await sleep(1500);
  }
  await sleep(2500);
}

for (const tab of TABS) {
  try {
    await page.goto(`${BASE}/?tab=${tab}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await settle();
    await page.screenshot({ path: path.join(OUT, `${tab}.png`) });
    summary[tab] = await page.evaluate(() => {
      const main = document.querySelector(".flex-1.overflow-auto") || document.body;
      const heads = [...main.querySelectorAll("h1,h2,h3")].map((h) => h.innerText.trim()).filter(Boolean).slice(0, 8);
      const paras = [...main.querySelectorAll("p")].map((p) => p.innerText.trim()).filter((t) => t.length > 30).slice(0, 4);
      return { heads, paras };
    });
    log("saved", tab);
  } catch (e) {
    log("FAIL", tab, e.message);
  }
}

// Titania Assistant: open the panel and ask one question.
if (!only.length || only.includes("assistant")) {
  try {
    await page.goto(`${BASE}/?tab=backtest`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(5000);
    const opened = await page.evaluate(() => {
      const el = [...document.querySelectorAll("button, a, div")].filter((e) => e.offsetParent && /Titania Assistant/.test(e.innerText || ""))
        .sort((a, b) => (a.innerText || "").length - (b.innerText || "").length)[0];
      el?.click();
      return Boolean(el);
    });
    log("assistant opened", opened);
    await sleep(2500);
    await page.screenshot({ path: path.join(OUT, "assistant-open.png") });
    const typed = await page.evaluate(() => {
      const box = [...document.querySelectorAll("textarea, input:not([type]), input[type=text]")]
        .filter((e) => e.offsetParent && /Ask about/i.test(e.getAttribute("placeholder") || "")).pop();
      if (!box) return false;
      box.focus();
      return true;
    });
    log("input found", typed);
    if (typed) {
      await page.keyboard.type(process.env.ASK || "What is a fair value gap, and how does Titania use it in its strategies?");
      const doneCount = () => page.evaluate(() => (document.body.innerText.match(/^\d+ ms$/gm) || []).length);
      const before = await doneCount();
      await page.keyboard.press("Enter");
      // Each finished answer ends with its latency ("1234 ms"); wait for a new one (local model can be slow).
      for (let i = 0; i < 120 && (await doneCount()) <= before; i++) await sleep(2000);
      await sleep(1500);
      await page.screenshot({ path: path.join(OUT, "assistant-answer.png") });
      log("saved assistant-answer");
    }
  } catch (e) {
    log("FAIL assistant", e.message);
  }
}

fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
await browser.close();
log("done");
