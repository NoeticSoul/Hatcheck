CREATE TABLE `asset_interfaces` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`mac` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `asset_interfaces_asset_id_idx` ON `asset_interfaces` (`asset_id`);--> statement-breakpoint
CREATE INDEX `asset_interfaces_mac_idx` ON `asset_interfaces` (`mac`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`asset_type` text DEFAULT 'device' NOT NULL,
	`status` text DEFAULT 'in_stock' NOT NULL,
	`location_id` text,
	`model` text,
	`manufacturer` text,
	`notes` text,
	`asset_tag` text,
	`asset_tag_norm` text,
	`serial_number` text,
	`serial_number_norm` text,
	`system_uuid` text,
	`system_uuid_norm` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_asset_tag_norm_unique` ON `assets` (`asset_tag_norm`);--> statement-breakpoint
CREATE UNIQUE INDEX `assets_serial_number_norm_unique` ON `assets` (`serial_number_norm`);--> statement-breakpoint
CREATE UNIQUE INDEX `assets_system_uuid_norm_unique` ON `assets` (`system_uuid_norm`);--> statement-breakpoint
CREATE INDEX `assets_status_idx` ON `assets` (`status`);--> statement-breakpoint
CREATE INDEX `assets_location_id_idx` ON `assets` (`location_id`);--> statement-breakpoint
CREATE TABLE `custody_events` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`at` integer NOT NULL,
	`type` text NOT NULL,
	`holder_user_id` text,
	`holder_name` text,
	`location_id` text,
	`location_name` text,
	`note` text,
	`actor_user_id` text,
	`actor_email` text,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `custody_events_asset_at_idx` ON `custody_events` (`asset_id`,`at`);--> statement-breakpoint
CREATE TABLE `exception_records` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`asset_id` text,
	`import_row_id` text,
	`details` text,
	`resolved_by_user_id` text,
	`resolved_at` integer,
	`resolution_note` text
);
--> statement-breakpoint
CREATE INDEX `exception_records_status_idx` ON `exception_records` (`status`);--> statement-breakpoint
CREATE INDEX `exception_records_at_idx` ON `exception_records` (`at`);--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor_user_id` text,
	`actor_email` text,
	`filename` text,
	`file_hash` text NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`total_rows` integer DEFAULT 0 NOT NULL,
	`created_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`collision_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `import_jobs_file_hash_idx` ON `import_jobs` (`file_hash`);--> statement-breakpoint
CREATE TABLE `import_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`row_number` integer NOT NULL,
	`outcome` text NOT NULL,
	`message` text,
	`asset_id` text,
	`raw` text,
	FOREIGN KEY (`job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `import_rows_job_id_idx` ON `import_rows` (`job_id`);--> statement-breakpoint
CREATE TABLE `locations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'room' NOT NULL,
	`parent_id` text,
	`description` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `locations_parent_id_idx` ON `locations` (`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `locations_parent_name_uq` ON `locations` (`parent_id`,`name`);