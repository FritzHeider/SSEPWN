import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { parseClipConfig, resolveConfig, type ClipConfig } from "@/lib/highlights/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Parse the stored `clip_config` text into clean overrides (empty on garbage). */
function storedConfig(raw: string | null): ClipConfig {
  if (!raw) return {};
  try {
    return parseClipConfig(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * The config surface's read + write model, shared by GET and PUT so both agree
 * on shape: `overrides` are exactly what the project saved (drives which fields
 * a UI shows as customised), `effective` is that layered over the defaults
 * (what a generate run would actually use).
 */
function body(projectId: number, overrides: ClipConfig) {
  return { projectId, overrides, effective: resolveConfig(overrides) };
}

function invalidId() {
  return NextResponse.json(
    { error: "Project id must be a positive integer", code: "invalid_id" },
    { status: 400 },
  );
}

/**
 * GET /api/projects/:id/clip-config — the project's saved clip tuning plus the
 * effective config (overrides merged onto defaults). A project that never set
 * one returns empty overrides and the pure defaults, so the config panel can
 * render without a special "unconfigured" case.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) return invalidId();

  const project = db
    .select({ clipConfig: projects.clipConfig })
    .from(projects)
    .where(eq(projects.id, id))
    .get();
  if (!project) {
    return NextResponse.json({ error: `No project with id ${id}`, code: "not_found" }, { status: 404 });
  }

  return NextResponse.json(body(id, storedConfig(project.clipConfig)));
}

/**
 * PUT /api/projects/:id/clip-config — replace the project's clip tuning.
 *
 * The body is untrusted (SPEC: validate at boundaries), so it goes through the
 * same `parseClipConfig` the scorer uses: unknown keys and wrong-typed values
 * are dropped, and only the cleaned overrides are persisted. Storing the cleaned
 * form (not the raw body) means the generate handler never has to re-defend
 * against a `minLen: "20"` that would otherwise NaN its way through the math.
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

  const overrides = parseClipConfig(payload);
  // No clean fields → clear the override so the project reverts to defaults,
  // rather than persisting an empty object that reads the same but isn't null.
  const stored = Object.keys(overrides).length > 0 ? JSON.stringify(overrides) : null;

  const updated = db
    .update(projects)
    .set({ clipConfig: stored })
    .where(eq(projects.id, id))
    .returning({ id: projects.id })
    .all();
  if (updated.length === 0) {
    return NextResponse.json({ error: `No project with id ${id}`, code: "not_found" }, { status: 404 });
  }

  return NextResponse.json(body(id, overrides));
}
