import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.BIANDU_BASE_URL || "http://127.0.0.1:4173";
const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const pdfPath = resolve("tests/fixtures/reading-sample.pdf");
const chatKey = "test-only-dummy-key-123456789";
const secondChatKey = "test-only-dummy-key-123456789";
const embeddingKey = "test-only-dummy-key-123456789";

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

async function appSettings(page) {
  return (await readStore(page, "settings")).find((row) => row.key === "app-settings");
}

async function waitForToast(page, text, timeout = 20_000) {
  await page.waitForFunction((expected) => document.getElementById("toastRoot")?.innerText.includes(expected),
    text, { timeout });
}

async function fillVisibleProfile(page, profile) {
  assert.equal(await page.locator("#realAiLabel").count(), 0, "Model IDs replace custom display names");
  await page.selectOption("#realAiType", profile.type || "chat");
  await page.fill("#realAiEndpoint", profile.endpoint);
  await page.fill("#realAiModel", profile.model);
  await page.fill("#realAiKey", profile.key);
}

async function openSettingsData(page) {
  await page.evaluate(() => {
    const details = document.querySelector(".settings-data");
    if (!details) return;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

const browser = await chromium.launch({ headless: true, executablePath: edgePath });

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    hasTouch: true,
    serviceWorkers: "block",
  });
  const requests = [];
  let failPrimaryAll = false;

  function mockVectors(input, payload) {
    const texts = Array.isArray(input) ? input : [input];
    return texts.map((text, index) => ({
      index,
      embedding: [1, String(text).length % 7, index + 1, payload.model.length % 5, 0.25, 0.125, 0.0625, 0.03125],
    }));
  }

  await context.route(`${baseUrl}/mock-chat`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
      return;
    }
    const payload = route.request().postDataJSON();
    requests.push({ kind: "chat", body: payload });
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify({ choices: [{ message: { content: "正常" } }] }),
    });
  });
  await context.route(`${baseUrl}/mock-embed-primary`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
      return;
    }
    const payload = route.request().postDataJSON();
    requests.push({ kind: "embedding-primary", body: payload });
    const texts = Array.isArray(payload.input) ? payload.input : [payload.input];
    if (failPrimaryAll || texts.some((text) => String(text).includes("__force_rate_limit__"))) {
      await route.fulfill({
        status: 429,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*", "retry-after": "0" },
        body: JSON.stringify({ error: { message: "免费额度限流，请稍后再试" } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify({ data: mockVectors(payload.input, payload), model: payload.model }),
    });
  });
  await context.route(`${baseUrl}/mock-embed-fallback`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
      return;
    }
    const payload = route.request().postDataJSON();
    requests.push({ kind: "embedding-fallback", body: payload });
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify({ data: mockVectors(payload.input, payload), model: payload.model }),
    });
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const chooserPromise = page.waitForEvent("filechooser");
  await page.click("#openImportPdfBtn");
  const chooser = await chooserPromise;
  await chooser.setFiles(pdfPath);
  await page.locator('.book-card-item[data-book-id^="pdf-"]').first().waitFor({ state: "visible", timeout: 30_000 });
  let evidenceBefore = [];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    evidenceBefore = await readStore(page, "evidence");
    if (evidenceBefore.some((item) => item.permanent)) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  assert.ok(evidenceBefore.some((item) => item.permanent), "Imported PDF should create permanent evidence");

  await page.click('[data-nav="settings"]');
  await page.waitForSelector('[data-edit-model-profile="builtin-deepseek-flash"]');
  const builtinState = await page.evaluate(async () => {
    const { BUILTIN_MODELS } = await import("./src/web/builtin-models.generated.js");
    const store = await readSettingsRows();
    const settings = store.find((row) => row.key === "app-settings");
    const serialized = JSON.stringify(settings);
    return {
      ids: settings.modelProfiles.map((profile) => profile.id),
      leaked: BUILTIN_MODELS.filter((profile) => serialized.includes(profile.apiKey)).map((profile) => profile.id),
      hasTemperatureInput: Boolean(document.querySelector("#realAiTemperature")),
    };
    async function readSettingsRows() {
      const db = await new Promise((resolveDb, reject) => {
        const request = indexedDB.open("biandu-local-v1", 4);
        request.onsuccess = () => resolveDb(request.result);
        request.onerror = () => reject(request.error);
      });
      return new Promise((resolveRows, reject) => {
        const request = db.transaction("settings", "readonly").objectStore("settings").getAll();
        request.onsuccess = () => resolveRows(request.result);
        request.onerror = () => reject(request.error);
      });
    }
  });
  assert.deepEqual(builtinState.ids, [
    "builtin-deepseek-flash", "builtin-siliconflow-bge-m3", "builtin-qwen-mt-flash",
  ]);
  assert.deepEqual(builtinState.leaked, [], "Built-in API keys must be stored AES-GCM encrypted");
  assert.equal(builtinState.hasTemperatureInput, false);
  const unconfiguredRoleOptions = await page.locator('[data-model-role="translation"] option').allTextContents();
  assert.deepEqual(unconfiguredRoleOptions, [
    "未指定", "deepseek-flash · api.deepseek.com", "qwen-mt-flash · dashscope.aliyuncs.com",
  ],
    "Function selectors must offer working built-in models and hide unavailable ones");
  await page.click('[data-edit-model-profile="builtin-deepseek-flash"]');
  const editorPlacement = await page.evaluate(() => {
    const editor = document.querySelector(".model-editor");
    const entry = editor?.closest(".model-profile-entry");
    return {
      profileId: entry?.getAttribute("data-profile-anchor"),
      editorIsInsideEntry: Boolean(editor && entry),
      rowTop: entry?.getBoundingClientRect().top,
    };
  });
  assert.equal(editorPlacement.editorIsInsideEntry, true,
    "The editor must expand inside the selected model row");
  assert.equal(editorPlacement.profileId, "builtin-deepseek-flash");
  await fillVisibleProfile(page, {
    endpoint: `${baseUrl}/mock-chat`, model: "chat-model-a", key: chatKey,
  });
  await page.click("#realSaveAiBtn");
  await waitForToast(page, "模型档案和密钥已加密保存在本机");
  await page.waitForFunction(() => !document.querySelector(".model-editor"));
  const rowTopAfterSave = await page.locator('[data-profile-anchor="builtin-deepseek-flash"]').evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  assert.ok(Math.abs(rowTopAfterSave - editorPlacement.rowTop) <= 2,
    "Saving a model must preserve the edited row position");

  let settings = await appSettings(page);
  const savedChat = settings.modelProfiles.find((profile) => profile.id === "builtin-deepseek-flash");
  assert.equal(savedChat.label, "chat-model-a");
  assert.equal(savedChat.model, "chat-model-a");
  assert.ok(savedChat.encryptedApiKey && savedChat.apiKeyIv, "API Key should be encrypted");
  assert.equal("cryptoKey" in savedChat, false, "AES key must live at the app-settings level");
  assert.ok(settings.cryptoKey, "AES key should be persisted at app-settings level");
  assert.ok(!JSON.stringify(settings).includes(chatKey), "Plaintext key must never be stored");
  const configuredRoleOptions = await page.locator('[data-model-role="translation"] option').allTextContents();
  assert.deepEqual(configuredRoleOptions, [
    "未指定", "chat-model-a · 127.0.0.1:4173", "qwen-mt-flash · dashscope.aliyuncs.com",
  ],
    "Function selector should list the configured model by its real ID");

  await page.click('[data-edit-model-profile="builtin-deepseek-flash"]');
  await page.waitForSelector("#realTestAiBtn");
  const rowTopBeforeTest = await page.locator('[data-profile-anchor="builtin-deepseek-flash"]').evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  await page.click("#realTestAiBtn");
  await waitForToast(page, "模型连接成功");
  await page.waitForFunction(() => !document.querySelector(".model-editor"));
  const rowTopAfterTest = await page.locator('[data-profile-anchor="builtin-deepseek-flash"]').evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  assert.ok(Math.abs(rowTopAfterTest - rowTopBeforeTest) <= 2,
    "A successful connection test must close the editor without moving the model row");

  await page.click("#realAddModelProfileBtn");
  await fillVisibleProfile(page, {
    endpoint: `${baseUrl}/mock-chat`, model: "chat-model-b", key: secondChatKey,
  });
  await page.click("#realSaveAiBtn");
  await waitForToast(page, "模型档案和密钥已加密保存在本机");
  settings = await appSettings(page);
  const secondChat = settings.modelProfiles.find((profile) => profile.model === "chat-model-b");
  assert.ok(secondChat, "New model profile should be persisted");
  assert.ok(!JSON.stringify(settings).includes(secondChatKey), "Second plaintext key must never be stored");

  await page.selectOption('[data-model-role="translation"]', secondChat.id);
  await waitForToast(page, "功能模型已更新");
  assert.equal((await appSettings(page)).modelBindings.translation, secondChat.id);

  await page.reload({ waitUntil: "networkidle" });
  await page.click('[data-nav="settings"]');
  await page.waitForSelector("#realAddModelProfileBtn");
  const keyState = await page.evaluate(async () => {
    const module = await import("./src/web/deepseek.js");
    return {
      translation: await module.hasApiKey("translation"),
      settings: await module.getAiSettings(),
    };
  });
  assert.equal(keyState.translation, true, "Encrypted key should still decrypt after a page reload");
  assert.equal(keyState.settings.bindings.translation, secondChat.id);

  const evidenceBeforeDelete = await readStore(page, "evidence");
  await page.click(`[data-edit-model-profile="${secondChat.id}"]`);
  await page.click(`[data-delete-model-profile="${secondChat.id}"]`);
  await waitForToast(page, "模型档案已删除");
  assert.equal((await readStore(page, "evidence")).length, evidenceBeforeDelete.length,
    "Deleting a model profile must not delete permanent user knowledge");

  await page.click('[data-edit-model-profile="builtin-siliconflow-bge-m3"]');
  await fillVisibleProfile(page, {
    type: "embedding", endpoint: `${baseUrl}/mock-embed-primary`,
    model: "BAAI/bge-m3", key: embeddingKey,
  });
  await page.click("#realSaveAiBtn");
  await waitForToast(page, "模型档案和密钥已加密保存在本机");

  await page.click("#realAddModelProfileBtn");
  await fillVisibleProfile(page, {
    type: "embedding", endpoint: `${baseUrl}/mock-embed-fallback`,
    model: "Pro/BAAI/bge-m3", key: embeddingKey,
  });
  await page.click("#realSaveAiBtn");
  await waitForToast(page, "模型档案和密钥已加密保存在本机");
  settings = await appSettings(page);
  const embeddingFallback = settings.modelProfiles.find((profile) => profile.model === "Pro/BAAI/bge-m3");
  assert.ok(embeddingFallback?.id);

  await page.selectOption('[data-model-role="embedding"]', "builtin-siliconflow-bge-m3");
  await page.selectOption('[data-model-role="embeddingFallback"]', embeddingFallback.id);
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.getElementById("toastRoot").textContent = ""; });
  await openSettingsData(page);
  await page.click("#settingsRebuildEmbeddingsBtn");
  await waitForToast(page, "语义索引完成", 30_000);

  settings = await appSettings(page);
  assert.equal(settings.semanticIndex.profileId, "builtin-siliconflow-bge-m3");
  assert.equal(settings.semanticIndex.fallbackUsed, false);
  assert.ok((await readStore(page, "embeddings")).every((item) => item.profileId === "builtin-siliconflow-bge-m3"));

  const automaticFallback = await page.evaluate(async () => {
    const embeddings = await import("./src/web/embeddings.js");
    const repository = await import("./src/web/repository.js");
    const evidence = await repository.getAll("evidence");
    const result = await embeddings.getSemanticScores("__force_rate_limit__", evidence);
    return { profileId: result?.profile?.id, scoreCount: result?.scores?.size || 0 };
  });
  assert.equal(automaticFallback.profileId, embeddingFallback.id);
  assert.ok(automaticFallback.scoreCount > 0, "Rate-limited query should rebuild with the fallback embedding model");
  settings = await appSettings(page);
  assert.equal(settings.semanticIndex.profileId, embeddingFallback.id);
  assert.equal(settings.semanticIndex.fallbackUsed, true);
  assert.ok(requests.some((item) => item.kind === "embedding-primary"));
  assert.ok(requests.some((item) => item.kind === "embedding-fallback"));

  const embeddings = await readStore(page, "embeddings");
  assert.ok(embeddings.length > 0, "Fallback embedding should create local vectors");
  const modelByProfile = {
    "builtin-siliconflow-bge-m3": "BAAI/bge-m3", [embeddingFallback.id]: "Pro/BAAI/bge-m3",
  };
  assert.ok(embeddings.every((item) => item.model === modelByProfile[item.profileId]),
    "Every vector record must stay bound to the exact model that generated it");
  assert.ok(embeddings.some((item) => item.profileId === embeddingFallback.id),
    "Fallback query should create a fallback-model index");
  const indexedCount = embeddings.length;

  failPrimaryAll = true;
  await page.evaluate(() => { document.getElementById("toastRoot").textContent = ""; });
  await openSettingsData(page);
  await page.click("#settingsRebuildEmbeddingsBtn");
  await waitForToast(page, "语义索引完成", 30_000);
  assert.equal((await readStore(page, "embeddings")).length, indexedCount,
    "Rebuilding an index must not duplicate records");
  assert.deepEqual(pageErrors, [], `Browser errors: ${pageErrors.join(" | ")}`);

  console.log("Configurable model profiles passed: encrypted keys, reload, role binding, profile deletion, semantic fallback and index deduplication.");
  await context.close();
} finally {
  await browser.close();
}
