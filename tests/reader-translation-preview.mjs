import { resolve } from "node:path";
import { chromium } from "playwright-core";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const baseUrl = "http://127.0.0.1:4173";
const pdfPath = resolve("tests/fixtures/reading-sample.pdf");
const outputPath = resolve("output/reader-translation-mixed-preview.png");
const browser = await chromium.launch({ headless: true, executablePath: edgePath });

try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 960 } });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const chooserPromise = page.waitForEvent("filechooser");
  await page.click("#openImportPdfBtn");
  const chooser = await chooserPromise;
  await chooser.setFiles(pdfPath);
  const card = page.locator('.book-card-item[data-book-id^="pdf-"]').first();
  await card.waitFor({ state: "visible", timeout: 30_000 });
  await card.click();
  await page.click("#bookDetailContinueBtn");
  await page.waitForSelector(".real-reader-text .reader-block-paragraph");

  const records = await page.evaluate(async () => {
    const repository = await import("/src/web/repository.js");
    const book = window.BianDuFeatures.currentImportedBook();
    const firstPage = book.pages.find((item) => item.number === 1);
    const blocks = (firstPage.readingBlocks || []).filter((block) =>
      ["title", "heading", "subheading", "paragraph", "list-item", "caption", "footnote"].includes(block.type)
    );
    const records = [];
    for (const block of blocks) {
      const heading = ["title", "heading", "subheading"].includes(block.type);
      const sentences = heading
        ? [block.text]
        : String(block.text).split(/(?<=[.!?。！？；;])\s+/u).filter(Boolean);
      sentences.forEach((sentence, segmentIndex) => {
        records.push({
          id: `tr-${book.id}-p1-b${block.index}-s${segmentIndex}`,
          bookId: book.id,
          page: 1,
          paragraphIndex: block.index,
          segmentIndex,
          original: sentence,
          translation: heading
            ? "双语阅读示例"
            : "读者可以逐句对照这段英文，并在同一连续阅读流中继续查看尚未翻译的后续页面。",
          mode: "sentence",
          textVersion: 2,
          createdAt: new Date().toISOString(),
        });
      });
    }
    await repository.replaceTranslationsForPage(book.id, 1, records);
    return records;
  });

  await page.evaluate((saved) => {
    const reader = window.BianDuRuntime.reader.getState();
    reader.translations = saved;
    reader.translationsOn = true;
    reader.lastEnhancedKey = "";
    window.BianDuFeatures.renderApp();
  }, records);
  await page.waitForSelector(".reader-page-section");
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const pageTwo = document.querySelector('.reader-page-section[data-page="2"]');
    const scroll = document.getElementById("realReaderScroll");
    if (pageTwo && scroll) scroll.scrollTop = Math.max(0, pageTwo.offsetTop - 620);
  });
  await page.waitForTimeout(350);
  await page.screenshot({ path: outputPath, fullPage: false });
  console.log(outputPath);
} finally {
  await browser.close();
}
