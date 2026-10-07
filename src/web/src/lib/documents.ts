import { request } from "./api";
import type { DocumentInput, DocumentListItem, DocumentRecord, DocumentRevision, DocumentStatus } from "../../../db/documents.types";
export { DOCUMENT_SECTIONS } from "../../../db/documents.types";
export type { DocumentInput, DocumentRevision, DocumentStatus };
export const sectionLabels = { purpose: "Purpose", scope: "Scope", prerequisites: "Prerequisites", procedure: "Procedure", verification: "Verification", escalation: "Escalation" } as const;
export interface DocumentDetail { document: DocumentRecord; revision: DocumentRevision; stale: boolean }
export interface DocumentPage { items: (DocumentListItem & { stale: boolean })[]; total: number; limit: number; offset: number }
export const documentsApi = {
  list(query: { limit: number; offset: number; q?: string; status?: DocumentStatus; stale?: boolean; published?: boolean }): Promise<DocumentPage> {
    const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) });
    if (query.q) params.set("q", query.q);
    if (query.status) params.set("status", query.status);
    if (query.stale) params.set("stale", "true");
    if (query.published) params.set("published", "true");
    return request(`/api/v1/documents?${params}`);
  },
  create(code: string, input: DocumentInput): Promise<DocumentDetail> {
    return request("/api/v1/documents", { method: "POST", body: { code, ...input } });
  },
  get(id: string, revision?: number): Promise<DocumentDetail> {
    return request(`/api/v1/documents/${id}${revision === undefined ? "" : `?revision=${revision}`}`);
  },
  revise(id: string, expectedRevision: number, input: DocumentInput): Promise<DocumentDetail> {
    return request(`/api/v1/documents/${id}/revisions`, { method: "POST", body: { expectedRevision, ...input } });
  },
  history(id: string, offset = 0): Promise<{ items: DocumentRevision[]; total: number; limit: number; offset: number }> {
    return request(`/api/v1/documents/${id}/revisions?limit=25&offset=${offset}`);
  },
  transition(id: string, expectedRevision: number, action: "publish" | "archive"): Promise<{ document: DocumentRecord }> {
    return request(`/api/v1/documents/${id}/${action}`, { method: "POST", body: { expectedRevision } });
  },
  exportUrl(id: string, revision: number, format: "md" | "html" | "docx"): string {
    return `/api/v1/documents/${id}/export?revision=${revision}&format=${format}`;
  },
};
