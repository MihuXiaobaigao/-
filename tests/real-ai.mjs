import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import sharp from "sharp";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
const siliconflowApiKey = process.env.SILICONFLOW_API_KEY?.trim();
if (!apiKey) {
  console.log("DEEPSEEK_API_KEY is not set; skipping the real DeepSeek regression.");
  process.exit(0);
}

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const pdfPath = resolve("tests/fixtures/reading-sample.pdf");
const scannedPdfPath = resolve("tests/fixtures/scanned-sample.pdf");
const configuredBaseUrl = process.env.BIANDU_BASE_URL || "";
const baseUrl = configuredBaseUrl || "http://127.0.0.1:4174";
let server;

async function waitForServer(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // The local static server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Static server did not start at ${url}`);
}

async function readStore(page, name) {
  return page.evaluate(async (storeName) => {
    const db = await new Promise((resolveDb, reject) => {
      const request = indexedDB.open("biandu-local-v1", 4);
      request.onsuccess = () => resolveDb(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise((resolveRows, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onsuccess = () => resolveRows(request.result);
      request.onerror = () => reject(request.error);
    });
  }, name);
}

async function openSettingsData(page) {
  await page.evaluate(() => {
    const details = document.querySelector(".settings-data");
    if (!details) return;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

async function importPdf(page) {
  const chooserPromise = page.waitForEvent("filechooser");
  await page.click("#openImportPdfBtn");
  const chooser = await chooserPromise;
  await chooser.setFiles(pdfPath);
  const card = page.locator('.book-card-item[data-book-id^="pdf-"]').first();
  await card.waitFor({ state: "visible", timeout: 30_000 });
  return card.getAttribute("data-book-id");
}

async function selectFirstParagraph(page) {
  await page.evaluate(() => {
    const paragraph = document.querySelector(".real-reader-text p");
    if (!paragraph) throw new Error("Reader paragraph not found");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "pen" }));
  });
  await page.waitForSelector("#realSelectionBar.is-visible");
}

async function selectWord(page, word) {
  await page.evaluate((target) => {
    const token = document.querySelector(`.real-reader-text .word-token[data-word="${target}"]`);
    if (!token) throw new Error(`Word token not found: ${target}`);
    const range = document.createRange();
    range.selectNodeContents(token);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
  }, word);
  await page.waitForSelector(".real-word-card");
}

function lastRequest(requests, marker) {
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    if (requests[index].system.includes(marker)) return requests[index];
  }
  return null;
}

function containsChinese(value) {
  return /[\u3400-\u9fff]/u.test(String(value || ""));
}

try {
  if (!configuredBaseUrl) {
    server = spawn(process.execPath, ["tools/serve.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: "4174" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    await waitForServer(baseUrl);
  }

  const browser = await chromium.launch({ headless: true, executablePath: edgePath });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      hasTouch: true,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const requests = [];
    const pageErrors = [];
    const failedRequests = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => {
      if (request.url().includes("api.deepseek.com")) {
        failedRequests.push(`${request.url()} :: ${request.failure()?.errorText || "unknown failure"}`);
      }
    });
    page.on("request", (request) => {
      if (request.method() !== "POST" || !request.url().includes("api.deepseek.com")) return;
      const body = request.postDataJSON();
      requests.push({
        model: body.model,
        messages: body.messages,
        system: body.messages?.find((message) => message.role === "system")?.content || "",
        user: body.messages?.at(-1)?.content || "",
      });
    });

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const bookId = await importPdf(page);
    assert.ok(bookId, "PDF should be imported");

    await page.click('[data-nav="settings"]');
    await page.click('[data-edit-model-profile="builtin-deepseek-flash"]');
    await page.waitForSelector("#realAiEndpoint");
    await page.fill("#realAiEndpoint", "https://api.deepseek.com/chat/completions");
    await page.fill("#realAiModel", "deepseek-flash");
    await page.fill("#realAiKey", apiKey);
    await page.click("#realSaveAiBtn");
    let settingsRows;
    let savedSettings;
    let savedChatProfile;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      settingsRows = await readStore(page, "settings");
      savedSettings = settingsRows.find((row) => row.key === "app-settings");
      savedChatProfile = savedSettings?.modelProfiles?.find((profile) => profile.type === "chat" && profile.model === "deepseek-flash");
      if (savedChatProfile?.encryptedApiKey && savedChatProfile?.apiKeyIv) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    const securitySnapshot = JSON.stringify(settingsRows);
    const saveToast = await page.locator("#toastRoot").innerText().catch(() => "");
    assert.ok(savedChatProfile?.encryptedApiKey && savedChatProfile?.apiKeyIv,
      `API Key should be encrypted inside its model profile; toast=${saveToast}; pageErrors=${pageErrors.join(" | ")}`);
    assert.ok(savedSettings?.cryptoKey, "AES-GCM key should be stored locally");
    assert.ok(!securitySnapshot.includes(apiKey), "Plaintext API Key must never be stored");
    assert.ok(!savedSettings.modelProfiles.some((profile) => profile.encryptedApiKey === apiKey), "Encrypted field must not hold plaintext");

    await page.waitForSelector("#realTestAiBtn:not([disabled])");
    await page.click("#realTestAiBtn");
    try {
      await page.waitForFunction(() => {
        const text = document.getElementById("toastRoot")?.innerText || "";
        return text.includes("模型连接成功") || text.includes("连接测试失败");
      }, null, { timeout: 45_000 });
    } catch (error) {
      const toast = await page.locator("#toastRoot").innerText().catch(() => "");
      throw new Error(`${error.message}; toast=${toast}; failedRequests=${failedRequests.join(" | ")}; pageErrors=${pageErrors.join(" | ")}`);
    }
    const connectionToast = await page.locator("#toastRoot").innerText();
    assert.match(connectionToast, /(?:AI|模型)连接成功/, `Real DeepSeek connection failed: ${connectionToast}`);
    assert.equal(lastRequest(requests, "只回答两个字符")?.model, "deepseek-flash");

    if (siliconflowApiKey) {
      const embeddingResults = await page.evaluate(async (key) => {
        const models = await import("./src/web/deepseek.js");
        const embeddings = await import("./src/web/embeddings.js");
        await models.configureModelProfile({
          id: "starter-bge-m3", label: "免费 BGE-M3", type: "embedding",
          endpoint: "https://api.siliconflow.cn/v1/embeddings", model: "BAAI/bge-m3", apiKey: key,
        });
        const primary = await embeddings.testEmbeddingProfile("starter-bge-m3");
        await models.configureModelProfile({
          id: "starter-bge-m3-pro", label: "BGE-M3 付费备用", type: "embedding",
          endpoint: "https://api.siliconflow.cn/v1/embeddings", model: "Pro/BAAI/bge-m3", apiKey: key,
        });
        const fallback = await embeddings.testEmbeddingProfile("starter-bge-m3-pro");
        return { primary, fallback };
      }, siliconflowApiKey);
      assert.equal(embeddingResults.primary.model, "BAAI/bge-m3");
      assert.equal(embeddingResults.fallback.model, "Pro/BAAI/bge-m3");
      assert.ok(embeddingResults.primary.dimensions > 0 && embeddingResults.fallback.dimensions > 0,
        "Both SiliconFlow embedding profiles should return vectors");
    }

    await page.click('[data-nav="library"]');
    await page.click(`.book-card-item[data-book-id="${bookId}"]`);
    await page.waitForSelector("#bookDetailContinueBtn");
    await page.click("#bookDetailContinueBtn");
    await page.waitForSelector(".real-reader-text p");

    await page.waitForSelector("#readerFullTranslationBtn", { timeout: 10_000 });
    await page.click("#readerFullTranslationBtn");
    await page.waitForSelector(".sentence-translation", { timeout: 90_000 });
    const translations = await readStore(page, "translations");
    assert.ok(translations.length > 0, "Translation should be persisted");
    assert.ok(translations.every((item) => containsChinese(item.translation)), "Translations must be Simplified Chinese");

    await selectFirstParagraph(page);
    const selectedParagraph = await page.locator(".real-reader-text .sentence-original").first().innerText();
    await page.click("#realExplainSelectionBtn");
    await page.fill("#selectionAiQuestion", "只用一句话说明这段话的核心限制。");
    await page.click("#sendSelectionAiBtn");
    await page.waitForSelector(".selection-ai-message", { timeout: 90_000 });
    const selectionAnswer = await page.locator(".selection-ai-message").last().innerText();
    assert.ok(containsChinese(selectionAnswer), "Selection explanation must be Chinese");
    const selectionRequest = lastRequest(requests, "选段讲解助手");
    assert.ok(selectionRequest, "Selection request should reach DeepSeek");
    assert.ok(selectionRequest.user.includes(selectedParagraph.slice(0, 36)), "Only the selected excerpt should be sent");
    assert.ok(!selectionRequest.user.includes(apiKey), "API Key must not be in the message body");

    await page.evaluate(() => {
      window.BianDuFeatures.state.readerExcerptAiOpen = false;
      window.BianDuFeatures.renderApp();
    });
    await page.waitForSelector(".real-reader-text p");
    await selectWord(page, "information");
    await page.waitForSelector("#manualMarkWordBtn");
    await page.click("#manualMarkWordBtn");
    let dictionary = [];
    let information;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      dictionary = await readStore(page, "dictionary");
      information = dictionary.find((entry) => entry.lemma === "information");
      if (information?.definitionZh && containsChinese(information.definitionZh)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    assert.ok(information, `Dictionary row missing; keys: ${dictionary.map((entry) => entry.lemma).join(",")}`);
    assert.ok(containsChinese(information.definitionZh), `Dictionary definition was not Chinese: ${information.definitionZh}`);
    assert.ok(information.partOfSpeech, "Dictionary entry should include part of speech");
    assert.ok(information.occurrences.length > 0, "Dictionary entry should retain its context sentence");

    const ocrImage = await sharp({
      create: { width: 1400, height: 520, channels: 3, background: "#ffffff" },
    }).composite([{
      input: Buffer.from('<svg width="1400" height="520" xmlns="http://www.w3.org/2000/svg"><text x="70" y="160" font-family="Arial" font-size="86" fill="#111111">Information becomes abundant,</text><text x="70" y="285" font-family="Arial" font-size="86" fill="#111111">while attention remains scarce.</text><text x="70" y="410" font-family="Arial" font-size="48" fill="#555555">Deep reading needs deliberate boundaries.</text></svg>'),
    }]).png().toBuffer();
    const ocrResult = await page.evaluate(async (dataUrl) => {
      const module = await import("./src/web/vision.js");
      return module.recognizeScannedPage(dataUrl);
    }, `data:image/png;base64,${ocrImage.toString("base64")}`);
    assert.match(ocrResult.text, /Information/i, `Vision OCR did not preserve English text: ${ocrResult.text}`);
    assert.match(ocrResult.text, /attention/i, `Vision OCR omitted key words: ${ocrResult.text}`);
    assert.ok(ocrResult.confidence >= 0 && ocrResult.confidence <= 1);

    await page.click('[data-nav="board"]');
    await page.waitForSelector("#boardGalleryCreateBtn, #boardGalleryEmptyCreateBtn");
    await page.locator("#boardGalleryCreateBtn, #boardGalleryEmptyCreateBtn").first().click();
    await page.waitForSelector("#bdStage");
    await page.click('[data-board-tool="text"]');
    await page.fill("#boardElementText", "信息充裕 -> 注意力稀缺 -> 深度阅读需要边界");
    await page.click("#saveBoardTextBtn");
    await page.waitForTimeout(300);
    await page.waitForSelector("#recognizeBoardAiBtn");
    await page.click("#recognizeBoardAiBtn");
    let board;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      board = (await readStore(page, "boards")).find((item) => item.elements?.some((element) => element.type === "text"));
      if (board?.ocrMeta?.method === "deepseek-flash" && board.ocrText) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    assert.ok(board?.ocrText, `Board handwriting recognition should persist transcript. Toast: ${await page.locator("#toastRoot").innerText()}`);
    assert.match(board.ocrText, /信息|注意力|阅读/, `Board OCR lost the visible concepts: ${board.ocrText}`);
    assert.equal(board.ocrMeta.method, "deepseek-flash");

    await page.click('[data-nav="library"]');
    await page.waitForSelector("#openImportPdfBtn");
    const booksBeforeScan = new Set((await readStore(page, "books")).map((item) => item.id));
    const scannedChooserPromise = page.waitForEvent("filechooser");
    await page.click("#openImportPdfBtn");
    const scannedChooser = await scannedChooserPromise;
    await scannedChooser.setFiles(scannedPdfPath);
    let scannedBookId = "";
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const imported = (await readStore(page, "books")).find((item) => !booksBeforeScan.has(item.id));
      if (imported) { scannedBookId = imported.id; break; }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    assert.ok(scannedBookId, "Scanned PDF should be imported");
    const scannedCard = page.locator(`.book-card-item[data-book-id="${scannedBookId}"]`);
    await scannedCard.waitFor({ state: "visible", timeout: 30_000 });
    await scannedCard.click();
    await page.waitForSelector("#bookDetailContinueBtn");
    await page.click("#bookDetailContinueBtn");
    await page.waitForSelector("#realOcrPageBtn", { timeout: 30_000 });
    await page.click("#realOcrPageBtn");
    let scannedBook;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      scannedBook = (await readStore(page, "books")).find((item) => item.id === scannedBookId);
      if (scannedBook?.pages?.[0]?.text && scannedBook?.pages?.[0]?.ocrMeta?.method === "deepseek-flash") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    assert.match(scannedBook?.pages?.[0]?.text || "", /Information/i, `Scanned PDF OCR did not create a readable text layer: ${scannedBook?.pages?.[0]?.text || ""}`);
    assert.match(scannedBook.pages[0].text, /attention/i);
    assert.equal(scannedBook.knowledgeProcessing.status, "local-indexed", "New OCR text must invalidate prior knowledge verification");
    await page.waitForSelector("#realOcrCorrectBtn");
    await page.click("#realOcrCorrectBtn");
    const correctedText = `${await page.inputValue("#ocrCorrectionText")}\n人工校对标记`;
    await page.fill("#ocrCorrectionText", correctedText);
    await page.click("#saveOcrCorrectionBtn");
    for (let attempt = 0; attempt < 60; attempt += 1) {
      scannedBook = (await readStore(page, "books")).find((item) => item.id === scannedBookId);
      if (scannedBook?.pages?.[0]?.text?.includes("人工校对标记")) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    assert.match(scannedBook?.pages?.[0]?.text || "", /人工校对标记/, "Manual OCR correction should persist");
    assert.ok(scannedBook?.pages?.[0]?.ocrMeta?.correctedAt, "OCR correction timestamp should be retained");

    await page.click("#readerBackLibraryBtn");
    await page.waitForSelector('[data-nav="settings"]');
    await page.click('[data-nav="settings"]');
    await openSettingsData(page);
    await page.waitForSelector("#settingsProcessKnowledgeBtn");
    await page.click("#settingsProcessKnowledgeBtn");
    let books = [];
    let book;
    for (let attempt = 0; attempt < 480; attempt += 1) {
      books = await readStore(page, "books");
      book = books.find((item) => item.id === bookId);
      if (book?.knowledgeProcessing?.status === "verified" || book?.knowledgeProcessing?.status === "failed") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    assert.equal(book?.knowledgeProcessing?.status, "verified", book?.knowledgeProcessing?.blockedReason || "Knowledge extraction failed");

    const nodes = await readStore(page, "knowledgeNodes");
    const edges = await readStore(page, "knowledgeEdges");
    const allEvidence = await readStore(page, "evidence");
    const bookEvidenceIds = new Set(allEvidence.filter((item) => item.bookId === bookId).map((item) => item.id));
    const summaries = allEvidence.filter((item) => item.kind === "ai-summary" && item.bookId === bookId);
    assert.ok(nodes.length > 0, "Knowledge extraction should create nodes");
    assert.ok(edges.length > 0, "Knowledge extraction should create evidence-backed edges");
    assert.ok(summaries.length > 0, "Knowledge extraction should retain summaries");
    const extractedNodes = nodes.filter((item) => ["concept", "claim", "person", "paper", "passage"].includes(item.kind) &&
      (item.evidenceIds || []).some((id) => bookEvidenceIds.has(id)));
    const extractedEdges = edges.filter((item) => (item.evidenceIds || []).some((id) => bookEvidenceIds.has(id)));
    assert.ok(extractedNodes.length > 0, "Knowledge extraction should add new nodes");
    assert.ok(extractedEdges.length > 0, "Knowledge extraction should add new edges");
    assert.ok(extractedNodes.every((item) => containsChinese(item.title) && containsChinese(item.summary)),
      `Extracted node title and summary should be Chinese: ${extractedNodes.map((item) => `${item.title} => ${item.summary}`).join(" | ")}`);
    assert.ok(extractedEdges.every((item) => containsChinese(item.rationale)),
      `Every AI edge should have a Chinese rationale: ${extractedEdges.map((item) => item.rationale).join(" | ")}`);
    assert.ok(summaries.every((item) => containsChinese(item.excerpt)), "Knowledge summaries should be Chinese");

    await page.click('[data-nav="kb"]');
    await page.waitForSelector("#realKbQuestion");
    await page.fill("#realKbQuestion", "信息供给与人的注意力之间是什么关系？");
    await page.click("#realKbAskBtn");
    await page.waitForSelector(".kb-answer-card", { timeout: 120_000 });
    await page.waitForFunction(() => document.querySelector(".kb-answer-card")?.innerText.includes("已通过逐条证据校验"),
      null, { timeout: 120_000 });
    const kbAnswer = await page.locator(".kb-answer-card").innerText();
    assert.ok(containsChinese(kbAnswer), "Knowledge-base answer should be Chinese");
    assert.match(kbAnswer, /引用|依据/, "Knowledge-base answer must display verified citations");
    assert.match(kbAnswer, /结论与来源类型/, "Knowledge-base answer must display claims and source types");
    const kbRequest = lastRequest(requests, "私人知识库问答助手");
    assert.ok(kbRequest, "Knowledge-base request should reach DeepSeek");
    const kbPayload = JSON.parse(kbRequest.user);
    assert.equal(kbPayload.question, "信息供给与人的注意力之间是什么关系？");
    assert.ok(Array.isArray(kbPayload.evidenceBlocks) && kbPayload.evidenceBlocks.length > 0,
      "Knowledge-base request should contain local evidence blocks");
    assert.ok(kbPayload.evidenceBlocks.every((item) => item.evidenceId && item.excerpt),
      "Every sent evidence block must have an ID and excerpt");
    assert.ok(!kbRequest.user.includes(apiKey), "API Key must not be sent inside the prompt");

    const robustness = await page.evaluate(async () => {
      const module = await import("./src/web/deepseek.js");
      const parsed = module.parseJsonResponse("```json\n{\"ok\":true}\n```");
      let malformedError = "";
      try { module.parseJsonResponse("not-json"); } catch (error) { malformedError = error.message; }
      const originalFetch = window.fetch;
      window.fetch = async () => new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429, headers: { "content-type": "application/json" },
      });
      let httpError = "";
      try { await module.chat([{ role: "user", content: "test" }]); } catch (error) { httpError = error.message; }
      window.fetch = originalFetch;
      return { parsed, malformedError, httpError };
    });
    assert.equal(robustness.parsed.ok, true);
    assert.match(robustness.malformedError, /有效 JSON/);
    assert.match(robustness.httpError, /429/);
    assert.deepEqual(pageErrors, [], `Browser errors: ${pageErrors.join(" | ")}`);

    console.log("Real DeepSeek flash tests passed: connection, selection, translation, dictionary, scanned-page OCR with correction, handwriting board, Chinese knowledge graph, cited QA, encrypted key and error handling.");
    await context.close();
  } finally {
    await browser.close();
  }
} finally {
  if (server) {
    server.kill();
    await new Promise((resolvePromise) => server.once("exit", resolvePromise));
  }
}
