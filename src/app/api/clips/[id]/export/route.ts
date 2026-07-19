import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { clipEdits, clips, exports, projects } from "@/lib/db/schema";
import { createJobQueue } from "@/lib/jobs";
import type { RenderQuality } from "@/lib/render/execute";
import {
  isPlatformPresetId,
  readClipPreset,
  resolvePresetSelection,
  type PlatformPresetId,
} from "@/lib/presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QUALITIES: readonly RenderQuality[] = ["draft", "final"];

function invalidId() {
  return NextResponse.json(
    { error: "Clip id must be a positive integer", code: "invalid_id" },
    { status: 400 },
  );
}

/** Load a clip with the project id it belongs to and that project's default
 * preset, or `null` when the clip is missing. */
function loadClip(id: number) {
  return db
    .select({ id: clips.id, projectId: clips.projectId, projectPreset: projects.platformPreset })
    .from(clips)
    .innerJoin(projects, eq(clips.projectId, projects.id))
    .where(eq(clips.id, id))
    .get();
}

/** The clip's persisted per-clip preset override, or `null` when none/corrupt. */
function readClipOverride(clipId: number): PlatformPresetId | null {
  const row = db
    .select({ state: clipEdits.state })
    .from(clipEdits)
    .where(eq(clipEdits.clipId, clipId))
    .get();
  if (!row) return null;
  try {
    return readClipPreset(JSON.parse(row.state));
  } catch {
    return null;
  }
}

/**
 * GET /api/clips/:id/export — this clip's export history, newest first. Backs
 * the per-clip history list in the editor: each row carries its status,
 * resolved output path (once done) and error, plus the `jobId` the UI polls
 * `/api/jobs/:jobId` (or `/api/exports/:id`) with for live progress.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) return invalidId();

  const clip = loadClip(id);
  if (!clip) {
    return NextResponse.json({ error: `No clip with id ${id}`, code: "not_found" }, { status: 404 });
  }

  const rows = db.select().from(exports).where(eq(exports.clipId, id)).orderBy(desc(exports.id)).all();
  return NextResponse.json({ exports: rows });
}

/**
 * POST /api/clips/:id/export — queue a render of this clip to a delivery MP4.
 *
 * Body `{ preset?, quality? }`. `preset` is a platform preset id; when omitted
 * the clip's effective preset (per-clip override → project default → product
 * default) is used, so "Export" with no explicit choice does the expected
 * thing. `quality` is the encode knob — `final` (crf 19) by default, `draft`
 * (crf 28, fast) for the quick-preview button. An unknown preset or quality is a
 * 400 rather than a job that fails deep in ffmpeg.
 *
 * Creates the `exports` row, enqueues the `export` job carrying
 * `{ exportId, quality }`, and links the job back onto the row (`jobId`) so
 * `GET /api/exports/:id` can report live progress before the worker starts. All
 * media work happens in that job, never in this request (global constraint).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) return invalidId();

  const clip = loadClip(id);
  if (!clip) {
    return NextResponse.json({ error: `No clip with id ${id}`, code: "not_found" }, { status: 404 });
  }

  let payload: unknown = {};
  const rawBody = await request.text();
  if (rawBody.trim() !== "") {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Body must be valid JSON", code: "invalid_body" }, { status: 400 });
    }
  }
  if (typeof payload !== "object" || payload === null) {
    return NextResponse.json(
      { error: "Body must be an object with optional { preset, quality }", code: "invalid_body" },
      { status: 400 },
    );
  }
  const body = payload as Record<string, unknown>;

  // Preset: an explicit value must be a known id; absence falls back to the
  // clip's effective preset so the common "just export" path needs no body.
  let preset: PlatformPresetId;
  if (body.preset === undefined) {
    preset = resolvePresetSelection(readClipOverride(id), clip.projectPreset).preset.id;
  } else if (isPlatformPresetId(body.preset)) {
    preset = body.preset;
  } else {
    return NextResponse.json(
      { error: "preset must be a known platform preset id", code: "invalid_preset" },
      { status: 400 },
    );
  }

  // Quality: default `final`; `draft` is the opt-in quick-preview render.
  let quality: RenderQuality;
  if (body.quality === undefined) {
    quality = "final";
  } else if (typeof body.quality === "string" && (QUALITIES as readonly string[]).includes(body.quality)) {
    quality = body.quality as RenderQuality;
  } else {
    return NextResponse.json(
      { error: "quality must be draft or final", code: "invalid_quality" },
      { status: 400 },
    );
  }

  const [row] = db
    .insert(exports)
    .values({ clipId: id, preset, status: "queued" })
    .returning()
    .all();

  const job = createJobQueue(db).enqueue("export", clip.projectId, { exportId: row.id, quality });

  db.update(exports).set({ jobId: job.id }).where(eq(exports.id, row.id)).run();

  return NextResponse.json({ export: { ...row, jobId: job.id }, quality }, { status: 201 });
}
