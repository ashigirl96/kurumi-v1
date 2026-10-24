CREATE TABLE `egress_allowance` (
	`approval_id` text PRIMARY KEY NOT NULL,
	`agent_group_id` text NOT NULL,
	`session_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`account_handle` text NOT NULL,
	`method` text NOT NULL,
	`host` text NOT NULL,
	`path` text NOT NULL,
	`fingerprint` blob NOT NULL,
	`state` text NOT NULL,
	`expires_at` integer,
	`used_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "egress_allowance_state" CHECK("egress_allowance"."state" in ('pending', 'granted', 'used', 'denied')),
	CONSTRAINT "egress_allowance_expires_iff_granted" CHECK(("egress_allowance"."state" in ('granted', 'used')) = ("egress_allowance"."expires_at" is not null)),
	CONSTRAINT "egress_allowance_used_at_iff_used" CHECK(("egress_allowance"."state" = 'used') = ("egress_allowance"."used_at" is not null))
);
--> statement-breakpoint
CREATE INDEX `egress_allowance_session_fingerprint` ON `egress_allowance` (`session_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `egress_allowance_agent_group_state` ON `egress_allowance` (`agent_group_id`,`state`);--> statement-breakpoint
CREATE TABLE `egress_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`priority` integer NOT NULL,
	`effect` text NOT NULL,
	`account_handle` text,
	`service` text,
	`host` text,
	`method` text,
	`path` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "egress_rule_one_target" CHECK(("egress_rule"."account_handle" is null) <> ("egress_rule"."service" is null)),
	CONSTRAINT "egress_rule_effect" CHECK("egress_rule"."effect" in ('approve', 'allow')),
	CONSTRAINT "egress_rule_exact_host" CHECK("egress_rule"."host" is null or instr("egress_rule"."host", '*') = 0),
	CONSTRAINT "egress_rule_rooted_path" CHECK("egress_rule"."path" is null or substr("egress_rule"."path", 1, 1) = '/')
);
--> statement-breakpoint
CREATE INDEX `egress_rule_account_handle` ON `egress_rule` (`account_handle`);--> statement-breakpoint
CREATE INDEX `egress_rule_service` ON `egress_rule` (`service`);