import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const baseUrl = process.env.BIANDU_BASE_URL || "http://127.0.0.1:4173";
const pdfPath = resolve("tests/fixtures/reading-sample.pdf");
const backupPath = resolve("preview/final-backup.biandu.json");
const boardFilePath = resolve("preview/final-board.biandu-board.json");
const boardPdfPath = resolve("preview/final-board.pdf");
const pngBuffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYGJAQoAHgQCAZ7Y5D8AAAAASUVORK5CYII=",
  "base64",
);

const aiRequests = [];
let knowledgeFailuresRemaining = 0;
let dictionaryDelayMs = 0;
let dictionaryFailuresRemaining = 0;
let translationDelayMs = 0;
const browser = await chromium.launch({ headless: true, executablePath: edgePath });

async function importPdf(page) {
  const chooserPromise = page.waitForEvent("filechooser");
  await page.click("#openImportPdfBtn");
  const chooser = await chooserPromise;
  await chooser.setFiles(pdfPath);
  const card = page.locator('.book-card-item[data-book-id^="pdf-"]').first();
  await card.waitFor({ state: "visible", timeout: 30_000 });
  return card.getAttribute("data-book-id");
}

async function openBookDetail(page, bookId) {
  await page.click(`.book-card-item[data-book-id="${bookId}"]`);
  await page.waitForSelector("#bookDetailContinueBtn");
}

async function continueReading(page) {
  await page.click("#bookDetailContinueBtn");
  await page.waitForSelector(".real-reader-text p");
}

async function openSettingsData(page) {
  await page.evaluate(() => {
    const details = document.querySelector(".settings-data");
    if (!details) return;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

async function selectFirstSentence(page) {
  await page.evaluate(() => {
    const paragraph = document.querySelector(".real-reader-text .reader-block-paragraph");
    if (!paragraph) throw new Error("Reader paragraph not found");
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    if (!nodes.length) throw new Error("Reader sentence text not found");
    let endNode = nodes.at(-1);
    let endOffset = endNode.data.length;
    let seen = 0;
    for (const candidate of nodes) {
      const boundary = candidate.data.search(/[.!?。！？]/);
      if (boundary >= 0) {
        endNode = candidate;
        endOffset = boundary + 1;
        break;
      }
      seen += candidate.data.length;
      if (seen > 240) {
        endNode = candidate;
        endOffset = Math.min(candidate.data.length, 160);
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
}

async function selectWord(page, word) {
  await page.evaluate((target) => {
    const token = document.querySelector(`.real-reader-text .word-token[data-word="${target}"]`);
    if (!token) throw new Error(`Word token not found: ${target}`);
    token.click();
  }, word);
  await page.waitForFunction(() => document.querySelector("#readerAddDictionaryBtn")?.getAttribute("aria-disabled") === "false");
}

async function readStore(page, store) {
  return page.evaluate(async (name) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("biandu-local-v1", 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise((resolve, reject) => {
      const request = db.transaction(name, "readonly").objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }, store);
}

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    hasTouch: true,
    serviceWorkers: "allow",
  });

  await context.route(`${baseUrl}/mock-ai`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
      return;
    }
    const payload = route.request().postDataJSON();
    const messages = payload.messages || [];
    const system = messages.find((message) => message.role === "system")?.content || "";
    const user = messages.at(-1)?.content || "";
    aiRequests.push({ system, user });
    let userPayload = null;
    try { userPayload = JSON.parse(user); } catch { /* Non-JSON prompts are handled below. */ }
    let content = "测试回答";

    if (system.includes("只回答两个字符")) {
      content = "正常";
    } else if (system.includes("OCR 与排版文字校对器")) {
      content = JSON.stringify({
        correctedText: String(userPayload?.sourceText || ""),
        language: "English",
        changed: 0,
        warnings: [],
      });
    } else if (system.includes("翻译器")) {
      if (translationDelayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, translationDelayMs));
      const segments = (userPayload?.paragraphs || []).map((paragraph) => ({
        index: paragraph.index,
        original: paragraph.text,
        translation: `译文：${paragraph.text}`,
      }));
      content = JSON.stringify({ segments });
    } else if (system.includes("英汉学习词典")) {
      if (dictionaryDelayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, dictionaryDelayMs));
      if (dictionaryFailuresRemaining > 0) {
        dictionaryFailuresRemaining -= 1;
        content = JSON.stringify({ lemma: "attention", definitionZh: "" });
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          body: JSON.stringify({ choices: [{ message: { content } }] }),
        });
        return;
      }
      content = JSON.stringify({
        lemma: "information", phonetic: "/ˌɪnfəˈmeɪʃn/", partOfSpeech: "n.",
        definitionZh: "信息；资讯", sentenceTranslation: "信息变得极为丰富。",
      });
    } else if (system.includes("图片、公式与图表讲解助手")) {
      content = "框选内容是一个测试图表：纵轴表示注意力，横轴表示信息量。";
    } else if (system.includes("页面视觉内容的证据整理器")) {
      content = JSON.stringify({
        transcript: "Figure 1",
        visualDescription: "图表展示信息量与注意力的关系。",
        formulas: ["A = I / t"], tables: [], figures: ["Figure 1: attention and information"],
        confidence: 0.92, warnings: [],
      });
    } else if (knowledgeFailuresRemaining > 0 && system.includes("知识图谱")) {
      knowledgeFailuresRemaining -= 1;
      content = "{}";
    } else if (system.includes("知识图谱")) {
      const ids = (userPayload?.evidenceBlocks || []).map((item) => item.evidenceId);
      const first = ids[0];
      const second = ids[1] || ids[0];
      content = JSON.stringify({
        summary: "本批证据说明信息供给增加，而人的注意力仍然有限。",
        nodes: [
          { title: "信息充裕", kind: "concept", summary: "信息供给变得丰富。", aliases: [], evidenceIds: [first] },
          { title: "注意力稀缺", kind: "claim", summary: "注意力成为限制因素。", aliases: [], evidenceIds: [second] },
        ],
        edges: [
          { from: "信息充裕", to: "注意力稀缺", relation: "contrasts-with", rationale: "两条证据形成对照。", evidenceIds: [first], confidence: 0.9 },
        ],
      });
    } else if (system.includes("私人知识库问答助手")) {
      const firstEvidence = userPayload?.evidenceBlocks?.[0];
      assert.ok(firstEvidence?.evidenceId && firstEvidence?.excerpt,
        "Mock knowledge prompt should contain a citable evidence excerpt");
      const quote = firstEvidence.excerpt.slice(0, 80);
      content = JSON.stringify({
        answer: `根据本机原文，${quote}`,
        insufficientEvidence: false,
        claims: [{ statement: quote, evidenceIds: [firstEvidence.evidenceId], sourceType: "quote" }],
        citations: [{ evidenceId: firstEvidence.evidenceId, quote }],
      });
    } else if (system.includes("选段讲解助手")) {
      content = "这段原文强调：信息越来越多，但人的注意力是有限资源。";
    }

    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify({ choices: [{ message: { content } }] }),
    });
  });

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  assert.match(await page.locator("#mainContent").innerText(), /还没有书/);
  assert.equal((await readStore(page, "books")).length, 0, "Demo books must not be seeded");

  const bookId = await importPdf(page);
  assert.ok(bookId);
  await page.waitForFunction(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("biandu-local-v1", 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise((resolve, reject) => {
      const request = db.transaction("evidence", "readonly").objectStore("evidence").count();
      request.onsuccess = () => resolve(request.result > 0);
      request.onerror = () => reject(request.error);
    });
  }, null, { timeout: 15_000 });

  await openBookDetail(page, bookId);
  assert.equal(await page.locator('.nav-item[data-nav="reader"]').count(), 0,
    "Reading must not remain a top-level navigation destination");
  assert.equal(await page.evaluate(() => window.BianDuFeatures?.state?.currentView), "book");
  assert.equal(await page.evaluate(() => window.BianDuFeatures?.state?.activeBookId), bookId);
  assert.match(await page.locator(".book-detail-progress-head").innerText(), /阅读进度/);
  assert.equal(await page.locator("#heroAskExcerptBtn").count(), 0,
    "Reading tools must stay inside the reader");
  await continueReading(page);
  assert.equal(await page.evaluate(() => window.BianDuFeatures?.state?.currentView), "reader");

  await page.click("#readerBackLibraryBtn");
  await page.waitForSelector('[data-nav="settings"]');
  await page.locator('[data-nav="settings"]:visible').click();
  await page.click('[data-edit-model-profile="builtin-deepseek-flash"]');
  await page.waitForSelector("#realAiEndpoint");
  await page.waitForTimeout(150);
  await page.fill("#realAiEndpoint", `${baseUrl}/mock-ai`);
  await page.fill("#realAiModel", "mock-deepseek-flash");
  await page.fill("#realAiKey", "test-only-dummy-key-123456789");
  await page.click("#realSaveAiBtn");
  await page.waitForFunction(() => !document.querySelector(".model-editor")
    && document.querySelector('[data-edit-model-profile="builtin-deepseek-flash"]')
      ?.closest(".model-profile-row")?.querySelector(".model-key-state.is-set"),
  null, { timeout: 20_000 });
  const savedSettings = (await readStore(page, "settings")).find((row) => row.key === "app-settings");
  const savedChat = savedSettings.modelProfiles.find((profile) => profile.id === "builtin-deepseek-flash");
  assert.equal(savedChat.endpoint, `${baseUrl}/mock-ai`,
    "Saving must persist the model while closing the editor");
  await page.selectOption('[data-model-role="translation"]', "builtin-deepseek-flash");
  await page.waitForFunction(() => document.getElementById("toastRoot")?.innerText.includes("功能模型已更新"));
  await page.click('[data-test-model-profile="builtin-deepseek-flash"]');
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-test-model-profile="builtin-deepseek-flash"]');
    return button && !button.disabled && button.textContent === "测试";
  });
  await page.waitForTimeout(80);
  const connectionToast = await page.locator("#toastRoot").innerText();
  assert.match(connectionToast, /(?:AI|模型)连接成功/, `Connection test failed: ${connectionToast}`);

  await page.locator('[data-nav="library"]:visible').click();
  await openBookDetail(page, bookId);
  await continueReading(page);

  await page.click("#readerViewModeBtn");
  await page.waitForSelector("#readerPageStage");
  await page.waitForFunction(() => document.getElementById("pdfFallbackCanvas")?.dataset.rendered === "true", null, { timeout: 15_000 });
  const pageCanvasBox = await page.locator("#pdfFallbackCanvas").boundingBox();
  assert.ok(pageCanvasBox);
  await page.click("#readerPdfHighlighterBtn");
  await page.mouse.move(pageCanvasBox.x + 45, pageCanvasBox.y + 55);
  await page.mouse.down();
  await page.mouse.move(pageCanvasBox.x + 300, pageCanvasBox.y + 155, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const inkStrokes = await page.evaluate((bookId) =>
    window.BianDuFeatures.books.find((book) => book.id === bookId)?.pdfInkAnnotations?.[
      window.BianDuFeatures.state.readerPage
    ]?.length || 0, bookId);
  assert.ok(inkStrokes >= 1, "PDF original mode should accept highlighter strokes");
  assert.equal(await page.locator("#readerRegionSelectBtn").count(), 0);
  assert.equal(await page.locator("#readerFullTranslationBtn").count(), 0);
  await page.evaluate(() => {
    window.BianDuFeatures.state.readerExcerptAiOpen = false;
    window.BianDuFeatures.state.readerSelectedImage = null;
    window.BianDuFeatures.state.readerViewMode = "text";
    window.BianDuFeatures.renderApp();
  });
  await page.waitForSelector(".real-reader-text p");

  await page.waitForSelector("#readerFullTranslationBtn", { timeout: 10_000 });
  translationDelayMs = 450;
  await page.click("#readerFullTranslationBtn");
  await page.waitForSelector(".sentence-translation", { timeout: 30_000 });
  assert.match(await page.locator(".sentence-translation").first().innerText(), /[\u3400-\u9fff]/);
  const readingWrap = await page.locator(".real-reader-text .reader-block-paragraph").first().evaluate((paragraph) => ({
    whiteSpace: getComputedStyle(paragraph).whiteSpace,
    textWrap: getComputedStyle(paragraph).textWrap,
    originalDisplay: getComputedStyle(paragraph.querySelector(".sentence-original")).display,
  }));
  assert.equal(readingWrap.whiteSpace, "normal", "Reader blocks must not preserve PDF line breaks");
  assert.notEqual(readingWrap.textWrap, "pretty", "Reader wrapping must not manufacture balanced line breaks");
  assert.equal(readingWrap.originalDisplay, "inline", "Translated sentences must flow instead of becoming paragraph-like blocks");
  await page.click("#readerLoadingOverlay .reader-loading-cancel");
  await page.waitForFunction(() => document.querySelector("#readerFullTranslationBtn")?.getAttribute("aria-label") === "继续翻译");
  await page.waitForFunction(() => !document.querySelector(".sentence-translation"));
  const partialTranslations = (await readStore(page, "translations")).filter((item) => item.bookId === bookId);
  assert.ok(partialTranslations.length > 0, "Completed pages should remain after cancel");
  assert.equal(new Set(partialTranslations.map((item) => item.page)).size, 1, "Only the committed page should be saved");
  translationDelayMs = 350;
  await page.click("#readerFullTranslationBtn");
  await page.waitForSelector(".sentence-translation");
  await page.waitForFunction(() => document.querySelector("#readerFullTranslationBtn")?.getAttribute("aria-label") === "取消翻译");
  const visibleResumedTranslation = (await page.locator(".sentence-translation").first().innerText()).trim();
  assert.ok(
    partialTranslations.some((item) => item.translation.trim() === visibleResumedTranslation),
    "Resuming must keep every previously translated sentence visible",
  );
  translationDelayMs = 0;
  await page.waitForFunction(() => document.querySelector("#readerFullTranslationBtn")?.getAttribute("aria-label") === "只显示原文", null, { timeout: 30_000 });
  const translationRequestsBeforeToggle = aiRequests.filter((request) => request.system.includes("翻译器")).length;
  await page.click("#readerFullTranslationBtn");
  await page.waitForFunction(() => !document.querySelector(".sentence-translation"));
  await page.waitForFunction(() => document.querySelector("#readerFullTranslationBtn")?.getAttribute("aria-label") === "显示译文");
  await page.click("#readerFullTranslationBtn");
  await page.waitForSelector(".sentence-translation");
  assert.equal(
    aiRequests.filter((request) => request.system.includes("翻译器")).length,
    translationRequestsBeforeToggle,
    "Showing cached translations must not call translation again",
  );

  await page.evaluate(() => {
    const original = document.querySelector(".real-reader-text .sentence-original");
    if (!original) return;
    const range = document.createRange();
    range.selectNodeContents(original);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
  });
  await page.waitForFunction(() => document.querySelector("#readerTranslateSelectionBtn")?.getAttribute("aria-disabled") === "false");
  await page.click("#readerTranslateSelectionBtn");
  await page.waitForSelector("#readerInlineTranslation", { timeout: 10_000 });
  await page.waitForTimeout(400);
  const inlineSentence = await page.locator("#readerInlineTranslation").innerText();
  assert.match(inlineSentence, /[\u3400-\u9fff]/, `Inline sentence translation failed: ${inlineSentence}`);

  dictionaryFailuresRemaining = 1;
  await selectWord(page, "attention");
  await page.click("#readerTranslateSelectionBtn");
  await page.waitForSelector("#readerInlineTranslation .reader-inline-error", { timeout: 10_000 });
  const rescuedWord = (await readStore(page, "dictionary")).find((entry) => entry.lemma === "attention");
  assert.ok(rescuedWord, "A selected word must be saved even when enrichment fails");

  dictionaryDelayMs = 650;
  await selectWord(page, "information");
  await page.click("#readerTranslateSelectionBtn");
  await page.waitForSelector("#readerInlineTranslation .reader-inline-definition", { timeout: 10_000 });
  assert.match(await page.locator("#readerInlineTranslation").innerText(), /信息；资讯/);
  const savedDictionary = await readStore(page, "dictionary");
  assert.ok(savedDictionary.some((entry) => entry.lemma === "information" && entry.definitionZh));
  dictionaryDelayMs = 0;

  await selectFirstSentence(page);
  await page.click("#readerSentenceNoteBtn");
  await page.click('[data-reader-note-choice="text"]');
  await page.waitForSelector("#readerInlineNoteEditor");
  await page.fill("#readerInlineNoteText", "文字笔记：信息充裕与注意力稀缺构成核心张力。");
  await page.click("#readerInlineNoteSave");
  await page.waitForFunction(() => document.querySelector(".reader-page-notes")?.innerText.includes("文字笔记"));
  assert.equal(await page.locator("#realReaderScroll").count(), 1, "Saving a text note must stay in the reader");

  await page.evaluate(() => window.BianDuRuntime.reader.createAnnotationBoard());
  await page.waitForSelector("#readerInlineBoard");
  assert.equal(await page.locator("#realReaderScroll").count(), 1, "Opening an annotation board must stay in the reader");
  const inlineBoardBox = await page.locator("#readerInlineBoardCanvas").boundingBox();
  assert.ok(inlineBoardBox);
  await page.mouse.move(inlineBoardBox.x + 70, inlineBoardBox.y + 80);
  await page.mouse.down();
  await page.mouse.move(inlineBoardBox.x + 180, inlineBoardBox.y + 130, { steps: 8 });
  await page.mouse.up();
  await page.click("#readerInlineBoardSave");
  await page.waitForFunction(() => !document.querySelector("#readerInlineBoard"));
  const firstBoardId = await page.evaluate(() => window.BianDuRuntime.board.getActive().id);
  await page.evaluate((boardId) => window.BianDuRuntime.app.switchView("board", { boardId }), firstBoardId);
  await page.waitForSelector(".bd-gallery-page");
  await page.locator(`[data-open-board-id="${firstBoardId}"]`).click();
  await page.waitForSelector("#bdStage");
  const stageBox = await page.locator("#bdStage").boundingBox();
  assert.ok(stageBox);
  await page.mouse.move(stageBox.x + 80, stageBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + 210, stageBox.y + 150, { steps: 8 });
  await page.mouse.move(stageBox.x + 260, stageBox.y + 210, { steps: 8 });
  await page.mouse.up();

  await page.click('[data-board-tool="text"]');
  await page.fill("#boardElementText", "信息供给上升");
  await page.click("#saveBoardTextBtn");
  await page.click('[data-board-tool="sticky"]');
  await page.fill("#boardElementText", "注意力是有限资源");
  await page.click("#saveBoardTextBtn");
  await page.setInputFiles("#boardImageInput", {
    name: "board-image.png", mimeType: "image/png", buffer: pngBuffer,
  });
  await page.fill("#boardOcrText", "信息充裕 -> 注意力稀缺 -> 深度阅读");
  await page.click("#saveBoardOcrBtn");
  await page.waitForTimeout(700);
  assert.deepEqual(
    new Set(await page.evaluate(() => window.BianDuRuntime.board.getActive().elements.map((item) => item.type))),
    new Set(["stroke", "text", "sticky", "image"]),
  );

  await page.click("#boardUndoBtn");
  assert.equal(await page.evaluate(() => window.BianDuRuntime.board.getActive().elements.length), 4);
  await page.click("#boardRedoBtn");
  assert.equal(await page.evaluate(() => window.BianDuRuntime.board.getActive().elements.length), 5);

  const pageHideSave = await page.evaluate(async (boardId) => {
    const repo = await import("/src/web/repository.js");
    const active = window.BianDuRuntime.board.getActive();
    active.elements.push({
      id: "page-hide-regression", type: "text", x: 20, y: 20,
      text: "关闭前立即保存", color: "#1f4037", fontSize: 18,
      createdAt: new Date().toISOString(),
    });
    window.dispatchEvent(new Event("pagehide"));
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    const stored = await repo.getRecord("boards", boardId);
    return Boolean(stored?.elements?.some((item) => item.id === "page-hide-regression"));
  }, firstBoardId);
  assert.equal(pageHideSave, true, "Page hide must flush the latest board changes immediately");
  await page.evaluate(async () => {
    const active = window.BianDuRuntime.board.getActive();
    active.elements = active.elements.filter((item) => item.id !== "page-hide-regression");
    window.dispatchEvent(new Event("pagehide"));
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  const pinchBox = await page.locator("#bdStage").boundingBox();
  const px = pinchBox.x + pinchBox.width / 2;
  const py = pinchBox.y + pinchBox.height / 2;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart", touchPoints: [{ x: px - 35, y: py, id: 1 }, { x: px + 35, y: py, id: 2 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove", touchPoints: [{ x: px - 85, y: py, id: 1 }, { x: px + 85, y: py, id: 2 }],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForFunction(() => document.getElementById("boardZoomLabel")?.textContent !== "100%");
  const boardZoom = await page.evaluate(() => window.BianDuRuntime.board.getState().zoom);
  assert.ok(boardZoom > 1, `Pinch should zoom in, received ${boardZoom}`);

  await page.click("#boardBackReaderBtn");
  await page.waitForSelector(".bd-gallery-page");
  await page.evaluate(() => window.BianDuRuntime.app.switchView("reader", {
    bookId: window.BianDuRuntime.board.getActive()?.bookId,
  }));
  await page.waitForSelector(".real-reader-text p");
  await selectFirstSentence(page);
  await page.evaluate(() => window.BianDuRuntime.reader.createAnnotationBoard());
  await page.waitForSelector("#readerInlineBoard");
  const secondInlineBoardBox = await page.locator("#readerInlineBoardCanvas").boundingBox();
  assert.ok(secondInlineBoardBox);
  await page.mouse.move(secondInlineBoardBox.x + 90, secondInlineBoardBox.y + 90);
  await page.mouse.down();
  await page.mouse.move(secondInlineBoardBox.x + 200, secondInlineBoardBox.y + 150, { steps: 8 });
  await page.mouse.up();
  await page.click("#readerInlineBoardSave");
  await page.waitForFunction(() => !document.querySelector("#readerInlineBoard"));
  const secondBoardId = await page.evaluate(() => window.BianDuRuntime.board.getActive().id);
  assert.notEqual(firstBoardId, secondBoardId);
  let boards = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    boards = await readStore(page, "boards");
    if ([firstBoardId, secondBoardId].every((id) => boards.some((board) => board.id === id))) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  assert.equal(
    boards.filter((board) => board.page === 1).length,
    2,
    `Unexpected board pages: ${JSON.stringify(boards.map((board) => ({ id: board.id, page: board.page })))}`
  );
  assert.ok(new Set(boards.map((board) => board.knowledgeNodeIds?.[0]).filter(Boolean)).size >= 2);

  await page.evaluate(() => window.BianDuRuntime.app.switchView("dict"));
  await page.waitForSelector(".dict-real-page");
  await page.waitForFunction(() => document.querySelector(".dict-real-page")?.innerText.includes("1 次"));
  await page.waitForFunction(
    () => document.querySelector(".dict-real-page")?.innerText.includes("信息；资讯"),
    null,
    { timeout: 10_000 },
  );
  assert.ok((await page.locator(".dict-occurrences article").count()) >= 1);

  await page.locator('[data-nav="kb"]:visible').click();
  await page.waitForSelector("#realKbQuestion");
  await page.fill("#realKbQuestion", "information becomes abundant 说明了什么？");
  await page.click("#realKbAskBtn");
  await page.waitForFunction(() => [...document.querySelectorAll(".kb-chat-message.is-assistant")]
    .some((node) => node.innerText.includes("根据本机原文")));
  const knowledgeText = await page.locator(".kb-agent-thread").innerText();
  assert.match(knowledgeText, /根据本机原文/);
  assert.equal(await page.locator(".kb-agent-answer").count(), 0);

  await page.locator('[data-nav="settings"]:visible').click();
  await openSettingsData(page);
  await page.click("#settingsProcessKnowledgeBtn");
  await page.waitForFunction(() => document.querySelector(".settings-book-jobs")?.innerText.includes("已整理"), null, { timeout: 20_000 });
  const [processedBook] = await readStore(page, "books");
  assert.equal(processedBook.knowledgeProcessing.status, "verified");
  assert.ok(processedBook.knowledgeProcessing.nodeCount > 0);
  assert.equal(processedBook.visualArchive.status, "complete");

  knowledgeFailuresRemaining = 4;
  const failedReprocessing = await page.evaluate(async (id) => {
    const repo = await import("/src/web/repository.js");
    const maintenance = await import("/src/web/maintenance.js");
    const book = await repo.getRecord("books", id);
    await repo.putRecord("books", {
      ...book,
      pages: book.pages.map((page, index) => index === 0
        ? { ...page, hasVisualContent: true, visualContentKinds: ["image"] }
        : page),
      visualArchive: { ...book.visualArchive, status: "pending" },
      knowledgeProcessing: { ...book.knowledgeProcessing, status: "local-indexed" },
    });
    try {
      await maintenance.processBookKnowledge(id);
      throw new Error("Knowledge processing unexpectedly succeeded");
    } catch (error) {
      if (String(error.message).includes("unexpectedly succeeded")) throw error;
    }
    const after = await repo.getRecord("books", id);
    return {
      status: after.knowledgeProcessing?.status,
      archiveStatus: after.visualArchive?.status,
      visualKnowledgeStatus: after.visualKnowledge?.status,
      snapshotPages: (after.pages || []).filter((page) => page.visualSnapshotAssetId).length,
    };
  }, bookId);
  knowledgeFailuresRemaining = 0;
  assert.equal(failedReprocessing.status, "failed");
  assert.equal(failedReprocessing.archiveStatus, "complete", "A later summary failure must not erase completed snapshots");
  assert.equal(failedReprocessing.visualKnowledgeStatus, "complete", "A later summary failure must not erase visual evidence state");
  assert.ok(failedReprocessing.snapshotPages > 0);

  const visualArchiveBlocked = await page.evaluate(async () => {
    const repo = await import("/src/web/repository.js");
    const maintenance = await import("/src/web/maintenance.js");
    const book = (await repo.getAll("books"))[0];
    const originalArchive = book.visualArchive;
    await repo.putRecord("books", {
      ...book, visualArchive: { ...originalArchive, status: "pending" },
      knowledgeProcessing: {
        ...book.knowledgeProcessing, status: "verified", evidenceSaved: true, summaryReady: true,
        verifiedAt: new Date(Date.now() - 8 * 86400000).toISOString(),
      },
    });
    await maintenance.runRetentionCleanup(new Date());
    const after = await repo.getRecord("books", book.id);
    const file = await repo.getRecord("files", book.id);
    await repo.putRecord("books", book);
    return { pages: after.pages.length, hasFile: Boolean(file?.blob) };
  });
  assert.ok(visualArchiveBlocked.pages > 0 && visualArchiveBlocked.hasFile,
    "Incomplete visual archive must block cleanup");

  await page.locator('[data-nav="graph"]:visible').click();
  await page.waitForSelector("#realGraphSvg");
  assert.ok((await page.locator(".pg-node").count()) >= 3);

  await page.locator('[data-nav="settings"]:visible').click();
  await openSettingsData(page);
  const downloadPromise = page.waitForEvent("download");
  await page.click("#settingsExportBackupBtn");
  const download = await downloadPromise;
  await download.saveAs(backupPath);

  const blocked = await page.evaluate(async () => {
    const repo = await import("/src/web/repository.js");
    const maintenance = await import("/src/web/maintenance.js");
    const book = (await repo.getAll("books"))[0];
    await repo.putRecord("books", {
      ...book,
      knowledgeProcessing: {
        ...book.knowledgeProcessing,
        status: "verified", evidenceSaved: false, summaryReady: true,
        verifiedAt: new Date(Date.now() - 8 * 86400000).toISOString(),
      },
    });
    await maintenance.runRetentionCleanup(new Date());
    const after = await repo.getRecord("books", book.id);
    const file = await repo.getRecord("files", book.id);
    return { pages: after.pages.length, hasFile: Boolean(file?.blob) };
  });
  assert.ok(blocked.pages > 0 && blocked.hasFile, "Missing verification must block cleanup");

  const cleaned = await page.evaluate(async () => {
    const repo = await import("/src/web/repository.js");
    const maintenance = await import("/src/web/maintenance.js");
    const book = (await repo.getAll("books"))[0];
    await repo.putRecord("books", {
      ...book,
      knowledgeProcessing: {
        ...book.knowledgeProcessing,
        status: "verified", evidenceSaved: true, summaryReady: true,
        verifiedAt: new Date(Date.now() - 8 * 86400000).toISOString(),
      },
    });
    await maintenance.runRetentionCleanup(new Date());
    const after = await repo.getRecord("books", book.id);
    const file = await repo.getRecord("files", book.id);
    const assets = await repo.getAll("assets");
    return {
      pages: after.pages.length, texts: after.pages.map((page) => page.text),
      snapshotCount: assets.filter((asset) => asset.kind === "pdf-page-snapshot" && asset.bookId === book.id).length,
      originalDeleted: after.originalDeleted, hasFile: Boolean(file?.blob),
    };
  });
  assert.ok(cleaned.pages > 0);
  assert.ok(cleaned.texts.every((text) => text === ""));
  assert.equal(cleaned.snapshotCount, cleaned.pages);
  assert.equal(cleaned.originalDeleted, true);
  assert.equal(cleaned.hasFile, false);

  await page.locator('[data-nav="library"]:visible').click();
  await openBookDetail(page, bookId);
  await continueReading(page);
  await page.waitForSelector(".real-reader-shell");
  await page.click("#readerViewModeBtn");
  await page.waitForFunction(() => document.getElementById("pdfFallbackCanvas")?.dataset.source === "snapshot", null, { timeout: 15_000 });
  assert.equal(await page.locator("#readerPdfPenBtn").count(), 1);
  assert.match(await page.locator("#readerPageLabel").innerText(), /原页视图/);
  await page.click("#readerBackLibraryBtn");
  await page.waitForSelector('[data-nav="settings"]');
  await page.locator('[data-nav="settings"]:visible').click();
  await openSettingsData(page);

  await page.setInputFiles("#settingsBackupFile", backupPath);
  await page.waitForFunction(async (id) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("biandu-local-v1", 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise((resolve, reject) => {
      const request = db.transaction("books", "readonly").objectStore("books").get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return record?.pages?.length > 0 && !record.originalDeleted;
  }, bookId, { timeout: 15_000 });

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#mainContent");
  await page.locator('[data-nav="board"]:visible').click();
  await page.waitForSelector(".bd-gallery-page");
  const boardPdfDownloadPromise = page.waitForEvent("download");
  await page.click(`[data-pdf-board-id="${firstBoardId}"]`);
  const boardPdfDownload = await boardPdfDownloadPromise;
  await boardPdfDownload.saveAs(boardPdfPath);
  const boardDownloadPromise = page.waitForEvent("download");
  await page.click(`[data-export-board-id="${firstBoardId}"]`);
  const boardDownload = await boardDownloadPromise;
  await boardDownload.saveAs(boardFilePath);
  await page.setInputFiles("#boardGalleryImportInput", boardFilePath);
  await page.waitForSelector("#bdStage");
  const importedBoard = await page.evaluate(() => window.BianDuRuntime.board.getActive());
  assert.notEqual(importedBoard.id, firstBoardId);
  assert.equal(importedBoard.elements.length, 5);
  assert.ok(importedBoard.elements.some((element) => element.type === "image"));
  await page.click("#boardBackReaderBtn");
  await page.waitForSelector(".bd-gallery-page");
  await page.locator(`[data-open-board-id="${firstBoardId}"]`).click();
  await page.waitForTimeout(500);
  const restoredFirst = await page.evaluate(() => window.BianDuRuntime.board.getActive());
  assert.equal(restoredFirst.elements.length, 5);
  assert.equal(restoredFirst.ocrText, "信息充裕 -> 注意力稀缺 -> 深度阅读");
  assert.ok(Math.abs(restoredFirst.viewport.zoom - boardZoom) < 0.02);

  await page.screenshot({ path: "preview/final-xiaomi-landscape.png", fullPage: true });
  // Xiaomi Pad 7S Pro portrait-class logical viewport.
  await page.setViewportSize({ width: 854, height: 1112 });
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".side-nav").evaluate((node) => getComputedStyle(node).display), "none");
  assert.equal(await page.locator(".bottom-nav").evaluate((node) => getComputedStyle(node).display), "none",
    "Board editor should use the whole portrait canvas");
  const portraitOverflow = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
  }));
  assert.ok(portraitOverflow.width <= portraitOverflow.client + 1, "Portrait layout should not overflow horizontally");
  await page.screenshot({ path: "preview/final-xiaomi-portrait.png", fullPage: true });
  await page.evaluate(() => window.BianDuRuntime.app.switchView("library"));
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".bottom-nav").evaluate((node) => getComputedStyle(node).display), "flex");

  // iPad A11-class PWA: 4:3 logical viewport, portrait and landscape.
  await page.goto(`${baseUrl}/index.html?device=ipad&view=kb`, { waitUntil: "networkidle" });
  await page.setViewportSize({ width: 810, height: 1080 });
  await page.waitForTimeout(300);
  await page.waitForSelector(".kb-agent-page");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.device), "ipad");
  assert.equal(await page.locator(".side-nav").evaluate((node) => getComputedStyle(node).display), "none");
  const ipadPortraitOverflow = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
  }));
  assert.ok(ipadPortraitOverflow.width <= ipadPortraitOverflow.client + 1, "iPad portrait should not overflow horizontally");
  await page.screenshot({ path: "preview/final-ipad-portrait.png", fullPage: true });
  await page.setViewportSize({ width: 1080, height: 810 });
  await page.waitForTimeout(300);
  const ipadLandscapeOverflow = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
  }));
  assert.ok(ipadLandscapeOverflow.width <= ipadLandscapeOverflow.client + 1, "iPad landscape should not overflow horizontally");
  await page.screenshot({ path: "preview/final-ipad-landscape.png", fullPage: true });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#mainContent", { timeout: 15_000 });
  assert.match(await page.locator("#mainContent").innerText(), /需要我为你做些什么|书库|还没有书/);
  await context.setOffline(false);

  assert.deepEqual(errors, [], `Page errors: ${errors.join(" | ")}`);
  console.log("Full reader, board, dictionary, AI workflows, knowledge graph, backup/restore, cleanup and offline PWA tests passed.");
  await context.close();
} finally {
  await browser.close();
}
