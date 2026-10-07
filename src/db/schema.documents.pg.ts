import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const documents = pgTable("documents", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  status: text("status", { enum: ["draft", "published", "archived"] }).notNull(),
  latestRevision: integer("latest_revision").notNull(),
  publishedRevision: integer("published_revision"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [index("documents_status_idx").on(t.status), check("documents_status_check", sql`${t.status} in ('draft','published','archived')`), check("documents_revision_check", sql`${t.latestRevision} >= 1`)]);

export const documentRevisions = pgTable("document_revisions", {
  documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "restrict" }),
  revision: integer("revision").notNull(),
  title: text("title").notNull(),
  reviewDate: text("review_date").notNull(),
  sections: text("sections").notNull(),
  changeSummary: text("change_summary").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  actorEmail: text("actor_email").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.documentId, t.revision] }), index("document_revisions_review_date_idx").on(t.reviewDate), check("document_revisions_revision_check", sql`${t.revision} >= 1`)]);
