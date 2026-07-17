import { eq } from "drizzle-orm";
import path from "node:path";

import { projects } from "../../lib/db/schema";
import { probe, type ProbeResult } from "../../lib/ffmpeg/exec";
import { generateThumbnail, posterTimestamp } from "../../lib/ffmpeg/thumbnail";
import type { JobHandler, JobContext } from "./index";

/** Where poster frames land; overridable so tests never write into the real data dir. */
export function thumbnailDir(): string {
  return process.env.SSECLONE_THUMBNAIL_DIR ?? path.join("data", "thumbnails");
}

/** Poster width — enough for the dashboard grid without storing a full-size frame. */
export const THUMBNAIL_WIDTH = 640;

export interface IngestHandlerOptions {
  /** Injected in tests; defaults to the real ffprobe/ffmpeg wrappers. */
  probeFn?: (path: string) => Promise<ProbeResult>;
  generateThumbnailFn?: typeof generateThumbnail;
  dir?: () => string;
}

/**
 * Turn any ingest failure into something a person can act on.
 *
 * `label` is the project's name (the original filename the user uploaded), never
 * the stored path: uploads are saved under a random UUID, so naming the file on
 * disk would tell the user nothing about which upload broke. The raw ffprobe
 * command and stderr stay on the job's own error column for debugging.
 */
function describeFailure(label: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  // Order matters: a missing file also fails via an `ffprobe` command, so the
  // ENOENT check has to run before the broader corrupt-file pattern below.
  if (/no such file|enoent/i.test(reason)) {
    return `"${label}" could not be found on disk — the upload may have been removed.`;
  }
  if (/no video stream/i.test(reason)) {
    return `"${label}" contains no video stream — upload a video file (mp4, mov, or webm).`;
  }
  if (/invalid data|moov atom|end of file|ffprobe/i.test(reason)) {
    return `"${label}" is not a readable video file — it may be corrupt or incompletely uploaded.`;
  }
  return `"${label}" could not be processed: ${reason}`;
}

/**
 * `ingest` — probe an uploaded video, record its metadata, and give it a poster
 * frame (phase-02: probe, thumbnail, status transitions).
 *
 * On a bad file the project is marked `failed` with a human-readable error and
 * the error is rethrown: job status is the queue's business, not a handler's, so
 * rethrowing is what lets the queue apply its retry-then-fail policy. A
 * transient failure that later succeeds self-corrects, since a winning attempt
 * sets the project back to `ready`.
 */
export function createIngestHandler(options: IngestHandlerOptions = {}): JobHandler {
  const probeFn = options.probeFn ?? probe;
  const generateThumbnailFn = options.generateThumbnailFn ?? generateThumbnail;
  const dir = options.dir ?? thumbnailDir;

  return async function ingest({ job, db, setProgress }: JobContext): Promise<void> {
    const [project] = db.select().from(projects).where(eq(projects.id, job.projectId)).all();
    if (!project) {
      throw new Error(`Project ${job.projectId} not found for ingest job ${job.id}`);
    }

    const sourcePath = project.sourceVideoPath;
    if (!sourcePath) {
      const message = `Project ${project.id} has no source video path to ingest.`;
      db.update(projects)
        .set({ status: "failed", error: message })
        .where(eq(projects.id, project.id))
        .run();
      throw new Error(message);
    }

    try {
      setProgress(10);
      const metadata = await probeFn(sourcePath);

      setProgress(50);
      const thumbnailPath = path.join(dir(), `project-${project.id}.jpg`);
      await generateThumbnailFn(sourcePath, thumbnailPath, {
        atSeconds: posterTimestamp(metadata.duration),
        width: THUMBNAIL_WIDTH,
      });

      setProgress(90);
      db.update(projects)
        .set({
          status: "ready",
          error: null,
          duration: metadata.duration,
          width: metadata.width,
          height: metadata.height,
          fps: metadata.fps,
          hasAudio: metadata.hasAudio,
          thumbnailPath,
        })
        .where(eq(projects.id, project.id))
        .run();
    } catch (error) {
      db.update(projects)
        .set({ status: "failed", error: describeFailure(project.name, error) })
        .where(eq(projects.id, project.id))
        .run();
      throw error;
    }
  };
}
