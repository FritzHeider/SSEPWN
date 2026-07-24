import { eq } from "drizzle-orm";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { waveformPath } from "@/lib/media/derived";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Waveforms are transparent PNGs written by the ingest handler. */
const WAVEFORM_CONTENT_TYPE = "image/png";

const CACHE_CONTROL = "private, max-age=60";

function notFound(message: string, code: string) {
  return NextResponse.json({ error: message, code }, { status: 404 });
}

/**
 * GET /api/projects/:id/waveform — the project's audio-waveform image.
 *
 * Rendered only for projects with audio and best-effort, so a clean 404 (rather
 * than a 500) is the normal answer for a no-audio project or one whose ingest
 * waveform step failed. Same fd-open-before-response idiom as the thumbnail
 * routes; the only input is the integer id.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json(
      { error: "Project id must be a positive integer", code: "invalid_id" },
      { status: 400 },
    );
  }

  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get();
  if (!project) {
    return notFound(`No project with id ${id}`, "not_found");
  }

  let handle: FileHandle;
  let size: number;
  try {
    handle = await open(waveformPath(id), "r");
  } catch {
    return notFound(`Project ${id} has no waveform`, "no_waveform");
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      return notFound(`Waveform for project ${id} is not a file`, "waveform_missing");
    }
    size = stats.size;
  } catch (error) {
    await handle.close();
    throw error;
  }

  const body = Readable.toWeb(handle.createReadStream()) as unknown as WebReadableStream<Uint8Array>;

  return new Response(body as unknown as BodyInit, {
    headers: {
      "content-type": WAVEFORM_CONTENT_TYPE,
      "content-length": String(size),
      "cache-control": CACHE_CONTROL,
    },
  });
}
