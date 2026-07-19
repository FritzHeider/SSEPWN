import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { readCropState } from "@/lib/crop/state";
import { db } from "@/lib/db";
import { clipEdits, clips } from "@/lib/db/schema";
import { createJobQueue } from "@/lib/jobs";
import { applyTemplate, hasTemplateUndo, undoTemplate } from "@/lib/templates/apply";
import { getTemplate } from "@/lib/templates/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badRequest(error: string, code: string) {
  return NextResponse.json({ error, code }, { status: 400 });
}

function loadClip(id: number) {
  return db
    .select({ id: clips.id, projectId: clips.projectId })
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

/** Upsert the whole edit blob for a clip. */
function writeState(clipId: number, state: Record<string, unknown>): void {
  const serialized = JSON.stringify(state);
  const existing = db
    .select({ clipId: clipEdits.clipId })
    .from(clipEdits)
    .where(eq(clipEdits.clipId, clipId))
    .get();
  if (existing) {
    db
      .update(clipEdits)
      .set({ state: serialized, updatedAt: sql`(unixepoch())` })
      .where(eq(clipEdits.clipId, clipId))
      .run();
  } else {
    db.insert(clipEdits).values({ clipId, state: serialized }).run();
  }
}

/**
 * POST /api/clips/:id/apply-template — impose a template's look on a clip.
 *
 * Thin wrapper over the pure {@link applyTemplate}: it loads the template, reads
 * the clip's current `clip_edits.state`, runs the pure function to get the new
 * blob (which overwrites caption style / AR / CTAs / watermark but preserves
 * segments, trims, SFX, transitions, and locked crop keyframes), and persists it.
 * The previous blob is snapshotted inside the new one so a later `DELETE` undoes
 * it exactly.
 *
 * Media work never runs in a request handler (global constraint): when the
 * template's aspect ratio differs from the clip's current one, the new crop plan
 * needs fresh keyframes, so we enqueue a `smart-crop` job on the clip's project
 * rather than reframing here. A clip with a manual-locked crop keeps its
 * keyframes and needs no job.
 *
 * Body: `{ templateId: number }`. Response: `{ clipId, templateId, job }`.
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

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("Body must be valid JSON", "invalid_body");
  }
  if (typeof payload !== "object" || payload === null) {
    return badRequest("Body must be an object with a templateId", "invalid_body");
  }
  const templateId = parseId(String((payload as Record<string, unknown>).templateId));
  if (templateId === null) {
    return badRequest("templateId must be a positive integer", "invalid_template_id");
  }

  const template = getTemplate(db, templateId);
  if (!template) {
    return NextResponse.json(
      { error: `No template with id ${templateId}`, code: "template_not_found" },
      { status: 404 },
    );
  }

  const state = readState(id);
  const next = applyTemplate(state, template);
  writeState(id, next);

  // Enqueue a smart-crop only when the applied crop actually needs auto
  // re-derivation: `applyTemplate` leaves the new crop with empty, unlocked
  // keyframes exactly when the aspect ratio changed and nothing was manually
  // locked. A locked crop is preserved and would no-op the job, so we skip it.
  const nextCrop = readCropState(next);
  let job = null;
  if (nextCrop && !nextCrop.locked && nextCrop.keyframes.length === 0) {
    job = createJobQueue(db).enqueue("smart-crop", clip.projectId, {
      clipId: id,
      aspectRatio: template.aspectRatio,
    });
  }

  return NextResponse.json({ clipId: id, templateId, job });
}

/**
 * DELETE /api/clips/:id/apply-template — undo the last template application.
 *
 * Restores the exact `clip_edits.state` blob snapshotted by the most recent
 * `POST` (byte-for-byte, including whatever undo/template markers it carried, so
 * a chain of applies unwinds one step at a time). 409 when there is nothing to
 * undo. Does NOT enqueue a smart-crop: undo restores the previous crop plan
 * (keyframes and all) verbatim.
 *
 * Response: `{ clipId, undone: true }`.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return badRequest("Clip id must be a positive integer", "invalid_id");
  }

  const clip = loadClip(id);
  if (!clip) {
    return NextResponse.json({ error: `No clip with id ${id}`, code: "not_found" }, { status: 404 });
  }

  const state = readState(id);
  if (!hasTemplateUndo(state)) {
    return NextResponse.json(
      { error: "No template application to undo", code: "nothing_to_undo" },
      { status: 409 },
    );
  }

  const restored = undoTemplate(state);
  if (!restored) {
    return NextResponse.json(
      { error: "Undo snapshot is corrupt", code: "undo_corrupt" },
      { status: 409 },
    );
  }

  writeState(id, restored);
  return NextResponse.json({ clipId: id, undone: true });
}
