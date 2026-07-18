import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CaptionEditor } from "./_components/caption-editor";
import { CropPanel } from "./_components/crop-panel";
import { TimelinePanel } from "./_components/timeline-panel";
import { parseId } from "@/lib/api/params";
import type { CaptionDoc } from "@/lib/captions/ass";
import { buildCaptionDoc, readCaptionDoc } from "@/lib/captions/edit";
import { readCropState, type CropState } from "@/lib/crop/state";
import { db } from "@/lib/db";
import { clipEdits, clips, projects, transcripts } from "@/lib/db/schema";
import { formatDuration } from "@/lib/projects/view";
import { buildTimelineDoc, readTimelineDoc } from "@/lib/timeline/state";
import type { TranscriptSegment } from "@/lib/transcribe/types";

// Reads clips / clip_edits / transcripts per request; nothing here is static.
export const dynamic = "force-dynamic";

/** Parse a `transcripts.segments` JSON column into segments, tolerating garbage. */
function parseSegments(raw: string | null | undefined): TranscriptSegment[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TranscriptSegment[]) : [];
  } catch {
    return [];
  }
}

/**
 * `/clips/:id` — the clip caption editor.
 *
 * Reads the DB directly (like `/projects/:id`) rather than fetching its own API:
 * the first paint needs the clip, its project (for the source video URL and
 * reference dimensions) and the caption document, and an HTTP hop to our own
 * process would only add a way to fail.
 *
 * The caption document is loaded the same way `PATCH /api/clips/:id/captions`
 * loads it — the stored `clip_edits.state.captions` copy if the clip has been
 * edited, otherwise a fresh doc built from the project transcript. Building here
 * only READS `transcripts` (the isolation rule lives in the PATCH route, which is
 * the only writer); the page never persists, so an unedited clip stays unedited
 * until the user actually changes something.
 */
export default async function ClipEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (id === null) notFound();

  const clip = db.select().from(clips).where(eq(clips.id, id)).get();
  if (!clip) notFound();

  const project = db.select().from(projects).where(eq(projects.id, clip.projectId)).get();
  if (!project) notFound();

  const edit = db.select({ state: clipEdits.state }).from(clipEdits).where(eq(clipEdits.clipId, id)).get();
  let parsedState: unknown = null;
  if (edit) {
    try {
      parsedState = JSON.parse(edit.state);
    } catch {
      parsedState = null;
    }
  }
  let doc: CaptionDoc | null = parsedState === null ? null : readCaptionDoc(parsedState);
  const crop: CropState | null = readCropState(parsedState);
  if (doc === null) {
    const transcript = db
      .select({ segments: transcripts.segments })
      .from(transcripts)
      .where(eq(transcripts.projectId, clip.projectId))
      .get();
    doc = buildCaptionDoc(parseSegments(transcript?.segments), clip.inPoint, clip.outPoint);
  }

  // The edited timeline lives in the same `clip_edits.state` blob; fall back to a
  // fresh single-segment doc spanning the clip window (the GET route does the same
  // and, like it, we do not persist the fresh doc — the first edit PATCHes it).
  const timeline = readTimelineDoc(parsedState) ?? buildTimelineDoc(clip.inPoint, clip.outPoint);

  const title = clip.title ?? `Clip ${clip.id}`;
  const range = `${formatDuration(clip.inPoint)} – ${formatDuration(clip.outPoint)}`;

  return (
    <div className="flex flex-1 justify-center bg-zinc-50 px-6 py-12 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <Link
            href={`/projects/${clip.projectId}`}
            className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            ← {project.name}
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {title}
          </h1>
          <p className="font-mono text-sm tabular-nums text-zinc-500 dark:text-zinc-400">{range}</p>
        </header>

        <CropPanel
          clipId={clip.id}
          projectId={clip.projectId}
          inPoint={clip.inPoint}
          outPoint={clip.outPoint}
          srcWidth={project.width ?? 0}
          srcHeight={project.height ?? 0}
          initialCrop={crop}
        />

        <TimelinePanel
          clipId={clip.id}
          projectId={clip.projectId}
          initialDoc={timeline}
          captionDoc={doc}
        />

        <CaptionEditor
          clipId={clip.id}
          projectId={clip.projectId}
          inPoint={clip.inPoint}
          outPoint={clip.outPoint}
          referenceHeight={project.height}
          initialDoc={doc}
        />
      </main>
    </div>
  );
}
