CREATE TABLE `document_revisions` (
	`document_id` text NOT NULL,
	`revision` integer NOT NULL,
	`title` text NOT NULL,
	`review_date` text NOT NULL,
	`sections` text NOT NULL,
	`change_summary` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`document_id`, `revision`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "document_revisions_revision_check" CHECK("document_revisions"."revision" >= 1)
);
--> statement-breakpoint
CREATE INDEX `document_revisions_review_date_idx` ON `document_revisions` (`review_date`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`status` text NOT NULL,
	`latest_revision` integer NOT NULL,
	`published_revision` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "documents_status_check" CHECK("documents"."status" in ('draft','published','archived')),
	CONSTRAINT "documents_revision_check" CHECK("documents"."latest_revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_code_unique` ON `documents` (`code`);--> statement-breakpoint
CREATE INDEX `documents_status_idx` ON `documents` (`status`);