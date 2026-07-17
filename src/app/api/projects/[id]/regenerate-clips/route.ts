import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { parseClipConfig } from "@/lib/highlights/config";
import { createJobQueue } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/projects/:id/regenerate-clips — re-run highlight detection.
 *
 * The handler does no media work itself (global constraint — that lives in the
 * worker): it validates the id, confirms the project exists, and enqueues a
 * `generate-clips` job, returning the queued job so the caller can poll it.
 *
 * An optional JSON body carries one-off clip-config overrides. They are validated
 * with the same `parseClipConfig` the scorer uses and passed as the job PAYLOAD,
 * not persisted — generate-clips layers the payload over the project's stored
 * config for this run only. That is what makes "regenerate with a custom hook
 * list" a live, non-destructive experiment: change the phrases, see which clip
 * ranks first, without overwriting the saved config (that is PUT clip-config's
 * job). An empty or absent body just re-runs with the stored config.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json(
      { error: "Project id must be a positive integer", code: "invalid_id" },
      { status: 400 },
    );
  }

  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get();
  if (!project) {
    return NextResponse.json({ error: `No project with id ${id}`, code: "not_found" }, { status: 404 });
  }

  // The body is optional: a plain regenerate sends nothing. Read it as text so an
  // empty body is "no overrides" rather than a JSON parse error, and reject only a
  // body that is present but malformed.
  const raw = (await request.text()).trim();
  let overrides = {};
  if (raw.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Body must be valid JSON", code: "invalid_body" }, { status: 400 });
    }
    overrides = parseClipConfig(parsed);
  }

  // Only attach a payload when there are real overrides, so a plain regenerate
  // leaves the job payload null (handler falls back to the stored config).
  const payload = Object.keys(overrides).length > 0 ? overrides : undefined;
  const job = createJobQueue(db).enqueue("generate-clips", id, payload);

  return NextResponse.json({ job }, { status: 202 });
}
