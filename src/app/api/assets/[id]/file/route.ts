import { eq } from "drizzle-orm";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { parseRangeHeader, rangeLength } from "@/lib/api/range";
import { db } from "@/lib/db";
import { assets } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Uploads are immutable — the probe worker writes derived files (posters)
 * elsewhere and never rewrites the asset — so a long private cache is safe and
 * keeps a seeking `<video>` from refetching the same bytes on every scrub.
 */
const CACHE_CONTROL = "private, max-age=3600";

/**
 * A stored MIME is trusted (it was validated against the asset allow-list at
 * upload), but a missing one must fail loudly: browsers refuse to guess
 * `application/octet-stream`, which surfaces as an obvious error rather than a
 * silently mis-decoded stream.
 */
const UNKNOWN_CONTENT_TYPE = "application/octet-stream";

function notFound(message: string, code: string) {
  return NextResponse.json({ error: message, code }, { status: 404 });
}

/**
 * GET /api/assets/:id/file — an asset's raw bytes, with Range support.
 *
 * B-roll / SFX / CTA-image assets live in `data/assets/`, outside `public/`, so
 * Next will not serve them statically and the editor's preview overlay has no
 * URL to point a `<video>` (or `<audio>`) at. This route is that URL, mirroring
 * `/api/projects/:id/video`: open the fd before building the response so an
 * unlinked file still becomes a 404 rather than a truncated 200, and speak
 * Range so an overlay `<video>` can seek to the playhead without refetching from
 * byte 0.
 *
 * Path-traversal surface: none. The only client input is an integer id; the
 * served path comes from the asset row, written solely by the upload route.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json(
      { error: "Asset id must be a positive integer", code: "invalid_id" },
      { status: 400 },
    );
  }

  const asset = db
    .select({ path: assets.path, mime: assets.mime })
    .from(assets)
    .where(eq(assets.id, id))
    .get();
  if (!asset) {
    return notFound(`No asset with id ${id}`, "not_found");
  }

  let handle: FileHandle;
  let size: number;
  try {
    handle = await open(asset.path, "r");
  } catch {
    return notFound(`File for asset ${id} is no longer on disk`, "asset_missing");
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      return notFound(`File for asset ${id} is not a file`, "asset_missing");
    }
    size = stats.size;
  } catch (error) {
    await handle.close();
    throw error;
  }

  const contentType = asset.mime ?? UNKNOWN_CONTENT_TYPE;
  const range = parseRangeHeader(request.headers.get("range"), size);

  if (range.kind === "unsatisfiable") {
    await handle.close();
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
