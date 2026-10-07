CREATE TABLE `mutation_locks` (`key` text PRIMARY KEY NOT NULL, `value` integer DEFAULT 0 NOT NULL);
--> statement-breakpoint
INSERT INTO `mutation_locks` (`key`, `value`) VALUES ('application', 0);
--> statement-breakpoint
DROP INDEX `users_oidc_subject_unique`;
--> statement-breakpoint
ALTER TABLE `users` ADD `oidc_issuer` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_oidc_identity_uq` ON `users` (`oidc_issuer`, `oidc_subject`);
--> statement-breakpoint
CREATE TABLE `custody_events_next` (
 `id` text PRIMARY KEY NOT NULL,
 `asset_id` text NOT NULL REFERENCES `assets` (`id`) ON DELETE cascade,
 `sequence` integer NOT NULL,
 `at` integer NOT NULL,
 `type` text NOT NULL,
 `holder_user_id` text,
 `holder_name` text,
 `location_id` text,
 `location_name` text,
 `note` text,
 `actor_user_id` text,
 `actor_email` text
);
--> statement-breakpoint
INSERT INTO custody_events_next
 (id, asset_id, sequence, at, type, holder_user_id, holder_name, location_id, location_name, note, actor_user_id, actor_email)
SELECT id, asset_id, row_number() OVER (PARTITION BY asset_id ORDER BY at, id COLLATE BINARY),
 at, type, holder_user_id, holder_name, location_id, location_name, note, actor_user_id, actor_email
FROM custody_events;
--> statement-breakpoint
DROP TABLE custody_events;
--> statement-breakpoint
ALTER TABLE custody_events_next RENAME TO custody_events;
--> statement-breakpoint
CREATE INDEX custody_events_asset_at_idx ON custody_events (asset_id, at);
--> statement-breakpoint
CREATE UNIQUE INDEX custody_events_asset_sequence_uq ON custody_events (asset_id, sequence);
