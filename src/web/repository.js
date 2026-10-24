const DB_NAME = "biandu-local-v1";
const DB_VERSION = 4;

let databasePromise;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function createId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("books")) {
        const books = db.createObjectStore("books", { keyPath: "id" });
        books.createIndex("byHash", "fileHash", { unique: false });
        books.createIndex("byImportedAt", "importedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "id" });
      if (!db.objectStoreNames.contains("notes")) {
        const notes = db.createObjectStore("notes", { keyPath: "id" });
        notes.createIndex("byBookAndPage", ["bookId", "page"], { unique: false });
      }
      if (!db.objectStoreNames.contains("dictionary")) {
        const dictionary = db.createObjectStore("dictionary", { keyPath: "lemma" });
        dictionary.createIndex("byLastMarkedAt", "lastMarkedAt", { unique: false });
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
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

export async function getAll(storeName) {
  const db = await openDatabase();
  return requestResult(db.transaction(storeName, "readonly").objectStore(storeName).getAll());
}

export async function getRecord(storeName, key) {
  const db = await openDatabase();
  return requestResult(db.transaction(storeName, "readonly").objectStore(storeName).get(key));
}

export async function putRecord(storeName, value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function deleteRecord(storeName, key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function queryByIndex(storeName, indexName, query) {
  const db = await openDatabase();
  return requestResult(db.transaction(storeName, "readonly").objectStore(storeName).index(indexName).getAll(query));
}

export async function putMany(storeName, values) {
  if (!values.length) return;
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    for (const value of values) tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function recordKey(store, record) {
  const keyPath = store.keyPath;
  if (Array.isArray(keyPath)) {
    const key = keyPath.map((field) => record?.[field]);
    return key.every((value) => value !== undefined && value !== null) ? key : undefined;
  }
  const key = record?.[keyPath];
  return key === undefined || key === null ? undefined : key;
}

const FRESHNESS_FIELDS = [
  "updatedAt", "lastMarkedAt", "capturedAt", "verifiedAt", "processedAt",
  "importedAt", "createdAt",
];

function recordFreshness(record) {
  let newest = 0;
  for (const field of FRESHNESS_FIELDS) {
    const value = Date.parse(record?.[field] || "");
    if (Number.isFinite(value)) newest = Math.max(newest, value);
  }
  return newest;
}

// Restore is a merge, never a destructive replacement. A backup may be old or
// come from an earlier install, so a locally newer record always wins. Records
// without comparable timestamps also keep the local copy, which is the safest
// choice when the two versions conflict.
export async function mergeBackupRecords(storeName, values) {
  const stats = { inserted: 0, updated: 0, keptLocal: 0, skipped: 0 };
  if (!values.length) return stats;
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    let index = 0;
    let operationError = null;

    const next = () => {
      if (index >= values.length) return;
      const incoming = values[index++];
      const key = recordKey(store, incoming);
      if (key === undefined) {
        stats.skipped += 1;
        next();
        return;
      }
      const request = store.get(key);
      request.onerror = () => {
        stats.skipped += 1;
        next();
      };
      request.onsuccess = () => {
        const current = request.result;
        const commit = () => {
          try {
            store.put(incoming);
            stats.inserted += current ? 0 : 1;
            stats.updated += current ? 1 : 0;
            next();
          } catch (error) {
            operationError = error;
            tx.abort();
          }
        };
        if (!current && storeName === "knowledgeNodes" && incoming.titleKey) {
          const titleRequest = store.index("byTitleKey").get(incoming.titleKey);
          titleRequest.onsuccess = () => {
            if (titleRequest.result) {
              stats.keptLocal += 1;
              next();
            } else {
              commit();
            }
          };
          titleRequest.onerror = () => tx.abort();
        } else if (!current) {
          commit();
        } else if (recordFreshness(incoming) > recordFreshness(current)) {
          try {
            store.put(incoming);
            stats.updated += 1;
            next();
          } catch (error) {
            operationError = error;
            tx.abort();
          }
        } else {
          stats.keptLocal += 1;
          next();
        }
      };
    };

    next();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("备份合并事务失败。"));
    tx.onabort = () => reject(operationError || tx.error || new Error("备份合并事务已中止。"));
  });
  return stats;
}

export async function replaceTranslationsForPage(bookId, pageNumber, records) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("translations", "readwrite");
    const store = tx.objectStore("translations");
    let operationError = null;
    const request = store.index("byBookAndPage").getAllKeys([bookId, pageNumber]);
    request.onsuccess = () => {
      try {
        for (const key of request.result) store.delete(key);
        for (const record of records) store.put(record);
      } catch (error) {
        operationError = error;
        tx.abort();
      }
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("翻译保存事务失败。"));
    tx.onabort = () => reject(operationError || tx.error || new Error("翻译保存事务已中止。"));
  });
  return records;
}

export async function deleteFileAndUpdateBook(bookId, bookRecord) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(["files", "books"], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("原文清理事务失败。"));
    tx.onabort = () => reject(tx.error || new Error("原文清理事务已中止。"));
    try {
      tx.objectStore("files").delete(bookId);
      tx.objectStore("books").put(bookRecord);
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}

export async function deleteMany(storeName, keys) {
  if (!keys.length) return;
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    for (const key of keys) tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function normalizeWord(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("en")
    .replace(/^[^a-z]+|[^a-z'-]+$/g, "");
}

export function titleKey(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim();
}

export async function saveEvidence(input) {
  const now = new Date().toISOString();
  const record = {
    id: input.id || createId("evidence"), kind: input.kind,
    sourceId: input.sourceId || input.bookId || "manual",
    sourceTitle: input.sourceTitle || "本地资料", bookId: input.bookId || null,
    page: Number(input.page) || null,
    locator: input.locator || { page: Number(input.page) || undefined },
    excerpt: String(input.excerpt || "").trim(), permanent: input.permanent !== false,
    imageAssetId: input.imageAssetId || null,
    mime: input.mime || null,
    region: input.region || null,
    metadata: input.metadata || null,
    capturedAt: input.capturedAt || now, updatedAt: now,
  };
  if (!record.excerpt) throw new Error("证据内容不能为空。");
  await putRecord("evidence", record);
  return record;
}

export async function upsertKnowledgeNode(input) {
  const nodes = await getAll("knowledgeNodes");
  const key = titleKey(input.title);
  if (!key) throw new Error("知识节点标题不能为空。");
  const existing = nodes.find((node) => node.titleKey === key);
  const now = new Date().toISOString();
  const node = {
    id: existing?.id || input.id || createId("node"), kind: input.kind || existing?.kind || "concept",
    title: String(input.title).trim(), titleKey: key,
    aliases: Array.from(new Set([...(existing?.aliases || []), ...(input.aliases || [])])),
    summary: String(input.summary || existing?.summary || "").trim(),
    evidenceIds: Array.from(new Set([...(existing?.evidenceIds || []), ...(input.evidenceIds || [])])),
    createdAt: existing?.createdAt || now, updatedAt: now,
    revision: (existing?.revision || 0) + 1,
    x: Number.isFinite(input.x) ? input.x : existing?.x,
    y: Number.isFinite(input.y) ? input.y : existing?.y,
  };
  await putRecord("knowledgeNodes", node);
  return node;
}

export async function saveKnowledgeEdge(input) {
  if (!input.fromNodeId || !input.toNodeId || input.fromNodeId === input.toNodeId) return null;
  const edges = await getAll("knowledgeEdges");
  const same = edges.find((edge) => edge.fromNodeId === input.fromNodeId &&
    edge.toNodeId === input.toNodeId && edge.relation === input.relation);
  const edge = {
    id: same?.id || input.id || createId("edge"), fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId, relation: input.relation,
    rationale: String(input.rationale || "").trim(),
    evidenceIds: Array.from(new Set([...(same?.evidenceIds || []), ...(input.evidenceIds || [])])),
    confidence: Math.max(0, Math.min(1, Number(input.confidence) || 0.7)),
    generatedBy: input.generatedBy || "ai", generatedAt: input.generatedAt || new Date().toISOString(),
  };
  await putRecord("knowledgeEdges", edge);
  return edge;
}

export async function saveSettings(settings) {
  return putRecord("settings", { key: "app-settings", ...settings, updatedAt: new Date().toISOString() });
}

export async function loadSettings() {
  return (await getRecord("settings", "app-settings")) || {};
}

export const stores = Object.freeze({
  books: "books", files: "files", notes: "notes", dictionary: "dictionary",
  boards: "boards", assets: "assets", evidence: "evidence", nodes: "knowledgeNodes",
  edges: "knowledgeEdges", conversations: "conversations", translations: "translations",
  embeddings: "embeddings", settings: "settings",
});
