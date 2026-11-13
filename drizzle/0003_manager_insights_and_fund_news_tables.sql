CREATE TABLE `manager_views` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`manager_id` text NOT NULL,
	`manager_name` text NOT NULL,
	`title` text NOT NULL,
	`source` text NOT NULL,
	`url` text NOT NULL,
	`published_date` text NOT NULL,
	`summary` text NOT NULL,
	`quote` text,
	`collected_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manager_views_mgr_url` ON `manager_views` (`manager_id`,`url`);
--> statement-breakpoint
CREATE TABLE `manager_statements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`manager_id` text NOT NULL,
	`fund_code` text NOT NULL,
	`fund_name` text NOT NULL,
	`kind` text NOT NULL,
	`period_label` text NOT NULL,
	`published_date` text NOT NULL,
	`excerpt` text NOT NULL,
	`section` text NOT NULL,
	`source_url` text NOT NULL,
	`collected_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manager_statements_mgr_fund_period` ON `manager_statements` (`manager_id`,`fund_code`,`period_label`);
--> statement-breakpoint
CREATE TABLE `fund_news` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fund_code` text NOT NULL,
	`title` text NOT NULL,
	`source` text NOT NULL,
	`url` text NOT NULL,
	`published_date` text NOT NULL,
	`relation` text NOT NULL,
	`collected_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fund_news_code_url` ON `fund_news` (`fund_code`,`url`);
