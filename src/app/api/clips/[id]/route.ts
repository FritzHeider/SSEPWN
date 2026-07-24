import { rmSync } from "node:fs";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { invalidId as invalidIdResponse, notFound as notFoundResponse, parseJsonBody } from "@/lib/api/errors";
import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { clipEdits, clips } from "@/lib/db/schema";
import { clipThumbnailPath } from "@/lib/media/derived";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const invalidId = () => invalidIdResponse("Clip");
const notFound = (id: number) => notFoundResponse("clip", id);

/** Rename body: a trimmed, non-empty title of at most 120 chars. Trimming runs
 * before the length checks, so whitespace-only titles are rejected. */
const renameBody = z.object({
  title: z.string().trim().min(1, "title must not be empty").max(120, "title must be at most 120 characters"),
});

/**
 * PATCH /api/clips/:id — rename a clip (phase-BE task 7).
 *
 * The only mutable field here is `title`; caption/crop/timeline edits live on
 * their own routes under this clip. Returns the updated clip row.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) return invalidId();

  const parsed = await parseJsonBody(request, renameBody);
  if (!parsed.ok) return parsed.response;

  const [updated] = db
    .update(clips)
    .set({ title: parsed.data.title })
    .where(eq(clips.id, id))
    .returning()
    .all();
  if (!updated) return notFound(id);

  return NextResponse.json({ clip: updated });
}

/**
 * DELETE /api/clips/:id — remove a single clip, manual or candidate.
 *
 * Keyed by clip id (not project) because the clips panel deletes a card without
 * caring which project owns it. Deleting nothing means the id was wrong, so it is
 * a 404 rather than a silent success — the caller learns its request missed.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) return invalidId();

  // A clip owns its caption/timeline edits (clip_edits.clip_id → clips.id), and
  // foreign keys are enforced (db/index.ts). Deleting the clip while an edit row
  // still points at it throws a FOREIGN KEY constraint error, so drop the child
  // rows first, atomically, so a mid-delete failure never orphans either side.
  const deleted = db.transaction((tx) => {
    tx.delete(clipEdits).where(eq(clipEdits.clipId, id)).run();
    return tx.delete(clips).where(eq(clips.id, id)).returning({ id: clips.id }).all();
  });
  if (deleted.length === 0) return notFound(id);

  // Best-effort: the clip's poster is a derived file (data/derived/clip-thumbs),
  // and a missing one already satisfies "no orphan files". Unlinked after the row
  // is gone so a failed delete never removes bytes a surviving row still names.
  rmSync(clipThumbnailPath(id), { force: true });

  return NextResponse.json({ deleted: id });
}
