import { eq } from "drizzle-orm";
import { statSync } from "node:fs";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { clips, exports } from "@/lib/db/schema";
import { exportPresetDimensions } from "@/lib/export/view";
import { createJobQueue } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** File size of a finished export's output, or null when not done / gone from
 * the scratch dir. Never throws — a cleaned-up file is a normal state. */
function fileSizeBytes(status: string, outputPath: string | null): number | null {
  if (status !== "done" || !outputPath) return null;
  try {
    return statSync(outputPath).size;
  } catch {
    return null;
  }
}

/**
 * GET /api/exports/:id — one export's status for the progress UI.
 *
 * The `exports` row owns the durable lifecycle (`queued → running → done |
 * failed`, `outputPath`, `error`), while the linked `jobs` row carries the live
 * `progress` 0–100 and retry counters the worker updates as ffmpeg runs. This
 * joins the two so the client polls a single endpoint: it reads `status` from
 * the row and `progress` from the job (0 until the job is claimed, 100 once the
 * row flips to `done`). A failed render surfaces the job's error too, since the
 * row's `error` is only written on the terminal failure.
 *
 * It also reports the delivery metadata the clip page shows: the preset's output
 * `width`/`height`, the clip `durationSec`, and `fileSizeBytes` once the file
 * exists on disk.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json(
      { error: "Export id must be a positive integer", code: "invalid_id" },
      { status: 400 },
    );
  }

  const row = db.select().from(exports).where(eq(exports.id, id)).get();
  if (!row) {
    return NextResponse.json({ error: `No export with id ${id}`, code: "not_found" }, { status: 404 });
  }

  const job = row.jobId === null ? null : createJobQueue(db).get(row.jobId);

  // `done` pins progress at 100 even if the terminal 100 tick lost the race with
  // the status write; otherwise trust the job's live value, or 0 pre-claim.
  const progress = row.status === "done" ? 100 : (job?.progress ?? 0);
  const error = row.error ?? job?.error ?? null;

  const clip = db
    .select({ inPoint: clips.inPoint, outPoint: clips.outPoint })
    .from(clips)
    .where(eq(clips.id, row.clipId))
    .get();
  const durationSec = clip ? Math.max(0, clip.outPoint - clip.inPoint) : null;
  const { width, height } = exportPresetDimensions(row.preset);

  return NextResponse.json({
    export: row,
    status: row.status,
    progress,
    error,
    job,
    width,
    height,
    durationSec,
    fileSizeBytes: fileSizeBytes(row.status, row.outputPath),
  });
}
