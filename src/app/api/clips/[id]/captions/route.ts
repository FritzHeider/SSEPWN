import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import {
  applyCaptionEdit,
  buildCaptionDoc,
  CaptionEditError,
  parseEdit,
  readCaptionDoc,
} from "@/lib/captions/edit";
import { db } from "@/lib/db";
import { clipEdits, clips, transcripts } from "@/lib/db/schema";
import type { TranscriptSegment } from "@/lib/transcribe/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badRequest(error: string, code: string) {
  return NextResponse.json({ error, code }, { status: 400 });
}

/**
 * PATCH /api/clips/:id/captions — edit a clip's caption document.
 *
 * The document is built lazily from the project transcript the first time a clip
 * is edited, then stored in `clip_edits.state.captions`. Every subsequent edit
 * reads that stored copy. CRITICALLY, this handler only ever READS the
 * `transcripts` table — word edits, timing shifts and line reshaping all land in
 * the clip's own `clip_edits` row, so a clip's captions can diverge from the
 * source transcript without ever mutating it (SPEC.md: "Word edits must NOT
 * mutate the project transcript — clip-local copy only").
 *
 * Body is one edit operation (`parseEdit`): `set-word`, `shift-line`,
 * `merge-line`, `split-line`, or `set-style`. A malformed op, or one that points
 * at a non-existent line/word, is a 400.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json(
      { error: "Clip id must be a positive integer", code: "invalid_id" },
      { status: 400 },
    );
  }

  const clip = db
    .select({
      id: clips.id,
      projectId: clips.projectId,
      inPoint: clips.inPoint,
      outPoint: clips.outPoint,
    })
    .from(clips)
    .where(eq(clips.id, id))
    .get();
  if (!clip) {
    return NextResponse.json({ error: `No clip with id ${id}`, code: "not_found" }, { status: 404 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("Body must be valid JSON", "invalid_body");
  }
  const edit = parseEdit(payload);
  if (edit === null) {
    return badRequest("Body must be a valid caption edit operation", "invalid_edit");
  }

  // Load the stored caption document, or build one from the transcript. A
  // read-only SELECT — the transcript is never written.
  const existing = db
    .select({ state: clipEdits.state })
    .from(clipEdits)
    .where(eq(clipEdits.clipId, id))
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

  let next;
  try {
    next = applyCaptionEdit(doc, edit);
  } catch (error) {
    if (error instanceof CaptionEditError) return badRequest(error.message, "invalid_edit");
    throw error;
  }

  state.captions = next;
  const serialized = JSON.stringify(state);
  if (existing) {
    db
      .update(clipEdits)
      .set({ state: serialized, updatedAt: sql`(unixepoch())` })
      .where(eq(clipEdits.clipId, id))
      .run();
  } else {
    db.insert(clipEdits).values({ clipId: id, state: serialized }).run();
  }

  return NextResponse.json({ clipId: id, captions: next });
}
