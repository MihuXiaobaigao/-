export type IsoDateTime = string;

export type SourceKind = "pdf" | "epub" | "web" | "manual";
export type EvidenceKind =
  | "source-excerpt"
  | "text-note"
  | "annotation"
  | "canvas-recognition"
  | "ai-summary"
  | "dictionary-context";

export type KnowledgeNodeKind =
  | "concept"
  | "claim"
  | "person"
  | "book"
  | "paper"
  | "passage"
  | "note"
  | "canvas"
  | "ai-summary"
  | "word";

export type RelationKind =
  | "supports"
  | "contradicts"
  | "causes"
  | "part-of"
  | "similar-to"
  | "contrasts-with"
  | "derived-from"
  | "defined-by"
  | "example-of"
  | "personally-related";

export interface SourceLocator {
  page?: number;
  chapter?: string;
  paragraphId?: string;
  sentenceId?: string;
  charStart?: number;
  charEnd?: number;
  canvasRegion?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  sourceId: string;
  locator: SourceLocator;
  excerpt: string;
  capturedAt: IsoDateTime;
  permanent: boolean;
}

export interface SourceDocument {
  id: string;
  title: string;
  author?: string;
  kind: SourceKind;
  fileAssetId: string;
  fileSha256: string;
  byteSize: number;
  importedAt: IsoDateTime;
  originalAvailable: boolean;
  processing: {
    extractionCompletedAt?: IsoDateTime;
    knowledgeIndexedAt?: IsoDateTime;
    verificationPassedAt?: IsoDateTime;
    evidenceSaved: boolean;
    summaryReady: boolean;
    pendingJobs: number;
    failedJobs: number;
    blockedReason?: string;
  };
  retention: {
    verifiedAt?: IsoDateTime;
    eligibleAt?: IsoDateTime;
    rawDeletedAt?: IsoDateTime;
    protectedByUser: boolean;
  };
}

export interface AiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: IsoDateTime;
  citationIds: string[];
}

export type AiConversationScope = "selection" | "knowledge-base";

export interface AiConversation {
  id: string;
  scope: AiConversationScope;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  messages: AiMessage[];
  retention: {
    knowledgeProcessedAt?: IsoDateTime;
    summaryReady: boolean;
    evidenceLinked: boolean;
    eligibleAt?: IsoDateTime;
    rawDeletedAt?: IsoDateTime;
    processedSummaryId?: string;
  };
}

export interface KnowledgeNode {
  id: string;
  kind: KnowledgeNodeKind;
  title: string;
  aliases: string[];
  summary: string;
  evidenceIds: string[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  revision: number;
}

export interface KnowledgeEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relation: RelationKind;
  rationale: string;
  evidenceIds: string[];
  confidence: number;
  generatedBy: "ai";
  generatedAt: IsoDateTime;
}

export interface CanvasBoard {
  id: string;
  annotationId?: string;
  sourceId?: string;
  locator?: SourceLocator;
  knowledgeNodeIds: string[];
  title: string;
  recognizedText: string;
  assetIds: string[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface DictionaryOccurrence {
  evidenceId: string;
  sourceId: string;
  sentence: string;
  translation?: string;
  markedAt: IsoDateTime;
}

export interface DictionaryEntry {
  id: string;
  lemma: string;
  displayForm: string;
  phonetic?: string;
  partOfSpeech?: string;
  definitionZh: string;
  occurrenceCount: number;
  occurrences: DictionaryOccurrence[];
  firstMarkedAt: IsoDateTime;
  lastMarkedAt: IsoDateTime;
  mastery: "new" | "learning" | "known";
}

export interface KnowledgeAnswerCitation {
  evidenceId: string;
  quote: string;
}

export interface KnowledgeAnswer {
  answer: string;
  citations: KnowledgeAnswerCitation[];
  insufficientEvidence: boolean;
}
