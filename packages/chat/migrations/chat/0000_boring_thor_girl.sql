CREATE TABLE `messaging_group` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`instance` text DEFAULT '' NOT NULL,
	`platform_id` text NOT NULL,
	`name` text NOT NULL,
	`is_group` integer NOT NULL,
	`unknown_sender_policy` text NOT NULL,
	`denied_at` integer,
	`detached_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messaging_group_key` ON `messaging_group` (`channel`,`instance`,`platform_id`);--> statement-breakpoint
CREATE TABLE `wiring` (
	`id` text PRIMARY KEY NOT NULL,
	`messaging_group_id` text NOT NULL,
	`agent_group_id` text NOT NULL,
	`engage_mode` text NOT NULL,
	`engage_pattern` text,
	`session_mode` text NOT NULL,
	`sender_scope` text NOT NULL,
	`accumulate` integer NOT NULL,
	`threads` integer,
	`priority` integer NOT NULL,
	FOREIGN KEY (`messaging_group_id`) REFERENCES `messaging_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_group_id`) REFERENCES `agent_group`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wiring_key` ON `wiring` (`messaging_group_id`,`agent_group_id`);