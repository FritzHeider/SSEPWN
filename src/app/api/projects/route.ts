import { unlink } from "node:fs/promises";
import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { createJobQueue } from "@/lib/jobs";
import { listProjects } from "@/lib/projects/queries";
import { receiveUpload, UploadError } from "@/lib/upload/receive";

// better-sqlite3 and the streaming parser both need Node APIs.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/projects — every project, newest first.
 *
 * The ordering (and why its `id` tiebreak matters) lives in `listProjects`,
 * which the `/` page server-renders from, so the first paint and every poll
 * cannot disagree.
 */
export async function GET() {
  return NextResponse.json({ projects: listProjects() });
}

/**
 * POST /api/projects — accept a video upload, register the project, and queue
 * its ingest job.
 *
 * The handler itself does no media work: it streams the bytes to disk and
 * enqueues (global constraint — all media work happens in the worker via the
 * `jobs` table, never inside a request handler). Probing, thumbnailing, and the
 * `ready` transition are the ingest handler's job.
 */
export async function POST(request: Request) {
  let upload;
  try {
    upload = await receiveUpload(request);
  } catch (error) {
    if (error instanceof UploadError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    throw error;
  }

  try {
    const created = db.transaction((tx) => {
      const [project] = tx
        .insert(projects)
        .values({
          name: upload.fields.name?.trim() || upload.originalName,
          sourceVideoPath: upload.filePath,
          status: "uploaded",
        })
        .returning()
        .all();

      const job = createJobQueue(tx).enqueue("ingest", project.id, { path: upload.filePath });
      return { project, job };
    });

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    // Don't leave an orphaned upload behind if registration failed.
    await unlink(upload.filePath).catch(() => {});
    throw error;
  }
}
