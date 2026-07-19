import { eq } from "drizzle-orm";

import { projects } from "../db/schema";
import { createJobQueue, type Job, type JobsDb } from "../jobs";

/**
 * The automatic upload pipeline, in chain order. Each handler enqueues the next
 * only on success (ingest → transcribe → generate-clips), so a failure at one
 * step leaves every downstream step un-enqueued and the chain stalled here.
 *
 * On-demand jobs (`smart-crop`, `export`, `probe-asset`) are deliberately absent:
 * they are user actions with their own retry affordances, not part of the
 * upload-time chain a "retry from failed step" restarts.
 */
export const PIPELINE_JOB_TYPES = ["ingest", "transcribe", "generate-clips"] as const;

export type PipelineJobType = (typeof PIPELINE_JOB_TYPES)[number];

/** Human-readable name of each pipeline step, for the retry button label. */
export const PIPELINE_STEP_LABELS: Readonly<Record<string, string>> = {
  ingest: "processing",
  transcribe: "transcription",
  "generate-clips": "clip generation",
};

/**
 * The failed pipeline step to resume from, or null when nothing is stuck.
 *
 * Earliest-in-chain wins: if two pipeline steps somehow show `failed`, restarting
 * from the earliest one re-runs the rest of the chain in order (its handler
 * re-enqueues the next step on success), which is exactly what the user means by
 * "retry from where it broke". In practice at most one is failed, since a step
 * that fails never enqueues its successor.
 */
export function findFailedStep(jobs: readonly Job[]): Job | null {
  for (const type of PIPELINE_JOB_TYPES) {
    const failed = jobs.find((job) => job.type === type && job.status === "failed");
    if (failed) return failed;
  }
  return null;
}

/**
 * Whether the generate-clips step has run to completion at least once.
 *
 * A `done` generate-clips job is the one durable signal that the auto-highlight
 * pass actually finished — distinct from "not enqueued yet" (upload still in the
 * transcribe leg) and from "failed" (a stall the retry button handles). The
 * clips panel uses it to tell a genuinely zero-highlight video (offer manual
 * clipping) apart from one whose generation simply has not happened yet.
 */
export function clipGenerationComplete(jobs: readonly Job[]): boolean {
  return jobs.some((job) => job.type === "generate-clips" && job.status === "done");
}

export type RetryReason = "project_not_found" | "no_failed_step";

export interface RetryResult {
  retried: boolean;
  /** Present when `retried` — the freshly enqueued job that resumes the chain. */
  job?: Job;
  /** Present when `!retried` — why nothing was requeued. */
  reason?: RetryReason;
}

/**
 * Resume a stalled upload pipeline by re-enqueuing its failed step.
 *
 * A fresh job (rather than resetting the dead one) is enqueued so the requeued
 * step gets a clean attempt budget and the failed row stays as a record of what
 * broke. Because each pipeline handler enqueues the next on success, requeuing
 * the earliest failed step is enough to drive the whole remaining chain.
 *
 * A project left `failed` by an ingest failure is reset to `uploaded`
 * ("Processing") and its error cleared, so the dashboard reflects that work has
 * resumed; transcribe/generate-clips failures never touch project status, so
 * there is nothing to reset for them. The status flip and the enqueue share one
 * transaction — the UI must never see a cleared error beside no running job.
 */
export function retryPipeline(db: JobsDb, projectId: number): RetryResult {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return { retried: false, reason: "project_not_found" };

  const failed = findFailedStep(createJobQueue(db).listByProject(projectId));
  if (!failed) return { retried: false, reason: "no_failed_step" };

  return db.transaction((tx): RetryResult => {
    if (project.status === "failed") {
      tx.update(projects).set({ status: "uploaded", error: null }).where(eq(projects.id, projectId)).run();
    }
    // Preserve the original payload (ingest carries `{ path }`); null → no payload.
    const payload = failed.payload === null ? undefined : failed.payload;
    const job = createJobQueue(tx).enqueue(failed.type, projectId, payload);
    return { retried: true, job };
  });
}
