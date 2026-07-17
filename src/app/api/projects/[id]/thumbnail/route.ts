import { eq } from "drizzle-orm";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ingest generates every poster as a JPEG (`project-<id>.jpg`, ingest.ts). */
const POSTER_CONTENT_TYPE = "image/jpeg";

/**
 * A poster only changes if its project is re-ingested, which re-runs a
 * deterministic seek on an immutable source and so reproduces the same frame.
 * A minute is therefore a generous staleness bound, and it keeps the polling
 * list from refetching every poster on every refresh.
 */
const CACHE_CONTROL = "private, max-age=60";

function notFound(message: string, code: string) {
  return NextResponse.json({ error: message, code }, { status: 404 });
}

/**
 * GET /api/projects/:id/thumbnail — the project's poster frame.
 *
 * Posters live in `data/thumbnails/`, which is outside `public/`, so Next will
 * not serve them statically and the list UI has no URL to point an `<img>` at.
 * This route is that URL.
 *
 * Note this reads a file from disk but has NO path-traversal surface: the only
 * client input is an integer id, and the path served comes from the project row
 * (written solely by the ingest handler). Nothing from the URL reaches the
 * filesystem.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json(
      { error: "Project id must be a positive integer", code: "invalid_id" },
      { status: 400 },
    );
  }

  const project = db
    .select({ thumbnailPath: projects.thumbnailPath })
    .from(projects)
    .where(eq(projects.id, id))
    .get();
  if (!project) {
    return notFound(`No project with id ${id}`, "not_found");
  }
  if (!project.thumbnailPath) {
    return notFound(`Project ${id} has no poster yet`, "no_thumbnail");
  }

  // Open BEFORE building the response rather than stat-then-stream: an unlinked
  // poster (data/ is a scratch dir) has to become a 404, and createReadStream
  // reports a missing file asynchronously — by then the 200 headers are already
  // sent and the failure can only truncate the body. Awaiting open() moves that
  // failure somewhere a status code can still describe it. Holding the fd also
  // makes the read immune to a delete that races this request.
  let handle: FileHandle;
  let size: number;
  try {
    handle = await open(project.thumbnailPath, "r");
  } catch {
    return notFound(`Poster for project ${id} is no longer on disk`, "thumbnail_missing");
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      return notFound(`Poster for project ${id} is not a file`, "thumbnail_missing");
    }
    size = stats.size;
  } catch (error) {
    await handle.close();
    throw error;
  }

  // The stream closes the handle when it ends or is destroyed (a cancelled
  // response destroys it), so there is no fd to clean up past this point.
  const body = Readable.toWeb(handle.createReadStream()) as unknown as WebReadableStream<Uint8Array>;

  return new Response(body as unknown as BodyInit, {
    headers: {
      "content-type": POSTER_CONTENT_TYPE,
      "content-length": String(size),
      "cache-control": CACHE_CONTROL,
    },
  });
}
