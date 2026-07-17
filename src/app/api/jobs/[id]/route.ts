import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { createJobQueue } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/jobs/:id — one job's status, progress, and error. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json({ error: "Job id must be a positive integer", code: "invalid_id" }, { status: 400 });
  }

  const job = createJobQueue(db).get(id);
  if (!job) {
    return NextResponse.json({ error: `No job with id ${id}`, code: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ job });
}
