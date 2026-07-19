import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { clipEdits, clips, projects } from "@/lib/db/schema";
import {
  isPlatformPresetId,
  readClipPreset,
  resolvePresetSelection,
  withClipPreset,
  type PlatformPresetId,
} from "@/lib/presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function invalidId() {
  return NextResponse.json(
    { error: "Clip id must be a positive integer", code: "invalid_id" },
    { status: 400 },
  );
}

/** Load a clip with its project's default preset, or `null` when the clip is
 * missing. The project default is the fallback when the clip has no override. */
function loadClip(id: number) {
  return db
    .select({ id: clips.id, projectPreset: projects.platformPreset })
    .from(clips)
    .innerJoin(projects, eq(clips.projectId, projects.id))
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

/** The per-clip read+write model shared by GET and PUT: `platformPreset` is the
 * clip's own override (null = inherits), `projectPreset` the project default,
 * and `effective`/`source` the layered resolution the editor renders from. */
function body(
  clipId: number,
  override: PlatformPresetId | null,
  projectPreset: PlatformPresetId | null,
) {
  const { preset, source } = resolvePresetSelection(override, projectPreset);
  return { clipId, platformPreset: override, projectPreset, effective: preset, source };
}

/** Normalise a raw column/override value to a known id or null. */
function normalizePreset(raw: unknown): PlatformPresetId | null {
  return isPlatformPresetId(raw) ? raw : null;
}

/**
 * GET /api/clips/:id/preset — the clip's per-clip preset override, the project
 * default it inherits from, and the layered effective preset. A clip with no
 * override returns `platformPreset: null` and `source: "project"` (or
 * `"default"` when the project has none either).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) return invalidId();

  const clip = loadClip(id);
  if (!clip) {
    return NextResponse.json({ error: `No clip with id ${id}`, code: "not_found" }, { status: 404 });
  }

  const override = readClipPreset(readState(id));
  return NextResponse.json(body(id, override, normalizePreset(clip.projectPreset)));
}

/**
 * PUT /api/clips/:id/preset — set (or clear) the clip's per-clip preset override.
 *
 * Body `{ platformPreset: <id> | null }`. A known id is persisted into the
 * clip's `clip_edits.state` blob (leaving timeline/crop/captions untouched);
 * `null` clears the override so the clip re-inherits the project default;
 * anything else is a 400. No smart-crop is enqueued here — a preset carries an
 * aspect ratio, but re-framing only happens when a template/AR change is applied,
 * not when a target platform is merely selected for the (Phase 10) export.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) return invalidId();

  const clip = loadClip(id);
  if (!clip) {
    return NextResponse.json({ error: `No clip with id ${id}`, code: "not_found" }, { status: 404 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON", code: "invalid_body" }, { status: 400 });
  }
  if (typeof payload !== "object" || payload === null) {
    return NextResponse.json(
      { error: "Body must be an object with a platformPreset", code: "invalid_body" },
      { status: 400 },
    );
  }

  const raw = (payload as Record<string, unknown>).platformPreset;
  let override: PlatformPresetId | null;
  if (raw === null) {
    override = null;
  } else if (isPlatformPresetId(raw)) {
    override = raw;
  } else {
    return NextResponse.json(
      { error: "platformPreset must be a known preset id or null", code: "invalid_preset" },
      { status: 400 },
    );
  }

  writeState(id, withClipPreset(readState(id), override));
  return NextResponse.json(body(id, override, normalizePreset(clip.projectPreset)));
}
