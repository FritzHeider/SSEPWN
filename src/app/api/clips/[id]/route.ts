import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { clips } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/clips/:id — remove a single clip, manual or candidate.
 *
 * Keyed by clip id (not project) because the clips panel deletes a card without
 * caring which project owns it. Deleting nothing means the id was wrong, so it is
 * a 404 rather than a silent success — the caller learns its request missed.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json(
      { error: "Clip id must be a positive integer", code: "invalid_id" },
      { status: 400 },
    );
  }

  const deleted = db.delete(clips).where(eq(clips.id, id)).returning({ id: clips.id }).all();
  if (deleted.length === 0) {
    return NextResponse.json({ error: `No clip with id ${id}`, code: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ deleted: id });
}
