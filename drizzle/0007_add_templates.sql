CREATE TABLE `templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text,
	`name` text NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`caption_preset` text NOT NULL,
	`caption_style` text NOT NULL,
	`aspect_ratio` text NOT NULL,
	`ctas` text DEFAULT '[]' NOT NULL,
	`brand_primary` text NOT NULL,
	`brand_secondary` text NOT NULL,
	`watermark_asset_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`watermark_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `templates_key_unique` ON `templates` (`key`);