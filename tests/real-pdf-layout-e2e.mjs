import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const pdfPath = resolve(process.argv[2] || process.env.BIANDU_REAL_PDF || "");
if (!process.env.BIANDU_REAL_PDF && !process.argv[2]) {
  console.log("Real PDF layout test skipped: pass a PDF path as the first argument.");
  process.exit(0);
}
assert.ok(existsSync(pdfPath), `PDF not found: ${pdfPath}`);

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
});

try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
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

  const titleText = await page.locator(".real-reader-text").innerText();
  assert.match(titleText, /AGENT AI: SURVEYING THE HORIZONS OF MULTIMODAL INTERACTION/i);
  assert.doesNotMatch(titleText, /\bA GENT\b/);
  assert.equal(await page.locator('.reader-block-title[data-paragraph-index="0"]').count(), 1);
  assert.ok(await page.locator(".reader-page-visual").count(), "Visual page preview should be available");
  await page.waitForFunction(() => document.querySelector(".pdf-visual-image")?.dataset.rendered === "true", null, { timeout: 30_000 });

  const tokenMismatch = await page.evaluate(() => {
    const tokens = Array.from(document.querySelectorAll(".real-reader-text .word-token"));
    return tokens.filter((token) => token.textContent !== token.getAttribute("data-word")).length;
  });
  assert.equal(tokenMismatch, 0, "Every rendered word token must preserve its exact source spelling");

  await page.click("#realNextPageBtn");
  await page.waitForFunction(() => document.querySelector("[data-page]")?.getAttribute("data-page") === "2");
  const abstractText = await page.locator(".real-reader-text").innerText();
  assert.match(abstractText, /^ABSTRACT/m);
  assert.doesNotMatch(abstractText, /\bA BSTRACT\b/);

  await page.locator("#readerPageSlider").evaluate((slider) => {
    slider.value = "15";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector("[data-page]")?.getAttribute("data-page") === "15");
  const page15 = page.locator(".real-reader-text");
  assert.ok(await page15.locator(".reader-block-list-item").count() >= 4, "Each bullet should be an independent reading block");
  assert.match(await page15.innerText(), /Figure 5:/i);
  assert.match(await page15.innerText(), /environmental feedback/i);
  await page.waitForFunction(() => document.querySelector(".pdf-visual-image")?.dataset.rendered === "true", null, { timeout: 30_000 });
  const visiblePageImage = await page.locator(".pdf-visual-image").evaluate((image) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { alpha: false });
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonWhite = 0;
    let sampled = 0;
    for (let index = 0; index < pixels.length; index += 160) {
      sampled += 1;
      if (pixels[index] < 248 || pixels[index + 1] < 248 || pixels[index + 2] < 248) nonWhite += 1;
    }
    return {
      ratio: nonWhite / Math.max(1, sampled),
      width: canvas.width,
      height: canvas.height,
      aspectRatio: canvas.width / Math.max(1, canvas.height),
    };
  });
  assert.ok(visiblePageImage.ratio > 0.01, `Embedded page image should contain visible PDF content: ${JSON.stringify(visiblePageImage)}`);
  assert.ok(visiblePageImage.aspectRatio > 2.5, `Figure crop must exclude the full reading page: ${JSON.stringify(visiblePageImage)}`);

  await page.screenshot({ path: "output/pdf/2401.03568v2-reading-landscape-fixed.png", fullPage: true });

  await page.locator("#readerPageSlider").evaluate((slider) => {
    slider.value = "16";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector("[data-page]")?.getAttribute("data-page") === "16");
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll(".pdf-visual-image"));
    return images.length === 2 && images.every((image) => image.dataset.rendered === "true");
  }, null, { timeout: 30_000 });
  const figureRatios = await page.locator(".pdf-visual-image").evaluateAll((images) =>
    images.map((image) => image.naturalWidth / Math.max(1, image.naturalHeight))
  );
  assert.ok(figureRatios.every((ratio) => ratio > 1.5), `Each figure should be a local visual crop: ${figureRatios.join(", ")}`);
  const figureAspectChecks = await page.locator(".pdf-visual-image").evaluateAll((images) =>
    images.map((image) => {
      const rect = image.getBoundingClientRect();
      return {
        natural: image.naturalWidth / Math.max(1, image.naturalHeight),
        rendered: rect.width / Math.max(1, rect.height)
      };
    })
  );
  assert.ok(
    figureAspectChecks.every(({ natural, rendered }) => Math.abs(natural - rendered) < 0.03),
    `Figure display must preserve the crop aspect ratio: ${JSON.stringify(figureAspectChecks)}`
  );
  const figureOrder = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".reader-block-caption"))
      .filter((caption) => /^Figure [67]:/i.test(caption.textContent.trim()))
      .map((caption) => ({
        text: caption.textContent.trim().slice(0, 20),
        previousClass: caption.previousElementSibling?.className || ""
      }))
  );
  assert.equal(figureOrder.length, 2, `Both figure captions should be present: ${JSON.stringify(figureOrder)}`);
  assert.ok(
    figureOrder.every((caption) => caption.previousClass === "reader-page-visual"),
    `Each figure crop should appear immediately before its caption: ${JSON.stringify(figureOrder)}`
  );
  await page.screenshot({ path: "output/pdf/2401.03568v2-reading-page16-figures.png", fullPage: true });

  await page.locator("#readerPageSlider").evaluate((slider) => {
    slider.value = "15";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector("[data-page]")?.getAttribute("data-page") === "15");
  await page.setViewportSize({ width: 1068, height: 1600 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: "output/pdf/2401.03568v2-reading-portrait-fixed.png", fullPage: true });

  await page.evaluate(async (id) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("biandu-local-v1", 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const book = await new Promise((resolve, reject) => {
      const request = db.transaction("books", "readonly").objectStore("books").get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    book.pages = book.pages.map(({ readingBlocks, readingLayoutVersion, ...page }) => ({
      ...page,
      visualRegionsVersion: 2,
      visualRegions: (page.visualRegions || []).map(({ aspect, ...region }) => region)
    }));
    book.readingLayoutVersion = 1;
    await new Promise((resolve, reject) => {
      const tx = db.transaction("books", "readwrite");
      tx.objectStore("books").put(book);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }, bookId);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(async (id) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("biandu-local-v1", 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const book = await new Promise((resolve, reject) => {
      const request = db.transaction("books", "readonly").objectStore("books").get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return book?.pages?.[0]?.readingLayoutVersion >= 6 &&
      Array.isArray(book.pages[0].readingBlocks) &&
      book.pages[0].readingBlocks.length > 0 &&
      [15, 16].every((index) => book.pages[index]?.visualRegionsVersion === 4 &&
        book.pages[index].visualRegions?.every((region) => Number(region.aspect) > 0));
  }, bookId, { timeout: 120_000 });

  assert.deepEqual(errors, [], `Browser errors: ${errors.join(" | ")}`);
  console.log("Real PDF reading layout passed: title initials, abstract, measured spaces, list blocks, image-only figure crops, exact word tokens and old-book migration.");
} finally {
  await browser.close();
}
