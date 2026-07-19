import { eq } from "drizzle-orm";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { assets } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The asset-probe worker writes every poster as a JPEG (`asset-<id>.jpg`, probe.ts). */
const POSTER_CONTENT_TYPE = "image/jpeg";

/**
 * A poster is a deterministic seek on an immutable upload, so it never changes
 * once written. A minute is a generous staleness bound and keeps the picker
 * from refetching every poster on every browse.
 */
const CACHE_CONTROL = "private, max-age=60";

function notFound(message: string, code: string) {
  return NextResponse.json({ error: message, code }, { status: 404 });
}

/**
 * GET /api/assets/:id/thumbnail — the asset's poster frame.
 *
 * Asset posters live in the thumbnail dir (outside `public/`), so Next will not
 * serve them statically and the picker's browse grid has no URL to point an
 * `<img>` at. This route is that URL, mirroring `/api/projects/:id/thumbnail`.
 *
 * No path-traversal surface: the only client input is an integer id, and the
 * served path comes from the asset row (written solely by the probe worker).
 * Audio assets and not-yet-probed uploads have no `thumbnailPath` and 404.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json(
      { error: "Asset id must be a positive integer", code: "invalid_id" },
      { status: 400 },
    );
  }

  const asset = db
    .select({ thumbnailPath: assets.thumbnailPath })
    .from(assets)
    .where(eq(assets.id, id))
    .get();
  if (!asset) {
    return notFound(`No asset with id ${id}`, "not_found");
  }
  if (!asset.thumbnailPath) {
    return notFound(`Asset ${id} has no poster`, "no_thumbnail");
  }

  // Open BEFORE building the response (same discipline as the project poster
  // route): a deleted poster must become a 404, and a stream that discovers the
  // missing file after the 200 headers are sent could only truncate the body.
  let handle: FileHandle;
  let size: number;
  try {
    handle = await open(asset.thumbnailPath, "r");
  } catch {
    return notFound(`Poster for asset ${id} is no longer on disk`, "thumbnail_missing");
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      return notFound(`Poster for asset ${id} is not a file`, "thumbnail_missing");
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
