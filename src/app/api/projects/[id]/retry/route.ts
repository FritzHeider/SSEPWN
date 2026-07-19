import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { retryPipeline } from "@/lib/projects/retry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/projects/:id/retry — resume a stalled upload pipeline from its
 * failed step (SPEC.md § Feature checklist / Phase-11: "failures stop the chain
 * with a resumable retry-from-failed-step action").
 *
 * The actual media work stays in the worker: this only enqueues a fresh job for
 * the failed step (global constraint — no long-running work in a request
 * handler). A project with no failed pipeline step is a 409, not a silent
 * success, so a double-click or a stale button can't spawn a duplicate chain.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json(
      { error: "Project id must be a positive integer", code: "invalid_id" },
      { status: 400 },
    );
  }

  const result = retryPipeline(db, id);
  if (result.retried) {
    return NextResponse.json({ retried: true, job: result.job });
  }

  if (result.reason === "project_not_found") {
    return NextResponse.json({ error: `No project with id ${id}`, code: "not_found" }, { status: 404 });
  }
  return NextResponse.json(
    { error: "Project has no failed pipeline step to retry", code: "no_failed_step" },
    { status: 409 },
  );
}
