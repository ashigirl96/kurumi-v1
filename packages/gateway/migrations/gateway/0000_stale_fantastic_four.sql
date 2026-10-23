CREATE TABLE `gateway_ca` (
	`id` integer PRIMARY KEY NOT NULL,
	`cert_pem` text NOT NULL,
	`sealed_key` blob NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "gateway_ca_single_row" CHECK("gateway_ca"."id" = 1)
);
