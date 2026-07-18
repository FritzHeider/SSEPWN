import type { Job, JobsDb } from "../../lib/jobs";
import { createGenerateClipsHandler } from "./generate-clips";
import { createIngestHandler } from "./ingest";
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
 * `smart-crop` is registered without a detector: the real `HumanFaceDetector`
 * (phase-06, still pending) will be injected here once it lands, at which point
 * the job runs end-to-end. Until then an enqueued smart-crop job fails loudly
 * with an actionable "no SubjectDetector configured" error rather than silently
 * producing a static center crop.
 */
export const handlers: HandlerRegistry = {
  ingest: createIngestHandler(),
  transcribe: createTranscribeHandler(),
  "generate-clips": createGenerateClipsHandler(),
  "smart-crop": createSmartCropHandler(),
};
