import { chat, hasApiKey } from "./deepseek.js";
import {
  buildKnowledgeWikiAnalysisMessages,
  buildKnowledgeWikiMessages,
} from "./prompts.js";
import {
  getAll,
  getRecord,
  putRecord,
  saveKnowledgeEdge,
  titleKey,
  upsertKnowledgeNode,
} from "./repository.js";

const WIKI_META_KEY = "knowledge-wiki-meta-v1";
const WIKI_VERSION = "llm-wiki-v1";
const MAX_BATCH_EVIDENCE = 10;
const MAX_BATCH_CHARS = 9_000;
const WIKI_KINDS = new Set([
  "concept", "claim", "person", "paper", "topic", "event",
  "note", "canvas", "ai-summary", "source",
]);
const RELATION_KINDS = new Set([
  "supports", "contradicts", "causes", "part-of", "similar-to", "contrasts-with",
  "derived-from", "defined-by", "example-of", "personally-related",
]);
const ORGANIZABLE_KINDS = new Set([
  "source-excerpt", "visual-page", "visual-selection", "text-note", "annotation",
  "canvas-recognition", "ai-summary", "dictionary-context",
]);

function clean(value, limit = 8_000) {
  return String(value ?? "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim().slice(0, limit);
}

function evidenceVersion(item) {
  return String(item.updatedAt || item.capturedAt || "");
}

function validEvidenceIds(value, allowedIds) {
  if (!Array.isArray(value)) return [];
  const ids = Array.from(new Set(value.map(String)));
  const unknown = ids.find((id) => !allowedIds.has(id));
  if (unknown) throw new Error(`Wiki 整理使用了本轮未提供的证据编号：${unknown}`);
  return ids;
}

function pageLookup(existingPages = []) {
  const byKey = new Map();
  const canonicalByLabel = new Map();
  for (const page of existingPages) {
    if (!page?.title) continue;
    byKey.set(titleKey(page.title), page);
    for (const label of [page.title, ...(page.aliases || [])]) {
      const key = titleKey(label);
      if (key) canonicalByLabel.set(key, page.title);
    }
  }
  return { byKey, canonicalByLabel };
}

export function validateKnowledgeWikiBatch(result, batch, existingPages = []) {
  const allowedIds = new Set(batch.map((item) => item.id));
  const { byKey, canonicalByLabel } = pageLookup(existingPages);
  const pages = [];
  const pageByKey = new Map();

  for (const rawPage of Array.isArray(result?.pages) ? result.pages.slice(0, 6) : []) {
    const requestedTitle = clean(rawPage?.title, 120);
    if (!requestedTitle) continue;
    const requestedKey = titleKey(requestedTitle);
    const title = canonicalByLabel.get(requestedKey) || requestedTitle;
    const key = titleKey(title);
    const summary = clean(rawPage?.summary, 2_400);
    const body = clean(rawPage?.body, 12_000) || summary;
    const evidenceIds = validEvidenceIds(rawPage?.evidenceIds, allowedIds);
    if (!key || !summary || !evidenceIds.length) continue;
    const existing = byKey.get(key);
    const kindValue = String(rawPage?.kind || existing?.kind || "concept");
    const page = {
      title,
      kind: WIKI_KINDS.has(kindValue) ? kindValue : "concept",
      summary,
      body,
      aliases: Array.from(new Set([
        ...(existing?.aliases || []),
        ...(Array.isArray(rawPage?.aliases) ? rawPage.aliases.map((item) => clean(item, 100)).filter(Boolean) : []),
      ])).slice(0, 16),
      evidenceIds,
      existing: Boolean(existing),
    };
    if (pageByKey.has(key)) {
      const current = pageByKey.get(key);
      current.evidenceIds = Array.from(new Set([...current.evidenceIds, ...page.evidenceIds]));
      current.aliases = Array.from(new Set([...current.aliases, ...page.aliases]));
      if (body.length > current.body.length) current.body = body;
      continue;
    }
    pages.push(page);
    pageByKey.set(key, page);
    canonicalByLabel.set(key, page.title);
  }

  if (!pages.length) throw new Error("本轮资料没有生成可保存的 Wiki 页面。");

  const links = [];
  for (const rawLink of Array.isArray(result?.links) ? result.links.slice(0, 14) : []) {
    const fromKey = titleKey(rawLink?.from);
    const toKey = titleKey(rawLink?.to);
    const from = canonicalByLabel.get(fromKey);
    const to = canonicalByLabel.get(toKey);
    const relation = String(rawLink?.relation || "");
    const rationale = clean(rawLink?.rationale, 1_200);
    const evidenceIds = validEvidenceIds(rawLink?.evidenceIds, allowedIds);
    if (!from || !to || titleKey(from) === titleKey(to)) continue;
    if (!RELATION_KINDS.has(relation) || !rationale || !evidenceIds.length) continue;
    links.push({
      from,
      to,
      relation,
      rationale,
      evidenceIds,
      confidence: Math.max(0, Math.min(1, Number(rawLink?.confidence) || 0.7)),
    });
  }

  return {
    overview: clean(result?.overview, 3_000),
    pages,
    links,
  };
}

export function buildEvidenceBatches(evidence, maxItems = MAX_BATCH_EVIDENCE, maxChars = MAX_BATCH_CHARS) {
  const batches = [];
  let batch = [];
  let characters = 0;
  for (const item of evidence) {
    const excerpt = clean(item.excerpt, 1_400);
    const card = {
      id: item.id,
      kind: item.kind,
      sourceTitle: clean(item.sourceTitle || "个人资料", 180),
      sourceId: item.sourceId || "",
      bookId: item.bookId || "",
      page: Number(item.page) || null,
      capturedAt: item.capturedAt || "",
      updatedAt: item.updatedAt || "",
      excerpt,
    };
    if (batch.length && (batch.length >= maxItems || characters + excerpt.length > maxChars)) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(card);
    characters += excerpt.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function pageCatalog(nodes) {
  return nodes
    .filter((node) => node?.title && node.kind !== "book")
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
    .slice(0, 60);
}

function nodeLookup(nodes) {
  const byKey = new Map();
  for (const node of nodes) {
    for (const label of [node.title, ...(node.aliases || [])]) {
      const key = titleKey(label);
      if (key && !byKey.has(key)) byKey.set(key, node);
    }
  }
  return byKey;
}

async function linkPageToSources(page, evidenceById, nodes) {
  const books = await getAll("books");
  const bookNodeByTitle = new Map(nodes
    .filter((node) => node.kind === "book")
    .map((node) => [titleKey(node.title), node]));
  const byBook = new Map();
  for (const evidenceId of page.evidenceIds || []) {
    const evidence = evidenceById.get(evidenceId);
    const book = books.find((item) => item.id === evidence?.bookId);
    if (!book) continue;
    const ids = byBook.get(book.id) || [];
    ids.push(evidenceId);
    byBook.set(book.id, ids);
  }
  for (const [bookId, evidenceIds] of byBook) {
    const book = books.find((item) => item.id === bookId);
    const bookNode = bookNodeByTitle.get(titleKey(book?.title));
    if (!bookNode) continue;
    await saveKnowledgeEdge({
      fromNodeId: page.id,
      toNodeId: bookNode.id,
      relation: "derived-from",
      rationale: `该 Wiki 页面由《${book.title}》中的证据整理而来`,
      evidenceIds,
      confidence: 1,
    });
  }
}

export async function organizeKnowledgeBase({ force = false, progress = () => {} } = {}) {
  if (!(await hasApiKey("graph"))) {
    throw new Error("请先为“知识整理”绑定模型，再自动整理个人知识库。");
  }

  const [allEvidence, initialNodes] = await Promise.all([
    getAll("evidence"),
    getAll("knowledgeNodes"),
  ]);
  const evidence = allEvidence.filter((item) =>
    item.permanent && item.active !== false && item.stale !== true &&
    ORGANIZABLE_KINDS.has(item.kind) && clean(item.excerpt)
  );
  if (!evidence.length) {
    return { processed: false, batches: 0, pages: 0, links: 0, message: "当前没有可整理的永久证据。" };
  }

  const storedMeta = (await getRecord("settings", WIKI_META_KEY)) || {};
  const organized = force ? {} : { ...(storedMeta.organizedEvidence || {}) };
  const pending = evidence.filter((item) => organized[item.id] !== evidenceVersion(item));
  if (!pending.length) {
    return {
      processed: false,
      batches: 0,
      pages: initialNodes.filter((node) => node.wiki?.version === WIKI_VERSION).length,
      links: 0,
      message: "知识 Wiki 已是最新。",
      meta: storedMeta,
    };
  }

  const batches = buildEvidenceBatches(pending);
  const touchedNodeIds = new Set();
  let linkCount = 0;
  let overview = storedMeta.overview || "";
  const errors = [];

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    progress({
      current: index + 1,
      total: batches.length,
      label: `AI 正在整理全部知识 ${index + 1} / ${batches.length}`,
    });
    try {
      const nodes = await getAll("knowledgeNodes");
      const existingPages = pageCatalog(nodes);
      const analysis = await chat(buildKnowledgeWikiAnalysisMessages({
        batch,
        existingPages,
        overview,
      }), {
        task: "graph",
        json: true,
        temperature: 0.1,
        timeoutMs: 150_000,
      });
      const generated = await chat(buildKnowledgeWikiMessages({
        analysis,
        batch,
        existingPages,
        overview,
      }), {
        task: "graph",
        json: true,
        temperature: 0.1,
        timeoutMs: 180_000,
      });
      const validated = validateKnowledgeWikiBatch(generated, batch, existingPages);
      overview = validated.overview || overview;
      const now = new Date().toISOString();
      const savedPages = [];
      for (const page of validated.pages) {
        const sourceIds = Array.from(new Set(page.evidenceIds
          .map((id) => batch.find((item) => item.id === id)?.sourceTitle)
          .filter(Boolean)));
        const node = await upsertKnowledgeNode({
          kind: page.kind,
          title: page.title,
          summary: page.summary,
          aliases: page.aliases,
          evidenceIds: page.evidenceIds,
          wiki: {
            version: WIKI_VERSION,
            body: page.body,
            sourceLabels: sourceIds.slice(0, 20),
            overview: validated.overview,
            organizedAt: now,
          },
        });
        touchedNodeIds.add(node.id);
        savedPages.push(node);
      }

      const currentNodes = await getAll("knowledgeNodes");
      const lookup = nodeLookup(currentNodes);
      for (const link of validated.links) {
        const from = lookup.get(titleKey(link.from));
        const to = lookup.get(titleKey(link.to));
        if (!from || !to || from.id === to.id) continue;
        const edge = await saveKnowledgeEdge({
          ...link,
          fromNodeId: from.id,
          toNodeId: to.id,
          generatedBy: "ai-wiki",
        });
        if (edge) linkCount += 1;
      }
      const evidenceById = new Map(batch.map((item) => [item.id, item]));
      for (const page of savedPages) {
        await linkPageToSources(page, evidenceById, currentNodes);
      }
      for (const item of batch) organized[item.id] = evidenceVersion(item);
      await putRecord("settings", {
        key: WIKI_META_KEY,
        version: WIKI_VERSION,
        overview,
        organizedEvidence: organized,
        updatedAt: now,
        pageCount: currentNodes.length,
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (errors.length === batches.length) {
    throw new Error(`知识 Wiki 整理失败：${errors[0]}`);
  }
  const finalNodes = await getAll("knowledgeNodes");
  return {
    processed: true,
    batches: batches.length,
    pages: [...touchedNodeIds].length,
    links: linkCount,
    partialErrors: errors,
    overview: overview || "个人知识网络已按证据重新整理。",
    meta: await getRecord("settings", WIKI_META_KEY),
    wikiPages: finalNodes.filter((node) => node.wiki?.version === WIKI_VERSION).length,
  };
}

export function expandEvidenceByGraph(ranked, allEvidence, nodes, edges, options = {}) {
  const seeds = ranked.slice(0, Number(options.seedLimit) || 5);
  if (!seeds.length) return { ranked, added: [], seedNodes: [], edgeIds: [] };
  const nodeByEvidence = new Map();
  for (const node of nodes) {
    for (const evidenceId of node.evidenceIds || []) {
      const list = nodeByEvidence.get(evidenceId) || [];
      list.push(node);
      nodeByEvidence.set(evidenceId, list);
    }
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const linksByNode = new Map();
  for (const edge of edges) {
    for (const nodeId of [edge.fromNodeId, edge.toNodeId]) {
      const list = linksByNode.get(nodeId) || [];
      list.push(edge);
      linksByNode.set(nodeId, list);
    }
  }
  const seedNodeScores = new Map();
  seeds.forEach((item, index) => {
    for (const node of nodeByEvidence.get(item.id) || []) {
      seedNodeScores.set(node.id, Math.max(seedNodeScores.get(node.id) || 0, Number(item.score) || seeds.length - index));
    }
  });
  const reached = new Map();
  const edgeIds = new Set();
  for (const [nodeId, score] of seedNodeScores) {
    for (const edge of linksByNode.get(nodeId) || []) {
      edgeIds.add(edge.id);
      const neighborId = edge.fromNodeId === nodeId ? edge.toNodeId : edge.fromNodeId;
      const current = reached.get(neighborId) || { nodeId, hops: 1, score: 0 };
      current.score = Math.max(current.score, score * (Number(edge.confidence) || 0.7) * 0.48);
      reached.set(neighborId, current);
    }
  }
  const firstHop = [...reached.entries()];
  for (const [nodeId, reachedNode] of firstHop.slice(0, Number(options.secondHopSeeds) || 8)) {
    for (const edge of linksByNode.get(nodeId) || []) {
      edgeIds.add(edge.id);
      const neighborId = edge.fromNodeId === nodeId ? edge.toNodeId : edge.fromNodeId;
      if (seedNodeScores.has(neighborId) || reached.has(neighborId)) continue;
      reached.set(neighborId, {
        nodeId,
        hops: 2,
        score: reachedNode.score * (Number(edge.confidence) || 0.7) * 0.42,
      });
    }
  }

  const existingIds = new Set(ranked.map((item) => item.id));
  const evidenceById = new Map(allEvidence.map((item) => [item.id, item]));
  const candidates = new Map();
  for (const [nodeId, reach] of reached) {
    const node = nodeById.get(nodeId);
    for (const evidenceId of node?.evidenceIds || []) {
      if (existingIds.has(evidenceId)) continue;
      const evidence = evidenceById.get(evidenceId);
      if (!evidence?.permanent || evidence.active === false || evidence.stale === true) continue;
      const previous = candidates.get(evidenceId);
      if (!previous || reach.score > previous.score) {
        candidates.set(evidenceId, {
          ...evidence,
          score: reach.score,
          graphReason: `经由「${node.title}」${reach.hops} 跳补证`,
          graphHops: reach.hops,
          graphNodeId: node.id,
        });
      }
    }
  }
  const added = [...candidates.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, Number(options.maxAdded) || 8);
  const merged = [...ranked, ...added]
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  return {
    ranked: merged,
    added,
    seedNodes: [...seedNodeScores.keys()].map((id) => nodeById.get(id)).filter(Boolean),
    edgeIds: [...edgeIds],
  };
}
