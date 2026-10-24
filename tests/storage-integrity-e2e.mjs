import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const baseUrl = process.env.BIANDU_BASE_URL || "http://127.0.0.1:4173";
const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const serviceWorker = await readFile("www/sw.js", "utf8");
assert.match(serviceWorker, /biandu-shell-[a-f0-9]{12}/, "PWA cache must use a generated content hash");
assert.doesNotMatch(serviceWorker, /__BUILD_ID__/, "PWA cache token was not replaced");

const manifest = await readFile("android/app/src/main/AndroidManifest.xml", "utf8");
assert.match(manifest, /android:allowBackup="false"/, "Android system backup must stay disabled");
assert.match(manifest, /android:fullBackupContent="false"/, "Android full backup must stay disabled");
assert.match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/, "Android extraction rules must be installed");

const browser = await chromium.launch({ headless: true, executablePath: edgePath });

async function seed(page, recordsByStore) {
  await page.evaluate(async (seedData) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("biandu-local-v1", 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const names = Object.keys(seedData);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(names, "readwrite");
      for (const name of names) {
        for (const record of seedData[name]) tx.objectStore(name).put(record);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, recordsByStore);
}

async function readAll(page, storeName) {
  return page.evaluate(async (name) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("biandu-local-v1", 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = await new Promise((resolve, reject) => {
      const request = db.transaction(name, "readonly").objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return result;
  }, storeName);
}

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    hasTouch: true,
    serviceWorkers: "allow",
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.BianDuFeatures && window.BianDuRuntime);

  // A translation replacement must leave the previous page untouched if any
  // part of the new batch cannot be committed.
  await seed(page, {
    translations: [{
      id: "old-translation", bookId: "book-transaction", page: 1,
      original: "Original", translation: "旧译文", segmentIndex: 0,
    }],
  });
  const translationFailure = await page.evaluate(async () => {
    const repository = await import("/src/web/repository.js");
    try {
      await repository.replaceTranslationsForPage("book-transaction", 1, [{
        id: "new-translation", bookId: "book-transaction", page: 1,
        original: "Original", translation: "新译文", invalid: () => "not-cloneable",
      }]);
      return "unexpected-success";
    } catch (error) {
      return error.name || error.message;
    }
  });
  assert.notEqual(translationFailure, "unexpected-success");
  const translations = await readAll(page, "translations");
  assert.deepEqual(translations.map((item) => item.id), ["old-translation"], "failed translation replacement must roll back");

  // File deletion and the book's originalDeleted marker must commit together.
  await seed(page, {
    books: [{ id: "book-retention", source: "local-pdf", title: "Retention", page: 1, pages: [{ number: 1, text: "x" }] }],
    files: [{ id: "book-retention", blob: new Blob(["pdf-bytes"]) }],
  });
  const retentionFailure = await page.evaluate(async () => {
    const repository = await import("/src/web/repository.js");
    try {
      await repository.deleteFileAndUpdateBook("book-retention", {
        id: "book-retention", source: "local-pdf", invalid: () => "not-cloneable",
      });
      return "unexpected-success";
    } catch (error) {
      return error.name || error.message;
    }
  });
  assert.notEqual(retentionFailure, "unexpected-success");
  const retentionFiles = await readAll(page, "files");
  assert.ok(retentionFiles.some((item) => item.id === "book-retention"), "aborted cleanup must keep the original file");

  // Restoring a stale backup is a merge. Local newer notes, local-only notes,
  // unique knowledge titles and encrypted API settings must survive unchanged.
  await seed(page, {
    notes: [
      { id: "note-shared", bookId: "book-backup", page: 1, text: "本机新笔记", createdAt: "2026-10-20T10:00:00.000Z" },
      { id: "note-local-only", bookId: "book-backup", page: 2, text: "只在本机", createdAt: "2026-10-21T10:00:00.000Z" },
    ],
    knowledgeNodes: [
      { id: "node-local", title: "同一主题", titleKey: "同一主题", kind: "concept", updatedAt: "2026-10-20T10:00:00.000Z" },
    ],
    settings: [{ key: "app-settings", apiKeyCipher: { ciphertext: "encrypted-local-key" } }],
  });
  const restoreResult = await page.evaluate(async () => {
    const maintenance = await import("/src/web/maintenance.js");
    return maintenance.restoreBackup({
      format: "biandu-backup",
      version: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      data: {
        notes: [
          { id: "note-shared", bookId: "book-backup", page: 1, text: "旧备份笔记", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "note-from-backup", bookId: "book-backup", page: 3, text: "备份新增", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
        knowledgeNodes: [
          { id: "node-backup", title: "同一主题", titleKey: "同一主题", kind: "concept", updatedAt: "2026-09-01T00:00:00.000Z" },
        ],
      },
    });
  });
  assert.equal(restoreResult.stores.notes.keptLocal, 1);
  assert.equal(restoreResult.stores.notes.inserted, 1);
  assert.equal(restoreResult.stores.knowledgeNodes.keptLocal, 1);

  const [notes, nodes, settings] = await Promise.all([
    readAll(page, "notes"), readAll(page, "knowledgeNodes"), readAll(page, "settings"),
  ]);
  assert.equal(notes.find((item) => item.id === "note-shared")?.text, "本机新笔记");
  assert.ok(notes.some((item) => item.id === "note-local-only"), "restore must not delete local-only records");
  assert.ok(notes.some((item) => item.id === "note-from-backup"), "restore must add missing backup records");
  assert.equal(nodes.filter((item) => item.titleKey === "同一主题").length, 1, "restore must not violate the unique title index");
  assert.equal(nodes[0].id, "node-local");
  assert.equal(settings[0].apiKeyCipher.ciphertext, "encrypted-local-key");

  const exported = await page.evaluate(async () => {
    const maintenance = await import("/src/web/maintenance.js");
    return maintenance.exportBackup();
  });
  assert.equal(exported.version, 2);
  assert.equal(exported.data.settings, undefined, "backup must never contain encrypted settings or API-key metadata");

  // A failed evidence/knowledge write must not prevent the canvas itself from
  // being persisted. This simulates quota or indexing corruption.
  const boardResult = await page.evaluate(async () => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function put(value, key) {
      if (this.name === "evidence" && String(value?.id || "").startsWith("evidence-board-")) {
        throw new DOMException("Injected evidence write failure", "QuotaExceededError");
      }
      return originalPut.call(this, value, key);
    };
    try {
      const created = await window.BianDuRuntime.app.board.createBoard({
        bookId: "book-board", page: 1, quote: "画板故障注入", title: "故障注入画板",
      });
      return { id: created.id };
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
  });
  const boards = await readAll(page, "boards");
  assert.ok(boards.some((item) => item.id === boardResult.id), "canvas must be saved before best-effort knowledge indexing");

  // Reading position is synchronously journaled and immediately committed. A
  // reload at the same moment must still reopen at the page just selected.
  await seed(page, {
    books: [{
      id: "book-progress", source: "local-pdf", title: "阅读位置测试", author: "BianDu",
      page: 1, progress: 0, totalPages: 3, importedAt: "2026-10-20T00:00:00.000Z",
      lastRead: "刚刚", bookmarks: [], annotations: 0, readingSeconds: 0,
      pages: [1, 2, 3].map((number) => ({
        number, text: `第 ${number} 页测试内容`, readingBlocks: [{ type: "paragraph", text: `第 ${number} 页测试内容` }],
      })),
    }],
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => window.BianDuFeatures?.books?.some((book) => book.id === "book-progress"));
  await page.evaluate(() => {
    const features = window.BianDuFeatures;
    Object.assign(features.state, {
      currentView: "reader", activeBookId: "book-progress", readerPage: 1,
      readerTotalPages: 3, readerWordPopupOpen: false, readerViewMode: "original",
    });
    features.renderApp();
  });
  await page.waitForSelector("#realNextPageBtn");
  await page.click("#realNextPageBtn");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => window.BianDuFeatures?.books?.some((book) => book.id === "book-progress"));
  const reopenedPage = await page.evaluate(() => window.BianDuFeatures.books.find((book) => book.id === "book-progress")?.page);
  assert.equal(reopenedPage, 2, "reading position must survive an immediate reload");

  assert.deepEqual(pageErrors, [], `unexpected page errors: ${pageErrors.join("; ")}`);
  console.log("storage-integrity-e2e: all durability and recovery checks passed");
} finally {
  await browser.close();
}
