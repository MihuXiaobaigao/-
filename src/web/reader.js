import { chat, hasApiKey, translateTextsWithSpecializedModel } from "./deepseek.js";
import {
  enrichDictionaryWord, indexBookLocal, prepareBookForReading, translateBook,
} from "./knowledge-engine.js";
import { buildImageSelectionMessages, buildSelectionMessages, buildTranslationMessages } from "./prompts.js";
import { createId, deleteMany, getAll, getRecord, normalizeWord, putRecord, saveEvidence, upsertKnowledgeNode } from "./repository.js";
import { recognizeScannedPage } from "./vision.js";

function esc(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function createReaderController(app) {
  const state = {
    selectionConversation: null, selectionBusy: false,
    translationBusy: false, translationMode: "sentence", translations: [],
    translationsOn: false,
    translationAbortController: null,
    translationCancelRequested: false,
    translationSavedPages: new Set(), translationInFlightPage: 0,
    dictionary: [], enrichedWord: "", lastEnhancedKey: "", ocrBusy: false,
    inlineTranslation: null, inlineTranslationBusy: false,
    inlineNoteQuote: "", inlineBoard: null,
    pdfTool: "pen", pdfDrawing: null, pdfLastPenActivityAt: 0,
    pdfLastInkTool: "pen",
  };
  let readerLoadingRemoveTimer = null;
  let readerActionTipTimer = null;
  let readerActionTipPointer = null;

  function hideReaderActionTip() {
    document.getElementById("readerActionTip")?.remove();
  }

  function showReaderActionTip(button) {
    hideReaderActionTip();
    const title = button.getAttribute("data-reader-tooltip-title") || button.getAttribute("aria-label") || "";
    const detail = button.getAttribute("data-reader-tooltip-detail") || "";
    if (!title) return;
    const rect = button.getBoundingClientRect();
    const tip = document.createElement("div");
    tip.id = "readerActionTip";
    tip.className = "reader-action-tip";
    tip.innerHTML = `<strong>${esc(title)}</strong>${detail ? `<span>${esc(detail)}</span>` : ""}`;
    document.body.appendChild(tip);
    const width = Math.min(260, window.innerWidth - 24);
    tip.style.width = `${width}px`;
    tip.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2))}px`;
    tip.style.top = `${Math.min(window.innerHeight - 80, rect.bottom + 8)}px`;
    fs().state.__readerSuppressActionClickUntil = performance.now() + 900;
    window.clearTimeout(readerActionTipTimer);
    readerActionTipTimer = window.setTimeout(hideReaderActionTip, 1800);
  }

  function fs() { return app.features(); }
  function currentBook() { return fs()?.currentImportedBook?.(); }

  function splitSentences(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?。！？；;])\s+/u)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function blocksFromText(text) {
    return String(text || "")
      .split(/\n{2,}/)
      .map((block) => block.replace(/\n+/g, " ").trim())
      .filter(Boolean)
      .map((value, index) => ({ type: "paragraph", text: value, index }));
  }

  function blocksFromRecognition(result) {
    const blocks = Array.isArray(result?.blocks) ? result.blocks : [];
    const normalized = blocks
      .map((block, index) => ({
        ...block,
        index,
        text: String(block?.text || "").trim(),
      }))
      .filter((block) => block.text);
    return normalized.length ? normalized : blocksFromText(result?.text);
  }

  function markWords(value) {
    const parts = String(value).split(
      /([\p{Script=Latin}]+(?:[’'][\p{Script=Latin}]+)*(?:-[\p{Script=Latin}]+)*)/gu
    );
    return parts
      .map((part, index) => {
        if (index % 2 === 1 && Array.from(part).length > 1) {
          return `<span class="word-token" data-word="${esc(part)}">${esc(part)}</span>`;
        }
        return esc(part);
      })
      .join("");
  }

  function sameSentence(left, right) {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
    return normalize(left) === normalize(right);
  }

  function isForeignLanguageBook(book) {
    const text = (book?.pages || []).slice(0, 3)
      .map((page) => page.text || "")
      .join(" ")
      .slice(0, 12000);
    const letters = (text.match(/\p{Letter}/gu) || []).length;
    if (letters < 80) return false;
    const han = (text.match(/\p{Script=Han}/gu) || []).length;
    return han / letters < 0.35;
  }

  async function loadDictionary() {
    state.dictionary = await getAll("dictionary");
  }

  function textPages(book) {
    return (book?.pages || []).filter((page) => String(page?.text || "").trim());
  }

  async function loadSavedTranslations(book) {
    return (await getAll("translations"))
      .filter((item) => item.bookId === book.id && item.textVersion === 2)
      .sort((a, b) => a.page - b.page || a.paragraphIndex - b.paragraphIndex ||
        Number(a.segmentIndex) - Number(b.segmentIndex));
  }

  function translationPages(records) {
    return new Set(records.map((item) => Number(item.page)).filter(Number.isFinite));
  }

  function translationIsComplete(book, records = state.translations) {
    const pages = textPages(book);
    const translated = translationPages(records);
    return pages.length > 0 && pages.every((page) => translated.has(Number(page.number)));
  }

  function translationActionState(book = currentBook()) {
    if (!book) return { label: "全文翻译", disabled: true };
    if (state.translationBusy) return { label: "取消翻译", disabled: false };
    const savedPages = translationPages(state.translations);
    const complete = translationIsComplete(book);
    if (savedPages.size) {
      if (state.translationsOn) return { label: "只显示原文", disabled: false };
      return { label: complete ? "显示译文" : "继续翻译", disabled: false };
    }
    return { label: "全文翻译", disabled: false };
  }

  function syncReaderActions(book = currentBook()) {
    if (!book) return;
    const action = translationActionState(book);
    const fsState = fs()?.state || {};
    fsState.readerTranslationAction = action;
    fsState.readerTranslationsOn = state.translationsOn;
    const button = document.getElementById("readerFullTranslationBtn");
    if (button) {
      button.disabled = action.disabled;
      button.classList.toggle("is-busy", state.translationBusy);
      button.classList.toggle("is-active", state.translationsOn && !state.translationBusy);
      button.setAttribute("aria-label", action.label);
      button.setAttribute("title", action.label);
      button.setAttribute("data-reader-tooltip-title", action.label);
    }
    const viewButton = document.getElementById("readerViewModeBtn");
    if (viewButton && fsState.readerViewMode === "original") {
      viewButton.setAttribute("aria-label", "文字阅读");
      viewButton.setAttribute("title", "文字阅读");
      viewButton.setAttribute("data-reader-tooltip-title", "文字阅读");
    }
    const selectionKind = fsState.readerSelectionKind;
    const translate = document.getElementById("readerTranslateSelectionBtn");
    const dictionary = document.getElementById("readerAddDictionaryBtn");
    const note = document.getElementById("readerSentenceNoteBtn");
    if (translate) {
      translate.setAttribute("aria-disabled", String(!(selectionKind === "word" || selectionKind === "sentence")));
      translate.classList.toggle("is-unavailable", !(selectionKind === "word" || selectionKind === "sentence"));
    }
    if (dictionary) {
      dictionary.setAttribute("aria-disabled", String(selectionKind !== "word"));
      dictionary.classList.toggle("is-unavailable", selectionKind !== "word");
    }
    if (note) {
      note.setAttribute("aria-disabled", String(selectionKind !== "sentence"));
      note.classList.toggle("is-unavailable", selectionKind !== "sentence");
    }
  }

  function clearInlineResult() {
    document.getElementById("readerInlineTranslation")?.remove();
    document.getElementById("readerInlineNoteEditor")?.remove();
    document.getElementById("readerInlineBoard")?.remove();
    state.inlineTranslation = null;
    state.inlineNoteQuote = "";
    state.inlineBoard = null;
  }

  function inlineResultMarkup() {
    const result = state.inlineTranslation;
    if (!result) return "";
    if (state.inlineTranslationBusy) {
      return `<div class="reader-inline-loading"><span></span><p>${result.kind === "word" ? "正在查询并加入词典" : "正在翻译这个句子"}</p></div>`;
    }
    if (result.error) return `<p class="reader-inline-error">${esc(result.error)}</p>`;
    if (result.kind === "word") {
      return `<div class="reader-inline-head"><strong>${esc(result.word)}</strong><span>${esc(result.phonetic || "")}${result.partOfSpeech ? ` · ${esc(result.partOfSpeech)}` : ""}</span></div><p class="reader-inline-definition">${esc(result.definitionZh || "")}</p>${result.context ? `<p class="reader-inline-context">${esc(result.context)}</p>` : ""}`;
    }
    return `<p class="reader-inline-original">${esc(result.original)}</p><p class="reader-inline-sentence">${esc(result.translation)}</p>`;
  }

  function positionInlineResult(rect, elementId = "readerInlineTranslation", options = {}) {
    const card = document.getElementById(elementId);
    if (!card) return;
    const width = Math.min(Number(options.width) || 420, window.innerWidth - 24);
    card.style.width = `${width}px`;
    const anchor = rect || {
      left: window.innerWidth / 2 - width / 2,
      top: 120,
      bottom: 140,
      width,
      height: 20,
    };
    const anchoredLeft = Math.max(12, Math.min(
      window.innerWidth - width - 12,
      anchor.left + Math.max(0, anchor.width / 2 - width / 2)
    ));
    const estimatedHeight = Number(options.height) || 156;
    const estimatedTop = anchor.top - estimatedHeight - 14 >= 12
      ? anchor.top - estimatedHeight - 14
      : Math.min(window.innerHeight - estimatedHeight - 12, anchor.bottom + 12);
    card.style.left = `${anchoredLeft}px`;
    card.style.top = `${Math.max(12, estimatedTop)}px`;
    const preferredTop = anchor.top - 14;
    requestAnimationFrame(() => {
      const height = card.getBoundingClientRect().height || 150;
      const left = anchoredLeft;
      const top = preferredTop - height >= 12 ? preferredTop - height : Math.min(window.innerHeight - height - 12, anchor.bottom + 12);
      card.style.left = `${left}px`;
      card.style.top = `${Math.max(12, top)}px`;
    });
  }

  function showInlineResult(payload) {
    clearInlineResult();
    state.inlineTranslation = payload;
    const card = document.createElement("section");
    card.id = "readerInlineTranslation";
    card.className = "reader-inline-translation";
    card.setAttribute("role", "status");
    card.innerHTML = inlineResultMarkup();
    document.body.appendChild(card);
    const selection = window.getSelection();
    const rangeRect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
    positionInlineResult(rangeRect?.width ? rangeRect : fs()?.state?.readerSelectionRect);
  }

  function refreshInlineResult() {
    const card = document.getElementById("readerInlineTranslation");
    if (!card) return;
    card.innerHTML = inlineResultMarkup();
    positionInlineResult(fs()?.state?.readerSelectionRect);
  }

  async function ensureSelectedWordInDictionary() {
    const word = String(fs()?.state?.activePopupWord || fs()?.state?.readerSelectionText || "").trim();
    if (!word || fs()?.state?.readerSelectionKind !== "word") {
      throw new Error("请只选中一个英文单词。");
    }
    if (!(await hasApiKey("dictionary"))) throw new Error("请先配置语境词典模型。");
    const book = currentBook();
    const lemma = normalizeWord(word);
    const existing = await getRecord("dictionary", lemma);
    const page = Number(fs()?.state?.__activeWordPage) || Number(book?.page) || 1;
    const sentence = fs()?.currentPageSentence?.(word, page) || word;
    const now = new Date().toISOString();
    const occurrence = {
      id: createId("occ"),
      bookId: book?.id || "",
      bookTitle: book?.title || "本地书籍",
      page,
      sentence,
      markedAt: now,
    };
    const draft = existing ? {
      ...existing,
      count: Number(existing.count || 0) + 1,
      occurrences: [...(existing.occurrences || []), occurrence],
      lastMarkedAt: now,
    } : {
      lemma,
      displayForm: word,
      definitionZh: "",
      partOfSpeech: "",
      phonetic: "",
      count: 1,
      occurrences: [occurrence],
      firstMarkedAt: now,
      lastMarkedAt: now,
    };
    const complete = Boolean(existing?.definitionZh && existing?.partOfSpeech);

    // Marking a word is a local-first action. Persist it before the optional
    // dictionary model runs so a timeout or provider error can never lose the
    // word that the reader has already selected.
    const savedDraft = complete ? await putRecord("dictionary", draft) : draft;
    if (!complete) await putRecord("dictionary", savedDraft);
    state.dictionary = [
      ...state.dictionary.filter((item) => item.lemma !== savedDraft.lemma),
      savedDraft,
    ];
    window.dispatchEvent(new CustomEvent("biandu:local-data-changed", {
      detail: { kind: "dictionary", id: savedDraft.lemma },
    }));

    if (complete) return savedDraft;
    const enriched = await enrichDictionaryWord(savedDraft);
    state.dictionary = [
      ...state.dictionary.filter((item) => item.lemma !== enriched.lemma),
      enriched,
    ];
    window.dispatchEvent(new CustomEvent("biandu:local-data-changed", {
      detail: { kind: "dictionary", id: enriched.lemma },
    }));
    return enriched;
  }

  async function translateSelectedSentence() {
    const text = String(fs()?.state?.readerSelectionText || "").trim();
    if (!text || fs()?.state?.readerSelectionKind !== "sentence") {
      throw new Error("请选中一个英文句子。");
    }
    if (!(await hasApiKey("translation"))) throw new Error("请先配置外文翻译模型。");
    const specialized = await translateTextsWithSpecializedModel([text]);
    if (specialized?.[0]) return stripText(specialized[0]);
    const result = await chat(buildTranslationMessages([text]), {
      task: "translation",
      json: true,
      temperature: 0.1,
    });
    const segment = Array.isArray(result?.segments)
      ? result.segments.find((item) => Number(item?.index) === 1)
      : null;
    const translation = stripText(segment?.translation);
    if (!translation) throw new Error("翻译没有返回有效结果。");
    return translation;
  }

  async function translateSelectionInline() {
    const fsState = fs()?.state;
    const kind = fsState?.readerSelectionKind;
    if (kind !== "word" && kind !== "sentence") return;
    const selected = String(fsState.readerSelectionText || fsState.activePopupWord || "").trim();
    if (!selected) return;
    showInlineResult(kind === "word"
      ? { kind, word: selected, selectionText: selected }
      : { kind, original: selected, selectionText: selected });
    state.inlineTranslationBusy = true;
    refreshInlineResult();
    try {
      if (kind === "word") {
        const entry = await ensureSelectedWordInDictionary();
        state.inlineTranslation = {
          kind,
          selectionText: selected,
          word: entry.displayForm || entry.lemma || selected,
          phonetic: entry.phonetic || "",
          partOfSpeech: entry.partOfSpeech || "",
          definitionZh: entry.definitionZh || "",
          context: entry.occurrences?.at(-1)?.sentence || "",
        };
      } else {
        const translation = await translateSelectedSentence();
        state.inlineTranslation = { kind, original: selected, translation, selectionText: selected };
      }
    } catch (error) {
      state.inlineTranslation = { kind, error: error.message };
    } finally {
      state.inlineTranslationBusy = false;
      refreshInlineResult();
    }
  }

  async function addSelectedDictionaryWord() {
    const word = String(fs()?.state?.activePopupWord || "").trim();
    if (!word || fs()?.state?.readerSelectionKind !== "word") return;
    showInlineResult({ kind: "word", word, selectionText: word });
    state.inlineTranslationBusy = true;
    refreshInlineResult();
    try {
      const entry = await ensureSelectedWordInDictionary();
      state.inlineTranslation = {
        kind: "word",
        selectionText: word,
        word: entry.displayForm || entry.lemma || word,
        phonetic: entry.phonetic || "",
        partOfSpeech: entry.partOfSpeech || "",
        definitionZh: entry.definitionZh || "",
        context: entry.occurrences?.at(-1)?.sentence || "",
      };
    } catch (error) {
      state.inlineTranslation = { kind: "word", error: error.message };
    } finally {
      state.inlineTranslationBusy = false;
      refreshInlineResult();
    }
  }

  function showSentenceNoteMenu() {
    if (fs()?.state?.readerSelectionKind !== "sentence") return;
    document.getElementById("readerNoteChoice")?.remove();
    const selected = String(fs()?.state?.readerSelectionText || "").trim();
    if (!selected) return;
    const card = document.createElement("section");
    card.id = "readerNoteChoice";
    card.className = "reader-inline-translation reader-note-choice";
    card.innerHTML = `<p class="reader-inline-original">${esc(selected)}</p><div class="reader-note-choice-actions"><button type="button" class="btn btn-sm btn-primary" data-reader-note-choice="text">文字笔记</button><button type="button" class="btn btn-sm" data-reader-note-choice="board">画板</button></div>`;
    document.body.appendChild(card);
    positionInlineResult(fs()?.state?.readerSelectionRect, "readerNoteChoice");
  }

  function showInlineTextNote(quote = "") {
    const selected = String(quote || fs()?.state?.readerSelectionText || "").trim();
    clearInlineResult();
    state.inlineNoteQuote = selected;
    const card = document.createElement("section");
    card.id = "readerInlineNoteEditor";
    card.className = "reader-inline-translation reader-inline-note-editor";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "添加文字笔记");
    card.innerHTML = `
      <div class="reader-inline-composer-head">
        <div><strong>文字笔记</strong><span>只在当前平板保存</span></div>
        <button class="reader-inline-close" type="button" data-inline-close="note" aria-label="关闭">×</button>
      </div>
      ${selected ? `<blockquote class="reader-inline-quote">${esc(selected.slice(0, 360))}</blockquote>` : ""}
      <textarea id="readerInlineNoteText" rows="5" placeholder="写下你的理解、疑问或联想…"></textarea>
      <div class="reader-inline-composer-actions">
        <button class="btn btn-sm" type="button" data-inline-close="note">取消</button>
        <button class="btn btn-sm btn-primary" id="readerInlineNoteSave" type="button">保存笔记</button>
      </div>`;
    document.body.appendChild(card);
    positionInlineResult(fs()?.state?.readerSelectionRect, "readerInlineNoteEditor", {
      width: 560,
      height: 310,
    });

    card.querySelectorAll("[data-inline-close]").forEach((button) => {
      button.addEventListener("click", () => clearInlineResult());
    });
    const save = async () => {
      const textarea = document.getElementById("readerInlineNoteText");
      const text = String(textarea?.value || "").trim();
      if (!text) {
        textarea?.focus();
        app.toast("请先写下笔记内容");
        return;
      }
      const button = document.getElementById("readerInlineNoteSave");
      if (button?.disabled) return;
      if (button) {
        button.disabled = true;
        button.textContent = "保存中…";
      }
      try {
        const saved = await fs()?.saveInlineReaderNote?.(text, state.inlineNoteQuote || selected);
        if (saved) {
          clearInlineResult();
          app.toast("文字笔记已保存到本机");
        }
      } finally {
        const current = document.getElementById("readerInlineNoteSave");
        if (current) {
          current.disabled = false;
          current.textContent = "保存笔记";
        }
      }
    };
    document.getElementById("readerInlineNoteSave")?.addEventListener("click", save);
    document.getElementById("readerInlineNoteText")?.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        save();
      }
    });
    requestAnimationFrame(() => document.getElementById("readerInlineNoteText")?.focus());
  }

  function inlineBoardPoint(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))),
      pressure: event.pointerType === "pen"
        ? Math.max(0.08, Math.min(1, Number(event.pressure) || 0.5))
        : 0.5,
      tiltX: Number(event.tiltX) || 0,
      tiltY: Number(event.tiltY) || 0,
      twist: Number(event.twist) || 0,
      altitudeAngle: Number(event.altitudeAngle) || 0,
      azimuthAngle: Number(event.azimuthAngle) || 0,
      timeStamp: Number(event.timeStamp) || performance.now(),
      pointerType: event.pointerType || "mouse",
    };
  }

  function redrawInlineBoard() {
    const drawing = state.inlineBoard;
    const canvas = document.getElementById("readerInlineBoardCanvas");
    if (!drawing || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const stroke of drawing.strokes) {
      const points = stroke.points || [];
      if (!points.length) continue;
      context.globalAlpha = Number(stroke.opacity ?? 1);
      context.strokeStyle = stroke.color || "#1F4037";
      context.fillStyle = stroke.color || "#1F4037";
      const baseWidth = Number(stroke.width) || 3;
      if (points.length === 1) {
        context.beginPath();
        context.arc(points[0].x * width, points[0].y * height, baseWidth / 2, 0, Math.PI * 2);
        context.fill();
        continue;
      }
      for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const point = points[index];
        const pressure = (Number(previous.pressure) + Number(point.pressure)) / 2;
        context.lineWidth = Math.max(0.7, baseWidth * (0.55 + pressure * 0.8));
        context.beginPath();
        context.moveTo(previous.x * width, previous.y * height);
        context.lineTo(point.x * width, point.y * height);
        context.stroke();
      }
    }
    context.globalAlpha = 1;
  }

  function eraseInlineBoardAt(point) {
    const drawing = state.inlineBoard;
    if (!drawing) return;
    const radius = 0.026;
    for (let index = drawing.strokes.length - 1; index >= 0; index -= 1) {
      const stroke = drawing.strokes[index];
      if ((stroke.points || []).some((candidate) =>
        Math.hypot(candidate.x - point.x, candidate.y - point.y) <= radius
      )) {
        drawing.strokes.splice(index, 1);
      }
    }
    redrawInlineBoard();
  }

  function inlineBoardIcon(name) {
    const common = 'width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
    if (name === "pen") return `<svg ${common}><path d="M5 19l3.2-.7L19 7.5a2.1 2.1 0 0 0-3-3L5.7 15.8 5 19z"/><path d="M14.8 5.8l3.4 3.4"/></svg>`;
    if (name === "highlighter") return `<svg ${common}><path d="M15.2 3.8l5 5-8.4 8.4H6.4v-5.4z"/><path d="M4 21h9"/><path d="M14.5 5.5l4 4"/></svg>`;
    if (name === "eraser") return `<svg ${common}><path d="M18.8 20H8l-4.2-4.2a1.8 1.8 0 0 1 0-2.6l8.3-8.3a1.8 1.8 0 0 1 2.6 0l4.7 4.7a1.8 1.8 0 0 1 0 2.6L13 18.8"/><path d="M10.3 7.5l7 7"/></svg>`;
    if (name === "undo") return `<svg ${common}><path d="M8.5 8H5v-3.5"/><path d="M5.7 8.2A7.5 7.5 0 1 1 5 15"/></svg>`;
    return "";
  }

  function showInlineBoard(quote = "") {
    const book = currentBook();
    if (!book) return;
    const selected = String(quote || fs()?.state?.readerSelectionText || "").trim();
    clearInlineResult();
    state.inlineBoard = {
      quote: selected,
      page: Number(book.page) || 1,
      tool: "pen",
      color: "#1F4037",
      width: 3,
      strokes: [],
      undo: [],
      drawing: null,
      penPointerId: null,
      lastPenActivityAt: 0,
      lastInkTool: "pen",
      barrelGesture: null,
    };
    const card = document.createElement("section");
    card.id = "readerInlineBoard";
    card.className = "reader-inline-translation reader-inline-board-editor";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "画板笔记");
    const colorButtons = [
      ["#1F4037", "墨绿"], ["#C2654A", "赭红"], ["#B68B3A", "金色"],
      ["#4E768B", "蓝灰"], ["#252B28", "墨黑"],
    ].map(([color, label], index) =>
      `<button type="button" class="reader-inline-color ${index === 0 ? "is-active" : ""}" data-inline-board-color="${color}" style="--swatch:${color}" aria-label="${label}"></button>`
    ).join("");
    card.innerHTML = `
      <div class="reader-inline-composer-head">
        <div><strong>画板笔记</strong><span>第 ${Number(book.page) || 1} 页 · 不会离开阅读页</span></div>
        <button class="reader-inline-close" type="button" data-inline-close="board" aria-label="关闭">×</button>
      </div>
      ${selected ? `<blockquote class="reader-inline-quote">${esc(selected.slice(0, 180))}</blockquote>` : ""}
      <div class="reader-inline-board-surface">
        <canvas id="readerInlineBoardCanvas" aria-label="内嵌画板"></canvas>
        <div class="reader-inline-board-rail" role="toolbar" aria-label="画板工具">
          <button type="button" class="is-active" data-inline-board-tool="pen" aria-label="钢笔">${inlineBoardIcon("pen")}</button>
          <button type="button" data-inline-board-tool="highlighter" aria-label="荧光笔">${inlineBoardIcon("highlighter")}</button>
          <button type="button" data-inline-board-tool="eraser" aria-label="橡皮">${inlineBoardIcon("eraser")}</button>
          <span></span>
          <button type="button" data-inline-board-undo aria-label="撤销">${inlineBoardIcon("undo")}</button>
        </div>
      </div>
      <div class="reader-inline-board-controls">
        <div class="reader-inline-colors">${colorButtons}</div>
        <label>笔宽 <input id="readerInlineBoardWidth" type="range" min="1" max="12" value="3" /></label>
        <div class="reader-inline-composer-actions">
          <button class="btn btn-sm" type="button" data-inline-close="board">取消</button>
          <button class="btn btn-sm btn-primary" id="readerInlineBoardSave" type="button">保存画板</button>
        </div>
      </div>`;
    document.body.appendChild(card);
    positionInlineResult(fs()?.state?.readerSelectionRect, "readerInlineBoard", {
      width: 760,
      height: 430,
    });

    card.querySelectorAll("[data-inline-close]").forEach((button) => {
      button.addEventListener("click", () => clearInlineResult());
    });
    card.querySelectorAll("[data-inline-board-tool]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!state.inlineBoard) return;
        state.inlineBoard.tool = button.getAttribute("data-inline-board-tool");
        card.querySelectorAll("[data-inline-board-tool]").forEach((item) =>
          item.classList.toggle("is-active", item === button)
        );
      });
    });
    card.querySelectorAll("[data-inline-board-color]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!state.inlineBoard) return;
        state.inlineBoard.color = button.getAttribute("data-inline-board-color");
        card.querySelectorAll("[data-inline-board-color]").forEach((item) =>
          item.classList.toggle("is-active", item === button)
        );
      });
    });
    document.getElementById("readerInlineBoardWidth")?.addEventListener("input", (event) => {
      if (state.inlineBoard) state.inlineBoard.width = Number(event.target.value) || 3;
    });
    card.querySelector("[data-inline-board-undo]")?.addEventListener("click", () => {
      if (!state.inlineBoard?.undo.length) return;
      state.inlineBoard.strokes = JSON.parse(state.inlineBoard.undo.pop());
      redrawInlineBoard();
    });

    const canvas = document.getElementById("readerInlineBoardCanvas");
    if (canvas) {
      canvas.addEventListener("pointerdown", (event) => {
        const drawing = state.inlineBoard;
        if (!drawing) return;
        const now = performance.now();
        if (event.pointerType === "touch" &&
            (drawing.penPointerId !== null ||
              now - Number(drawing.lastPenActivityAt || 0) < 220 ||
              Math.max(Number(event.width) || 0, Number(event.height) || 0) >= 32)) {
          event.preventDefault();
          return;
        }
        if (event.pointerType === "pen") {
          drawing.lastPenActivityAt = now;
          if (drawing.penPointerId !== null && drawing.penPointerId !== event.pointerId) return;
          drawing.penPointerId = event.pointerId;
        }
        if (drawing.drawing && drawing.drawing.pointerId !== event.pointerId) return;
        event.preventDefault();
        drawing.undo.push(JSON.stringify(drawing.strokes));
        if (drawing.undo.length > 30) drawing.undo.shift();
        const point = inlineBoardPoint(event, canvas);
        const hardwareEraser = event.pointerType === "pen" &&
          (event.button === 5 || (event.buttons & 32) === 32);
        const barrelEraser = event.pointerType === "pen" &&
          (event.button === 2 || (event.buttons & 2) === 2);
        if (drawing.tool === "eraser" || hardwareEraser || barrelEraser) {
          if (barrelEraser) {
            drawing.barrelGesture = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              moved: false,
              returnTool: drawing.tool,
            };
            if (drawing.tool !== "eraser") drawing.lastInkTool = drawing.tool;
            drawing.tool = "eraser";
            card.querySelectorAll("[data-inline-board-tool]").forEach((item) =>
              item.classList.toggle("is-active", item.getAttribute("data-inline-board-tool") === "eraser")
            );
          }
          drawing.drawing = { pointerId: event.pointerId, eraser: true };
          eraseInlineBoardAt(point);
          try { canvas.setPointerCapture(event.pointerId); } catch { /* Synthetic pointers may not capture. */ }
          return;
        }
        const highlighter = drawing.tool === "highlighter";
        const stroke = {
          id: createId("stroke"),
          type: "stroke",
          tool: drawing.tool,
          color: drawing.color,
          width: highlighter ? Math.max(10, drawing.width * 3) : drawing.width,
          opacity: highlighter ? 0.28 : 1,
          points: [point],
          pointerType: event.pointerType || "touch",
        };
        drawing.strokes.push(stroke);
        drawing.drawing = { pointerId: event.pointerId, stroke };
        try { canvas.setPointerCapture(event.pointerId); } catch { /* Synthetic pointers may not capture. */ }
        redrawInlineBoard();
      });
      canvas.addEventListener("pointermove", (event) => {
        const drawing = state.inlineBoard;
        if (!drawing?.drawing || drawing.drawing.pointerId !== event.pointerId) return;
        if (event.pointerType === "pen") drawing.lastPenActivityAt = performance.now();
        if (drawing.drawing.eraser) {
          if (drawing.barrelGesture?.pointerId === event.pointerId &&
              Math.hypot(event.clientX - drawing.barrelGesture.startX,
                event.clientY - drawing.barrelGesture.startY) > 7) {
            drawing.barrelGesture.moved = true;
          }
          for (const sample of coalescedPointerSamples(event)) eraseInlineBoardAt(inlineBoardPoint(sample, canvas));
          return;
        }
        const points = drawing.drawing.stroke.points;
        for (const sample of coalescedPointerSamples(event)) {
          const point = inlineBoardPoint(sample, canvas);
          const previous = points.at(-1);
          if (previous && point.timeStamp < previous.timeStamp - 0.01) continue;
          if (previous && Math.hypot(previous.x - point.x, previous.y - point.y) < 0.0015 &&
              Math.abs(previous.pressure - point.pressure) < 0.01) continue;
          points.push(point);
        }
        redrawInlineBoard();
      });
      const finish = (event) => {
        const drawing = state.inlineBoard;
        if (!drawing?.drawing || drawing.drawing.pointerId !== event.pointerId) return;
        if (event.pointerType === "pen") {
          drawing.lastPenActivityAt = performance.now();
          if (drawing.penPointerId === event.pointerId) drawing.penPointerId = null;
        }
        if (drawing.barrelGesture?.pointerId === event.pointerId) {
          const gesture = drawing.barrelGesture;
          drawing.barrelGesture = null;
          drawing.tool = event.type === "pointercancel"
            ? gesture.returnTool
            : gesture.returnTool === "eraser"
              ? (drawing.lastInkTool || "pen")
              : gesture.moved ? gesture.returnTool : "eraser";
          if (drawing.tool !== "eraser") drawing.lastInkTool = drawing.tool;
          card.querySelectorAll("[data-inline-board-tool]").forEach((item) =>
            item.classList.toggle("is-active", item.getAttribute("data-inline-board-tool") === drawing.tool)
          );
        }
        drawing.drawing = null;
        redrawInlineBoard();
      };
      canvas.addEventListener("pointerup", finish);
      canvas.addEventListener("pointercancel", finish);
      canvas.addEventListener("pointerrawupdate", (event) => {
        const drawing = state.inlineBoard;
        if (event.pointerType !== "pen" || !drawing?.drawing ||
            drawing.drawing.pointerId !== event.pointerId || drawing.drawing.eraser) return;
        event.preventDefault();
        drawing.lastPenActivityAt = performance.now();
        const points = drawing.drawing.stroke.points;
        for (const sample of coalescedPointerSamples(event)) {
          const point = inlineBoardPoint(sample, canvas);
          const previous = points.at(-1);
          if (previous && point.timeStamp < previous.timeStamp - 0.01) continue;
          if (previous && Math.hypot(previous.x - point.x, previous.y - point.y) < 0.0015 &&
              Math.abs(previous.pressure - point.pressure) < 0.01) continue;
          points.push(point);
        }
        redrawInlineBoard();
      });
      requestAnimationFrame(redrawInlineBoard);
    }

    document.getElementById("readerInlineBoardSave")?.addEventListener("click", async () => {
      const drawing = state.inlineBoard;
      if (!drawing) return;
      if (!drawing.strokes.length) {
        app.toast("请先在画板上写点内容");
        return;
      }
      const button = document.getElementById("readerInlineBoardSave");
      if (button?.disabled) return;
      if (button) {
        button.disabled = true;
        button.textContent = "保存中…";
      }
      try {
        const title = drawing.quote
          ? `第 ${drawing.page} 页选段画板 · ${drawing.quote.slice(0, 18)}`
          : `第 ${drawing.page} 页画板`;
        await app.board.createBoard({
          bookId: book.id,
          page: drawing.page,
          quote: drawing.quote,
          title,
          elements: drawing.strokes,
        }, { navigate: false });
        clearInlineResult();
        window.dispatchEvent(new CustomEvent("biandu:local-data-changed", {
          detail: { kind: "board", id: book.id },
        }));
        app.toast("画板笔记已保存，可稍后在画板页继续编辑");
      } catch (error) {
        app.toast(`画板保存失败：${error.message}`);
      } finally {
        const current = document.getElementById("readerInlineBoardSave");
        if (current) {
          current.disabled = false;
          current.textContent = "保存画板";
        }
      }
    });
  }

  function pageInkStrokes(book, pageNumber) {
    book.pdfInkAnnotations ||= {};
    const key = String(pageNumber);
    if (!Array.isArray(book.pdfInkAnnotations[key])) book.pdfInkAnnotations[key] = [];
    return book.pdfInkAnnotations[key];
  }

  function drawInkStroke(context, stroke, width, height) {
    const points = stroke.points || [];
    if (!points.length) return;
    context.save();
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    context.globalAlpha = stroke.opacity ?? 1;
    context.lineCap = "round";
    context.lineJoin = "round";
    const baseWidth = Math.max(1, Number(stroke.width || 2));
    if (points.length === 1) {
      const pressure = Math.max(0.05, Math.min(1, Number(points[0].pressure) || 0.5));
      context.lineWidth = Math.max(1, baseWidth * (0.5 + pressure * 0.9));
      context.beginPath();
      context.arc(points[0].x * width, points[0].y * height, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const point = points[index];
        const pressure = (Number(previous.pressure || 0.5) + Number(point.pressure || 0.5)) / 2;
        context.lineWidth = Math.max(1, baseWidth * (0.5 + pressure * 0.9));
        context.beginPath();
        context.moveTo(previous.x * width, previous.y * height);
        context.lineTo(point.x * width, point.y * height);
        context.stroke();
      }
    }
    context.restore();
  }

  function redrawPdfInk() {
    const book = currentBook();
    const page = fs()?.state?.readerPage;
    const canvas = document.getElementById("readerInkCanvas");
    const pdfCanvas = document.getElementById("pdfFallbackCanvas");
    if (!book || !canvas || !pdfCanvas || !pdfCanvas.dataset.rendered) return;
    const width = Math.max(1, pdfCanvas.clientWidth);
    const height = Math.max(1, pdfCanvas.clientHeight);
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    for (const stroke of pageInkStrokes(book, page)) drawInkStroke(context, stroke, width, height);
  }

  function inkPoint(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))),
      pressure: event.pointerType === "pen" ? Math.max(0.1, Math.min(1, Number(event.pressure) || 0.5)) : 0.5,
      tiltX: Number(event.tiltX) || 0,
      tiltY: Number(event.tiltY) || 0,
      twist: Number(event.twist) || 0,
      altitudeAngle: Number(event.altitudeAngle) || 0,
      azimuthAngle: Number(event.azimuthAngle) || 0,
      timeStamp: Number(event.timeStamp) || performance.now(),
      pointerType: event.pointerType || "mouse",
    };
  }

  function coalescedPointerSamples(event) {
    let samples = [];
    try { samples = Array.from(event.getCoalescedEvents?.() || []); } catch { samples = []; }
    if (!samples.some((sample) => sample.timeStamp === event.timeStamp)) samples.push(event);
    return samples;
  }

  function eraseInkAt(book, page, point, canvas) {
    const strokes = pageInkStrokes(book, page);
    const rect = canvas.getBoundingClientRect();
    const tolerance = 18 / Math.max(1, Math.min(rect.width, rect.height));
    const index = strokes.findIndex((stroke) => (stroke.points || []).some((candidate) =>
      Math.hypot(candidate.x - point.x, candidate.y - point.y) <= tolerance
    ));
    if (index < 0) return false;
    strokes.splice(index, 1);
    return true;
  }

  function bindPdfInkLayer() {
    const canvas = document.getElementById("readerInkCanvas");
    if (!canvas || canvas.dataset.bound === "true") return;
    canvas.dataset.bound = "true";
    let stroke = null;
    let erased = false;
    let barrelGesture = null;
    const markPenActivity = () => {
      state.pdfLastPenActivityAt = performance.now();
    };
    const syncPdfTool = () => {
      const tool = fs()?.state?.readerPdfTool || "pen";
      const activeId = tool === "highlighter" ? "readerPdfHighlighterBtn"
        : tool === "eraser" ? "readerPdfEraserBtn" : "readerPdfPenBtn";
      ["readerPdfPenBtn", "readerPdfHighlighterBtn", "readerPdfEraserBtn"].forEach((id) => {
        document.getElementById(id)?.classList.toggle("is-active", id === activeId);
      });
    };
    const begin = (event) => {
      const book = currentBook();
      if (!book || fs()?.state?.readerViewMode !== "original") return;
      if (event.pointerType === "touch") return;
      event.preventDefault();
      if (event.pointerType === "pen") {
        markPenActivity();
        if (state.pdfDrawing && state.pdfDrawing.pointerId !== event.pointerId) return;
      }
      try { canvas.setPointerCapture?.(event.pointerId); } catch { /* Synthetic or cancelled pointers may not be capturable. */ }
      const point = inkPoint(event, canvas);
      const tool = fs()?.state?.readerPdfTool || "pen";
      const barrelButton = event.pointerType === "pen" &&
        (event.button === 2 || (event.buttons & 2) === 2);
      const hardwareEraser = event.pointerType === "pen" &&
        (event.button === 5 || (event.buttons & 32) === 32);
      if (barrelButton) {
        barrelGesture = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
          returnTool: tool,
        };
        if (tool !== "eraser") state.pdfLastInkTool = tool;
        state.pdfDrawing = { pointerId: event.pointerId, erasing: true, barrel: true };
        fs().state.readerPdfTool = "eraser";
        syncPdfTool();
        erased = eraseInkAt(book, book.page, point, canvas) || erased;
        redrawPdfInk();
        return;
      }
      if (tool === "eraser" || hardwareEraser) {
        state.pdfDrawing = { pointerId: event.pointerId, erasing: true };
        erased = eraseInkAt(book, book.page, point, canvas) || erased;
        redrawPdfInk();
        return;
      }
      stroke = {
        id: createId("pdf-ink"),
        tool,
        color: tool === "highlighter" ? "#B68B3A" : "#1F4037",
        width: tool === "highlighter" ? 14 : 2.4,
        opacity: tool === "highlighter" ? 0.28 : 0.92,
        points: [point],
        pointerType: event.pointerType || "mouse",
        createdAt: new Date().toISOString(),
      };
      state.pdfDrawing = { pointerId: event.pointerId, stroke };
      pageInkStrokes(book, book.page).push(stroke);
      redrawPdfInk();
    };
    const move = (event) => {
      if (state.pdfDrawing?.pointerId !== event.pointerId) return;
      const book = currentBook();
      if (!book) return;
      if (event.pointerType === "pen") markPenActivity();
      event.preventDefault();
      const samples = coalescedPointerSamples(event);
      if (state.pdfDrawing.erasing) {
        if (barrelGesture?.pointerId === event.pointerId &&
            Math.hypot(event.clientX - barrelGesture.startX, event.clientY - barrelGesture.startY) > 7) {
          barrelGesture.moved = true;
        }
        for (const sample of samples) {
          const point = inkPoint(sample, canvas);
          erased = eraseInkAt(book, book.page, point, canvas) || erased;
        }
        redrawPdfInk();
        return;
      }
      for (const sample of samples) {
        const point = inkPoint(sample, canvas);
        const previous = stroke?.points.at(-1);
        if (previous && point.timeStamp < previous.timeStamp - 0.01) continue;
        if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.0007 &&
            Math.abs(point.pressure - previous.pressure) < 0.01) continue;
        stroke?.points.push(point);
      }
      redrawPdfInk();
    };
    const finish = (event) => {
      if (state.pdfDrawing?.pointerId !== event.pointerId) return;
      if (event.pointerType === "pen") markPenActivity();
      const book = currentBook();
      if (barrelGesture?.pointerId === event.pointerId) {
        const gesture = barrelGesture;
        barrelGesture = null;
        const nextTool = event.type === "pointercancel"
          ? gesture.returnTool
          : gesture.returnTool === "eraser"
            ? (state.pdfLastInkTool || "pen")
            : gesture.moved ? gesture.returnTool : "eraser";
        fs().state.readerPdfTool = nextTool;
        if (nextTool !== "eraser") state.pdfLastInkTool = nextTool;
        syncPdfTool();
      }
      state.pdfDrawing = null;
      stroke = null;
      erased = false;
      if (book) fs()?.db?.putRecord?.("books", book).catch(() => {});
    };
    canvas.addEventListener("pointerdown", begin);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", finish);
    canvas.addEventListener("pointerrawupdate", (event) => {
      if (event.pointerType !== "pen") return;
      if (state.pdfDrawing?.pointerId !== event.pointerId || state.pdfDrawing.erasing) return;
      event.preventDefault();
      markPenActivity();
      const book = currentBook();
      if (!book || !stroke) return;
      for (const sample of coalescedPointerSamples(event)) {
        const point = inkPoint(sample, canvas);
        const previous = stroke.points.at(-1);
        if (previous && point.timeStamp < previous.timeStamp - 0.01) continue;
        if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.0007 &&
            Math.abs(point.pressure - previous.pressure) < 0.01) continue;
        stroke.points.push(point);
      }
      redrawPdfInk();
    });
    requestAnimationFrame(() => {
      redrawPdfInk();
      requestAnimationFrame(redrawPdfInk);
    });
    window.addEventListener("resize", redrawPdfInk, { passive: true });
  }

  function stripText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  async function enhance() {
    const book = currentBook();
    if (!book || fs()?.state?.currentView !== "reader") return;
    const key = book.id;
    if (state.lastEnhancedKey !== key) {
      state.lastEnhancedKey = key;
      state.translations = await loadSavedTranslations(book);
      state.translationSavedPages = translationPages(state.translations);
      state.translationsOn = state.translations.length > 0;
      await loadDictionary();
    }
    renderTranslations();
    highlightDictionaryWords();
    syncReaderActions(book);
    if (fs()?.state?.readerViewMode === "original") {
      const tool = fs()?.state?.readerPdfTool || "pen";
      const activeId = tool === "highlighter" ? "readerPdfHighlighterBtn" : tool === "eraser" ? "readerPdfEraserBtn" : "readerPdfPenBtn";
      ["readerPdfPenBtn", "readerPdfHighlighterBtn", "readerPdfEraserBtn"].forEach((id) => {
        document.getElementById(id)?.classList.toggle("is-active", id === activeId);
      });
      requestAnimationFrame(bindPdfInkLayer);
    }
  }

  function setReaderLoading(label = "", options = {}) {
    if (readerLoadingRemoveTimer) {
      window.clearTimeout(readerLoadingRemoveTimer);
      readerLoadingRemoveTimer = null;
    }
    let root = document.getElementById("readerLoadingOverlay");
    if (!root) {
      root = document.createElement("div");
      root.id = "readerLoadingOverlay";
      root.className = "reader-loading-overlay";
      root.innerHTML = `<div class="reader-loading-card"><span class="reader-loading-spinner" aria-hidden="true"></span><strong></strong><button class="btn btn-sm reader-loading-cancel" type="button" hidden>停止翻译</button></div>`;
      document.body.appendChild(root);
    }
    const title = root.querySelector("strong");
    if (title) title.textContent = label;
    const cancelButton = root.querySelector(".reader-loading-cancel");
    if (cancelButton) {
      cancelButton.hidden = typeof options.onCancel !== "function";
      cancelButton.textContent = options.cancelLabel || "停止翻译";
      cancelButton.onclick = typeof options.onCancel === "function" ? options.onCancel : null;
    }
    document.body.classList.add("reader-loading-active");
    root.hidden = false;
    requestAnimationFrame(() => root.classList.add("is-visible"));
  }

  function clearReaderLoading() {
    const root = document.getElementById("readerLoadingOverlay");
    if (!root) return;
    document.body.classList.remove("reader-loading-active");
    root.classList.remove("is-visible");
    readerLoadingRemoveTimer = window.setTimeout(() => root.remove(), 220);
  }

  function cancelTranslation(reason = "user") {
    if (!state.translationBusy) return;
    state.translationCancelRequested = true;
    state.translationAbortController?.abort();
    if (reason === "user") {
      app.toast("翻译已暂停，已完成页面已保存；可继续翻译");
    }
    if (reason === "background") {
      app.toast("应用进入后台，翻译已暂停；已完成的页面保存在本机");
    }
  }

  function isBookPreparedForTranslation(book) {
    const pages = (book?.pages || []).filter((page) => String(page?.text || "").trim());
    return book?.readingPreparation?.textVersion === 2 &&
      pages.length > 0 &&
      pages.every((page) => page.proofreadMeta?.version === 2);
  }

  function injectReaderControls(book) {
    const header = document.querySelector(".real-reader-shell .reader-toolbar > div:last-child");
    if (!header) return;
    let group = document.getElementById("realReaderAiControls");
    if (!group) {
      group = document.createElement("div");
      group.id = "realReaderAiControls";
      group.style.cssText = "display:flex;align-items:center;gap:5px;padding-left:8px;border-left:1px solid var(--border-hairline);";
      header.appendChild(group);
    }
    const noText = !(book.pages || []).some((page) => String(page?.text || "").trim());
    const showTranslation = isForeignLanguageBook(book) || state.translations.length > 0 || noText;
    if (showTranslation && !document.getElementById("realTranslationToggle")) {
      group.insertAdjacentHTML("beforeend", `<button class="btn btn-icon btn-sm ${state.translationsOn ? "btn-tonal" : ""}" id="realTranslationToggle" title="${state.translationsOn ? "关闭翻译" : noText ? "识别并翻译整本书" : "开启翻译"}"><span style="font-size:13px;font-weight:650;">译</span></button>`);
    }
    if (!showTranslation) document.getElementById("realTranslationToggle")?.remove();
    const continuous = Boolean(document.querySelector(".real-reader-article[data-continuous]"));
    const page = fs()?.pageRecord?.(book, book.page);
    if (!continuous && !String(page?.text || "").trim() && !book.originalDeleted && !document.getElementById("realOcrPageBtn")) {
      group.insertAdjacentHTML("beforeend", `<button class="btn btn-sm" id="realOcrPageBtn" ${state.ocrBusy ? "disabled" : ""}>${state.ocrBusy ? "正在识别…" : "AI 识别扫描页"}</button><span id="realOcrStatus" style="font-size:11px;color:var(--text-muted);">当前页无文字层</span>`);
    }
    if (!continuous && page?.ocrMeta && !document.getElementById("realOcrCorrectBtn")) {
      group.insertAdjacentHTML("beforeend", `<button class="btn btn-sm" id="realOcrCorrectBtn">校对 OCR</button>`);
    }
    if (book.originalDeleted) {
      const article = document.querySelector(".real-reader-article");
      if (article && !article.querySelector(".reader-cleaned-notice")) {
        article.insertAdjacentHTML("afterbegin", `<div class="reader-cleaned-notice">这本 PDF 的原文已按 7 天规则清理。你的笔记、画板、词典与知识证据仍永久保存在本机。</div>`);
      }
    }
  }

  function renderTranslations() {
    document.querySelectorAll(".real-reader-text p").forEach((paragraph) => {
      const page = Number(paragraph.getAttribute("data-page"));
      const index = Number(paragraph.getAttribute("data-paragraph-index"));
      const records = state.translations
        .filter((item) => item.page === page && item.paragraphIndex === index)
        .sort((left, right) => Number(left.segmentIndex || 0) - Number(right.segmentIndex || 0));
      if (!records.length) return;
      if (paragraph.getAttribute("data-original") === null) {
        paragraph.setAttribute("data-original", paragraph.textContent);
      }
    });
    if (!state.translationsOn) {
      document.querySelectorAll(".real-reader-text p").forEach((paragraph) => {
        const original = paragraph.getAttribute("data-original");
        if (original !== null) {
          paragraph.innerHTML = markWords(original);
          paragraph.removeAttribute("data-original");
        }
      });
      return;
    }
    document.querySelectorAll(".real-reader-text p").forEach((paragraph) => {
      const page = Number(paragraph.getAttribute("data-page"));
      const index = Number(paragraph.getAttribute("data-paragraph-index"));
      const records = state.translations
        .filter((item) => item.page === page && item.paragraphIndex === index)
        .sort((left, right) => Number(left.segmentIndex || 0) - Number(right.segmentIndex || 0));
      if (!records.length) return;
      const blockType = paragraph.getAttribute("data-block-type");
      const sentences = ["title", "heading", "subheading"].includes(blockType)
        ? [paragraph.getAttribute("data-original")]
        : splitSentences(paragraph.getAttribute("data-original"));
      paragraph.innerHTML = sentences.map((sentence, segmentIndex) => {
        const record = records.find((item) => Number(item.segmentIndex) === segmentIndex) ||
          records.find((item) => sameSentence(item.original, sentence));
        const translation = record?.translation ? `<span class="sentence-translation">${esc(record.translation)}</span>` : "";
        return `<span class="sentence-original">${markWords(sentence)}</span>${translation || " "}`;
      }).join("");
    });
  }

  function highlightDictionaryWords() {
    const lemmas = new Set(state.dictionary.map((entry) => normalizeWord(entry.displayForm || entry.lemma)));
    document.querySelectorAll(".real-reader-text .word-token").forEach((token) => {
      token.classList.toggle("marked-word", lemmas.has(normalizeWord(token.getAttribute("data-word") || token.textContent)));
    });
  }

  function enhanceWordCard() {
    const card = document.querySelector(".real-word-card");
    if (!card) return;
    const word = fs()?.state?.activePopupWord || "";
    const data = fs()?.state?.__wordPopupData;
    if (!word) return;
    const badges = card.querySelector("div:last-of-type");
    if (badges && !data) {
      const saved = [...badges.querySelectorAll(".badge")].find((item) => item.textContent.includes("已保存"));
      if (saved) saved.textContent = "仅查看";
    }
    if (!card.querySelector("[data-word-actions]")) {
      const actions = document.createElement("div");
      actions.setAttribute("data-word-actions", "");
      actions.style.cssText = "display:flex;gap:7px;flex-wrap:wrap;margin-top:10px;";
      actions.innerHTML = `${data ? "" : `<button class="btn btn-sm btn-primary" id="manualMarkWordBtn">标记为生词</button>`}<button class="btn btn-sm" id="realWordEnrichBtn" ${data?.definitionZh ? "disabled" : ""}>${data?.definitionZh ? "已有释义" : "AI 查询释义"}</button>`;
      card.appendChild(actions);
    }
  }

  async function markCurrentWord() {
    const word = fs()?.state?.activePopupWord;
    if (!word) return;
    const entry = await fs()?.markDictionaryWord(word);
    fs().state.__wordPopupData = entry;
    state.dictionary = [
      ...state.dictionary.filter((item) => normalizeWord(item.lemma) !== normalizeWord(entry.lemma)),
      entry,
    ];
    app.renderApp();
  }

  async function enrichCurrentWord() {
    const word = fs()?.state?.activePopupWord;
    if (!word) return;
    const entry = await getRecord("dictionary", normalizeWord(word));
    if (!entry) { app.toast("请先把这个单词标记为生词"); return; }
    if (entry.definitionZh) return;
    if (state.enrichedWord === word) return;
    state.enrichedWord = word;
    app.toast("正在结合原句生成释义…");
    try {
      const updated = await enrichDictionaryWord(entry);
      fs().state.__wordPopupData = updated;
      await loadDictionary(); app.renderApp(); app.toast("单词释义已保存到本地词典");
    } catch (error) { app.toast(`释义失败：${error.message}`); }
    finally { state.enrichedWord = ""; }
  }

  function toggleTranslation() {
    state.translationsOn = !state.translationsOn;
    renderTranslations();
    syncReaderActions();
  }

  async function handleFullTranslationAction() {
    const book = currentBook();
    if (!book) return;
    if (state.translationBusy) {
      cancelTranslation("user");
      return;
    }
    const cached = await loadSavedTranslations(book);
    state.translations = cached;
    state.translationSavedPages = translationPages(cached);
    if (state.translationSavedPages.size) {
      if (state.translationsOn) {
        state.translationsOn = false;
        renderTranslations();
        syncReaderActions(book);
        return;
      }
      if (translationIsComplete(book, cached)) {
        state.translationsOn = true;
        renderTranslations();
        syncReaderActions(book);
        return;
      }
      state.translationsOn = true;
      renderTranslations();
      syncReaderActions(book);
    }
    await ensureBookTranslated(false);
  }

  async function ensureBookTranslated() {
    let book = currentBook();
    if (!book || state.translationBusy) return;
    if (!(await hasApiKey("translation"))) {
      app.switchView("settings");
      app.toast("请先为“外文翻译”配置模型并填写 API Key");
      return;
    }

    let cached = await loadSavedTranslations(book);
    let pagesWithText = textPages(book);

    if (isBookPreparedForTranslation(book) && translationIsComplete(book, cached)) {
      state.translations = cached;
      state.translationSavedPages = translationPages(cached);
      state.translationsOn = true;
      renderTranslations();
      syncReaderActions(book);
      return;
    }

    state.translationBusy = true;
    state.translationCancelRequested = false;
    state.translationAbortController = new AbortController();
    const cancelControl = {
      cancelLabel: "停止翻译",
      onCancel: () => cancelTranslation("user"),
    };
    syncReaderActions(book);
    setReaderLoading("正在准备整本书…", cancelControl);
    try {
      if (!isBookPreparedForTranslation(book)) {
        const prepared = await prepareBookForReading(
          book,
          (progressInfo) => setReaderLoading(progressInfo?.label || "正在准备整本书…", cancelControl),
          { signal: state.translationAbortController.signal }
        );
        book = fs()?.currentImportedBook?.() || prepared.book || book;
        app.renderApp();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        pagesWithText = (book.pages || []).filter((page) => String(page.text || "").trim());
        if (!pagesWithText.length) throw new Error("这本书没有可翻译的文字，请检查扫描页识别结果。");
        cached = await loadSavedTranslations(book);
      }

      if (translationIsComplete(book, cached)) {
        state.translations = cached;
        state.translationSavedPages = translationPages(cached);
        state.translationsOn = true;
        renderTranslations();
        syncReaderActions(book);
        return;
      }

      state.translations = cached;
      state.translationSavedPages = translationPages(cached);
      state.translationsOn = true;
      renderTranslations();
      setReaderLoading("正在翻译整本书…", cancelControl);
      const translated = await translateBook(book, (progressInfo) => {
        const current = Number(progressInfo?.current || 0);
        const total = Number(progressInfo?.total || pagesWithText.length);
        state.translationInFlightPage = current;
        setReaderLoading(`正在翻译整本书 · ${current}/${total} 页 · 已保存 ${state.translationSavedPages.size} 页`, cancelControl);
      }, (pageRecords) => {
        const byId = new Map(state.translations.map((item) => [item.id, item]));
        for (const record of pageRecords) {
          byId.set(record.id, record);
          state.translationSavedPages.add(Number(record.page));
        }
        state.translations = [...byId.values()]
          .sort((a, b) => a.page - b.page || a.paragraphIndex - b.paragraphIndex || Number(a.segmentIndex) - Number(b.segmentIndex));
        renderTranslations();
        syncReaderActions(book);
      }, { signal: state.translationAbortController.signal });
      state.translations = translated
        .slice()
        .sort((a, b) => a.page - b.page || a.paragraphIndex - b.paragraphIndex || Number(a.segmentIndex) - Number(b.segmentIndex));
      state.translationSavedPages = translationPages(state.translations);
      state.translationsOn = true;
      renderTranslations();
    } catch (error) {
      const cancelled = error?.cancelled || error?.name === "AbortError" || state.translationCancelRequested;
      state.translationsOn = cancelled ? false : state.translationSavedPages.size > 0;
      renderTranslations();
      if (!cancelled) app.toast(`翻译失败：${error.message}`);
    } finally {
      state.translationBusy = false;
      state.translationInFlightPage = 0;
      state.translationAbortController = null;
      state.translationCancelRequested = false;
      clearReaderLoading();
      syncReaderActions(book);
    }
  }

  async function recoverReadingText() {
    const book = currentBook();
    if (!book || state.translationBusy) return;
    if (!(await hasApiKey("proofread"))) {
      app.switchView("settings");
      app.toast("请先配置“文字校对”模型，再重新校对阅读文字");
      return;
    }
    state.translationBusy = true;
    state.translationAbortController = new AbortController();
    const cancelControl = {
      cancelLabel: "停止校对",
      onCancel: () => cancelTranslation("user"),
    };
    setReaderLoading("正在重新校对受影响页面…", cancelControl);
    try {
      const prepared = await prepareBookForReading(
        book,
        (progressInfo) => setReaderLoading(progressInfo?.label || "正在重新校对文字…", cancelControl),
        { signal: state.translationAbortController.signal },
      );
      state.translations = [];
      state.translationSavedPages.clear();
      state.translationsOn = false;
      state.lastEnhancedKey = "";
      Object.assign(book, prepared.book || {});
      clearReaderLoading();
      app.renderApp();
      app.toast("文字校对完成，已替换受影响页面");
    } catch (error) {
      const cancelled = error?.cancelled || error?.name === "AbortError" || state.translationCancelRequested;
      if (!cancelled) app.toast(`文字校对失败：${error.message}`);
    } finally {
      state.translationBusy = false;
      state.translationAbortController = null;
      state.translationCancelRequested = false;
      clearReaderLoading();
    }
  }

  async function recognizeCurrentPage() {
    const book = currentBook();
    if (!book || state.ocrBusy) return null;
    if (book.originalDeleted || !fs()?.renderPdfPageDataUrl) throw new Error("这本 PDF 的原始文件已清理，无法再识别扫描页。");
    if (!(await hasApiKey("ocr"))) {
      app.switchView("settings"); app.toast("请先配置扫描页识别模型"); return null;
    }
    const page = fs()?.pageRecord?.(book, book.page);
    if (!page) throw new Error("找不到当前页。");
    state.ocrBusy = true;
    const button = document.getElementById("realOcrPageBtn");
    if (button) { button.disabled = true; button.textContent = "正在识别…"; }
    try {
      app.toast("正在识别当前扫描页，只发送这一页图像…");
      const dataUrl = await fs().renderPdfPageDataUrl(book.id, book.page, { maxDimension: 1800 });
      const result = await recognizeScannedPage(dataUrl);
      if (!result.text.trim()) throw new Error("没有识别到可确认的文字；原页面已保留。");
      const recognizedAt = new Date().toISOString();
      const { blocks: recognizedBlocks, text: recognizedText, ...recognitionMeta } = result;
      page.text = result.text;
      page.readingBlocks = blocksFromRecognition({ blocks: recognizedBlocks, text: recognizedText });
      page.ocrMeta = { method: result.recognitionModel || "configured-model", recognizedAt, ...recognitionMeta };
      page.proofreadMeta = null;
      book.pages[(book.pages || []).findIndex((item) => item.number === book.page)] = page;
      book.textCharacters = (book.pages || []).reduce((total, item) => total + String(item.text || "").length, 0);
      book.readingPreparation = {
        ...(book.readingPreparation || {}),
        status: "needs-proofread",
        textVersion: 1,
      };
      const staleTranslations = (await getAll("translations"))
        .filter((item) => item.bookId === book.id && item.page === book.page)
        .map((item) => item.id);
      if (staleTranslations.length) await deleteMany("translations", staleTranslations);
      book.tag = "本地 PDF · AI OCR";
      book.knowledgeProcessing = {
        ...(book.knowledgeProcessing || {}), status: "local-indexed", localIndexedAt: recognizedAt,
        verifiedAt: "", verificationPassedAt: "", blockedReason: "新增 OCR 原文，知识库需要重新校验",
      };
      await putRecord("books", book);
      await indexBookLocal(book);
      state.lastEnhancedKey = "";
      window.dispatchEvent(new CustomEvent("biandu:local-data-changed", { detail: { kind: "ocr", id: `${book.id}:${book.page}` } }));
      app.renderApp();
      return result;
    } catch (error) {
      app.toast(`扫描页识别失败：${error.message}`);
      throw error;
    } finally {
      state.ocrBusy = false;
      if (button) { button.disabled = false; button.textContent = "AI 识别扫描页"; }
    }
  }

  function openOcrCorrection() {
    const book = currentBook();
    const page = book ? fs()?.pageRecord?.(book, book.page) : null;
    if (!book || !page?.ocrMeta) return;
    const root = document.getElementById("modalRoot");
    root.innerHTML = `<div class="modal-backdrop" id="ocrCorrectBackdrop"><div class="modal-card" style="max-width:760px;" onclick="event.stopPropagation()"><h2 class="serif-title" style="font-size:20px;margin-bottom:6px;">校对扫描页文字</h2><p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;">AI 识别置信度 ${Number.isFinite(page.ocrMeta.confidence) ? `${Math.round(page.ocrMeta.confidence * 100)}%` : "未提供"}。请直接修正错字或段落，保存后会重新建立本地证据并撤销旧知识校验。</p><textarea id="ocrCorrectionText" style="width:100%;min-height:360px;padding:12px;border:1px solid var(--border-strong);border-radius:7px;background:var(--bg-paper);color:var(--text-main);font:inherit;line-height:1.65;resize:vertical;">${esc(page.text || "")}</textarea><div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;"><button class="btn" id="cancelOcrCorrectionBtn">取消</button><button class="btn btn-primary" id="saveOcrCorrectionBtn">保存校对结果</button></div></div></div>`;
    document.getElementById("cancelOcrCorrectionBtn").onclick = () => { root.innerHTML = ""; };
    document.getElementById("ocrCorrectBackdrop").onclick = (event) => { if (event.target.id === "ocrCorrectBackdrop") root.innerHTML = ""; };
    document.getElementById("saveOcrCorrectionBtn").onclick = async () => {
      const corrected = document.getElementById("ocrCorrectionText")?.value.trim() || "";
      if (!corrected) return app.toast("校对后的文字不能为空。");
      const correctedAt = new Date().toISOString();
      page.text = corrected;
      page.readingBlocks = blocksFromText(corrected);
      page.proofreadMeta = null;
      page.ocrMeta = { ...page.ocrMeta, correctedAt };
      const index = (book.pages || []).findIndex((item) => item.number === book.page);
      if (index < 0) return app.toast("当前页记录已变化，请重新打开这一页。");
      book.pages[index] = page;
      book.textCharacters = book.pages.reduce((total, item) => total + String(item.text || "").length, 0);
      book.readingPreparation = {
        ...(book.readingPreparation || {}),
        status: "needs-proofread",
        textVersion: 1,
      };
      const staleTranslations = (await getAll("translations"))
        .filter((item) => item.bookId === book.id && item.page === book.page)
        .map((item) => item.id);
      if (staleTranslations.length) await deleteMany("translations", staleTranslations);
      book.knowledgeProcessing = {
        ...(book.knowledgeProcessing || {}), status: "local-indexed", localIndexedAt: correctedAt,
        verifiedAt: "", verificationPassedAt: "", blockedReason: "OCR 文字已人工校对，知识库需要重新校验",
      };
      await putRecord("books", book);
      await indexBookLocal(book);
      root.innerHTML = "";
      state.lastEnhancedKey = "";
      window.dispatchEvent(new CustomEvent("biandu:local-data-changed", { detail: { kind: "ocr-correction", id: `${book.id}:${book.page}` } }));
      app.renderApp();
    };
  }

  function createAnnotationBoard() {
    if (!currentBook()) return;
    showInlineBoard(fs()?.state?.readerSelectionText || "");
  }

  function selectionKey(book) {
    const imageId = fs()?.state?.readerSelectedImage?.assetId || "";
    return `${book.id}:${book.page}:${imageId || fs()?.state?.readerSelectionText || ""}`;
  }

  function enhanceSelectionDrawer(book) {
    const aside = document.querySelector("#excerptAiBackdrop .drawer-panel");
    if (!aside) return;
    const key = selectionKey(book);
    if (state.selectionConversation?.key !== key) {
      const image = fs()?.state?.readerSelectedImage;
      state.selectionConversation = {
        key, id: createId("conversation"), messages: [],
        kind: image?.assetId ? "image" : "text",
        imageAssetId: image?.assetId || null,
        imageDataUrl: image?.dataUrl || "",
        bounds: image?.bounds || null,
      };
    }
    const oldPlaceholder = aside.querySelector(":scope > div:nth-child(3)");
    if (oldPlaceholder && !oldPlaceholder.classList.contains("selection-real-chat")) {
      oldPlaceholder.remove();
      const chatRoot = document.createElement("div");
      chatRoot.className = "selection-real-chat";
      aside.appendChild(chatRoot);
    }
    const chatRoot = aside.querySelector(".selection-real-chat");
    if (!chatRoot) return;
    const imageMode = state.selectionConversation?.kind === "image";
    chatRoot.innerHTML = `<div class="selection-chat-messages">${renderSelectionMessages()}</div><div class="selection-chat-composer"><textarea id="selectionAiQuestion" rows="3" placeholder="${imageMode ? "询问图片、图表或公式…" : "只针对当前选段提问…"}"></textarea><div><span>${imageMode ? "仅发送框选区域与问题" : "仅发送当前选段与问题"}</span><button class="btn btn-primary" id="sendSelectionAiBtn" ${state.selectionBusy ? "disabled" : ""}>${state.selectionBusy ? "思考中…" : "发送"}</button></div></div>`;
    const questionInput = document.getElementById("selectionAiQuestion");
    if (imageMode && questionInput && fs()?.state?.__imageSelectionDefaultQuestion) {
      questionInput.value = fs().state.__imageSelectionDefaultQuestion;
      fs().state.__imageSelectionDefaultQuestion = "";
    }
    document.getElementById("sendSelectionAiBtn")?.addEventListener("click", sendSelectionQuestion);
    document.getElementById("selectionAiQuestion")?.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") sendSelectionQuestion();
    });
    document.querySelectorAll(".selection-save-note").forEach((button) => button.addEventListener("click", () => saveSelectionAnswerAsNote(Number(button.getAttribute("data-message-index")))));
    document.querySelectorAll(".selection-add-kb").forEach((button) => button.addEventListener("click", () => saveSelectionAnswerToKnowledge(Number(button.getAttribute("data-message-index")))));
  }

  function renderSelectionMessages() {
    if (!state.selectionConversation?.messages.length) {
      return state.selectionConversation?.kind === "image"
        ? `<div class="selection-chat-empty"><strong>只发送框选图像，不读取整页或全书</strong><p>可以询问公式变量、图表趋势、流程结构或图片中的文字。AI 回答会先保存在本机，并可直接转为笔记或知识证据。</p></div>`
        : `<div class="selection-chat-empty"><strong>只发送选段，不读取其他资料</strong><p>可以问概念、推理、背景或语言结构。AI 返回内容会先保存在本机，你可选择转为笔记或知识证据。</p></div>`;
    }
    return state.selectionConversation.messages.map((message, index) => message.role === "user"
      ? `<div class="selection-user-message">${esc(message.content)}</div>`
      : `<article class="selection-ai-message"><div>${esc(message.content).replaceAll("\n", "<br>")}</div><div class="selection-ai-actions"><button class="btn btn-sm selection-save-note" data-message-index="${index}">保存为文字笔记</button><button class="btn btn-sm btn-tonal selection-add-kb" data-message-index="${index}">加入知识库</button></div></article>`).join("");
  }

  async function sendSelectionQuestion() {
    if (state.selectionBusy) return;
    const input = document.getElementById("selectionAiQuestion");
    const question = input?.value.trim();
    const selectedText = fs()?.state?.readerSelectionText?.trim();
    const selectedImage = fs()?.state?.readerSelectedImage;
    const book = currentBook();
    const imageMode = Boolean(selectedImage?.assetId && selectedImage?.dataUrl && book &&
      selectedImage.bookId === book.id && Number(selectedImage.page) === Number(book.page));
    if (!question) { input?.focus(); return; }
    if (!selectedText && !imageMode) { app.toast("请先在原文中选中文字，或在原页视图中框选图片/公式"); return; }
    if (!(await hasApiKey(imageMode ? "visual" : "selection"))) {
      app.switchView("settings");
      app.toast(imageMode ? "请先配置支持图片输入的“图片与公式讲解”模型" : "请先配置选段讲解模型");
      return;
    }
    state.selectionBusy = true;
    state.selectionConversation.messages.push({ role: "user", content: question });
    app.renderApp();
    try {
      const messages = imageMode
        ? buildImageSelectionMessages({
            imageDataUrl: selectedImage.dataUrl,
            question,
            history: state.selectionConversation.messages.slice(-8),
          })
        : buildSelectionMessages({
            selectedText,
            question,
            history: state.selectionConversation.messages.slice(-8),
          });
      const answer = await chat(messages, { task: imageMode ? "visual" : "selection" });
      state.selectionConversation.messages.push({ role: "assistant", content: answer });
      await persistSelectionConversation(false);
    } catch (error) {
      state.selectionConversation.messages.push({ role: "assistant", content: `请求失败：${error.message}` });
    } finally {
      state.selectionBusy = false; app.renderApp();
    }
  }

  async function persistSelectionConversation(processed = false) {
    const book = currentBook();
    if (!book || !state.selectionConversation?.messages.length) return;
    const now = new Date().toISOString();
    const conversation = {
      id: state.selectionConversation.id, scope: "selection",
      title: `${book.title} · 第 ${book.page} 页选段`, bookId: book.id, page: book.page,
      selectedText: fs()?.state?.readerSelectionText || "",
      kind: state.selectionConversation.kind || "text",
      selectedImageAssetId: state.selectionConversation.imageAssetId || null,
      selectedImageBounds: state.selectionConversation.bounds || null,
      createdAt: state.selectionConversation.createdAt || now, updatedAt: now,
      messages: state.selectionConversation.messages.map((message) => ({
        id: message.id || createId("message"), role: message.role,
        content: message.content, createdAt: message.createdAt || now, citationIds: [],
      })),
      retention: processed ? {
        knowledgeProcessedAt: now, summaryReady: true, evidenceLinked: true,
        processedSummaryId: state.selectionConversation.lastSummaryEvidenceId,
      } : { summaryReady: false, evidenceLinked: false },
    };
    state.selectionConversation.createdAt ||= now;
    await putRecord("conversations", conversation);
  }

  async function saveSelectionAnswerAsNote(messageIndex) {
    const message = state.selectionConversation?.messages[messageIndex];
    const book = currentBook();
    if (!message || message.role !== "assistant" || !book) return;
    const now = new Date().toISOString();
    const note = {
      id: createId("note"), bookId: book.id, page: book.page,
      quote: state.selectionConversation.kind === "image" ? "框选的图片、图表或公式" : (fs()?.state?.readerSelectionText || ""),
      text: message.content,
      createdAt: now, source: "selection-ai",
      imageIds: state.selectionConversation.imageAssetId ? [state.selectionConversation.imageAssetId] : [],
    };
    await putRecord("notes", note);
    await saveEvidence({
      id: `evidence-${note.id}`, kind: "text-note", bookId: book.id,
      sourceId: book.id, sourceTitle: book.title, page: book.page,
      excerpt: `${state.selectionConversation.kind === "image" ? "图片选区" : "选段"}：${note.quote}\nAI 笔记：${note.text}`,
      imageAssetId: state.selectionConversation.imageAssetId || null,
      region: state.selectionConversation.bounds || null, permanent: true,
    });
    window.dispatchEvent(new CustomEvent("biandu:local-data-changed", { detail: { kind: "note", id: note.id } }));
    app.toast("AI 讲解已保存为这一页的文字笔记");
  }

  async function saveSelectionAnswerToKnowledge(messageIndex) {
    const message = state.selectionConversation?.messages[messageIndex];
    const book = currentBook();
    if (!message || message.role !== "assistant" || !book) return;
    const evidence = await saveEvidence({
      id: createId("evidence"), kind: "ai-summary", bookId: book.id,
      sourceId: book.id, sourceTitle: book.title, page: book.page,
      excerpt: `${state.selectionConversation.kind === "image" ? "图片选区" : "选段"}：${state.selectionConversation.kind === "image" ? "框选的图片、图表或公式" : (fs()?.state?.readerSelectionText || "")}\nAI 讲解：${message.content}`,
      imageAssetId: state.selectionConversation.imageAssetId || null,
      region: state.selectionConversation.bounds || null,
      permanent: true,
    });
    await upsertKnowledgeNode({ kind: "ai-summary", title: `${book.title} · 第 ${book.page} 页讲解`, summary: message.content, evidenceIds: [evidence.id] });
    state.selectionConversation.lastSummaryEvidenceId = evidence.id;
    await persistSelectionConversation(true);
    app.toast("AI 讲解已加入知识库；原始对话将在完整 7 天后清理");
  }

  function bind() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") cancelTranslation("background");
    });
    window.addEventListener("pagehide", () => cancelTranslation("background"));
    document.addEventListener("pointerdown", (event) => {
      const button = event.target.closest?.("[data-reader-tooltip-title]");
      if (!button) {
        hideReaderActionTip();
        return;
      }
      window.clearTimeout(readerActionTipTimer);
      readerActionTipPointer = { x: event.clientX, y: event.clientY };
      readerActionTipTimer = window.setTimeout(() => showReaderActionTip(button), 480);
    }, true);
    document.addEventListener("pointermove", (event) => {
      if (!readerActionTipPointer) return;
      if (Math.hypot(event.clientX - readerActionTipPointer.x, event.clientY - readerActionTipPointer.y) > 8) {
        window.clearTimeout(readerActionTipTimer);
        readerActionTipPointer = null;
      }
    }, true);
    document.addEventListener("pointerup", () => {
      window.clearTimeout(readerActionTipTimer);
      readerActionTipPointer = null;
      if (document.getElementById("readerActionTip")) {
        readerActionTipTimer = window.setTimeout(hideReaderActionTip, 1200);
      }
    }, true);
    document.addEventListener("pointercancel", () => {
      window.clearTimeout(readerActionTipTimer);
      readerActionTipPointer = null;
    }, true);
    document.addEventListener("contextmenu", (event) => {
      const button = event.target.closest?.("[data-reader-tooltip-title]");
      if (!button) return;
      event.preventDefault();
      showReaderActionTip(button);
    }, true);
    document.addEventListener("pointerdown", (event) => {
      if (event.target.closest("#readerTranslateSelectionBtn, #readerAddDictionaryBtn, #readerSentenceNoteBtn, [data-reader-note-choice]")) {
        event.preventDefault();
      }
    }, true);
    document.addEventListener("click", (event) => {
      const book = currentBook();
      if (!book || fs()?.state?.currentView !== "reader") return;
      if (performance.now() < Number(fs()?.state?.__readerSuppressActionClickUntil || 0) &&
          event.target.closest("[data-reader-tooltip-title]")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        fs().state.__readerSuppressActionClickUntil = 0;
        return;
      }
      if (event.target.closest("#readerRecoverTextBtn")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        recoverReadingText();
        return;
      }
      if (event.target.closest("#readerTranslateSelectionBtn")) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.target.closest("#readerTranslateSelectionBtn").getAttribute("aria-disabled") === "true") return;
        translateSelectionInline();
        return;
      }
      if (event.target.closest("#readerAddDictionaryBtn")) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.target.closest("#readerAddDictionaryBtn").getAttribute("aria-disabled") === "true") return;
        addSelectedDictionaryWord();
        return;
      }
      if (event.target.closest("#readerSentenceNoteBtn")) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.target.closest("#readerSentenceNoteBtn").getAttribute("aria-disabled") === "true") return;
        showSentenceNoteMenu();
        return;
      }
      if (event.target.closest("#readerFullTranslationBtn")) {
        event.preventDefault(); event.stopImmediatePropagation();
        handleFullTranslationAction();
        return;
      }
      const pdfTool = event.target.closest("#readerPdfPenBtn, #readerPdfHighlighterBtn, #readerPdfEraserBtn");
      if (pdfTool) {
        event.preventDefault(); event.stopImmediatePropagation();
        const nextTool = pdfTool.id === "readerPdfHighlighterBtn"
          ? "highlighter" : pdfTool.id === "readerPdfEraserBtn" ? "eraser" : "pen";
        fs().state.readerPdfTool = nextTool;
        ["readerPdfPenBtn", "readerPdfHighlighterBtn", "readerPdfEraserBtn"].forEach((id) => {
          document.getElementById(id)?.classList.toggle("is-active", id === pdfTool.id);
        });
        return;
      }
      if (event.target.closest("#readerPdfInkUndoBtn")) {
        event.preventDefault(); event.stopImmediatePropagation();
        const strokes = pageInkStrokes(book, book.page);
        strokes.pop();
        redrawPdfInk();
        fs()?.db?.putRecord?.("books", book).catch(() => {});
        return;
      }
      const noteChoice = event.target.closest("[data-reader-note-choice]");
      if (noteChoice) {
        event.preventDefault(); event.stopImmediatePropagation();
        const quote = String(fs()?.state?.readerSelectionText || "");
        document.getElementById("readerNoteChoice")?.remove();
        if (noteChoice.getAttribute("data-reader-note-choice") === "board") createAnnotationBoard();
        else showInlineTextNote(quote);
        return;
      }
      if (!event.target.closest("#readerInlineTranslation, #readerInlineNoteEditor, #readerInlineBoard, .word-token, #readerSentenceNoteBtn")) {
        clearInlineResult();
      }
      if (event.target.closest("#manualMarkWordBtn")) {
        event.preventDefault(); event.stopImmediatePropagation(); markCurrentWord(); return;
      }
      if (event.target.closest("#realWordEnrichBtn")) {
        event.preventDefault(); event.stopImmediatePropagation(); enrichCurrentWord(); return;
      }
      if (event.target.closest("#realTranslationToggle")) {
        event.preventDefault(); event.stopImmediatePropagation(); toggleTranslation(); return;
      }
      if (event.target.closest("#realOcrPageBtn")) {
        event.preventDefault(); event.stopImmediatePropagation(); recognizeCurrentPage().catch(() => {}); return;
      }
      if (event.target.closest("#realOcrCorrectBtn")) {
        event.preventDefault(); event.stopImmediatePropagation(); openOcrCorrection(); return;
      }
      const selection = fs()?.state?.readerSelectionText?.trim() || "";
      const selectedImage = fs()?.state?.readerSelectedImage;
      if (event.target.closest("#realBoardSelectionBtn, #drawerActionNewBoardBtn, #floatNewBoardBtn")) {
        event.preventDefault(); event.stopImmediatePropagation(); createAnnotationBoard(); return;
      }
      if (event.target.closest("#readerAskExcerptAiBtn, #floatExplainBtn, #realExplainSelectionBtn") && !selection && !selectedImage?.assetId) {
        event.preventDefault(); event.stopImmediatePropagation();
        app.toast("请先从原文中选中要询问的段落"); return;
      }
    }, true);
  }

  function bindDynamic() {
    const translate = document.getElementById("realTranslationToggle");
    if (translate && translate.dataset.bound !== "true") {
      translate.dataset.bound = "true";
      translate.addEventListener("click", toggleTranslation);
    }
    const ocr = document.getElementById("realOcrPageBtn");
    if (ocr && ocr.dataset.bound !== "true") {
      ocr.dataset.bound = "true";
      ocr.addEventListener("click", () => recognizeCurrentPage().catch(() => {}));
    }
    const correctOcr = document.getElementById("realOcrCorrectBtn");
    if (correctOcr && correctOcr.dataset.bound !== "true") {
      correctOcr.dataset.bound = "true";
      correctOcr.addEventListener("click", openOcrCorrection);
    }
    const mark = document.getElementById("manualMarkWordBtn");
    if (mark && mark.dataset.bound !== "true") {
      mark.dataset.bound = "true"; mark.addEventListener("click", markCurrentWord);
    }
    const enrich = document.getElementById("realWordEnrichBtn");
    if (enrich && enrich.dataset.bound !== "true") {
      enrich.dataset.bound = "true"; enrich.addEventListener("click", enrichCurrentWord);
    }
  }

  const originalEnhance = enhance;
  async function enhanceAndBind() {
    await originalEnhance();
    bindDynamic();
  }

  return {
    bind,
    enhance: enhanceAndBind,
    ensureBookTranslated,
    toggleTranslation,
    clearInlineResult,
    recognizeCurrentPage,
    openOcrCorrection,
    createAnnotationBoard,
      cancelTranslation,
    getState: () => state,
  };
}
