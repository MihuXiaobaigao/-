import {
  MODEL_ROLE_DEFINITIONS, clearModelProfileKey, configureModelProfile,
  deleteModelProfile, getAiSettings, hasApiKey, markModelProfileAvailable, setModelBinding, testConnection,
} from "./deepseek.js";
import { rebuildSemanticIndex, testEmbeddingProfile } from "./embeddings.js";
import { downloadArtifactFile, createKnowledgeArtifact } from "./artifact-export.js";
import { createBuiltinMcpHost } from "./builtin-mcp.js";
import { organizeKnowledgeBase } from "./knowledge-compiler.js";
import { answerKnowledge, enrichDictionaryWord } from "./knowledge-engine.js";
import { composeKnowledgeDeliverable, KNOWLEDGE_TASKS } from "./knowledge-agent.js";
import {
  cleanupEligibility, downloadBackup, exportBackup, processBookKnowledge, processUnverifiedBooks,
  restoreBackup, runRetentionCleanup,
} from "./maintenance.js";
import {
  createId, getAll, getRecord, putRecord, saveEvidence, saveKnowledgeEdge,
  titleKey, upsertKnowledgeNode,
} from "./repository.js";
import { recognizeVisualPage } from "./vision.js";

function esc(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

const kindLabels = {
  "source-excerpt": "原文", "text-note": "文字笔记", annotation: "标注",
  "canvas-recognition": "画板", "ai-summary": "AI 总结", "dictionary-context": "词典语境",
  "visual-page": "页面图像", "visual-selection": "图片附件",
};
const sourceTypeLabels = {
  quote: "原文", note: "笔记", ai_summary: "AI 总结", inference: "推断",
};
const relationLabels = {
  supports: "支持", contradicts: "反驳", causes: "因果", "part-of": "属于",
  "similar-to": "相似", "contrasts-with": "对比", "derived-from": "来源于",
  "defined-by": "定义于", "example-of": "举例说明", "personally-related": "与个人经历相关",
};

const LAST_BACKUP_KEY = "biandu.last-complete-backup.v1";

const OFFICIAL_MODEL_PRESETS = Object.freeze([
  {
    id: "recommended-translation",
    label: "阿里云百炼 · Qwen-MT Plus",
    type: "chat",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: "qwen-mt-plus",
  },
  {
    id: "official-deepseek-chat",
    label: "DeepSeek 官方 · Chat",
    type: "chat",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
  },
  {
    id: "official-zhipu-glm",
    label: "智谱官方 · GLM-4-Flash",
    type: "chat",
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4-flash",
  },
  {
    id: "official-moonshot-kimi",
    label: "月之暗面官方 · Kimi",
    type: "chat",
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    model: "moonshot-v1-8k",
  },
  {
    id: "official-baidu-ernie",
    label: "百度智能云 · 千帆 ERNIE",
    type: "chat",
    endpoint: "https://qianfan.baidubce.com/v2/chat/completions",
    model: "ernie-speed-128k",
  },
  {
    id: "official-openai-mini",
    label: "OpenAI 官方 · GPT-4.1 mini",
    type: "chat",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4.1-mini",
  },
]);

function loadLastBackupAt() {
  try { return localStorage.getItem(LAST_BACKUP_KEY) || ""; }
  catch { return ""; }
}

function saveLastBackupAt(value) {
  try { localStorage.setItem(LAST_BACKUP_KEY, value); }
  catch { /* The backup itself is still valid if metadata cannot be kept. */ }
}

function shortDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function createPagesController(app) {
  const mcpHost = createBuiltinMcpHost();
  const state = {
    loaded: false, loading: false, books: [], evidence: [], nodes: [], edges: [],
    boards: [], dictionary: [], conversations: [],
    kbQuestion: "", kbFilter: "全部来源", kbResult: null, kbBusy: false,
    kbMode: "chat", kbTask: "pdf", kbTaskArtifact: null, kbTaskStep: "",
    kbAttachmentBusy: false,
    kbMessages: [],
    kbConversationId: "",
    kbChatSidebarOpen: !globalThis.window || window.innerWidth >= 900,
    dictQuery: "", dictFilter: "全部", selectedWord: "", dictBusy: false,
    selectedNodeId: "", graphZoom: 0.86, graphPanX: 0, graphPanY: 0,
    aiSettings: {}, hasKey: false, storageEstimate: null, wikiMeta: null,
    storagePersisted: false, lastBackupAt: loadLastBackupAt(),
    editingModelId: "", modelBusyId: "", dataSettingsOpen: false,
    refreshPromise: null, refreshRequested: false,
  };

  mcpHost.registerTool({
    name: "knowledge.answer",
    title: "检索并回答私人知识库",
    description: "调用本地证据检索、语义索引和引用校验，回答用户问题。",
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: {
        question: { type: "string" },
        filter: { type: "string" },
        history: { type: "string" },
      },
    },
    handler: async ({ question, filter, history }) => {
      const result = await answerKnowledge(question, filter || "全部来源", { history });
      return { ...result, summary: result.answer || "知识库检索已完成。" };
    },
  });
  mcpHost.registerTool({
    name: "artifact.create",
    title: "生成知识交付文件",
    description: "根据用户明确指定的格式生成本机 PDF、DOCX 或 PPTX 文件。",
    inputSchema: {
      type: "object",
      required: ["artifact"],
      properties: { artifact: { type: "object" } },
    },
    handler: async ({ artifact }) => {
      const file = await createKnowledgeArtifact(artifact);
      return {
        ...file,
        mimeType: file.blob.type,
        size: file.blob.size,
        summary: `${file.filename} 已生成。`,
      };
    },
  });

  function fs() { return app.features(); }

  function refresh(options = {}) {
    const shouldRender = options.render !== false;
    // Coalesce all readers onto one drain loop. A refresh requested while a
    // snapshot is in flight makes that same promise run another read, so
    // callers never resume against the stale snapshot they tried to replace.
    if (state.refreshPromise) {
      state.refreshRequested = true;
      return state.refreshPromise;
    }
    state.loading = true;
    state.refreshPromise = (async () => {
      try {
        do {
          state.refreshRequested = false;
          const [books, evidence, nodes, edges, boards, dictionary, conversations, aiSettings, hasKey, storageInfo, wikiMeta] = await Promise.all([
            getAll("books"), getAll("evidence"), getAll("knowledgeNodes"),
            getAll("knowledgeEdges"), getAll("boards"), getAll("dictionary"), getAll("conversations"),
            getAiSettings(), hasApiKey(), (async () => {
              try {
                const [estimate, persisted] = await Promise.all([
                  navigator.storage?.estimate?.() || Promise.resolve(null),
                  navigator.storage?.persisted?.() || Promise.resolve(false),
                ]);
                return { estimate, persisted: Boolean(persisted) };
              } catch { return { estimate: null, persisted: false }; }
            })(),
            getRecord("settings", "knowledge-wiki-meta-v1"),
          ]);
          Object.assign(state, {
            books, evidence, nodes, edges, boards, dictionary, conversations, aiSettings, hasKey,
            storageEstimate: storageInfo.estimate, storagePersisted: storageInfo.persisted, wikiMeta,
          });
          await ensureStandaloneEvidenceNodes();
          state.loaded = true;
          const current = fs()?.state?.currentView;
          if (shouldRender && ["kb", "graph", "dict", "settings"].includes(current)) app.renderApp();
        } while (state.refreshRequested);
      } finally {
        state.loading = false;
        state.refreshPromise = null;
      }
    })();
    return state.refreshPromise;
  }

  function ensureLoaded() {
    if (!state.loaded && !state.loading) refresh();
  }

  async function ensureStandaloneEvidenceNodes() {
    const nonSource = state.evidence.filter((item) => item.kind !== "source-excerpt");
    if (!nonSource.length) return;
    const nodeEvidence = new Set(state.nodes.flatMap((node) => node.evidenceIds || []));
    let changed = false;
    for (const evidence of nonSource) {
      if (nodeEvidence.has(evidence.id)) continue;
      const kind = evidence.kind === "text-note" ? "note" : evidence.kind === "canvas-recognition" ? "canvas" : evidence.kind === "ai-summary" ? "ai-summary" : "passage";
      const title = evidence.excerpt.replace(/\s+/g, " ").slice(0, 34) + (evidence.excerpt.length > 34 ? "…" : "");
      const node = await upsertKnowledgeNode({ kind, title: title || kindLabels[evidence.kind], summary: evidence.excerpt.slice(0, 800), evidenceIds: [evidence.id] });
      state.nodes.push(node);
      const bookNode = state.nodes.find((item) => titleKey(item.title) === titleKey(evidence.sourceTitle));
      if (bookNode) await saveKnowledgeEdge({ fromNodeId: node.id, toNodeId: bookNode.id, relation: "derived-from", rationale: `来自${kindLabels[evidence.kind]}证据`, evidenceIds: [evidence.id], confidence: 1 });
      changed = true;
    }
    if (changed) {
      state.nodes = await getAll("knowledgeNodes");
      state.edges = await getAll("knowledgeEdges");
    }
  }

  function renderLoading(title) {
    return `<div class="page-scroll"><section class="card" style="padding:42px;text-align:center;"><h1 class="serif-title">${title}</h1><p style="color:var(--text-muted);margin-top:8px;">正在读取本地数据…</p></section></div>`;
  }

  function knowledgeConversationRecords() {
    return (state.conversations || [])
      .filter((conversation) => conversation.scope === "knowledge-base" &&
        Array.isArray(conversation.messages) && conversation.messages.length)
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  }

  function knowledgeConversationTitle(conversation) {
    const first = (conversation?.messages || []).find((message) => message.role === "user");
    return String(conversation?.title || first?.content || "未命名对话").replace(/\s+/g, " ").slice(0, 42);
  }

  function renderKnowledgeSidebar() {
    const conversations = knowledgeConversationRecords();
    if (!state.kbChatSidebarOpen) {
      return `<aside class="kb-chat-sidebar is-collapsed" aria-label="对话栏"><button class="kb-chat-sidebar-toggle" id="realKbSidebarToggle" type="button" aria-label="展开对话栏"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button></aside>`;
    }
    return `<aside class="kb-chat-sidebar" aria-label="对话栏">
      <div class="kb-chat-sidebar-head">
        <strong>对话</strong>
        <button class="kb-chat-sidebar-toggle" id="realKbSidebarToggle" type="button" aria-label="收起对话栏"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
      </div>
      <button class="kb-new-chat" id="realKbNewChatBtn" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>新对话</span></button>
      <nav class="kb-conversation-list" aria-label="历史对话">
        ${conversations.length ? conversations.map((conversation) => `<button type="button" class="kb-conversation-item ${state.kbConversationId === conversation.id ? "is-active" : ""}" data-kb-conversation-id="${esc(conversation.id)}"><span>${esc(knowledgeConversationTitle(conversation))}</span><small>${shortDate(conversation.updatedAt)}</small></button>`).join("") : `<p>还没有对话</p>`}
      </nav>
      <div class="kb-chat-sidebar-foot">内置 MCP · ${mcpHost.listTools().length} 项能力</div>
    </aside>`;
  }

  function renderKnowledgeBase() {
    ensureLoaded();
    if (!state.loaded) return renderLoading("知识库");
    const task = KNOWLEDGE_TASKS.find((item) => item.id === state.kbTask) || KNOWLEDGE_TASKS[0];
    const hasThread = Boolean(state.kbMessages.length || state.kbTaskArtifact || state.kbTaskStep);
    const conversationTitle = knowledgeConversationTitle({
      title: state.kbMessages.find((message) => message.role === "user")?.content || "",
    });
    return `
      <div class="page-scroll kb-agent-page">
        <div class="kb-agent-shell ${state.kbChatSidebarOpen ? "is-sidebar-open" : "is-sidebar-closed"}">
          ${renderKnowledgeSidebar()}
          <div class="kb-agent-main">
            <div class="kb-agent-stage ${hasThread ? "has-thread" : "is-empty"}">
              ${!state.kbChatSidebarOpen ? `<button class="kb-sidebar-reopen" id="realKbSidebarReopenBtn" type="button" aria-label="打开对话栏"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>` : ""}
              <header class="kb-agent-heading">
                <h1 class="serif-title">${hasThread ? esc(conversationTitle || "当前对话") : "需要我为你做些什么？"}</h1>
              </header>
              <div class="kb-agent-thread">
                ${state.kbMessages.map(renderKnowledgeMessage).join("")}
                ${renderKnowledgeTaskProgress()}
                ${state.kbTaskArtifact ? renderKnowledgeArtifact() : ""}
              </div>
              <form class="kb-agent-composer ${state.kbBusy ? "is-busy" : ""}" id="realKbComposer">
                <textarea id="realKbQuestion" rows="2" aria-label="${state.kbMode === "task" ? "描述知识整理任务" : "输入知识库问题"}" placeholder="${state.kbMode === "task" ? `例如：把关于注意力经济的笔记整理成一份 ${task.label}` : "输入 @ 可使用关联应用、任务等你想要的功能"}" ${state.kbBusy ? "disabled" : ""}>${esc(state.kbQuestion)}</textarea>
                <div class="kb-agent-composer-bar">
                  <button class="kb-agent-plus ${state.kbAttachmentBusy ? "is-active" : ""}" id="realKbAttachBtn" type="button" aria-label="上传图片或文档" ${state.kbAttachmentBusy ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
                  <span class="kb-agent-context">${state.kbAttachmentBusy ? "正在整理附件…" : "自动整理的知识库"}</span>
                  ${state.kbMode === "task" ? `<label class="kb-agent-format">格式 <select id="realKbTaskSelect" aria-label="导出格式">${KNOWLEDGE_TASKS.map((item) => `<option value="${item.id}" ${item.id === task.id ? "selected" : ""}>${esc(item.label)}</option>`).join("")}</select></label>` : ""}
                  <button class="kb-agent-send" id="realKbAskBtn" type="submit" aria-label="${state.kbMode === "task" ? "生成文件" : "发送问题"}" ${state.kbBusy ? "disabled" : ""}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>
                  </button>
                </div>
                <input id="realKbAttachmentInput" type="file" accept="image/*,application/pdf,.pdf,.txt,.md,.markdown,.csv,.json,.xml,.html,.htm" multiple hidden />
              </form>
              <div class="kb-mode-switch" role="group" aria-label="回答方式">
                <button type="button" class="${state.kbMode === "chat" ? "is-active" : ""}" data-kb-mode="chat">对话</button>
                <button type="button" class="${state.kbMode === "task" ? "is-active" : ""}" data-kb-mode="task">任务</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  function renderKnowledgeTaskProgress() {
    if (!state.kbTaskStep) return "";
    return `<div class="kb-chat-message is-assistant is-pending" role="status"><span class="kb-chat-typing" aria-hidden="true"></span><span>${esc(state.kbTaskStep)}…</span></div>`;
  }

  function renderKnowledgeArtifact() {
    const artifact = state.kbTaskArtifact;
    if (!artifact) return "";
    const task = KNOWLEDGE_TASKS.find((item) => item.id === artifact.task) || KNOWLEDGE_TASKS[0];
    return `<div class="kb-chat-message is-assistant kb-chat-file">
      <p>已生成 ${esc(task.label)}：<strong>${esc(artifact.filename)}</strong></p>
      <button class="kb-chat-download" type="button" id="realKbDownloadArtifact">再次下载</button>
    </div>`;
  }

  function renderKnowledgeMessage(message) {
    const role = message?.role === "user" ? "user" : "assistant";
    const content = String(message?.content || "").trim();
    if (!content) return "";
    return `<div class="kb-chat-message is-${role}"><p>${esc(content).replaceAll("\n", "<br>")}</p></div>`;
  }

  function fileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("无法读取附件。"));
      reader.readAsDataURL(file);
    });
  }

  function attachmentTextChunks(value, size = 1_400) {
    const paragraphs = String(value || "").replace(/\r/g, "").split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
    const chunks = [];
    let current = "";
    for (const paragraph of paragraphs.length ? paragraphs : [String(value || "").trim()]) {
      if (current && current.length + paragraph.length + 2 > size) {
        chunks.push(current);
        current = "";
      }
      if (paragraph.length > size) {
        if (current) chunks.push(current);
        current = "";
        for (let index = 0; index < paragraph.length; index += size) {
          chunks.push(paragraph.slice(index, index + size).trim());
        }
      } else {
        current += `${current ? "\n\n" : ""}${paragraph}`;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.filter(Boolean);
  }

  async function indexTextAttachment(file) {
    if (file.size > 8 * 1024 * 1024) throw new Error("文本附件不能超过 8 MB。");
    const chunks = attachmentTextChunks(await file.text());
    if (!chunks.length) throw new Error("附件中没有可整理的文字。");
    const evidenceIds = [];
    const sourceId = `attachment-${createId("file")}`;
    for (const chunk of chunks) {
      const evidence = await saveEvidence({
        kind: "source-excerpt",
        sourceId,
        sourceTitle: file.name,
        locator: { fileName: file.name, chunk: evidenceIds.length + 1 },
        excerpt: chunk,
        capturedAt: new Date().toISOString(),
        permanent: true,
      });
      evidenceIds.push(evidence.id);
    }
    await upsertKnowledgeNode({
      kind: "source",
      title: `资料：${file.name}`,
      summary: chunks[0].slice(0, 1_600),
      evidenceIds,
    });
    return { name: file.name, kind: "文本", evidenceCount: evidenceIds.length };
  }

  async function indexImageAttachment(file) {
    if (file.size > 24 * 1024 * 1024) throw new Error("图片附件不能超过 24 MB。");
    const dataUrl = await fileAsDataUrl(file);
    const assetId = createId("knowledge-image");
    await putRecord("assets", {
      id: assetId,
      kind: "knowledge-image",
      name: file.name,
      mime: file.type || "image/jpeg",
      blob: file,
      createdAt: new Date().toISOString(),
    });
    let recognized = null;
    let recognitionError = "";
    try {
      recognized = await recognizeVisualPage(dataUrl);
    } catch (error) {
      recognitionError = error.message;
    }
    const excerpt = recognized?.excerpt || `图片附件：${file.name}`;
    const evidence = await saveEvidence({
      kind: "visual-selection",
      sourceId: assetId,
      sourceTitle: file.name,
      locator: { imageAssetId: assetId, fileName: file.name },
      excerpt,
      imageAssetId: assetId,
      mime: file.type || "image/jpeg",
      metadata: recognized ? {
        recognitionModel: recognized.recognitionModel,
        recognitionProfile: recognized.recognitionProfile,
        confidence: recognized.confidence,
        visualDescription: recognized.visualDescription,
        formulas: recognized.formulas,
        tables: recognized.tables,
        figures: recognized.figures,
      } : { recognitionError },
      permanent: true,
    });
    await upsertKnowledgeNode({
      kind: "passage",
      title: `图片：${file.name}`,
      summary: excerpt.slice(0, 1_600),
      evidenceIds: [evidence.id],
    });
    return { name: file.name, kind: "图片", evidenceCount: 1, recognitionError };
  }

  async function indexPdfAttachment(file) {
    if (!fs()?.importPdfFiles) throw new Error("PDF 导入模块尚未加载，请刷新后重试。");
    const book = await fs().importPdfFiles([file]);
    if (!book) throw new Error("PDF 没有成功导入。");
    if (book.knowledgeProcessing?.status !== "verified") {
      await processBookKnowledge(book.id, (progress) => {
        state.kbTaskStep = progress.label || "正在整理 PDF";
        app.renderApp();
      });
    }
    return { name: file.name, kind: "PDF", bookId: book.id };
  }

  async function handleKnowledgeAttachments(files) {
    const list = Array.from(files || []);
    if (!list.length || state.kbAttachmentBusy || state.kbBusy) return;
    state.kbAttachmentBusy = true;
    app.renderApp();
    const indexed = [];
    const failures = [];
    try {
      for (const file of list) {
        app.toast(`正在整理附件：${file.name}`);
        try {
          if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
            indexed.push(await indexPdfAttachment(file));
          } else if (file.type.startsWith("image/") || /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(file.name)) {
            indexed.push(await indexImageAttachment(file));
          } else if (/\.(?:txt|md|markdown|csv|json|xml|html?|log)$/i.test(file.name) || file.type.startsWith("text/")) {
            indexed.push(await indexTextAttachment(file));
          } else {
            throw new Error("暂不支持这种附件格式，请使用图片、PDF、Markdown 或纯文本。");
          }
        } catch (error) {
          failures.push(`${file.name}：${error.message}`);
        }
      }
      if (indexed.length) {
        try {
          const wiki = await organizeKnowledgeBase();
          if (wiki.processed) {
            app.toast(`附件已汇入知识库，并更新了 ${wiki.pages} 个 Wiki 页面`);
          }
        } catch (error) {
          app.toast(`附件已保存，知识网络稍后自动整理：${error.message}`);
        }
        await refresh({ render: false });
      }
      if (failures.length) app.toast(failures[0]);
      else if (!indexed.length) app.toast("没有可整理的附件");
    } finally {
      state.kbAttachmentBusy = false;
      state.kbTaskStep = "";
      app.renderApp();
    }
  }

  async function saveKnowledgeConversation(question, result) {
    if (!result) return;
    const now = new Date().toISOString();
    const conversationId = state.kbConversationId || createId("conversation");
    const existing = state.conversations.find((item) => item.id === conversationId);
    const claims = (result.claims || []).map((claim) => {
      const sourceType = sourceTypeLabels[claim.sourceType] || "证据";
      return `- [${sourceType}] ${claim.statement}（证据：${(claim.evidenceIds || []).join("、")}）`;
    });
    let evidenceId = existing?.retention?.processedSummaryId || "";
    if (!result.insufficientEvidence) {
      const evidence = await saveEvidence({
        id: createId("evidence"), kind: "ai-summary", sourceId: "knowledge-base",
        sourceTitle: "知识库对话",
        excerpt: [`问题：${question}`, `结论：${result.answer}`, claims.length ? `证据化结论：\n${claims.join("\n")}` : ""].filter(Boolean).join("\n"),
        permanent: true,
      });
      evidenceId = evidence.id;
      const claimSummary = claims.length ? `\n${claims.join("\n")}` : "";
      await upsertKnowledgeNode({ kind: "ai-summary", title: question.slice(0, 30), summary: `${result.answer}${claimSummary}`, evidenceIds: [evidence.id] });
    }
    const messages = state.kbMessages.map((message) => ({
      id: createId("message"),
      role: message.role === "user" ? "user" : "assistant",
      content: String(message.content || ""),
      createdAt: now,
      citationIds: message.role === "assistant" ? (result.citations || []).map((item) => item.evidenceId) : [],
    }));
    const title = messages.find((message) => message.role === "user")?.content?.slice(0, 60) || question.slice(0, 60);
    const conversation = {
      ...(existing || {}),
      id: conversationId,
      scope: "knowledge-base",
      title,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      messages,
      retention: {
        knowledgeProcessedAt: now,
        summaryReady: Boolean(evidenceId),
        evidenceLinked: Boolean(evidenceId),
        processedSummaryId: evidenceId,
      },
    };
    await putRecord("conversations", conversation);
    state.kbConversationId = conversationId;
    state.conversations = [conversation, ...state.conversations.filter((item) => item.id !== conversationId)];
  }

  function startNewKnowledgeConversation() {
    if (state.kbBusy) return;
    state.kbConversationId = "";
    state.kbMessages = [];
    state.kbResult = null;
    state.kbQuestion = "";
    state.kbTaskArtifact = null;
    state.kbTaskStep = "";
    app.renderApp();
    requestAnimationFrame(() => document.getElementById("realKbQuestion")?.focus({ preventScroll: true }));
  }

  function openKnowledgeConversation(conversationId) {
    if (state.kbBusy) return;
    const conversation = state.conversations.find((item) => item.id === conversationId &&
      item.scope === "knowledge-base");
    if (!conversation) return;
    state.kbConversationId = conversation.id;
    state.kbMessages = (conversation.messages || [])
      .map((message) => ({ role: message.role === "user" ? "user" : "assistant", content: String(message.content || "") }))
      .filter((message) => message.content.trim());
    state.kbResult = null;
    state.kbQuestion = "";
    state.kbTaskArtifact = null;
    state.kbTaskStep = "";
    app.renderApp();
  }

  function isExplicitArtifactRequest(text) {
    const value = String(text || "").trim();
    const action = /(?:生成|导出|下载|保存|制作|做成|整理成|写成|转成|输出)/iu;
    const output = /(?:pdf|word|docx|ppt|pptx|演示文稿|幻灯片|报告|文档|成稿|稿件)/iu;
    return action.test(value) && output.test(value);
  }

  async function submitKnowledgeQuestion(question) {
    const text = String(question || "").trim();
    if (!text || state.kbBusy) return;
    if (state.kbMode === "task" && isExplicitArtifactRequest(text)) {
      return submitKnowledgeTask(text);
    }
    const history = state.kbMessages.slice(-10)
      .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content}`)
      .join("\n");
    state.kbTaskArtifact = null;
    state.kbTaskStep = "";
    state.kbMessages = [...state.kbMessages, { role: "user", content: text }];
    state.kbQuestion = "";
    state.kbBusy = true;
    state.kbResult = null;
    app.renderApp();
    try {
      const result = await mcpHost.callTool("knowledge.answer", {
        question: text,
        filter: state.kbFilter,
        history,
      });
      state.kbResult = result;
      state.kbMessages = [...state.kbMessages, { role: "assistant", content: result.answer }];
      await saveKnowledgeConversation(text, result);
      app.toast(result.insufficientEvidence ? "当前证据不足，没有生成推测性回答" : "回答已完成并通过本地引用校验");
    } catch (error) {
      state.kbResult = { answer: `检索失败：${error.message}`, citations: [], insufficientEvidence: true, localOnly: false, evidence: [] };
      state.kbMessages = [...state.kbMessages, { role: "assistant", content: `暂时没能完成这次回答：${error.message}` }];
      app.toast("知识库问答失败");
    } finally {
      state.kbBusy = false; await refresh({ render: false }); app.renderApp();
    }
  }

  async function submitKnowledgeTask(question) {
    const text = String(question || "").trim();
    if (!text || state.kbBusy) return;
    const task = KNOWLEDGE_TASKS.find((item) => item.id === state.kbTask) || KNOWLEDGE_TASKS[0];
    const history = state.kbMessages.slice(-8)
      .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content}`)
      .join("\n");
    state.kbMessages = [...state.kbMessages, { role: "user", content: text }];
    state.kbQuestion = "";
    state.kbBusy = true;
    state.kbResult = null;
    state.kbTaskArtifact = null;
    state.kbTaskStep = "正在检索相关证据";
    app.renderApp();
    try {
      const result = await mcpHost.callTool("knowledge.answer", {
        question: text,
        filter: "全部来源",
        history,
      });
      if (result.insufficientEvidence) throw new Error("知识库中的证据不足，暂时不能生成可靠成稿。");
      state.kbResult = result;
      state.kbMessages = [...state.kbMessages, { role: "assistant", content: result.answer }];
      await saveKnowledgeConversation(text, result);
      state.kbTaskStep = `正在组织${task.label}结构`;
      app.renderApp();
      const composed = await composeKnowledgeDeliverable({ task: task.id, question: text, result });
      state.kbTaskStep = "正在生成可下载文件";
      app.renderApp();
      const file = await mcpHost.callTool("artifact.create", { artifact: composed });
      await downloadArtifactFile(file);
      state.kbTaskArtifact = { ...file, title: composed.title, task: task.id };
      app.toast(`${task.label}已生成并开始下载`);
    } catch (error) {
      state.kbResult = {
        answer: `任务未完成：${error.message}`,
        citations: [],
        claims: [],
        insufficientEvidence: true,
        localOnly: false,
        evidence: [],
        retrievalQuality: { level: "none", warning: "" },
      };
      state.kbMessages = [...state.kbMessages, { role: "assistant", content: `任务未完成：${error.message}` }];
      app.toast("知识任务失败");
    } finally {
      state.kbTaskStep = "";
      state.kbBusy = false;
      await refresh({ render: false });
      app.renderApp();
    }
  }

  function bindKnowledgeBase() {
    const ask = () => submitKnowledgeQuestion(document.getElementById("realKbQuestion")?.value || state.kbQuestion);
    document.getElementById("realKbComposer")?.addEventListener("submit", (event) => {
      event.preventDefault();
      ask();
    });
    document.getElementById("realKbQuestion")?.addEventListener("input", (event) => { state.kbQuestion = event.target.value; });
    document.getElementById("realKbQuestion")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        ask();
      }
    });
    document.getElementById("realKbSidebarToggle")?.addEventListener("click", () => {
      state.kbChatSidebarOpen = !state.kbChatSidebarOpen;
      app.renderApp();
    });
    document.getElementById("realKbSidebarReopenBtn")?.addEventListener("click", () => {
      state.kbChatSidebarOpen = true;
      app.renderApp();
    });
    document.getElementById("realKbNewChatBtn")?.addEventListener("click", startNewKnowledgeConversation);
    document.querySelectorAll("[data-kb-conversation-id]").forEach((button) => button.addEventListener("click", () => {
      openKnowledgeConversation(button.getAttribute("data-kb-conversation-id"));
    }));
    document.querySelectorAll("[data-kb-mode]").forEach((button) => button.addEventListener("click", () => {
      state.kbMode = button.getAttribute("data-kb-mode") === "task" ? "task" : "chat";
      app.renderApp();
      requestAnimationFrame(() => document.getElementById("realKbQuestion")?.focus({ preventScroll: true }));
    }));
    document.getElementById("realKbAttachBtn")?.addEventListener("click", () => {
      document.getElementById("realKbAttachmentInput")?.click();
    });
    document.getElementById("realKbAttachmentInput")?.addEventListener("change", (event) => {
      const files = Array.from(event.target.files || []);
      event.target.value = "";
      handleKnowledgeAttachments(files);
    });
    document.getElementById("realKbTaskSelect")?.addEventListener("change", (event) => {
      if (KNOWLEDGE_TASKS.some((item) => item.id === event.target.value)) state.kbTask = event.target.value;
      app.renderApp();
    });
    document.getElementById("realKbDownloadArtifact")?.addEventListener("click", async () => {
      if (state.kbTaskArtifact) {
        try { await downloadArtifactFile(state.kbTaskArtifact); }
        catch (error) { app.toast(`保存文件失败：${error.message}`); }
      }
    });
  }

  function laidOutNodes() {
    const query = String(state.graphSearch || "").trim().toLocaleLowerCase("und");
    const matches = !query ? state.nodes : state.nodes.filter((node) => {
      const searchable = [node.title, node.summary, ...(node.aliases || [])]
        .filter(Boolean).join(" ").toLocaleLowerCase("und");
      return searchable.includes(query);
    });
    const nodes = matches.slice(0, 400);
    return nodes.map((node, index) => {
      if (Number.isFinite(node.x) && Number.isFinite(node.y)) return node;
      const ring = Math.floor(Math.sqrt(index + 1));
      const angle = index * 2.399963;
      const radius = 130 + ring * 95;
      return { ...node, x: 760 + Math.cos(angle) * radius, y: 500 + Math.sin(angle) * radius };
    });
  }

  function renderKnowledgeGraph() {
    ensureLoaded();
    if (!state.loaded) return renderLoading("知识图谱");
    const nodes = laidOutNodes();
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const ui = fs()?.state;
    const selected = nodes.find((node) => node.id === (state.selectedNodeId || ui?.selectedNodeId)) || null;
    const transform = `translate(${state.graphPanX} ${state.graphPanY}) scale(${state.graphZoom})`;
    return `
      <div class="pg-shell">
        <header class="pg-header"><div><h1 class="serif-title">私人知识图谱</h1><p>${state.nodes.length} 个 Wiki 页面与知识节点 · ${state.edges.length} 条有依据的关系 · AI 持续整理全部个人资料</p>${state.wikiMeta?.overview ? `<p class="pg-wiki-overview">${esc(state.wikiMeta.overview)}</p>` : ""}</div><div class="pg-actions"><input id="realGraphSearch" placeholder="搜索页面、别名或摘要…" value="${esc(state.graphSearch || "")}" /><button class="btn btn-sm" id="realGraphZoomOut">−</button><button class="btn btn-sm" id="realGraphFit">适应屏幕</button><button class="btn btn-sm" id="realGraphZoomIn">＋</button><button class="btn btn-sm btn-primary" id="realGraphRebuildBtn">重新整理全部资料</button></div></header>
        <div class="pg-layout">
          <div class="pg-canvas-wrap" id="graphCanvasWrap">
            ${nodes.length ? `<svg id="realGraphSvg" viewBox="0 0 1520 1000" aria-label="知识图谱">
              <g id="realGraphViewport" transform="${transform}">
                ${state.edges.filter((edge) => nodeMap.has(edge.fromNodeId) && nodeMap.has(edge.toNodeId)).map((edge) => {
                  const from = nodeMap.get(edge.fromNodeId); const to = nodeMap.get(edge.toNodeId);
                  return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="#B6AB98" stroke-width="1.4" opacity=".72" /><text x="${(from.x + to.x) / 2}" y="${(from.y + to.y) / 2 - 4}" fill="#8A7F6D" font-size="11" text-anchor="middle">${esc(relationLabels[edge.relation] || edge.relation)}</text>`;
                }).join("")}
                ${nodes.map((node) => {
                  const active = selected?.id === node.id; const radius = node.kind === "book" || node.kind === "paper" ? 27 : 18;
                  return `<g class="pg-node" data-node-id="${node.id}" transform="translate(${node.x},${node.y})" role="button" tabindex="0"><circle r="${radius + (active ? 6 : 0)}" fill="${active ? "#DCE9E2" : "#FAF8F3"}" stroke="${active ? "#1F4037" : "#BDB3A3"}" stroke-width="${active ? 2.5 : 1.4}" /><text y="${radius + 17}" text-anchor="middle" font-size="12" fill="#303632">${esc(node.title.slice(0, 18))}</text></g>`;
                }).join("")}
              </g></svg>` : `<div class="pg-empty"><h2 class="serif-title">图谱还是空的</h2><p>导入资料并在设置中配置 AI 后，系统会自动抽取概念与关系。笔记、画板和词典也会成为图谱节点。</p><button class="btn btn-primary" id="realGraphEmptyLibrary">去书库导入</button></div>`}
          </div>
          <aside class="pg-detail">${renderGraphDetail(selected)}</aside>
        </div>
      </div>`;
  }

  function renderGraphDetail(node) {
    if (!node) return `<div class="pg-detail-empty"><h3>选择一个节点</h3><p>点击图谱中的节点查看摘要、原文证据与关联内容。</p></div>`;
    const evidence = state.evidence.filter((item) => (node.evidenceIds || []).includes(item.id));
    const related = state.edges.filter((edge) => edge.fromNodeId === node.id || edge.toNodeId === node.id);
    const body = node.wiki?.body || "";
    return `<div class="pg-detail-head"><span class="badge badge-neutral">${esc(node.kind)}</span><button class="btn btn-sm btn-icon" id="closeGraphDetailBtn">×</button></div><h2 class="serif-title">${esc(node.title)}</h2><p>${esc(node.summary || "暂无摘要")}</p>${body ? `<h3>Wiki 页面</h3><div class="pg-wiki-body">${esc(body).replaceAll("\n", "<br>")}</div>` : ""}<h3>关联关系 (${related.length})</h3>${related.slice(0, 12).map((edge) => `<div class="pg-relation"><strong>${esc(relationLabels[edge.relation] || edge.relation)}</strong><span>${esc(edge.rationale || "AI 根据证据建立")}</span></div>`).join("") || "<p class='muted'>暂无关联</p>"}<h3>来源证据 (${evidence.length})</h3>${evidence.slice(0, 8).map((item) => `<article class="pg-evidence"><div>${esc(item.sourceTitle)}${item.page ? ` · 第 ${item.page} 页` : ""} · ${kindLabels[item.kind] || item.kind}</div><blockquote>${esc(item.excerpt.slice(0, 260))}</blockquote>${item.bookId ? `<button class="btn btn-sm real-graph-open-book" data-book-id="${item.bookId}" data-page="${item.page || 1}">打开原文</button>` : ""}</article>`).join("") || "<p class='muted'>没有可显示的证据</p>"}`;
  }

  async function rebuildKnowledge() {
    if (!(await hasApiKey("graph"))) { app.toast("请先为知识整理配置模型档案"); app.switchView("settings"); return; }
    const button = document.getElementById("realGraphRebuildBtn");
    if (button) { button.disabled = true; button.textContent = "正在整理…"; }
    try {
      await processUnverifiedBooks((progress) => { if (button) button.textContent = progress.label || "正在整理…"; });
      const wiki = await organizeKnowledgeBase({
        force: true,
        progress: (progress) => { if (button) button.textContent = progress.label || "正在整理…"; },
      });
      await refresh();
      app.toast(`知识 Wiki 已重建：${wiki.pages || 0} 个页面，${wiki.links || 0} 条关系`);
    } catch (error) { app.toast(`知识整理失败：${error.message}`); }
    finally { if (button) { button.disabled = false; button.textContent = "整理全部资料"; } }
  }

  function bindKnowledgeGraph() {
    document.querySelectorAll(".pg-node").forEach((node) => node.addEventListener("click", () => {
      state.selectedNodeId = node.getAttribute("data-node-id");
      const ui = fs()?.state; if (ui) ui.selectedNodeId = state.selectedNodeId;
      app.renderApp();
    }));
    document.getElementById("closeGraphDetailBtn")?.addEventListener("click", () => { state.selectedNodeId = ""; app.renderApp(); });
    document.getElementById("realGraphSearch")?.addEventListener("input", (event) => {
      state.graphSearch = event.target.value;
      app.renderApp();
      requestAnimationFrame(() => {
        const input = document.getElementById("realGraphSearch");
        if (!input) return;
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
      });
    });
    document.getElementById("realGraphZoomIn")?.addEventListener("click", () => { state.graphZoom = Math.min(2.5, state.graphZoom * 1.15); app.renderApp(); });
    document.getElementById("realGraphZoomOut")?.addEventListener("click", () => { state.graphZoom = Math.max(0.35, state.graphZoom / 1.15); app.renderApp(); });
    document.getElementById("realGraphFit")?.addEventListener("click", () => { state.graphZoom = 0.86; state.graphPanX = 0; state.graphPanY = 0; app.renderApp(); });
    document.getElementById("realGraphRebuildBtn")?.addEventListener("click", rebuildKnowledge);
    document.getElementById("realGraphEmptyLibrary")?.addEventListener("click", () => app.switchView("library"));
    document.querySelectorAll(".real-graph-open-book").forEach((button) => button.addEventListener("click", () => {
      const ui = fs()?.state; if (ui) ui.readerPage = Number(button.getAttribute("data-page")) || 1;
      app.switchView("reader", { bookId: button.getAttribute("data-book-id") });
    }));
    const wrap = document.getElementById("graphCanvasWrap");
    if (wrap) {
      let drag = null;
      let pinch = null;
      const pointers = new Map();

      function graphCoordinates(clientX, clientY) {
        const rect = wrap.getBoundingClientRect();
        return {
          x: ((clientX - rect.left) / Math.max(1, rect.width)) * 1520,
          y: ((clientY - rect.top) / Math.max(1, rect.height)) * 1000,
        };
      }

      function zoomAt(nextZoom, clientX, clientY) {
        const point = graphCoordinates(clientX, clientY);
        const worldX = (point.x - state.graphPanX) / state.graphZoom;
        const worldY = (point.y - state.graphPanY) / state.graphZoom;
        state.graphZoom = Math.max(0.35, Math.min(2.5, nextZoom));
        state.graphPanX = point.x - worldX * state.graphZoom;
        state.graphPanY = point.y - worldY * state.graphZoom;
        document.getElementById("realGraphViewport")?.setAttribute(
          "transform", `translate(${state.graphPanX} ${state.graphPanY}) scale(${state.graphZoom})`,
        );
      }

      wrap.addEventListener("wheel", (event) => {
        event.preventDefault();
        zoomAt(state.graphZoom * (event.deltaY < 0 ? 1.1 : 0.9), event.clientX, event.clientY);
      }, { passive: false });
      wrap.addEventListener("pointerdown", (event) => {
        if (event.target.closest(".pg-node") && pointers.size === 0 && event.pointerType !== "touch") return;
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.size >= 2) {
          const [first, second] = [...pointers.values()];
          drag = null;
          pinch = {
            distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
            zoom: state.graphZoom,
          };
        } else {
          drag = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: state.graphPanX, panY: state.graphPanY };
        }
        wrap.setPointerCapture(event.pointerId);
      });
      wrap.addEventListener("pointermove", (event) => {
        if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pinch && pointers.size >= 2) {
          event.preventDefault();
          const [first, second] = [...pointers.values()];
          const centerX = (first.x + second.x) / 2;
          const centerY = (first.y + second.y) / 2;
          const ratio = Math.hypot(first.x - second.x, first.y - second.y) / pinch.distance;
          zoomAt(pinch.zoom * ratio, centerX, centerY);
          return;
        }
        if (!drag || drag.id !== event.pointerId) return;
        event.preventDefault();
        state.graphPanX = drag.panX + event.clientX - drag.x;
        state.graphPanY = drag.panY + event.clientY - drag.y;
        document.getElementById("realGraphViewport")?.setAttribute("transform", `translate(${state.graphPanX} ${state.graphPanY}) scale(${state.graphZoom})`);
      });
      const finishPointer = (event) => {
        pointers.delete(event.pointerId);
        if (pointers.size < 2) pinch = null;
        if (drag?.id === event.pointerId) drag = null;
      };
      wrap.addEventListener("pointerup", finishPointer);
      wrap.addEventListener("pointercancel", finishPointer);
    }
  }

  function dictionaryEntries() {
    const query = state.dictQuery.toLocaleLowerCase("en").trim();
    return state.dictionary
      .filter((entry) => {
        if (state.dictFilter === "待学习") return !entry.mastery || entry.mastery === "new";
        if (state.dictFilter === "学习中") return entry.mastery === "learning";
        if (state.dictFilter === "已掌握") return entry.mastery === "known";
        return true;
      })
      .filter((entry) => !query || entry.lemma.includes(query) || String(entry.definitionZh || "").toLocaleLowerCase("und").includes(query))
      .sort((a, b) => String(b.lastMarkedAt).localeCompare(String(a.lastMarkedAt)));
  }

  function selectedDictionaryEntry(entries = dictionaryEntries()) {
    const requested = state.selectedWord || fs()?.state?.selectedWordKey || "";
    return entries.find((entry) => entry.lemma === requested) || entries[0] || null;
  }

  function renderDictionary() {
    ensureLoaded();
    if (!state.loaded) return renderLoading("词典");
    const entries = dictionaryEntries();
    const selected = selectedDictionaryEntry(entries);
    return `
      <div class="page-scroll dict-real-page">
        <section class="dict-real-header"><div><h1 class="serif-title">语境词典</h1><p>长按阅读中的英文单词即可标记；同一单词只保留一个词条，并累计全部标注次数与原句语境。</p></div><div class="dict-honest-stats"><strong>${state.dictionary.length}</strong><span>去重词条</span><strong>${state.dictionary.reduce((sum, item) => sum + Number(item.count || 0), 0)}</strong><span>累计标注</span></div></section>
        <div class="dict-real-layout">
          <aside class="dict-real-list card">
            <input id="realDictSearch" value="${esc(state.dictQuery)}" placeholder="搜索单词或中文释义…" />
            <div class="dict-real-filters">${["全部", "待学习", "学习中", "已掌握"].map((filter) => `<button class="btn btn-sm ${state.dictFilter === filter ? "btn-tonal" : ""}" data-dict-filter="${filter}">${filter}</button>`).join("")}</div>
            <div class="dict-real-items">${entries.length ? entries.map((entry) => `<button class="dict-real-item ${selected?.lemma === entry.lemma ? "active" : ""}" data-dict-word="${esc(entry.lemma)}"><div><strong>${esc(entry.displayForm || entry.lemma)}</strong><span>${esc(entry.partOfSpeech || "待补全词性")} ${esc(entry.definitionZh || "尚未生成释义")}</span></div><b>${entry.count || 1}×</b></button>`).join("") : `<div class="dict-empty">${state.dictionary.length ? "没有符合筛选条件的单词。" : "词典还是空的。阅读外文时，用 Apple Pencil 或手指长按单词即可加入。"}</div>`}</div>
          </aside>
          <main class="dict-real-detail card">${renderDictionaryDetail(selected)}</main>
        </div>
      </div>`;
  }

  function renderDictionaryDetail(entry) {
    if (!entry) return `<div class="dict-detail-empty"><h2 class="serif-title">选择一个单词</h2><p>每次长按都会保留它当时所在的原句，用于后续背诵和理解。</p></div>`;
    return `
      <div class="dict-detail-head"><div><span class="badge badge-green">${esc(entry.mastery === "known" ? "已掌握" : entry.mastery === "learning" ? "学习中" : "待学习")}</span><span class="badge badge-gold">标注 ${entry.count || 1} 次</span></div><div><button class="btn btn-sm" id="realDictSpeak">朗读</button><button class="btn btn-sm" id="realDictMastery">${entry.mastery === "known" ? "标为待学习" : "标为已掌握"}</button></div></div>
      <h2 class="dict-real-word">${esc(entry.displayForm || entry.lemma)}</h2>
      <div class="dict-real-phonetic">${esc(entry.phonetic || "")} <span>${esc(entry.partOfSpeech || "")}</span></div>
      <div class="dict-real-definition">${esc(entry.definitionZh || "尚未生成释义。配置 AI 后可结合当前原句生成中文释义、词性和例句翻译。")}</div>
      <button class="btn btn-primary" id="realDictEnrich" ${state.dictBusy ? "disabled" : ""}>${state.dictBusy ? "正在生成释义…" : entry.definitionZh ? "结合最新原句重新解释" : "AI 生成词典释义"}</button>
      <h3>原书语境 (${entry.occurrences?.length || 0})</h3>
      <div class="dict-occurrences">${(entry.occurrences || []).slice().reverse().map((occurrence) => `<article><div>${esc(occurrence.bookTitle || "本地书籍")} · 第 ${occurrence.page || "?"} 页 · ${shortDate(occurrence.markedAt)}</div><blockquote>${esc(occurrence.sentence || "未捕获原句")}</blockquote>${occurrence.translation ? `<p>${esc(occurrence.translation)}</p>` : ""}${occurrence.bookId ? `<button class="btn btn-sm real-dict-open-book" data-book-id="${occurrence.bookId}" data-page="${occurrence.page || 1}">回到原句</button>` : ""}</article>`).join("")}</div>
      <button class="btn btn-tonal" id="realDictReview" style="margin-top:16px;">开始语境背诵</button>`;
  }

  function openDictionaryReview(entry) {
    if (!entry) return;
    let revealed = false;
    const root = document.getElementById("modalRoot");
    const draw = () => {
      const sentence = entry.occurrences?.at(-1)?.sentence || "";
      root.innerHTML = `<div class="modal-backdrop" id="dictReviewBackdrop"><div class="modal-card" style="max-width:620px;" onclick="event.stopPropagation()"><div style="display:flex;justify-content:space-between;align-items:center;"><h2 class="serif-title">语境背诵</h2><button class="btn btn-sm" id="closeDictReview">关闭</button></div><div class="dict-review-word">${esc(entry.displayForm || entry.lemma)}</div><blockquote>${esc(sentence)}</blockquote>${revealed ? `<div class="dict-review-answer"><strong>${esc(entry.partOfSpeech || "")} ${esc(entry.definitionZh || "暂无释义")}</strong><p>${esc(entry.occurrences?.at(-1)?.translation || "")}</p></div>` : ""}<div style="display:flex;gap:8px;margin-top:16px;"><button class="btn btn-primary" id="revealDictReview">${revealed ? "再想一遍" : "显示释义"}</button><button class="btn" id="nextDictReview">下一个单词</button></div></div></div>`;
      document.getElementById("closeDictReview").onclick = () => { root.innerHTML = ""; };
      document.getElementById("revealDictReview").onclick = () => { revealed = !revealed; draw(); };
      document.getElementById("nextDictReview").onclick = () => {
        const all = dictionaryEntries(); const index = all.findIndex((item) => item.lemma === entry.lemma);
        entry = all[(index + 1) % all.length] || entry; revealed = false; draw();
      };
    };
    draw();
  }

  function bindDictionary() {
    const search = document.getElementById("realDictSearch");
    search?.addEventListener("input", (event) => {
      state.dictQuery = event.target.value; app.renderApp(); requestAnimationFrame(() => {
        const input = document.getElementById("realDictSearch"); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length);
      });
    });
    document.querySelectorAll("[data-dict-filter]").forEach((button) => button.addEventListener("click", () => { state.dictFilter = button.getAttribute("data-dict-filter"); app.renderApp(); }));
    document.querySelectorAll("[data-dict-word]").forEach((button) => button.addEventListener("click", () => { state.selectedWord = button.getAttribute("data-dict-word"); app.renderApp(); }));
    const entry = selectedDictionaryEntry();
    document.getElementById("realDictSpeak")?.addEventListener("click", () => {
      if (!entry || !("speechSynthesis" in window)) return app.toast("当前设备不支持系统朗读");
      const utterance = new SpeechSynthesisUtterance(entry.displayForm || entry.lemma); utterance.lang = "en-US"; speechSynthesis.speak(utterance);
    });
    document.getElementById("realDictMastery")?.addEventListener("click", async () => {
      if (!entry) return;
      const updated = { ...entry, mastery: entry.mastery === "known" ? "learning" : "known" }; await putRecord("dictionary", updated);
      await refresh(); app.toast(updated.mastery === "known" ? "已标为掌握" : "已重新加入学习");
    });
    document.getElementById("realDictEnrich")?.addEventListener("click", async () => {
      if (!entry || state.dictBusy) return;
      state.dictBusy = true; app.renderApp();
      try { const updated = await enrichDictionaryWord(entry); state.selectedWord = updated.lemma; await refresh(); app.toast("释义、词性和例句翻译已保存"); }
      catch (error) { app.toast(`词典释义失败：${error.message}`); }
      finally { state.dictBusy = false; app.renderApp(); }
    });
    document.getElementById("realDictReview")?.addEventListener("click", () => openDictionaryReview(entry));
    document.querySelectorAll(".real-dict-open-book").forEach((button) => button.addEventListener("click", () => {
      const ui = fs()?.state; if (ui) ui.readerPage = Number(button.getAttribute("data-page")) || 1;
      app.switchView("reader", { bookId: button.getAttribute("data-book-id") });
    }));
  }

  function modelTypeLabel(type) {
    return type === "embedding" ? "向量模型" : "对话 / 多模态";
  }

  function endpointHost(endpoint) {
    try { return new URL(endpoint).host; }
    catch { return String(endpoint || ""); }
  }

  function currentModelEditor() {
    const profiles = state.aiSettings?.profiles || [];
    if (state.editingModelId === "__new__") {
      return {
        id: "", type: "chat", endpoint: "https://api.deepseek.com/chat/completions",
        model: "", hasKey: false, isNew: true,
      };
    }
    const selected = profiles.find((profile) => profile.id === state.editingModelId);
    return selected ? { ...selected, isNew: false } : null;
  }

  function renderModelProfiles() {
    const profiles = state.aiSettings?.profiles || [];
    if (!profiles.length) {
      return `<p class="settings-empty">还没有模型。添加一个模型后，就可以在下面的功能分配中选择它。</p>`;
    }
    return profiles.map((profile) => `
      <div class="model-profile-entry ${state.editingModelId === profile.id ? "is-editing" : ""}" data-profile-anchor="${esc(profile.id)}" data-settings-anchor="profile:${esc(profile.id)}">
        <article class="model-profile-row">
          <div class="model-profile-identity">
            <strong>${esc(profile.model || "未填写模型 ID")}</strong>
            <span class="model-profile-meta">${profile.builtin ? "内置 · " : ""}${esc(modelTypeLabel(profile.type))} · <i>${esc(endpointHost(profile.endpoint))}</i></span>
          </div>
          <span class="model-key-state ${profile.availability === "quota-exhausted" ? "is-unset" : profile.hasKey ? "is-set" : "is-unset"}">${profile.availability === "quota-exhausted" ? "额度待恢复" : profile.hasKey ? "密钥已保存" : "未配置密钥"}</span>
          <div class="model-profile-actions">
            <button class="btn btn-sm" data-edit-model-profile="${esc(profile.id)}">${state.editingModelId === profile.id ? "正在编辑" : "编辑"}</button>
            <button class="btn btn-sm" data-test-model-profile="${esc(profile.id)}" ${profile.hasKey ? "" : "disabled"}>测试</button>
          </div>
        </article>
        ${state.editingModelId === profile.id ? renderModelEditor({ ...profile, isNew: false }) : ""}
      </div>`).join("");
  }

  function renderModelBindings() {
    const profiles = state.aiSettings?.profiles || [];
    const bindings = state.aiSettings?.bindings || {};
    const groups = [
      { type: "chat", title: "对话功能", roles: MODEL_ROLE_DEFINITIONS.filter((role) => role.type === "chat") },
      { type: "embedding", title: "向量功能", roles: MODEL_ROLE_DEFINITIONS.filter((role) => role.type === "embedding") },
    ];
    return groups.map((group) => {
      const matching = profiles.filter((profile) => profile.type === group.type &&
        profile.hasKey && profile.availability !== "quota-exhausted");
      return `
        <div class="binding-group">
          <div class="binding-group-head"><h3>${group.title}</h3><span>${matching.length} 个已配置模型</span></div>
          <div class="model-bindings">
            ${group.roles.map((role) => `
              <label class="model-binding-row" data-settings-anchor="binding:${esc(role.id)}">
                <span class="model-binding-copy"><b>${esc(role.label)}</b><small>${esc(role.hint)}</small></span>
                <select data-model-role="${esc(role.id)}" ${matching.length ? "" : "disabled"}>
                  ${matching.length
                    ? `<option value="">未指定</option>${matching.map((profile) => `<option value="${esc(profile.id)}" title="${esc(profile.model)} · ${esc(profile.endpoint)}" ${bindings[role.id] === profile.id ? "selected" : ""}>${esc(profile.model)} · ${esc(endpointHost(profile.endpoint))}</option>`).join("")}`
                    : `<option value="">先为${group.type === "chat" ? "对话" : "向量"}模型保存 API Key</option>`}
                </select>
              </label>`).join("")}
          </div>
        </div>`;
    }).join("");
  }

  function renderModelEditor(editor) {
    if (!editor) return "";
    return `
      <div class="model-editor" data-editing-id="${esc(editor.id)}" data-editing-new="${editor.isNew ? "true" : "false"}">
        <div class="model-editor-head">
          <div><h3 class="serif-title">${editor.isNew ? "添加模型" : `编辑 ${esc(editor.model)}`}</h3><p>${editor.isNew ? "只需填写接口、模型 ID 和密钥。" : "修改后，下一次请求即生效。"}</p></div>
          <button class="btn btn-sm" id="realCancelModelEditBtn">取消</button>
        </div>
        <div class="model-editor-grid">
          <label>模型 ID<input id="realAiModel" value="${esc(editor.model)}" placeholder="服务商控制台中的模型名称" /></label>
          <label>类型<select id="realAiType"><option value="chat" ${editor.type !== "embedding" ? "selected" : ""}>对话 / 多模态</option><option value="embedding" ${editor.type === "embedding" ? "selected" : ""}>向量模型</option></select></label>
          <label class="wide">接口地址<input id="realAiEndpoint" value="${esc(editor.endpoint)}" placeholder="完整的 OpenAI 兼容接口地址" /></label>
          <label class="wide">API Key<input id="realAiKey" type="password" autocomplete="off" placeholder="${editor.hasKey ? "密钥已加密保存；留空表示不修改" : "输入此模型对应的 API Key"}" /></label>
        </div>
        <div class="model-editor-actions">
          <button class="btn btn-primary" id="realSaveAiBtn">加密保存</button>
          <button class="btn" id="realTestAiBtn">测试连接</button>
          <div class="model-editor-danger">
            ${editor.hasKey ? `<button class="btn" id="realClearAiBtn">清除密钥</button>` : ""}
            ${editor.isNew ? "" : `<button class="btn btn-terracotta" data-delete-model-profile="${esc(editor.id)}">删除模型</button>`}
          </div>
        </div>
        <p class="settings-hint">密钥使用 AES-GCM 加密后只保存在本机，不进入备份。生成参数由便读按任务自动匹配，不需要手动调温度。</p>
      </div>`;
  }

  function renderDataSettings() {
    const storage = state.storageEstimate;
    const books = state.books.filter((book) => book.source === "local-pdf");
    const eligible = books.filter((book) => cleanupEligibility(book).eligible);
    const semantic = state.aiSettings?.semanticIndex;
    return `
      <details class="settings-data" ${state.dataSettingsOpen ? "open" : ""}>
        <summary>
          <span class="settings-data-title"><b>数据与备份</b><small>本地存储、知识整理、原文清理与完整备份</small></span>
          <span class="settings-data-side"><span class="settings-data-meta">已用 ${formatBytes(storage?.usage)}</span><span class="settings-data-chevron" aria-hidden="true"></span></span>
        </summary>
        <div class="settings-data-body">
          <div class="settings-data-summary">
            <div><span>存储状态</span><strong>${state.storagePersisted ? "持久存储已获准" : "系统未承诺永久保留"}</strong></div>
            <div><span>可用空间</span><strong>${formatBytes(storage?.quota)}</strong></div>
            <div><span>最近备份</span><strong>${state.lastBackupAt ? shortDate(state.lastBackupAt) : "还没有记录"}</strong></div>
          </div>
          <section class="settings-data-group">
            <div class="settings-data-heading"><h3>知识整理</h3><span>${state.evidence.length} 条证据 · ${state.nodes.length} 个节点 · ${state.edges.length} 条关系</span></div>
            <div class="settings-book-jobs">${books.length ? books.map((book) => `<div><strong>${esc(book.title)}</strong><span class="${book.knowledgeProcessing?.status === "verified" ? "ok" : book.knowledgeProcessing?.status === "failed" ? "bad" : ""}">${book.knowledgeProcessing?.status === "verified" ? `已整理 · ${shortDate(book.knowledgeProcessing.verifiedAt)}` : book.knowledgeProcessing?.status === "failed" ? `失败：${esc(book.knowledgeProcessing.blockedReason || "未知原因")}` : "等待整理"}</span></div>`).join("") : "<p class='muted'>还没有导入书籍。</p>"}</div>
            <div class="settings-actions"><button class="btn btn-primary" id="settingsProcessKnowledgeBtn">整理并重建个人知识 Wiki</button></div>
          </section>
          <section class="settings-data-group">
            <div class="settings-data-heading"><h3>语义索引</h3><span>${semantic ? `${esc(semantic.model)} · ${semantic.count} 条证据 · ${semantic.dimensions} 维${semantic.fallbackUsed ? " · 已使用备用模型" : ""}` : "尚未建立，问答会暂时使用本地关键词检索"}</span></div>
            <div class="settings-actions"><button class="btn" id="settingsRebuildEmbeddingsBtn">更新全部语义索引</button></div>
          </section>
          <section class="settings-data-group">
            <div class="settings-data-heading"><h3>七天原文清理</h3><span>${eligible.length} 本可清理</span></div>
            <div class="cleanup-list">${books.length ? books.map((book) => {
              const decision = cleanupEligibility(book);
              return `<div><strong>${esc(book.title)}</strong><span>${decision.eligible ? "已到期，可清理原文" : decision.blockers.join("；")}</span>${decision.eligibleAt ? `<small>计划时间：${shortDate(decision.eligibleAt)}</small>` : ""}</div>`;
            }).join("") : "<p class='muted'>没有可清理的书籍。</p>"}</div>
            <div class="settings-actions"><button class="btn ${eligible.length ? "btn-terracotta" : ""}" id="settingsRunCleanupBtn" ${eligible.length ? "" : "disabled"}>执行已到期清理</button></div>
            <p class="settings-hint">笔记、图片、画板、词典、知识卡片和证据短句永久保留。</p>
          </section>
          <section class="settings-data-group">
            <div class="settings-data-heading"><h3>本地备份与恢复</h3><span>备份不包含 API Key</span></div>
            <div class="settings-actions"><button class="btn btn-primary" id="settingsExportBackupBtn">导出完整备份</button><button class="btn" id="settingsImportBackupBtn">从备份恢复</button><input type="file" id="settingsBackupFile" accept=".json,.biandu" hidden /></div>
            <p class="settings-hint">恢复按 ID 合并，不会覆盖本机较新的笔记、画板或知识节点。</p>
          </section>
          <div class="privacy-list">
            <div><b>永久</b><span>笔记、图片、画板、词典、证据与知识图谱</span></div>
            <div><b>7 天后</b><span>已完成整理的 PDF 原文和 AI 原始对话</span></div>
            <div><b>从不发送</b><span>整本书、无关书籍、API Key、备份文件</span></div>
          </div>
        </div>
      </details>`;
  }

  function renderSettings() {
    ensureLoaded();
    if (!state.loaded) return renderLoading("设置");
    const profiles = state.aiSettings?.profiles || [];
    const configured = profiles.filter((profile) => profile.hasKey).length;
    return `
      <div class="page-scroll settings-real-page">
        <header class="settings-head">
          <h1 class="serif-title">模型设置</h1>
          <p>配置模型，并为每个阅读功能指定要使用的模型。模型与密钥只保存在本机。</p>
        </header>
        <section class="settings-section" aria-labelledby="settingsProfilesTitle">
          <div class="settings-section-head">
            <div><h2 class="serif-title" id="settingsProfilesTitle">我的模型</h2><p>模型以真实 ID 显示；配置一次后，可在下方的功能分配中重复选择。</p></div>
            <div class="settings-section-actions">
              <span class="settings-count">${configured} / ${profiles.length} 已配置密钥</span>
              <button class="btn btn-primary btn-sm" id="realAddModelProfileBtn">添加模型</button>
            </div>
          </div>
          <div class="model-preset-bar">
            <div class="model-preset-copy">
              <strong>从官方服务添加</strong>
              <span>预设只填写接口和模型 ID，密钥仍需由你配置。</span>
            </div>
            <div class="model-preset-controls">
              <select id="realOfficialPresetSelect" aria-label="选择官方模型">
                ${OFFICIAL_MODEL_PRESETS.map((preset) => `<option value="${esc(preset.id)}">${esc(preset.label)}</option>`).join("")}
              </select>
              <button class="btn btn-tonal btn-sm" id="realAddPresetModelBtn">添加预设</button>
            </div>
          </div>
          ${state.editingModelId === "__new__" ? `<div class="model-new-entry" data-settings-anchor="new-model">${renderModelEditor(currentModelEditor())}</div>` : ""}
          <div class="model-profile-list">${renderModelProfiles()}</div>
        </section>
        <section class="settings-section" aria-labelledby="settingsBindingsTitle">
          <div class="settings-section-head">
            <div><h2 class="serif-title" id="settingsBindingsTitle">功能分配</h2><p>为每项功能选择“我的模型”中已配置的同类型模型，修改后下一次请求立即生效。</p></div>
          </div>
          ${renderModelBindings()}
        </section>
        ${renderDataSettings()}
      </div>`;
  }

  function aiFormValues() {
    const editor = document.querySelector(".model-editor");
    return {
      id: editor?.dataset.editingNew === "true" ? "" : editor?.dataset.editingId,
      type: document.getElementById("realAiType")?.value || "chat",
      endpoint: document.getElementById("realAiEndpoint")?.value.trim(),
      model: document.getElementById("realAiModel")?.value.trim(),
      apiKey: document.getElementById("realAiKey")?.value.trim() || undefined,
    };
  }

  function settingsAnchor(key) {
    if (!key) return null;
    return [...document.querySelectorAll("[data-settings-anchor]")]
      .find((element) => element.getAttribute("data-settings-anchor") === key) || null;
  }

  function captureSettingsPosition(key) {
    const scroll = document.querySelector(".settings-real-page");
    const anchor = settingsAnchor(key);
    return {
      key,
      scrollTop: Number(scroll?.scrollTop) || 0,
      anchorTop: anchor?.getBoundingClientRect().top ?? null,
    };
  }

  function restoreSettingsPosition(snapshot, options = {}) {
    const scroll = document.querySelector(".settings-real-page");
    if (!scroll) return;
    const anchor = settingsAnchor(snapshot?.key);
    if (Number.isFinite(snapshot?.anchorTop) && anchor) {
      const delta = anchor.getBoundingClientRect().top - snapshot.anchorTop;
      const maxTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      scroll.scrollTop = Math.max(0, Math.min(maxTop, snapshot.scrollTop + delta));
    } else {
      scroll.scrollTop = snapshot?.scrollTop || 0;
    }
    if (options.revealAnchor && anchor) anchor.scrollIntoView({ block: "nearest" });
    if (options.focusSelector) {
      document.querySelector(options.focusSelector)?.focus({ preventScroll: true });
    }
  }

  function rerenderSettings(snapshot, options = {}) {
    app.renderApp();
    restoreSettingsPosition(snapshot, options);
    requestAnimationFrame(() => restoreSettingsPosition(snapshot, options));
  }

  function bindSettings() {
    const dataDetails = document.querySelector(".settings-data");
    if (dataDetails) {
      state.dataSettingsOpen = dataDetails.open;
      dataDetails.addEventListener("toggle", () => { state.dataSettingsOpen = dataDetails.open; });
    }
    document.getElementById("realAddPresetModelBtn")?.addEventListener("click", async () => {
      const select = document.getElementById("realOfficialPresetSelect");
      const preset = OFFICIAL_MODEL_PRESETS.find((item) => item.id === select?.value);
      if (!preset) return;
      const button = document.getElementById("realAddPresetModelBtn");
      if (button) { button.disabled = true; button.textContent = "正在添加…"; }
      try {
        const saved = await configureModelProfile(preset);
        state.editingModelId = saved.id;
        await refresh({ render: false });
        rerenderSettings(captureSettingsPosition(`profile:${saved.id}`), {
          revealAnchor: true,
          focusSelector: "#realAiKey",
        });
        app.toast(`已添加“${preset.label}”，请填写对应的 API Key`);
      } catch (error) {
        app.toast(`添加预设失败：${error.message}`);
        if (button) { button.disabled = false; button.textContent = "添加官方预设"; }
      }
    });
    document.getElementById("realAddModelProfileBtn")?.addEventListener("click", () => {
      const snapshot = captureSettingsPosition(null);
      state.editingModelId = "__new__";
      rerenderSettings(snapshot, { focusSelector: "#realAiModel" });
      requestAnimationFrame(() => settingsAnchor("new-model")?.scrollIntoView({ block: "nearest" }));
    });
    document.getElementById("realCancelModelEditBtn")?.addEventListener("click", () => {
      const editor = document.querySelector(".model-editor");
      const key = editor?.dataset.editingNew === "true"
        ? "new-model"
        : `profile:${editor?.dataset.editingId || ""}`;
      const snapshot = captureSettingsPosition(key);
      state.editingModelId = "";
      rerenderSettings(snapshot);
    });
    document.querySelectorAll("[data-edit-model-profile]").forEach((button) => button.addEventListener("click", () => {
      const profileId = button.getAttribute("data-edit-model-profile");
      const snapshot = captureSettingsPosition(`profile:${profileId}`);
      state.editingModelId = profileId;
      rerenderSettings(snapshot, { focusSelector: "#realAiModel" });
    }));
    document.querySelectorAll("[data-delete-model-profile]").forEach((button) => button.addEventListener("click", async () => {
      const profileId = button.getAttribute("data-delete-model-profile");
      const profile = (state.aiSettings.profiles || []).find((item) => item.id === profileId);
      if (!profile || !window.confirm(`确定删除模型“${profile.model}”及其本机密钥？`)) return;
      const snapshot = captureSettingsPosition(`profile:${profileId}`);
      try {
        await deleteModelProfile(profileId);
        if (state.editingModelId === profileId) state.editingModelId = "";
        await refresh({ render: false });
        rerenderSettings(snapshot);
        app.toast("模型档案已删除");
      } catch (error) { app.toast(`删除失败：${error.message}`); }
    }));
    document.querySelectorAll("[data-test-model-profile]").forEach((button) => button.addEventListener("click", async () => {
      const profileId = button.getAttribute("data-test-model-profile");
      const profile = (state.aiSettings.profiles || []).find((item) => item.id === profileId);
      if (!profile) return;
      const snapshot = captureSettingsPosition(`profile:${profileId}`);
      button.disabled = true; button.textContent = "测试中…";
      try {
        if (profile.type === "embedding") {
          const result = await testEmbeddingProfile(profileId);
          app.toast(`向量模型连接成功：${result.model} · ${result.dimensions} 维`);
        } else {
          const response = await testConnection(profileId);
          app.toast(`模型连接成功：${response.slice(0, 40)}`);
        }
        await markModelProfileAvailable(profileId);
        await refresh({ render: false });
        rerenderSettings(snapshot);
      } catch (error) { app.toast(`模型测试失败：${error.message}`); }
      finally { button.disabled = false; button.textContent = "测试"; }
    }));
    document.querySelectorAll("[data-model-role]").forEach((select) => select.addEventListener("change", async () => {
      const role = select.getAttribute("data-model-role");
      const snapshot = captureSettingsPosition(`binding:${role}`);
      try {
        await setModelBinding(role, select.value || "__unset__");
        await refresh({ render: false });
        rerenderSettings(snapshot);
        app.toast("功能模型已更新");
      } catch (error) {
        app.toast(`更新失败：${error.message}`);
        await refresh({ render: false });
        rerenderSettings(snapshot);
      }
    }));
    document.getElementById("realSaveAiBtn")?.addEventListener("click", async () => {
      const editor = document.querySelector(".model-editor");
      const targetKey = editor?.dataset.editingNew === "true"
        ? "new-model"
        : `profile:${editor?.dataset.editingId || ""}`;
      const snapshot = captureSettingsPosition(targetKey);
      const button = document.getElementById("realSaveAiBtn"); if (button) { button.disabled = true; button.textContent = "正在加密…"; }
      try {
        const saved = await configureModelProfile(aiFormValues());
        state.editingModelId = "";
        state.hasKey = await hasApiKey("knowledge");
        window.dispatchEvent(new CustomEvent("biandu:config-changed"));
        await refresh({ render: false });
        rerenderSettings({
          ...snapshot,
          key: `profile:${saved.id}`,
        });
        app.toast("模型档案和密钥已加密保存在本机");
      }
      catch (error) { app.toast(`保存失败：${error.message}`); }
      finally { if (button) { button.disabled = false; button.textContent = "加密保存"; } }
    });
    document.getElementById("realTestAiBtn")?.addEventListener("click", async () => {
      const editor = document.querySelector(".model-editor");
      const targetKey = editor?.dataset.editingNew === "true"
        ? "new-model"
        : `profile:${editor?.dataset.editingId || ""}`;
      const snapshot = captureSettingsPosition(targetKey);
      const button = document.getElementById("realTestAiBtn"); if (button) { button.disabled = true; button.textContent = "真实请求中…"; }
      try {
        const saved = await configureModelProfile(aiFormValues());
        if (saved.type === "embedding") {
          const result = await testEmbeddingProfile(saved.id);
          app.toast(`向量模型连接成功：${result.model} · ${result.dimensions} 维`);
        } else {
          const response = await testConnection(saved.id);
          app.toast(`模型连接成功：${response.slice(0, 40)}`);
        }
        await markModelProfileAvailable(saved.id);
        state.editingModelId = "";
        state.hasKey = await hasApiKey("knowledge");
        window.dispatchEvent(new CustomEvent("biandu:config-changed"));
        await refresh({ render: false });
        rerenderSettings({
          ...snapshot,
          key: `profile:${saved.id}`,
        });
      } catch (error) { app.toast(`连接测试失败：${error.message}`); }
      finally { if (button) { button.disabled = false; button.textContent = "测试连接"; } }
    });
    document.getElementById("realClearAiBtn")?.addEventListener("click", async () => {
      const profileId = document.querySelector(".model-editor")?.dataset.editingId;
      if (!profileId || !window.confirm("确定清除这个模型档案在本机保存的 API Key？档案和已生成知识会保留。")) return;
      const snapshot = captureSettingsPosition(`profile:${profileId}`);
      await clearModelProfileKey(profileId);
      state.hasKey = await hasApiKey("knowledge");
      window.dispatchEvent(new CustomEvent("biandu:config-changed"));
      await refresh({ render: false });
      rerenderSettings(snapshot);
      app.toast("API Key 已删除");
    });
    document.getElementById("settingsRebuildEmbeddingsBtn")?.addEventListener("click", async () => {
      const button = document.getElementById("settingsRebuildEmbeddingsBtn");
      if (!(await hasApiKey("embedding"))) { app.toast("请先为语义向量（首选）选择并配置模型档案"); return; }
      if (button) { button.disabled = true; button.textContent = "正在建立…"; }
      try {
        const meta = await rebuildSemanticIndex(state.evidence, (progress) => { if (button) button.textContent = progress.label || "正在建立…"; });
        await refresh(); app.renderApp();
        app.toast(`语义索引完成：${meta.count} 条证据使用 ${meta.model}${meta.fallbackUsed ? "（备用模型）" : ""}`);
      } catch (error) { app.toast(`语义索引失败：${error.message}`); }
      finally { if (button) { button.disabled = false; button.textContent = "更新全部语义索引"; } }
    });
    document.getElementById("settingsProcessKnowledgeBtn")?.addEventListener("click", async () => {
      const button = document.getElementById("settingsProcessKnowledgeBtn"); if (button) { button.disabled = true; button.textContent = "正在整理…"; }
      try {
        if (!(await hasApiKey("graph"))) throw new Error("请先为知识整理选择并配置模型档案");
        await processUnverifiedBooks((progress) => { if (button) button.textContent = progress.label || "正在整理…"; });
        const wiki = await organizeKnowledgeBase({
          force: true,
          progress: (progress) => { if (button) button.textContent = progress.label || "正在整理…"; },
        });
        await refresh(); app.toast(`个人知识 Wiki 已重建：${wiki.pages || 0} 个页面，${wiki.links || 0} 条关系`);
      } catch (error) { app.toast(`知识整理失败：${error.message}`); }
      finally { if (button) { button.disabled = false; button.textContent = "整理并重建个人知识 Wiki"; } }
    });
    document.getElementById("settingsRunCleanupBtn")?.addEventListener("click", async () => {
      try {
        await window.BianDuRuntime?.flushPendingWrites?.();
        const report = await runRetentionCleanup();
        await refresh(); app.toast(`已清理 ${report.books.length} 本书的原文和 ${report.conversations.length} 段对话；永久知识仍保留`);
      } catch (error) { app.toast(`清理失败：${error.message}`); }
    });
    document.getElementById("settingsExportBackupBtn")?.addEventListener("click", async () => {
      const button = document.getElementById("settingsExportBackupBtn"); if (button) { button.disabled = true; button.textContent = "正在打包本机数据…"; }
      try {
        await window.BianDuRuntime?.flushPendingWrites?.();
        const backup = await exportBackup();
        await downloadBackup(backup);
        state.lastBackupAt = new Date().toISOString();
        saveLastBackupAt(state.lastBackupAt);
        app.renderApp();
        app.toast("完整本地备份已生成，文件不包含 API Key");
      }
      catch (error) { app.toast(`备份失败：${error.message}`); }
      finally { if (button) { button.disabled = false; button.textContent = "导出完整备份"; } }
    });
    document.getElementById("settingsImportBackupBtn")?.addEventListener("click", () => document.getElementById("settingsBackupFile")?.click());
    document.getElementById("settingsBackupFile")?.addEventListener("change", async (event) => {
      const file = event.target.files?.[0]; if (!file) return;
      if (!window.confirm("恢复会把备份中的数据合并到这台平板。是否继续？")) { event.target.value = ""; return; }
      try {
        await window.BianDuRuntime?.flushPendingWrites?.();
        const backup = JSON.parse(await file.text());
        const result = await restoreBackup(backup);
        await refresh();
        app.renderApp();
        app.toast(`备份已合并：新增 ${result.inserted} 项，更新 ${result.updated} 项，保留本机较新 ${result.keptLocal} 项；API Key 未改动`);
      } catch (error) { app.toast(`恢复失败：${error.message}`); }
      finally { event.target.value = ""; }
    });
  }

  return {
    refresh,
    renderKnowledgeBase,
    bindKnowledgeBase,
    renderKnowledgeGraph,
    bindKnowledgeGraph,
    renderDictionary,
    bindDictionary,
    renderSettings,
    bindSettings,
    submitKnowledgeQuestion,
    getMcpStatus: () => mcpHost.status(),
    callMcpTool: (name, args) => mcpHost.callTool(name, args),
    getState: () => state,
  };
}
