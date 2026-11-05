// Screenshots of the Agent Desk tab for the README (live view + mid-replay).
import puppeteer from "puppeteer-core";
import path from "node:path";
import fs from "node:fs";

const BASE = process.env.SHOT_BASE || "http://localhost:3000";
const OUT = "C:/Users/saite/OneDrive/Documents/Algo_ICT_Trader/docs/images/tabs";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  defaultViewport: { width: 1440, height: 1700 },
  args: ["--hide-scrollbars"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
try {
  await page.goto(`${BASE}/?tab=agent-desk`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => document.body.innerText.includes("Agent Desk") && !document.body.innerText.includes("booting six agents"), { timeout: 120000 });
  await sleep(3000);
  const desk = await page.$("main .flex-1.overflow-auto > div") ;
  await (desk ?? page).screenshot({ path: path.join(OUT, "agent-desk.png") });
  console.log("saved agent-desk");
  // Replay: start, let it run a bit, pause, capture.
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.innerText.includes("replay the window"))?.click());
  // Let the replay run part-way, then capture it mid-flight (no other clicks).
  await sleep(25000);
  const desk2 = await page.$("main .flex-1.overflow-auto > div");
  await (desk2 ?? page).screenshot({ path: path.join(OUT, "agent-desk-replay.png") });
  console.log("saved agent-desk-replay");
} catch (e) {
  console.log("ERROR", e.message);
} finally {
  console.log("page errors:", JSON.stringify(errors.slice(0, 5)));
  await browser.close();
}
