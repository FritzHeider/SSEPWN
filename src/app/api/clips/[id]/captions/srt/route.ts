import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { loadClipCaptionDoc } from "@/lib/captions/load";
import { captionDocToSrt } from "@/lib/captions/subtitle";
import { db } from "@/lib/db";
import { slugify } from "@/lib/slug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/clips/:id/captions/srt — the clip's captions as a SubRip sidecar.
 *
 * Uses a `/captions/srt` subpath rather than a `captions.srt` segment: a dot in a
 * route folder name is legal in the App Router but reads awkwardly, and this
 * nests cleanly under the existing `/captions` PATCH route. Loads the caption doc
 * exactly like that route (stored clip edit, else built from the transcript) and
 * serves it as an attachment named from the clip title slug.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) {
    return NextResponse.json(
      { error: "Clip id must be a positive integer", code: "invalid_id" },
      { status: 400 },
    );
  }

  const loaded = loadClipCaptionDoc(db, id);
  if (loaded === null) {
    return NextResponse.json({ error: `No clip with id ${id}`, code: "not_found" }, { status: 404 });
  }

  const body = captionDocToSrt(loaded.doc);
  const filename = `${slugify(loaded.clip.title ?? "") || "clip"}.srt`;

  return new Response(body, {
    headers: {
      "content-type": "application/x-subrip; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, max-age=0, must-revalidate",
    },
  });
}
