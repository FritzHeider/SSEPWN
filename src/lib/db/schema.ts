import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// SPEC.md § Data model — all timestamps are unix epoch seconds, JSON columns
// are stored as text and parsed at the boundary.

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  sourceVideoPath: text("source_video_path"),
  // created | uploaded | ready | failed
  status: text("status").notNull().default("created"),
  platformPreset: text("platform_preset"),
  /** Human-readable reason the project is `failed`; cleared when it turns `ready`. */
  error: text("error"),
  /**
   * Non-fatal note about a pipeline step that was skipped, e.g. "no audio —
   * captions unavailable". Distinct from `error`: the project still works, it
   * just has less in it. Null when there is nothing to say.
   */
  statusNote: text("status_note"),
  /** True once a transcript has been written for this project (phase-03). */
  transcribed: integer("transcribed", { mode: "boolean" }).notNull().default(false),
  // Source metadata, written by the ingest handler once ffprobe has run
  // (SPEC.md § Feature checklist 1). Null until then.
  duration: real("duration"), // seconds
  width: integer("width"),
  height: integer("height"),
  fps: real("fps"),
  hasAudio: integer("has_audio", { mode: "boolean" }),
  /** Poster frame generated at ingest. */
  thumbnailPath: text("thumbnail_path"),
  /**
   * Per-project highlight-clip tuning as JSON (clip length min/max, count,
   * hook-phrase list, per-signal weights — Phase 04 "config surface"). Only the
   * knobs the user overrode are stored; unset fields fall back to
   * DEFAULT_CLIP_CONFIG at generate time. Null means "all defaults". A job
   * payload can still override this per run (regenerate), so this is the base,
   * not the last word.
   */
  clipConfig: text("clip_config"),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

export const assets = sqliteTable("assets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").references(() => projects.id),
  /** Semantic role: source | broll | sfx | logo | cta (defaults to `kind`). */
  type: text("type").notNull(),
  /** Media class detected at upload: video | audio | image. */
  kind: text("kind"),
  /** Declared MIME type accepted at the upload boundary. */
  mime: text("mime"),
  path: text("path").notNull(),
  originalName: text("original_name"),
  // Probed metadata (filled by the asset-probe worker job; null until then).
  width: integer("width"),
  height: integer("height"),
  duration: real("duration"),
  thumbnailPath: text("thumbnail_path"),
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
  /**
   * JSON array of human-readable reasons the clip was chosen ("high energy",
   * "hook phrase: the secret"), taken verbatim from the scorer's per-signal
   * breakdown (Phase 04). Null for clips added manually rather than scored.
   */
  reasons: text("reasons"),
  // candidate (auto-generated by generate-clips) | manual (user-added).
  // Regenerate replaces `candidate` rows only, so manual clips survive.
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
