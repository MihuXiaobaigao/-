/*! Local-first reading MVP: PDF import, IndexedDB, progress, notes and highlights. */

(function installReadingFeatures() {
  "use strict";

  const DB_NAME = "biandu-local-v1";
  const DB_VERSION = 4;
  const STATS_KEY = "biandu.reading-stats.v1";
  const PROGRESS_JOURNAL_KEY = "biandu.progress-journal.v1";
  const READER_SCROLL_KEY = "biandu.reader-scroll.v1";
  const READER_ANCHOR_KEY = "biandu.reader-anchor.v2";
  const READER_PREFS_KEY = "biandu.reader-preferences.v1";
  const DND_PROMPT_KEY = "biandu.dnd-permission-prompt.v1";
  const DND_PROMPT_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
  const PDFJS_URL = new URL("./vendor/pdfjs/pdf.min.mjs", window.location.href);
  const PDF_BASE_URL = new URL("./vendor/pdfjs/", window.location.href);
  const PDF_LAYOUT_URL = new URL("./src/web/pdf-layout.js", window.location.href);
  const MIN_READING_LAYOUT_VERSION = 8;
  const VISUAL_REGION_VERSION = 5;

  let dbPromise = null;
  let pdfjsPromise = null;
  let pdfLayoutPromise = null;
  let readingLayoutMigrationStarted = false;
  let fileInput = null;
  let activeTimerStartedAt = Date.now();
  let progressSaveTimer = null;
  let progressSaveChain = Promise.resolve();
  let readingClockVisible = document.visibilityState === "visible";
  let storageHealthCache = null;
  const pendingProgressSaves = new Map();
  const visualRegionCache = new Map();
  const notesByPage = new Map();
  const notesLoading = new Set();
  let pendingNoteImages = [];
  let readerNotesRefreshTimer = null;
  let dndPermissionPrompted = false;

  const READER_PREFERENCE_DEFAULTS = Object.freeze({
    readerFont: "serif",
    readerFontSize: 19,
    readerLineHeight: 1.68,
    readerParaSpacing: 18,
    readerContentWidth: 920,
    readerMargin: "standard",
    readerTextColor: "#1F2522",
    readerTheme: "white",
    readerBrightness: 98
  });

  function restoreReaderPreferences() {
    try {
      const saved = JSON.parse(localStorage.getItem(READER_PREFS_KEY) || "{}");
      if (["serif", "sans", "humanist"].includes(saved.readerFont)) STATE.readerFont = saved.readerFont;
      if (Number.isFinite(Number(saved.readerFontSize))) {
        STATE.readerFontSize = Math.max(15, Math.min(30, Math.round(Number(saved.readerFontSize))));
      }
      if (Number.isFinite(Number(saved.readerLineHeight))) {
        STATE.readerLineHeight = Math.max(1.4, Math.min(2.2, Number(saved.readerLineHeight)));
      }
      if (Number.isFinite(Number(saved.readerParaSpacing))) {
        STATE.readerParaSpacing = Math.max(12, Math.min(42, Math.round(Number(saved.readerParaSpacing))));
      }
      if (Number.isFinite(Number(saved.readerContentWidth))) {
        STATE.readerContentWidth = Math.max(760, Math.min(1120, Math.round(Number(saved.readerContentWidth))));
      }
      if (["narrow", "standard", "wide"].includes(saved.readerMargin)) STATE.readerMargin = saved.readerMargin;
      if (/^#[0-9A-Fa-f]{6}$/.test(String(saved.readerTextColor || ""))) {
        STATE.readerTextColor = saved.readerTextColor;
      }
      if (["white", "beige", "green", "night"].includes(saved.readerTheme)) STATE.readerTheme = saved.readerTheme;
      if (Number.isFinite(Number(saved.readerBrightness))) {
        STATE.readerBrightness = Math.max(70, Math.min(110, Number(saved.readerBrightness)));
      }
    } catch {
      Object.assign(STATE, READER_PREFERENCE_DEFAULTS);
    }
  }

  function saveReaderPreferences() {
    try {
      localStorage.setItem(READER_PREFS_KEY, JSON.stringify({
        readerFont: STATE.readerFont,
        readerFontSize: STATE.readerFontSize,
        readerLineHeight: STATE.readerLineHeight,
        readerParaSpacing: STATE.readerParaSpacing,
        readerContentWidth: STATE.readerContentWidth,
        readerMargin: STATE.readerMargin,
        readerTextColor: STATE.readerTextColor,
        readerTheme: STATE.readerTheme,
        readerBrightness: STATE.readerBrightness
      }));
    } catch { /* Reading remains available when preferences cannot be stored. */ }
  }

  restoreReaderPreferences();

  function dndPromptIsDue() {
    try {
      const lastPromptedAt = Number(localStorage.getItem(DND_PROMPT_KEY) || 0);
      return !Number.isFinite(lastPromptedAt) || !lastPromptedAt ||
        Date.now() - lastPromptedAt >= DND_PROMPT_INTERVAL_MS;
    } catch {
      return false;
    }
  }

  function markDndPrompted() {
    try { localStorage.setItem(DND_PROMPT_KEY, String(Date.now())); }
    catch { /* The in-memory guard still prevents repeated prompts this session. */ }
  }

  async function setReaderFocusMode(enabled) {
    document.body.classList.toggle("reader-immersive", Boolean(enabled));
    document.documentElement.classList.toggle("reader-immersive-root", Boolean(enabled));

    try {
      if (enabled && document.fullscreenEnabled && !document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else if (!enabled && document.fullscreenElement) {
        await document.exitFullscreen();
      }
    } catch { /* Native Android immersive mode remains the primary path. */ }

    const plugin = globalThis.Capacitor?.Plugins?.BianduFocus;
    if (!plugin) return;
    try {
      if (enabled) {
        const result = await plugin.enterFocusMode();
        if (result?.dndAccess !== true && result?.needsDndAccess &&
            !dndPermissionPrompted && dndPromptIsDue()) {
          dndPermissionPrompted = true;
          markDndPrompted();
          showToast("请在系统设置中允许便读开启勿扰模式，屏蔽阅读时的其他通知");
          window.setTimeout(() => plugin.openDndSettings?.().catch(() => {}), 350);
        }
      } else {
        await plugin.exitFocusMode();
      }
    } catch (error) {
      console.warn("Could not update Android focus mode", error);
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function readerActionIcon(name) {
    const common = 'width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
    if (name === "settings") return String(ICONS.settings || "").replace("<svg ", `<svg ${common} `);
    if (name === "translate") return `<svg ${common}><path d="M4 5h8M8 3v2M5 8.5c1.4 2.4 3.5 4 6.3 4.8M11 5c-.6 3.1-2.7 5.6-6.3 7.4"/><path d="M14 20l3.5-9 3.5 9M15.3 17h4.4"/></svg>`;
    if (name === "dictionary") return `<svg ${common}><path d="M4 4.5h5A3 3 0 0 1 12 7v13H7a3 3 0 0 1-3-3z"/><path d="M20 4.5h-5A3 3 0 0 0 12 7v13h5a3 3 0 0 0 3-3z"/><path d="M7.5 9H10M14 9h2M7.5 12H10M14 12h2"/></svg>`;
    if (name === "pdf") return `<svg ${common}><path d="M3.5 5.5A8.2 8.2 0 0 1 12 7v12a8.2 8.2 0 0 0-8.5-1.5z"/><path d="M20.5 5.5A8.2 8.2 0 0 0 12 7v12a8.2 8.2 0 0 1 8.5-1.5z"/></svg>`;
    if (name === "note") return `<svg ${common}><rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>`;
    if (name === "full-translation") return `<svg ${common}><path d="M5 3.5h6l3 3v14H5z"/><path d="M11 3.5v3h3"/><path d="M7.5 8.5h3M9 7v1.5M7.5 11c.7 1.1 1.7 1.8 3 2.3"/><path d="M16 9h4M18 9v2.5c0 2-1 3.7-2.8 5M16.5 13c.8 1.4 2 2.4 3.5 3"/></svg>`;
    if (name === "pen") return `<svg ${common}><path d="M17.8 3.2a2.1 2.1 0 0 1 3 3L8.5 18.5 4 20l1.5-4.5z"/><path d="M14.8 6.2l3 3"/></svg>`;
    if (name === "highlighter") return `<svg ${common}><path d="M14.5 3.5l6 6-8.8 8.8H6v-5.7z"/><path d="M4 21h9M14.4 5.1l4.5 4.5"/></svg>`;
    if (name === "eraser") return `<svg ${common}><path d="M18 20H8.5l-4.7-4.7a2 2 0 0 1 0-2.8L12 4.3a2 2 0 0 1 2.8 0l4.9 4.9a2 2 0 0 1 0 2.8L12 19.7"/><path d="M9.5 7.2l7.3 7.3"/></svg>`;
    if (name === "undo") return `<svg ${common}><path d="M9 7L4 12l5 5"/><path d="M4 12h9a6 6 0 0 1 6 6v1"/></svg>`;
    if (name === "text-reader") return `<svg ${common}><path d="M6 3.5h8l4 4V20H6z"/><path d="M14 3.5v4h4M9 11h6M9 14h6M9 17h4"/></svg>`;
    return "";
  }

  function normalizeWord(value) {
    return String(value)
      .normalize("NFKC")
      .replaceAll("’", "'")
      .toLocaleLowerCase("en")
      .replace(/^[^\p{Script=Latin}'-]+|[^\p{Script=Latin}'-]+$/gu, "");
  }

  function makeId(prefix) {
    if (window.crypto?.randomUUID) {
      return `${prefix}-${window.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function openDatabase() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains("books")) {
          const books = db.createObjectStore("books", { keyPath: "id" });
          books.createIndex("byHash", "fileHash", { unique: false });
          books.createIndex("byImportedAt", "importedAt", { unique: false });
        }

        if (!db.objectStoreNames.contains("files")) {
          db.createObjectStore("files", { keyPath: "id" });
        }

        if (!db.objectStoreNames.contains("notes")) {
          const notes = db.createObjectStore("notes", { keyPath: "id" });
          notes.createIndex("byBookAndPage", ["bookId", "page"], {
            unique: false
          });
        }

        if (!db.objectStoreNames.contains("dictionary")) {
          const dictionary = db.createObjectStore("dictionary", {
            keyPath: "lemma"
          });
          dictionary.createIndex("byLastMarkedAt", "lastMarkedAt", {
            unique: false
          });
        }

        if (!db.objectStoreNames.contains("boards")) {
          const boards = db.createObjectStore("boards", { keyPath: "id" });
          boards.createIndex("byBookAndPage", ["bookId", "page"], { unique: false });
          boards.createIndex("byUpdatedAt", "updatedAt", { unique: false });
        }

        if (!db.objectStoreNames.contains("assets")) {
          const assets = db.createObjectStore("assets", { keyPath: "id" });
          assets.createIndex("byCreatedAt", "createdAt", { unique: false });
        }

        if (!db.objectStoreNames.contains("evidence")) {
          const evidence = db.createObjectStore("evidence", { keyPath: "id" });
          evidence.createIndex("byBookAndPage", ["bookId", "page"], { unique: false });
          evidence.createIndex("byKind", "kind", { unique: false });
          evidence.createIndex("byCreatedAt", "capturedAt", { unique: false });
        }

        if (!db.objectStoreNames.contains("knowledgeNodes")) {
          const nodes = db.createObjectStore("knowledgeNodes", { keyPath: "id" });
          nodes.createIndex("byTitleKey", "titleKey", { unique: true });
          nodes.createIndex("byUpdatedAt", "updatedAt", { unique: false });
        }

        if (!db.objectStoreNames.contains("knowledgeEdges")) {
          const edges = db.createObjectStore("knowledgeEdges", { keyPath: "id" });
          edges.createIndex("byFrom", "fromNodeId", { unique: false });
          edges.createIndex("byTo", "toNodeId", { unique: false });
        }

        if (!db.objectStoreNames.contains("conversations")) {
          const conversations = db.createObjectStore("conversations", { keyPath: "id" });
          conversations.createIndex("byUpdatedAt", "updatedAt", { unique: false });
          conversations.createIndex("byScope", "scope", { unique: false });
        }

        if (!db.objectStoreNames.contains("translations")) {
          const translations = db.createObjectStore("translations", { keyPath: "id" });
          translations.createIndex("byBookAndPage", ["bookId", "page"], { unique: false });
        }

        if (!db.objectStoreNames.contains("embeddings")) {
          const embeddings = db.createObjectStore("embeddings", { keyPath: "id" });
          embeddings.createIndex("byModel", "model", { unique: false });
          embeddings.createIndex("byEvidenceId", "evidenceId", { unique: false });
        }

        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "key" });
        }
      };

      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          dbPromise = null;
        };
        resolve(database);
      };
      request.onerror = () => reject(request.error);
    });

    return dbPromise;
  }

  async function getAll(storeName) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db
        .transaction(storeName, "readonly")
        .objectStore(storeName)
        .getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getRecord(storeName, key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db
        .transaction(storeName, "readonly")
        .objectStore(storeName)
        .get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function putRecord(storeName, value) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function deleteRecord(storeName, key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function putImportedBook(fileRecord, bookRecord) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["books", "files"], "readwrite");
      tx.objectStore("books").put(bookRecord);
      tx.objectStore("files").put(fileRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function saveNoteBundle(assetRecords, noteRecord, evidenceRecord) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["assets", "notes", "evidence", "books"], "readwrite");
      const assets = tx.objectStore("assets");
      for (const asset of assetRecords) assets.put(asset);
      tx.objectStore("notes").put(noteRecord);
      tx.objectStore("evidence").put(evidenceRecord);
      const bookRequest = tx.objectStore("books").get(noteRecord.bookId);
      bookRequest.onsuccess = () => {
        if (!bookRequest.result) return;
        tx.objectStore("books").put({
          ...bookRequest.result,
          annotations: Number(bookRequest.result.annotations || 0) + 1
        });
      };
      bookRequest.onerror = () => tx.abort();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("笔记保存事务失败。"));
      tx.onabort = () => reject(tx.error || new Error("笔记保存事务已中止。"));
    });
  }

  function isImportedBook(book) {
    return Boolean(book && book.source === "local-pdf");
  }

  async function loadPdfJs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(PDFJS_URL.href).then(module => {
        module.GlobalWorkerOptions.workerSrc = new URL(
          "./pdf.worker.min.mjs",
          PDF_BASE_URL
        ).href;
        return module;
      });
    }
    return pdfjsPromise;
  }

  function loadPdfLayout() {
    if (!pdfLayoutPromise) {
      pdfLayoutPromise = import(PDF_LAYOUT_URL.href);
    }
    return pdfLayoutPromise;
  }

  function hashToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function cleanMetadataText(value, fallback) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text || fallback;
  }

  function fileTitle(file) {
    return file.name
      .replace(/\.pdf$/i, "")
      .replace(/[_-]+/g, " ")
      .trim() || "未命名 PDF";
  }

  function extractTextFromContent(content) {
    const items = (content.items || []).filter(
      item => item.str && item.str.trim()
    );
    if (!items.length) return "";

    const lines = [];
    let current = null;

    for (const item of items) {
      const x = Number(item.transform?.[4] || 0);
      const y = Number(item.transform?.[5] || 0);
      const height = Math.abs(
        Number(item.height || item.transform?.[3] || 10)
      );
      const lastLine = lines.at(-1);
      const sameLine =
        lastLine && Math.abs(lastLine.y - y) <= Math.max(2.5, height * 0.35);

      if (!sameLine) {
        current = { y, height, parts: [{ x, text: item.str }] };
        lines.push(current);
      } else {
        current.parts.push({ x, text: item.str });
      }
    }

    const renderedLines = lines
      .sort((a, b) => b.y - a.y)
      .map(line => {
        const parts = line.parts.sort((a, b) => a.x - b.x);
        let output = "";
        for (const part of parts) {
          const piece = part.text.replace(/\s+/g, " ").trim();
          if (!piece) continue;
          if (output) {
            const cjk =
              /[\u3400-\u9fff]$/.test(output) ||
              /^[\u3400-\u9fff]/.test(piece);
            if (!cjk) output += " ";
          }
          output += piece;
        }
        return { text: output.trim(), y: line.y, height: line.height };
      })
      .filter(line => line.text);

    let value = "";
    let previous = null;
    for (const line of renderedLines) {
      if (previous) {
        const gap = previous.y - line.y;
        value += gap > Math.max(previous.height * 1.8, 18) ? "\n\n" : "\n";
      }
      value += line.text;
      previous = line;
    }
    return value.trim();
  }

  function multiplyMatrix(left, right) {
    const [a1, b1, c1, d1, e1, f1] = left;
    const [a2, b2, c2, d2, e2, f2] = right;
    return [
      a1 * a2 + c1 * b2,
      b1 * a2 + d1 * b2,
      a1 * c2 + c1 * d2,
      b1 * c2 + d1 * d2,
      a1 * e2 + c1 * f2 + e1,
      b1 * e2 + d1 * f2 + f1
    ];
  }

  function transformMatrixPoint(matrix, x, y) {
    return {
      x: matrix[0] * x + matrix[2] * y + matrix[4],
      y: matrix[1] * x + matrix[3] * y + matrix[5]
    };
  }

  function matrixBounds(matrix, x = 0, y = 0, width = 1, height = 1) {
    const points = [
      transformMatrixPoint(matrix, x, y),
      transformMatrixPoint(matrix, x + width, y),
      transformMatrixPoint(matrix, x, y + height),
      transformMatrixPoint(matrix, x + width, y + height)
    ];
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys)
    };
  }

  function unionRect(left, right) {
    const x = Math.min(left.x, right.x);
    const y = Math.min(left.y, right.y);
    return {
      x,
      y,
      width: Math.max(left.x + left.width, right.x + right.width) - x,
      height: Math.max(left.y + left.height, right.y + right.height) - y
    };
  }

  function rectsNear(left, right, gap = 8) {
    return !(
      left.x + left.width + gap < right.x ||
      right.x + right.width + gap < left.x ||
      left.y + left.height + gap < right.y ||
      right.y + right.height + gap < left.y
    );
  }

  function clusterVisualParts(parts, pageWidth, pageHeight) {
    const pageArea = pageWidth * pageHeight;
    const clusters = [];
    for (const part of parts) {
      let target = clusters.find(cluster => rectsNear(cluster.rect, part.rect, 7));
      if (!target) {
        target = {
          rect: part.rect, kinds: new Set(), partCount: 0,
          imageCount: 0, horizontalLines: 0, verticalLines: 0, drawingCount: 0
        };
        clusters.push(target);
      }
      target.rect = unionRect(target.rect, part.rect);
      target.kinds.add(part.kind);
      target.partCount += 1;
      if (part.kind === "image") target.imageCount += 1;
      if (part.kind === "horizontal-line") target.horizontalLines += 1;
      if (part.kind === "vertical-line") target.verticalLines += 1;
      if (part.kind === "drawing") target.drawingCount += 1;
    }

    let merged = true;
    while (merged) {
      merged = false;
      for (let index = 0; index < clusters.length; index += 1) {
        for (let other = index + 1; other < clusters.length; other += 1) {
          if (!rectsNear(clusters[index].rect, clusters[other].rect, 9)) continue;
          clusters[index].rect = unionRect(clusters[index].rect, clusters[other].rect);
          clusters[index].partCount += clusters[other].partCount;
          clusters[index].imageCount += clusters[other].imageCount;
          clusters[index].horizontalLines += clusters[other].horizontalLines;
          clusters[index].verticalLines += clusters[other].verticalLines;
          clusters[index].drawingCount += clusters[other].drawingCount;
          clusters[other].kinds.forEach(kind => clusters[index].kinds.add(kind));
          clusters.splice(other, 1);
          merged = true;
          break;
        }
        if (merged) break;
      }
    }

    return clusters
      .filter(cluster => {
        const { rect } = cluster;
        const area = rect.width * rect.height;
        if (rect.width > pageWidth * .78 && rect.height > pageHeight * .72) return false;
        if (rect.width > pageWidth * .78 && rect.height < 3) return false;
        if (rect.height > pageHeight * .78 && rect.width < 3) return false;
        if (area < pageArea * .0012) return false;
        return cluster.kinds.has("image") || cluster.partCount >= 2 ||
          (rect.width >= pageWidth * .12 && rect.height >= pageHeight * .03);
      })
      .map(cluster => ({
        ...cluster,
        visualKind: cluster.imageCount ? "image" : cluster.horizontalLines >= 3 && cluster.verticalLines >= 3
          ? "table" : "drawing"
      }));
  }

  function operatorText(args) {
    if (typeof args === "string") return args;
    if (!Array.isArray(args)) return args?.unicode ? String(args.unicode) : "";
    return args.map(operatorText).join("");
  }

  function hiddenTextItemIndexes(textContent, pieces) {
    const items = textContent?.items || [];
    const chars = [];
    const itemIndexes = [];
    items.forEach((item, itemIndex) => {
      for (const char of String(item?.str || "")) {
        if (/\s/u.test(char)) continue;
        chars.push(char);
        itemIndexes.push(itemIndex);
      }
    });
    const fullText = chars.join("");
    const hiddenIndexes = new Set();
    for (const piece of pieces) {
      const compact = Array.from(String(piece || "")).filter(char => !/\s/u.test(char)).join("");
      if (compact.length < 4) continue;
      let from = 0;
      while (from < fullText.length) {
        const at = fullText.indexOf(compact, from);
        if (at < 0) break;
        for (let offset = at; offset < at + compact.length; offset += 1) hiddenIndexes.add(itemIndexes[offset]);
        from = at + compact.length;
      }
    }
    return [...hiddenIndexes];
  }

  function isWhiteFillColor(args) {
    const values = args && Number.isInteger(args.length) ? Array.from(args) :
      args && typeof args === "object" ? [0, 1, 2, 3].flatMap((key) => key in args ? [args[key]] : []) :
      args !== null && args !== undefined && args !== "" ? [args] : [];
    const normalized = values.some(value => Number(value) > 1) ? values.map(value => Number(value) / 255) : values.map(Number);
    if (normalized.length === 1) return normalized[0] >= 0.97;
    if (normalized.length === 3) return normalized.every(value => value >= 0.97);
    if (normalized.length === 4) return normalized.every(value => value <= 0.03);
    return false;
  }

  function fillAlphaFromGraphicsState(states) {
    const pending = [states];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== "object") continue;
      if (value.length >= 2 && value[0] === "ca") return Number(value[1]);
      const children = Number.isInteger(value.length) ? Array.from(value) : Object.values(value);
      for (const child of children) if (child && typeof child === "object") pending.push(child);
    }
    return null;
  }

  async function verifyWhiteTextOnPaper(page, textContent, candidateIndexes) {
    if (!candidateIndexes.length || typeof document === "undefined") return [];
    try {
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(1, 1000 / Math.max(baseViewport.width, baseViewport.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const hidden = [];
      for (const itemIndex of candidateIndexes) {
        const item = textContent?.items?.[itemIndex];
        const transform = item?.transform || [];
        const x = Number(transform[4]);
        const y = Number(transform[5]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const topLeft = viewport.convertToViewportPoint(x, y + Math.max(1, Number(item.height)));
        const bottomRight = viewport.convertToViewportPoint(x + Math.max(1, Number(item.width)), y);
        const x1 = Array.isArray(topLeft) ? topLeft[0] : topLeft.x;
        const y1 = Array.isArray(topLeft) ? topLeft[1] : topLeft.y;
        const x2 = Array.isArray(bottomRight) ? bottomRight[0] : bottomRight.x;
        const y2 = Array.isArray(bottomRight) ? bottomRight[1] : bottomRight.y;
        const left = Math.max(0, Math.floor(Math.min(x1, x2)) - 1);
        const top = Math.max(0, Math.floor(Math.min(y1, y2)) - 1);
        const right = Math.min(canvas.width - 1, Math.ceil(Math.max(x1, x2)) + 1);
        const bottom = Math.min(canvas.height - 1, Math.ceil(Math.max(y1, y2)) + 1);
        if (right <= left || bottom <= top) continue;
        const stepX = Math.max(1, Math.floor((right - left) / 12));
        const stepY = Math.max(1, Math.floor((bottom - top) / 8));
        let samples = 0;
        let nonPaper = 0;
        for (let py = top; py <= bottom; py += stepY) {
          for (let px = left; px <= right; px += stepX) {
            const offset = (py * canvas.width + px) * 4;
            samples += 1;
            if (pixels[offset] < 244 || pixels[offset + 1] < 244 || pixels[offset + 2] < 244) nonPaper += 1;
          }
        }
        if (samples >= 4 && nonPaper / samples < 0.01) hidden.push(itemIndex);
      }
      return hidden;
    } catch {
      return [];
    }
  }

  async function inspectPageVisualContent(pdfjs, page, textContent = null) {
    try {
      const operatorList = await page.getOperatorList();
      const imageOperations = new Set([
        pdfjs.OPS.paintImageXObject,
        pdfjs.OPS.paintInlineImageXObject,
        pdfjs.OPS.paintImageXObjectRepeat,
        pdfjs.OPS.paintImageMaskXObject,
        pdfjs.OPS.paintInlineImageXObjectGroup,
        pdfjs.OPS.paintImageMaskXObjectGroup,
        pdfjs.OPS.paintSolidColorImageMask
      ]);
      const pathOperation = pdfjs.OPS.constructPath;
      const saveOperation = pdfjs.OPS.save;
      const restoreOperation = pdfjs.OPS.restore;
      const transformOperation = pdfjs.OPS.transform;
      const setTransformOperation = pdfjs.OPS.setTransform;
      const setGStateOperation = pdfjs.OPS.setGState;
      const setFillTransparentOperation = pdfjs.OPS.setFillTransparent;
      const setFillRGBColorOperation = pdfjs.OPS.setFillRGBColor;
      const setFillGrayOperation = pdfjs.OPS.setFillGray;
      const setFillCMYKColorOperation = pdfjs.OPS.setFillCMYKColor;
      const setFillColorOperation = pdfjs.OPS.setFillColor;
      const setFillColorNOperation = pdfjs.OPS.setFillColorN;
      const setTextRenderingModeOperation = pdfjs.OPS.setTextRenderingMode;
      const textOperations = new Set([
        pdfjs.OPS.showText,
        pdfjs.OPS.showSpacedText,
        pdfjs.OPS.nextLineShowText,
        pdfjs.OPS.nextLineSetSpacingShowText
      ].filter(Number.isFinite));
      const viewport = page.getViewport({ scale: 1 });
      const stack = [];
      let matrix = [1, 0, 0, 1, 0, 0];
      let fillAlpha = 1;
      let fillTransparent = false;
      let fillWhite = false;
      let textRenderingMode = 0;
      let hiddenBuffer = "";
      let whiteBuffer = "";
      const hiddenPieces = [];
      const whitePieces = [];
      let imageCount = 0;
      let pathCount = 0;
      const parts = [];

      for (let index = 0; index < operatorList.fnArray.length; index += 1) {
        const operation = operatorList.fnArray[index];
        const args = operatorList.argsArray[index];
        const flushTextPieces = () => {
          if (hiddenBuffer.trim().length >= 3) hiddenPieces.push(hiddenBuffer);
          if (whiteBuffer.trim().length >= 3) whitePieces.push(whiteBuffer);
          hiddenBuffer = "";
          whiteBuffer = "";
        };
        if (operation === saveOperation) {
          stack.push({ matrix, fillAlpha, fillTransparent, fillWhite, textRenderingMode });
          continue;
        }
        if (operation === restoreOperation) {
          const state = stack.pop();
          matrix = state?.matrix || [1, 0, 0, 1, 0, 0];
          fillAlpha = state?.fillAlpha ?? 1;
          fillTransparent = state?.fillTransparent ?? false;
          fillWhite = state?.fillWhite ?? false;
          textRenderingMode = state?.textRenderingMode ?? 0;
          continue;
        }
        if (operation === transformOperation && Array.isArray(args)) {
          matrix = multiplyMatrix(matrix, args);
          continue;
        }
        if (operation === setTransformOperation && Array.isArray(args)) {
          matrix = args;
          continue;
        }
        if (operation === setGStateOperation && Array.isArray(args)) {
          flushTextPieces();
          const alpha = fillAlphaFromGraphicsState(args);
          if (Number.isFinite(alpha)) fillAlpha = Math.max(0, Math.min(1, alpha));
          continue;
        }
        if (operation === setFillTransparentOperation) {
          flushTextPieces();
          fillTransparent = true;
          continue;
        }
        if (operation === setFillRGBColorOperation || operation === setFillGrayOperation ||
            operation === setFillCMYKColorOperation) {
          flushTextPieces();
          fillTransparent = false;
          fillWhite = isWhiteFillColor(args);
          continue;
        }
        if (operation === setFillColorOperation || operation === setFillColorNOperation) {
          flushTextPieces();
          fillTransparent = false;
          fillWhite = false;
          continue;
        }
        if (operation === setTextRenderingModeOperation) {
          flushTextPieces();
          textRenderingMode = Number(Array.isArray(args) ? args[0] : args) || 0;
          continue;
        }
        if (textOperations.has(operation)) {
          const value = operatorText(args);
          if (fillTransparent || fillAlpha <= 0.01 || textRenderingMode === 3) hiddenBuffer += value;
          else if (fillWhite) whiteBuffer += value;
          else flushTextPieces();
          continue;
        }
        if (imageOperations.has(operation)) {
          imageCount += 1;
          const rect = matrixBounds(matrix);
          if (rect.width >= 6 && rect.height >= 6) parts.push({ kind: "image", rect });
          continue;
        }
        if (operation === pathOperation) {
          pathCount += 1;
          const minMax = args?.[2];
          if (!Array.isArray(minMax) || minMax.length < 4) continue;
          const [minX, minY, maxX, maxY] = minMax.map(Number);
          if (![minX, minY, maxX, maxY].every(Number.isFinite)) continue;
          const rect = matrixBounds(matrix, minX, minY, maxX - minX, maxY - minY);
          if (rect.width >= 7 && rect.height <= 1.4) parts.push({ kind: "horizontal-line", rect: { ...rect, height: 1.4 } });
          else if (rect.height >= 7 && rect.width <= 1.4) parts.push({ kind: "vertical-line", rect: { ...rect, width: 1.4 } });
          else if (rect.width >= 2 && rect.height >= 2) parts.push({ kind: "drawing", rect });
        }
      }
      if (hiddenBuffer.trim().length >= 3) hiddenPieces.push(hiddenBuffer);
      if (whiteBuffer.trim().length >= 3) whitePieces.push(whiteBuffer);
      const hiddenIndexes = new Set(hiddenTextItemIndexes(textContent, hiddenPieces));
      const whiteCandidates = hiddenTextItemIndexes(textContent, whitePieces).filter(index => !hiddenIndexes.has(index));
      for (const index of await verifyWhiteTextOnPaper(page, textContent, whiteCandidates)) hiddenIndexes.add(index);

      const clusters = clusterVisualParts(parts, viewport.width, viewport.height);
      const regions = clusters
        .map((cluster, index) => {
          const rect = cluster.rect;
          const topLeft = viewport.convertToViewportPoint(rect.x, rect.y + rect.height);
          const bottomRight = viewport.convertToViewportPoint(rect.x + rect.width, rect.y);
          const topLeftX = Array.isArray(topLeft) ? topLeft[0] : topLeft.x;
          const topLeftY = Array.isArray(topLeft) ? topLeft[1] : topLeft.y;
          const bottomRightX = Array.isArray(bottomRight) ? bottomRight[0] : bottomRight.x;
          const bottomRightY = Array.isArray(bottomRight) ? bottomRight[1] : bottomRight.y;
          const left = Math.min(topLeftX, bottomRightX);
          const top = Math.min(topLeftY, bottomRightY);
          const right = Math.max(topLeftX, bottomRightX);
          const bottom = Math.max(topLeftY, bottomRightY);
          return {
            id: `visual-${index}`,
            visualKind: cluster.visualKind,
            horizontalLines: cluster.horizontalLines,
            verticalLines: cluster.verticalLines,
            pdfRect: rect,
            aspect: (right - left) / Math.max(1, bottom - top),
            normalizedRect: {
              x: Math.max(0, left / viewport.width),
              y: Math.max(0, top / viewport.height),
              width: Math.min(1, (right - left) / viewport.width),
              height: Math.min(1, (bottom - top) / viewport.height)
            }
          };
        })
        .filter(region => region.normalizedRect.width > .01 && region.normalizedRect.height > .005);
      const kinds = [];
      if (imageCount) kinds.push("image");
      if (pathCount >= 20) kinds.push("drawing-or-formula");
      if (regions.some(region => region.visualKind === "table")) kinds.push("table");
      return {
        hasVisualContent: regions.length > 0,
        visualContentKinds: kinds,
        visualScore: imageCount * 10 + pathCount,
        visualRegions: regions,
        hiddenTextIndexes: [...hiddenIndexes]
      };
    } catch {
      return {
        hasVisualContent: false,
        visualContentKinds: [],
        visualScore: 0,
        visualRegions: [],
        hiddenTextIndexes: []
      };
    }
  }

  function attachVisualRegionAnchors(blocks, regions) {
    const indexed = blocks.map((block, index) => ({ ...block, index }));
    const captions = indexed.filter(block => block.type === "caption");
    const overlapsHorizontally = (block, region) => {
      const box = block.boundingBox;
      if (!box) return true;
      const left = Math.max(box.left, region.pdfRect.x);
      const right = Math.min(box.right, region.pdfRect.x + region.pdfRect.width);
      return right >= left - 12;
    };
    const attached = (regions || []).map((region, regionIndex) => {
      const regionTop = region.pdfRect.y + region.pdfRect.height;
      const caption = captions
        .filter(block => overlapsHorizontally(block, region) &&
          Number(block.topY ?? block.y) <= region.pdfRect.y + 7 &&
          Number(block.bottomY ?? block.y) >= region.pdfRect.y - 110)
        .sort((left, right) => Number(right.topY ?? right.y) - Number(left.topY ?? left.y))[0];
      const preceding = indexed
        .filter(block => block.type !== "caption" && overlapsHorizontally(block, region) &&
          Number(block.bottomY ?? block.y) >= regionTop - 7 &&
          Number(block.topY ?? block.y) <= regionTop + 110)
        .sort((left, right) => Number(left.y) - Number(right.y))[0];
      const captionKind = caption?.captionKind || "";
      const visualKind = captionKind && ["table", "figure", "algorithm", "listing", "formula"].includes(captionKind)
        ? captionKind
        : region.visualKind || "visual";
      return {
        ...region,
        visualKind,
        regionId: region.id || `visual-${regionIndex}`,
        anchorIndex: caption?.index ?? preceding?.index ?? null,
        anchorBlockId: caption?.blockId || preceding?.blockId || null,
        captionBlockIndex: caption?.index ?? null,
        captionBlockId: caption?.blockId || null,
        captionLabel: caption?.captionLabel || "",
        captionKind,
        captionText: caption?.text ? caption.text.slice(0, 240) : "",
        placement: caption ? "before" : "after"
      };
    });
    const linksByIndex = new Map();
    for (const region of attached) {
      if (!Number.isInteger(region.anchorIndex)) continue;
      const links = linksByIndex.get(region.anchorIndex) || [];
      links.push(region.regionId);
      linksByIndex.set(region.anchorIndex, links);
    }
    for (const block of blocks) {
      const links = linksByIndex.get(Number(block.index));
      if (links?.length) block.visualRegionIds = links;
    }
    return attached;
  }

  function updateImportProgress(percent, label) {
    const bar = document.getElementById("importProgressBar");
    const text = document.getElementById("importProgressText");
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (text) text.textContent = label;
  }

  function showImportProgress(fileName) {
    const root = document.getElementById("modalRoot");
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal-card" style="max-width:500px;" onclick="event.stopPropagation()">
          <h2 class="serif-title" style="font-size:20px; margin-bottom:6px;">正在导入本地 PDF</h2>
          <p style="font-size:13px; color:var(--text-secondary); margin-bottom:16px; word-break:break-word;">
            ${escapeHtml(fileName)}
          </p>
          <div class="import-progress-track"><span id="importProgressBar"></span></div>
          <div id="importProgressText" style="font-size:12.5px; color:var(--text-muted); margin-top:10px;">
            正在读取文件…
          </div>
          <div style="margin-top:16px; padding:12px; background:var(--bg-paper); border:1px solid var(--border-hairline); border-radius:6px; font-size:12px; color:var(--text-secondary);">
            文件、提取文字和阅读位置都只保存在当前平板。导入完成后会立即加入书库。
          </div>
        </div>
      </div>
    `;
  }

  function showImportError(message) {
    const root = document.getElementById("modalRoot");
    root.innerHTML = `
      <div class="modal-backdrop" id="importErrorBackdrop">
        <div class="modal-card" style="max-width:500px;" onclick="event.stopPropagation()">
          <h2 class="serif-title" style="font-size:19px; color:var(--terracotta); margin-bottom:8px;">PDF 导入失败</h2>
          <p style="font-size:13px; line-height:1.65; color:var(--text-secondary);">${escapeHtml(message)}</p>
          <div style="display:flex; justify-content:flex-end; margin-top:18px;">
            <button class="btn btn-primary" id="closeImportErrorBtn">关闭</button>
          </div>
        </div>
      </div>
    `;
    document
      .getElementById("importErrorBackdrop")
      ?.addEventListener("click", closeModal);
    document
      .getElementById("closeImportErrorBtn")
      ?.addEventListener("click", closeModal);
  }

  async function importPdfFile(file) {
    if (
      !file ||
      (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name))
    ) {
      throw new Error("请选择 PDF 文件。");
    }

    showImportProgress(file.name);
    updateImportProgress(4, "正在计算文件指纹…");
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const fileHash = hashToHex(digest);
    const existing = BOOKS.find(
      book => isImportedBook(book) && book.fileHash === fileHash
    );
    if (existing) {
      closeModal();
      showToast(`《${existing.title}》已经在本地书库中`);
      return existing;
    }

    updateImportProgress(10, "正在打开 PDF 并读取页数…");
    const pdfjs = await loadPdfJs();
    const pdfLayout = await loadPdfLayout();
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      cMapUrl: new URL("./cmaps/", PDF_BASE_URL).href,
      cMapPacked: true,
      standardFontDataUrl: new URL("./standard_fonts/", PDF_BASE_URL).href,
      useSystemFonts: true
    });
    const pdf = await loadingTask.promise;
    const metadata = await pdf.getMetadata().catch(() => ({ info: {} }));
    const totalPages = pdf.numPages;
    const pages = [];
    let inheritedSectionPath = [];
    let coverDataUrl = "";

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      try {
        const page = await pdf.getPage(pageNumber);
        if (pageNumber === 1) {
          try {
            const baseViewport = page.getViewport({ scale: 1 });
            const coverScale = Math.min(1, 420 / Math.max(1, baseViewport.width));
            const coverViewport = page.getViewport({ scale: coverScale });
            const coverCanvas = document.createElement("canvas");
            coverCanvas.width = Math.max(1, Math.floor(coverViewport.width));
            coverCanvas.height = Math.max(1, Math.floor(coverViewport.height));
            const coverContext = coverCanvas.getContext("2d", { alpha: false });
            coverContext.fillStyle = "#ffffff";
            coverContext.fillRect(0, 0, coverCanvas.width, coverCanvas.height);
            await page.render({ canvasContext: coverContext, viewport: coverViewport }).promise;
            coverDataUrl = coverCanvas.toDataURL("image/jpeg", 0.78);
          } catch (error) {
            console.warn("Could not render PDF cover", error);
          }
        }
        const content = await page.getTextContent();
        const visual = await inspectPageVisualContent(pdfjs, page, content);
        const pageViewport = page.getViewport({ scale: 1 });
        const layout = pdfLayout.buildPdfReadingLayout(content, {
          pageNumber,
          pageWidth: pageViewport.width,
          pageHeight: pageViewport.height,
          hiddenItemIndexes: visual.hiddenTextIndexes,
          protectedRegions: visual.visualRegions,
          inheritedSectionPath
        });
        if (layout.sectionPath?.length) inheritedSectionPath = layout.sectionPath;
        const readingBlocks = layout.blocks.map((block, index) => ({ ...block, index }));
        pages.push({
          number: pageNumber,
          text: layout.text,
          readingBlocks,
          readingLayoutVersion: layout.version,
          readingQuality: layout.quality,
          ...visual,
          visualRegions: attachVisualRegionAnchors(readingBlocks, visual.visualRegions),
          visualRegionsVersion: VISUAL_REGION_VERSION
        });
        page.cleanup();
      } catch (error) {
        pages.push({
          number: pageNumber,
          text: "",
          hasVisualContent: false,
          visualContentKinds: [],
          visualScore: 0,
          visualRegions: [],
          visualRegionsVersion: VISUAL_REGION_VERSION,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      if (pageNumber === 1 || pageNumber === totalPages || pageNumber % 3 === 0) {
        const percent = 10 + Math.round((pageNumber / totalPages) * 82);
        updateImportProgress(
          percent,
          `正在提取文字：${pageNumber} / ${totalPages} 页`
        );
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    }

    const title = cleanMetadataText(metadata.info?.Title, fileTitle(file));
    const author = cleanMetadataText(metadata.info?.Author, "本地 PDF");
    const firstText = pages.find(page => page.text)?.text || "";
    const chapter =
      firstText
        .split("\n")
        .find(line => line.trim())
        ?.slice(0, 90) || "未识别章节";
    const id = `pdf-${fileHash.slice(0, 20)}`;
    const importedAt = new Date().toISOString();
    const textCharacters = pages.reduce(
      (total, page) => total + page.text.length,
      0
    );

    const book = {
      id,
      source: "local-pdf",
      fileHash,
      title,
      subtitle: file.name,
      author,
      chapter,
      progress: 0,
      annotations: 0,
      lastRead: "刚刚导入",
      page: 1,
      totalPages,
      readingSeconds: 0,
      coverDataUrl,
      tag: textCharacters ? "本地 PDF · 文字已提取" : "本地 PDF · 等待 OCR",
      importedAt,
      extractedAt: importedAt,
      readingLayoutVersion: pdfLayout.PDF_READING_LAYOUT_VERSION,
      readingLayoutUpdatedAt: importedAt,
      textCharacters,
      pages
    };

    updateImportProgress(95, "正在写入当前平板的本地数据库…");
    await putImportedBook(
      {
        id,
        name: file.name,
        type: file.type || "application/pdf",
        size: file.size,
        blob: file
      },
      book
    );
    window.dispatchEvent(new CustomEvent("biandu:local-data-changed", { detail: { kind: "pdf", id: book.id } }));
    pdf.destroy();
    updateImportProgress(100, "导入完成");
    return book;
  }

  async function importPdfFiles(files) {
    const list = Array.from(files || []).filter(
      file => /\.pdf$/i.test(file.name) || file.type === "application/pdf"
    );
    if (!list.length) return;

    let lastBook = null;
    for (const file of list) {
      try {
        lastBook = (await importPdfFile(file)) || lastBook;
        if (lastBook && !BOOKS.some(book => book.id === lastBook.id)) {
          BOOKS.unshift(lastBook);
        }
      } catch (error) {
        console.error(error);
        showImportError(error instanceof Error ? error.message : String(error));
        return;
      }
    }

    if (lastBook) {
      STATE.activeBookId = lastBook.id;
      STATE.readerPage = 1;
      STATE.readerTotalPages = lastBook.totalPages;
      STATE.readerWordPopupOpen = false;
      closeModal();
      renderApp();
      requestStoragePersistence();
    }
    return lastBook;
  }

  async function requestStoragePersistence() {
    let persisted = false;
    try {
      persisted = Boolean(await navigator.storage?.persisted?.());
      if (navigator.storage?.persist && !persisted) persisted = Boolean(await navigator.storage.persist());
    } catch {
      // Persistence is best effort on WebKit.
    }
    let estimate = null;
    try { estimate = await navigator.storage?.estimate?.(); } catch { /* Best effort only. */ }
    storageHealthCache = {
      persisted,
      usage: Number(estimate?.usage || 0),
      quota: Number(estimate?.quota || 0),
      checkedAt: new Date().toISOString()
    };
    window.dispatchEvent(new CustomEvent("biandu:storage-status", { detail: storageHealthCache }));
    return storageHealthCache;
  }

  function ensureFileInput() {
    if (fileInput) return fileInput;
    fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "application/pdf,.pdf";
    fileInput.multiple = true;
    fileInput.hidden = true;
    fileInput.addEventListener("change", () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = "";
      if (files.length) importPdfFiles(files);
    });
    document.body.appendChild(fileInput);
    return fileInput;
  }

  function syncImportedBookReader(book) {
    if (STATE.__importedReaderId !== book.id) {
      STATE.__importedReaderId = book.id;
      STATE.readerPage = Number(book.page) || 1;
      STATE.readerSelectionText = "";
      STATE.readerWordPopupOpen = false;
      STATE.readerSettingsOpen = false;
      STATE.readerExcerptAiOpen = false;
      if (!["text", "original"].includes(STATE.readerViewMode)) STATE.readerViewMode = "text";
      STATE.readerRegionSelecting = false;
      STATE.readerSelectedImage = null;
      STATE.__readerPageChanged = true;
    }

    STATE.readerTotalPages = book.totalPages;
    const requestedPage = Math.max(
      1,
      Math.min(book.totalPages, Number(STATE.readerPage) || 1)
    );
    if (STATE.__lastImportedReaderPage !== requestedPage) {
      STATE.__lastImportedReaderPage = requestedPage;
      STATE.readerSelectionText = "";
      STATE.readerWordPopupOpen = false;
      STATE.readerSelectedImage = null;
      STATE.readerRegionSelecting = false;
    }
    STATE.readerPage = requestedPage;
    book.page = STATE.readerPage;
    book.progress =
      book.totalPages <= 1
        ? 100
        : Math.round(((book.page - 1) / (book.totalPages - 1)) * 100);
    book.lastRead = "刚刚";
    queueBookSave(book);
  }

  function progressPatch(book) {
    return {
      page: book.page,
      progress: book.progress,
      lastRead: book.lastRead,
      readingSeconds: book.readingSeconds || 0,
      annotations: book.annotations || 0,
      readerPosition: book.readerPosition || null
    };
  }

  function readProgressJournal() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PROGRESS_JOURNAL_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch { return {}; }
  }

  function writeProgressJournal(bookId, patch, journalAt) {
    try {
      const journal = readProgressJournal();
      journal[bookId] = { patch, journalAt };
      localStorage.setItem(PROGRESS_JOURNAL_KEY, JSON.stringify(journal));
    } catch { /* IndexedDB remains the primary durable store. */ }
  }

  function clearProgressJournal(bookId, journalAt) {
    try {
      const journal = readProgressJournal();
      if (journal[bookId]?.journalAt !== journalAt) return;
      delete journal[bookId];
      localStorage.setItem(PROGRESS_JOURNAL_KEY, JSON.stringify(journal));
    } catch { /* A stale journal is harmless and will be merged again. */ }
  }

  function rememberPendingProgress(book) {
    const patch = progressPatch(book);
    const journalAt = new Date().toISOString();
    pendingProgressSaves.set(book.id, { patch, journalAt });
    writeProgressJournal(book.id, patch, journalAt);
  }

  function mergeBookProgress(bookId, patch) {
    return openDatabase().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction("books", "readwrite");
      const store = tx.objectStore("books");
      const request = store.get(bookId);
      request.onsuccess = () => {
        if (!request.result) return;
        store.put({ ...request.result, ...patch });
      };
      request.onerror = () => tx.abort();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("阅读位置保存事务失败。"));
      tx.onabort = () => reject(tx.error || new Error("阅读位置保存事务已中止。"));
    }));
  }

  function drainProgressSave(bookId) {
    const pending = pendingProgressSaves.get(bookId);
    if (!pending) return progressSaveChain;
    pendingProgressSaves.delete(bookId);
    const run = progressSaveChain
      .catch(() => {})
      .then(() => mergeBookProgress(bookId, pending.patch))
      .then(() => clearProgressJournal(bookId, pending.journalAt));
    progressSaveChain = run.catch((error) => console.warn("Could not save reading progress", error));
    return run;
  }

  function flushBookProgress(book = null) {
    window.clearTimeout(progressSaveTimer);
    progressSaveTimer = null;
    if (book?.id) rememberPendingProgress(book);
    const bookIds = book?.id ? [book.id] : [...pendingProgressSaves.keys()];
    return Promise.allSettled(bookIds.map(drainProgressSave)).then(results => {
      const failed = results.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
    });
  }

  function queueBookSave(book, immediate = false) {
    if (!book?.id) return Promise.resolve();
    rememberPendingProgress(book);
    window.clearTimeout(progressSaveTimer);
    progressSaveTimer = null;
    if (immediate) return flushBookProgress(book);
    progressSaveTimer = window.setTimeout(() => {
      flushBookProgress().catch(() => {});
    }, 240);
    return Promise.resolve();
  }

  function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.round(totalSeconds || 0));
    const totalMinutes = Math.floor(seconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `${hours} 小时 ${minutes} 分`;
    return `${minutes} 分钟`;
  }

  function getTodayStats() {
    const today = new Date().toLocaleDateString("en-CA");
    try {
      const parsed = JSON.parse(localStorage.getItem(STATS_KEY) || "{}");
      if (parsed.date === today) return parsed;
    } catch {
      // Ignore invalid local statistics.
    }
    return { date: today, seconds: 0 };
  }

  function saveTodayStats(stats) {
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify(stats));
    } catch {
      // Reading remains functional without statistics storage.
    }
  }

  function currentImportedBook() {
    return BOOKS.find(
      book => book.id === STATE.activeBookId && isImportedBook(book)
    );
  }

  function flushReadingTime() {
    const now = Date.now();
    const seconds = Math.min(
      120,
      Math.max(0, (now - activeTimerStartedAt) / 1000)
    );
    activeTimerStartedAt = now;
    const visibleNow = document.visibilityState === "visible";
    const wasVisible = readingClockVisible;
    readingClockVisible = visibleNow;
    if (STATE.currentView !== "reader" || (!visibleNow && !wasVisible)) {
      return;
    }

    const book = currentImportedBook();
    if (!book || seconds < 1) return;
    book.readingSeconds = Number(book.readingSeconds || 0) + seconds;
    const stats = getTodayStats();
    stats.seconds += seconds;
    saveTodayStats(stats);
    queueBookSave(book);
  }

  function markEnglishWords(value) {
    const parts = String(value).split(
      /([\p{Script=Latin}]+(?:[’'][\p{Script=Latin}]+)*(?:-[\p{Script=Latin}]+)*)/gu
    );
    return parts
      .map((part, index) => {
        if (index % 2 === 1 && Array.from(part).length > 1) {
          return `<span class="word-token" data-word="${escapeHtml(part)}">${escapeHtml(part)}</span>`;
        }
        return escapeHtml(part);
      })
      .join("");
  }

  function paragraphsForText(text) {
    const blocks = String(text || "")
      .split(/\n{2,}/)
      .map(block => block.replace(/\n+/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    return blocks.length ? blocks : [];
  }

  function pageReadingBlocks(page) {
    const source = Array.isArray(page?.readingBlocks)
      ? page.readingBlocks.map((block, index) => ({ ...block, index }))
      : paragraphsForText(page?.text || "").map((text, index) => ({
          type: "paragraph",
          text,
          index
        }));
    return source.filter(block =>
      block?.text &&
      !["header", "footer", "visual"].includes(block.type)
    );
  }

  function renderReadingBlocks(book, page, blocks) {
    const visibleIndexes = new Set(blocks.map(block => Number(block.index)));
    const regionsByAnchor = new Map();
    const trailingRegions = [];
    (page?.visualRegions || []).forEach((region, regionIndex) => {
      const anchor = Number(region.anchorIndex);
      if (visibleIndexes.has(anchor)) {
        const list = regionsByAnchor.get(anchor) || [];
        list.push({ region, regionIndex });
        regionsByAnchor.set(anchor, list);
      } else {
        trailingRegions.push({ region, regionIndex });
      }
    });

    return blocks.map(block => {
      const type = String(block.type || "paragraph").replace(/[^a-z-]/g, "");
      const text = block.text;
      const anchored = regionsByAnchor.get(Number(block.index)) || [];
      const before = anchored
        .filter(item => item.region.placement === "before")
        .map(item => renderPageVisualRegion(book, page, item.region, item.regionIndex))
        .join("");
      const after = anchored
        .filter(item => item.region.placement !== "before")
        .map(item => renderPageVisualRegion(book, page, item.region, item.regionIndex))
        .join("");
      return `${before}<p class="reader-block reader-block-${type}" data-block-type="${type}" data-page="${page.number}" data-paragraph-index="${block.index}" style="position:relative;">${markEnglishWords(text)}</p>${after}`;
    }).join("") + trailingRegions
      .map(item => renderPageVisualRegion(book, page, item.region, item.regionIndex))
      .join("");
  }

  function renderPageVisualRegion(book, page, region, regionIndex) {
    const normalized = region?.normalizedRect;
    if (!normalized?.width || !normalized?.height) return "";
    const aspect =
      Number(region?.aspect) ||
      Number(region?.pdfRect?.width) / Math.max(1, Number(region?.pdfRect?.height)) ||
      normalized.width / normalized.height;
    return `
      <figure class="reader-page-visual" data-visual-region-index="${regionIndex}">
        <div class="reader-page-visual-stage">
          <img class="pdf-visual-image" role="img" alt="第 ${escapeHtml(page.number)} 页图表 ${regionIndex + 1}" style="aspect-ratio:${aspect};" data-book-id="${escapeHtml(book.id)}" data-page="${escapeHtml(page.number)}" data-region-index="${regionIndex}">
        </div>
      </figure>
    `;
  }

  function pageRecord(book, pageNumber) {
    return (book.pages || []).find(page => page.number === pageNumber);
  }

  function selectionOffsetInsideBlock(block, node, offset) {
    if (!block || !node) return null;
    const range = document.createRange();
    range.selectNodeContents(block);
    try {
      range.setEnd(node, offset);
    } catch {
      return null;
    }
    return range.toString().length;
  }

  function selectionHighlightForBook(book) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !book) return null;
    const text = selection.toString().replace(/\s+/g, " ").trim();
    if (!text) return null;
    const range = selection.getRangeAt(0);
    const startElement = range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement
      : range.startContainer;
    const endElement = range.endContainer.nodeType === Node.TEXT_NODE
      ? range.endContainer.parentElement
      : range.endContainer;
    const startBlock = startElement?.closest?.("[data-paragraph-index][data-page]");
    const endBlock = endElement?.closest?.("[data-paragraph-index][data-page]");
    if (!startBlock || !endBlock || startBlock !== endBlock) return null;
    const page = Number(startBlock.getAttribute("data-page"));
    const blockIndex = Number(startBlock.getAttribute("data-paragraph-index"));
    const start = selectionOffsetInsideBlock(startBlock, range.startContainer, range.startOffset);
    const end = selectionOffsetInsideBlock(startBlock, range.endContainer, range.endOffset);
    if (!Number.isFinite(page) || !Number.isFinite(blockIndex) || start === null || end === null || end <= start) return null;
    return {
      id: makeId("highlight"),
      page,
      blockIndex,
      start,
      end,
      text: text.slice(0, 2000),
      color: "gold",
      createdAt: new Date().toISOString()
    };
  }

  async function saveReaderHighlight() {
    const book = currentImportedBook();
    const highlight = selectionHighlightForBook(book);
    if (!book || !highlight) {
      showToast("请在同一个段落内选择文字后再划线");
      return;
    }
    const existing = Array.isArray(book.highlights) ? book.highlights : [];
    if (!existing.some(item =>
      item.page === highlight.page &&
      item.blockIndex === highlight.blockIndex &&
      item.start === highlight.start &&
      item.end === highlight.end
    )) {
      book.highlights = [...existing, highlight].slice(-2000);
      book.annotations = Number(book.annotations || 0) + 1;
    }
    await putRecord("books", book);
    window.getSelection()?.removeAllRanges();
    STATE.readerSelectionText = "";
    document.getElementById("realSelectionBar")?.classList.remove("is-visible");
    applyReaderHighlights(book);
  }

  async function removeReaderHighlight(highlightId) {
    const book = currentImportedBook();
    if (!book || !highlightId) return;
    const highlights = Array.isArray(book.highlights) ? book.highlights : [];
    const next = highlights.filter(item => item.id !== highlightId);
    if (next.length === highlights.length) return;
    book.highlights = next;
    book.annotations = Math.max(0, Number(book.annotations || 0) - 1);
    await putRecord("books", book);
    applyReaderHighlights(book);
    refreshReaderSidePanel(book);
    showToast("划线已删除");
  }

  function applyReaderHighlights(book) {
    if (!book || typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
    CSS.highlights.delete("reader-highlight");
    const ranges = [];
    for (const highlight of Array.isArray(book.highlights) ? book.highlights : []) {
      const block = document.querySelector(
        `.reader-page-section[data-page="${Number(highlight.page)}"] [data-paragraph-index="${Number(highlight.blockIndex)}"]`
      );
      if (!block) continue;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let node;
      let offset = 0;
      while ((node = walker.nextNode())) {
        const next = offset + node.data.length;
        nodes.push({ node, start: offset, end: next });
        offset = next;
      }
      const startNode = nodes.find(item => Number(highlight.start) >= item.start && Number(highlight.start) < item.end);
      const endNode = nodes.find(item => Number(highlight.end) > item.start && Number(highlight.end) <= item.end);
      if (!startNode || !endNode) continue;
      const range = document.createRange();
      range.setStart(startNode.node, Number(highlight.start) - startNode.start);
      range.setEnd(endNode.node, Number(highlight.end) - endNode.start);
      ranges.push(range);
    }
    if (ranges.length) CSS.highlights.set("reader-highlight", new Highlight(...ranges));
  }

  function readerOutlineEntries(book) {
    const entries = [];
    const seen = new Set();
    const pages = (book.pages || []).slice().sort((left, right) => left.number - right.number);
    const pushEntry = (page, block, fallbackTitle = "") => {
      const title = String(block?.text || fallbackTitle || "").replace(/\s+/g, " ").trim();
      if (!title) return;
      const key = `${page.number}:${block?.index ?? "page"}:${title.slice(0, 80)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const type = String(block?.type || "paragraph");
      entries.push({
        page: page.number,
        blockIndex: Number.isInteger(block?.index) ? block.index : null,
        title: title.slice(0, 140),
        level: type === "title" ? 0 : type === "heading" ? 1 : type === "subheading" ? 2 : 3
      });
    };

    for (const page of pages) {
      const blocks = pageReadingBlocks(page);
      const headings = blocks.filter(block =>
        ["title", "heading", "subheading"].includes(String(block.type || "")) &&
        String(block.text || "").trim().length <= 160
      );
      if (headings.length) {
        headings.forEach(block => pushEntry(page, block));
      } else if (blocks.length) {
        pushEntry(page, blocks[0], `第 ${page.number} 页`);
      }
      if (entries.length >= 180) break;
    }
    return entries;
  }

  function readerSearchResults(book, query) {
    const normalizedQuery = String(query || "").trim().toLocaleLowerCase("zh-CN");
    if (!normalizedQuery) return [];
    const results = [];
    for (const page of (book.pages || []).slice().sort((left, right) => left.number - right.number)) {
      for (const block of pageReadingBlocks(page)) {
        const text = String(block.text || "").replace(/\s+/g, " ").trim();
        const matchIndex = text.toLocaleLowerCase("zh-CN").indexOf(normalizedQuery);
        if (matchIndex < 0) continue;
        const start = Math.max(0, matchIndex - 56);
        const end = Math.min(text.length, matchIndex + normalizedQuery.length + 92);
        results.push({
          page: page.number,
          blockIndex: block.index,
          text,
          prefix: start > 0 ? "…" : "",
          snippet: text.slice(start, end),
          suffix: end < text.length ? "…" : ""
        });
        if (results.length >= 100) return results;
      }
    }
    return results;
  }

  function highlightReaderSearchText(text, query) {
    const safe = String(text || "");
    const needle = String(query || "").trim();
    if (!needle) return escapeHtml(safe);
    const lower = safe.toLocaleLowerCase("zh-CN");
    const target = needle.toLocaleLowerCase("zh-CN");
    let cursor = 0;
    const parts = [];
    let index = lower.indexOf(target);
    while (index >= 0) {
      parts.push(escapeHtml(safe.slice(cursor, index)));
      parts.push(`<mark>${escapeHtml(safe.slice(index, index + needle.length))}</mark>`);
      cursor = index + needle.length;
      index = lower.indexOf(target, cursor);
    }
    parts.push(escapeHtml(safe.slice(cursor)));
    return parts.join("");
  }

  function renderReaderSearchResults(book, query) {
    const results = readerSearchResults(book, query);
    if (!String(query || "").trim()) {
      return `<p class="reader-panel-hint">输入关键词，可定位正文中的句子。搜索只在本机书籍文字中进行。</p>`;
    }
    if (!results.length) {
      return `<p class="reader-panel-hint">没有找到“${escapeHtml(query)}”。</p>`;
    }
    return `
      <div class="reader-panel-section-label">找到 ${results.length} 处</div>
      <div class="reader-search-results">
        ${results.map(item => `
          <button class="reader-search-hit" data-reader-jump-page="${item.page}" data-reader-jump-block="${item.blockIndex}">
            <span>第 ${item.page} 页</span>
            <span>${item.prefix}${highlightReaderSearchText(item.snippet, query)}${item.suffix}</span>
          </button>
        `).join("")}
      </div>
    `;
  }

  function renderReaderCatalogPanel(book) {
    const entries = readerOutlineEntries(book);
    return `
      <label class="reader-panel-search">
        ${ICONS.search}
        <input id="readerCatalogSearchInput" type="search" value="${escapeHtml(STATE.readerCatalogQuery || "")}" placeholder="搜索本书正文" autocomplete="off" />
      </label>
      <div id="readerCatalogResults">${renderReaderSearchResults(book, STATE.readerCatalogQuery)}</div>
      <div class="reader-panel-section-label">目录 · ${(book.pages || []).length} 页</div>
      <div class="reader-toc-list">
        ${entries.map(entry => `
          <button class="reader-toc-entry level-${entry.level}" data-reader-jump-page="${entry.page}" ${entry.blockIndex === null ? "" : `data-reader-jump-block="${entry.blockIndex}"`}>
            <span>${escapeHtml(entry.title)}</span>
            <small>${entry.page}</small>
          </button>
        `).join("")}
      </div>
    `;
  }

  function renderReaderNotesPanel(book) {
    const grouped = new Map();
    for (const [key, values] of notesByPage.entries()) {
      if (!key.startsWith(`${book.id}:`) || !values.length) continue;
      const page = Number(key.slice(book.id.length + 1));
      if (Number.isFinite(page)) grouped.set(page, values);
    }
    const pages = [...grouped.entries()].sort((left, right) => left[0] - right[0]);
    const noteCount = pages.reduce((total, [, notes]) => total + notes.length, 0);
    const highlights = (Array.isArray(book.highlights) ? book.highlights : [])
      .slice()
      .sort((left, right) => left.page - right.page || left.blockIndex - right.blockIndex);
    return `
      <div class="reader-panel-actions">
        <span>笔记和划线从正文选段创建</span>
        <strong>${noteCount} 条笔记 · ${highlights.length} 条划线</strong>
      </div>
      ${highlights.length ? `
        <div class="reader-panel-section-label">划线</div>
        <div class="reader-highlight-list">
          ${highlights.map(highlight => `
            <article class="reader-highlight-card">
              <button data-reader-jump-page="${highlight.page}" data-reader-jump-block="${highlight.blockIndex}">
                <q>${escapeHtml(highlight.text || "")}</q>
                <small>第 ${highlight.page} 页</small>
              </button>
              <button class="reader-delete-highlight" data-highlight-id="${escapeHtml(highlight.id)}" title="删除划线">${ICONS.close}</button>
            </article>
          `).join("")}
        </div>
      ` : ""}
      <div class="reader-panel-section-label">我的笔记</div>
      ${pages.length ? pages.map(([page, notes]) => `
        <section class="reader-note-group">
          <button class="reader-note-page" data-reader-jump-page="${page}">第 ${page} 页 <small>${notes.length} 条</small></button>
          ${notes.map(note => `
            <button class="reader-note-card" data-reader-jump-page="${page}">
              ${note.quote ? `<q>${escapeHtml(note.quote.slice(0, 160))}</q>` : ""}
              <span>${escapeHtml(String(note.text || "图片笔记").slice(0, 240))}</span>
              <small>${new Date(note.createdAt).toLocaleString("zh-CN")}</small>
            </button>
          `).join("")}
        </section>
      `).join("") : `<p class="reader-panel-hint">还没有笔记。在正文中选中文字后，使用浮动工具条的“笔记”。</p>`}
    `;
  }

  function renderReaderOutlinePanel(book) {
    const localEntries = readerOutlineEntries(book);
    const aiOutline = book.readerOutline && Array.isArray(book.readerOutline.sections)
      ? book.readerOutline
      : null;
    return `
      <div class="reader-panel-actions">
        <button class="btn btn-sm btn-tonal" id="readerGenerateOutlineBtn" ${STATE.readerOutlineBusy ? "disabled" : ""}>
          ${ICONS.sparkle} ${STATE.readerOutlineBusy ? "正在提炼…" : aiOutline ? "重新提炼" : "AI 提炼大纲"}
        </button>
      </div>
      ${aiOutline ? `
        <div class="reader-ai-outline">
          <p>${escapeHtml(aiOutline.summary || "AI 已根据书籍文字生成结构。")}</p>
          ${(aiOutline.sections || []).map(section => `
            <section>
              <button data-reader-jump-page="${Number(section.page) || 1}" ${Number.isInteger(Number(section.blockIndex)) ? `data-reader-jump-block="${Number(section.blockIndex)}"` : ""}>${escapeHtml(section.title || "未命名章节")}</button>
              ${(section.points || []).length ? `<ul>${section.points.slice(0, 6).map(point => `<li>${escapeHtml(typeof point === "string" ? point : point.text || point.title || "")}</li>`).join("")}</ul>` : ""}
            </section>
          `).join("")}
          <small>公开范围：${escapeHtml(aiOutline.scopeLabel || "本地文本")} · ${new Date(aiOutline.generatedAt).toLocaleString("zh-CN")}</small>
        </div>
      ` : `
        <p class="reader-panel-hint">下面是依据标题与段落生成的本地目录。点击“AI 提炼大纲”可进一步归纳主题。</p>
      `}
      <div class="reader-panel-section-label">本地结构</div>
      <div class="reader-toc-list">
        ${localEntries.map(entry => `
          <button class="reader-toc-entry level-${entry.level}" data-reader-jump-page="${entry.page}" ${entry.blockIndex === null ? "" : `data-reader-jump-block="${entry.blockIndex}"`}>
            <span>${escapeHtml(entry.title)}</span><small>${entry.page}</small>
          </button>
        `).join("")}
      </div>
    `;
  }

  function renderReaderSidePanel(book) {
    const panel = STATE.readerSidePanel;
    if (!["catalog", "notes", "outline"].includes(panel)) return "";
    const titles = { catalog: "目录与搜索", notes: "笔记", outline: "AI 大纲" };
    const body = panel === "catalog"
      ? renderReaderCatalogPanel(book)
      : panel === "notes"
        ? renderReaderNotesPanel(book)
        : renderReaderOutlinePanel(book);
    return `
      <aside class="reader-side-panel" id="readerSidePanel" aria-label="${titles[panel]}">
        <header class="reader-side-panel-head">
          <div>
            <strong>${titles[panel]}</strong>
            <span>${escapeHtml(book.title)}</span>
          </div>
          <button class="btn btn-sm btn-icon" id="closeReaderSidePanelBtn" title="关闭">${ICONS.close}</button>
        </header>
        <nav class="reader-side-panel-tabs" aria-label="阅读辅助面板">
          <button class="${panel === "catalog" ? "active" : ""}" data-reader-panel="catalog">目录</button>
          <button class="${panel === "notes" ? "active" : ""}" data-reader-panel="notes">笔记</button>
          <button class="${panel === "outline" ? "active" : ""}" data-reader-panel="outline">AI 大纲</button>
        </nav>
        <div class="reader-side-panel-body" id="readerSidePanelBody">${body}</div>
      </aside>
    `;
  }

  function refreshReaderSidePanel(book) {
    const panel = document.getElementById("readerSidePanel");
    if (!panel) return;
    panel.outerHTML = renderReaderSidePanel(book);
  }

  async function generateReaderAiOutline(book) {
    if (!book || STATE.readerOutlineBusy) return;
    STATE.readerOutlineBusy = true;
    refreshReaderSidePanel(book);
    try {
      const deepseek = await import(new URL("./src/web/deepseek.js", window.location.href).href);
      const prompts = await import(new URL("./src/web/prompts.js", window.location.href).href);
      if (!(await deepseek.hasApiKey("knowledge"))) {
        showToast("请先在设置中为知识整理配置可用模型");
        return;
      }
      const pages = (book.pages || []).slice(0, 80);
      const source = pages.map(page => {
        const body = pageReadingBlocks(page).map(block => String(block.text || "").trim()).filter(Boolean).join("\n");
        return `【第 ${page.number} 页】\n${body}`;
      }).join("\n\n").slice(0, 60_000);
      if (!source.trim()) throw new Error("这本书还没有可用于提炼的文字");
      const result = await deepseek.chat([
        { role: "system", content: prompts.promptTemplates.readerOutline },
        {
          role: "user",
          content: JSON.stringify({
            bookTitle: book.title,
            totalPages: book.pages.length,
            includedPages: pages.length,
            source
          })
        }
      ], { task: "knowledge", json: true, temperature: 0.1, timeoutMs: 120_000 });
      const sections = (Array.isArray(result?.sections) ? result.sections : [])
        .map(section => ({
          title: String(section?.title || "").trim().slice(0, 120),
          page: Math.max(1, Math.min(book.totalPages, Number(section?.page) || 1)),
          blockIndex: Number.isInteger(Number(section?.blockIndex)) ? Number(section.blockIndex) : null,
          points: (Array.isArray(section?.points) ? section.points : [])
            .map(point => typeof point === "string" ? point : point?.text || point?.title || "")
            .map(point => String(point).trim())
            .filter(Boolean)
            .slice(0, 6)
        }))
        .filter(section => section.title);
      if (!sections.length) throw new Error("模型没有返回可用的大纲章节");
      book.readerOutline = {
        summary: String(result?.summary || "").trim().slice(0, 1200),
        sections,
        generatedAt: new Date().toISOString(),
        scopeLabel: pages.length < (book.pages || []).length
          ? `前 ${pages.length} 页，约 ${source.length.toLocaleString("zh-CN")} 字`
          : `全书文字，约 ${source.length.toLocaleString("zh-CN")} 字`
      };
      await putRecord("books", book);
      showToast("AI 大纲已生成并保存在本机");
    } catch (error) {
      showToast(`AI 大纲生成失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      STATE.readerOutlineBusy = false;
      refreshReaderSidePanel(book);
    }
  }

  function ensurePageNotes(bookId, pageNumber) {
    const key = `${bookId}:${pageNumber}`;
    if (notesByPage.has(key) || notesLoading.has(key)) return;
    notesLoading.add(key);
    (async () => {
      try {
        const all = await getAll("notes");
        const filtered = await Promise.all(all
          .filter(note => note.bookId === bookId && note.page === pageNumber)
          .sort((a, b) =>
            String(b.createdAt).localeCompare(String(a.createdAt))
          )
          .map(async note => {
            const previews = [];
            for (const assetId of note.imageIds || []) {
              const asset = await getRecord("assets", assetId);
              if (asset?.blob) previews.push({ id: assetId, url: URL.createObjectURL(asset.blob), name: asset.name || "笔记图片" });
            }
            return { ...note, imagePreviews: previews };
          }));
        notesByPage.set(key, filtered);
      } catch {
        notesByPage.set(key, []);
      } finally {
        notesLoading.delete(key);
        if (STATE.currentView === "reader" && STATE.activeBookId === bookId) {
          window.clearTimeout(readerNotesRefreshTimer);
          readerNotesRefreshTimer = window.setTimeout(() => {
            if (STATE.currentView === "reader" && STATE.activeBookId === bookId) renderApp();
          }, 120);
        }
      }
    })();
  }

  function renderReaderSettings() {
    return `
      <div class="drawer-backdrop" id="settingsDrawerBackdrop">
        <aside class="drawer-panel" style="padding:20px; overflow-y:auto;" onclick="event.stopPropagation()">
          <div style="display:flex; align-items:center; justify-content:space-between; padding-bottom:12px; border-bottom:1px solid var(--border-hairline); margin-bottom:16px;">
            <div>
              <h3 class="serif-title" style="font-size:18px;">阅读排版与视觉设置</h3>
              <span style="font-size:11.5px; color:var(--primary);">● 自动保存在当前平板</span>
            </div>
            <button class="btn btn-sm btn-icon" id="closeReaderSettingsBtn">${ICONS.close}</button>
          </div>
          <div style="display:flex; flex-direction:column; gap:16px;">
            <div>
              <label style="font-size:12.5px; font-weight:600; color:var(--text-secondary); display:block; margin-bottom:6px;">字体</label>
              <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:8px;">
                <button class="btn btn-sm font-opt-btn ${STATE.readerFont === "serif" ? "btn-primary" : ""}" data-font="serif">宋体</button>
                <button class="btn btn-sm font-opt-btn ${STATE.readerFont === "sans" ? "btn-primary" : ""}" data-font="sans">黑体</button>
                <button class="btn btn-sm font-opt-btn ${STATE.readerFont === "humanist" ? "btn-primary" : ""}" data-font="humanist">人文</button>
              </div>
            </div>
            <div>
              <div style="display:flex; justify-content:space-between; font-size:12.5px; margin-bottom:6px;"><span>字号</span><strong>${STATE.readerFontSize}px</strong></div>
              <input type="range" id="settingFontSizeSlider" min="15" max="30" step="1" value="${STATE.readerFontSize}" />
            </div>
            <div>
              <div style="display:flex; justify-content:space-between; font-size:12.5px; margin-bottom:6px;"><span>行距</span><strong>${STATE.readerLineHeight}</strong></div>
              <input type="range" id="settingLineHeightSlider" min="1.4" max="2.2" step="0.05" value="${STATE.readerLineHeight}" />
            </div>
            <div>
              <div style="display:flex; justify-content:space-between; font-size:12.5px; margin-bottom:6px;"><span>段间距</span><strong>${STATE.readerParaSpacing}px</strong></div>
              <input type="range" id="settingParaSpacingSlider" min="12" max="42" step="2" value="${STATE.readerParaSpacing}" />
            </div>
            <div>
              <div style="display:flex; justify-content:space-between; font-size:12.5px; margin-bottom:6px;"><span>版面宽度</span><strong>${STATE.readerContentWidth}px</strong></div>
              <input type="range" id="settingContentWidthSlider" min="760" max="1120" step="40" value="${STATE.readerContentWidth}" />
            </div>
            <div>
              <label style="font-size:12.5px; font-weight:600; color:var(--text-secondary); display:block; margin-bottom:6px;">页边距</label>
              <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:8px;">
                <button class="btn btn-sm margin-opt-btn ${STATE.readerMargin === "narrow" ? "btn-primary" : ""}" data-margin="narrow">紧凑</button>
                <button class="btn btn-sm margin-opt-btn ${STATE.readerMargin === "standard" ? "btn-primary" : ""}" data-margin="standard">标准</button>
                <button class="btn btn-sm margin-opt-btn ${STATE.readerMargin === "wide" ? "btn-primary" : ""}" data-margin="wide">宽松</button>
              </div>
            </div>
            <div>
              <label style="font-size:12.5px; font-weight:600; color:var(--text-secondary); display:block; margin-bottom:6px;">文字颜色</label>
              <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:8px;">
                <button class="btn btn-sm textcolor-opt-btn ${STATE.readerTextColor === "#1F2522" ? "btn-tonal" : ""}" data-color="#1F2522">墨黑</button>
                <button class="btn btn-sm textcolor-opt-btn ${STATE.readerTextColor === "#3E4642" ? "btn-tonal" : ""}" data-color="#3E4642">炭灰</button>
                <button class="btn btn-sm textcolor-opt-btn ${STATE.readerTextColor === "#4A3B2C" ? "btn-tonal" : ""}" data-color="#4A3B2C">暖褐</button>
              </div>
            </div>
            <div>
              <label style="font-size:12.5px; font-weight:600; color:var(--text-secondary); display:block; margin-bottom:6px;">背景</label>
              <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:8px;">
                <button class="btn btn-sm theme-opt-btn" data-theme="white" style="background:#FAF8F3;color:#1F2522;">纸张白</button>
                <button class="btn btn-sm theme-opt-btn" data-theme="beige" style="background:#EFE9DA;color:#2B261F;">暖米色</button>
                <button class="btn btn-sm theme-opt-btn" data-theme="green" style="background:#E2ECE4;color:#1A2B22;">护眼绿</button>
                <button class="btn btn-sm theme-opt-btn" data-theme="night" style="background:#202724;color:#D8DDD9;">夜间</button>
              </div>
            </div>
            <div>
              <div style="display:flex; justify-content:space-between; font-size:12.5px; margin-bottom:6px;"><span>页面亮度</span><strong>${STATE.readerBrightness}%</strong></div>
              <input type="range" id="settingBrightnessSlider" min="65" max="100" step="1" value="${STATE.readerBrightness}" />
            </div>
          </div>
        </aside>
      </div>
    `;
  }

  function readerPadding() {
    return {
      narrow: "24px 28px",
      standard: "32px 44px",
      wide: "40px 72px"
    }[STATE.readerMargin] || "32px 44px";
  }

  function applyReaderFormattingPreview() {
    const shell = document.querySelector(".real-reader-shell");
    const article = document.querySelector(".real-reader-article");
    const text = document.querySelector(".real-reader-text");
    if (!shell || !article) return;
    shell.style.filter = `brightness(${STATE.readerBrightness}%)`;
    if (article.hasAttribute("data-continuous")) article.style.maxWidth = `${STATE.readerContentWidth}px`;
    if (text) {
      text.style.fontSize = `${STATE.readerFontSize}px`;
      text.style.lineHeight = String(STATE.readerLineHeight);
      text.style.setProperty("--real-paragraph-gap", `${STATE.readerParaSpacing}px`);
      text.style.fontFamily = STATE.readerFont === "serif"
        ? "var(--font-serif)"
        : STATE.readerFont === "sans"
          ? "var(--font-sans)"
          : 'Georgia, "Songti SC", serif';
      text.style.color = STATE.readerTheme === "night" ? "var(--reader-text)" : STATE.readerTextColor;
    }
    article.style.padding = readerPadding();
    document.querySelectorAll(".font-opt-btn").forEach(button =>
      button.classList.toggle("btn-primary", button.getAttribute("data-font") === STATE.readerFont)
    );
    document.querySelectorAll(".margin-opt-btn").forEach(button =>
      button.classList.toggle("btn-primary", button.getAttribute("data-margin") === STATE.readerMargin)
    );
    document.querySelectorAll(".textcolor-opt-btn").forEach(button =>
      button.classList.toggle("btn-tonal", button.getAttribute("data-color") === STATE.readerTextColor)
    );
    document.querySelectorAll(".theme-opt-btn").forEach(button => {
      const active = button.getAttribute("data-theme") === STATE.readerTheme;
      button.style.outline = active ? "2px solid var(--primary)" : "none";
      button.style.outlineOffset = active ? "2px" : "0";
    });
  }

  function applyReaderFormattingPreservingPosition() {
    const book = currentImportedBook();
    const scroll = document.getElementById("realReaderScroll");
    const article = document.querySelector(".real-reader-article");
    const anchor = book && scroll && article?.hasAttribute("data-continuous")
      ? captureReaderAnchorFrom(scroll, book)
      : null;
    applyReaderFormattingPreview();
    if (!anchor || !book || !scroll) return;
    book.readerPosition = anchor;
    scroll.dataset.readerRestoring = "true";
    requestAnimationFrame(() => {
      restoreReaderAnchor(scroll, book, anchor);
      requestAnimationFrame(() => {
        scroll.dataset.readerRestoring = "false";
      });
    });
  }

  function setReaderSettingsOpen(open) {
    STATE.readerSettingsOpen = Boolean(open);
    document.getElementById("settingsDrawerBackdrop")?.remove();
    const button = document.getElementById("readerSettingsToggleBtn");
    button?.classList.toggle("btn-tonal", STATE.readerSettingsOpen);
    if (!STATE.readerSettingsOpen) return;
    STATE.readerSidePanel = null;
    document.getElementById("readerSidePanel")?.remove();
    document.getElementById("readerCatalogToggleBtn")?.classList.remove("btn-tonal");
    document.getElementById("readerNotesToggleBtn")?.classList.remove("btn-tonal");
    document.getElementById("readerOutlineToggleBtn")?.classList.remove("btn-tonal");
    document.querySelector(".real-reader-shell")?.insertAdjacentHTML("beforeend", renderReaderSettings());
    applyReaderFormattingPreview();
  }

  function setReaderExcerptAiOpen(open) {
    STATE.readerExcerptAiOpen = Boolean(open);
    document.getElementById("excerptAiBackdrop")?.remove();
    const button = document.getElementById("readerAskExcerptAiBtn");
    button?.classList.toggle("btn-primary", STATE.readerExcerptAiOpen);
    if (!STATE.readerExcerptAiOpen || !currentImportedBook()) return;
    const book = currentImportedBook();
    document.querySelector(".real-reader-shell")?.insertAdjacentHTML(
      "beforeend",
      renderSelectionAi(book, pageRecord(book, book.page), STATE.readerSelectionText || "")
    );
    window.setTimeout(() => window.BianDuRuntime?.reader?.enhance?.(), 0);
  }

  function renderSelectionAi(book, page, selectedText) {
    const snippet = selectedText || page?.text?.slice(0, 360) || "";
    const image = STATE.readerSelectedImage;
    const imageMode = Boolean(image?.dataUrl && image?.bookId === book.id && image?.page === book.page);
    return `
      <div class="drawer-backdrop" id="excerptAiBackdrop">
        <aside class="drawer-panel" style="width:420px; max-width:94vw; background:var(--bg-paper-elevated); color:var(--text-main);" onclick="event.stopPropagation()">
          <div style="padding:16px 18px; border-bottom:1px solid var(--border-hairline); display:flex; align-items:center; justify-content:space-between;">
            <div>
              <h3 class="serif-title" style="font-size:18px;">${imageMode ? "询问图片 AI" : "询问选段 AI"}</h3>
              <span class="badge badge-green" style="margin-top:4px;">${imageMode ? "只发送框选区域与问题" : "已选段，按当前模型讲解"}</span>
            </div>
            <button class="btn btn-sm btn-icon" id="closeExcerptAiDrawerBtn">${ICONS.close}</button>
          </div>
          <div style="padding:14px 18px; background:var(--bg-paper-warm); border-bottom:1px solid var(--border-hairline);">
            <div style="font-size:11.5px; color:var(--text-muted); margin-bottom:5px;">${imageMode ? "框选图片、图表或公式" : "当前选段"} · 《${escapeHtml(book.title)}》第 ${book.page} 页</div>
            ${imageMode
              ? `<img src="${escapeHtml(image.dataUrl)}" alt="当前框选的图片、图表或公式" style="display:block;max-width:100%;max-height:230px;margin:0 auto;border:1px solid var(--border-hairline);border-radius:7px;background:#fff;" />`
              : `<blockquote style="font-family:var(--font-serif); font-size:13px; line-height:1.55; padding-left:10px; border-left:2.5px solid var(--primary); max-height:180px; overflow:auto;">${escapeHtml(snippet || "当前页没有选中文字")}</blockquote>`}
          </div>
          <div style="flex:1; padding:24px; display:flex; flex-direction:column; justify-content:center; gap:10px; text-align:center; color:var(--text-secondary);">
            ${ICONS.sparkle}
            <strong style="color:var(--text-main);">AI 接口尚未连接</strong>
            <span style="font-size:12.5px; line-height:1.6;">${imageMode ? "框选区域已永久保存在本机。请先在设置中为“图片与公式讲解”绑定支持图片输入的模型。" : "选段已经准备好。先在设置中配置选段讲解模型，这里只发送当前选段与问题。"}</span>
            <button class="btn btn-primary" id="goToAiSettingsBtn" style="align-self:center;">前往 AI 设置</button>
          </div>
        </aside>
      </div>
    `;
  }

  function renderWordCard() {
    if (!STATE.readerWordPopupOpen) return "";
    const word = STATE.activePopupWord || "";
    const data =
      STATE.__wordPopupData?.lemma === normalizeWord(word)
        ? STATE.__wordPopupData
        : null;
    return `
      <section class="real-word-card">
        <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
          <div>
            <div class="serif-title" style="font-size:21px; color:var(--primary);">${escapeHtml(word)}</div>
            <div style="font-size:13px; color:var(--text-secondary); margin-top:2px;">
              ${data?.definitionZh ? escapeHtml(data.definitionZh) : "标记为生词后，可由当前词典模型补全释义"}
            </div>
          </div>
          <button class="btn btn-sm btn-icon" id="closeWordPopupBtn">${ICONS.close}</button>
        </div>
        <div style="display:flex; gap:7px; flex-wrap:wrap; margin-top:10px;">
          <span class="badge ${data ? "badge-green" : "badge-gold"}">${data ? "已保存在本机" : "尚未标注"}</span>
          ${data ? `<span class="badge badge-gold">标注次数 ${data.count || 1} 次</span>` : ""}
          <button class="btn btn-sm" id="viewDictionaryBtn">查看词典</button>
        </div>
        <div data-word-actions style="display:flex;gap:7px;flex-wrap:wrap;margin-top:10px;">
          ${data ? "" : `<button class="btn btn-sm btn-primary" id="manualMarkWordBtn">标记为生词</button>`}
          <button class="btn btn-sm" id="realWordEnrichBtn" ${data?.definitionZh ? "disabled" : ""}>${data?.definitionZh ? "已有释义" : "AI 查询释义"}</button>
        </div>
      </section>
    `;
  }

  function renderInlineNotes(book, pageNumber) {
    const notes = notesByPage.get(`${book.id}:${pageNumber}`) || [];
    if (!notes.length) return "";
    return `
      <section class="reader-page-notes" data-page="${pageNumber}">
        <div class="reader-page-notes-head">第 ${pageNumber} 页笔记 (${notes.length})</div>
        ${notes.map(note => `
          <div class="real-reader-note">
            ${note.quote ? `<div style="font-size:11.5px; color:var(--text-muted); margin-bottom:5px;">“${escapeHtml(note.quote.slice(0, 180))}”</div>` : ""}
            <div style="font-size:13px; color:var(--text-main); line-height:1.6; white-space:pre-wrap;">${escapeHtml(note.text)}</div>
            ${(note.imagePreviews || []).length ? `<div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">${note.imagePreviews.map(image => `<img src="${image.url}" alt="${escapeHtml(image.name)}" style="width:min(220px,45vw); max-height:180px; object-fit:cover; border-radius:6px; border:1px solid var(--border-hairline);" />`).join("")}</div>` : ""}
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:7px; color:var(--text-muted); font-size:11px;">
              <span>${new Date(note.createdAt).toLocaleString("zh-CN")}</span>
              <button class="btn btn-sm delete-real-note" data-note-id="${note.id}" style="min-height:30px;padding:0 8px;">删除</button>
            </div>
          </div>
        `).join("")}
      </section>
    `;
  }

  function renderContinuousText(book, fontMap, wordColor) {
    const pages = (book.pages || []).slice().sort((a, b) => a.number - b.number);
    const sections = [];
    for (const page of pages) {
      const blocks = pageReadingBlocks(page);
      if (!blocks.length) continue;
      const content = renderReadingBlocks(book, page, blocks);
      sections.push(`<section class="reader-page-section" data-page="${page.number}">${content}</section>${renderInlineNotes(book, page.number)}`);
    }
    if (!sections.length) {
      return `
        <div class="real-reader-text" style="font-family:${fontMap[STATE.readerFont]}; font-size:${STATE.readerFontSize}px; line-height:${STATE.readerLineHeight}; --real-paragraph-gap:${STATE.readerParaSpacing}px; color:${wordColor};">
          <div style="padding:22px; border:1px solid var(--reader-border); border-radius:6px; background:var(--bg-paper); color:var(--reader-sub); margin-bottom:18px;">
            <strong style="color:var(--reader-text);">还没有可提取的文字。</strong><br>
            请切换到“原页视图”查看原貌，或等待扫描页识别生成文字层。
          </div>
        </div>
      `;
    }
    return `<div class="real-reader-text" style="font-family:${fontMap[STATE.readerFont]}; font-size:${STATE.readerFontSize}px; line-height:${STATE.readerLineHeight}; --real-paragraph-gap:${STATE.readerParaSpacing}px; color:${wordColor};">${sections.join("")}</div>`;
  }

  function renderImportedReader(book) {
    syncImportedBookReader(book);
    const page = pageRecord(book, STATE.readerPage);
    const originalMode = STATE.readerViewMode === "original";
    if (originalMode) ensurePageNotes(book.id, STATE.readerPage);
    else (book.pages || []).forEach(item => ensurePageNotes(book.id, item.number));
    const fontMap = {
      serif: "var(--font-serif)",
      sans: "var(--font-sans)",
      humanist: 'Georgia, "Songti SC", serif'
    };
    const readingBlocks = pageReadingBlocks(page);
    const notes = notesByPage.get(`${book.id}:${book.page}`) || [];
    const themeClass = `reader-theme-${STATE.readerTheme}`;
    const selectionText = STATE.readerSelectionText || "";
    const wordColor =
      STATE.readerTheme === "night" ? "var(--reader-text)" : STATE.readerTextColor;
    const hasOriginalPage = Boolean(page?.visualSnapshotAssetId || (!book.originalDeleted && book.totalPages));
    const needsTextRecovery = (book.pages || []).some(item => item.proofreadMeta?.recoveryRequired);
    const translationAction = STATE.readerTranslationAction || {
      label: "全文翻译",
      disabled: false
    };

    return `
      <div class="real-reader-shell ${themeClass} ${originalMode ? "is-original-reader" : "is-continuous-reader"}" style="flex:1; display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden; position:relative; filter:brightness(${STATE.readerBrightness}%);">
        <header class="reader-toolbar" style="min-height:54px; padding:6px 16px; background:var(--bg-paper-elevated); color:var(--text-main); border-bottom:1px solid var(--border-hairline); display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; z-index:25;">
          <div style="display:flex; align-items:center; gap:8px; min-width:0;">
            <button class="btn btn-sm" id="readerBackLibraryBtn">${ICONS.arrowLeft}<span>返回书库</span></button>
            <div style="margin-left:4px; border-left:1px solid var(--border-hairline); padding-left:12px; min-width:0;">
              <div class="serif-title" style="font-size:14.5px; line-height:1.25; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:320px;">《${escapeHtml(book.title)}》</div>
              <div style="font-size:11.5px; color:var(--text-secondary);">${escapeHtml(book.author)} · 本地 PDF</div>
            </div>
          </div>
          <div class="reader-toolbar-actions reader-primary-actions">
            ${originalMode ? `
              <button class="btn btn-icon reader-icon-action is-active" id="readerPdfPenBtn" aria-label="钢笔" title="钢笔" data-reader-tooltip-title="钢笔" data-reader-tooltip-detail="在 PDF 原页上直接手写">${readerActionIcon("pen")}</button>
              <button class="btn btn-icon reader-icon-action" id="readerPdfHighlighterBtn" aria-label="荧光笔" title="荧光笔" data-reader-tooltip-title="荧光笔" data-reader-tooltip-detail="用半透明笔迹标记 PDF 原文">${readerActionIcon("highlighter")}</button>
              <button class="btn btn-icon reader-icon-action" id="readerPdfEraserBtn" aria-label="橡皮" title="橡皮" data-reader-tooltip-title="橡皮" data-reader-tooltip-detail="轻轻划过即可删除整条笔迹">${readerActionIcon("eraser")}</button>
              <button class="btn btn-icon reader-icon-action" id="readerPdfInkUndoBtn" aria-label="撤销笔迹" title="撤销笔迹" data-reader-tooltip-title="撤销笔迹" data-reader-tooltip-detail="删除当前 PDF 原页最近一条标注">${readerActionIcon("undo")}</button>
              <button class="btn btn-icon reader-icon-action" id="readerViewModeBtn" ${hasOriginalPage ? "" : "disabled"} aria-label="文字阅读" title="文字阅读" data-reader-tooltip-title="文字阅读" data-reader-tooltip-detail="返回连续文字阅读、选中翻译和词典">${readerActionIcon("text-reader")}</button>
            ` : `
              <button class="btn btn-icon reader-icon-action" id="readerSettingsToggleBtn" aria-label="阅读设置" title="阅读设置" data-reader-tooltip-title="阅读设置" data-reader-tooltip-detail="字号、字体、行距、页面宽度、背景和亮度">${readerActionIcon("settings")}</button>
              <button class="btn btn-icon reader-icon-action is-unavailable" id="readerTranslateSelectionBtn" aria-disabled="true" aria-label="翻译选中内容" title="翻译选中内容" data-reader-tooltip-title="翻译选中内容" data-reader-tooltip-detail="选中单词或句子后可用；单词翻译会直接加入词典">${readerActionIcon("translate")}</button>
              <button class="btn btn-icon reader-icon-action is-unavailable" id="readerAddDictionaryBtn" aria-disabled="true" aria-label="加入词典" title="加入词典" data-reader-tooltip-title="加入词典" data-reader-tooltip-detail="只对单个单词可用；自动生成音标、词性、释义和原句语境">${readerActionIcon("dictionary")}</button>
              <button class="btn btn-icon reader-action-mode" id="readerViewModeBtn" ${hasOriginalPage ? "" : "disabled"} aria-label="PDF 原页" title="PDF 原页" data-reader-tooltip-title="PDF 原页" data-reader-tooltip-detail="查看原始排版并在页面上手写、划线">${readerActionIcon("pdf")}</button>
              <button class="btn btn-icon reader-icon-action is-unavailable" id="readerSentenceNoteBtn" aria-disabled="true" aria-label="句子笔记" title="句子笔记" data-reader-tooltip-title="句子笔记" data-reader-tooltip-detail="只对完整句子可用；可写文字笔记或创建画板">${readerActionIcon("note")}</button>
              <button class="btn btn-icon reader-icon-action reader-full-translation-action ${STATE.readerTranslationsOn ? "is-active" : ""}" id="readerFullTranslationBtn" ${translationAction.disabled ? "disabled" : ""} aria-label="${escapeHtml(translationAction.label)}" title="${escapeHtml(translationAction.label)}" data-reader-tooltip-title="${escapeHtml(translationAction.label)}" data-reader-tooltip-detail="开始后逐页保存；再次点击可暂停并看原文，第三次从未翻译处继续">${readerActionIcon("full-translation")}</button>
            `}
          </div>
        </header>

        <div class="reader-scroll real-reader-scroll" id="realReaderScroll" style="flex:1; min-height:0; overflow-y:auto; padding:${originalMode ? "18px 18px 36px" : "14px 16px 34px"}; display:flex; align-items:flex-start; justify-content:center; background:var(--reader-bg);">
          <article class="reader-paper real-reader-article" data-book-id="${book.id}" ${originalMode ? `data-page="${book.page}"` : 'data-continuous="true"'} style="width:100%; max-width:${originalMode ? "880px" : `${STATE.readerContentWidth}px`}; min-height:70%; padding:${readerPadding()}; background:var(--reader-page); border:1px solid var(--reader-border); border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.04);">
            <div style="display:flex; justify-content:space-between; gap:12px; padding-bottom:14px; margin-bottom:24px; border-bottom:1px solid var(--reader-border); font-size:12px; color:var(--reader-sub);">
              <span>${escapeHtml(book.title)}</span>
              <span id="${originalMode ? "readerPageLabel" : "continuousProgressLabel"}">${originalMode ? `原页视图 · 第 ${book.page} / ${book.totalPages} 页` : `连续阅读 · 当前第 ${book.page} / ${book.totalPages} 页`}</span>
            </div>
            ${needsTextRecovery ? `<div class="reader-text-recovery"><div><strong>检测到旧版排版可能覆盖了校对文本</strong><span>先用本机 PDF 重新校对受影响页面，避免继续使用缺字文本。</span></div><button class="btn btn-sm" id="readerRecoverTextBtn" type="button">重新校对文字</button></div>` : ""}

            ${originalMode ? `
              <div class="reader-page-stage" id="readerPageStage" data-book-id="${book.id}" data-page="${book.page}">
                <canvas class="pdf-fallback-canvas" id="pdfFallbackCanvas" data-book-id="${book.id}" data-page="${book.page}"></canvas>
                <canvas class="reader-ink-canvas" id="readerInkCanvas" aria-label="PDF 手写标注层"></canvas>
              </div>
              <p class="reader-original-hint">在 PDF 原页上直接书写、划线或做标记；笔键单击切换橡皮，按住临时擦除。文字翻译与词典仅在文字阅读模式使用。</p>
              ${renderInlineNotes(book, book.page)}
            ` : `
              ${renderContinuousText(book, fontMap, wordColor)}
            `}
          </article>
        </div>

        ${originalMode ? `
        <footer class="reader-footer" style="min-height:52px; padding:6px 20px; background:var(--bg-paper-elevated); color:var(--text-main); border-top:1px solid var(--border-hairline); display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; z-index:20;">
          <div style="display:flex; align-items:center; gap:8px;">
            <button class="btn btn-sm" id="realPrevPageBtn" ${book.page <= 1 ? "disabled" : ""}>上一页</button>
            <span style="font-size:13px; font-weight:600;">${book.page} / ${book.totalPages}</span>
            <button class="btn btn-sm" id="realNextPageBtn" ${book.page >= book.totalPages ? "disabled" : ""}>下一页</button>
          </div>
          <div style="flex:1; max-width:420px; min-width:180px;">
            <input type="range" id="readerPageSlider" min="1" max="${book.totalPages}" value="${book.page}" />
            <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--text-muted); margin-top:3px;">
              <span>阅读进度 ${book.progress}%</span>
              <span>已读 ${formatDuration(book.readingSeconds || 0)}</span>
            </div>
          </div>
        </footer>
        ` : ""}

        ${STATE.readerSettingsOpen ? renderReaderSettings() : ""}
      </div>
    `;
  }

  function openNoteComposer(quote = "") {
    const root = document.getElementById("modalRoot");
    root.innerHTML = `
      <div class="modal-backdrop" id="noteModalBackdrop">
        <div class="modal-card" style="max-width:600px;" onclick="event.stopPropagation()">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
            <h2 class="serif-title" style="font-size:19px;">添加文字笔记</h2>
            <button class="btn btn-sm btn-icon" id="closeNoteModalBtn">${ICONS.close}</button>
          </div>
          ${quote ? `<blockquote style="padding:9px 12px; margin-bottom:12px; border-left:3px solid var(--gold); background:var(--bg-paper); color:var(--text-secondary); font-family:var(--font-serif); font-size:12.5px;">${escapeHtml(quote)}</blockquote>` : ""}
          <textarea id="realNoteTextarea" rows="7" style="width:100%; resize:vertical; padding:12px; border:1px solid var(--border-strong); border-radius:6px; font:inherit; line-height:1.6; background:var(--bg-paper-elevated); color:var(--text-main);" placeholder="写下你的理解、疑问或联想…"></textarea>
          <div style="display:flex; align-items:center; gap:8px; margin-top:10px; flex-wrap:wrap;">
            <input type="file" id="realNoteImageInput" accept="image/*" multiple hidden />
            <button class="btn btn-sm" id="chooseRealNoteImageBtn">${ICONS.image || "图片"}<span>插入图片</span></button>
            <span style="font-size:11.5px; color:var(--text-muted);">图片只保存在当前平板</span>
          </div>
          <div id="realNoteImagePreview" style="display:flex; gap:8px; flex-wrap:wrap; margin-top:9px;"></div>
          <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:14px;">
            <button class="btn" id="cancelRealNoteBtn">取消</button>
            <button class="btn btn-primary" id="saveRealNoteBtn">保存到本机</button>
          </div>
        </div>
      </div>
    `;
    pendingNoteImages = [];
    document
      .getElementById("noteModalBackdrop")
      ?.addEventListener("click", closeModal);
    document
      .getElementById("closeNoteModalBtn")
      ?.addEventListener("click", closeModal);
    document
      .getElementById("cancelRealNoteBtn")
      ?.addEventListener("click", closeModal);
    document
      .getElementById("saveRealNoteBtn")
      ?.addEventListener("click", () => saveCurrentPageNote(quote));
    document.getElementById("chooseRealNoteImageBtn")?.addEventListener("click", () => {
      document.getElementById("realNoteImageInput")?.click();
    });
    document.getElementById("realNoteImageInput")?.addEventListener("change", event => {
      pendingNoteImages = Array.from(event.target.files || []).filter(file => file.type.startsWith("image/"));
      pendingNoteImages.forEach(file => { file.__previewUrl = URL.createObjectURL(file); });
      const preview = document.getElementById("realNoteImagePreview");
      if (preview) {
        preview.innerHTML = pendingNoteImages.map(file => `
          <figure style="margin:0; max-width:150px;">
            <img src="${file.__previewUrl}" alt="${escapeHtml(file.name)}" style="width:150px; height:100px; object-fit:cover; border-radius:6px; border:1px solid var(--border-hairline);" />
            <figcaption style="font-size:10.5px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(file.name)}</figcaption>
          </figure>`).join("");
      }
    });
    requestAnimationFrame(() => document.getElementById("realNoteTextarea")?.focus());
  }

  async function persistReaderNote(text, quote = "", imageFiles = []) {
    const book = currentImportedBook();
    if (!text && imageFiles.length === 0) {
      showToast("请先写下笔记内容或插入图片");
      return false;
    }
    if (!book) return false;

    const assetRecords = [];
    const imageIds = [];
    const imagePreviews = [];
    for (const file of imageFiles) {
      const assetId = makeId("asset");
      assetRecords.push({
        id: assetId, kind: "note-image", name: file.name,
        mime: file.type, blob: file, createdAt: new Date().toISOString()
      });
      imageIds.push(assetId);
      imagePreviews.push({ id: assetId, url: file.__previewUrl, name: file.name });
    }

    const note = {
      id: makeId("note"),
      bookId: book.id,
      page: book.page,
      quote,
      text: text || "图片笔记",
      imageIds,
      imagePreviews,
      createdAt: new Date().toISOString()
    };
    const evidence = {
      id: `evidence-${note.id}`,
      kind: "text-note",
      sourceId: book.id,
      sourceTitle: book.title,
      bookId: book.id,
      page: book.page,
      locator: { page: book.page, sentenceId: note.quote || undefined },
      excerpt: [quote ? `原文：${quote}` : "", `用户笔记：${note.text}`].filter(Boolean).join("\n"),
      permanent: true,
      capturedAt: note.createdAt,
      updatedAt: note.createdAt
    };
    try {
      await saveNoteBundle(assetRecords, note, evidence);
    } catch (error) {
      showToast(`笔记保存失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    book.annotations = Number(book.annotations || 0) + 1;
    const key = `${book.id}:${book.page}`;
    notesByPage.set(key, [note, ...(notesByPage.get(key) || [])]);
    queueBookSave(book, true).catch(() => showToast("笔记已保存，阅读统计稍后重试"));
    window.dispatchEvent(new CustomEvent("biandu:local-data-changed", { detail: { kind: "note", id: note.id } }));
    closeModal();
    renderApp();
    return true;
  }

  async function saveCurrentPageNote(quote = "") {
    const textarea = document.getElementById("realNoteTextarea");
    const text = textarea?.value.trim() || "";
    const saved = await persistReaderNote(text, quote, pendingNoteImages);
    if (!saved && !text && pendingNoteImages.length === 0) textarea?.focus();
    return saved;
  }

  async function saveInlineReaderNote(text, quote = "") {
    return persistReaderNote(String(text || "").trim(), quote, []);
  }

  function currentPageSentence(word, pageNumber) {
    const book = currentImportedBook();
    const page = book ? pageRecord(book, pageNumber ?? book.page) : null;
    if (!page?.text) return "";
    const sentences = page.text
      .replace(/\n+/g, " ")
      .split(/(?<=[.!?。！？])\s+/);
    return (
      sentences
        .find(sentence =>
          sentence.toLowerCase().includes(String(word).toLowerCase())
        )
        ?.slice(0, 360) || page.text.slice(0, 360)
    );
  }

  async function performDictionaryMark(word) {
    const book = currentImportedBook();
    if (!book) return null;
    const lemma = normalizeWord(word);
    if (!lemma) return null;
    const now = new Date().toISOString();
    const existing = await getRecord("dictionary", lemma);
    const pageNumber = Number(STATE.__activeWordPage) || book.page;
    const sentence = currentPageSentence(word, pageNumber);
    const occurrence = {
      id: makeId("occ"),
      bookId: book.id,
      bookTitle: book.title,
      page: pageNumber,
      sentence,
      markedAt: now
    };
    const entry = existing || {
      lemma,
      displayForm: word,
      definitionZh: "",
      partOfSpeech: "",
      count: 0,
      occurrences: [],
      firstMarkedAt: now
    };
    entry.count += 1;
    entry.occurrences.push(occurrence);
    entry.lastMarkedAt = now;
    await putRecord("dictionary", entry);
    mergeDictionaryIntoVocabulary(entry);
    window.dispatchEvent(new CustomEvent("biandu:local-data-changed", { detail: { kind: "dictionary", id: lemma } }));
    window.dispatchEvent(new CustomEvent("biandu:dictionary-word-marked", {
      detail: { word, entry },
    }));
    return entry;
  }

  const dictionaryMarkQueues = new Map();

  function markDictionaryWord(word) {
    const lemma = normalizeWord(word);
    if (!lemma) return Promise.resolve(null);
    const previous = dictionaryMarkQueues.get(lemma) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => performDictionaryMark(word));
    dictionaryMarkQueues.set(lemma, operation);
    const clear = () => {
      if (dictionaryMarkQueues.get(lemma) === operation) dictionaryMarkQueues.delete(lemma);
    };
    operation.then(clear, clear);
    return operation;
  }

  function mergeDictionaryIntoVocabulary(entry) {
    const existing = VOCAB_LIST.find(
      item => normalizeWord(item.word) === entry.lemma
    );
    const contexts = entry.occurrences
      .slice()
      .reverse()
      .map(occurrence => ({
        book: `《${occurrence.bookTitle}》`,
        page: `第 ${occurrence.page} 页`,
        en: occurrence.sentence,
        zh: "等待当前词典模型生成语境翻译",
        activeContext: false
      }));
    if (contexts[0]) contexts[0].activeContext = true;

    if (existing) {
      existing.count = entry.count;
      existing.lastTime = "刚刚";
      existing.contexts = contexts.length ? contexts : existing.contexts;
      return;
    }

    VOCAB_LIST.unshift({
      word: entry.displayForm,
      phonetic: "",
      pos: entry.partOfSpeech || "—",
      meaning: entry.definitionZh || "等待当前词典模型生成释义",
      commonSenses: [entry.definitionZh || "等待当前词典模型生成释义"],
      inflections: entry.lemma !== entry.displayForm ? `原形：${entry.lemma}` : "",
      count: entry.count,
      lastTime: "刚刚",
      status: "待复习",
      inPlan: false,
      books: `《${entry.occurrences.at(-1)?.bookTitle || "本地 PDF"}》等 ${new Set(entry.occurrences.map(item => item.bookId)).size} 本`,
      contexts: contexts.length
        ? contexts
        : [
            {
              book: "本地 PDF",
              page: "未知页码",
              en: "No context captured.",
              zh: "暂无语境",
              activeContext: true
            }
          ]
    });
  }

  async function migrateReadingLayouts(books) {
    const candidates = books.filter(book =>
      isImportedBook(book) &&
      !book.originalDeleted &&
      (book.pages || []).some(page =>
        Number(page.readingLayoutVersion || 1) < MIN_READING_LAYOUT_VERSION ||
        !Array.isArray(page.readingBlocks) ||
        (page.hasVisualContent && page.visualRegionsVersion !== VISUAL_REGION_VERSION)
      )
    );
    if (!candidates.length) return;

    const pdfLayout = await loadPdfLayout();
    const pdfjs = await loadPdfJs();
    for (const book of candidates) {
      try {
        const fileRecord = await getRecord("files", book.id);
        if (!fileRecord?.blob) continue;
        const pdf = await pdfjs.getDocument({
          data: new Uint8Array(await fileRecord.blob.arrayBuffer()),
          cMapUrl: new URL("./cmaps/", PDF_BASE_URL).href,
          cMapPacked: true,
          standardFontDataUrl: new URL("./standard_fonts/", PDF_BASE_URL).href,
          useSystemFonts: true
        }).promise;
        const parsedPages = new Map();
        let inheritedSectionPath = [];
        try {
          for (const existingPage of book.pages || []) {
            const existingText = String(existingPage.text || "").trim();
            const existingBlocks = Array.isArray(existingPage.readingBlocks) ? existingPage.readingBlocks : [];
            if ((existingPage.proofreadMeta?.version === 2 || existingPage.ocrMeta) && existingText) {
              const reflowed = pdfLayout.reflowReadingBlocks(existingBlocks);
              const normalizedExisting = existingText.replace(/\s+/g, "");
              const normalizedReflow = String(reflowed.text || "").replace(/\s+/g, "");
              const safeReflow = normalizedReflow === normalizedExisting ? reflowed : {
                blocks: existingBlocks.map((block, index) => ({ ...block, index })),
                text: existingText,
              };
              const existingPath = safeReflow.blocks.at(-1)?.sectionPath;
              if (Array.isArray(existingPath) && existingPath.length) inheritedSectionPath = existingPath;
              parsedPages.set(existingPage.number, {
                text: safeReflow.text,
                readingBlocks: safeReflow.blocks,
                readingLayoutVersion: pdfLayout.PDF_READING_LAYOUT_VERSION,
                proofreadMeta: existingPage.proofreadMeta?.version === 2 &&
                  Number(existingPage.readingLayoutVersion) === 7
                  ? { ...existingPage.proofreadMeta, recoveryRequired: true }
                  : existingPage.proofreadMeta,
                readingQuality: {
                  ...(existingPage.readingQuality || {}),
                  reflowedWithoutTextLoss: true,
                },
              });
              continue;
            }
            try {
              const page = await pdf.getPage(existingPage.number);
              const content = await page.getTextContent();
              const pageViewport = page.getViewport({ scale: 1 });
              const visual = existingPage.visualRegionsVersion === VISUAL_REGION_VERSION &&
                Array.isArray(existingPage.visualRegions)
                ? null
                : await inspectPageVisualContent(pdfjs, page, content);
              const layout = pdfLayout.buildPdfReadingLayout(content, {
                pageNumber: existingPage.number,
                pageWidth: pageViewport.width,
                pageHeight: pageViewport.height,
                hiddenItemIndexes: visual?.hiddenTextIndexes || existingPage.hiddenTextIndexes || [],
                protectedRegions: visual?.visualRegions || existingPage.visualRegions || [],
                inheritedSectionPath
              });
              const visibleCount = (value) => String(value || "").replace(/\s+/g, "").length;
              if (existingText && visibleCount(layout.text) < visibleCount(existingText) - Math.max(12, visibleCount(existingText) * 0.01)) {
                const reflowed = pdfLayout.reflowReadingBlocks(existingBlocks);
                const normalizedExisting = existingText.replace(/\s+/g, "");
                const normalizedReflow = String(reflowed.text || "").replace(/\s+/g, "");
                const safeReflow = normalizedReflow === normalizedExisting ? reflowed : {
                  blocks: existingBlocks.map((block, index) => ({ ...block, index })),
                  text: existingText,
                };
                parsedPages.set(existingPage.number, {
                  text: safeReflow.text,
                  readingBlocks: safeReflow.blocks,
                  readingLayoutVersion: pdfLayout.PDF_READING_LAYOUT_VERSION,
                  readingQuality: {
                    ...(existingPage.readingQuality || {}),
                    preservedPriorText: true,
                    rejectedRawTextCharacters: visibleCount(layout.text),
                    retainedTextCharacters: visibleCount(existingText),
                  },
                });
                page.cleanup();
                continue;
              }
              if (layout.sectionPath?.length) inheritedSectionPath = layout.sectionPath;
              const readingBlocks = layout.blocks.map((block, index) => ({ ...block, index }));
              parsedPages.set(existingPage.number, {
                text: layout.text || existingPage.text || "",
                readingBlocks,
                readingLayoutVersion: layout.version,
                readingQuality: layout.quality,
                ...(visual ? {
                  hasVisualContent: visual.hasVisualContent,
                  visualContentKinds: visual.visualContentKinds,
                  visualScore: visual.visualScore,
                  visualRegions: attachVisualRegionAnchors(readingBlocks, visual.visualRegions),
                  visualRegionsVersion: VISUAL_REGION_VERSION
                } : {})
              });
              page.cleanup();
            } catch (error) {
              console.warn(`Could not rebuild reading layout for page ${existingPage.number}`, error);
            }
          }
        } finally {
          await pdf.destroy();
        }

        const stored = (await getRecord("books", book.id)) || book;
        const pages = (stored.pages || []).map(page => ({
          ...page,
          ...(parsedPages.get(page.number) || {})
        }));
        const updatedAt = new Date().toISOString();
        const previousVerifiedAt = stored.knowledgeProcessing?.verifiedAt || "";
        const updated = {
          ...stored,
          pages,
          readingLayoutVersion: pdfLayout.PDF_READING_LAYOUT_VERSION,
          readingLayoutUpdatedAt: updatedAt,
          textCharacters: pages.reduce((total, page) => total + String(page.text || "").length, 0),
          knowledgeProcessing: {
            ...(stored.knowledgeProcessing || {}),
            status: "local-indexed",
            localIndexedAt: updatedAt,
            previousVerifiedAt,
            verifiedAt: "",
            verificationPassedAt: "",
            blockedReason: "PDF 阅读结构与图表定位已升级，知识库等待重新校验"
          }
        };
        await putRecord("books", updated);
        const local = BOOKS.find(item => item.id === book.id);
        if (local) Object.assign(local, updated);
        if (STATE.currentView === "reader" && STATE.activeBookId === updated.id) {
          renderApp();
        }
        window.dispatchEvent(new CustomEvent("biandu:local-data-changed", {
          detail: { kind: "pdf-reading-layout", id: updated.id }
        }));
      } catch (error) {
        console.warn(`Could not migrate PDF reading layout for ${book.id}`, error);
      }
    }
  }

  async function loadImportedBooks() {
    try {
      const records = await getAll("books");
      const imported = records
        .filter(book => book.source === "local-pdf")
        .sort((a, b) =>
          String(b.importedAt).localeCompare(String(a.importedAt))
        );

      for (const book of imported) {
        const index = BOOKS.findIndex(item => item.id === book.id);
        if (index >= 0) BOOKS[index] = book;
        else BOOKS.unshift(book);
      }

      const journal = readProgressJournal();
      const journalBooks = [];
      for (const book of imported) {
        const pending = journal[book.id];
        if (!pending?.patch) continue;
        Object.assign(book, pending.patch);
        journalBooks.push(book);
      }

      const dictionary = await getAll("dictionary");
      dictionary.forEach(mergeDictionaryIntoVocabulary);
      renderApp();
      const missingCovers = imported.filter(book => !book.coverDataUrl && !book.originalDeleted);
      if (missingCovers.length) {
        (async () => {
          for (const book of missingCovers) await ensureBookCover(book);
        })();
      }
      for (const book of journalBooks) {
        flushBookProgress(book).catch((error) => console.warn("Could not recover reading position journal", error));
      }
      requestStoragePersistence();
      if (!readingLayoutMigrationStarted) {
        readingLayoutMigrationStarted = true;
        window.setTimeout(() => migrateReadingLayouts(imported), 0);
      }
    } catch (error) {
      console.warn("Could not load local books", error);
      if (String(error?.name || "").includes("Security")) {
        showToast("当前浏览器不允许本地数据库，请使用便读 PWA 打开");
      }
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function dataUrlToBlob(dataUrl) {
    const response = await fetch(dataUrl);
    if (!response.ok) throw new Error("无法读取页面或选区图像。");
    return response.blob();
  }

  async function drawBlobToCanvas(blob, canvas) {
    const bitmap = await createImageBitmap(blob);
    try {
      const cssWidth = Math.min(820, canvas.parentElement?.clientWidth || 680);
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.style.width = `${Math.min(cssWidth, bitmap.width)}px`;
      canvas.style.height = "auto";
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0);
    } finally {
      bitmap.close?.();
    }
  }

  async function renderPdfFallback(bookId, pageNumber, canvas) {
    if (
      !canvas ||
      canvas.dataset.rendering === "true" ||
      canvas.dataset.rendered === "true"
    ) {
      return;
    }
    canvas.dataset.rendering = "true";
    try {
      const book = BOOKS.find(item => item.id === bookId) || (await getRecord("books", bookId));
      const pageRecordValue = book?.pages?.find(item => item.number === pageNumber);
      const snapshot = pageRecordValue?.visualSnapshotAssetId
        ? await getRecord("assets", pageRecordValue.visualSnapshotAssetId)
        : null;
      if (snapshot?.blob) {
        await drawBlobToCanvas(snapshot.blob, canvas);
        canvas.dataset.rendered = "true";
        canvas.dataset.source = "snapshot";
        return;
      }

      const fileRecord = await getRecord("files", bookId);
      if (!fileRecord?.blob) throw new Error("原始 PDF 和页面快照都已不在本机");
      const pdfjs = await loadPdfJs();
      const pdf = await pdfjs.getDocument({
        data: new Uint8Array(await fileRecord.blob.arrayBuffer())
      }).promise;
      try {
        const page = await pdf.getPage(pageNumber);
        const baseViewport = page.getViewport({ scale: 1 });
        const cssWidth = Math.min(820, canvas.parentElement?.clientWidth || 680);
        const scale = cssWidth / baseViewport.width;
        const viewport = page.getViewport({ scale });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const context = canvas.getContext("2d", { alpha: false });
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0]
        }).promise;
        canvas.dataset.rendered = "true";
        canvas.dataset.source = "pdf";
        snapshotCanvasForPage(bookId, pageNumber, canvas).catch(error => {
          console.warn("Could not persist visible page snapshot", error);
        });
      } finally {
        try { await pdf.destroy(); } catch { /* Ignore cleanup failures after rendering. */ }
      }
    } catch (error) {
      canvas.replaceWith(
        Object.assign(document.createElement("div"), {
          textContent: `原始页面加载失败：${error instanceof Error ? error.message : String(error)}`,
          style: "padding:16px;color:var(--terracotta);font-size:13px;"
        })
      );
    } finally {
      canvas.dataset.rendering = "false";
    }
  }

  async function renderPdfPageDataUrl(bookId, pageNumber, options = {}) {
    const fileRecord = await getRecord("files", bookId);
    if (!fileRecord?.blob) throw new Error("原始 PDF 文件已不在本机，无法识别这一页。");
    const pdfjs = await loadPdfJs();
    let pdf;
    try {
      pdf = await pdfjs.getDocument({
        data: new Uint8Array(await fileRecord.blob.arrayBuffer())
      }).promise;
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const maxDimension = Math.max(900, Math.min(2200, Number(options.maxDimension) || 1800));
      const scale = Math.min(maxDimension / base.width, maxDimension / base.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      return canvas.toDataURL("image/jpeg", Number(options.quality) || 0.82);
    } finally {
      try { await pdf?.destroy(); } catch { /* Ignore cleanup failures after rendering. */ }
    }
  }

  async function renderPdfVisualRegionDataUrl(bookId, pageNumber, region) {
    const normalized = region?.normalizedRect;
    if (!normalized) throw new Error("图表区域坐标缺失。");
    const storedBook = (await getRecord("books", bookId)) ||
      BOOKS.find(book => book.id === bookId);
    const storedPage = (storedBook?.pages || []).find(page => page.number === pageNumber);
    const fileRecord = await getRecord("files", bookId);
    let sourceCanvas;
    let pdf;

    if (fileRecord?.blob) {
      const pdfjs = await loadPdfJs();
      try {
        pdf = await pdfjs.getDocument({
          data: new Uint8Array(await fileRecord.blob.arrayBuffer()),
          cMapUrl: new URL("./cmaps/", PDF_BASE_URL).href,
          cMapPacked: true,
          standardFontDataUrl: new URL("./standard_fonts/", PDF_BASE_URL).href,
          useSystemFonts: true
        }).promise;
        const page = await pdf.getPage(pageNumber);
        const base = page.getViewport({ scale: 1 });
        const regionWidth = Math.max(1, normalized.width * base.width);
        const regionHeight = Math.max(1, normalized.height * base.height);
        const targetScale = Math.min(3, Math.max(1.15, 1600 / regionWidth));
        const viewport = page.getViewport({ scale: targetScale });
        sourceCanvas = document.createElement("canvas");
        sourceCanvas.width = Math.max(1, Math.floor(viewport.width));
        sourceCanvas.height = Math.max(1, Math.floor(viewport.height));
        const context = sourceCanvas.getContext("2d", { alpha: false });
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
        await page.render({ canvasContext: context, viewport }).promise;
      } finally {
        try { await pdf?.destroy(); } catch { /* Ignore cleanup failures after rendering. */ }
      }
    } else if (storedPage?.visualSnapshotAssetId) {
      const snapshot = await getRecord("assets", storedPage.visualSnapshotAssetId);
      if (!snapshot?.blob) throw new Error("原始 PDF 和页面快照都已不在本机。");
      const bitmap = await createImageBitmap(snapshot.blob);
      try {
        sourceCanvas = document.createElement("canvas");
        sourceCanvas.width = bitmap.width;
        sourceCanvas.height = bitmap.height;
        const context = sourceCanvas.getContext("2d", { alpha: false });
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
        context.drawImage(bitmap, 0, 0);
      } finally {
        bitmap.close?.();
      }
    } else {
      throw new Error("原始 PDF 已清理，且这一页没有可用的视觉快照。");
    }

    const pageWidth = sourceCanvas.width;
    const pageHeight = sourceCanvas.height;
    const padding = Math.max(3, Math.round(Math.min(pageWidth, pageHeight) * .006));
    const left = Math.max(0, Math.floor(normalized.x * pageWidth - padding));
    const top = Math.max(0, Math.floor(normalized.y * pageHeight - padding));
    const right = Math.min(pageWidth, Math.ceil((normalized.x + normalized.width) * pageWidth + padding));
    const bottom = Math.min(pageHeight, Math.ceil((normalized.y + normalized.height) * pageHeight + padding));
    const cropWidth = Math.max(1, right - left);
    const cropHeight = Math.max(1, bottom - top);
    const maxOutput = 1800;
    const outputScale = Math.min(1, maxOutput / Math.max(cropWidth, cropHeight));
    const output = document.createElement("canvas");
    output.width = Math.max(1, Math.round(cropWidth * outputScale));
    output.height = Math.max(1, Math.round(cropHeight * outputScale));
    const outputContext = output.getContext("2d", { alpha: false });
    outputContext.fillStyle = "#ffffff";
    outputContext.fillRect(0, 0, output.width, output.height);
    outputContext.drawImage(sourceCanvas, left, top, cropWidth, cropHeight, 0, 0, output.width, output.height);
    return output.toDataURL("image/png");
  }

  async function renderVisiblePageVisuals(book) {
    if (!book) return;
    const images = Array.from(document.querySelectorAll(".pdf-visual-image[data-book-id]"));
    for (const image of images) {
      if (image.dataset.loading === "true" || image.dataset.rendered === "true") continue;
      const pageNumber = Number(image.getAttribute("data-page"));
      const regionIndex = Number(image.getAttribute("data-region-index"));
      const pageValue = pageRecord(book, pageNumber);
      const region = pageValue?.visualRegions?.[regionIndex];
      if (!region) continue;
      image.dataset.loading = "true";
      const key = `${book.id}:${pageNumber}:${regionIndex}:${region.id || ""}`;
      try {
        let source = visualRegionCache.get(key);
        if (!source) {
          source = await renderPdfVisualRegionDataUrl(book.id, pageNumber, region);
          visualRegionCache.set(key, source);
          while (visualRegionCache.size > 24) {
            visualRegionCache.delete(visualRegionCache.keys().next().value);
          }
        }
        const continuousMode = Boolean(document.querySelector(".real-reader-article[data-continuous]"));
        if (currentImportedBook()?.id === book.id && (continuousMode || STATE.readerPage === pageNumber) && image.isConnected) {
          image.src = source;
          image.dataset.rendered = "true";
        }
      } catch (error) {
        image.alt = `图表加载失败：${error instanceof Error ? error.message : String(error)}`;
        image.dataset.failed = "true";
      } finally {
        image.dataset.loading = "false";
      }
    }
  }

  function pageSnapshotAssetId(bookId, pageNumber) {
    return `page-snapshot-${String(bookId).replace(/[^A-Za-z0-9_-]/g, "-")}-${pageNumber}`;
  }

  async function updatePageSnapshotMetadata(bookId, pageNumber, asset) {
    const stored = await getRecord("books", bookId);
    if (!stored) return;
    const pages = (stored.pages || []).map(page => page.number === pageNumber
      ? {
          ...page,
          visualSnapshotAssetId: asset.id,
          visualSnapshotMime: asset.mime,
          visualSnapshotWidth: asset.width,
          visualSnapshotHeight: asset.height,
          visualSnapshotCreatedAt: asset.createdAt
        }
      : page);
    await putRecord("books", { ...stored, pages });
    const local = BOOKS.find(book => book.id === bookId);
    if (local) local.pages = pages;
  }

  async function persistPageSnapshotBlob(bookId, pageNumber, blob, details = {}) {
    let width = Number(details.width) || 0;
    let height = Number(details.height) || 0;
    if ((!width || !height) && blob) {
      try {
        const bitmap = await createImageBitmap(blob);
        width = bitmap.width;
        height = bitmap.height;
        bitmap.close?.();
      } catch { /* Dimensions are optional metadata. */ }
    }
    const asset = {
      id: pageSnapshotAssetId(bookId, pageNumber),
      kind: "pdf-page-snapshot",
      name: `第 ${pageNumber} 页原页快照.jpg`,
      mime: blob.type || "image/jpeg",
      blob,
      bookId,
      page: pageNumber,
      width,
      height,
      createdAt: details.createdAt || new Date().toISOString()
    };
    await putRecord("assets", asset);
    await updatePageSnapshotMetadata(bookId, pageNumber, asset);
    return asset;
  }

  async function snapshotCanvasForPage(bookId, pageNumber, canvas) {
    if (!canvas || !canvas.width || !canvas.height || canvas.dataset.snapshotSaving === "true") return null;
    canvas.dataset.snapshotSaving = "true";
    try {
      const blob = await new Promise((resolve, reject) => canvas.toBlob(
        value => value ? resolve(value) : reject(new Error("无法生成页面快照")),
        "image/jpeg",
        0.78
      ));
      return await persistPageSnapshotBlob(bookId, pageNumber, blob, { width: canvas.width, height: canvas.height });
    } finally {
      canvas.dataset.snapshotSaving = "false";
    }
  }

  async function ensurePageSnapshot(bookId, pageNumber, options = {}) {
    const book = (await getRecord("books", bookId)) || BOOKS.find(item => item.id === bookId);
    const page = book?.pages?.find(item => item.number === Number(pageNumber));
    if (!book || !page) throw new Error(`找不到第 ${pageNumber} 页。`);
    if (page.visualSnapshotAssetId) {
      const existing = await getRecord("assets", page.visualSnapshotAssetId);
      if (existing?.blob) {
        return { asset: existing, dataUrl: await blobToDataUrl(existing.blob) };
      }
    }
    if (book.originalDeleted) throw new Error("原始 PDF 已清理，且这一页没有视觉快照。");
    const dataUrl = await renderPdfPageDataUrl(bookId, pageNumber, {
      maxDimension: Number(options.maxDimension) || 1800,
      quality: Number(options.quality) || 0.78
    });
    const blob = await dataUrlToBlob(dataUrl);
    const asset = await persistPageSnapshotBlob(bookId, pageNumber, blob, options);
    return { asset, dataUrl };
  }

  async function ensureBookCover(book) {
    if (!book || book.coverDataUrl || book.originalDeleted) return book?.coverDataUrl || "";
    try {
      const dataUrl = await renderPdfPageDataUrl(book.id, 1, { maxDimension: 480, quality: 0.78 });
      const stored = await getRecord("books", book.id);
      if (stored) await putRecord("books", { ...stored, coverDataUrl: dataUrl });
      const local = BOOKS.find(item => item.id === book.id);
      if (local) local.coverDataUrl = dataUrl;
      if (STATE.currentView === "library" || STATE.currentView === "book") renderApp();
      return dataUrl;
    } catch (error) {
      console.warn("Could not prepare book cover", book.title, error);
      return "";
    }
  }

  async function ensureBookVisualArchive(bookId, progress = () => {}) {
    let book = await getRecord("books", bookId);
    if (!book) throw new Error("找不到要归档的书籍。");
    if (book.visualArchive?.status === "complete" &&
        (book.pages || []).every(page => page.visualSnapshotAssetId)) {
      return book.visualArchive;
    }
    if (!(book.pages || []).length) throw new Error("没有可归档的页面。");
    if (book.originalDeleted) throw new Error("原始 PDF 已清理，但视觉快照不完整。");
    const total = book.pages.length;
    for (let index = 0; index < total; index += 1) {
      const pageNumber = book.pages[index].number;
      progress({ current: index, total, label: `正在永久保存原页快照 ${index + 1} / ${total}（第 ${pageNumber} 页）` });
      const snapshot = await ensurePageSnapshot(bookId, pageNumber, { maxDimension: 1800, quality: 0.76 });
      book.pages[index] = {
        ...book.pages[index],
        visualSnapshotAssetId: snapshot.asset.id,
        visualSnapshotMime: snapshot.asset.mime,
        visualSnapshotWidth: snapshot.asset.width,
        visualSnapshotHeight: snapshot.asset.height,
        visualSnapshotCreatedAt: snapshot.asset.createdAt
      };
    }
    const completedAt = new Date().toISOString();
    const visualArchive = { status: "complete", pageCount: total, completedAt, format: "jpeg", maxDimension: 1800 };
    book = (await getRecord("books", bookId)) || book;
    const storedPages = (book.pages || []).map((page, index) => ({
      ...page,
      visualSnapshotAssetId: page.visualSnapshotAssetId || BOOKS.find(item => item.id === bookId)?.pages?.[index]?.visualSnapshotAssetId,
      visualSnapshotMime: page.visualSnapshotMime || "image/jpeg"
    }));
    await putRecord("books", { ...book, pages: storedPages, visualArchive });
    const local = BOOKS.find(item => item.id === bookId);
    if (local) { local.pages = storedPages; local.visualArchive = visualArchive; }
    return visualArchive;
  }

  function updateRenderedLabels() {
    const today = getTodayStats();
    document.querySelectorAll("[data-real-reading-time]").forEach(element => {
      element.textContent = `今日阅读 ${formatDuration(today.seconds)}`;
    });

    if (STATE.currentView === "library") {
      document.querySelectorAll(".badge span").forEach(label => {
        if (label.textContent.trim().startsWith("今日阅读")) {
          label.textContent = `今日阅读 ${formatDuration(today.seconds)}`;
        }
      });
    }
  }

  function readerScrollKey(book, continuous) {
    return continuous ? `${book.id}:continuous` : `${book.id}:${book.page}`;
  }

  function readReaderScrollState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(READER_SCROLL_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function readReaderAnchorState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(READER_ANCHOR_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveReaderScrollState(scrollState, anchorState = null) {
    try {
      localStorage.setItem(READER_SCROLL_KEY, JSON.stringify(scrollState));
      if (anchorState) localStorage.setItem(READER_ANCHOR_KEY, JSON.stringify(anchorState));
    } catch { /* The IndexedDB progress journal remains the durable fallback. */ }
  }

  function elementDocumentTop(element, scroll) {
    return element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
  }

  function captureReaderAnchorFrom(scroll, book) {
    if (!scroll || !book) return null;
    const sections = Array.from(scroll.querySelectorAll(".reader-page-section"));
    if (!sections.length) return null;
    const viewportOffset = Math.min(180, Math.max(72, scroll.clientHeight * 0.28));
    const probe = scroll.scrollTop + viewportOffset;
    let currentSection = sections[0];
    for (const section of sections) {
      if (elementDocumentTop(section, scroll) <= probe) currentSection = section;
      else break;
    }
    const page = Number(currentSection.getAttribute("data-page")) || book.page || 1;
    const blocks = Array.from(currentSection.querySelectorAll("[data-paragraph-index]"));
    let block = blocks[0] || null;
    for (const candidate of blocks) {
      if (elementDocumentTop(candidate, scroll) + candidate.getBoundingClientRect().height > probe) {
        block = candidate;
        break;
      }
    }
    const blockTop = block ? elementDocumentTop(block, scroll) : elementDocumentTop(currentSection, scroll);
    return {
      page,
      blockIndex: block ? Number(block.getAttribute("data-paragraph-index")) : null,
      insideOffset: Math.max(0, Math.round(probe - blockTop)),
      viewportOffset: Math.round(viewportOffset),
      scrollTop: Math.round(scroll.scrollTop),
      updatedAt: new Date().toISOString()
    };
  }

  function readerAnchorTarget(scroll, anchor) {
    if (!scroll || !anchor?.page) return null;
    const section = scroll.querySelector(`.reader-page-section[data-page="${Number(anchor.page)}"]`);
    if (!section) return null;
    const block = Number.isInteger(Number(anchor.blockIndex))
      ? section.querySelector(`[data-paragraph-index="${Number(anchor.blockIndex)}"]`)
      : null;
    return block || section;
  }

  function restoreReaderAnchor(scroll, book, anchor) {
    if (!scroll || !book) return false;
    const target = readerAnchorTarget(scroll, anchor);
    if (!target) return false;
    const viewportOffset = Math.max(0, Number(anchor.viewportOffset) || 0);
    const insideOffset = Math.max(0, Number(anchor.insideOffset) || 0);
    const desired = elementDocumentTop(target, scroll) + insideOffset - viewportOffset;
    const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    scroll.scrollTop = Math.max(0, Math.min(maxScrollTop, desired));
    return true;
  }

  function captureReaderAnchor() {
    const book = currentImportedBook();
    const scroll = document.getElementById("realReaderScroll");
    const article = document.querySelector(".real-reader-article");
    if (!book || !scroll || !article || article.getAttribute("data-book-id") !== book.id) return;
    if (STATE.__readerJumpPending) return;
    if (!article.hasAttribute("data-continuous")) return;
    const anchor = captureReaderAnchorFrom(scroll, book);
    if (anchor) {
      STATE.__pendingReaderAnchor = anchor;
      book.readerPosition = anchor;
    }
  }

  function setReaderSidePanel(panel) {
    const next = ["catalog", "notes", "outline"].includes(panel) ? panel : null;
    STATE.readerSidePanel = STATE.readerSidePanel === next ? null : next;
    document.getElementById("readerSidePanel")?.remove();
    const shell = document.querySelector(".real-reader-shell");
    const book = currentImportedBook();
    if (shell && book && STATE.readerSidePanel) {
      shell.insertAdjacentHTML("beforeend", renderReaderSidePanel(book));
    }
    document.getElementById("readerCatalogToggleBtn")?.classList.toggle("btn-tonal", STATE.readerSidePanel === "catalog");
    document.getElementById("readerNotesToggleBtn")?.classList.toggle("btn-tonal", STATE.readerSidePanel === "notes");
    document.getElementById("readerOutlineToggleBtn")?.classList.toggle("btn-tonal", STATE.readerSidePanel === "outline");
  }

  function jumpToReaderLocation(pageNumber, blockIndex = null) {
    const book = currentImportedBook();
    if (!book) return;
    const page = Math.max(1, Math.min(book.totalPages, Number(pageNumber) || 1));
    const parsedBlock = Number(blockIndex);
    STATE.readerSidePanel = null;
    STATE.readerViewMode = "text";
    STATE.readerPage = page;
    book.page = page;
    STATE.__lastImportedReaderPage = page;
    book.progress = book.totalPages <= 1
      ? 100
      : Math.round(((page - 1) / (book.totalPages - 1)) * 100);
    queueBookSave(book).catch(() => {});
    STATE.__readerJumpPending = true;
    STATE.__pendingReaderAnchor = {
      page,
      blockIndex: Number.isInteger(parsedBlock) ? parsedBlock : null,
      insideOffset: 0,
      viewportOffset: 64,
      scrollTop: 0,
      updatedAt: new Date().toISOString()
    };
    renderApp();
  }

  function updateContinuousReadingProgress(book, scroll, anchor = null) {
    if (!book || !scroll) return;
    const currentPage = Number(anchor?.page) || book.page || 1;
    if (anchor) book.readerPosition = anchor;
    if (currentPage !== book.page) {
      book.page = currentPage;
      STATE.readerPage = currentPage;
      STATE.__lastImportedReaderPage = currentPage;
      book.progress = book.totalPages <= 1
        ? 100
        : Math.round(((book.page - 1) / (book.totalPages - 1)) * 100);
      const label = document.getElementById("continuousProgressLabel");
      if (label) label.textContent = `连续阅读 · 当前第 ${book.page} / ${book.totalPages} 页`;
      queueBookSave(book, true).catch(() => {});
    }
  }

  function afterRender() {
    updateRenderedLabels();
    const scroll = document.getElementById("realReaderScroll");
    const article = document.querySelector(".real-reader-article");
    const book = currentImportedBook();

    if (scroll && book && article) {
      const continuous = article.hasAttribute("data-continuous");
      const key = readerScrollKey(book, continuous);
      const isNewReaderDom = scroll.dataset.readerSessionKey !== key;
      if (isNewReaderDom) {
        const stateMap = readReaderScrollState();
        const anchorMap = readReaderAnchorState();
        const pendingAnchor = STATE.__pendingReaderAnchor || null;
        const storedAnchor = book.readerPosition || anchorMap[key] || null;
        scroll.dataset.readerSessionKey = key;
        scroll.dataset.readerRestoring = "true";
        const fallbackTop = STATE.__readerPageChanged && !continuous
          ? 0
          : Number(stateMap[key] || 0);
        const restore = () => {
          if (!scroll.isConnected) return;
          if (continuous && !restoreReaderAnchor(scroll, book, pendingAnchor || storedAnchor)) {
            scroll.scrollTop = Math.max(0, Math.min(
              Math.max(0, scroll.scrollHeight - scroll.clientHeight),
              Number(pendingAnchor?.scrollTop ?? fallbackTop) || 0
            ));
          } else if (!continuous) {
            scroll.scrollTop = fallbackTop;
          }
        };
        restore();
        requestAnimationFrame(() => {
          restore();
          requestAnimationFrame(() => {
            scroll.dataset.readerRestoring = "false";
            STATE.__readerJumpPending = false;
          });
        });
        STATE.__pendingReaderAnchor = null;
      }
      STATE.__readerPageChanged = false;
      if (scroll.dataset.bound !== "true") {
        scroll.dataset.bound = "true";
        let scrollFrame = 0;
        scroll.addEventListener(
          "scroll",
          () => {
            if (!scroll.isConnected || scroll.dataset.readerRestoring === "true" || scrollFrame) return;
            scrollFrame = requestAnimationFrame(() => {
              scrollFrame = 0;
              if (!scroll.isConnected || scroll.dataset.readerRestoring === "true") return;
              const latestBook = currentImportedBook();
              if (!latestBook || latestBook.id !== book.id) return;
              const stateMap = readReaderScrollState();
              stateMap[key] = Math.round(scroll.scrollTop);
              if (continuous) {
                const anchor = captureReaderAnchorFrom(scroll, latestBook);
                const anchorMap = readReaderAnchorState();
                if (anchor) anchorMap[key] = anchor;
                saveReaderScrollState(stateMap, anchorMap);
                updateContinuousReadingProgress(latestBook, scroll, anchor);
              } else {
                saveReaderScrollState(stateMap);
              }
            });
          },
          { passive: true }
        );
      }

      const fallback = document.getElementById("pdfFallbackCanvas");
      if (fallback) renderPdfFallback(book.id, book.page, fallback);
      renderVisiblePageVisuals(book);
      if (continuous) applyReaderHighlights(book);
      else bindPageRegionSelection();
    }

    if (STATE.__markWordFromLongPress && book && STATE.readerWordPopupOpen) {
      STATE.__markWordFromLongPress = false;
      const word = STATE.activePopupWord;
      markDictionaryWord(word).then(entry => {
        STATE.__wordPopupData = entry;
        if (
          currentImportedBook()?.id === book.id &&
          STATE.activePopupWord === word
        ) {
          renderApp();
        }
      });
    }
  }

  function selectionViewportRect(range) {
    const rect = range?.getBoundingClientRect?.();
    if (!rect || !Number.isFinite(rect.left)) return null;
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    };
  }

  function selectedTextKind(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value) return null;
    if (/^[\p{Script=Latin}][\p{Script=Latin}'’\-]*$/u.test(value)) return "word";
    if (value.length > 700) return null;
    const sentenceParts = value
      .split(/(?<=[.!?。！？])\s+/u)
      .map(part => part.trim())
      .filter(Boolean);
    if (sentenceParts.length > 2) return null;
    if (/\p{Script=Latin}/u.test(value) && !/\p{Script=Han}/u.test(value) &&
        (value.match(/\p{Script=Latin}/gu) || []).length >= 2) return "sentence";
    return null;
  }

  function clearReaderTextSelection() {
    STATE.readerSelectionText = "";
    STATE.readerSelectionKind = null;
    STATE.readerSelectionRect = null;
    STATE.readerSelectedImage = null;
    STATE.activePopupWord = "";
    STATE.readerWordPopupOpen = false;
    document.querySelectorAll(".word-token.is-selected").forEach(node => node.classList.remove("is-selected"));
  }

  function syncReaderActionAvailability() {
    const kind = STATE.readerSelectionKind;
    const translate = document.getElementById("readerTranslateSelectionBtn");
    const dictionary = document.getElementById("readerAddDictionaryBtn");
    const note = document.getElementById("readerSentenceNoteBtn");
    if (translate) {
      translate.setAttribute("aria-disabled", String(!(kind === "word" || kind === "sentence")));
      translate.classList.toggle("is-unavailable", !(kind === "word" || kind === "sentence"));
    }
    if (dictionary) {
      dictionary.setAttribute("aria-disabled", String(kind !== "word"));
      dictionary.classList.toggle("is-unavailable", kind !== "word");
    }
    if (note) {
      note.setAttribute("aria-disabled", String(kind !== "sentence"));
      note.classList.toggle("is-unavailable", kind !== "sentence");
    }
  }

  function selectReaderWordToken(token) {
    if (!token || STATE.readerViewMode !== "text") return;
    STATE.__suppressReaderSelectionClearUntil = performance.now() + 180;
    const word = token.getAttribute("data-word") || token.textContent || "";
    if (!word) return;
    window.getSelection()?.removeAllRanges();
    document.querySelectorAll(".word-token.is-selected").forEach(node => node.classList.remove("is-selected"));
    token.classList.add("is-selected");
    const pageNode = token.closest("[data-page]");
    STATE.readerSelectionText = word;
    STATE.readerSelectionKind = "word";
    STATE.readerSelectionRect = selectionViewportRect(token.getBoundingClientRect ? {
      getBoundingClientRect: () => token.getBoundingClientRect()
    } : null);
    STATE.readerSelectedImage = null;
    STATE.activePopupWord = word;
    STATE.readerWordPopupOpen = false;
    STATE.__activeWordPage = Number(pageNode?.getAttribute("data-page")) || STATE.readerPage;
    syncReaderActionAvailability();
    window.BianDuRuntime?.reader?.clearInlineResult?.();
  }

  function updateSelectionToolbar() {
    const article = document.querySelector(".real-reader-article");
    if (!article || STATE.readerViewMode !== "text") {
      clearReaderTextSelection();
      syncReaderActionAvailability();
      return;
    }
    const selection = window.getSelection();
    const text = selection?.toString().replace(/\s+/g, " ").trim() || "";
    const anchor = selection?.anchorNode;
    const focus = selection?.focusNode;
    const inside = anchor && focus &&
      article.contains(anchor.nodeType === Node.TEXT_NODE ? anchor.parentNode : anchor) &&
      article.contains(focus.nodeType === Node.TEXT_NODE ? focus.parentNode : focus);
    if (!text || !inside) {
      if (performance.now() < Number(STATE.__suppressReaderSelectionClearUntil || 0)) return;
      if (!["readerNoteTextarea", "readerInlineNoteText", "readerInlineBoardCanvas"].includes(document.activeElement?.id)) {
        clearReaderTextSelection();
        syncReaderActionAvailability();
      }
      return;
    }
    const range = selection.getRangeAt(0);
    const startElement = range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement : range.startContainer;
    const endElement = range.endContainer.nodeType === Node.TEXT_NODE
      ? range.endContainer.parentElement : range.endContainer;
    const startBlock = startElement?.closest?.("[data-paragraph-index][data-page]");
    const endBlock = endElement?.closest?.("[data-paragraph-index][data-page]");
    if (!startBlock || startBlock !== endBlock) {
      clearReaderTextSelection();
      syncReaderActionAvailability();
      return;
    }
    const kind = selectedTextKind(text);
    STATE.readerSelectionKind = kind;
    STATE.readerSelectionText = kind ? text.slice(0, 700) : "";
    STATE.readerSelectionRect = selectionViewportRect(range);
    STATE.readerSelectedImage = null;
    STATE.readerWordPopupOpen = false;
    STATE.activePopupWord = kind === "word" ? text : "";
    STATE.__activeWordPage = Number(startBlock.getAttribute("data-page")) || STATE.readerPage;
    if (kind === "word") {
      document.querySelectorAll(".word-token.is-selected").forEach(node => node.classList.remove("is-selected"));
      const target = startElement?.closest?.(".word-token");
      if (target) target.classList.add("is-selected");
    }
    const inline = window.BianDuRuntime?.reader?.getState?.().inlineTranslation;
    if (inline?.selectionText && inline.selectionText !== STATE.readerSelectionText) {
      window.BianDuRuntime.reader.clearInlineResult?.();
    }
    const book = currentImportedBook();
    if (book && Number.isFinite(STATE.__activeWordPage)) {
      STATE.readerPage = STATE.__activeWordPage;
      book.page = STATE.__activeWordPage;
      STATE.__lastImportedReaderPage = STATE.__activeWordPage;
      book.progress = book.totalPages <= 1
        ? 100
        : Math.round(((STATE.__activeWordPage - 1) / (book.totalPages - 1)) * 100);
      queueBookSave(book).catch(() => {});
    }
    syncReaderActionAvailability();
  }

  function setReaderRegionSelecting(value) {
    STATE.readerRegionSelecting = Boolean(value);
    if (!STATE.readerRegionSelecting) {
      const marquee = document.getElementById("readerRegionMarquee");
      if (marquee) marquee.classList.remove("is-visible");
    }
    renderApp();
  }

  function toggleReaderViewMode(mode) {
    STATE.readerViewMode = mode === "original" ? "original" : "text";
    clearReaderTextSelection();
    STATE.readerExcerptAiOpen = false;
    STATE.readerRegionSelecting = false;
    renderApp();
  }

  async function saveReaderRegion(dataUrl, bounds, canvas) {
    const book = currentImportedBook();
    if (!book || !dataUrl) return null;
    const blob = await dataUrlToBlob(dataUrl);
    const assetId = makeId("reader-region");
    const asset = {
      id: assetId,
      kind: "reader-region",
      name: `第 ${book.page} 页图片或公式选区.jpg`,
      mime: blob.type || "image/jpeg",
      blob,
      bookId: book.id,
      page: book.page,
      bounds,
      sourceWidth: canvas.width,
      sourceHeight: canvas.height,
      createdAt: new Date().toISOString()
    };
    await putRecord("assets", asset);
    STATE.readerSelectedImage = {
      assetId,
      dataUrl,
      bookId: book.id,
      page: book.page,
      bounds,
      width: bounds.width,
      height: bounds.height,
      createdAt: asset.createdAt
    };
    STATE.readerSelectionText = "";
    STATE.readerRegionSelecting = false;
    STATE.readerExcerptAiOpen = true;
    STATE.__imageSelectionDefaultQuestion = "请解释我框选的图片、图表或公式，并说明其中可确认的关键信息。";
    window.dispatchEvent(new CustomEvent("biandu:local-data-changed", { detail: { kind: "reader-region", id: assetId } }));
    return asset;
  }

  function bindPageRegionSelection() {
    const stage = document.getElementById("readerPageStage");
    const canvas = stage?.querySelector("#pdfFallbackCanvas");
    const marquee = stage?.querySelector("#readerRegionMarquee");
    if (!stage || !canvas || !marquee || stage.dataset.regionBound === "true") return;
    stage.dataset.regionBound = "true";
    let selecting = false;
    let start = null;

    function localPoint(event) {
      const canvasRect = canvas.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const x = Math.max(canvasRect.left, Math.min(canvasRect.right, event.clientX));
      const y = Math.max(canvasRect.top, Math.min(canvasRect.bottom, event.clientY));
      const originLeft = canvasRect.left - stageRect.left;
      const originTop = canvasRect.top - stageRect.top;
      return {
        x, y, originLeft, originTop, width: canvasRect.width, height: canvasRect.height,
        relativeX: x - canvasRect.left, relativeY: y - canvasRect.top
      };
    }

    function drawMarquee(rect) {
      marquee.style.left = `${rect.left}px`;
      marquee.style.top = `${rect.top}px`;
      marquee.style.width = `${rect.width}px`;
      marquee.style.height = `${rect.height}px`;
      marquee.classList.add("is-visible");
    }

    stage.addEventListener("pointerdown", event => {
      if (!STATE.readerRegionSelecting || event.button > 0 || canvas.dataset.rendered !== "true") return;
      event.preventDefault();
      const point = localPoint(event);
      selecting = true;
      start = point;
      stage.setPointerCapture?.(event.pointerId);
      drawMarquee({ left: point.originLeft + point.relativeX, top: point.originTop + point.relativeY, width: 0, height: 0 });
    });

    stage.addEventListener("pointermove", event => {
      if (!selecting || !start) return;
      event.preventDefault();
      const point = localPoint(event);
      const left = point.originLeft + Math.min(start.relativeX, point.relativeX);
      const top = point.originTop + Math.min(start.relativeY, point.relativeY);
      drawMarquee({ left, top, width: Math.abs(point.relativeX - start.relativeX), height: Math.abs(point.relativeY - start.relativeY) });
    });

    stage.addEventListener("pointerup", async event => {
      if (!selecting || !start) return;
      selecting = false;
      const point = localPoint(event);
      const cssRect = {
        left: Math.min(start.relativeX, point.relativeX),
        top: Math.min(start.relativeY, point.relativeY),
        width: Math.abs(point.relativeX - start.relativeX),
        height: Math.abs(point.relativeY - start.relativeY)
      };
      start = null;
      if (cssRect.width < 12 || cssRect.height < 12) {
        marquee.classList.remove("is-visible");
        showToast("框选区域太小，请重新拖动");
        return;
      }
      const sx = Math.round((cssRect.left / point.width) * canvas.width);
      const sy = Math.round((cssRect.top / point.height) * canvas.height);
      const sw = Math.max(1, Math.round((cssRect.width / point.width) * canvas.width));
      const sh = Math.max(1, Math.round((cssRect.height / point.height) * canvas.height));
      const crop = document.createElement("canvas");
      crop.width = sw;
      crop.height = sh;
      const context = crop.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, sw, sh);
      context.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
      const dataUrl = crop.toDataURL("image/jpeg", 0.9);
      try {
        await saveReaderRegion(dataUrl, { x: sx, y: sy, width: sw, height: sh }, canvas);
        showToast("选区已永久保存在本机，正在打开图片 AI");
        renderApp();
      } catch (error) {
        showToast(`保存选区失败：${error instanceof Error ? error.message : String(error)}`);
      }
    });

    stage.addEventListener("pointercancel", () => {
      selecting = false;
      start = null;
      marquee.classList.remove("is-visible");
    });
  }

  function setReaderPage(pageNumber) {
    const book = currentImportedBook();
    if (!book) return;
    STATE.readerPage = Math.max(1, Math.min(book.totalPages, pageNumber));
    STATE.__lastImportedReaderPage = STATE.readerPage;
    STATE.readerSelectionText = "";
    STATE.readerWordPopupOpen = false;
    STATE.readerSelectedImage = null;
    STATE.readerRegionSelecting = false;
    STATE.__readerPageChanged = true;
    book.page = STATE.readerPage;
    book.progress = book.totalPages <= 1
      ? 100
      : Math.round(((book.page - 1) / (book.totalPages - 1)) * 100);
    flushReadingTime();
    queueBookSave(book, true).catch(() => showToast("阅读位置保存失败，请检查本机存储空间"));
    renderApp();
  }

  document.addEventListener(
    "click",
    event => {
      if (performance.now() < Number(STATE.__readerSuppressActionClickUntil || 0) &&
          event.target.closest("[data-reader-tooltip-title]")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        STATE.__readerSuppressActionClickUntil = 0;
        return;
      }
      if (STATE.currentView === "reader" && STATE.readerViewMode === "text") {
        const wordToken = event.target.closest?.(".real-reader-text .word-token");
        if (wordToken) {
          event.preventDefault();
          event.stopImmediatePropagation();
          selectReaderWordToken(wordToken);
          return;
        }
      }
      if (event.target.closest("#readerSettingsToggleBtn")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setReaderSettingsOpen(!STATE.readerSettingsOpen);
        return;
      }

      if (event.target.closest("#closeReaderSettingsBtn") ||
          (event.target.id === "settingsDrawerBackdrop")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setReaderSettingsOpen(false);
        return;
      }

      if (event.target.closest("#readerAskExcerptAiBtn")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        STATE.readerSettingsOpen = false;
        document.getElementById("settingsDrawerBackdrop")?.remove();
        setReaderExcerptAiOpen(!STATE.readerExcerptAiOpen);
        return;
      }

      if (event.target.closest("#closeExcerptAiDrawerBtn") ||
          (event.target.id === "excerptAiBackdrop")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setReaderExcerptAiOpen(false);
        return;
      }

      const fontOption = event.target.closest(".font-opt-btn");
      const marginOption = event.target.closest(".margin-opt-btn");
      const textColorOption = event.target.closest(".textcolor-opt-btn");
      const themeOption = event.target.closest(".theme-opt-btn");
      if (fontOption || marginOption || textColorOption || themeOption) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (fontOption) STATE.readerFont = fontOption.getAttribute("data-font");
        if (marginOption) STATE.readerMargin = marginOption.getAttribute("data-margin");
        if (textColorOption) STATE.readerTextColor = textColorOption.getAttribute("data-color");
        if (themeOption) STATE.readerTheme = themeOption.getAttribute("data-theme");
        saveReaderPreferences();
        applyReaderFormattingPreservingPosition();
        return;
      }

      if (event.target.closest("#quickFontDecBtn, #quickFontIncBtn")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const delta = event.target.closest("#quickFontDecBtn") ? -1 : 1;
        STATE.readerFontSize = Math.max(15, Math.min(30, STATE.readerFontSize + delta));
        saveReaderPreferences();
        applyReaderFormattingPreservingPosition();
        const label = document.querySelector("#quickFontDecBtn + span");
        if (label) label.textContent = `${STATE.readerFontSize}px`;
        return;
      }

      const panelToggle = event.target.closest(
        "#readerCatalogToggleBtn, #readerNotesToggleBtn, #readerOutlineToggleBtn"
      );
      if (panelToggle && currentImportedBook()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const panel = panelToggle.id === "readerCatalogToggleBtn"
          ? "catalog"
          : panelToggle.id === "readerNotesToggleBtn"
            ? "notes"
            : "outline";
        setReaderSidePanel(panel);
        return;
      }

      if (event.target.closest("#closeReaderSidePanelBtn")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        STATE.readerSidePanel = null;
        document.getElementById("readerSidePanel")?.remove();
        document.getElementById("readerCatalogToggleBtn")?.classList.remove("btn-tonal");
        document.getElementById("readerNotesToggleBtn")?.classList.remove("btn-tonal");
        document.getElementById("readerOutlineToggleBtn")?.classList.remove("btn-tonal");
        return;
      }

      const panelTab = event.target.closest("[data-reader-panel]");
      if (panelTab) {
        event.preventDefault();
        event.stopImmediatePropagation();
        STATE.readerSidePanel = panelTab.getAttribute("data-reader-panel");
        const shell = document.querySelector(".real-reader-shell");
        const book = currentImportedBook();
        if (shell && book) {
          document.getElementById("readerSidePanel")?.remove();
          shell.insertAdjacentHTML("beforeend", renderReaderSidePanel(book));
        }
        document.getElementById("readerCatalogToggleBtn")?.classList.toggle("btn-tonal", STATE.readerSidePanel === "catalog");
        document.getElementById("readerNotesToggleBtn")?.classList.toggle("btn-tonal", STATE.readerSidePanel === "notes");
        document.getElementById("readerOutlineToggleBtn")?.classList.toggle("btn-tonal", STATE.readerSidePanel === "outline");
        return;
      }

      const deleteHighlight = event.target.closest(".reader-delete-highlight");
      if (deleteHighlight) {
        event.preventDefault();
        event.stopImmediatePropagation();
        removeReaderHighlight(deleteHighlight.getAttribute("data-highlight-id"))
          .catch(error => showToast(`删除划线失败：${error instanceof Error ? error.message : String(error)}`));
        return;
      }

      const readerJump = event.target.closest("[data-reader-jump-page]");
      if (readerJump) {
        event.preventDefault();
        event.stopImmediatePropagation();
        jumpToReaderLocation(
          Number(readerJump.getAttribute("data-reader-jump-page")),
          readerJump.hasAttribute("data-reader-jump-block")
            ? Number(readerJump.getAttribute("data-reader-jump-block"))
            : null
        );
        return;
      }

      if (event.target.closest("#readerGenerateOutlineBtn") && currentImportedBook()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        generateReaderAiOutline(currentImportedBook());
        return;
      }

      if (event.target.closest("#openImportPdfBtn")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (location.protocol === "file:") {
          showImportError(
            "PDF 导入需要从本地服务或已安装的便读 PWA 打开。请运行 npm start 后访问 http://127.0.0.1:4173。"
          );
          return;
        }
        ensureFileInput().click();
        return;
      }

      if (event.target.closest("#realPrevPageBtn")) {
        setReaderPage((currentImportedBook()?.page || 1) - 1);
        return;
      }

      if (event.target.closest("#realNextPageBtn")) {
        setReaderPage((currentImportedBook()?.page || 1) + 1);
        return;
      }

      if (event.target.closest("#readerViewModeBtn")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleReaderViewMode(STATE.readerViewMode === "original" ? "text" : "original");
        return;
      }

      if (event.target.closest("#readerVisualSelectBtn, #readerRegionSelectBtn")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (STATE.readerViewMode !== "original") STATE.readerViewMode = "original";
        STATE.readerRegionSelecting = !STATE.readerRegionSelecting;
        STATE.readerExcerptAiOpen = false;
        renderApp();
        if (STATE.readerRegionSelecting) showToast("原页视图已开启：请直接拖动画出图片或公式区域");
        return;
      }

      if (event.target.closest("#realHighlightSelectionBtn")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        saveReaderHighlight().catch(error => showToast(`划线保存失败：${error instanceof Error ? error.message : String(error)}`));
        return;
      }

      if (event.target.closest("#realNoteSelectionBtn")) {
        openNoteComposer(STATE.readerSelectionText || "");
        return;
      }

      if (event.target.closest("#realExplainSelectionBtn")) {
        STATE.readerSelectedImage = null;
        setReaderExcerptAiOpen(true);
        return;
      }

      if (event.target.closest("#realCopySelectionBtn")) {
        const text = STATE.readerSelectionText || "";
        if (text) {
          navigator.clipboard
            ?.writeText(text)
            .then(() => showToast("选段已复制"))
            .catch(() => showToast("复制失败，请长按文字手动复制"));
        }
        return;
      }

      if (event.target.closest("#realBoardSelectionBtn")) {
        if (!window.BianDuRuntime?.reader) showToast("画板模块尚未加载，请刷新页面");
        return;
      }

      if (event.target.closest("#viewDictionaryBtn")) {
        switchView("dict", { selectedWordKey: STATE.activePopupWord });
        return;
      }

      if (event.target.closest("#goToAiSettingsBtn")) {
        switchView("settings");
        return;
      }

      const deleteButton = event.target.closest(".delete-real-note");
      if (deleteButton) {
        const noteId = deleteButton.getAttribute("data-note-id");
        deleteRecord("notes", noteId).then(() => {
          for (const [key, notes] of notesByPage.entries()) {
            notesByPage.set(
              key,
              notes.filter(note => note.id !== noteId)
            );
          }
          renderApp();
          showToast("笔记已删除");
        });
        return;
      }

    },
    true
  );

  document.addEventListener(
    "input",
    event => {
      const settingId = event.target.id;
      const rangeSetting = {
        settingFontSizeSlider: ["readerFontSize", 15, 30, 1],
        settingLineHeightSlider: ["readerLineHeight", 1.4, 2.2, 0.05],
        settingParaSpacingSlider: ["readerParaSpacing", 12, 42, 2],
        settingContentWidthSlider: ["readerContentWidth", 760, 1120, 40],
        settingBrightnessSlider: ["readerBrightness", 65, 100, 1]
      }[settingId];
      if (rangeSetting) {
        event.stopImmediatePropagation();
        const [key, min, max, step] = rangeSetting;
        let value = Number(event.target.value);
        value = Math.max(min, Math.min(max, step < 1 ? value : Math.round(value)));
        STATE[key] = value;
        const label = event.target.closest("div")?.querySelector("strong");
        if (label) {
          label.textContent = key === "readerLineHeight"
            ? String(value)
            : key === "readerBrightness"
              ? `${value}%`
              : `${value}px`;
        }
        saveReaderPreferences();
        applyReaderFormattingPreservingPosition();
        return;
      }
      if (event.target.id === "readerCatalogSearchInput" && currentImportedBook()) {
        const query = event.target.value;
        STATE.readerCatalogQuery = query;
        const results = document.getElementById("readerCatalogResults");
        if (results) results.innerHTML = renderReaderSearchResults(currentImportedBook(), query);
        return;
      }
      if (event.target.id === "readerPageSlider") {
        STATE.__readerPageChanged = true;
      }
    },
    true
  );

  document.addEventListener(
    "change",
    event => {
      if (event.target.id === "readerPageSlider") {
        setReaderPage(Number(event.target.value) || 1);
      }
    },
    true
  );

  document.addEventListener(
    "selectionchange",
    () => {
      if (STATE.currentView === "reader" && currentImportedBook()) {
        updateSelectionToolbar();
      }
    },
    { passive: true }
  );

  document.addEventListener(
    "pointerup",
    () => {
      if (STATE.currentView === "reader" && currentImportedBook()) {
        window.setTimeout(updateSelectionToolbar, 0);
      }
    },
    { passive: true }
  );

  const flushReadingPersistence = () => {
    flushReadingTime();
    flushBookProgress().catch((error) => console.warn("Reading position page-hide save failed", error));
  };
  document.addEventListener("visibilitychange", flushReadingPersistence);
  document.addEventListener("visibilitychange", () => {
    const inReader = STATE.currentView === "reader";
    setReaderFocusMode(inReader && document.visibilityState === "visible");
  });
  window.addEventListener("pagehide", () => setReaderFocusMode(false));
  window.addEventListener("pagehide", flushReadingPersistence);

  document.addEventListener(
    "click",
    event => {
      if (
        event.target.closest("[data-nav]") ||
        event.target.closest("#readerBackLibraryBtn")
      ) {
        flushReadingTime();
        flushBookProgress().catch((error) => console.warn("Reading position navigation save failed", error));
      }
    },
    true
  );

  const mainContent = document.getElementById("mainContent");
  if (mainContent) {
    new MutationObserver(() => requestAnimationFrame(afterRender)).observe(
      mainContent,
      { childList: true, subtree: false }
    );
  }

  window.setInterval(() => {
    flushReadingTime();
    updateRenderedLabels();
  }, 15000);

  window.BianDuFeatures = {
    isImportedBook,
    renderImportedReader,
    importPdfFiles,
    markDictionaryWord,
    flushBookProgress,
    getStorageHealth: () => storageHealthCache || requestStoragePersistence(),
    state: STATE,
    books: BOOKS,
    vocabulary: VOCAB_LIST,
    currentImportedBook,
    pageRecord,
    currentPageSentence,
    renderPdfPageDataUrl,
    ensurePageSnapshot,
    ensureBookCover,
    ensureBookVisualArchive,
    captureReaderAnchor,
    saveReaderPreferences,
    jumpToReaderLocation,
    setReaderFocusMode,
    renderApp,
    showToast,
    openNoteComposer,
    saveInlineReaderNote,
    saveCurrentPageNote,
    db: {
      getAll,
      getRecord,
      putRecord,
      deleteRecord
    }
  };

  loadImportedBooks();
})();
