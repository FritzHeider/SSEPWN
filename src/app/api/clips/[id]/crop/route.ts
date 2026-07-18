import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import {
  applyCropOverride,
  CropOverrideError,
  parseCropOverride,
  readCropState,
  withCropState,
} from "@/lib/crop/state";
import { parseAspectRatio } from "@/lib/crop/types";
import { db } from "@/lib/db";
import { clipEdits, clips, projects } from "@/lib/db/schema";
import { createJobQueue } from "@/lib/jobs";

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

/**
 * GET /api/clips/:id/crop — the clip's current crop plan, or `null` when it has
 * none yet. The editor reads this on load and re-reads it while polling after a
 * "re-run auto" so the overlay reflects what the worker wrote. Read-only: it never
 * touches the DB beyond the select, so it is safe to call repeatedly.
 *
 * Response: `{ crop: CropState | null }`.
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

  return NextResponse.json({ crop: readCropState(readState(id)) });
}

/**
 * POST /api/clips/:id/crop — enqueue an automatic smart-crop for one aspect ratio.
 *
 * Media work never runs in a request handler (global constraint), so this only
 * validates the body and enqueues a `smart-crop` job on the clip's project; the
 * worker samples frames, runs the detector, and writes `clip_edits.crop`. Returns
 * the queued job (202) so the caller can poll it. A crop the user has locked is
 * left alone by the job itself, so re-running auto never clobbers a manual
 * override (see the smart-crop handler).
 *
 * Body: `{ aspectRatio: "9:16" | "1:1" | "16:9", sampleEverySec?: number }`.
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
    return badRequest("Body must be an object with an aspectRatio", "invalid_body");
  }
  const body = payload as Record<string, unknown>;

  let aspectRatio;
  try {
    aspectRatio = parseAspectRatio(body.aspectRatio);
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Invalid aspectRatio", "invalid_aspect_ratio");
  }

  let sampleEverySec: number | undefined;
  if (body.sampleEverySec !== undefined) {
    if (
      typeof body.sampleEverySec !== "number" ||
      !Number.isFinite(body.sampleEverySec) ||
      body.sampleEverySec <= 0
    ) {
      return badRequest("sampleEverySec must be a positive number", "invalid_sample_every");
    }
    sampleEverySec = body.sampleEverySec;
  }

  const jobPayload: Record<string, unknown> = { clipId: id, aspectRatio };
  if (sampleEverySec !== undefined) jobPayload.sampleEverySec = sampleEverySec;
  const job = createJobQueue(db).enqueue("smart-crop", clip.projectId, jobPayload);

  return NextResponse.json({ job }, { status: 202 });
}

/**
 * PATCH /api/clips/:id/crop — write a manual crop keyframe (drag-to-override).
 *
 * The editor drags the crop rectangle at the current playhead and sends one
 * keyframe `{ t, x, y, w, h }` in source pixels. The override is merged into the
 * clip's crop plan and the result is flagged `locked: true`, so a subsequent
 * "re-run auto" (a `smart-crop` job) leaves it untouched — the manual crop wins
 * (phase-06 acceptance). Only the `crop` key of the edit blob is rewritten;
 * captions/timeline in the same blob survive.
 *
 * Body: `{ keyframe: { t, x, y, w, h }, aspectRatio? }`. `aspectRatio` is required
 * only for the first override on a clip that has no auto crop yet.
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

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest("Body must be valid JSON", "invalid_body");
  }

  let override;
  try {
    override = parseCropOverride(raw);
  } catch (error) {
    if (error instanceof CropOverrideError) return badRequest(error.message, "invalid_override");
    throw error;
  }

  const state = readState(id);
  const existing = readCropState(state);

  const project = db
    .select({ width: projects.width, height: projects.height })
    .from(projects)
    .where(eq(projects.id, clip.projectId))
    .get();

  let next;
  try {
    next = applyCropOverride(existing, override, {
      srcWidth: project?.width ?? 0,
      srcHeight: project?.height ?? 0,
    });
  } catch (error) {
    if (error instanceof CropOverrideError) return badRequest(error.message, "invalid_override");
    throw error;
  }

  const serialized = JSON.stringify(withCropState(state, next));
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

  return NextResponse.json({ clipId: id, crop: next });
}
