/**
 * Load a clip's caption document exactly the way `PATCH /api/clips/:id/captions`
 * does: the stored `clip_edits.state.captions` copy if the clip has been edited,
 * otherwise a fresh document built from the project transcript. Read-only — the
 * transcript is never mutated (SPEC: word edits are clip-local).
 *
 * Extracted so the `.srt`/`.vtt` export routes and any future consumer resolve
 * the same document from one place instead of re-deriving the fallback.
 */
import { eq } from "drizzle-orm";

import type { JobsDb } from "../jobs";
import { clipEdits, clips, transcripts } from "../db/schema";
import type { TranscriptSegment } from "../transcribe/types";
import type { CaptionDoc } from "./ass";
import { buildCaptionDoc, readCaptionDoc } from "./edit";

export interface LoadedClipCaptions {
  clip: { id: number; projectId: number; inPoint: number; outPoint: number; title: string | null };
  doc: CaptionDoc;
}

/** Resolve a clip's caption document, or `null` when the clip does not exist. */
export function loadClipCaptionDoc(db: JobsDb, clipId: number): LoadedClipCaptions | null {
  const clip = db
    .select({
      id: clips.id,
      projectId: clips.projectId,
      inPoint: clips.inPoint,
      outPoint: clips.outPoint,
      title: clips.title,
    })
    .from(clips)
    .where(eq(clips.id, clipId))
    .get();
  if (!clip) return null;

  const existing = db
    .select({ state: clipEdits.state })
    .from(clipEdits)
    .where(eq(clipEdits.clipId, clipId))
    .get();

  let state: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing.state);
      if (typeof parsed === "object" && parsed !== null) state = parsed as Record<string, unknown>;
    } catch {
      state = {};
    }
  }

  let doc = readCaptionDoc(state);
  if (doc === null) {
    const transcript = db
      .select({ segments: transcripts.segments })
      .from(transcripts)
      .where(eq(transcripts.projectId, clip.projectId))
      .get();
    let segments: TranscriptSegment[] = [];
    if (transcript) {
      try {
        const parsed = JSON.parse(transcript.segments);
        if (Array.isArray(parsed)) segments = parsed as TranscriptSegment[];
      } catch {
        segments = [];
      }
    }
    doc = buildCaptionDoc(segments, clip.inPoint, clip.outPoint);
  }

  return { clip, doc };
}
