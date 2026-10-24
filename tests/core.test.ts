import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKnowledgeAiPayload,
  buildSelectionAiPayload,
  validateKnowledgeAnswerCitations,
} from "../src/core/ai-context.ts";
import {
  RETENTION_PERIOD_MS,
  evaluateConversationCleanup,
  evaluateSourceCleanup,
} from "../src/core/cleanup.ts";
import type {
  AiConversation,
  Evidence,
  KnowledgeNode,
  SourceDocument,
} from "../src/core/domain.ts";
import {
  findKnowledgeNodeByTitleOrAlias,
  normalizeKnowledgeTerm,
} from "../src/core/knowledge.ts";

const verifiedAt = "2026-10-01T00:00:00.000Z";

function sourceDocument(
  overrides: Partial<SourceDocument["processing"]> = {},
  protectedByUser = false,
): SourceDocument {
  return {
    id: "source-1",
    title: "The Attention Economy",
    kind: "pdf",
    fileAssetId: "asset-1",
    fileSha256: "abc",
    byteSize: 1_000_000,
    importedAt: "2026-09-20T00:00:00.000Z",
    originalAvailable: true,
    processing: {
      extractionCompletedAt: "2026-09-21T00:00:00.000Z",
      knowledgeIndexedAt: verifiedAt,
      verificationPassedAt: verifiedAt,
      evidenceSaved: true,
      summaryReady: true,
      pendingJobs: 0,
      failedJobs: 0,
      ...overrides,
    },
    retention: {
      verifiedAt,
      protectedByUser,
    },
  };
}

function conversation(
  processedAt = verifiedAt,
  summaryReady = true,
): AiConversation {
  return {
    id: "conversation-1",
    scope: "selection",
    createdAt: processedAt,
    updatedAt: processedAt,
    messages: [],
    retention: {
      knowledgeProcessedAt: processedAt,
      summaryReady,
      evidenceLinked: true,
    },
  };
}

function evidence(
  id: string,
  excerpt: string,
  permanent = true,
): Evidence {
  return {
    id,
    kind: "source-excerpt",
    sourceId: "source-1",
    locator: { page: 7 },
    excerpt,
    capturedAt: verifiedAt,
    permanent,
  };
}

test("selection AI sends only the selected text and question", () => {
  const payload = buildSelectionAiPayload(
    "  Attention is becoming scarce.  ",
    "  Why does the author say this? ",
  );

  assert.deepEqual(payload, {
    selectedText: "Attention is becoming scarce.",
    question: "Why does the author say this?",
    contextPolicy: "selection-only",
  });
  assert.equal("bookTitle" in payload, false);
});

test("knowledge AI uses only permanent evidence and respects its budget", () => {
  const payload = buildKnowledgeAiPayload(
    "What did I read about attention?",
    [
      evidence("evidence-1", "attention economy"),
      evidence("evidence-2", "ignored duplicate", false),
      evidence("evidence-2", "valid second", true),
      evidence("evidence-1", "duplicate id"),
    ],
    80,
  );

  assert.deepEqual(payload.evidence, [
    { evidenceId: "evidence-1", excerpt: "attention economy" },
    { evidenceId: "evidence-2", excerpt: "valid second" },
  ]);
  assert.equal(payload.insufficientEvidence, false);
});

test("knowledge answer citations must refer to evidence that was sent", () => {
  assert.doesNotThrow(() => {
    validateKnowledgeAnswerCitations(
      {
        answer: "The author links attention to scarcity.",
        citations: [
          { evidenceId: "evidence-1", quote: "attention economy" },
        ],
        insufficientEvidence: false,
      },
      ["evidence-1"],
    );
  });

  assert.throws(() => {
    validateKnowledgeAnswerCitations(
      {
        answer: "Unsupported answer",
        citations: [
          { evidenceId: "evidence-99", quote: "not sent" },
        ],
        insufficientEvidence: false,
      },
      ["evidence-1"],
    );
  }, /not provided/);
});

test("source cleanup waits seven complete days after verification", () => {
  const source = sourceDocument();
  const almostReady = new Date(
    Date.parse(verifiedAt) + RETENTION_PERIOD_MS - 1,
  );
  const ready = new Date(Date.parse(verifiedAt) + RETENTION_PERIOD_MS);

  assert.equal(evaluateSourceCleanup(source, almostReady).eligible, false);
  assert.deepEqual(
    evaluateSourceCleanup(source, almostReady).blockers,
    ["retention-not-elapsed"],
  );
  assert.equal(evaluateSourceCleanup(source, ready).eligible, true);
});

test("failed processing and missing evidence permanently block source cleanup", () => {
  const failed = sourceDocument({ failedJobs: 1 });
  const missingEvidence = sourceDocument({ evidenceSaved: false });
  const now = new Date(Date.parse(verifiedAt) + RETENTION_PERIOD_MS * 2);

  assert.equal(evaluateSourceCleanup(failed, now).eligible, false);
  assert.ok(
    evaluateSourceCleanup(failed, now).blockers.includes("processing-failed"),
  );
  assert.equal(evaluateSourceCleanup(missingEvidence, now).eligible, false);
  assert.ok(
    evaluateSourceCleanup(missingEvidence, now).blockers.includes(
      "evidence-not-saved",
    ),
  );
});

test("user-protected sources are never automatically cleaned", () => {
  const source = sourceDocument({}, true);
  const now = new Date(Date.parse(verifiedAt) + RETENTION_PERIOD_MS * 2);
  const decision = evaluateSourceCleanup(source, now);

  assert.equal(decision.eligible, false);
  assert.ok(decision.blockers.includes("user-protected"));
});

test("AI raw messages wait for a retained summary and seven days", () => {
  const ready = new Date(Date.parse(verifiedAt) + RETENTION_PERIOD_MS);

  assert.equal(
    evaluateConversationCleanup(conversation(), ready).eligible,
    true,
  );
  assert.equal(
    evaluateConversationCleanup(
      conversation(verifiedAt, false),
      ready,
    ).eligible,
    false,
  );
  assert.ok(
    evaluateConversationCleanup(
      conversation(verifiedAt, false),
      ready,
    ).blockers.includes("summary-not-ready"),
  );
});

test("knowledge node aliases are normalized and deduplicated", () => {
  const node: KnowledgeNode = {
    id: "node-1",
    kind: "concept",
    title: "注意力经济",
    aliases: ["Attention Economy", "attention-economy"],
    summary: "Summary",
    evidenceIds: ["evidence-1"],
    createdAt: verifiedAt,
    updatedAt: verifiedAt,
    revision: 1,
  };

  assert.equal(normalizeKnowledgeTerm("  Attention   Economy! "), "attention economy");
  assert.equal(
    findKnowledgeNodeByTitleOrAlias([node], "ATTENTION ECONOMY")?.id,
    "node-1",
  );
  assert.equal(findKnowledgeNodeByTitleOrAlias([node], "媒介环境"), undefined);
});
