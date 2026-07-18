CREATE TABLE "asset_interfaces" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"mac" text NOT NULL,
	"label" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"asset_type" text DEFAULT 'device' NOT NULL,
	"status" text DEFAULT 'in_stock' NOT NULL,
	"location_id" text,
	"model" text,
	"manufacturer" text,
	"notes" text,
	"asset_tag" text,
	"asset_tag_norm" text,
	"serial_number" text,
	"serial_number_norm" text,
	"system_uuid" text,
	"system_uuid_norm" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "assets_asset_tag_norm_unique" UNIQUE("asset_tag_norm"),
	CONSTRAINT "assets_serial_number_norm_unique" UNIQUE("serial_number_norm"),
	CONSTRAINT "assets_system_uuid_norm_unique" UNIQUE("system_uuid_norm")
);
--> statement-breakpoint
CREATE TABLE "custody_events" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"at" bigint NOT NULL,
	"type" text NOT NULL,
	"holder_user_id" text,
	"holder_name" text,
	"location_id" text,
	"location_name" text,
	"note" text,
	"actor_user_id" text,
	"actor_email" text
);
--> statement-breakpoint
CREATE TABLE "exception_records" (
	"id" text PRIMARY KEY NOT NULL,
	"at" bigint NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"asset_id" text,
	"import_row_id" text,
	"details" text,
	"resolved_by_user_id" text,
	"resolved_at" bigint,
	"resolution_note" text
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"at" bigint NOT NULL,
	"actor_user_id" text,
	"actor_email" text,
	"filename" text,
	"file_hash" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"total_rows" bigint DEFAULT 0 NOT NULL,
	"created_count" bigint DEFAULT 0 NOT NULL,
	"skipped_count" bigint DEFAULT 0 NOT NULL,
	"collision_count" bigint DEFAULT 0 NOT NULL,
	"error_count" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"row_number" bigint NOT NULL,
	"outcome" text NOT NULL,
	"message" text,
	"asset_id" text,
	"raw" text
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'room' NOT NULL,
	"parent_id" text,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_interfaces" ADD CONSTRAINT "asset_interfaces_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_job_id_import_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."import_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_parent_id_locations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_interfaces_asset_id_idx" ON "asset_interfaces" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "asset_interfaces_mac_idx" ON "asset_interfaces" USING btree ("mac");--> statement-breakpoint
CREATE INDEX "assets_status_idx" ON "assets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "assets_location_id_idx" ON "assets" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "custody_events_asset_at_idx" ON "custody_events" USING btree ("asset_id","at");--> statement-breakpoint
CREATE INDEX "exception_records_status_idx" ON "exception_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "exception_records_at_idx" ON "exception_records" USING btree ("at");--> statement-breakpoint
CREATE INDEX "import_jobs_file_hash_idx" ON "import_jobs" USING btree ("file_hash");--> statement-breakpoint
CREATE INDEX "import_rows_job_id_idx" ON "import_rows" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "locations_parent_id_idx" ON "locations" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_parent_name_uq" ON "locations" USING btree ("parent_id","name");