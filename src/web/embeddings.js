import {
  describeModelHttpError, getAiSettings, getBoundModelProfile, getModelProfile, updateSemanticIndexMeta,
  postModelRequest,
} from "./deepseek.js";
import { deleteMany, getAll, putMany } from "./repository.js";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const FALLBACK_TEXT = /(rate.?limit|too many requests|quota|balance|限流|额度|余额|请求过多)/i;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hashText(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function shouldFallback(error) {
  if (Number(error?.status) === 0) return true;
  if (RETRYABLE_STATUS.has(Number(error?.status))) return true;
  return Number(error?.status) === 402 || Number(error?.status) === 403 || FALLBACK_TEXT.test(error?.message || "");
}

function normalizeInput(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("不能为空的证据建立语义向量。");
  return text.slice(0, 6000);
}

async function requestEmbeddings(profile, texts, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 90_000);
  try {
    const retries = Math.max(0, Math.min(2, Number(options.retries ?? 1)));
    let response;
    let body = "";
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      response = await postModelRequest({
        url: profile.endpoint,
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${profile.apiKey}` },
        body: JSON.stringify({ model: profile.model, input: texts, encoding_format: "float" }),
        timeoutMs: options.timeoutMs || 90_000,
        signal: controller.signal,
      });
      body = await response.text();
      const quotaBlocked = response.status === 429 &&
        /(quota|balance|insufficient|credit|余额|额度|欠费)/.test(body.toLowerCase());
      if (response.ok || !RETRYABLE_STATUS.has(response.status) || quotaBlocked || attempt === retries) break;
      const retryAfter = Number(response.headers.get("retry-after"));
      await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(15_000, retryAfter * 1000) : 900 * (2 ** attempt));
    }
    let data;
    try { data = JSON.parse(body); } catch { data = null; }
    if (!response.ok) {
      const detail = data?.error?.message || body.slice(0, 500) || response.statusText;
      throw describeModelHttpError(profile, response.status, detail);
    }
    const ordered = Array.isArray(data?.data) ? data.data.slice().sort((a, b) => Number(a.index) - Number(b.index)) : [];
    if (ordered.length !== texts.length || ordered.some((item) => !Array.isArray(item.embedding))) {
      throw new Error(`向量模型“${profile.label}”返回的向量数量不完整。`);
    }
    return ordered.map((item) => item.embedding.map(Number));
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`向量模型“${profile.label}”请求超时。请检查网络，或换一个响应更快的向量模型。`);
    if (error instanceof TypeError) {
      const wrapped = new Error(`无法连接向量模型“${profile.label}”。请检查网络、接口地址和跨域权限。`);
      wrapped.status = 0;
      throw wrapped;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function embedTexts(texts, options = {}) {
  const inputs = texts.map(normalizeInput);
  const primary = await getBoundModelProfile(options.role || "embedding");
  try {
    const vectors = await requestEmbeddings(primary, inputs, options);
    return { vectors, profile: primary, fallbackUsed: false };
  } catch (primaryError) {
    if (options.allowFallback === false || !shouldFallback(primaryError)) throw primaryError;
    let fallback;
    try { fallback = await getBoundModelProfile("embeddingFallback"); } catch { throw primaryError; }
    if (fallback.id === primary.id) throw primaryError;
    try {
      const vectors = await requestEmbeddings(fallback, inputs, options);
      return { vectors, profile: fallback, fallbackUsed: true, primaryError };
    } catch (fallbackError) {
      const combined = new Error(`首选向量模型失败：${primaryError.message}；备用向量模型也失败：${fallbackError.message}`);
      combined.status = fallbackError.status ?? primaryError.status;
      throw combined;
    }
  }
}

export async function testEmbeddingProfile(profileId) {
  const profile = await getModelProfile(profileId);
  if (profile.type !== "embedding") throw new Error("这个档案不是向量模型。请在对话模型区域测试。");
  const result = await requestEmbeddings(profile, ["便读语义索引连接测试"], { retries: 0, timeoutMs: 30_000 });
  return { model: profile.model, dimensions: result[0]?.length || 0 };
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function embeddingRecordId(profileId, evidenceId) {
  return `${profileId}:${evidenceId}`;
}

async function indexWithProfile(profile, evidence, progress) {
  const batchSize = 20;
  const records = [];
  for (let start = 0; start < evidence.length; start += batchSize) {
    const batch = evidence.slice(start, start + batchSize);
    progress?.({ current: start, total: evidence.length, label: `正在生成语义索引 ${start + 1}-${Math.min(start + batch.length, evidence.length)} / ${evidence.length}` });
    let vectors;
    try {
      vectors = await requestEmbeddings(profile, batch.map((item) => normalizeInput(item.excerpt)), { retries: 1 });
    } catch (error) {
      error.partialProgress = start;
      throw error;
    }
    batch.forEach((item, index) => {
      records.push({
        id: embeddingRecordId(profile.id, item.id),
        evidenceId: item.id,
        profileId: profile.id,
        model: profile.model,
        dimensions: vectors[index].length,
        contentHash: hashText(item.excerpt),
        vector: vectors[index],
        updatedAt: new Date().toISOString(),
      });
    });
  }
  await putMany("embeddings", records);
  const currentIds = new Set(records.map((record) => record.id));
  const staleIds = (await getAll("embeddings"))
    .filter((record) => record.profileId === profile.id && !currentIds.has(record.id))
    .map((record) => record.id);
  if (staleIds.length) await deleteMany("embeddings", staleIds);
  return records;
}

export async function rebuildSemanticIndex(evidence, progress = () => {}) {
  const permanent = evidence.filter((item) => item.permanent && String(item.excerpt || "").trim());
  if (!permanent.length) throw new Error("当前没有可建立语义索引的永久证据。");
  const primary = await getBoundModelProfile("embedding");
  let selected = primary;
  let fallbackUsed = false;
  let records;
  try {
    records = await indexWithProfile(selected, permanent, progress);
  } catch (error) {
    if (!shouldFallback(error)) throw error;
    const fallback = await getBoundModelProfile("embeddingFallback");
    if (fallback.id === primary.id) throw error;
    selected = fallback;
    fallbackUsed = true;
    progress?.({ current: 0, total: permanent.length, label: `首选向量模型不可用，正在切换 ${fallback.label}` });
    records = await indexWithProfile(selected, permanent, progress);
  }
  const meta = {
    profileId: selected.id, label: selected.label, model: selected.model,
    dimensions: records[0]?.dimensions || 0, count: records.length,
    fallbackUsed, completedAt: new Date().toISOString(),
  };
  await updateSemanticIndexMeta(meta);
  return meta;
}

export async function getSemanticScores(question, evidence) {
  const settings = await getAiSettings();
  const meta = settings.semanticIndex;
  if (!meta?.profileId || !meta?.count) return null;
  let profile;
  try { profile = await getModelProfile(meta.profileId); } catch { return null; }
  if (profile.type !== "embedding") return null;
  async function scoreWithProfile(candidate, candidateMeta) {
    const records = (await getAll("embeddings")).filter((item) => item.profileId === candidate.id && item.model === candidate.model);
    if (!records.length) return null;
    const byEvidenceId = new Map(records.map((item) => [item.evidenceId, item]));
    const queryVector = (await requestEmbeddings(candidate, [normalizeInput(question)], { retries: 1 }))[0];
    const scores = new Map();
    for (const item of evidence) {
      const record = byEvidenceId.get(item.id);
      if (!record || record.contentHash !== hashText(item.excerpt) || record.dimensions !== queryVector.length) continue;
      scores.set(item.id, cosineSimilarity(queryVector, record.vector));
    }
    return { scores, profile: candidate, meta: candidateMeta };
  }

  try {
    const result = await scoreWithProfile(profile, meta);
    if (result) return result;
  } catch (primaryError) {
    if (!shouldFallback(primaryError)) throw primaryError;
    const primary = await getBoundModelProfile("embedding");
    const boundFallback = await getBoundModelProfile("embeddingFallback").catch(() => null);
    const candidate = profile.id === primary.id ? boundFallback : primary;
    if (!candidate || candidate.id === profile.id || candidate.type !== "embedding") throw primaryError;
    const permanent = evidence.filter((item) => item.permanent && String(item.excerpt || "").trim());
    let existing = (await getAll("embeddings"))
      .some((item) => item.profileId === candidate.id && item.model === candidate.model);
    if (!existing && permanent.length) {
      await indexWithProfile(candidate, permanent);
      existing = true;
    }
    if (existing) {
      const candidateMeta = {
        ...meta, profileId: candidate.id, label: candidate.label, model: candidate.model,
        fallbackUsed: true, repairedAt: new Date().toISOString(),
      };
      const result = await scoreWithProfile(candidate, candidateMeta);
      if (result) {
        await updateSemanticIndexMeta(candidateMeta);
        return result;
      }
    }
    throw primaryError;
  }
  return null;
}
