import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { clips, projects } from "../src/lib/db/schema";

/**
 * Seed harness for the Playwright timeline e2e (Phase 07).
 *
 * The real app reads the DB at `SSECLONE_DB_PATH` (see `src/lib/db/index.ts`).
 * We point BOTH the Next dev server (via the webServer `env` in
 * `playwright.config.ts`) and this seeder at the same throwaway file so the
 * editor page renders a known clip. Kept out of the default `data/` DB so a run
 * never touches developer data, and inside gitignored `data/` so nothing is
 * committed (fixtures are generated, never checked in — SPEC constraint).
 */
export const SEED_DB_PATH = path.join(process.cwd(), "data", "e2e.db");

/**
 * The seeded clip's id. A freshly migrated DB with a single inserted clip gives
 * it autoincrement id 1, so the spec can address `/clips/1` deterministically.
 */
export const SEEDED_CLIP_ID = 1;

/** The seeded clip's source window, in seconds — long enough to split cleanly. */
export const SEED_CLIP_IN = 0;
export const SEED_CLIP_OUT = 6;

/** A tiny, browser-playable source video the editor's `<video>` can load. */
export const SEED_VIDEO_PATH = path.join(process.cwd(), "data", "e2e-source.mp4");

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * Generate a small H.264/yuv420p sample (no shell string — arg array, like
 * `scripts/make-fixtures.sh`) so the editor `<video>` actually loads and the
 * ruler seek → `video.currentTime` round-trip drives the playhead. Without a
 * loadable source the browser clamps `currentTime` to 0 and a `timeupdate`
 * snaps the playhead back, so a split at the playhead would be a no-op. Skipped
 * when the file already exists to keep re-runs fast.
 */
function ensureSeedVideo(): void {
  if (existsSync(SEED_VIDEO_PATH)) return;
  mkdirSync(path.dirname(SEED_VIDEO_PATH), { recursive: true });
  try {
    execFileSync(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15:duration=8",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=8",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest",
        SEED_VIDEO_PATH,
      ],
      { stdio: "pipe" },
    );
  } catch (cause) {
    throw new Error(
      `Failed to generate the e2e source video with ffmpeg (is it on PATH?): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

/**
 * Delete any prior e2e DB, migrate a fresh one, and insert one project + one
 * clip. Synchronous (better-sqlite3) so `playwright.config.ts` can call it at
 * module load, before the webServer starts and before any test runs — that
 * ordering guarantees the Next process only ever opens an already-seeded file.
 */
export function prepareSeedDb(): void {
  mkdirSync(path.dirname(SEED_DB_PATH), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${SEED_DB_PATH}${suffix}`, { force: true });
  }
  ensureSeedVideo();

  const sqlite = new Database(SEED_DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  const [project] = db
    .insert(projects)
    .values({
      name: "E2E timeline project",
      status: "ready",
      sourceVideoPath: SEED_VIDEO_PATH,
      width: 320,
      height: 180,
      duration: 8,
      hasAudio: true,
    })
    .returning({ id: projects.id })
    .all();

  db.insert(clips)
    .values({
      projectId: project.id,
      inPoint: SEED_CLIP_IN,
      outPoint: SEED_CLIP_OUT,
      title: "E2E clip",
      status: "candidate",
    })
    .run();

  sqlite.close();
}
