import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { clipEdits, clips } from "@/lib/db/schema";
import {
  assertValidDoc,
  buildTimelineDoc,
  readTimelineDoc,
  withTimelineDoc,
} from "@/lib/timeline/state";
import { TIME_EPSILON, TimelineError } from "@/lib/timeline/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badRequest(error: string, code: string) {
  return NextResponse.json({ error, code }, { status: 400 });
}

function loadClip(id: number) {
  return db
    .select({
      id: clips.id,
      projectId: clips.projectId,
      inPoint: clips.inPoint,
      outPoint: clips.outPoint,
    })
    .from(clips)
    .where(eq(clips.id, id))
    .get();
}

/** Read the clip's parsed `clip_edits.state` blob (or `{}` when none/corrupt). */
function readState(clipId: number): Record<string, unknown> {
  const row = db
    .select({ state: clipEdits.state })
    .from(clipEdits)
    .where(eq(clipEdits.clipId, clipId))
    .get();
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.state);
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    /* fall through to empty */
  }
  return {};
}

/**
 * GET /api/clips/:id/timeline — the clip's edited timeline. Returns the persisted
 * doc when one exists, otherwise a freshly built one spanning the clip's whole
 * source window (`buildTimelineDoc` from the clip's in/out points). The fresh doc
 * is NOT persisted here — the editor renders it immediately and the first real
 * edit is what PATCHes a doc back. Read-only.
 *
 * Response: `{ timeline: TimelineDoc }`.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return badRequest("Clip id must be a positive integer", "invalid_id");
  }

  const clip = loadClip(id);
  if (!clip) {
    return NextResponse.json({ error: `No clip with id ${id}`, code: "not_found" }, { status: 404 });
  }

  const persisted = readTimelineDoc(readState(id));
  const timeline = persisted ?? buildTimelineDoc(clip.inPoint, clip.outPoint);
  return NextResponse.json({ timeline });
}

/**
 * PATCH /api/clips/:id/timeline — persist the whole edited timeline (optimistic
 * save). The editor applies pure ops locally, keeps the resulting {@link
 * TimelineDoc} in its undo stack, and debounce-sends the current doc here; the
 * client is optimistic, so this handler is the durable write-behind.
 *
 * The body is a FULL doc, not a diff. It is shape-guarded by `readTimelineDoc`,
 * its `bounds` are checked against the clip's real source window (a client cannot
 * widen the window to smuggle segments outside the clip), and `assertValidDoc`
 * enforces every structural invariant before it is stored. Only the `timeline`
 * key of the edit blob is rewritten, so the clip's crop/captions survive.
 *
 * Body: `{ timeline: TimelineDoc }`.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return badRequest("Clip id must be a positive integer", "invalid_id");
  }

  const clip = loadClip(id);
  if (!clip) {
    return NextResponse.json({ error: `No clip with id ${id}`, code: "not_found" }, { status: 404 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("Body must be valid JSON", "invalid_body");
  }
  if (typeof payload !== "object" || payload === null) {
    return badRequest("Body must be an object with a timeline", "invalid_body");
  }

  // `readTimelineDoc` looks for a `.timeline` key, exactly what the client sends,
  // and rejects a malformed shape (null) before any invariant is checked.
  const doc = readTimelineDoc(payload);
  if (!doc) {
    return badRequest("Body must contain a valid timeline document", "invalid_timeline");
  }

  // Bounds are the clip's fixed source window; a persisted doc must not move them
  // (Phase 07 never edits bounds). Reject a client that tampers with them so
  // segments can never escape the real clip window.
  if (
    Math.abs(doc.bounds.in - clip.inPoint) > TIME_EPSILON ||
    Math.abs(doc.bounds.out - clip.outPoint) > TIME_EPSILON
  ) {
    return badRequest(
      `Timeline bounds ${doc.bounds.in}–${doc.bounds.out} do not match clip window ${clip.inPoint}–${clip.outPoint}`,
      "bounds_mismatch",
    );
  }

  try {
    assertValidDoc(doc);
  } catch (error) {
    if (error instanceof TimelineError) return badRequest(error.message, "invalid_timeline");
    throw error;
  }

  const state = readState(id);
  const serialized = JSON.stringify(withTimelineDoc(state, doc));
  const existingRow = db
    .select({ clipId: clipEdits.clipId })
    .from(clipEdits)
    .where(eq(clipEdits.clipId, id))
    .get();
  if (existingRow) {
    db
      .update(clipEdits)
      .set({ state: serialized, updatedAt: sql`(unixepoch())` })
      .where(eq(clipEdits.clipId, id))
      .run();
  } else {
    db.insert(clipEdits).values({ clipId: id, state: serialized }).run();
  }

  return NextResponse.json({ clipId: id, timeline: doc });
}
