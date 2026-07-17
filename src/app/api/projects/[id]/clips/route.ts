import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { clips, projects } from "@/lib/db/schema";
import { listClips, type ProjectClip } from "@/lib/projects/clips";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Longest a clip title may be, matching the auto-title cap in generate-clips. */
const TITLE_MAX = 60;

function invalidId() {
  return NextResponse.json(
    { error: "Project id must be a positive integer", code: "invalid_id" },
    { status: 400 },
  );
}

function notFound(id: number) {
  return NextResponse.json({ error: `No project with id ${id}`, code: "not_found" }, { status: 404 });
}

function badRequest(error: string, code: string) {
  return NextResponse.json({ error, code }, { status: 400 });
}

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

/** Read a finite number field from an untrusted body, or undefined. */
function numField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("Body must be valid JSON", "invalid_body");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return badRequest("Body must be a JSON object", "invalid_body");
  }

  const body = payload as Record<string, unknown>;
  const inPoint = numField(body.inPoint);
  const outPoint = numField(body.outPoint);
  if (inPoint === undefined || outPoint === undefined) {
    return badRequest("inPoint and outPoint must be finite numbers", "invalid_range");
  }
  if (inPoint < 0) {
    return badRequest("inPoint must be >= 0", "invalid_range");
  }
  if (outPoint <= inPoint) {
    return badRequest("outPoint must be greater than inPoint", "invalid_range");
  }
  // Bound to the source when we know its length (ingest writes `duration`); a
  // small epsilon absorbs float drift so an out-point exactly at the end passes.
  if (project.duration != null && outPoint > project.duration + 1e-3) {
    return badRequest(`Range must fall within the ${project.duration}s source`, "invalid_range");
  }

  const rawTitle = typeof body.title === "string" ? body.title.trim() : "";
  const title = rawTitle.length > 0 ? rawTitle.slice(0, TITLE_MAX) : "Manual clip";

  const [inserted] = db
    .insert(clips)
    .values({ projectId: id, inPoint, outPoint, title, status: "manual" })
    .returning()
    .all();

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
