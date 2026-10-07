import { and, asc, count, desc, eq, getTableColumns, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema.sqlite";
import { documents, documentRevisions } from "./schema.documents.sqlite";
import type { DocumentQuery, DocumentRevision, DocumentsStore } from "./documents.types";

function parse(row: typeof documentRevisions.$inferSelect): DocumentRevision {
  return { ...row, sections: JSON.parse(row.sections) as DocumentRevision["sections"] };
}
function conditions(query: Omit<DocumentQuery, "limit" | "offset">): SQL | undefined {
  const clauses: SQL[] = [];
  if (query.publishedOnly) clauses.push(eq(documents.status, "published"));
  if (query.status) clauses.push(eq(documents.status, query.status));
  if (query.staleBefore) clauses.push(lt(documentRevisions.reviewDate, query.staleBefore));
  if (query.q) {
    const pattern = `%${query.q.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const contains = (column: SQL) => sql`lower(${column}) like ${pattern} escape ${"\\"}`;
    clauses.push(or(contains(sql`${documents.code}`), contains(sql`${documentRevisions.title}`), contains(sql`${documentRevisions.sections}`))!);
  }
  return clauses.length ? and(...clauses) : undefined;
}

export function createSqliteDocuments<TRun>(db: BaseSQLiteDatabase<"sync", TRun, typeof schema>): DocumentsStore {
  const join = (query: { publishedOnly?: boolean }) => and(eq(documents.id, documentRevisions.documentId), eq(documentRevisions.revision, query.publishedOnly ? documents.publishedRevision : documents.latestRevision));
  return {
    async createDocument(document, revision) {
      db.insert(documents).values(document).run();
      db.insert(documentRevisions).values({ ...revision, sections: JSON.stringify(revision.sections) }).run();
    },
    async getDocument(id) {
      return db.select().from(documents).where(eq(documents.id, id)).get() ?? null;
    },
    async getDocumentByCode(code) {
      return db.select().from(documents).where(eq(documents.code, code)).get() ?? null;
    },
    async getDocumentRevision(id, revision) {
      const row = db.select().from(documentRevisions).where(and(eq(documentRevisions.documentId, id), eq(documentRevisions.revision, revision))).get();
      return row ? parse(row) : null;
    },
    async listDocumentRevisions(id, query) {
      return db.select().from(documentRevisions).where(eq(documentRevisions.documentId, id)).orderBy(desc(documentRevisions.revision)).limit(query.limit).offset(query.offset ?? 0).all().map(parse);
    },
    async listDocuments(query) {
      return db.select({ ...getTableColumns(documents), title: documentRevisions.title, reviewDate: documentRevisions.reviewDate, visibleRevision: documentRevisions.revision }).from(documents).innerJoin(documentRevisions, join(query)).where(conditions(query)).orderBy(asc(sql`${documents.code} collate binary`)).limit(query.limit).offset(query.offset ?? 0).all();
    },
    async countDocuments(query) {
      return db.select({ total: count() }).from(documents).innerJoin(documentRevisions, join(query)).where(conditions(query)).get()?.total ?? 0;
    },
    async appendDocumentRevision(id, expectedRevision, revision) {
      if (revision.documentId !== id || revision.revision !== expectedRevision + 1) throw new Error("Document revision does not match its expected predecessor");
      const document = db.update(documents).set({ latestRevision: expectedRevision + 1, updatedAt: revision.createdAt }).where(and(eq(documents.id, id), eq(documents.latestRevision, expectedRevision), ne(documents.status, "archived"))).returning().get();
      if (!document) return null;
      db.insert(documentRevisions).values({ ...revision, sections: JSON.stringify(revision.sections) }).run();
      return document;
    },
    async transitionDocument(id, expectedRevision, status) {
      return db.update(documents).set({ status, ...(status === "published" ? { publishedRevision: expectedRevision } : {}), updatedAt: Date.now() }).where(and(eq(documents.id, id), eq(documents.latestRevision, expectedRevision), ne(documents.status, "archived"))).returning().get() ?? null;
    },
  };
}
