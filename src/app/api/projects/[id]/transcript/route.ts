import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { readTranscript } from "@/lib/projects/transcript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/projects/:id/transcript — the project's segments with word timings.
 *
 * Three outcomes, deliberately distinct (same reasoning as parseId's
 * 400-vs-404): a malformed id is a 400, an id for no project is a 404, and a
 * project with no transcript is a 200 carrying an empty `segments` plus the
 * `statusNote` explaining why. Only the middle case means "wrong id", so only it
 * gets the status code that says so.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json(
      { error: "Project id must be a positive integer", code: "invalid_id" },
      { status: 400 },
    );
  }

  const transcript = readTranscript(db, id);
  if (!transcript) {
    return NextResponse.json({ error: `No project with id ${id}`, code: "not_found" }, { status: 404 });
  }

  return NextResponse.json(transcript);
}
