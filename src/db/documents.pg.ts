import { and, asc, count, desc, eq, getTableColumns, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import * as schema from "./schema.pg";
import { documents, documentRevisions } from "./schema.documents.pg";
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

export function createPgDocuments(db: PgDatabase<PostgresJsQueryResultHKT, typeof schema>): DocumentsStore {
  const join = (query: { publishedOnly?: boolean }) => and(eq(documents.id, documentRevisions.documentId), eq(documentRevisions.revision, query.publishedOnly ? documents.publishedRevision : documents.latestRevision));
  return {
    async createDocument(document, revision) {
      await db.insert(documents).values(document);
      await db.insert(documentRevisions).values({ ...revision, sections: JSON.stringify(revision.sections) });
    },
    async getDocument(id) {
      return (await db.select().from(documents).where(eq(documents.id, id)))[0] ?? null;
    },
    async getDocumentByCode(code) {
      return (await db.select().from(documents).where(eq(documents.code, code)))[0] ?? null;
    },
    async getDocumentRevision(id, revision) {
      const row = (await db.select().from(documentRevisions).where(and(eq(documentRevisions.documentId, id), eq(documentRevisions.revision, revision))))[0];
      return row ? parse(row) : null;
    },
    async listDocumentRevisions(id, query) {
      return (await db.select().from(documentRevisions).where(eq(documentRevisions.documentId, id)).orderBy(desc(documentRevisions.revision)).limit(query.limit).offset(query.offset ?? 0)).map(parse);
    },
    async listDocuments(query) {
      return db.select({ ...getTableColumns(documents), title: documentRevisions.title, reviewDate: documentRevisions.reviewDate, visibleRevision: documentRevisions.revision }).from(documents).innerJoin(documentRevisions, join(query)).where(conditions(query)).orderBy(asc(sql`${documents.code} collate "C"`)).limit(query.limit).offset(query.offset ?? 0);
    },
    async countDocuments(query) {
      return (await db.select({ total: count() }).from(documents).innerJoin(documentRevisions, join(query)).where(conditions(query)))[0]?.total ?? 0;
    },
    async appendDocumentRevision(id, expectedRevision, revision) {
      if (revision.documentId !== id || revision.revision !== expectedRevision + 1) throw new Error("Document revision does not match its expected predecessor");
      const document = (await db.update(documents).set({ latestRevision: expectedRevision + 1, updatedAt: revision.createdAt }).where(and(eq(documents.id, id), eq(documents.latestRevision, expectedRevision), ne(documents.status, "archived"))).returning())[0];
      if (!document) return null;
      await db.insert(documentRevisions).values({ ...revision, sections: JSON.stringify(revision.sections) });
      return document;
    },
    async transitionDocument(id, expectedRevision, status) {
      return (await db.update(documents).set({ status, ...(status === "published" ? { publishedRevision: expectedRevision } : {}), updatedAt: Date.now() }).where(and(eq(documents.id, id), eq(documents.latestRevision, expectedRevision), ne(documents.status, "archived"))).returning())[0] ?? null;
    },
  };
}
