import { eq } from "drizzle-orm";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { exports } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(message: string, code: string, status: number) {
  return NextResponse.json({ error: message, code }, { status });
}

/**
 * GET /api/exports/:id/download — stream the rendered MP4 as an attachment.
 *
 * Only a `done` export with an `outputPath` is downloadable; a still-rendering
 * (409) or failed export has no file to serve. The path comes from the
 * `exports` row (written solely by the export job to `data/exports/`), never
 * from client input, so there is no traversal surface — the only input is an
 * integer id. The fd is opened before the response is built so an export whose
 * file was cleaned up off disk becomes a clean 404, not a truncated 200.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return jsonError("Export id must be a positive integer", "invalid_id", 400);
  }

  const row = db.select().from(exports).where(eq(exports.id, id)).get();
  if (!row) {
    return jsonError(`No export with id ${id}`, "not_found", 404);
  }
  if (row.status !== "done" || !row.outputPath) {
    return jsonError(
      `Export ${id} is not ready to download (status: ${row.status})`,
      "not_ready",
      409,
    );
  }

  let handle: FileHandle;
  let size: number;
  try {
    handle = await open(row.outputPath, "r");
  } catch {
    return jsonError(`File for export ${id} is no longer on disk`, "file_missing", 404);
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      return jsonError(`File for export ${id} is not a file`, "file_missing", 404);
    }
    size = stats.size;
  } catch (error) {
    await handle.close();
    throw error;
  }

  const filename = path.basename(row.outputPath);
  // The stream closes the handle when it ends or the response is cancelled.
  const stream = Readable.toWeb(handle.createReadStream()) as unknown as WebReadableStream<Uint8Array>;

  return new Response(stream as unknown as BodyInit, {
    headers: {
      "content-type": "video/mp4",
      "content-length": String(size),
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, max-age=0, must-revalidate",
    },
  });
}
