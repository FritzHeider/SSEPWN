import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { invalidId as invalidIdResponse, notFound as notFoundResponse } from "@/lib/api/errors";
import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { clips, projects } from "@/lib/db/schema";
import { createJobQueue } from "@/lib/jobs";
import { derivePipeline } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/projects/:id/pipeline — the ingest → transcribe → generate-clips step
 * states for a project (phase-BE task 3).
 *
 * The route only gathers the durable facts (jobs, project row, clip count) and
 * hands them to the pure `derivePipeline`; the derivation — including the
 * no-audio `skipped` transcribe case — is unit-tested there, not here.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) return invalidIdResponse("Project");

  const project = db
    .select({
      status: projects.status,
      hasAudio: projects.hasAudio,
      transcribed: projects.transcribed,
    })
    .from(projects)
    .where(eq(projects.id, id))
    .get();
  if (!project) return notFoundResponse("project", id);

  const jobs = createJobQueue(db).listByProject(id);
  const [{ count: clipCount }] = db
    .select({ count: sql<number>`count(*)` })
    .from(clips)
    .where(eq(clips.projectId, id))
    .all();

  const steps = derivePipeline({
    jobs: jobs.map((job) => ({ type: job.type, status: job.status, error: job.error })),
    projectStatus: project.status,
    hasAudio: project.hasAudio,
    transcribed: project.transcribed,
    clipCount,
  });

  return NextResponse.json({ projectId: id, steps });
}
