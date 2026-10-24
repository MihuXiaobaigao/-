import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEvidenceBatches,
  expandEvidenceByGraph,
  validateKnowledgeWikiBatch,
} from "../src/web/knowledge-compiler.js";

const batch = [
  { id: "ev-1", excerpt: "注意力是稀缺资源。", sourceTitle: "一本书" },
  { id: "ev-2", excerpt: "信息越丰富，注意力越稀缺。", sourceTitle: "一篇笔记" },
];

test("wiki validation reuses aliases, keeps evidence-backed pages and links", () => {
  const result = validateKnowledgeWikiBatch({
    overview: "本轮把注意力与信息供给连接起来。",
    pages: [
      {
        title: "attention economy",
        kind: "concept",
        summary: "注意力是有限资源。",
        body: "注意力是一种 [[稀缺资源]]。",
        aliases: ["注意力经济"],
        evidenceIds: ["ev-1"],
      },
      {
        title: "信息供给",
        kind: "claim",
        summary: "信息增长会加剧注意力稀缺。",
        body: "信息增长与注意力稀缺有关。",
        evidenceIds: ["ev-2"],
      },
    ],
    links: [{
      from: "attention economy",
      to: "信息供给",
      relation: "causes",
      rationale: "证据说明信息供给增加会加剧注意力稀缺。",
      evidenceIds: ["ev-1", "ev-2"],
      confidence: 0.86,
    }],
  }, batch, [{
    title: "注意力经济",
    kind: "concept",
    summary: "已有页面",
    aliases: ["Attention Economy"],
  }]);

  assert.equal(result.pages[0].title, "注意力经济");
  assert.equal(result.pages.length, 2);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].from, "注意力经济");
});

test("wiki validation rejects fabricated evidence ids", () => {
  assert.throws(() => validateKnowledgeWikiBatch({
    overview: "测试",
    pages: [{
      title: "虚构页面",
      kind: "concept",
      summary: "无来源",
      body: "无来源",
      evidenceIds: ["ev-404"],
    }],
    links: [],
  }, batch), /未提供/);
});

test("wiki batches and graph expansion preserve evidence boundaries", () => {
  const evidence = Array.from({ length: 7 }, (_, index) => ({
    id: `ev-${index}`,
    excerpt: `证据 ${index}`,
  }));
  assert.deepEqual(buildEvidenceBatches(evidence, 3).map((items) => items.length), [3, 3, 1]);

  const nodes = [
    { id: "n1", title: "注意力", evidenceIds: ["seed"], aliases: [] },
    { id: "n2", title: "深度阅读", evidenceIds: ["neighbor"], aliases: [] },
    { id: "n3", title: "认知负荷", evidenceIds: ["second"], aliases: [] },
  ];
  const edges = [
    { id: "e1", fromNodeId: "n1", toNodeId: "n2", confidence: 0.9 },
    { id: "e2", fromNodeId: "n2", toNodeId: "n3", confidence: 0.8 },
  ];
  const allEvidence = [
    { id: "seed", excerpt: "种子", permanent: true },
    { id: "neighbor", excerpt: "相邻证据", permanent: true },
    { id: "second", excerpt: "二跳证据", permanent: true },
  ];
  const expanded = expandEvidenceByGraph(
    [{ id: "seed", excerpt: "种子", score: 12, permanent: true }],
    allEvidence,
    nodes,
    edges,
  );
  assert.ok(expanded.added.some((item) => item.id === "neighbor"));
  assert.ok(expanded.added.some((item) => item.id === "second"));
});
