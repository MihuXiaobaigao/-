import { chat } from "./deepseek.js";
import { buildKnowledgeDeliverableMessages } from "./prompts.js";

export const KNOWLEDGE_TASKS = Object.freeze([
  { id: "pdf", label: "PDF 报告", extension: "pdf", hint: "整理成适合打印和分享的长文报告" },
  { id: "docx", label: "Word 文档", extension: "docx", hint: "生成可继续编辑的 Word 文档" },
  { id: "pptx", label: "PPT 演示", extension: "pptx", hint: "提炼成结构清晰的演示文稿" },
]);

function clean(value, limit = 5000) {
  return String(value ?? "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim().slice(0, limit);
}

function allowedCitations(value, allowedIds) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(String).filter((id) => allowedIds.has(id))));
}

function fallbackSections(answer) {
  const paragraphs = String(answer || "")
    .split(/\n{2,}/u)
    .map((paragraph) => clean(paragraph, 2400))
    .filter(Boolean);
  const midpoint = Math.max(1, Math.ceil(paragraphs.length / 2));
  return [
    { heading: "核心回答", paragraphs: paragraphs.slice(0, midpoint) },
    { heading: "展开说明", paragraphs: paragraphs.slice(midpoint) },
  ].filter((section) => section.paragraphs.length);
}

function normalizeDocument(result, fallbackTitle, allowedIds) {
  const sections = (Array.isArray(result?.sections) ? result.sections : [])
    .slice(0, 14)
    .map((section) => ({
      heading: clean(section?.heading, 160),
      paragraphs: (Array.isArray(section?.paragraphs) ? section.paragraphs : [])
        .map((paragraph) => clean(paragraph, 2600))
        .filter(Boolean)
        .slice(0, 8),
      citationIds: allowedCitations(section?.citationIds, allowedIds),
    }))
    .filter((section) => section.heading && section.paragraphs.length);
  return {
    title: clean(result?.title, 160) || fallbackTitle,
    subtitle: clean(result?.subtitle, 220),
    summary: clean(result?.summary, 1600),
    sections: sections.length ? sections : fallbackSections(result?.summary || fallbackTitle),
    sourceLabels: Array.isArray(result?.sourceLabels)
      ? result.sourceLabels.map((item) => clean(item, 180)).filter(Boolean).slice(0, 20)
      : [],
  };
}

function normalizeSlides(result, fallbackTitle, allowedIds) {
  const slides = (Array.isArray(result?.slides) ? result.slides : [])
    .slice(0, 12)
    .map((slide) => ({
      title: clean(slide?.title, 140),
      points: (Array.isArray(slide?.points) ? slide.points : [])
        .map((point) => clean(point, 360))
        .filter(Boolean)
        .slice(0, 6),
      citationIds: allowedCitations(slide?.citationIds, allowedIds),
    }))
    .filter((slide) => slide.title && slide.points.length);
  return {
    title: clean(result?.title, 160) || fallbackTitle,
    subtitle: clean(result?.subtitle, 220),
    summary: clean(result?.summary, 1000),
    slides: slides.length ? slides : [{
      title: fallbackTitle,
      points: fallbackSections(result?.summary || fallbackTitle).flatMap((section) => section.paragraphs).slice(0, 6),
      citationIds: [],
    }],
    sourceLabels: Array.isArray(result?.sourceLabels)
      ? result.sourceLabels.map((item) => clean(item, 180)).filter(Boolean).slice(0, 20)
      : [],
  };
}

export async function composeKnowledgeDeliverable({
  task, question, result, signal,
}) {
  if (!KNOWLEDGE_TASKS.some((item) => item.id === task)) throw new Error("未知的知识交付格式。");
  const evidence = Array.isArray(result?.evidence) ? result.evidence : [];
  const allowedIds = new Set(evidence.map((item) => item.id));
  const fallbackTitle = clean(question, 80) || "私人知识库整理";
  let generated;
  try {
    generated = await chat(buildKnowledgeDeliverableMessages({
      question,
      answer: result?.answer,
      task,
      evidence,
      citations: result?.citations || [],
    }), {
      task: "knowledge",
      json: true,
      temperature: task === "pptx" ? 0.35 : 0.25,
      timeoutMs: 180_000,
      signal,
    });
  } catch {
    generated = {
      title: fallbackTitle,
      subtitle: "基于已通过引用校验的知识回答整理",
      summary: result?.answer || "",
      sections: fallbackSections(result?.answer),
      slides: [{
        title: fallbackTitle,
        points: fallbackSections(result?.answer).flatMap((section) => section.paragraphs).slice(0, 6),
        citationIds: [],
      }],
    };
  }
  if (!generated?.summary && result?.answer) generated.summary = result.answer;
  const normalized = task === "pptx"
    ? normalizeSlides(generated, fallbackTitle, allowedIds)
    : normalizeDocument(generated, fallbackTitle, allowedIds);
  const citations = (result?.citations || []).map((citation) => {
    const source = evidence.find((item) => item.id === citation.evidenceId);
    return {
      evidenceId: citation.evidenceId,
      quote: clean(citation.quote, 320),
      sourceTitle: clean(source?.sourceTitle, 180) || "本地资料",
      page: Number(source?.page) || null,
    };
  });
  return {
    ...normalized,
    task,
    citations,
    generatedAt: new Date().toISOString(),
  };
}
