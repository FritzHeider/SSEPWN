import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { createJobQueue } from "@/lib/jobs";
import { deleteProject } from "@/lib/projects/delete";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/projects/:id — one project plus the progress of its jobs.
 *
 * Jobs come back through the queue rather than a direct select so their
 * `payload` is parsed by the same mapper the rest of the system uses; a select
 * here would hand the caller a raw JSON string instead.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Project id must be a positive integer", code: "invalid_id" }, { status: 400 });
  }

  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) {
    return NextResponse.json({ error: `No project with id ${id}`, code: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ project, jobs: createJobQueue(db).listByProject(id) });
}

/**
 * DELETE /api/projects/:id — remove a project with all its clips, edits,
 * exports, transcripts, jobs and assets, and unlink the files they named.
 *
 * Returns the per-table row counts so the caller (and the cascade test) can see
 * exactly what the delete reached. A missing project is a 404, matching GET.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Project id must be a positive integer", code: "invalid_id" }, { status: 400 });
  }

  const result = deleteProject(db, id);
  if (!result.found) {
    return NextResponse.json({ error: `No project with id ${id}`, code: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ deleted: true, id, rows: result.rows });
}
