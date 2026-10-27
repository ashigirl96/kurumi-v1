CREATE TABLE `connect_link` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`minted_for` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`request_id`) REFERENCES `connection_request`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `connection_request` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_group_id` text NOT NULL,
	`vendor` text NOT NULL,
	`services` text NOT NULL,
	`session_id` text,
	`state` text NOT NULL,
	`oauth_state` text,
	`pkce_verifier` blob,
	`card_message_id` text,
	`account_id` text,
	`requested_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`agent_group_id`) REFERENCES `agent_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_request_oauth_state_unique` ON `connection_request` (`oauth_state`);--> statement-breakpoint
CREATE UNIQUE INDEX `connection_request_live` ON `connection_request` (`agent_group_id`,`vendor`,`session_id`) WHERE "connection_request"."session_id" IS NOT NULL AND "connection_request"."state" IN ('open', 'authorizing');--> statement-breakpoint
CREATE TABLE `oauth_client` (
	`vendor` text PRIMARY KEY NOT NULL,
	`material` blob NOT NULL,
	`updated_at` integer NOT NULL
);
