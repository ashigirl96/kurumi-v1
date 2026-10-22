CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor` text NOT NULL,
	`label` text NOT NULL,
	`subject` text,
	`kind` text NOT NULL,
	`services` text NOT NULL,
	`material` blob NOT NULL,
	`access_expires_at` integer,
	`status` text NOT NULL,
	`auto_grant` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_vendor_label` ON `account` (`vendor`,`label`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_vendor_subject` ON `account` (`vendor`,`subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_id_vendor` ON `account` (`id`,`vendor`);--> statement-breakpoint
CREATE TABLE `account_grant` (
	`agent_group_id` text NOT NULL,
	`account_id` text NOT NULL,
	`vendor` text NOT NULL,
	`service` text NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` integer NOT NULL,
	PRIMARY KEY(`agent_group_id`, `account_id`, `service`),
	FOREIGN KEY (`agent_group_id`) REFERENCES `agent_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`,`vendor`) REFERENCES `account`(`id`,`vendor`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "account_grant_service_of_vendor" CHECK(((vendor = 'anthropic' AND service IN ('anthropic-api')) OR (vendor = 'google' AND service IN ('gmail','google-calendar')) OR (vendor = 'notion' AND service IN ('notion')) OR (vendor = 'github' AND service IN ('github'))))
);
--> statement-breakpoint
CREATE INDEX `account_grant_group_service` ON `account_grant` (`agent_group_id`,`service`);--> statement-breakpoint
CREATE TABLE `default_account` (
	`agent_group_id` text NOT NULL,
	`service` text NOT NULL,
	`account_id` text NOT NULL,
	`vendor` text NOT NULL,
	PRIMARY KEY(`agent_group_id`, `service`),
	FOREIGN KEY (`agent_group_id`,`account_id`,`service`) REFERENCES `account_grant`(`agent_group_id`,`account_id`,`service`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`,`vendor`) REFERENCES `account`(`id`,`vendor`) ON UPDATE no action ON DELETE cascade
);
