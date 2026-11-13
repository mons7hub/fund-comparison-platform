CREATE TABLE `manager_coverage` (
	`manager_id` text PRIMARY KEY NOT NULL,
	`manager_name` text NOT NULL,
	`views_status` text DEFAULT 'pending' NOT NULL,
	`statements_status` text DEFAULT 'pending' NOT NULL,
	`batch_attempted_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `theme_news` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`theme` text NOT NULL,
	`title` text NOT NULL,
	`source` text NOT NULL,
	`url` text NOT NULL,
	`published_date` text NOT NULL,
	`collected_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `theme_news_theme_url` ON `theme_news` (`theme`,`url`);
