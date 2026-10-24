import type { Evidence, KnowledgeAnswer } from "./domain.ts";

export interface SelectionAiPayload {
  selectedText: string;
  question: string;
  contextPolicy: "selection-only";
}

export interface KnowledgeEvidencePayload {
  evidenceId: string;
  excerpt: string;
}

const MIN_EVIDENCE_EXCERPT_CHARACTERS = 48;

export interface KnowledgeAiPayload {
  question: string;
  evidence: KnowledgeEvidencePayload[];
  contextPolicy: "retrieved-evidence-only";
  insufficientEvidence: boolean;
}

export function buildSelectionAiPayload(
  selectedText: string,
  question: string,
): SelectionAiPayload {
  const normalizedSelection = selectedText.trim();
  const normalizedQuestion = question.trim();

  if (!normalizedSelection) {
    throw new Error("A selection is required before asking AI.");
  }

  if (!normalizedQuestion) {
    throw new Error("A question is required before asking AI.");
  }

  return {
    selectedText: normalizedSelection,
    question: normalizedQuestion,
    contextPolicy: "selection-only",
  };
}

export function buildKnowledgeAiPayload(
  question: string,
  rankedEvidence: readonly Evidence[],
  maxExcerptCharacters = 12_000,
): KnowledgeAiPayload {
  const normalizedQuestion = question.trim();
  if (!normalizedQuestion) {
    throw new Error("A question is required before querying the knowledge base.");
  }

  const uniqueEvidence = new Map<string, Evidence>();
  for (const item of rankedEvidence) {
    if (!item.permanent || !item.excerpt.trim()) {
      continue;
    }
    if (!uniqueEvidence.has(item.id)) {
      uniqueEvidence.set(item.id, item);
    }
  }

  const selected: KnowledgeEvidencePayload[] = [];
  let usedCharacters = 0;

  for (const item of uniqueEvidence.values()) {
    const excerpt = item.excerpt.trim();
    const remaining = maxExcerptCharacters - usedCharacters;
    if (remaining < MIN_EVIDENCE_EXCERPT_CHARACTERS) {
      break;
    }

    if (excerpt.length > remaining) {
      break;
    }

    selected.push({
      evidenceId: item.id,
      excerpt,
    });
    usedCharacters += excerpt.length;
  }

  return {
    question: normalizedQuestion,
    evidence: selected,
    contextPolicy: "retrieved-evidence-only",
    insufficientEvidence: selected.length === 0,
  };
}

export function validateKnowledgeAnswerCitations(
  answer: KnowledgeAnswer,
  sentEvidenceIds: readonly string[],
): void {
  const knownIds = new Set(sentEvidenceIds);
  const citedIds = new Set<string>();

  for (const citation of answer.citations) {
    if (!knownIds.has(citation.evidenceId)) {
      throw new Error(
        `The answer cited evidence that was not provided: ${citation.evidenceId}`,
      );
    }
    if (!citation.quote.trim()) {
      throw new Error(`Citation ${citation.evidenceId} has an empty quote.`);
    }
    citedIds.add(citation.evidenceId);
  }

  if (!answer.insufficientEvidence && citedIds.size === 0) {
    throw new Error("A substantive knowledge answer must include evidence.");
  }
}
