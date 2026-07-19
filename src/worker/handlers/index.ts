import { HumanFaceDetector } from "../../lib/crop/human";
import type { Job, JobsDb } from "../../lib/jobs";
import { createExportHandler } from "./export";
import { createGenerateClipsHandler } from "./generate-clips";
import { createIngestHandler } from "./ingest";
import { createProbeAssetHandler } from "./probe-asset";
import { createSmartCropHandler } from "./smart-crop";
import { createTranscribeHandler } from "./transcribe";

/** Everything a handler is allowed to touch. */
export interface JobContext {
  job: Job;
  db: JobsDb;
  /** Report progress 0–100; clamped by the queue. */
  setProgress(progress: number): void;
}

/**
 * A handler owns one job type. Resolve to mark the job done; throw to fail the
 * attempt — the worker translates that into a retry-with-backoff or a terminal
 * failure. Handlers never touch job status themselves.
 */
export type JobHandler = (ctx: JobContext) => Promise<void>;

export type HandlerRegistry = Record<string, JobHandler>;

/**
 * Job type → handler. Later phases extend the pipeline by adding entries here
 * (ingest in Phase 02, transcribe in Phase 03, generate-clips in Phase 04,
 * smart-crop in Phase 06, …); the worker loop itself does not change.
 *
 * `smart-crop` runs with the real `HumanFaceDetector` (phase-06). The detector
 * is constructed here but loads nothing until its first `detect` call, so wiring
 * it in pulls in no TF.js and touches no disk; an enqueued job that reaches a
 * machine without the opt-in `@vladmandic/human` backend or its models fails
 * loudly with an actionable install/setup message (README § Smart crop) rather
 * than silently producing a static center crop.
 */
export const handlers: HandlerRegistry = {
  ingest: createIngestHandler(),
  transcribe: createTranscribeHandler(),
  "generate-clips": createGenerateClipsHandler(),
  "smart-crop": createSmartCropHandler({ detector: new HumanFaceDetector() }),
  "probe-asset": createProbeAssetHandler(),
  export: createExportHandler(),
};
