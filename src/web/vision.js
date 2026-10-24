import { chat, getBoundModelProfile } from "./deepseek.js";
import { buildHandwritingMessages, buildScannedPageMessages, buildVisualPageMessages } from "./prompts.js";

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function confidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function warnings(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean).slice(0, 8) : [];
}

function normalizeOcrBlocks(value) {
  const allowedTypes = new Set([
    "title", "heading", "paragraph", "list-item", "caption", "formula", "footnote",
  ]);
  if (!Array.isArray(value)) return [];
  return value.map((block, index) => {
    const content = String(block?.text || "").replace(/\r/g, "").trim();
    if (!content) return null;
    const type = allowedTypes.has(String(block?.type || "")) ? String(block.type) : "paragraph";
    const values = Array.isArray(block?.bbox) ? block.bbox.slice(0, 4).map(Number) : [];
    const hasBox = values.length === 4 && values.every(Number.isFinite);
    const x0 = hasBox ? Math.max(0, Math.min(1, values[0])) : null;
    const y0 = hasBox ? Math.max(0, Math.min(1, values[1])) : null;
    const x1 = hasBox ? Math.max(0, Math.min(1, values[2])) : null;
    const y1 = hasBox ? Math.max(0, Math.min(1, values[3])) : null;
    const boundingBox = hasBox && x1 > x0 && y1 > y0
      ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
      : null;
    return {
      index,
      type,
      text: content,
      ...(boundingBox ? { boundingBox, bbox: [x0, y0, x1, y1] } : {}),
    };
  }).filter(Boolean).map((block, index) => ({ ...block, index }));
}

export function normalizePageOcr(result) {
  const blocks = normalizeOcrBlocks(result?.blocks);
  const transcript = blocks.length
    ? blocks.map((block) => block.text).join("\n\n")
    : String(result?.text ?? result?.transcript ?? "").replace(/\r/g, "").trim();
  return {
    text: transcript,
    blocks,
    language: text(result?.language),
    confidence: confidence(result?.confidence),
    uncertainLines: Array.isArray(result?.uncertainLines)
      ? result.uncertainLines.map(text).filter(Boolean).slice(0, 20) : [],
    warnings: warnings(result?.warnings),
  };
}

export function normalizeHandwritingOcr(result) {
  return {
    transcript: String(result?.transcript ?? result?.text ?? "").replace(/\r/g, "").trim(),
    keywords: Array.isArray(result?.keywords) ? result.keywords.map(text).filter(Boolean).slice(0, 30) : [],
    confidence: confidence(result?.confidence),
    warnings: warnings(result?.warnings),
  };
}

function stringList(value, limit = 20) {
  return Array.isArray(value) ? value.map(text).filter(Boolean).slice(0, limit) : [];
}

export function normalizeVisualPage(result) {
  const transcript = String(result?.transcript ?? result?.text ?? "").replace(/\r/g, "").trim();
  const visualDescription = String(result?.visualDescription ?? result?.description ?? "").trim();
  const formulas = stringList(result?.formulas, 24);
  const tables = stringList(result?.tables, 16);
  const figures = stringList(result?.figures, 16);
  const excerpt = [
    transcript ? `页面文字：${transcript}` : "",
    visualDescription ? `视觉内容：${visualDescription}` : "",
    formulas.length ? `公式：${formulas.join("\n")}` : "",
    tables.length ? `表格：${tables.join("\n")}` : "",
    figures.length ? `图注/图表：${figures.join("\n")}` : "",
  ].filter(Boolean).join("\n");
  return {
    transcript, visualDescription, formulas, tables, figures, excerpt,
    confidence: confidence(result?.confidence), warnings: warnings(result?.warnings),
  };
}

export async function recognizeImageDataUrl(dataUrl, options = {}) {
  const url = String(dataUrl || "");
  if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(url)) {
    throw new Error("待识别图片格式不受支持。");
  }
  const task = options.mode === "handwriting" ? "handwriting" : "ocr";
  const profile = await getBoundModelProfile(task);
  const messages = options.mode === "handwriting"
    ? buildHandwritingMessages(url)
    : buildScannedPageMessages(url);
  const result = await chat(messages, { task, json: true, temperature: 0 });
  return { result, profile };
}

export async function recognizeScannedPage(dataUrl) {
  const { result, profile } = await recognizeImageDataUrl(dataUrl, { mode: "scanned-page" });
  return { ...normalizePageOcr(result), recognitionModel: profile.model, recognitionProfile: profile.label };
}

export async function recognizeHandwritingBoard(dataUrl) {
  const { result, profile } = await recognizeImageDataUrl(dataUrl, { mode: "handwriting" });
  return { ...normalizeHandwritingOcr(result), recognitionModel: profile.model, recognitionProfile: profile.label };
}

export async function recognizeVisualPage(dataUrl) {
  const url = String(dataUrl || "");
  if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(url)) {
    throw new Error("待整理的页面快照格式不受支持。");
  }
  const profile = await getBoundModelProfile("visual");
  const result = await chat(buildVisualPageMessages(url), { task: "visual", json: true, temperature: 0 });
  return {
    ...normalizeVisualPage(result),
    recognitionModel: profile.model,
    recognitionProfile: profile.label,
  };
}
