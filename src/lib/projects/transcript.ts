import { desc, eq } from "drizzle-orm";

import type { JobsDb } from "@/lib/jobs";
import { projects, transcripts } from "@/lib/db/schema";
import type { TranscriptSegment } from "@/lib/transcribe/types";

/**
 * What a caller learns about a project's transcript.
 *
 * `segments: []` is a real answer, not an error: a project with no audio, or one
 * whose transcribe job has not run yet, has nothing to show and a reason why.
 * `statusNote` carries that reason (the transcribe handler writes "no audio —
 * captions unavailable"), so the panel can say what happened instead of
 * rendering an unexplained blank.
 */
export interface ProjectTranscript {
  projectId: number;
  /** The project's `transcribed` flag — false while there is nothing to show. */
  transcribed: boolean;
  /** Non-fatal reason there is no transcript, or null. */
  statusNote: string | null;
  segments: TranscriptSegment[];
}

/**
 * Read a project's transcript, parsing the `segments` JSON column at the
 * boundary (schema.ts stores JSON as text).
 *
 * Returns `null` only when the PROJECT does not exist — that is the one case
 * that means "wrong id". A project that exists but has no transcript row is a
 * successful read of an empty transcript, and conflating the two would leave the
 * UI unable to tell a bad URL from a video with no captions.
 *
 * `order by id desc, limit 1` rather than a bare select: the transcribe handler
 * replaces rather than appends, so there should only ever be one row — but if a
 * stale row ever does survive, "newest wins" is at least deterministic, whereas
 * an unordered select leaves the answer up to SQLite.
 */
export function readTranscript(db: JobsDb, projectId: number): ProjectTranscript | null {
  const project = db
    .select({ transcribed: projects.transcribed, statusNote: projects.statusNote })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) return null;

  const row = db
    .select({ segments: transcripts.segments })
    .from(transcripts)
    .where(eq(transcripts.projectId, projectId))
    .orderBy(desc(transcripts.id))
    .limit(1)
    .get();

  return {
    projectId,
    transcribed: project.transcribed,
    statusNote: project.statusNote,
    segments: row ? (JSON.parse(row.segments) as TranscriptSegment[]) : [],
  };
}
