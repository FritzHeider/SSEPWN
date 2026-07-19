import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import {
  getPlatformPreset,
  isPlatformPresetId,
  resolvePlatformPreset,
  type PlatformPresetId,
} from "@/lib/presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The project-default read+write model, shared by GET and PUT so both agree on
 * shape: `platformPreset` is exactly what the project stored (null = never set,
 * so it uses the product default), `effective` is the full preset a clip
 * inherits when it has no override of its own.
 */
function body(projectId: number, stored: PlatformPresetId | null) {
  return { projectId, platformPreset: stored, effective: resolvePlatformPreset(stored) };
}

function invalidId() {
  return NextResponse.json(
    { error: "Project id must be a positive integer", code: "invalid_id" },
    { status: 400 },
  );
}

/** Normalise the stored column value to a known id or null (garbage → null). */
function storedPreset(raw: string | null): PlatformPresetId | null {
  return getPlatformPreset(raw)?.id ?? null;
}

/**
 * GET /api/projects/:id/preset — the project's default platform preset plus the
 * full effective preset it resolves to. A project that never set one returns
 * `platformPreset: null` and the product default, so the picker renders without
 * a special "unset" case.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) return invalidId();

  const project = db
    .select({ platformPreset: projects.platformPreset })
    .from(projects)
    .where(eq(projects.id, id))
    .get();
  if (!project) {
    return NextResponse.json({ error: `No project with id ${id}`, code: "not_found" }, { status: 404 });
  }

  return NextResponse.json(body(id, storedPreset(project.platformPreset)));
}

/**
 * PUT /api/projects/:id/preset — set (or clear) the project's default preset.
 *
 * Body `{ platformPreset: <id> | null }`. The value is untrusted (SPEC: validate
 * at boundaries): a known preset id is persisted, `null` clears the default
 * (reverting to the product default), and anything else is a 400 rather than
 * silently writing garbage a later export would have to re-defend against.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) return invalidId();

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
  let stored: PlatformPresetId | null;
  if (raw === null) {
    stored = null;
  } else if (isPlatformPresetId(raw)) {
    stored = raw;
  } else {
    return NextResponse.json(
      { error: "platformPreset must be a known preset id or null", code: "invalid_preset" },
      { status: 400 },
    );
  }

  const updated = db
    .update(projects)
    .set({ platformPreset: stored })
    .where(eq(projects.id, id))
    .returning({ id: projects.id })
    .all();
  if (updated.length === 0) {
    return NextResponse.json({ error: `No project with id ${id}`, code: "not_found" }, { status: 404 });
  }

  return NextResponse.json(body(id, stored));
}
