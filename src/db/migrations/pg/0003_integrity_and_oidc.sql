CREATE TABLE "mutation_locks" ("key" text PRIMARY KEY NOT NULL, "value" bigint DEFAULT 0 NOT NULL);
--> statement-breakpoint
INSERT INTO "mutation_locks" ("key", "value") VALUES ('application', 0);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_oidc_subject_unique";
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "oidc_issuer" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_oidc_identity_uq" ON "users" ("oidc_issuer", "oidc_subject");
--> statement-breakpoint
ALTER TABLE "custody_events" ADD COLUMN "sequence" bigint;
--> statement-breakpoint
WITH ordered AS (
 SELECT id, row_number() OVER (PARTITION BY asset_id ORDER BY at, id COLLATE "C") AS sequence
 FROM custody_events
)
UPDATE custody_events SET sequence = ordered.sequence FROM ordered WHERE custody_events.id = ordered.id;
--> statement-breakpoint
ALTER TABLE "custody_events" ALTER COLUMN "sequence" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "custody_events_asset_sequence_uq" ON "custody_events" ("asset_id", "sequence");
