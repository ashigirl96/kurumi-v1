PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_account` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor` text NOT NULL,
	`label` text NOT NULL,
	`subject` text,
	`kind` text NOT NULL,
	`auth_mode` text,
	`services` text NOT NULL,
	`material` blob NOT NULL,
	`access_expires_at` integer,
	`status` text NOT NULL,
	`auto_grant` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "account_auth_mode_of_vendor" CHECK(((vendor = 'anthropic' AND auth_mode IS NOT NULL AND auth_mode IN ('api-key','oauth-token')) OR (vendor = 'google' AND auth_mode IS NULL) OR (vendor = 'notion' AND auth_mode IS NULL) OR (vendor = 'github' AND auth_mode IS NULL)))
);
--> statement-breakpoint
INSERT INTO `__new_account`("id", "vendor", "label", "subject", "kind", "auth_mode", "services", "material", "access_expires_at", "status", "auto_grant", "created_at") SELECT "id", "vendor", "label", "subject", "kind", CASE WHEN "vendor" = 'anthropic' THEN 'api-key' END, "services", "material", "access_expires_at", "status", "auto_grant", "created_at" FROM `account`;--> statement-breakpoint
DROP TABLE `account`;--> statement-breakpoint
ALTER TABLE `__new_account` RENAME TO `account`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `account_vendor_label` ON `account` (`vendor`,`label`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_vendor_subject` ON `account` (`vendor`,`subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_id_vendor` ON `account` (`id`,`vendor`);