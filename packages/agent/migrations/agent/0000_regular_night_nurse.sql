CREATE TABLE `agent_group` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`folder` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_group_folder_unique` ON `agent_group` (`folder`);