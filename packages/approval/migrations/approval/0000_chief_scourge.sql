CREATE TABLE `pending_approval` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`agent_group_id` text,
	`session_id` text,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`payload` text NOT NULL,
	`approvers` text NOT NULL,
	`status` text NOT NULL,
	`decided_by` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`handled_at` integer,
	CONSTRAINT "pending_approval_decided_iff_not_pending" CHECK(("pending_approval"."status" = 'pending') = ("pending_approval"."decided_by" IS NULL AND "pending_approval"."decided_at" IS NULL)),
	CONSTRAINT "pending_approval_handled_only_when_decided" CHECK("pending_approval"."handled_at" IS NULL OR "pending_approval"."status" <> 'pending')
);
