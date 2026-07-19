import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { clipEdits, clips } from "@/lib/db/schema";
import { saveAsTemplate } from "@/lib/templates/apply";
import { insertTemplate } from "@/lib/templates/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badRequest(error: string, code: string) {
  return NextResponse.json({ error, code }, { status: 400 });
}

function loadClip(id: number) {
  return db.select({ id: clips.id }).from(clips).where(eq(clips.id, id)).get();
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
 * POST /api/clips/:id/save-as-template — capture a clip's current look as a new
 * saved template.
 *
 * Thin wrapper over the pure {@link saveAsTemplate}: it reads the clip's edit
 * state, distils it into a {@link TemplateInput} (caption style, AR, CTAs, brand
 * primary tracking the caption highlight), and inserts it as a non-built-in
 * template. The insert re-validates through `parseTemplateInput`, so a hand-edited
 * blob can never corrupt the stored row. The round-trip is a fixed point: saving
 * from clip A and applying to clip B reproduces A's caption style exactly.
 *
 * Body: `{ name?: string }` (defaults to "Untitled template").
 * Response: `{ template: Template }` (201).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return badRequest("Clip id must be a positive integer", "invalid_id");
  }

  const clip = loadClip(id);
  if (!clip) {
    return NextResponse.json({ error: `No clip with id ${id}`, code: "not_found" }, { status: 404 });
  }

  let payload: unknown = {};
  const text = await request.text();
  if (text.trim() !== "") {
    try {
      payload = JSON.parse(text);
    } catch {
      return badRequest("Body must be valid JSON", "invalid_body");
    }
  }
  const rawName = (payload as Record<string, unknown> | null)?.name;
  const name = typeof rawName === "string" ? rawName : "";

  const state = readState(id);
  const input = saveAsTemplate(state, name);
  const template = insertTemplate(db, input);

  return NextResponse.json({ template }, { status: 201 });
}
