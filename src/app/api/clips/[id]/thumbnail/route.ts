import { eq } from "drizzle-orm";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { clips } from "@/lib/db/schema";
import { clipThumbnailPath } from "@/lib/media/derived";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Clip posters are JPEGs written by the clip-thumbnail handler. */
const POSTER_CONTENT_TYPE = "image/jpeg";

/** A clip poster changes only when the clip is re-generated at a new in-point;
 * a minute is a generous bound that keeps a polling grid from refetching every
 * poster on every refresh. */
const CACHE_CONTROL = "private, max-age=60";

function notFound(message: string, code: string) {
  return NextResponse.json({ error: message, code }, { status: 404 });
}

/**
 * GET /api/clips/:id/thumbnail — the clip's poster frame.
 *
 * Mirrors the project thumbnail route: the poster lives under `data/derived/`
 * (outside `public/`), so this is the only URL an `<img>` can point at. The path
 * is derived from the integer id alone (no client string reaches the fs), and the
 * fd is opened before the response is built so a not-yet-generated or cleaned-up
 * poster becomes a clean 404 rather than a truncated 200.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json(
      { error: "Clip id must be a positive integer", code: "invalid_id" },
      { status: 400 },
    );
  }

  const clip = db.select({ id: clips.id }).from(clips).where(eq(clips.id, id)).get();
  if (!clip) {
    return notFound(`No clip with id ${id}`, "not_found");
  }

  let handle: FileHandle;
  let size: number;
  try {
    handle = await open(clipThumbnailPath(id), "r");
  } catch {
    return notFound(`Clip ${id} has no poster yet`, "no_thumbnail");
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      return notFound(`Poster for clip ${id} is not a file`, "thumbnail_missing");
    }
    size = stats.size;
  } catch (error) {
    await handle.close();
    throw error;
  }

  const body = Readable.toWeb(handle.createReadStream()) as unknown as WebReadableStream<Uint8Array>;

  return new Response(body as unknown as BodyInit, {
    headers: {
      "content-type": POSTER_CONTENT_TYPE,
      "content-length": String(size),
      "cache-control": CACHE_CONTROL,
    },
  });
}
