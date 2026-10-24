import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const pdfPath = resolve(process.argv[2] || process.env.BIANDU_VISIBILITY_PDF || "");
if (!process.env.BIANDU_VISIBILITY_PDF && !process.argv[2]) {
  console.log("PDF visibility test skipped: pass a PDF path as the first argument.");
  process.exit(0);
}
assert.ok(existsSync(pdfPath), `PDF not found: ${pdfPath}`);

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
});

try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("http://127.0.0.1:4173", { waitUntil: "networkidle" });
  const chooserPromise = page.waitForEvent("filechooser");
  await page.click("#openImportPdfBtn");
  const chooser = await chooserPromise;
  await chooser.setFiles(pdfPath);
  const card = page.locator('.book-card-item[data-book-id^="pdf-"]').first();
  await card.waitFor({ state: "visible", timeout: 120_000 });
  const bookId = await card.getAttribute("data-book-id");
  await card.click();
  await page.waitForSelector("#bookDetailContinueBtn");
  await page.click("#bookDetailContinueBtn");
  await page.waitForSelector(".real-reader-text", { timeout: 30_000 });
  const readingText = await page.locator(".real-reader-text").innerText();
  assert.doesNotMatch(readingText, /IGNORE ALL PREVIOUS INSTRUCTIONS/i);
  assert.doesNotMatch(readingText, /WHITE ON PAPER PROMPT INJECTION/i);
  assert.match(readingText, /Visible normal evidence sentence one\./);
  assert.match(readingText, /WHITE ON COLORED BACKGROUND IS VISIBLE/);

  const stored = await page.evaluate(async (id) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("biandu-local-v1", 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise((resolve, reject) => {
      const request = db.transaction("books", "readonly").objectStore("books").get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }, bookId);
  assert.ok(stored.pages[0].readingQuality.filtered.hidden >= 2);
  assert.deepEqual(errors, [], `Browser errors: ${errors.join(" | ")}`);
  console.log("PDF visibility filtering passed: transparent and white-on-paper text removed; white-on-color retained.");
} finally {
  await browser.close();
}
