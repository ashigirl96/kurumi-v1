PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_account_grant` (
	`agent_group_id` text NOT NULL,
	`account_id` text NOT NULL,
	`vendor` text NOT NULL,
	`service` text NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` integer NOT NULL,
	PRIMARY KEY(`agent_group_id`, `account_id`, `service`),
	FOREIGN KEY (`agent_group_id`) REFERENCES `agent_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`,`vendor`) REFERENCES `account`(`id`,`vendor`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "account_grant_service_of_vendor" CHECK(((vendor = 'anthropic' AND service IN ('anthropic-api')) OR (vendor = 'google' AND service IN ('gmail','google-drive','google-calendar')) OR (vendor = 'notion' AND service IN ('notion')) OR (vendor = 'github' AND service IN ('github'))))
);
--> statement-breakpoint
INSERT INTO `__new_account_grant`("agent_group_id", "account_id", "vendor", "service", "granted_by", "granted_at") SELECT "agent_group_id", "account_id", "vendor", "service", "granted_by", "granted_at" FROM `account_grant`;--> statement-breakpoint
DROP TABLE `account_grant`;--> statement-breakpoint
ALTER TABLE `__new_account_grant` RENAME TO `account_grant`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `account_grant_group_service` ON `account_grant` (`agent_group_id`,`service`);