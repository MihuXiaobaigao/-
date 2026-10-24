import type {
  AiConversation,
  IsoDateTime,
  SourceDocument,
} from "./domain.ts";

export const RETENTION_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

export type CleanupBlocker =
  | "original-already-deleted"
  | "processing-failed"
  | "processing-incomplete"
  | "evidence-not-saved"
  | "summary-not-ready"
  | "verification-failed"
  | "user-protected"
  | "retention-not-elapsed";

export interface CleanupDecision {
  eligible: boolean;
  eligibleAt?: IsoDateTime;
  blockers: CleanupBlocker[];
}

function elapsedSince(
  reference: IsoDateTime | undefined,
  now: Date,
): number | undefined {
  if (!reference) {
    return undefined;
  }
  const start = Date.parse(reference);
  if (Number.isNaN(start)) {
    return undefined;
  }
  return now.getTime() - start;
}

export function evaluateSourceCleanup(
  source: SourceDocument,
  now: Date,
): CleanupDecision {
  const blockers: CleanupBlocker[] = [];

  if (!source.originalAvailable) {
    blockers.push("original-already-deleted");
  }
  if (source.processing.failedJobs > 0 || source.processing.blockedReason) {
    blockers.push("processing-failed");
  }
  if (source.processing.pendingJobs > 0) {
    blockers.push("processing-incomplete");
  }
  if (!source.processing.evidenceSaved) {
    blockers.push("evidence-not-saved");
  }
  if (!source.processing.summaryReady) {
    blockers.push("summary-not-ready");
  }
  if (!source.processing.verificationPassedAt) {
    blockers.push("verification-failed");
  }
  if (source.retention.protectedByUser) {
    blockers.push("user-protected");
  }

  const reference =
    source.retention.verifiedAt ?? source.processing.verificationPassedAt;
  const elapsed = elapsedSince(reference, now);

  if (elapsed === undefined || elapsed < RETENTION_PERIOD_MS) {
    blockers.push("retention-not-elapsed");
  }

  const eligibleAt =
    reference === undefined
      ? undefined
      : new Date(Date.parse(reference) + RETENTION_PERIOD_MS).toISOString();

  return {
    eligible: blockers.length === 0,
    eligibleAt,
    blockers,
  };
}

export function evaluateConversationCleanup(
  conversation: AiConversation,
  now: Date,
): CleanupDecision {
  const blockers: CleanupBlocker[] = [];

  if (conversation.retention.rawDeletedAt) {
    blockers.push("original-already-deleted");
  }
  if (!conversation.retention.summaryReady) {
    blockers.push("summary-not-ready");
  }
  if (!conversation.retention.evidenceLinked) {
    blockers.push("evidence-not-saved");
  }

  const reference = conversation.retention.knowledgeProcessedAt;
  const elapsed = elapsedSince(reference, now);

  if (elapsed === undefined || elapsed < RETENTION_PERIOD_MS) {
    blockers.push("retention-not-elapsed");
  }

  const eligibleAt =
    reference === undefined
      ? undefined
      : new Date(Date.parse(reference) + RETENTION_PERIOD_MS).toISOString();

  return {
    eligible: blockers.length === 0,
    eligibleAt,
    blockers,
  };
}
