CREATE TABLE `egress_log` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`agent_group_id` text NOT NULL,
	`session_id` text NOT NULL,
	`host` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`account` text,
	`service` text,
	`decision` text NOT NULL,
	`refusal` text,
	`status` integer,
	`duration_ms` integer NOT NULL,
	CONSTRAINT "egress_log_refusal" CHECK(("egress_log"."decision" = 'refused') = ("egress_log"."refusal" is not null)),
	CONSTRAINT "egress_log_account" CHECK(("egress_log"."decision" = 'injected') = ("egress_log"."account" is not null))
);
--> statement-breakpoint
CREATE INDEX `egress_log_at` ON `egress_log` (`at`);