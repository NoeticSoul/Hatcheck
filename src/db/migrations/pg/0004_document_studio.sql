CREATE TABLE "document_revisions" (
	"document_id" text NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"review_date" text NOT NULL,
	"sections" text NOT NULL,
	"change_summary" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_email" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "document_revisions_document_id_revision_pk" PRIMARY KEY("document_id","revision"),
	CONSTRAINT "document_revisions_revision_check" CHECK ("document_revisions"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"status" text NOT NULL,
	"latest_revision" integer NOT NULL,
	"published_revision" integer,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "documents_code_unique" UNIQUE("code"),
	CONSTRAINT "documents_status_check" CHECK ("documents"."status" in ('draft','published','archived')),
	CONSTRAINT "documents_revision_check" CHECK ("documents"."latest_revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_revisions_review_date_idx" ON "document_revisions" USING btree ("review_date");--> statement-breakpoint
CREATE INDEX "documents_status_idx" ON "documents" USING btree ("status");