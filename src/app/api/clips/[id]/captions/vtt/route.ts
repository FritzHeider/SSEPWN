import { NextResponse } from "next/server";

import { parseId } from "@/lib/api/params";
import { loadClipCaptionDoc } from "@/lib/captions/load";
import { captionDocToVtt } from "@/lib/captions/subtitle";
import { db } from "@/lib/db";
import { slugify } from "@/lib/slug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/clips/:id/captions/vtt — the clip's captions as a WebVTT sidecar.
 *
 * Sibling of the `.srt` route (see it for why a `/captions/vtt` subpath is used).
 * Same caption-doc loading and title-slug filename; only the format differs.
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

  const body = captionDocToVtt(loaded.doc);
  const filename = `${slugify(loaded.clip.title ?? "") || "clip"}.vtt`;

  return new Response(body, {
    headers: {
      "content-type": "text/vtt; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, max-age=0, must-revalidate",
    },
  });
}
