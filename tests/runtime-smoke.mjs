import { chromium } from "playwright-core";

const baseUrl = process.env.BIANDU_BASE_URL || "http://127.0.0.1:4173";
const browser = await chromium.launch({ headless: true, executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.goto(baseUrl, { waitUntil: "networkidle" });
for (const view of ["board", "kb", "graph", "dict", "settings"]) {
  await page.click(`[data-nav="${view}"]`);
  await page.waitForTimeout(700);
  console.log(view, (await page.locator("#mainContent").innerText()).slice(0, 180).replace(/\s+/g, " "));
  await page.screenshot({ path: `preview/runtime-${view}.png`, fullPage: true });
}
console.log("errors", errors);
await browser.close();
