ALTER TABLE `projects` ADD `status_note` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `transcribed` integer DEFAULT false NOT NULL;