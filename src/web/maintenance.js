import { extractBookKnowledge, indexBookLocal, indexBookVisualEvidence } from "./knowledge-engine.js";
import {
  deleteFileAndUpdateBook, getAll, getRecord, mergeBackupRecords, normalizeWord,
  putRecord, saveEvidence, saveKnowledgeEdge, stores, titleKey, upsertKnowledgeNode,
} from "./repository.js";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function initializeLocalEvidence() {
  const books = await getAll("books");
  for (const book of books) {
    if (book.source !== "local-pdf" || !book.pages?.length) continue;
    await indexBookLocal(book);
    if (!book.knowledgeProcessing?.localIndexedAt) {
      await putRecord("books", {
        ...book,
        knowledgeProcessing: {
          ...(book.knowledgeProcessing || {}),
          status: book.knowledgeProcessing?.status || "local-indexed",
          localIndexedAt: new Date().toISOString(),
        },
      });
    }
  }
  await migratePermanentArtifacts(books);
}

function boardSourceText(board) {
  return [
    board.title,
    board.quote,
    board.ocrText,
    ...(board.elements || [])
      .filter((item) => item.type === "text" || item.type === "sticky")
      .map((item) => item.text),
  ].filter(Boolean).join("\n").trim();
}

async function linkArtifactNode(node, bookNode, evidenceId, rationale) {
  if (!bookNode) return;
  await saveKnowledgeEdge({
    fromNodeId: node.id, toNodeId: bookNode.id, relation: "derived-from",
    rationale, evidenceIds: [evidenceId], confidence: 1, generatedBy: "local-indexer",
  });
}

async function migratePermanentArtifacts(books) {
  const [notes, boards, dictionary, nodes] = await Promise.all([
    getAll("notes"), getAll("boards"), getAll("dictionary"), getAll("knowledgeNodes"),
  ]);
  const boardTitleCounts = new Map();
  for (const board of boards) boardTitleCounts.set(board.title, (boardTitleCounts.get(board.title) || 0) + 1);
  const booksById = new Map(books.map((book) => [book.id, book]));
  const bookNodes = new Map(nodes
    .filter((node) => node.kind === "book")
    .map((node) => [titleKey(node.title), node]));

  for (const note of notes) {
    const text = [note.quote ? `选段：${note.quote}` : "", note.text ? `笔记：${note.text}` : ""]
      .filter(Boolean).join("\n").trim();
    if (!text) continue;
    const book = booksById.get(note.bookId);
    const evidence = await saveEvidence({
      id: `evidence-note-${note.id}`, kind: "text-note", bookId: note.bookId,
      sourceId: note.bookId || note.id, sourceTitle: book?.title || "文字笔记",
      page: note.page, locator: { page: note.page || undefined, noteId: note.id },
      excerpt: text, permanent: true, capturedAt: note.createdAt,
    });
    const node = await upsertKnowledgeNode({
      kind: "note", title: `${book?.title || "阅读"} · 第 ${note.page || "—"} 页笔记`,
      summary: note.text || note.quote || "", evidenceIds: [evidence.id],
    });
    await linkArtifactNode(node, book ? bookNodes.get(titleKey(book.title)) : null, evidence.id, "文字笔记关联到所读书籍");
  }

  for (const board of boards) {
    const text = boardSourceText(board);
    if (!text) continue;
    const book = booksById.get(board.bookId);
    const evidence = await saveEvidence({
      id: `evidence-board-${board.id}`, kind: "canvas-recognition", bookId: board.bookId,
      sourceId: board.bookId || board.id, sourceTitle: book?.title || board.title,
      page: board.page, locator: { page: board.page || undefined, boardId: board.id },
      excerpt: text, permanent: true, capturedAt: board.createdAt,
    });
    const node = await upsertKnowledgeNode({
      kind: "canvas",
      title: board.knowledgeNodeTitle || (boardTitleCounts.get(board.title) > 1
        ? `${board.title} · ${String(board.id).slice(-6)}`
        : board.title),
      summary: text.slice(0, 1200), evidenceIds: [evidence.id],
    });
    await linkArtifactNode(node, book ? bookNodes.get(titleKey(book.title)) : null, evidence.id, "画板关联到所读书籍");
  }

  for (const entry of dictionary) {
    const lemma = normalizeWord(entry.lemma || entry.displayForm);
    if (!lemma) continue;
    const contexts = (entry.occurrences || []).slice(-12).map((occurrence) => occurrence.sentence).filter(Boolean);
    const text = [
      `单词：${entry.displayForm || lemma}`,
      entry.definitionZh ? `释义：${entry.definitionZh}` : "",
      entry.partOfSpeech ? `词性：${entry.partOfSpeech}` : "",
      contexts.length ? `原句：${contexts.join("；")}` : "",
      `标注次数：${entry.count || 0}`,
    ].filter(Boolean).join("\n");
    const latest = entry.occurrences?.at(-1);
    const evidence = await saveEvidence({
      id: `evidence-dictionary-${lemma}`, kind: "dictionary-context", bookId: latest?.bookId,
      sourceId: latest?.bookId || "dictionary", sourceTitle: "语境词典",
      page: latest?.page, locator: { page: latest?.page || undefined, lemma },
      excerpt: text, permanent: true, capturedAt: entry.firstMarkedAt,
    });
    await upsertKnowledgeNode({
      kind: "vocabulary", title: `词汇：${entry.displayForm || lemma}`,
      summary: entry.definitionZh || contexts[0] || "", evidenceIds: [evidence.id],
    });
  }
}

export async function processBookKnowledge(bookId, progress = () => {}) {
  const books = await getAll("books");
  const book = books.find((item) => item.id === bookId);
  if (!book) throw new Error("找不到这本书。");
  if (book.originalDeleted && !book.pages?.length) throw new Error("原文已清理，不能重新进行全文整理。");
  await putRecord("books", {
    ...book,
    knowledgeProcessing: { ...(book.knowledgeProcessing || {}), status: "processing", startedAt: new Date().toISOString(), blockedReason: "" },
  });
  try {
    let currentBook = book;
    if ((book.pages || []).some((page) => page.hasVisualContent || page.ocrMeta)) {
      await indexBookVisualEvidence(currentBook, progress);
      currentBook = await getRecord("books", bookId);
    }
    const features = globalThis.window?.BianDuFeatures;
    if (features?.ensureBookVisualArchive) {
      await features.ensureBookVisualArchive(bookId, progress);
      currentBook = await getRecord("books", bookId);
    }
    const result = await extractBookKnowledge(currentBook, progress);
    if (!result.summaries.length) throw new Error("AI 未生成可保存的知识摘要，本次整理未通过验证。");
    if (!result.nodes.length) throw new Error("AI 未生成带有效证据编号的知识节点，本次整理未通过验证。");
    const verifiedAt = new Date().toISOString();
    await putRecord("books", {
      ...currentBook,
      knowledgeProcessing: {
        ...(currentBook.knowledgeProcessing || {}), status: "verified",
        evidenceSaved: true, summaryReady: true,
        verifiedAt, processedAt: verifiedAt,
        evidenceCount: result.evidence.length, nodeCount: result.nodes.length,
        blockedReason: "",
      },
    });
    return result;
  } catch (error) {
    const latestBook = (await getRecord("books", bookId)) || book;
    await putRecord("books", {
      ...latestBook,
      knowledgeProcessing: {
        ...(latestBook.knowledgeProcessing || {}), status: "failed",
        blockedReason: error instanceof Error ? error.message : String(error),
        failedAt: new Date().toISOString(),
      },
    });
    throw error;
  }
}

export async function processUnverifiedBooks(progress = () => {}) {
  const books = (await getAll("books")).filter((book) => book.source === "local-pdf" && !book.originalDeleted && book.pages?.length &&
    (book.knowledgeProcessing?.status !== "verified" || book.visualArchive?.status !== "complete"));
  const results = [];
  for (const book of books) {
    results.push(await processBookKnowledge(book.id, progress));
  }
  return results;
}

export function cleanupEligibility(book, now = new Date()) {
  const processing = book.knowledgeProcessing || {};
  const verifiedAt = processing.verifiedAt || processing.processedAt;
  const elapsed = verifiedAt ? now.getTime() - Date.parse(verifiedAt) : Number.NaN;
  const eligibleAt = verifiedAt ? new Date(Date.parse(verifiedAt) + RETENTION_MS).toISOString() : null;
  const blockers = [];
  if (book.originalDeleted || !book.pages?.length) blockers.push("原文已清理");
  if (processing.status !== "verified") blockers.push("知识整理未通过验证");
  if (!processing.evidenceSaved) blockers.push("永久证据未保存");
  if (!processing.summaryReady) blockers.push("知识摘要未完成");
  if (book.visualArchive?.status !== "complete") blockers.push("视觉页面快照未归档");
  if (book.pages?.some((page) => page.hasVisualContent || page.ocrMeta) && book.visualKnowledge?.status !== "complete") {
    blockers.push("图片、图表或公式证据未整理");
  }
  if (!Number.isFinite(elapsed) || elapsed < RETENTION_MS) blockers.push("未满 7 天");
  return { eligible: blockers.length === 0, eligibleAt, blockers };
}

export async function runRetentionCleanup(now = new Date()) {
  const report = { books: [], conversations: [] };
  const books = await getAll("books");
  for (const book of books) {
    if (book.source !== "local-pdf") continue;
    const eligibility = cleanupEligibility(book, now);
    if (!eligibility.eligible) continue;
    const cleanedBook = {
      ...book,
      pages: (book.pages || []).map((page) => ({
        number: page.number, text: "", hasVisualContent: Boolean(page.hasVisualContent),
        ocrMeta: null, visualContentKinds: page.visualContentKinds || [],
        visualSnapshotAssetId: page.visualSnapshotAssetId || null,
        visualSnapshotMime: page.visualSnapshotMime || null,
        visualSnapshotWidth: page.visualSnapshotWidth || null,
        visualSnapshotHeight: page.visualSnapshotHeight || null,
        visualIndex: page.visualIndex || null,
      })),
      originalDeleted: true, originalDeletedAt: now.toISOString(),
      originalAvailable: false, knowledgeProcessing: { ...book.knowledgeProcessing, rawDeleted: true },
    };
    await deleteFileAndUpdateBook(book.id, cleanedBook);
    report.books.push({ id: book.id, title: book.title });
  }
  const conversations = await getAll("conversations");
  for (const conversation of conversations) {
    const retention = conversation.retention || {};
    const processed = Date.parse(retention.knowledgeProcessedAt || "");
    if (retention.rawDeletedAt || !conversation.messages?.length) continue;
    if (!retention.summaryReady || !retention.evidenceLinked || !Number.isFinite(processed)) continue;
    if (now.getTime() - processed < RETENTION_MS) continue;
    await putRecord("conversations", {
      ...conversation, messages: [],
      retention: { ...retention, rawDeletedAt: now.toISOString() },
    });
    report.conversations.push({ id: conversation.id, title: conversation.title || "AI 对话" });
  }
  return report;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  return fetch(dataUrl).then((response) => response.blob());
}

export async function exportBackup() {
  const data = {};
  for (const name of Object.values(stores)) {
    if (name === "settings") continue;
    const records = await getAll(name);
    data[name] = await Promise.all(records.map(async (record) => {
      if (!(record.blob instanceof Blob)) return record;
      return { ...record, blob: null, blobDataUrl: await blobToDataUrl(record.blob) };
    }));
  }
  return {
    format: "biandu-backup", version: 2,
    exportedAt: new Date().toISOString(), data,
  };
}

export async function downloadBackup(backup) {
  const filename = `便读备份-${new Date().toISOString().slice(0, 10)}.biandu.json`;
  const content = JSON.stringify(backup);
  const nativePlugin = globalThis.Capacitor?.Plugins?.BianduBackup;
  if (nativePlugin?.saveText) {
    return nativePlugin.saveText({ filename, content });
  }

  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function restoreBackup(backup) {
  if (backup?.format !== "biandu-backup" || ![1, 2].includes(backup.version) || !backup.data) {
    throw new Error("这不是有效的便读备份文件。");
  }
  const stats = { inserted: 0, updated: 0, keptLocal: 0, skipped: 0, stores: {} };
  for (const name of Object.values(stores)) {
    if (name === "settings") continue;
    const records = backup.data[name];
    if (!Array.isArray(records)) continue;
    const restored = await Promise.all(records.map(async (record) => {
      if (!record.blobDataUrl) return record;
      const { blobDataUrl, ...rest } = record;
      return { ...rest, blob: await dataUrlToBlob(blobDataUrl) };
    }));
    const result = await mergeBackupRecords(name, restored);
    stats.stores[name] = result;
    for (const key of ["inserted", "updated", "keptLocal", "skipped"]) stats[key] += result[key];
  }
  return stats;
}
