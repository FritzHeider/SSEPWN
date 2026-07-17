import { eq } from "drizzle-orm";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { parseRangeHeader, rangeLength } from "@/lib/api/range";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { videoContentType } from "@/lib/upload/allowed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Uploads are immutable — the pipeline writes derived files elsewhere and never
 * rewrites the source — so a long private cache is safe and keeps a seeking
 * `<video>` from refetching the same bytes on every scrub.
 */
const CACHE_CONTROL = "private, max-age=3600";

/**
 * An upload whose extension the allow-list does not claim cannot happen through
 * `receive.ts`, but a mislabelled body is worse than an unlabelled one: browsers
 * sniff `application/octet-stream` and refuse to guess, which fails loudly,
 * whereas calling a .webm `video/mp4` fails as an unexplained decode error.
 */
const UNKNOWN_CONTENT_TYPE = "application/octet-stream";

function notFound(message: string, code: string) {
  return NextResponse.json({ error: message, code }, { status: 404 });
}

/**
 * GET /api/projects/:id/video — the project's source video, with Range support.
 *
 * Uploads live in `data/uploads/`, outside `public/`, so Next will not serve
 * them statically and the project page has no URL to point a `<video>` at. This
 * route is that URL — the same reason the thumbnail route exists, and it shares
 * that route's shape: open the fd before building the response so an unlinked
 * file can still become a 404 instead of a truncated 200.
 *
 * Unlike the poster, this must speak Range. A 200-only route leaves the UA no
 * way to jump to a timestamp without refetching from byte 0, which makes the
 * transcript panel's seek-on-click unreliable in real browsers even though every
 * unit test would pass. `Accept-Ranges` is what invites the UA to try.
 *
 * Path-traversal surface: none. The only client input is an integer id, and the
 * path served comes from the project row, written solely by the upload route.
 * Nothing from the URL reaches the filesystem.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json(
      { error: "Project id must be a positive integer", code: "invalid_id" },
      { status: 400 },
    );
  }

  const project = db
    .select({ sourceVideoPath: projects.sourceVideoPath })
    .from(projects)
    .where(eq(projects.id, id))
    .get();
  if (!project) {
    return notFound(`No project with id ${id}`, "not_found");
  }
  if (!project.sourceVideoPath) {
    return notFound(`Project ${id} has no source video`, "no_source_video");
  }

  let handle: FileHandle;
  let size: number;
  try {
    handle = await open(project.sourceVideoPath, "r");
  } catch {
    return notFound(`Source video for project ${id} is no longer on disk`, "source_video_missing");
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      return notFound(`Source video for project ${id} is not a file`, "source_video_missing");
    }
    size = stats.size;
  } catch (error) {
    await handle.close();
    throw error;
  }

  const contentType = videoContentType(project.sourceVideoPath) ?? UNKNOWN_CONTENT_TYPE;
  const range = parseRangeHeader(request.headers.get("range"), size);

  if (range.kind === "unsatisfiable") {
    await handle.close();
    // `bytes */size` is the whole point of a 416: it tells the client how far it
    // may actually seek, so it can correct itself rather than retry blindly.
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes" },
    });
  }

  // The stream closes the handle when it ends or is destroyed (a cancelled
  // response destroys it), so there is no fd to clean up past this point.
  const stream = (options?: { start: number; end: number }) =>
    Readable.toWeb(handle.createReadStream(options)) as unknown as WebReadableStream<Uint8Array>;

  if (range.kind === "partial") {
    return new Response(stream({ start: range.start, end: range.end }) as unknown as BodyInit, {
      status: 206,
      headers: {
        "content-type": contentType,
        "content-length": String(rangeLength(range)),
        "content-range": `bytes ${range.start}-${range.end}/${size}`,
        "accept-ranges": "bytes",
        "cache-control": CACHE_CONTROL,
      },
    });
  }

  return new Response(stream() as unknown as BodyInit, {
    headers: {
      "content-type": contentType,
      "content-length": String(size),
      "accept-ranges": "bytes",
      "cache-control": CACHE_CONTROL,
    },
  });
}
