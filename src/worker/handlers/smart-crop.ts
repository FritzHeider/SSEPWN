import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq, sql } from "drizzle-orm";

import { clipEdits, clips, projects } from "../../lib/db/schema";
import { buildCropState, readCropState, withCropState } from "../../lib/crop/state";
import { planCrop } from "../../lib/crop/plan";
import { parseAspectRatio, type AspectRatio, type FrameSample, type SubjectDetector } from "../../lib/crop/types";
import { sampleFrames as realSampleFrames, type SampledFrame } from "../../lib/ffmpeg/frames";
import type { JobHandler, JobContext } from "./index";

/** Default seconds between sampled frames when a payload does not say. */
export const DEFAULT_SAMPLE_EVERY_SEC = 1;

/** How a smart-crop job is addressed: one clip, one target aspect ratio. */
export interface SmartCropPayload {
  clipId: number;
  aspectRatio: AspectRatio;
  /** Seconds between sampled frames; defaults to {@link DEFAULT_SAMPLE_EVERY_SEC}. */
  sampleEverySec?: number;
}

/**
 * Validate a smart-crop job payload at the boundary. The payload is written by
 * our own crop API (already validated) but is still free-form JSON out of the
 * `jobs` table, so a bad shape fails the job with a clear message rather than
 * feeding `NaN` into `sampleFrames`/`planCrop`.
 */
export function parseSmartCropPayload(raw: unknown): SmartCropPayload {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("smart-crop payload must be an object with { clipId, aspectRatio }");
  }
  const obj = raw as Record<string, unknown>;
  if (!Number.isInteger(obj.clipId) || (obj.clipId as number) <= 0) {
    throw new Error(`smart-crop payload needs a positive integer clipId, got ${obj.clipId}`);
  }
  const aspectRatio = parseAspectRatio(obj.aspectRatio);
  let sampleEverySec = DEFAULT_SAMPLE_EVERY_SEC;
  if (obj.sampleEverySec !== undefined) {
    if (typeof obj.sampleEverySec !== "number" || !Number.isFinite(obj.sampleEverySec) || obj.sampleEverySec <= 0) {
      throw new Error(`smart-crop payload sampleEverySec must be a positive number, got ${obj.sampleEverySec}`);
    }
    sampleEverySec = obj.sampleEverySec;
  }
  return { clipId: obj.clipId as number, aspectRatio, sampleEverySec };
}

export interface SmartCropHandlerOptions {
  /**
   * The subject detector to run on each sampled frame. Injected in tests
   * (`FakeDetector`); in production a real `HumanFaceDetector` is passed here.
   * When omitted the handler fails loudly the moment it runs, rather than
   * silently producing a static center crop — the same "no backend ⇒ throw"
   * contract `SubjectDetector.detect` documents.
   */
  detector?: SubjectDetector;
  /** Frame extractor, injectable so the DB/wiring can be tested without ffmpeg. */
  sampleFramesFn?: typeof realSampleFrames;
}

function requireDetector(detector: SubjectDetector | undefined): SubjectDetector {
  if (detector) return detector;
  throw new Error(
    "smart-crop: no SubjectDetector configured. Pass one to createSmartCropHandler " +
      "(HumanFaceDetector in production, FakeDetector under test). See phase-06.",
  );
}

/**
 * `smart-crop` — reframe one clip to a target aspect ratio (SPEC.md § Smart crop,
 * phase-06). Enqueued by `POST /api/clips/:id/crop`.
 *
 * The wiring only: sample frames across the clip's `[in, out]` range, run the
 * injected `SubjectDetector` on each, hand the resulting `FrameSample[]` to the
 * pure `planCrop`, and persist the keyframes + chosen AR into
 * `clip_edits.state.crop`. All of the reframe logic lives in `planCrop`; all of
 * the ffmpeg lives in `sampleFrames`. This handler renders NO video — the crop is
 * a set of keyframes previewed as an overlay; actual cropped output is Phase 10.
 *
 * A crop the user has locked (manual override) is left untouched, so "re-run
 * auto" cannot clobber a hand-tuned crop (phase-06 acceptance).
 */
export function createSmartCropHandler(options: SmartCropHandlerOptions = {}): JobHandler {
  const sampleFramesFn = options.sampleFramesFn ?? realSampleFrames;

  return async function smartCrop({ job, db, setProgress }: JobContext): Promise<void> {
    const payload = parseSmartCropPayload(job.payload);

    const clip = db
      .select({
        id: clips.id,
        projectId: clips.projectId,
        inPoint: clips.inPoint,
        outPoint: clips.outPoint,
      })
      .from(clips)
      .where(eq(clips.id, payload.clipId))
      .get();
    if (!clip) {
      throw new Error(`smart-crop: no clip with id ${payload.clipId} (job ${job.id})`);
    }
    if (clip.projectId !== job.projectId) {
      throw new Error(
        `smart-crop: clip ${clip.id} belongs to project ${clip.projectId}, not job project ${job.projectId}`,
      );
    }

    const project = db
      .select({
        sourceVideoPath: projects.sourceVideoPath,
        width: projects.width,
        height: projects.height,
      })
      .from(projects)
      .where(eq(projects.id, clip.projectId))
      .get();
    if (!project?.sourceVideoPath) {
      throw new Error(`smart-crop: project ${clip.projectId} has no source video to crop.`);
    }
    if (!project.width || !project.height) {
      throw new Error(`smart-crop: project ${clip.projectId} has no ingested dimensions yet.`);
    }
    const srcW = project.width;
    const srcH = project.height;

    // Read the existing edit blob once. A locked crop is the user's — leave it,
    // whatever aspect ratio "re-run auto" asked for, so the manual override wins.
    const existing = db
      .select({ state: clipEdits.state })
      .from(clipEdits)
      .where(eq(clipEdits.clipId, clip.id))
      .get();
    let state: Record<string, unknown> = {};
    if (existing) {
      try {
        const parsed = JSON.parse(existing.state);
        if (typeof parsed === "object" && parsed !== null) state = parsed as Record<string, unknown>;
      } catch {
        state = {};
      }
    }
    if (readCropState(state)?.locked) {
      setProgress(100);
      return;
    }

    const detector = requireDetector(options.detector);
    const duration = Math.max(clip.outPoint - clip.inPoint, 0);

    setProgress(10);
    const dir = await mkdtemp(path.join(tmpdir(), "sseclone-smart-crop-"));
    try {
      const frames: SampledFrame[] = await sampleFramesFn(
        project.sourceVideoPath,
        payload.sampleEverySec ?? DEFAULT_SAMPLE_EVERY_SEC,
        dir,
        { startSec: clip.inPoint, durationSec: duration > 0 ? duration : undefined },
      );
      setProgress(45);

      // Detect sequentially (in time order): FakeDetector maps its script to call
      // order, and running detection one frame at a time keeps peak memory flat.
      const samples: FrameSample[] = [];
      for (const frame of frames) {
        const boxes = await detector.detect(frame.path);
        samples.push({ t: frame.t, boxes });
      }
      setProgress(80);

      const keyframes = planCrop(samples, srcW, srcH, payload.aspectRatio);
      const cropState = buildCropState(payload.aspectRatio, keyframes, srcW, srcH, false);
      const serialized = JSON.stringify(withCropState(state, cropState));

      if (existing) {
        db
          .update(clipEdits)
          .set({ state: serialized, updatedAt: sql`(unixepoch())` })
          .where(eq(clipEdits.clipId, clip.id))
          .run();
      } else {
        db.insert(clipEdits).values({ clipId: clip.id, state: serialized }).run();
      }
      setProgress(100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
