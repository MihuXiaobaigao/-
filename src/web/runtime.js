import { createBoardController } from "./board.js";
import { hasApiKey } from "./deepseek.js";
import { organizeKnowledgeBase } from "./knowledge-compiler.js";
import { initializeLocalEvidence, processBookKnowledge, runRetentionCleanup } from "./maintenance.js";
import { createPagesController } from "./pages.js";
import { createReaderController } from "./reader.js";
import { getAll } from "./repository.js";

const app = {
  features: () => window.BianDuFeatures,
  toast(message) {
    if (typeof window.showToast === "function") window.showToast(String(message));
    else console.info(message);
  },
  renderApp() {
    window.BianDuFeatures?.renderApp?.();
    window.setTimeout(afterRender, 0);
  },
  switchView(view, options) {
    if (typeof window.switchView === "function") window.switchView(view, options);
    else {
      const state = window.BianDuFeatures?.state;
      if (state) state.currentView = view;
      window.BianDuFeatures?.renderApp?.();
    }
    window.setTimeout(afterRender, 20);
  },
};

const pages = createPagesController(app);
const board = createBoardController(app);
const reader = createReaderController(app);
app.pages = pages;
app.board = board;
app.reader = reader;

async function flushPendingWrites() {
  const results = await Promise.allSettled([
    window.BianDuFeatures?.flushBookProgress?.(),
    board.flush(),
  ]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

let afterRenderScheduled = false;
let localDataRefreshTimer = null;
async function afterRender() {
  if (afterRenderScheduled) return;
  afterRenderScheduled = true;
  requestAnimationFrame(async () => {
    afterRenderScheduled = false;
    updateNavigation();
    try { await reader.enhance(); } catch (error) { console.warn("Reading enhancement failed", error); }
  });
}

async function updateNavigation() {
  const all = await Promise.all([
    getAll("books"), getAll("dictionary"), getAll("boards"), getAll("knowledgeNodes"),
  ]);
  const counts = [
    ["library", all[0].filter((book) => book.source === "local-pdf").length],
    ["dict", all[1].length], ["board", all[2].length], ["graph", all[3].length],
  ];
  for (const [id, count] of counts) {
    const button = document.querySelector(`[data-nav="${id}"]`);
    const badge = button?.querySelector(".badge");
    if (badge) badge.textContent = String(count);
  }
}

function installPageOverrides() {
  window.renderKnowledgeBasePage = pages.renderKnowledgeBase;
  window.bindKnowledgeBaseEvents = pages.bindKnowledgeBase;
  window.renderKnowledgeGraphPage = pages.renderKnowledgeGraph;
  window.bindKnowledgeGraphEvents = pages.bindKnowledgeGraph;
  window.renderDictionaryPage = pages.renderDictionary;
  window.bindDictionaryEvents = pages.bindDictionary;
  window.renderSettingsPage = pages.renderSettings;
  window.bindSettingsEvents = pages.bindSettings;
  window.renderBoardPage = board.render;
  window.bindBoardEvents = board.bind;
}

async function autoMaintain() {
  try {
    if (await hasApiKey("graph")) {
      const books = await getAll("books");
      const pending = books.filter((book) => book.source === "local-pdf" && !book.originalDeleted && book.pages?.length &&
        (book.knowledgeProcessing?.status !== "verified" ||
          book.visualArchive?.status !== "complete"));
      for (const book of pending) {
        try { await processBookKnowledge(book.id); }
        catch (error) { console.warn(`Knowledge processing failed for ${book.title}`, error); }
      }
      const wiki = await organizeKnowledgeBase();
      if (pending.length || wiki.processed) await pages.refresh();
    }
  } catch (error) { console.warn("Automatic knowledge processing failed", error); }
  try { await runRetentionCleanup(); } catch (error) { console.warn("Retention cleanup failed", error); }
}

function scheduleLocalDataRefresh() {
  window.clearTimeout(localDataRefreshTimer);
  localDataRefreshTimer = window.setTimeout(async () => {
    try {
      await initializeLocalEvidence();
      await pages.refresh();
      await updateNavigation();
    } catch (error) {
      console.warn("Local knowledge index refresh failed", error);
    }
  }, 220);
}

async function boot() {
  installPageOverrides();
  reader.bind();
  board.bind();
  window.BianDuFeatures?.renderApp?.();
  afterRender();
  try { await initializeLocalEvidence(); } catch (error) { console.warn("Local evidence initialization failed", error); }
  try { await pages.refresh(); } catch (error) { console.warn("Page data refresh failed", error); }
  try { await board.refresh(); } catch (error) { console.warn("Board data refresh failed", error); }
  await updateNavigation();
  window.addEventListener("biandu:local-data-changed", scheduleLocalDataRefresh);
  window.addEventListener("biandu:config-changed", () => updateNavigation());
  window.setTimeout(autoMaintain, 2500);
  window.setInterval(autoMaintain, 6 * 60 * 60 * 1000);
  const main = document.getElementById("mainContent");
  if (main) new MutationObserver(() => afterRender()).observe(main, { childList: true, subtree: false });
}

window.BianDuRuntime = { app, pages, board, reader, afterRender, autoMaintain, flushPendingWrites };

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => window.setTimeout(boot, 0), { once: true });
} else {
  window.setTimeout(boot, 0);
}
