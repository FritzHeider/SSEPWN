import { eq } from "drizzle-orm";

import { clips, projects } from "../../lib/db/schema";
import { generateThumbnail } from "../../lib/ffmpeg/thumbnail";
import { clipThumbnailPath } from "../../lib/media/derived";
import type { JobContext, JobHandler } from "./index";

/** Poster width — same sizing approach as project posters (ingest THUMBNAIL_WIDTH). */
export const CLIP_THUMBNAIL_WIDTH = 640;

/** How a clip-thumbnail job is addressed: the clip to grab a poster for. */
export interface ClipThumbnailPayload {
  clipId: number;
}

/**
 * Validate the payload at the boundary. Written by our own enqueue sites
 * (generate-clips, manual add, regenerate) but still free-form JSON out of the
 * `jobs` table, so a bad shape fails the job with a clear message.
 */
export function parseClipThumbnailPayload(raw: unknown): ClipThumbnailPayload {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("clip-thumbnail payload must be an object with { clipId }");
  }
  const obj = raw as Record<string, unknown>;
  if (!Number.isInteger(obj.clipId) || (obj.clipId as number) <= 0) {
    throw new Error(`clip-thumbnail payload needs a positive integer clipId, got ${obj.clipId}`);
  }
  return { clipId: obj.clipId as number };
}

export interface ClipThumbnailHandlerOptions {
  /** Injected in tests; defaults to the real ffmpeg thumbnail extractor. */
  generateThumbnailFn?: typeof generateThumbnail;
  /** Where the poster lands; defaults to the shared derived-path helper. */
  pathFor?: (clipId: number) => string;
}

/**
 * `clip-thumbnail` — extract a poster frame at a clip's in-point into
 * `data/derived/clip-thumbs/<clipId>.jpg` (phase-BE task 4). Enqueued per clip by
 * generate-clips (and thus regenerate) and by the manual-add route. All ffmpeg
 * work stays in the worker per the global constraint.
 */
export function createClipThumbnailHandler(options: ClipThumbnailHandlerOptions = {}): JobHandler {
  const generateThumbnailFn = options.generateThumbnailFn ?? generateThumbnail;
  const pathFor = options.pathFor ?? clipThumbnailPath;

  return async function clipThumbnail({ job, db, setProgress }: JobContext): Promise<void> {
    const { clipId } = parseClipThumbnailPayload(job.payload);

    const clip = db
      .select({ id: clips.id, projectId: clips.projectId, inPoint: clips.inPoint })
      .from(clips)
      .where(eq(clips.id, clipId))
      .get();
    if (!clip) {
      throw new Error(`clip-thumbnail: no clip with id ${clipId} (job ${job.id})`);
    }
    if (clip.projectId !== job.projectId) {
      throw new Error(
        `clip-thumbnail: clip ${clip.id} belongs to project ${clip.projectId}, not job project ${job.projectId}`,
      );
    }

    const project = db
      .select({ sourceVideoPath: projects.sourceVideoPath })
      .from(projects)
      .where(eq(projects.id, clip.projectId))
      .get();
    if (!project?.sourceVideoPath) {
      throw new Error(`clip-thumbnail: project ${clip.projectId} has no source video to poster.`);
    }

    setProgress(20);
    await generateThumbnailFn(project.sourceVideoPath, pathFor(clipId), {
      atSeconds: Math.max(0, clip.inPoint),
      width: CLIP_THUMBNAIL_WIDTH,
    });
    setProgress(100);
  };
}
