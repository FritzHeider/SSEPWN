import { asc, desc, eq } from "drizzle-orm";

import type { JobsDb } from "@/lib/jobs";
import { clips, projects } from "@/lib/db/schema";

/**
 * A clip as the API and UI consume it: the stored row with its `reasons` JSON
 * column parsed back into an array at the boundary (schema.ts stores JSON as
 * text). Manual clips have no score and no reasons, so `reasons` is `[]` and
 * `score` is null for them — the panel renders those cases, it does not treat
 * them as errors.
 */
export interface ProjectClip {
  id: number;
  projectId: number;
  /** Seconds into the source video. */
  inPoint: number;
  outPoint: number;
  /** Total highlight score; null for manually-added clips. */
  score: number | null;
  title: string | null;
  /** Human-readable reasons the clip was chosen; `[]` for manual clips. */
  reasons: string[];
  /** `candidate` (auto-generated) | `manual` (user-added). */
  status: string;
  createdAt: number;
}

/** Parse a clip's stored `reasons` text into an array, tolerating garbage. */
function parseReasons(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Every clip for a project, best first — the same rank order the scorer produced
 * (`selectClips` returns winners by descending score) so the clips panel and the
 * API agree without either re-sorting.
 *
 * `score DESC` puts the highest-scoring candidate first; SQLite orders NULLs last
 * under DESC, so manually-added clips (no score) trail the ranked ones, with `id`
 * as a stable tiebreak. `reasons` is parsed here so callers never touch the raw
 * JSON column.
 *
 * Returns `null` only when the PROJECT does not exist — the one case that means
 * "wrong id". A project with no clips yet is a successful read of an empty list,
 * mirroring `readTranscript`.
 */
export function listClips(db: JobsDb, projectId: number): ProjectClip[] | null {
  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return null;

  const rows = db
    .select()
    .from(clips)
    .where(eq(clips.projectId, projectId))
    .orderBy(desc(clips.score), asc(clips.id))
    .all();

  return rows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    inPoint: row.inPoint,
    outPoint: row.outPoint,
    score: row.score,
    title: row.title,
    reasons: parseReasons(row.reasons),
    status: row.status,
    createdAt: row.createdAt,
  }));
}
