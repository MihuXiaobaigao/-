import type { KnowledgeNode } from "./domain.ts";

export function normalizeKnowledgeTerm(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function findKnowledgeNodeByTitleOrAlias(
  nodes: readonly KnowledgeNode[],
  candidate: string,
): KnowledgeNode | undefined {
  const normalizedCandidate = normalizeKnowledgeTerm(candidate);
  if (!normalizedCandidate) {
    return undefined;
  }

  return nodes.find((node) => {
    if (normalizeKnowledgeTerm(node.title) === normalizedCandidate) {
      return true;
    }
    return node.aliases.some(
      (alias) => normalizeKnowledgeTerm(alias) === normalizedCandidate,
    );
  });
}
