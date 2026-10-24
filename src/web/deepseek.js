import { deleteMany, getAll, loadSettings, saveSettings } from "./repository.js";
import { BUILTIN_MODEL_VERSION, BUILTIN_MODELS } from "./builtin-models.generated.js";
import { adaptMessagesForProfile } from "./prompt-adapters.js";

const DEFAULT_CHAT_ENDPOINT = "https://api.deepseek.com/chat/completions";
const DEFAULT_CHAT_MODEL = "deepseek-flash";
const DEFAULT_TRANSLATION_ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const DEFAULT_TRANSLATION_MODEL = "qwen-mt-plus";
const DEFAULT_EMBEDDING_ENDPOINT = "https://api.siliconflow.cn/v1/embeddings";
const DEFAULT_EMBEDDING_MODEL = "BAAI/bge-m3";
const DEFAULT_EMBEDDING_FALLBACK_MODEL = "Pro/BAAI/bge-m3";
const MODEL_SCHEMA_VERSION = 3;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sessionKeys = new Map();
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
let cachedRawSettings;

export const MODEL_ROLE_DEFINITIONS = Object.freeze([
  { id: "selection", label: "选段讲解", type: "chat", hint: "只发送当前选段和问题" },
  { id: "visual", label: "图片与公式讲解", type: "chat", hint: "框选图片、图表或公式；模型必须支持图片输入" },
  { id: "knowledge", label: "知识库问答", type: "chat", hint: "只发送问题与本机检索证据" },
  { id: "graph", label: "知识整理", type: "chat", hint: "抽取知识节点与关系" },
  { id: "translation", label: "外文翻译", type: "chat", hint: "整书推荐独立使用阿里云百炼官方 Qwen-MT Plus" },
  { id: "dictionary", label: "语境词典", type: "chat", hint: "释义、词性和例句翻译" },
  { id: "ocr", label: "扫描页识别", type: "chat", hint: "模型必须支持图片输入" },
  { id: "proofread", label: "文字校对", type: "chat", hint: "修正 OCR 断行、错字与丢失连词" },
  { id: "handwriting", label: "手写识别", type: "chat", hint: "模型必须支持图片输入" },
  { id: "embedding", label: "语义向量（首选）", type: "embedding", hint: "默认使用免费 BGE-M3" },
  { id: "embeddingFallback", label: "语义向量（备用）", type: "embedding", hint: "首选限流或故障时切换" },
]);

const roleById = new Map(MODEL_ROLE_DEFINITIONS.map((role) => [role.id, role]));

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function createProfileId() {
  if (globalThis.crypto?.randomUUID) return `model-${crypto.randomUUID()}`;
  return `model-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function ensureCryptoKey(settings) {
  if (settings.cryptoKey) return settings.cryptoKey;
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function encryptSecret(secret, settings) {
  const cryptoKey = await ensureCryptoKey(settings);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, encoder.encode(secret));
  return {
    cryptoKey,
    encryptedApiKey: bytesToBase64(new Uint8Array(encrypted)),
    apiKeyIv: bytesToBase64(iv),
  };
}

function defaultProfiles(saved) {
  const profiles = [];
  const legacyHasSettings = saved.aiEndpoint || saved.aiModel || saved.encryptedApiKey;
  if (legacyHasSettings) {
    profiles.push({
      id: "starter-chat",
      label: "原有对话模型",
      type: "chat",
      endpoint: String(saved.aiEndpoint || DEFAULT_CHAT_ENDPOINT).trim(),
      model: String(saved.aiModel || DEFAULT_CHAT_MODEL).trim(),
      encryptedApiKey: saved.encryptedApiKey || "",
      apiKeyIv: saved.apiKeyIv || "",
    });
  }
  return profiles;
}

function normalizeRawSettings(saved) {
  const hasProfiles = Array.isArray(saved.modelProfiles) && saved.modelProfiles.length > 0;
  const embeddedCryptoKey = hasProfiles ? saved.modelProfiles.find((profile) => profile.cryptoKey)?.cryptoKey : null;
  const profiles = hasProfiles ? saved.modelProfiles.map(({ cryptoKey, ...profile }) => profile) : defaultProfiles(saved);
  const cryptoKey = saved.cryptoKey || embeddedCryptoKey;
  const bindings = { ...(saved.modelBindings || {}) };
  const chatFallback = bindings.visual || bindings.ocr || bindings.selection || profiles.find((profile) => profile.type === "chat")?.id || "";
  for (const role of MODEL_ROLE_DEFINITIONS) {
    if (bindings[role.id] && profiles.some((profile) => profile.id === bindings[role.id])) continue;
    if (role.type === "embedding") {
      bindings[role.id] = role.id === "embedding"
        ? (profiles.find((profile) => profile.id === "starter-bge-m3")?.id || profiles.find((profile) => profile.type === "embedding")?.id || "")
        : (profiles.find((profile) => profile.id === "starter-bge-m3-pro")?.id || profiles.find((profile) => profile.type === "embedding")?.id || "");
    } else {
      bindings[role.id] = chatFallback;
    }
  }
  const dirty = saved.modelSchemaVersion !== MODEL_SCHEMA_VERSION || Boolean(embeddedCryptoKey) ||
    !hasProfiles || MODEL_ROLE_DEFINITIONS.some((role) => saved.modelBindings?.[role.id] !== bindings[role.id]);
  return {
    settings: {
      ...saved,
      modelSchemaVersion: MODEL_SCHEMA_VERSION,
      cryptoKey,
      modelProfiles: profiles,
      modelBindings: bindings,
    },
    dirty,
  };
}

function isLegacyPlaceholder(profile) {
  if (!profile || profile.encryptedApiKey || profile.apiKeyIv) return false;
  if (profile.id === "starter-chat") {
    return profile.endpoint === DEFAULT_CHAT_ENDPOINT && profile.model === DEFAULT_CHAT_MODEL;
  }
  if (profile.id === "starter-bge-m3") {
    return profile.endpoint === DEFAULT_EMBEDDING_ENDPOINT && profile.model === DEFAULT_EMBEDDING_MODEL;
  }
  if (profile.id === "starter-bge-m3-pro") {
    return profile.endpoint === DEFAULT_EMBEDDING_ENDPOINT && profile.model === DEFAULT_EMBEDDING_FALLBACK_MODEL;
  }
  if (profile.id === "recommended-translation") {
    return profile.endpoint === DEFAULT_TRANSLATION_ENDPOINT &&
      ["qwen-mt-plus", "qwen-mt-flash"].includes(profile.model);
  }
  return false;
}

async function seedBuiltinModels(raw) {
  const profiles = raw.modelProfiles.filter((profile) => !isLegacyPlaceholder(profile));
  const removedBuiltins = new Set(Array.isArray(raw.builtinRemovedModels) ? raw.builtinRemovedModels : []);
  let changed = profiles.length !== raw.modelProfiles.length;
  for (const builtin of BUILTIN_MODELS) {
    if (removedBuiltins.has(builtin.id)) continue;
    let profile = profiles.find((item) => item.id === builtin.id);
    if (!profile) {
      profile = {
        id: builtin.id,
        label: builtin.label,
        type: builtin.type,
        endpoint: builtin.endpoint,
        model: builtin.model,
        builtin: true,
        availability: builtin.availability || "",
        encryptedApiKey: "",
        apiKeyIv: "",
        builtinKeySeeded: false,
      };
      profiles.push(profile);
      changed = true;
    }
    if (!profile.encryptedApiKey && !profile.apiKeyIv && !profile.builtinKeySeeded) {
      const encrypted = await encryptSecret(builtin.apiKey, raw);
      profile.encryptedApiKey = encrypted.encryptedApiKey;
      profile.apiKeyIv = encrypted.apiKeyIv;
      profile.builtinKeySeeded = true;
      raw.cryptoKey = encrypted.cryptoKey;
      changed = true;
    }
  }
  const profileIds = new Set(profiles.map((profile) => profile.id));
  const bindings = { ...(raw.modelBindings || {}) };
  const deepseekId = "builtin-deepseek-flash";
  const embeddingId = "builtin-siliconflow-bge-m3";
  const qwenTranslationId = "builtin-qwen-mt-flash";
  const chatFallback = profiles.find((profile) => profile.id === deepseekId && profile.type === "chat")?.id ||
    profiles.find((profile) => profile.type === "chat")?.id || "";
  const embeddingFallback = profiles.find((profile) => profile.id === embeddingId && profile.type === "embedding")?.id ||
    profiles.find((profile) => profile.type === "embedding")?.id || "";
  const translationFallback = profiles.find((profile) =>
    profile.id === qwenTranslationId && profile.type === "chat" && profile.availability !== "quota-exhausted")?.id ||
    chatFallback;
  for (const role of MODEL_ROLE_DEFINITIONS) {
    if (bindings[role.id] && profileIds.has(bindings[role.id])) continue;
    const fallback = role.type === "embedding"
      ? embeddingFallback
      : role.id === "translation" ? translationFallback : chatFallback;
    if (fallback) bindings[role.id] = fallback;
    else delete bindings[role.id];
    changed = true;
  }
  return {
    settings: {
      ...raw,
      builtinModelVersion: BUILTIN_MODEL_VERSION,
      modelProfiles: profiles,
      modelBindings: bindings,
    },
    changed,
  };
}

async function getRawSettings() {
  if (cachedRawSettings) return cachedRawSettings;
  const saved = await loadSettings();
  const normalized = normalizeRawSettings(saved);
  const seeded = await seedBuiltinModels(normalized.settings);
  cachedRawSettings = seeded.settings;
  if (normalized.dirty || seeded.changed) await saveSettings(cachedRawSettings);
  return cachedRawSettings;
}

function publicProfile(profile) {
  return {
    id: profile.id,
    label: profile.label,
    type: profile.type,
    endpoint: profile.endpoint,
    model: profile.model,
    hasKey: Boolean(profile.encryptedApiKey && profile.apiKeyIv),
    builtin: profile.builtin === true,
    availability: profile.availability || "",
  };
}

function resolveProfile(raw, selector = "knowledge") {
  const selectorIsProfile = raw.modelProfiles.find((profile) => profile.id === selector);
  const selectedId = selectorIsProfile?.id || raw.modelBindings?.[selector];
  const role = roleById.get(selector);
  const profile = raw.modelProfiles.find((item) => item.id === selectedId);
  if (!profile) throw new Error(`尚未为“${role?.label || selector}”配置模型档案。`);
  return profile;
}

async function decryptProfileKey(raw, profile) {
  if (sessionKeys.has(profile.id)) return sessionKeys.get(profile.id);
  if (!profile.encryptedApiKey || !profile.apiKeyIv || !raw.cryptoKey) {
    throw new Error(`模型档案“${profile.label}”尚未保存 API Key。`);
  }
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(profile.apiKeyIv) },
      raw.cryptoKey,
      base64ToBytes(profile.encryptedApiKey),
    );
    const apiKey = decoder.decode(plain);
    sessionKeys.set(profile.id, apiKey);
    return apiKey;
  } catch {
    throw new Error(`模型档案“${profile.label}”的 API Key 无法解密，请重新输入。`);
  }
}

export async function getAiSettings() {
  const raw = await getRawSettings();
  const profiles = raw.modelProfiles.map(publicProfile);
  let active;
  try { active = resolveProfile(raw, "knowledge"); }
  catch { active = raw.modelProfiles.find((profile) => profile.type === "chat") || raw.modelProfiles[0] || {}; }
  return {
    modelSchemaVersion: raw.modelSchemaVersion,
    profiles,
    bindings: { ...(raw.modelBindings || {}) },
    model: active.model,
    endpoint: active.endpoint,
    temperaturePolicy: "automatic",
    hasApiKey: profiles.some((profile) => profile.type === "chat" && profile.hasKey),
    semanticIndex: raw.semanticIndex || null,
  };
}

export async function getModelProfile(profileId) {
  const raw = await getRawSettings();
  const profile = raw.modelProfiles.find((item) => item.id === profileId);
  if (!profile) throw new Error("模型档案不存在。");
  return { ...publicProfile(profile), apiKey: await decryptProfileKey(raw, profile) };
}

export async function getBoundModelProfile(role = "knowledge") {
  const raw = await getRawSettings();
  const profile = resolveProfile(raw, role);
  return { ...publicProfile(profile), apiKey: await decryptProfileKey(raw, profile) };
}

export async function configureModelProfile(input) {
  const raw = await getRawSettings();
  const type = input.type === "embedding" ? "embedding" : "chat";
  const existingIndex = raw.modelProfiles.findIndex((profile) => profile.id === input.id);
  const existing = existingIndex >= 0 ? raw.modelProfiles[existingIndex] : null;
  const model = String(input.model || existing?.model || "").trim();
  const profile = {
    ...(existing || {}),
    id: existing?.id || input.id || createProfileId(),
    label: model || (type === "embedding" ? "语义向量模型" : "对话模型"),
    type,
    endpoint: String(input.endpoint || existing?.endpoint || (type === "embedding" ? DEFAULT_EMBEDDING_ENDPOINT : DEFAULT_CHAT_ENDPOINT)).trim(),
    model,
  };
  if (!profile.label || !profile.endpoint || !profile.model) throw new Error("模型 ID 和接口地址不能为空。");
  let url;
  try { url = new URL(profile.endpoint); } catch { throw new Error("接口地址必须是完整 URL。"); }
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("接口地址必须使用 HTTPS 或本机 HTTP。");
  if (input.apiKey !== undefined && String(input.apiKey).trim()) {
    const apiKey = String(input.apiKey).trim();
    if (!/^\S{8,4096}$/.test(apiKey)) throw new Error("API Key 格式不正确：不能包含空白字符。");
    const encrypted = await encryptSecret(apiKey, raw);
    profile.encryptedApiKey = encrypted.encryptedApiKey;
    profile.apiKeyIv = encrypted.apiKeyIv;
    raw.cryptoKey = encrypted.cryptoKey;
    sessionKeys.set(profile.id, apiKey);
    profile.availability = "";
  }
  const profiles = existing ? raw.modelProfiles.map((item, index) => index === existingIndex ? profile : item) : [...raw.modelProfiles, profile];
  const bindings = { ...(raw.modelBindings || {}) };
  for (const role of MODEL_ROLE_DEFINITIONS) {
    if (bindings[role.id] === profile.id && role.type !== type) delete bindings[role.id];
  }
  for (const role of MODEL_ROLE_DEFINITIONS) {
    if (!roleById.get(role.id) || role.type !== type || bindings[role.id]) continue;
    bindings[role.id] = profile.id;
  }
  if (profile.id === "recommended-translation" && profile.type === "chat" &&
      profile.encryptedApiKey && profile.apiKeyIv) {
    bindings.translation = profile.id;
  }
  if (type === "chat" && !profiles.some((item) => item.type === "chat" && item.id !== profile.id) && !bindings.knowledge) bindings.knowledge = profile.id;
  cachedRawSettings = { ...raw, modelProfiles: profiles, modelBindings: bindings };
  await saveSettings(cachedRawSettings);
  return publicProfile(profile);
}

export async function deleteModelProfile(profileId) {
  const raw = await getRawSettings();
  const removedProfile = raw.modelProfiles.find((profile) => profile.id === profileId);
  const profiles = raw.modelProfiles.filter((profile) => profile.id !== profileId);
  const bindings = { ...(raw.modelBindings || {}) };
  for (const role of MODEL_ROLE_DEFINITIONS) {
    if (bindings[role.id] !== profileId) continue;
    const replacement = profiles.find((profile) => profile.type === role.type);
    if (replacement) bindings[role.id] = replacement.id; else delete bindings[role.id];
  }
  const embeddingIds = (await getAll("embeddings"))
    .filter((record) => record.profileId === profileId)
    .map((record) => record.id);
  if (embeddingIds.length) await deleteMany("embeddings", embeddingIds);
  sessionKeys.delete(profileId);
  cachedRawSettings = {
    ...raw,
    modelProfiles: profiles,
    modelBindings: bindings,
    builtinRemovedModels: removedProfile?.builtin
      ? Array.from(new Set([...(raw.builtinRemovedModels || []), profileId]))
      : raw.builtinRemovedModels,
    semanticIndex: raw.semanticIndex?.profileId === profileId ? null : raw.semanticIndex,
  };
  await saveSettings(cachedRawSettings);
}

export async function clearModelProfileKey(profileId) {
  const raw = await getRawSettings();
  const profile = raw.modelProfiles.find((item) => item.id === profileId);
  if (!profile) throw new Error("模型档案不存在。");
  cachedRawSettings = {
    ...raw,
    modelProfiles: raw.modelProfiles.map((item) => item.id === profileId
      ? { ...item, encryptedApiKey: "", apiKeyIv: "" } : item),
  };
  sessionKeys.delete(profileId);
  await saveSettings(cachedRawSettings);
}

export async function setModelBinding(role, profileId) {
  if (!roleById.has(role)) throw new Error("未知的模型任务。");
  const raw = await getRawSettings();
  const bindings = { ...(raw.modelBindings || {}) };
  if (!profileId || profileId === "__unset__") {
    delete bindings[role];
    cachedRawSettings = { ...raw, modelBindings: bindings };
    await saveSettings(cachedRawSettings);
    return;
  }
  const profile = raw.modelProfiles.find((item) => item.id === profileId);
  if (!profile) throw new Error("模型档案不存在。");
  if (profile.type !== roleById.get(role).type) throw new Error("模型档案类型与任务不匹配。");
  bindings[role] = profileId;
  cachedRawSettings = { ...raw, modelBindings: bindings };
  await saveSettings(cachedRawSettings);
}

export async function markModelProfileAvailable(profileId) {
  const raw = await getRawSettings();
  let changed = false;
  const modelProfiles = raw.modelProfiles.map((profile) => {
    if (profile.id !== profileId || !profile.availability) return profile;
    changed = true;
    return { ...profile, availability: "" };
  });
  if (!changed) return;
  cachedRawSettings = { ...raw, modelProfiles };
  await saveSettings(cachedRawSettings);
}

export async function updateSemanticIndexMeta(meta) {
  const raw = await getRawSettings();
  cachedRawSettings = { ...raw, semanticIndex: meta || null };
  await saveSettings(cachedRawSettings);
}

export async function hasApiKey(role = "knowledge") {
  try {
    const raw = await getRawSettings();
    const profile = resolveProfile(raw, role);
    return Boolean(profile.encryptedApiKey && profile.apiKeyIv && raw.cryptoKey);
  } catch { return false; }
}

export async function getApiKey(role = "knowledge") {
  return (await getBoundModelProfile(role)).apiKey;
}

export async function configureAi(input) {
  await configureModelProfile({ ...input, id: input.id || "starter-chat", type: "chat", label: input.label || "对话模型" });
  return getAiSettings();
}

export async function clearAiKey(profileId = "starter-chat") {
  await clearModelProfileKey(profileId);
}

export function parseJsonResponse(text) {
  const raw = String(text || "").trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw new Error("AI 返回内容不是有效 JSON。");
  }
}

export function describeModelHttpError(profile, status, detail) {
  const code = Number(status) || 0;
  const providerText = String(detail || "").trim();
  const lower = providerText.toLowerCase();
  let reason = "";
  let action = "";
  if (code === 401) {
    reason = "API Key 无效、已过期或被撤销";
    action = "请到设置中重新填写这个模型的 API Key，并点击“测试连接”。";
  } else if (code === 402) {
    reason = "账户余额不足";
    action = "请到模型服务商充值，或切换到另一个已配置的模型。";
  } else if ([403, 429].includes(code) &&
      /(allocationquota|freetieronly|free\s+quota\s+exhausted|quota\s+exhausted|免费额度|额度.*耗尽)/i.test(lower)) {
    reason = "模型的免费额度已经耗尽";
    action = "请在服务商控制台充值，或关闭“仅使用免费额度”设置；也可以先在功能分配中改用其他模型。";
  } else if (code === 403) {
    reason = "API Key 没有调用这个模型的权限";
    action = "请检查模型是否已开通、账号是否有权限，以及接口地址是否属于该服务商。";
  } else if (code === 404) {
    reason = "接口地址或模型 ID 不正确";
    action = "请检查完整接口地址和模型 ID，确认服务商支持这个模型。";
  } else if (code === 429 && /(quota|balance|insufficient|credit|余额|额度|欠费)/.test(lower)) {
    reason = "账户额度已经耗尽";
    action = "请充值或切换到备用模型，再重新发起请求。";
  } else if (code === 429) {
    reason = "请求太频繁或触发了服务商限流";
    action = "请稍等一会儿再试，或在设置中换一个模型。";
  } else if (code === 400 && /(model|not found|invalid|不存在|无效)/.test(lower)) {
    reason = "模型 ID 或请求参数不正确";
    action = "请检查模型 ID 是否是服务商控制台中的完整名称。";
  } else if (code === 400) {
    reason = "请求参数被服务商拒绝";
    action = "请检查接口是否兼容 OpenAI 格式，或换一个兼容模型。";
  } else if (code === 413 || code === 422) {
    reason = "一次发送的内容太长";
    action = "请减少选段或一次发送的内容后再试。";
  } else if (code >= 500) {
    reason = "模型服务商暂时故障";
    action = "请稍后重试，或切换到另一个模型。";
  } else {
    reason = "模型请求失败";
    action = "请检查模型设置和网络后重试。";
  }
  const statusText = `（HTTP ${code || "未知"}）`;
  const error = new Error(
    `模型“${profile.label}”：${reason}${statusText}。${action}`,
  );
  error.status = code;
  error.reason = reason;
  error.action = action;
  error.providerDetail = providerText;
  return error;
}

export async function postModelRequest({ url, headers, body, timeoutMs = 90_000, signal }) {
  const nativePlugin = globalThis.Capacitor?.Plugins?.BianduNetwork;
  if (nativePlugin?.postJson) {
    if (signal?.aborted) {
      const error = new Error("请求已取消");
      error.name = "AbortError";
      error.cancelled = true;
      throw error;
    }
    const requestId = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `net-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let cancelled = false;
    const cancelRequest = () => {
      cancelled = true;
      nativePlugin.cancel?.({ requestId }).catch(() => {});
    };
    signal?.addEventListener("abort", cancelRequest, { once: true });
    let result;
    try {
      result = await nativePlugin.postJson({
        url,
        headers,
        body,
        timeoutMs,
        requestId,
      });
      if (cancelled) {
        const cancelledError = new Error("请求已取消");
        cancelledError.name = "AbortError";
        cancelledError.cancelled = true;
        throw cancelledError;
      }
    } catch (error) {
      if (cancelled) {
        const cancelledError = new Error("请求已取消");
        cancelledError.name = "AbortError";
        cancelledError.cancelled = true;
        throw cancelledError;
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancelRequest);
    }
    const nativeHeaders = result?.headers || {};
    const getHeader = (name) => {
      const lower = String(name || "").toLowerCase();
      const key = Object.keys(nativeHeaders).find((item) => item.toLowerCase() === lower);
      return key ? nativeHeaders[key] : null;
    };
    return {
      ok: Number(result?.status) >= 200 && Number(result?.status) < 300,
      status: Number(result?.status) || 0,
      statusText: "",
      headers: { get: getHeader },
      text: async () => String(result?.body || ""),
    };
  }
  return fetch(url, {
    method: "POST",
    headers,
    body,
    signal,
  });
}

async function chatWithProfile(profile, messages, options = {}) {
  const controller = new AbortController();
  let timedOut = false;
  let externallyCancelled = false;
  const cancelFromCaller = () => {
    externallyCancelled = true;
    controller.abort();
  };
  if (options.signal?.aborted) cancelFromCaller();
  else options.signal?.addEventListener("abort", cancelFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs || 90_000);
  try {
    const maxRetries = Math.max(0, Math.min(3, Number(options.retries ?? 2)));
    let response;
    let body = "";
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      response = await postModelRequest({
        url: profile.endpoint,
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${profile.apiKey}` },
        body: JSON.stringify({
          model: profile.model,
          messages: adaptMessagesForProfile(messages, profile),
          temperature: options.temperature ?? 0.2,
          ...(options.json ? { response_format: { type: "json_object" } } : {}),
          ...(options.extraBody || {}),
        }),
        timeoutMs: options.timeoutMs || 90_000,
        signal: controller.signal,
      });
      body = await response.text();
      const quotaBlocked = response.status === 429 &&
        /(quota|balance|insufficient|credit|余额|额度|欠费)/.test(body.toLowerCase());
      if (response.ok || !RETRYABLE_STATUS.has(response.status) || quotaBlocked || attempt === maxRetries) break;
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(15_000, retryAfter * 1000)
        : 900 * (2 ** attempt);
      await wait(delay);
    }
    let data;
    try { data = JSON.parse(body); } catch { data = null; }
    if (!response.ok) {
      const detail = data?.error?.message || body.slice(0, 500) || response.statusText;
      throw describeModelHttpError(profile, response.status, detail);
    }
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      const error = new Error(`模型“${profile.label}”没有返回可用内容。可能是内容过滤、额度耗尽或模型不支持当前请求，请检查服务商控制台。`);
      error.reason = "模型没有返回可用内容";
      error.action = "请检查服务商控制台中的额度、内容过滤和模型状态。";
      throw error;
    }
    return options.json ? parseJsonResponse(content) : String(content).trim();
  } catch (error) {
    if (error?.name === "AbortError") {
      if (externallyCancelled || !timedOut) {
        const wrapped = new Error(`模型“${profile.label}”请求已取消。`);
        wrapped.name = "AbortError";
        wrapped.cancelled = true;
        wrapped.reason = "翻译已暂停";
        throw wrapped;
      }
      const timeout = Math.round((options.timeoutMs || 90_000) / 1000);
      const wrapped = new Error(`模型“${profile.label}”请求超时（${timeout} 秒）。请检查网络，或换一个响应更快的模型。`);
      wrapped.reason = "模型请求超时";
      wrapped.action = "请检查网络，或换一个响应更快的模型。";
      throw wrapped;
    }
    if (error instanceof TypeError) {
      const wrapped = new Error(`无法连接模型“${profile.label}”。请检查网络、接口完整地址和服务商跨域权限（CORS）。`);
      wrapped.status = 0;
      wrapped.reason = "无法连接模型服务";
      wrapped.action = "请检查网络、接口完整地址和服务商跨域权限（CORS）。";
      throw wrapped;
    }
    if (/不是有效 JSON/.test(error?.message || "")) {
      const wrapped = new Error(`模型“${profile.label}”返回的内容不是有效 JSON。请确认该模型支持 JSON 输出，或换一个兼容模型。`);
      wrapped.status = 0;
      wrapped.reason = "模型返回格式不正确";
      wrapped.action = "请换一个兼容 OpenAI JSON 输出的模型。";
      throw wrapped;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancelFromCaller);
  }
}

export async function chat(messages, options = {}) {
  const profile = await getBoundModelProfile(options.profileId || options.task || "knowledge");
  if (profile.type !== "chat") throw new Error(`模型档案“${profile.label}”是向量模型，不能用于对话任务。`);
  return chatWithProfile(profile, messages, options);
}

export async function translateTextsWithSpecializedModel(texts, options = {}) {
  const sourceTexts = Array.isArray(texts) ? texts.map((text) => String(text || "")) : [];
  if (!sourceTexts.length) return [];
  const raw = await getRawSettings();
  const profile = resolveProfile(raw, "translation");
  if (!/^qwen-mt-(plus|flash)$/i.test(String(profile.model || ""))) return null;
  if (!profile.encryptedApiKey || !profile.apiKeyIv) {
    throw new Error("已选择 Qwen-MT 翻译模型，但还没有保存阿里云百炼 API Key。");
  }
  const apiKey = await decryptProfileKey(raw, profile);
  profile.apiKey = apiKey;
  const sourceLang = String(options.sourceLang || "auto");
  const targetLang = String(options.targetLang || "Chinese");
  const translateOne = (text) => chatWithProfile(profile, [{ role: "user", content: text }], {
    json: false,
    temperature: 0,
    timeoutMs: options.timeoutMs || 180_000,
    signal: options.signal,
    extraBody: {
      translation_options: {
        source_lang: sourceLang,
        target_lang: targetLang,
      },
    },
  });
  const translated = new Array(sourceTexts.length);
  let cursor = 0;
  async function worker() {
    while (cursor < sourceTexts.length) {
      const index = cursor;
      cursor += 1;
      const output = String(await translateOne(sourceTexts[index]) || "").trim();
      if (!output) throw new Error("Qwen-MT 返回了空翻译，本次未保存。请重试。");
      translated[index] = output;
    }
  }
  await Promise.all([0, 1, 2].map(() => worker()));
  return translated;
}

export async function testConnection(profileId) {
  const profile = await getModelProfile(profileId || (await getRawSettings()).modelBindings?.knowledge);
  if (profile.type !== "chat") throw new Error("请在语义索引区域测试向量模型。");
  if (/^qwen-mt-(plus|flash)$/i.test(String(profile.model || ""))) {
    return chatWithProfile(profile, [{ role: "user", content: "Hello, this is a connection test." }], {
      timeoutMs: 30_000,
      temperature: 0,
      extraBody: {
        translation_options: {
          source_lang: "auto",
          target_lang: "Chinese",
        },
      },
    });
  }
  return chatWithProfile(profile, [
    { role: "system", content: "只回答两个字符：正常" },
    { role: "user", content: "连接测试" },
  ], { timeoutMs: 30_000, temperature: 0 });
}
