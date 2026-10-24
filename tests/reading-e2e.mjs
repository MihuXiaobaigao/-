import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const pdfPath = resolve("tests/fixtures/reading-sample.pdf");
const baseUrl = "http://127.0.0.1:4173";

const browser = await chromium.launch({
  headless: true,
  executablePath: edgePath
});

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("#openImportPdfBtn");

  const chooserPromise = page.waitForEvent("filechooser");
  await page.click("#openImportPdfBtn");
  const chooser = await chooserPromise;
  await chooser.setFiles(pdfPath);

  const importedCard = page.locator(
    '.book-card-item[data-book-id^="pdf-"]'
  ).first();
  await importedCard.waitFor({ state: "visible", timeout: 30000 });
  const importedBookId = await importedCard.getAttribute("data-book-id");
  assert.ok(importedBookId, "Imported book should have a local id");

  await importedCard.click();
  await page.waitForSelector("#bookDetailContinueBtn");
  assert.match(await page.locator(".book-detail-progress-head").innerText(), /阅读进度/);
  await page.click("#bookDetailContinueBtn");
  await page.waitForSelector(".real-reader-text", { timeout: 15000 });
  await page.waitForSelector(".real-reader-text p");

  const firstPageText = await page.locator(".real-reader-text").innerText();
  assert.match(firstPageText, /information becomes abundant/i);

  const readingLayout = await page.evaluate(() => ({
    articleWidth: document.querySelector(".real-reader-article").getBoundingClientRect().width,
    textWidth: document.querySelector(".real-reader-text").getBoundingClientRect().width,
  }));
  assert.ok(readingLayout.articleWidth >= 900, "Wide tablets should use the denser 920px reading column");
  assert.ok(readingLayout.textWidth > 780, "The reading line should not be squeezed by excessive margins");

  await page.evaluate(() => {
    document.querySelector("#realReaderScroll").scrollTop = 260;
  });
  await page.waitForTimeout(150);
  const scrollBeforeRender = await page.evaluate(() =>
    document.querySelector("#realReaderScroll").scrollTop
  );
  await page.evaluate(() => window.BianDuFeatures.renderApp());
  await page.waitForTimeout(250);
  const scrollAfterRender = await page.evaluate(() =>
    document.querySelector("#realReaderScroll").scrollTop
  );
  assert.ok(
    Math.abs(scrollAfterRender - scrollBeforeRender) <= 2,
    "Reader re-render must preserve the stable text anchor instead of jumping toward the top"
  );

  assert.equal(await page.locator("#readerSettingsToggleBtn").count(), 1);
  assert.equal(await page.locator("#realAddNoteBtn").count(), 0);
  assert.equal(await page.locator("#readerBookmarkToggleBtn").count(), 0);
  assert.equal(await page.locator("#readerCatalogToggleBtn").count(), 0);
  assert.equal(await page.locator("#readerNotesToggleBtn").count(), 0);
  assert.equal(await page.locator("#readerOutlineToggleBtn").count(), 0);
  assert.equal(await page.locator("#readerAskExcerptAiBtn").count(), 0);

  const settingsButton = await page.locator("#readerSettingsToggleBtn").boundingBox();
  assert.ok(settingsButton);
  await page.mouse.move(settingsButton.x + settingsButton.width / 2, settingsButton.y + settingsButton.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(550);
  await page.waitForSelector("#readerActionTip");
  assert.match(await page.locator("#readerActionTip").innerText(), /阅读设置/);
  await page.mouse.up();
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.BianDuFeatures.state.readerSettingsOpen), false);

  await page.locator('.reader-page-section[data-page="2"]').evaluate((el) => el.scrollIntoView());
  await page.waitForTimeout(250);
  const secondPageText = await page.locator('.reader-page-section[data-page="2"]').innerText();
  assert.match(secondPageText, /Media and Cognitive Focus/i);

  await page.click('.real-reader-text .word-token[data-word="Media"]');
  await page.waitForFunction(() => document.querySelector("#readerAddDictionaryBtn")?.getAttribute("aria-disabled") === "false");
  assert.equal(await page.locator(".real-word-card").count(), 0);
  await page.evaluate(() => window.BianDuFeatures.markDictionaryWord("Media"));
  await page.waitForTimeout(250);

  await page.evaluate(() => {
    const paragraph = document.querySelector('.reader-page-section[data-page="2"] .reader-block-paragraph');
    if (!paragraph) throw new Error("Second-page paragraph not found");
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let textNode;
    while ((textNode = walker.nextNode())) nodes.push(textNode);
    let endNode = nodes.at(-1);
    let endOffset = endNode.data.length;
    for (const candidate of nodes) {
      const boundary = candidate.data.search(/[.!?。！？]/);
      if (boundary >= 0) {
        endNode = candidate;
        endOffset = boundary + 1;
        break;
      }
    }
    const range = document.createRange();
    range.setStart(nodes[0], 0);
    range.setEnd(endNode, endOffset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
  });
  await page.waitForFunction(() => document.querySelector("#readerSentenceNoteBtn")?.getAttribute("aria-disabled") === "false");
  await page.click("#readerSentenceNoteBtn");
  await page.click('[data-reader-note-choice="text"]');
  await page.waitForSelector("#realNoteTextarea");
  await page.fill(
    "#realNoteTextarea",
    "Test note: media shapes the architecture of attention."
  );
  await page.click("#saveRealNoteBtn");
  await page.waitForFunction(
    () => document.querySelector(".reader-page-notes")?.innerText.includes("Test note:")
  );

  await page.waitForTimeout(700);
  await page.screenshot({
    path: "preview/reading-feature-landscape.png",
    fullPage: true
  });

  await page.reload({ waitUntil: "networkidle" });
  const restoredCard = page.locator(`.book-card-item[data-book-id="${importedBookId}"]`);
  await restoredCard.waitFor({ state: "visible", timeout: 15000 });
  await restoredCard.click();
  await page.waitForSelector("#bookDetailContinueBtn");
  await page.click("#bookDetailContinueBtn");
  await page.waitForSelector(".real-reader-text");
  assert.match(await page.locator(".real-reader-text").innerText(), /Media and Cognitive Focus/i);
  await page.waitForFunction(
    () => document.querySelector(".real-reader-article")?.innerText.includes("Test note:"),
    undefined,
    { timeout: 10_000 }
  );
  assert.match(await page.locator(".real-reader-article").innerText(), /Test note:/i);

  const storedBookCount = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("biandu-local-v1", 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise((resolve, reject) => {
      const request = db.transaction("books", "readonly").objectStore("books").count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
  assert.equal(storedBookCount, 1);

  const storedDictionary = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("biandu-local-v1", 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise((resolve, reject) => {
      const request = db.transaction("dictionary", "readonly").objectStore("dictionary").get("media");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
  assert.equal(storedDictionary.count, 1);
  assert.match(storedDictionary.occurrences[0].sentence, /media/i);
  assert.deepEqual(pageErrors, []);

  await page.setViewportSize({ width: 854, height: 1112 });
  await page.waitForTimeout(300);
  const responsiveLayout = await page.evaluate(() => ({
    sideNav: getComputedStyle(document.querySelector(".side-nav")).display,
    bottomNav: getComputedStyle(document.querySelector(".bottom-nav")).display,
    statusBar: getComputedStyle(document.querySelector(".tablet-status-bar")).display,
    immersive: document.body.classList.contains("reader-immersive"),
    toolbarHits: [...document.querySelectorAll(".reader-toolbar button")].map(button => {
      const rect = button.getBoundingClientRect();
      const hit = rect.width && rect.height
        ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        : null;
      return Boolean(hit && (hit === button || button.contains(hit)));
    })
  }));
  assert.equal(responsiveLayout.sideNav, "none");
  assert.equal(responsiveLayout.bottomNav, "none");
  assert.equal(responsiveLayout.statusBar, "none");
  assert.equal(responsiveLayout.immersive, true, "Reader should enter immersive mode on start");
  assert.ok(responsiveLayout.toolbarHits.every(Boolean), "Reader toolbar buttons must not be covered by another layer");
  await page.screenshot({
    path: "preview/reading-feature-portrait.png",
    fullPage: true
  });

  console.log("PDF import, reading, note, progress and reload restoration passed.");
  await context.close();
} finally {
  await browser.close();
}
