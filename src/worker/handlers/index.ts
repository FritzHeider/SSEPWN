import type { Job, JobsDb } from "../../lib/jobs";
import { createIngestHandler } from "./ingest";
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
 * (ingest in Phase 02, transcribe in Phase 03, …); the worker loop itself does
 * not change.
 */
export const handlers: HandlerRegistry = {
  ingest: createIngestHandler(),
  transcribe: createTranscribeHandler(),
};
