import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiError, invalidId as invalidIdResponse, notFound as notFoundResponse, parseJsonBody } from "@/lib/api/errors";
import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { clips, projects } from "@/lib/db/schema";
import { createJobQueue } from "@/lib/jobs";
import { listClips, type ProjectClip } from "@/lib/projects/clips";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Longest a clip title may be, matching the auto-title cap in generate-clips. */
const TITLE_MAX = 60;

const invalidId = () => invalidIdResponse("Project");
const notFound = (id: number) => notFoundResponse("project", id);

/**
 * A manual clip request: a finite in/out range with an optional title. The
 * cross-field ordering (`out > in`) and the lower bound live in the schema so a
 * backwards or negative range is caught here with the `invalid_range` code the
 * client branches on; the source-duration bound stays in the handler because it
 * needs the project row.
 */
const manualClipBody = z
  .object({
    inPoint: z
      .number()
      .refine(Number.isFinite, "inPoint and outPoint must be finite numbers")
      .refine((n) => n >= 0, "inPoint must be >= 0"),
    outPoint: z.number().refine(Number.isFinite, "inPoint and outPoint must be finite numbers"),
    title: z.string().optional(),
  })
  .refine((b) => b.outPoint > b.inPoint, {
    message: "outPoint must be greater than inPoint",
    path: ["outPoint"],
  });

/**
 * GET /api/projects/:id/clips — the project's clips, best-scored first.
 *
 * Ranking and `reasons` parsing live in `listClips`, shared with the server
 * render, so the API and the page cannot disagree on order. An existing project
 * with no clips returns `{ clips: [] }`; only a missing project is a 404.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) return invalidId();

  const clipRows = listClips(db, id);
  if (clipRows === null) return notFound(id);

  return NextResponse.json({ projectId: id, clips: clipRows });
}

/**
 * POST /api/projects/:id/clips — add a manual clip from an in/out range.
 *
 * Manual clips are the user's own selection, so they carry no score and no
 * reasons and are stored with `status: "manual"` — which is exactly why
 * regenerate (delete-then-insert of `candidate` rows only) leaves them untouched.
 * The range is validated at the boundary: both ends must be finite numbers, the
 * out-point must come after the in-point, and — when the source duration is known
 * — the range must fall inside it, so a clip can never point past the video.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) return invalidId();

  const project = db
    .select({ id: projects.id, duration: projects.duration })
    .from(projects)
    .where(eq(projects.id, id))
    .get();
  if (!project) return notFound(id);

  const parsed = await parseJsonBody(request, manualClipBody, { schemaCode: "invalid_range" });
  if (!parsed.ok) return parsed.response;
  const { inPoint, outPoint } = parsed.data;

  // Bound to the source when we know its length (ingest writes `duration`); a
  // small epsilon absorbs float drift so an out-point exactly at the end passes.
  if (project.duration != null && outPoint > project.duration + 1e-3) {
    return apiError(400, "invalid_range", `Range must fall within the ${project.duration}s source`);
  }

  const rawTitle = typeof parsed.data.title === "string" ? parsed.data.title.trim() : "";
  const title = rawTitle.length > 0 ? rawTitle.slice(0, TITLE_MAX) : "Manual clip";

  const [inserted] = db
    .insert(clips)
    .values({ projectId: id, inPoint, outPoint, title, status: "manual" })
    .returning()
    .all();

  // Poster the new clip in the worker (all ffmpeg stays out of this request).
  createJobQueue(db).enqueue("clip-thumbnail", id, { clipId: inserted.id });

  const clip: ProjectClip = {
    id: inserted.id,
    projectId: inserted.projectId,
    inPoint: inserted.inPoint,
    outPoint: inserted.outPoint,
    score: inserted.score,
    title: inserted.title,
    reasons: [],
    status: inserted.status,
    createdAt: inserted.createdAt,
  };
  return NextResponse.json({ clip }, { status: 201 });
}
