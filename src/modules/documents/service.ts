import { z } from "zod";
import { DOCUMENT_SECTIONS, type DocumentInput, type DocumentRecord, type DocumentRevision } from "../../db/documents.types";
import type { Store, UserRecord } from "../../db/store";

export const documentCodeSchema = z.string().trim().regex(/^SOP-[A-Z0-9]{2,16}-[0-9]{3,6}$/, "Use SOP-AREA-001 (uppercase area, 3-6 digits)");
// XML 1.0 permits these code points. Reject invalid controls and unpaired
// surrogates rather than producing a document an office reader cannot open.
const xmlText = (value: string) => /^[\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]*$/u.test(value);
const section = z.string().trim().min(1).max(20000).refine(xmlText, "Text contains unsupported control characters");
export const documentInputSchema = z.object({
  title: z.string().trim().min(1).max(200).refine(xmlText, "Text contains unsupported control characters"),
  reviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Review date must be a real calendar date"),
  sections: z.object({ purpose: section, scope: section, prerequisites: section, procedure: section, verification: section, escalation: section }).strict(),
  changeSummary: z.string().trim().min(1).max(2000).refine(xmlText, "Text contains unsupported control characters"),
}).strict();

export class DocumentError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string) { super(message); }
}
export function isStale(reviewDate: string, now = Date.now()): boolean {
  return reviewDate < new Date(now).toISOString().slice(0, 10);
}
function snapshot(id: string, revision: number, input: DocumentInput, actor: UserRecord): DocumentRevision {
  return { ...input, sections: Object.fromEntries(DOCUMENT_SECTIONS.map((key) => [key, input.sections[key]])) as DocumentInput["sections"], documentId: id, revision, actorUserId: actor.id, actorEmail: actor.email, createdAt: Date.now() };
}
async function requireDocument(store: Store, id: string): Promise<DocumentRecord> {
  const document = await store.getDocument(id);
  if (!document) throw new DocumentError(404, "not_found", "Document not found");
  return document;
}
function writer(actor: UserRecord) {
  if (actor.role === "readonly") throw new DocumentError(403, "forbidden", "Technician or admin role required");
}
export async function createDocument(store: Store, code: string, input: DocumentInput, actor: UserRecord, ip: string) {
  writer(actor);
  return store.transaction(async (tx) => {
    if (await tx.getDocumentByCode(code)) throw new DocumentError(409, "code_conflict", "Document code already exists");
    const revision = snapshot(crypto.randomUUID(), 1, input, actor);
    const document: DocumentRecord = { id: revision.documentId, code, status: "draft", latestRevision: 1, publishedRevision: null, createdAt: revision.createdAt, updatedAt: revision.createdAt };
    await tx.createDocument(document, revision);
    await tx.appendAudit({ action: "document.create", actorUserId: actor.id, actorEmail: actor.email, entityType: "document", entityId: document.id, details: { before: null, after: document, revision: 1, changeSummary: input.changeSummary }, ip });
    return { document, revision, stale: isStale(revision.reviewDate) };
  });
}
export async function reviseDocument(store: Store, id: string, expectedRevision: number, input: DocumentInput, actor: UserRecord, ip: string) {
  writer(actor);
  return store.transaction(async (tx) => {
    const before = await requireDocument(tx, id);
    if (before.status === "archived") throw new DocumentError(409, "archived", "Archived documents are retained and cannot be edited");
    const revision = snapshot(id, expectedRevision + 1, input, actor);
    const document = await tx.appendDocumentRevision(id, expectedRevision, revision);
    if (!document) throw new DocumentError(409, "revision_conflict", "This document changed. Reload its latest revision before saving");
    await tx.appendAudit({ action: "document.revise", actorUserId: actor.id, actorEmail: actor.email, entityType: "document", entityId: id, details: { before, after: document, revision: revision.revision, changeSummary: input.changeSummary }, ip });
    return { document, revision, stale: isStale(revision.reviewDate) };
  });
}
export async function transitionDocument(store: Store, id: string, expectedRevision: number, status: "published" | "archived", actor: UserRecord, ip: string) {
  if (actor.role !== "admin") throw new DocumentError(403, "forbidden", "Admin approval required");
  return store.transaction(async (tx) => {
    const before = await requireDocument(tx, id);
    const document = await tx.transitionDocument(id, expectedRevision, status);
    if (!document) throw new DocumentError(409, "revision_conflict", "Document changed or is archived. Reload before continuing");
    await tx.appendAudit({ action: status === "published" ? "document.publish" : "document.archive", actorUserId: actor.id, actorEmail: actor.email, entityType: "document", entityId: id, details: { before, after: document, approvedRevision: status === "published" ? expectedRevision : null }, ip });
    return { document };
  });
}
export async function readDocument(store: Store, id: string, actor: UserRecord, selectedRevision?: number) {
  const document = await requireDocument(store, id);
  const readonly = actor.role === "readonly";
  if (readonly && (document.status !== "published" || document.publishedRevision === null)) throw new DocumentError(404, "not_found", "Document not found");
  const revisionNumber = selectedRevision ?? (readonly ? document.publishedRevision! : document.latestRevision);
  if (readonly && revisionNumber !== document.publishedRevision) throw new DocumentError(404, "not_found", "Revision not available");
  const revision = await store.getDocumentRevision(id, revisionNumber);
  if (!revision) throw new DocumentError(404, "not_found", "Revision not found");
  return { document, revision, stale: isStale(revision.reviewDate) };
}
