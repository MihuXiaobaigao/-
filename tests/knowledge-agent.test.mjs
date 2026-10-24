import assert from "node:assert/strict";
import test from "node:test";

import { createDocxBlob, createPptxBlob } from "../src/web/artifact-export.js";
import {
  buildKnowledgeAnswerMessages,
  buildKnowledgeDeliverableMessages,
} from "../src/web/prompts.js";
import {
  adaptMessagesForProfile,
  providerFamily,
} from "../src/web/prompt-adapters.js";

const artifact = {
  title: "注意力经济研究简报",
  subtitle: "私人知识库整理",
  summary: "注意力是有限资源。",
  sections: [{ heading: "核心结论", paragraphs: ["信息越丰富，注意力越稀缺。"], citationIds: ["ev-1"] }],
  slides: [{ title: "核心结论", points: ["信息越丰富", "注意力越稀缺"], citationIds: ["ev-1"] }],
  citations: [{ evidenceId: "ev-1", quote: "Attention is scarce.", sourceTitle: "注意力研究", page: 6 }],
};

test("LangGPT adapters add provider-specific constraints without changing user data", () => {
  assert.equal(providerFamily({ model: "deepseek-flash" }), "deepseek");
  assert.equal(providerFamily({ model: "qwen-mt-flash" }), "qwen-translation");
  assert.equal(providerFamily({ endpoint: "http://127.0.0.1:1234/v1/chat/completions" }), "local");

  const messages = buildKnowledgeAnswerMessages({
    question: "注意力为什么稀缺？",
    evidence: [{ id: "ev-1", sourceTitle: "资料", excerpt: "注意力是有限资源。" }],
  });
  const adapted = adaptMessagesForProfile(messages, { model: "deepseek-flash" });
  assert.match(adapted[0].content, /接口适配约束 \(LangGPT\)/);
  assert.match(adapted[0].content, /Provider profile: deepseek/);
  assert.equal(adapted[1].content, messages[1].content);
});

test("knowledge delivery prompt keeps citations and separates documents from slides", () => {
  const documentPrompt = buildKnowledgeDeliverableMessages({
    question: "整理成报告",
    answer: "注意力是有限的。",
    task: "docx",
    evidence: [{ id: "ev-1", excerpt: "注意力是有限的。", sourceTitle: "书" }],
  });
  const slidePrompt = buildKnowledgeDeliverableMessages({
    question: "做成演示",
    answer: "注意力是有限的。",
    task: "pptx",
    evidence: [{ id: "ev-1", excerpt: "注意力是有限的。", sourceTitle: "书" }],
  });
  assert.match(documentPrompt[0].content, /sections/);
  assert.match(slidePrompt[0].content, /slides/);
  assert.match(documentPrompt[0].content, /citationIds/);
  assert.match(documentPrompt[0].content, /不增加未要求的附加文件/);
  assert.equal(JSON.parse(documentPrompt[1].content).targetFormat, "docx");
});

test("Office exporters generate non-empty DOCX and PPTX ZIP containers", async () => {
  for (const blob of [createDocxBlob(artifact), createPptxBlob(artifact)]) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.ok(bytes.length > 1000);
    assert.equal(bytes[0], 0x50);
    assert.equal(bytes[1], 0x4B);
  }
});
