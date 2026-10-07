/** Structured SOP revisions are immutable snapshots. No revision update/delete API. */
export const DOCUMENT_SECTIONS = ["purpose", "scope", "prerequisites", "procedure", "verification", "escalation"] as const;
export type DocumentSection = typeof DOCUMENT_SECTIONS[number];
export type DocumentSections = Record<DocumentSection, string>;
export type DocumentStatus = "draft" | "published" | "archived";

export interface DocumentRecord {
  id: string;
  code: string;
  status: DocumentStatus;
  latestRevision: number;
  publishedRevision: number | null;
  createdAt: number;
  updatedAt: number;
}
export interface DocumentRevision {
  documentId: string;
  revision: number;
  title: string;
  reviewDate: string;
  sections: DocumentSections;
  changeSummary: string;
  actorUserId: string;
  actorEmail: string;
  createdAt: number;
}
export interface DocumentInput {
  title: string;
  reviewDate: string;
  sections: DocumentSections;
  changeSummary: string;
}
export interface DocumentQuery {
  limit: number;
  offset?: number;
  q?: string;
  status?: DocumentStatus;
  publishedOnly?: boolean;
  staleBefore?: string;
}
export interface DocumentListItem extends DocumentRecord {
  title: string;
  reviewDate: string;
  visibleRevision: number;
}
export interface DocumentsStore {
  createDocument(document: DocumentRecord, revision: DocumentRevision): Promise<void>;
  getDocument(id: string): Promise<DocumentRecord | null>;
  getDocumentByCode(code: string): Promise<DocumentRecord | null>;
  getDocumentRevision(id: string, revision: number): Promise<DocumentRevision | null>;
  listDocumentRevisions(id: string, query: { limit: number; offset?: number }): Promise<DocumentRevision[]>;
  listDocuments(query: DocumentQuery): Promise<DocumentListItem[]>;
  countDocuments(query: Omit<DocumentQuery, "limit" | "offset">): Promise<number>;
  /** CAS master pointer followed by immutable insert; invoke inside Store.transaction. */
  appendDocumentRevision(id: string, expectedRevision: number, revision: DocumentRevision): Promise<DocumentRecord | null>;
  /** CAS transitions retain every revision and never delete history. */
  transitionDocument(id: string, expectedRevision: number, status: DocumentStatus): Promise<DocumentRecord | null>;
}
