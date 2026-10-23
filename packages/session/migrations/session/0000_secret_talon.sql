CREATE TABLE `container` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`token_hash` blob NOT NULL,
	`status` text NOT NULL,
	`image` text NOT NULL,
	`started_at` integer NOT NULL,
	`last_seen_at` integer,
	`current_tool` text,
	`tool_deadline_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `container_token_hash_unique` ON `container` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `container_one_per_session` ON `container` (`session_id`) WHERE status in ('starting','running');--> statement-breakpoint
CREATE TABLE `inbound_message` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`trigger` integer NOT NULL,
	`status` text NOT NULL,
	`claimed_by` text,
	`process_after` integer,
	`tries` integer DEFAULT 0 NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_seq` ON `inbound_message` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `inbound_due` ON `inbound_message` (`status`,`process_after`);--> statement-breakpoint
CREATE TABLE `outbound_message` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`in_reply_to` text,
	`to` text,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`platform_message_id` text,
	`deliver_after` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbound_seq` ON `outbound_message` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `outbound_queued` ON `outbound_message` (`status`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_group_id` text NOT NULL,
	`messaging_group_id` text,
	`thread_id` text,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`last_active_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_group_id`) REFERENCES `agent_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`messaging_group_id`) REFERENCES `messaging_group`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_key` ON `session` (`agent_group_id`,coalesce("messaging_group_id", ''),coalesce("thread_id", ''),`mode`);--> statement-breakpoint
CREATE TABLE `session_state` (
	`session_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`session_id`, `key`),
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
