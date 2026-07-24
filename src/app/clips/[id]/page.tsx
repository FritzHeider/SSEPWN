import { desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { EditorShell } from "./_components/editor-shell";
import { parseId } from "@/lib/api/params";
import type { CaptionDoc } from "@/lib/captions/ass";
import { buildCaptionDoc, readCaptionDoc } from "@/lib/captions/edit";
import { readCropState, type CropState } from "@/lib/crop/state";
import { db } from "@/lib/db";
import { clipEdits, clips, exports, projects, transcripts } from "@/lib/db/schema";
import type { ExportRow } from "@/lib/export/view";
import { isPlatformPresetId, readClipPreset, type PlatformPresetId } from "@/lib/presets";
import { formatDuration } from "@/lib/projects/view";
import { hasTemplateUndo } from "@/lib/templates/apply";
import { listTemplates } from "@/lib/templates/db";
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

  // Template gallery + platform-preset picker state, all read from the same
  // `clip_edits.state` blob (plus the project default preset). Applying is done
  // via the API route, so the page only supplies initial data.
  const stateObj: Record<string, unknown> =
    parsedState !== null && typeof parsedState === "object"
      ? (parsedState as Record<string, unknown>)
      : {};
  const templates = listTemplates(db);
  const appliedTemplateId =
    typeof stateObj.templateId === "number" ? stateObj.templateId : null;
  const presetOverride: PlatformPresetId | null = readClipPreset(stateObj);
  const projectPreset: PlatformPresetId | null = isPlatformPresetId(project.platformPreset)
    ? project.platformPreset
    : null;

  // Export history for this clip, newest first — same ordering the history API
  // returns; the panel polls live rows and prepends new ones.
  const exportHistory = db
    .select()
    .from(exports)
    .where(eq(exports.clipId, id))
    .orderBy(desc(exports.id))
    .all() as ExportRow[];

  const title = clip.title ?? `Clip ${clip.id}`;
  const range = `${formatDuration(clip.inPoint)} – ${formatDuration(clip.outPoint)}`;

  return (
    <EditorShell
      clipId={clip.id}
      projectId={clip.projectId}
      projectName={project.name}
      title={title}
      range={range}
      inPoint={clip.inPoint}
      outPoint={clip.outPoint}
      srcWidth={project.width ?? 0}
      srcHeight={project.height ?? 0}
      referenceHeight={project.height}
      projectDuration={project.duration}
      captionDoc={doc}
      initialCrop={crop}
      initialTimeline={timeline}
      templates={templates}
      appliedTemplateId={appliedTemplateId}
      templateCanUndo={hasTemplateUndo(stateObj)}
      durationSec={clip.outPoint - clip.inPoint}
      presetOverride={presetOverride}
      projectPreset={projectPreset}
      initialExports={exportHistory}
    />
  );
}
