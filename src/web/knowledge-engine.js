import { chat, hasApiKey, translateTextsWithSpecializedModel } from "./deepseek.js";
import { getSemanticScores } from "./embeddings.js";
import { expandEvidenceByGraph } from "./knowledge-compiler.js";
import { recognizeScannedPage, recognizeVisualPage } from "./vision.js";
import {
  PROMPT_VERSION, buildDictionaryMessages, buildKnowledgeAnswerMessages,
  buildKnowledgeGraphMessages, buildProofreadMessages, buildTranslationMessages,
} from "./prompts.js";
import {
  createId, deleteMany, getAll, getRecord, putMany, putRecord, saveEvidence,
  replaceTranslationsForPage, saveKnowledgeEdge, titleKey, upsertKnowledgeNode,
} from "./repository.js";

const MAX_EXCERPT = 1400;
const MAX_CONTEXT = 12000;
const NODE_KINDS = new Set(["concept", "claim", "person", "paper", "passage", "topic", "event"]);
const RELATION_KINDS = new Set([
  "supports", "contradicts", "causes", "part-of", "similar-to", "contrasts-with",
  "derived-from", "defined-by", "example-of", "personally-related",
]);

function stripText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function paragraphsOf(text) {
  const paragraphs = String(text || "").split(/\n{2,}/).map(stripText).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;
  const lines = String(text || "").split(/\n+/).map(stripText).filter(Boolean);
  if (lines.length > 4) {
    const merged = [];
    for (let index = 0; index < lines.length; index += 3) merged.push(lines.slice(index, index + 3).join(" "));
    return merged;
  }
  return paragraphs;
}

export function splitLongText(text, size = MAX_EXCERPT) {
  const paragraphs = paragraphsOf(text);
  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 1 > size) {
      chunks.push(current.trim());
      current = "";
    }
    if (paragraph.length > size) {
      if (current) chunks.push(current.trim());
      current = "";
      const sentences = paragraph.split(/(?<=[.!?。！？；;])\s*/).filter(Boolean);
      let sentenceChunk = "";
      for (const sentence of sentences) {
        if (sentenceChunk && sentenceChunk.length + sentence.length > size) {
          chunks.push(sentenceChunk.trim());
          sentenceChunk = "";
        }
        const needsSpace = sentenceChunk && !/[\u3400-\u9fff]$/u.test(sentenceChunk) &&
          !/^[\u3400-\u9fff]/u.test(sentence);
        sentenceChunk += `${needsSpace ? " " : ""}${sentence}`;
      }
      if (sentenceChunk) current = sentenceChunk.trim();
    } else {
      current += `${current ? " " : ""}${paragraph}`;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function evidenceIdFor(bookId, page, index) {
  const safeBookId = String(bookId).replace(/[^A-Za-z0-9_-]/g, "-");
  return `ev-${safeBookId}-p${page}-${index}`;
}

function renderedEvidenceBlock(block) {
  return block?.type === "list-item" ? `• ${block.text}` : String(block?.text || "");
}

function unionEvidenceBox(left, right) {
  if (!left) return right ? { ...right } : null;
  if (!right) return left;
  const result = {
    left: Math.min(left.left, right.left),
    right: Math.max(left.right, right.right),
    bottom: Math.min(left.bottom, right.bottom),
    top: Math.max(left.top, right.top),
  };
  return { ...result, width: Math.max(0, result.right - result.left), height: Math.max(0, result.top - result.bottom) };
}

export function buildPageEvidenceLocator(page, chunk, options = {}) {
  const visibleTypes = new Set(["title", "heading", "subheading", "paragraph", "list-item", "caption", "footnote"]);
  const blocks = (page?.readingBlocks || [])
    .map((block, index) => ({ ...block, index: Number.isInteger(block.index) ? block.index : index }))
    .filter((block) => visibleTypes.has(block.type) && stripText(block.text));
  const fallback = {
    locator: { page: page?.number, paragraphId: options.paragraphId, blockIds: [] },
    metadata: { readingLayoutVersion: page?.readingLayoutVersion || null, sectionPath: [], visualRegions: [] },
    endOffset: Number(options.startOffset) || 0,
  };
  if (!blocks.length) return fallback;

  const ranges = [];
  let text = "";
  for (const block of blocks) {
    if (text) text += " ";
    const start = text.length;
    text += stripText(renderedEvidenceBlock(block));
    ranges.push({ block, start, end: text.length });
  }
  const cursor = Math.max(0, Number(options.startOffset) || 0);
  let start = text.indexOf(chunk, cursor);
  if (start < 0 && cursor > 0) start = text.indexOf(chunk);
  if (start < 0) return fallback;
  const end = start + chunk.length;
  const selected = ranges.filter((range) => range.end > start && range.start < end).map((range) => range.block);
  const selectedRegions = new Set(selected.flatMap((block) => block.visualRegionIds || []));
  const regions = (page?.visualRegions || []).filter((region) =>
    selectedRegions.has(region.id) || selectedRegions.has(region.regionId) ||
    selected.some((block) => Number(region.captionBlockIndex) === Number(block.index))
  );
  const sectionPath = selected.map((block) => block.sectionPath || []).find((path) => path.length) ||
    blocks.filter((block) => block.index <= selected[0]?.index && block.sectionPath?.length).at(-1)?.sectionPath || [];
  const boundingBox = selected.reduce((box, block) => unionEvidenceBox(box, block.boundingBox || null), null);
  const visualRegions = regions.slice(0, 12).map((region) => ({
    id: region.regionId || region.id,
    kind: region.visualKind || "visual",
    captionLabel: region.captionLabel || "",
    captionText: region.captionText || "",
    boundingBox: region.pdfRect || null,
  }));
  return {
    locator: {
      page: page?.number,
      paragraphId: options.paragraphId,
      blockIds: selected.map((block) => block.blockId).filter(Boolean),
      boundingBox,
      sectionPath,
      visualRegionIds: visualRegions.map((region) => region.id).filter(Boolean),
    },
    metadata: {
      readingLayoutVersion: page?.readingLayoutVersion || null,
      readingOrder: page?.readingQuality?.readingOrder || null,
      sectionPath,
      visualRegions,
    },
    endOffset: end,
  };
}

export async function indexBookLocal(book) {
  const existing = await getAll("evidence");
  const existingById = new Map(existing.map((item) => [item.id, item]));
  const records = [];
  const desiredIds = new Set();
  const staleEvidenceIds = new Set();
  for (const page of book.pages || []) {
    const chunks = splitLongText(page.text);
    let cursor = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const id = evidenceIdFor(book.id, page.number, index);
      desiredIds.add(id);
      const paragraphId = `${book.id}:p${page.number}:${index}`;
      const context = buildPageEvidenceLocator(page, chunks[index], { paragraphId, startOffset: cursor });
      cursor = context.endOffset;
      const previous = existingById.get(id);
      const record = {
        id, kind: "source-excerpt", sourceId: book.id, sourceTitle: book.title,
        bookId: book.id, page: page.number,
        locator: context.locator,
        metadata: context.metadata,
        layoutVersion: page.readingLayoutVersion || null,
        excerpt: chunks[index], permanent: true, capturedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        active: true, stale: false,
      };
      if (previous) {
        record.capturedAt = previous.capturedAt || record.capturedAt;
        if (previous.excerpt === record.excerpt &&
            JSON.stringify(previous.locator) === JSON.stringify(record.locator) &&
            JSON.stringify(previous.metadata) === JSON.stringify(record.metadata) &&
            previous.active !== false) continue;
      }
      records.push(record);
    }
  }
  const staleAt = new Date().toISOString();
  for (const item of existing) {
    if (item.bookId !== book.id || item.kind !== "source-excerpt" || desiredIds.has(item.id) || item.active === false) continue;
    staleEvidenceIds.add(item.id);
    records.push({ ...item, active: false, stale: true, staleAt, updatedAt: staleAt });
  }
  await putMany("evidence", records);
  if (staleEvidenceIds.size) {
    const staleEmbeddings = (await getAll("embeddings"))
      .filter((item) => staleEvidenceIds.has(item.evidenceId))
      .map((item) => item.id);
    if (staleEmbeddings.length) await deleteMany("embeddings", staleEmbeddings);
  }
  return (await getAll("evidence")).filter((item) => item.bookId === book.id &&
    item.active !== false && !item.stale &&
    ["source-excerpt", "visual-page", "visual-selection"].includes(item.kind));
}

export async function indexBookVisualEvidence(book, progress = () => {}) {
  const pages = (book.pages || []).filter((page) => page.hasVisualContent || page.ocrMeta || page.visualSnapshotAssetId);
  if (!pages.length) {
    const completedAt = new Date().toISOString();
    await putRecord("books", {
      ...book,
      visualKnowledge: { status: "not-needed", pageCount: 0, completedAt },
    });
    return { status: "not-needed", pages: [], completedAt };
  }
  if (!(await hasApiKey("visual"))) {
    throw new Error("这本书包含图片、图表或公式。请先在设置中为“图片与公式讲解”绑定支持图片输入的模型。");
  }

  const features = globalThis.window?.BianDuFeatures;
  if (!features?.ensurePageSnapshot) {
    throw new Error("视觉页面归档模块尚未加载，请刷新页面后重试。");
  }

  const indexed = [];
  const nextPages = [...(book.pages || [])];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    progress({
      current: index, total: pages.length,
      label: `正在整理视觉证据 ${index + 1} / ${pages.length}（第 ${page.number} 页）`,
    });
    const snapshot = await features.ensurePageSnapshot(book.id, page.number, { maxDimension: 1800, quality: 0.78 });
    const result = await recognizeVisualPage(snapshot.dataUrl);
    if (!result.excerpt) throw new Error(`第 ${page.number} 页没有生成可验证的视觉证据，原文已保留。`);
    const evidence = await saveEvidence({
      id: `evidence-visual-${book.id}-p${page.number}`,
      kind: "visual-page", bookId: book.id, sourceId: book.id, sourceTitle: book.title,
      page: page.number,
      locator: { page: page.number, imageAssetId: snapshot.asset.id },
      excerpt: result.excerpt, imageAssetId: snapshot.asset.id, mime: snapshot.asset.mime,
      metadata: {
        recognitionModel: result.recognitionModel,
        confidence: result.confidence,
        visualDescription: result.visualDescription,
        formulas: result.formulas,
        tables: result.tables,
        figures: result.figures,
      },
      permanent: true,
    });
    const updatedPage = {
      ...page,
      visualSnapshotAssetId: snapshot.asset.id,
      visualSnapshotMime: snapshot.asset.mime,
      visualSnapshotWidth: snapshot.asset.width,
      visualSnapshotHeight: snapshot.asset.height,
      visualIndex: {
        status: "complete", evidenceId: evidence.id, indexedAt: new Date().toISOString(),
        recognitionModel: result.recognitionModel, confidence: result.confidence,
      },
    };
    const pageIndex = nextPages.findIndex((item) => item.number === page.number);
    if (pageIndex >= 0) nextPages[pageIndex] = updatedPage;
    indexed.push({ page: page.number, evidenceId: evidence.id, assetId: snapshot.asset.id });
  }

  const completedAt = new Date().toISOString();
  await putRecord("books", {
    ...book, pages: nextPages,
    visualKnowledge: {
      status: "complete", pageCount: pages.length, evidenceCount: indexed.length,
      completedAt, pages: indexed,
    },
    knowledgeProcessing: {
      ...(book.knowledgeProcessing || {}), status: "local-indexed",
      localIndexedAt: completedAt, blockedReason: "视觉证据已更新，知识图谱需要重新校验",
    },
  });
  return { status: "complete", pages: indexed, completedAt };
}

const ENGLISH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is",
  "it", "of", "on", "or", "that", "the", "this", "to", "was", "were", "what", "when",
  "where", "which", "who", "why", "with",
]);
const CJK_STOP_WORDS = new Set(["什么", "如何", "哪些", "这个", "那个", "一下", "之间", "关于", "我的", "我们"]);

function latinVariants(term) {
  const variants = new Set([term]);
  if (term.length > 4 && term.endsWith("ies")) variants.add(`${term.slice(0, -3)}y`);
  if (term.length > 5 && term.endsWith("ing")) variants.add(term.slice(0, -3));
  if (term.length > 4 && term.endsWith("ed")) variants.add(term.slice(0, -2));
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) variants.add(term.slice(0, -1));
  return [...variants];
}

function terms(value) {
  const normalized = String(value || "").normalize("NFKC").toLocaleLowerCase("und")
    .replace(/[’']s\b/g, " ");
  const latin = (normalized.match(/[a-z][a-z'-]{1,}/g) || []).flatMap(latinVariants)
    .filter((term) => !ENGLISH_STOP_WORDS.has(term));
  const chinese = normalized.match(/[\u3400-\u9fff]+/g) || [];
  const cjkTerms = [];
  for (const run of chinese) {
    if (run.length <= 2) cjkTerms.push(run);
    else {
      cjkTerms.push(run);
      for (let index = 0; index < run.length - 1; index += 1) cjkTerms.push(run.slice(index, index + 2));
    }
  }
  return Array.from(new Set([...latin, ...cjkTerms]))
    .filter((item) => item.length > 1 && !CJK_STOP_WORDS.has(item));
}

export function buildKnowledgeAliasIndex(nodes = []) {
  const index = new Map();
  for (const node of nodes) {
    if (!node || node.kind === "book") continue;
    const labels = [node.title, ...(node.aliases || [])]
      .map((label) => stripText(label).toLocaleLowerCase("und"))
      .filter(Boolean);
    for (const evidenceId of node.evidenceIds || []) {
      const current = index.get(evidenceId) || new Set();
      for (const label of labels) current.add(label);
      index.set(evidenceId, current);
    }
  }
  return index;
}

export function rankEvidence(question, evidence, options = {}) {
  const queryTerms = terms(question);
  const phrase = stripText(question).normalize("NFKC").toLocaleLowerCase("und");
  const aliasIndex = buildKnowledgeAliasIndex(options.knowledgeNodes || []);
  const kindMap = {
    "书籍": new Set(["source-excerpt"]), "论文": new Set(["source-excerpt"]),
    "文字笔记": new Set(["text-note"]), "画板": new Set(["canvas-recognition", "annotation"]),
    "词典": new Set(["dictionary-context"]), "AI 总结": new Set(["ai-summary"]),
  };
  const allowed = kindMap[options.filter || "全部来源"];
  return evidence
    .filter((item) => item.permanent && item.excerpt)
    .filter((item) => item.active !== false && item.stale !== true)
    .filter((item) => !allowed || allowed.has(item.kind))
    .map((item) => {
      const text = item.excerpt.normalize("NFKC").toLocaleLowerCase("und");
      const source = String(item.sourceTitle || "").normalize("NFKC").toLocaleLowerCase("und");
      const aliases = [...(aliasIndex.get(item.id) || [])].join(" ");
      let score = 0;
      const matchedTerms = new Set();
      if (phrase.length > 2 && text.includes(phrase)) score += 14;
      if (phrase.length > 2 && source.includes(phrase)) score += 8;
      if (phrase.length > 2 && aliases.includes(phrase)) score += 12;
      for (const term of queryTerms) {
        if (text.includes(term)) { score += term.length > 3 ? 3 : 1.5; matchedTerms.add(term); }
        if (source.includes(term)) { score += 1; matchedTerms.add(term); }
        if (aliases.includes(term)) { score += 2.2; matchedTerms.add(term); }
      }
      const semanticSimilarity = Number(options.semanticScores?.get(item.id) || 0);
      if (semanticSimilarity > 0.2) score += Math.max(0, semanticSimilarity - 0.2) * 20;
      if (item.kind === "text-note" || item.kind === "canvas-recognition") score += 0.4;
      return {
        ...item, score, semanticSimilarity,
        matchCoverage: queryTerms.length ? matchedTerms.size / queryTerms.length : 0,
        matchedTerms: [...matchedTerms],
        matchedAliases: aliases ? [...(aliasIndex.get(item.id) || [])] : [],
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || String(b.capturedAt).localeCompare(String(a.capturedAt)));
}

export function assessRetrievalQuality(ranked) {
  if (!ranked.length) return { level: "none", warning: "没有检索到相关证据。" };
  const top = ranked[0];
  if (top.score >= 12 || top.matchCoverage >= 0.5 || top.semanticSimilarity >= 0.43) return { level: "high", warning: "" };
  if (top.score >= 6 || top.matchCoverage >= 0.22 || top.semanticSimilarity >= 0.3) {
    return { level: "medium", warning: "检索到的证据只覆盖问题的一部分，请核对引用后再采用结论。" };
  }
  return { level: "low", warning: "检索结果与问题关联较弱，当前回答可能不完整，请换用更具体的词或补充资料。" };
}

export function buildEvidenceContext(ranked, options = {}) {
  const selected = [];
  let used = 0;
  const perSourceLimit = Number(options.perSourceLimit) || 8;
  const maxItems = Number(options.maxItems) || 20;
  const sourceCounts = new Map();
  for (const item of ranked) {
    const sourceKey = item.sourceId || item.sourceTitle || item.id;
    const sourceCount = sourceCounts.get(sourceKey) || 0;
    if (sourceCount >= perSourceLimit) continue;
    const excerpt = item.excerpt.slice(0, MAX_EXCERPT);
    if (selected.length >= maxItems || used + excerpt.length > MAX_CONTEXT) break;
    selected.push({ ...item, excerpt });
    used += excerpt.length;
    sourceCounts.set(sourceKey, sourceCount + 1);
  }
  return selected;
}

function validateCitations(result, sentEvidence) {
  const evidenceById = new Map(sentEvidence.map((item) => [item.id, item]));
  const citations = Array.isArray(result.citations) ? result.citations.slice(0, 12) : [];
  const valid = [];
  const seen = new Set();
  const normalize = (value) => String(value).replace(/\s+/g, "").toLocaleLowerCase("und");
  for (const citation of citations) {
    const source = evidenceById.get(String(citation.evidenceId || ""));
    const quote = stripText(citation.quote).slice(0, 300);
    if (!source || !quote || !normalize(source.excerpt).includes(normalize(quote))) continue;
    const key = `${source.id}:${normalize(quote)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({ evidenceId: source.id, quote });
  }
  if (!result.insufficientEvidence && !valid.length) {
    throw new Error("AI 回答没有通过本地证据引用校验，未采用该回答。");
  }
  return { ...result, citations: valid };
}

function sourceTypeForEvidence(evidenceIds, evidenceById) {
  const kinds = new Set(evidenceIds.map((id) => evidenceById.get(id)?.kind));
  const all = (kind) => kinds.size === 1 && kinds.has(kind);
  const sourceKinds = new Set(["source-excerpt", "visual-page", "visual-selection"]);
  const noteKinds = new Set(["text-note", "annotation", "canvas-recognition", "dictionary-context"]);
  if ([...kinds].every((kind) => sourceKinds.has(kind))) return "quote";
  if ([...kinds].every((kind) => noteKinds.has(kind))) return "note";
  if (all("ai-summary")) return "ai_summary";
  return "inference";
}

export function validateKnowledgeAnswer(result, sentEvidence) {
  const evidenceById = new Map(sentEvidence.map((item) => [item.id, item]));
  const validated = validateCitations(result, sentEvidence);
  const insufficientEvidence = result?.insufficientEvidence === true;
  if (insufficientEvidence) return { ...validated, insufficientEvidence, claims: [], citations: [] };
  if (!stripText(result?.answer)) throw new Error("AI 没有返回有效回答。");
  const rawClaims = Array.isArray(result?.claims) ? result.claims.slice(0, 20) : [];
  if (!rawClaims.length) throw new Error("AI 没有按结论分别标注证据，未采用该回答。");
  const claims = rawClaims.map((claim) => {
    const statement = stripText(claim?.statement).slice(0, 700);
    const evidenceIds = Array.isArray(claim?.evidenceIds) ? claim.evidenceIds.map(String) : [];
    if (!statement || !evidenceIds.length) throw new Error("AI 返回了没有证据依据的结论。");
    const unknown = evidenceIds.find((id) => !evidenceById.has(id));
    if (unknown) throw new Error(`AI 使用了未提供的证据编号：${unknown}`);
    const uniqueIds = Array.from(new Set(evidenceIds));
    return { statement, evidenceIds: uniqueIds, sourceType: sourceTypeForEvidence(uniqueIds, evidenceById) };
  });
  return { ...validated, insufficientEvidence, claims };
}

export async function answerKnowledge(question, filter = "全部来源", options = {}) {
  const query = stripText(question);
  if (!query) throw new Error("请输入问题。");
  const [evidence, knowledgeNodes, knowledgeEdges] = await Promise.all([
    getAll("evidence"), getAll("knowledgeNodes"), getAll("knowledgeEdges"),
  ]);
  let semantic = null;
  let semanticWarning = "";
  try {
    semantic = await getSemanticScores(query, evidence);
  } catch (error) {
    semanticWarning = `语义检索暂不可用，已回退到关键词检索：${error.message}`;
  }
  const directlyRanked = rankEvidence(query, evidence, {
    filter, knowledgeNodes, semanticScores: semantic?.scores,
  });
  const initialRanked = buildEvidenceContext(directlyRanked, { maxItems: 7 });
  const expansion = expandEvidenceByGraph(initialRanked, evidence, knowledgeNodes, knowledgeEdges);
  const ranked = buildEvidenceContext(expansion.ranked);
  const retrievalQuality = {
    ...assessRetrievalQuality(ranked),
    mode: semantic ? "hybrid" : "lexical",
    semanticModel: semantic?.profile?.model || "",
    semanticWarning,
    graphExpansion: {
      added: expansion.added.length,
      seedNodes: expansion.seedNodes.map((node) => node.title).slice(0, 8),
      edgeCount: expansion.edgeIds.length,
    },
  };
  if (!ranked.length) {
    return {
      answer: "当前知识库中没有找到足够相关的证据，因此不能据此回答。可以先阅读并整理相关资料，或换个更具体的问题。",
      citations: [], claims: [], insufficientEvidence: true, localOnly: true, evidence: [],
      retrievalQuality, promptVersion: PROMPT_VERSION,
    };
  }
  if (!(await hasApiKey("knowledge"))) {
    return {
      answer: `本地检索找到 ${ranked.length} 条相关证据。尚未配置 AI，当前只展示可核验的原始依据，不会生成无法验证的结论。`,
      citations: ranked.slice(0, 8).map((item) => ({ evidenceId: item.id, quote: item.excerpt.slice(0, 160) })),
      claims: [], insufficientEvidence: false, localOnly: true, evidence: ranked,
      retrievalQuality, promptVersion: PROMPT_VERSION,
    };
  }
  const messages = buildKnowledgeAnswerMessages({
    question: query,
    evidence: ranked,
    history: options.history || "",
  });
  let result = await chat(messages, { task: "knowledge", json: true, temperature: 0.1 });
  let validated;
  try {
    validated = validateKnowledgeAnswer(result, ranked);
  } catch (validationError) {
    result = await chat([
      ...messages,
      { role: "user", content: `上一次输出未通过本地证据校验：${validationError.message}。请严格修正字段并重新输出完整 JSON；不得使用未提供的证据编号，不得把无依据结论写入 answer。` },
    ], { task: "knowledge", json: true, temperature: 0 });
    validated = validateKnowledgeAnswer(result, ranked);
  }
  return {
    ...validated, localOnly: false, evidence: ranked,
    retrievalQuality, promptVersion: PROMPT_VERSION,
  };
}

function validatedEvidenceIds(value, allowedIds) {
  if (!Array.isArray(value)) return [];
  const ids = Array.from(new Set(value.map(String)));
  const unknown = ids.find((id) => !allowedIds.has(id));
  if (unknown) throw new Error(`使用了本批次未提供的证据编号：${unknown}`);
  return ids;
}

export function validateKnowledgeGraphBatch(result, batch, knownNodeTitles = []) {
  const allowedIds = new Set(batch.map((item) => item.id));
  const knownKeys = new Set(knownNodeTitles.map(titleKey));
  const nodes = [];
  const nodeByKey = new Map();
  for (const rawNode of Array.isArray(result?.nodes) ? result.nodes.slice(0, 8) : []) {
    const title = stripText(rawNode?.title).slice(0, 120);
    const summary = stripText(rawNode?.summary).slice(0, 1800);
    const evidenceIds = validatedEvidenceIds(rawNode?.evidenceIds, allowedIds);
    if (!title || !summary || !evidenceIds.length) continue;
    const key = titleKey(title);
    if (nodeByKey.has(key)) {
      const current = nodeByKey.get(key);
      current.evidenceIds = Array.from(new Set([...current.evidenceIds, ...evidenceIds]));
      current.aliases = Array.from(new Set([...current.aliases, ...(rawNode?.aliases || []).map(stripText).filter(Boolean)]));
      continue;
    }
    const node = {
      title,
      kind: NODE_KINDS.has(rawNode?.kind) ? rawNode.kind : "concept",
      summary,
      aliases: Array.isArray(rawNode?.aliases) ? rawNode.aliases.map(stripText).filter(Boolean).slice(0, 12) : [],
      evidenceIds,
    };
    nodes.push(node);
    nodeByKey.set(key, node);
    knownKeys.add(key);
  }
  if (!nodes.length) throw new Error("本批证据没有生成带有有效证据编号的知识节点。");

  const edges = [];
  for (const rawEdge of Array.isArray(result?.edges) ? result.edges.slice(0, 20) : []) {
    const fromKey = titleKey(rawEdge?.from);
    const toKey = titleKey(rawEdge?.to);
    const relation = String(rawEdge?.relation || "");
    const rationale = stripText(rawEdge?.rationale).slice(0, 1200);
    const evidenceIds = validatedEvidenceIds(rawEdge?.evidenceIds, allowedIds);
    if (!fromKey || !toKey || fromKey === toKey || !knownKeys.has(fromKey) || !knownKeys.has(toKey)) continue;
    if (!RELATION_KINDS.has(relation) || !rationale || !evidenceIds.length) continue;
    edges.push({
      from: stripText(rawEdge.from), to: stripText(rawEdge.to), relation, rationale,
      evidenceIds, confidence: Math.max(0, Math.min(1, Number(rawEdge?.confidence) || 0.7)),
    });
  }
  if (nodes.length > 1 && !edges.length) {
    throw new Error("本批知识节点之间没有生成任何有证据依据的关系。");
  }
  return { summary: stripText(result?.summary), nodes, edges };
}

export async function extractBookKnowledge(book, progress = () => {}) {
  const evidence = await indexBookLocal(book);
  if (!evidence.length) throw new Error("这本书没有可整理的文字证据；扫描页需要先完成 OCR。");
  if (!(await hasApiKey("graph"))) throw new Error("请先在设置中配置知识整理模型，再开始 AI 知识整理。");
  const createdNodeIds = new Set();
  const summaries = [];
  const existingNodes = await getAll("knowledgeNodes");
  const knownNodeByTitle = new Map(existingNodes.map((node) => [titleKey(node.title), node]));
  let validEdgeCount = 0;
  const batchSize = 7;
  for (let start = 0; start < evidence.length; start += batchSize) {
    const batch = evidence.slice(start, start + batchSize);
    progress({ current: start, total: evidence.length, label: `正在抽取知识 ${start + 1}-${Math.min(start + batch.length, evidence.length)} / ${evidence.length}` });
    const knownNodeTitles = Array.from(knownNodeByTitle.values())
      .filter((node) => node.kind !== "book")
      .map((node) => node.title)
      .filter(Boolean)
      .slice(-40);
    const messages = buildKnowledgeGraphMessages({ bookTitle: book.title, batch, knownNodeTitles });
    let result = await chat(messages, { task: "graph", json: true, temperature: 0.1 });
    let validated;
    try {
      validated = validateKnowledgeGraphBatch(result, batch, knownNodeTitles);
    } catch (validationError) {
      result = await chat([
        ...messages,
        { role: "user", content: `上一次抽取未通过本地结构校验：${validationError.message}。请只修正 JSON，确保每个节点和关系使用本次提供的 evidenceId，并保证关系端点存在于本次 nodes 或 knownNodeTitles 中。` },
      ], { task: "graph", json: true, temperature: 0 });
      validated = validateKnowledgeGraphBatch(result, batch, knownNodeTitles);
    }

    const titleToId = new Map(knownNodeByTitle);
    for (const normalizedNode of validated.nodes) {
      const node = await upsertKnowledgeNode({
        ...normalizedNode,
      });
      createdNodeIds.add(node.id);
      knownNodeByTitle.set(titleKey(node.title), node);
      titleToId.set(titleKey(node.title), node);
    }
    for (const rawEdge of validated.edges) {
      const fromNodeId = titleToId.get(titleKey(rawEdge.from))?.id;
      const toNodeId = titleToId.get(titleKey(rawEdge.to))?.id;
      if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) continue;
      const edge = await saveKnowledgeEdge({
        ...rawEdge, fromNodeId, toNodeId,
      });
      if (edge) validEdgeCount += 1;
    }
    summaries.push(await saveEvidence({
      id: createId("evidence"), kind: "ai-summary", bookId: book.id,
      sourceId: book.id, sourceTitle: book.title, page: batch[0].page,
      excerpt: validated.summary, permanent: true,
    }));
  }
  const bookNode = await upsertKnowledgeNode({
    kind: "book", title: book.title,
    summary: summaries.map((item) => item.excerpt).join("\n"),
    evidenceIds: evidence.map((item) => item.id),
  });
  if (createdNodeIds.size && !validEdgeCount) {
    throw new Error("AI 没有生成通过证据校验的知识关系，本次整理未通过验证。");
  }
  return { evidence, nodes: [...createdNodeIds], bookNode, summaries, edgeCount: validEdgeCount };
}

export async function translatePage(book, pageNumber, mode = "paragraph", options = {}) {
  const page = (book.pages || []).find((item) => item.number === pageNumber);
  const sourceSegments = translationSourceSegments(page, mode);
  if (!sourceSegments.length) throw new Error("这一页没有可翻译的文字。");
  const sourceTexts = sourceSegments.map((item) => item.text);
  const specialized = await translateTextsWithSpecializedModel(sourceTexts, { signal: options.signal });
  let translations;
  if (specialized) {
    translations = specialized;
  } else {
    const result = await chat(buildTranslationMessages(sourceTexts), {
      task: "translation",
      json: true,
      temperature: 0.1,
      signal: options.signal,
    });
    const segments = Array.isArray(result.segments) ? result.segments : [];
    if (segments.length !== sourceSegments.length) throw new Error("翻译结果不完整，未保存。请重试。");
    translations = sourceSegments.map((_, index) =>
      stripText(segments.find((item) => Number(item?.index) === index + 1)?.translation)
    );
  }
  const records = sourceSegments.map((source, index) => ({
    id: `tr-${book.id}-p${pageNumber}-b${source.paragraphIndex}-s${source.segmentIndex}`,
    bookId: book.id, page: pageNumber, paragraphIndex: source.paragraphIndex,
    segmentIndex: source.segmentIndex,
    original: source.text,
    translation: stripText(translations[index]),
    mode, textVersion: 2, createdAt: new Date().toISOString(),
  }));
  if (records.some((item) => !item.translation)) throw new Error("翻译结果为空，未保存。");
  return replaceTranslationsForPage(book.id, pageNumber, records);
}

function splitSentences(text) {
  const sentences = String(text || "")
    .split(/(?<=[.!?。！？；;])\s+/u)
    .map(stripText)
    .filter(Boolean);
  return sentences.flatMap((sentence) => {
    if (sentence.length <= 240) return [sentence];
    const clauses = sentence.split(/(?<=[,，；;：:])\s+/u).map(stripText).filter(Boolean);
    if (clauses.length < 2) return [sentence];
    const groups = [];
    let current = "";
    for (const clause of clauses) {
      if (current && current.length + clause.length + 1 > 220) {
        groups.push(current);
        current = clause;
      } else {
        current += `${current ? " " : ""}${clause}`;
      }
    }
    if (current) groups.push(current);
    return groups;
  });
}

function splitBlockForTranslation(text, size) {
  const value = stripText(text);
  if (!value || value.length <= size) return value ? [value] : [];
  const chunks = [];
  let current = "";
  for (const sentence of splitSentences(value)) {
    if (current && current.length + sentence.length + 1 > size) {
      chunks.push(current.trim());
      current = "";
    }
    current += `${current ? " " : ""}${sentence}`;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function translationSourceSegments(page, mode) {
  const visibleTypes = new Set(["title", "heading", "subheading", "paragraph", "list-item", "caption", "footnote"]);
  const blocks = (page?.readingBlocks || [])
    .map((block, index) => ({ ...block, index }))
    .filter((block) => visibleTypes.has(block.type) && stripText(block.text));
  if (blocks.length) {
    const segments = [];
    for (const block of blocks) {
      const parts = mode === "sentence" && !["title", "heading", "subheading"].includes(block.type)
        ? splitSentences(block.text)
        : mode === "sentence"
          ? [stripText(block.text)]
          : splitBlockForTranslation(block.text, 1100);
      parts.forEach((text, segmentIndex) => segments.push({
        text, paragraphIndex: block.index, segmentIndex,
      }));
    }
    return segments;
  }
  return splitLongText(page?.text || "", mode === "sentence" ? 520 : 1100)
    .map((text, paragraphIndex) => ({ text, paragraphIndex, segmentIndex: 0 }));
}

export async function enrichDictionaryWord(entry) {
  const occurrence = entry.occurrences?.at(-1);
  if (!occurrence) throw new Error("这个单词没有可用的原句语境。");
  const result = await chat(buildDictionaryMessages(entry, occurrence), { task: "dictionary", json: true, temperature: 0.1 });
  const latest = (await getRecord("dictionary", entry.lemma)) || entry;
  const updated = {
    ...latest, phonetic: stripText(result.phonetic),
    partOfSpeech: stripText(result.partOfSpeech),
    definitionZh: stripText(result.definitionZh),
    occurrences: (latest.occurrences || []).map((item) =>
      item.id === occurrence.id ? { ...item, translation: stripText(result.sentenceTranslation) } : item
    ),
    enrichedAt: new Date().toISOString(),
  };
  if (!updated.definitionZh) throw new Error("AI 未返回有效释义。");
  await putRecord("dictionary", updated);
  return updated;
}

export async function proofreadText(text, options = {}) {
  const source = String(text || "").replace(/\r/g, "").trim();
  if (!source) return source;
  const result = await chat(buildProofreadMessages(source), {
    task: "proofread",
    json: true,
    temperature: 0,
    signal: options.signal,
  });
  const corrected = String(result?.correctedText || "").replace(/\r/g, "").trim();
  if (!corrected) throw new Error("文字校对未返回有效结果。");
  return corrected;
}

function readingBlocksForText(text) {
  return paragraphsOf(text).map((paragraph, index) => ({
    type: "paragraph",
    text: paragraph,
    index,
  }));
}

export async function prepareBookForReading(book, progress = () => {}, options = {}) {
  const features = globalThis.window?.BianDuFeatures;
  const pages = Array.isArray(book.pages) ? book.pages : [];
  const nextPages = [];
  let ocrPages = 0;
  let proofreadPages = 0;
  let proofreadAvailable = null;

  for (let index = 0; index < pages.length; index += 1) {
    if (options.signal?.aborted) {
      const error = new Error("翻译准备已暂停");
      error.name = "AbortError";
      error.cancelled = true;
      throw error;
    }
    const page = pages[index];
    progress({
      current: index,
      total: pages.length,
      label: `正在识别与校对 ${index + 1} / ${pages.length}`,
    });
    let text = String(page?.text || "").trim();
    let ocrMeta = page?.ocrMeta || null;
    let readingBlocks = Array.isArray(page?.readingBlocks) ? page.readingBlocks : [];

    if (!text && !book.originalDeleted && typeof features?.renderPdfPageDataUrl === "function") {
      if (!(await hasApiKey("ocr"))) {
        throw new Error("请先在设置中为“扫描页识别”配置模型，再进行整本处理。");
      }
      const dataUrl = await features.renderPdfPageDataUrl(book.id, page.number, { maxDimension: 1800 });
      const ocr = await recognizeScannedPage(dataUrl);
      const { blocks: recognizedBlocks, text: recognizedText, ...recognitionMeta } = ocr || {};
      text = String(recognizedText || "").trim();
      readingBlocks = Array.isArray(recognizedBlocks) && recognizedBlocks.length
        ? recognizedBlocks.map((block, index) => ({ ...block, index }))
        : readingBlocksForText(text);
      ocrMeta = {
        method: recognitionMeta.recognitionModel || "configured-model",
        recognizedAt: new Date().toISOString(),
        ...recognitionMeta,
        blockCount: readingBlocks.length,
      };
      if (text) ocrPages += 1;
    }

    if (!text) {
      nextPages.push({ ...page, ocrMeta });
      book.pages = nextPages.slice();
      continue;
    }

    if (page.proofreadMeta?.version === 2 && !page.proofreadMeta?.recoveryRequired) {
      nextPages.push({ ...page, text, ocrMeta });
      book.pages = nextPages.slice();
      continue;
    }

    if (proofreadAvailable === null) proofreadAvailable = await hasApiKey("proofread");
    if (!proofreadAvailable) {
      throw new Error("请先在设置中为“文字校对”配置模型，再进行整本处理。");
    }

    const proofreadBlocks = readingBlocks
      .filter((block) => block?.text && !["header", "footer", "visual", "formula"].includes(block.type));
    let corrected = text;
    let correctedBlocks = readingBlocks;
    if (proofreadBlocks.length) {
      const marked = proofreadBlocks.map((block) => `[[B${block.index}]]${block.text}`).join("\n\n");
      const correctedMarked = await proofreadText(marked, { signal: options.signal });
      const correctedByIndex = new Map();
      const pattern = /\[\[B(\d+)\]\]\s*([\s\S]*?)(?=\s*\[\[B\d+\]\]|$)/g;
      let match;
      while ((match = pattern.exec(correctedMarked))) {
        correctedByIndex.set(Number(match[1]), match[2].trim());
      }
      if (proofreadBlocks.some((block) => !correctedByIndex.has(block.index))) {
        throw new Error(`第 ${page.number} 页的文字校对结果分块不完整，已停止以保护图片和公式布局。请重试。`);
      }
      correctedBlocks = readingBlocks.map((block) => correctedByIndex.has(block.index)
        ? { ...block, text: correctedByIndex.get(block.index) }
        : block);
      corrected = correctedBlocks.filter((block) => block?.text).map((block) => block.text).join("\n\n");
    } else if (readingBlocks.some((block) => block?.type === "formula")) {
      corrected = readingBlocks
        .filter((block) => block?.text)
        .map((block) => block.text)
        .join("\n\n");
      correctedBlocks = readingBlocks;
    } else {
      corrected = await proofreadText(text, { signal: options.signal });
      correctedBlocks = readingBlocksForText(corrected);
    }
    if (corrected !== text) proofreadPages += 1;

    nextPages.push({
      ...page,
      text: corrected,
      ocrMeta,
      readingBlocks: correctedBlocks,
      proofreadMeta: {
        version: 2,
        method: "ai-proofread",
        correctedAt: new Date().toISOString(),
        changed: corrected !== text,
      },
    });
    book.pages = nextPages.slice();
  }

  const updated = {
    ...book,
    pages: nextPages,
    textCharacters: nextPages.reduce((total, page) => total + String(page.text || "").length, 0),
    readingPreparation: {
      status: "done",
      textVersion: 2,
      ocrPages,
      proofreadPages,
      pageCount: pages.length,
      completedAt: new Date().toISOString(),
    },
  };
  if (proofreadPages > 0 || ocrPages > 0) {
    const staleTranslations = (await getAll("translations"))
      .filter((item) => item.bookId === book.id)
      .map((item) => item.id);
    if (staleTranslations.length) await deleteMany("translations", staleTranslations);
  }
  await putRecord("books", updated);
  const local = features?.books?.find((item) => item.id === book.id);
  if (local) Object.assign(local, updated);
  return { book: updated, ocrPages, proofreadPages, pageCount: pages.length };
}

export async function translateBook(book, progress = () => {}, onPage = null, options = {}) {
  const pages = (book.pages || []).filter((page) => String(page?.text || "").trim());
  const cachedByPage = new Map();
  for (const record of (await getAll("translations")).filter((item) => item.bookId === book.id && item.textVersion === 2)) {
    const list = cachedByPage.get(record.page) || [];
    list.push(record);
    cachedByPage.set(record.page, list);
  }
  const cachedRecords = pages.flatMap((page) => (cachedByPage.get(page.number) || []).sort(
    (left, right) => left.paragraphIndex - right.paragraphIndex ||
      Number(left.segmentIndex) - Number(right.segmentIndex),
  ));
  const records = [...cachedRecords];
  const missingPages = pages.filter((page) => !(cachedByPage.get(page.number) || []).length);
  for (let index = 0; index < missingPages.length; index += 1) {
    if (options.signal?.aborted) {
      const error = new Error("翻译已暂停");
      error.name = "AbortError";
      error.cancelled = true;
      throw error;
    }
    const page = missingPages[index];
    progress({
      current: index,
      total: missingPages.length,
      label: `正在翻译整本书 · 第 ${index + 1} / ${missingPages.length} 页`,
    });
    const translated = await translatePage(book, page.number, "sentence", { signal: options.signal });
    records.push(...translated);
    if (typeof onPage === "function") onPage(translated, index, missingPages.length);
  }
  return records;
}
