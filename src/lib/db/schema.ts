import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// SPEC.md § Data model — all timestamps are unix epoch seconds, JSON columns
// are stored as text and parsed at the boundary.

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  sourceVideoPath: text("source_video_path"),
  status: text("status").notNull().default("created"),
  platformPreset: text("platform_preset"),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

export const assets = sqliteTable("assets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").references(() => projects.id),
  type: text("type").notNull(), // source | broll | sfx
  path: text("path").notNull(),
  originalName: text("original_name"),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

export const jobs = sqliteTable("jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  type: text("type").notNull(),
  status: text("status").notNull().default("queued"), // queued | running | done | failed
  progress: integer("progress").notNull().default(0), // 0–100
  error: text("error"),
  payload: text("payload"), // JSON
  /** Incremented by each claim, so a running job's attempts includes itself. */
  attempts: integer("attempts").notNull().default(0),
  /** Initial try + 2 retries. Exceeding this marks the job `failed`. */
  maxAttempts: integer("max_attempts").notNull().default(3),
  /**
   * Earliest time this job may be claimed; retry backoff pushes it forward.
   * NOTE: epoch MILLISECONDS, unlike the epoch-second timestamps elsewhere in
   * this schema — backoff needs sub-second resolution.
   */
  runAt: integer("run_at")
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

export const transcripts = sqliteTable("transcripts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  segments: text("segments").notNull(), // JSON: word-level { text, start, end }
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

export const clips = sqliteTable("clips", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  inPoint: real("in_point").notNull(), // seconds into source
  outPoint: real("out_point").notNull(),
  score: real("score"),
  title: text("title"),
  status: text("status").notNull().default("candidate"),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

export const clipEdits = sqliteTable("clip_edits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clipId: integer("clip_id")
    .notNull()
    .references(() => clips.id),
  // JSON: caption style + edited words, crop keyframes, aspect ratio,
  // timeline (segments, B-roll slots, transitions, SFX, CTA overlays), template id
  state: text("state").notNull(),
  updatedAt: integer("updated_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

export const exports = sqliteTable("exports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clipId: integer("clip_id")
    .notNull()
    .references(() => clips.id),
  preset: text("preset").notNull(),
  outputPath: text("output_path"),
  status: text("status").notNull().default("queued"),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
});
