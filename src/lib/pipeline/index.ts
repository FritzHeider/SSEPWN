/**
 * Derive the ingest → transcribe → generate-clips pipeline status for a project
 * (phase-BE task 3), backing `GET /api/projects/:id/pipeline`.
 *
 * Pure: state in, steps out — no DB, no clock — so every edge case is
 * unit-testable. The `jobs` table is authoritative because jobs are never
 * deleted (delete-project aside): a step's status is its latest job's status,
 * with project-row facts (`hasAudio`, `transcribed`, `clipCount`) filling the
 * gaps a job row cannot express.
 *
 * This is a RICHER shape than `projects/view.ts` `pipelineSteps` (which drives
 * the dashboard stepper with done/active/failed/pending): here each step also
 * distinguishes `queued` vs `running` and carries `skipped` for the no-audio
 * transcribe case and an `error` string, which the project page's detailed
 * pipeline panel needs.
 */

export type PipelineStepStatus =
  | "done"
  | "running"
  | "queued"
  | "failed"
  | "skipped"
  | "pending";

export type PipelineStepKey = "ingest" | "transcribe" | "generate-clips";

export interface PipelineStep {
  key: PipelineStepKey;
  label: string;
  status: PipelineStepStatus;
  /** Failure message from the step's failed job, when there is one. */
  error?: string;
}

/** The one job fact this derivation reads. */
export interface PipelineJob {
  type: string;
  status: string;
  error: string | null;
}

export interface PipelineInput {
  /** Every job for the project, any order. */
  jobs: PipelineJob[];
  projectStatus: string;
  /** null = not probed yet (distinct from "no audio"). */
  hasAudio: boolean | null;
  transcribed: boolean;
  clipCount: number;
}

const LABELS: Record<PipelineStepKey, string> = {
  ingest: "Ingest",
  transcribe: "Transcribe",
  "generate-clips": "Generate clips",
};

/** The latest job of a type wins — jobs arrive oldest-first, so the last match
 * is the most recent attempt/regeneration. */
function latestJob(jobs: PipelineJob[], type: string): PipelineJob | null {
  let found: PipelineJob | null = null;
  for (const job of jobs) {
    if (job.type === type) found = job;
  }
  return found;
}

/** Map a raw job status onto a step status (queued/running/done/failed). */
function fromJobStatus(status: string): PipelineStepStatus {
  switch (status) {
    case "done":
      return "done";
    case "running":
      return "running";
    case "failed":
      return "failed";
    default:
      return "queued";
  }
}

function step(key: PipelineStepKey, status: PipelineStepStatus, error?: string): PipelineStep {
  const base: PipelineStep = { key, label: LABELS[key], status };
  return error ? { ...base, error } : base;
}

function fromJob(key: PipelineStepKey, job: PipelineJob): PipelineStep {
  const status = fromJobStatus(job.status);
  return step(key, status, status === "failed" && job.error ? job.error : undefined);
}

export function derivePipeline(input: PipelineInput): PipelineStep[] {
  const ingestJob = latestJob(input.jobs, "ingest");
  const transcribeJob = latestJob(input.jobs, "transcribe");
  const generateJob = latestJob(input.jobs, "generate-clips");

  // Ingest: its own job is authoritative; without one, the project's own status
  // (ready = probed = done, failed = ingest failed) fills in for older rows.
  const ingest = ingestJob
    ? fromJob("ingest", ingestJob)
    : step(
        "ingest",
        input.projectStatus === "ready" ? "done" : input.projectStatus === "failed" ? "failed" : "pending",
      );

  // Transcribe: no-audio projects skip it outright (the handler records the skip
  // and moves straight to clips), so `hasAudio === false` wins over any job row.
  // A written transcript is done regardless; otherwise the job drives it, and no
  // job yet means the step has not been reached.
  let transcribe: PipelineStep;
  if (input.hasAudio === false) {
    transcribe = step("transcribe", "skipped");
  } else if (input.transcribed) {
    transcribe = step("transcribe", "done");
  } else if (transcribeJob) {
    transcribe = fromJob("transcribe", transcribeJob);
  } else {
    transcribe = step("transcribe", "pending");
  }

  // Generate-clips: its job is authoritative (a regenerate re-runs it); without a
  // job, existing clips mean it finished (older rows), else it is unreached.
  let generate: PipelineStep;
  if (generateJob) {
    generate = fromJob("generate-clips", generateJob);
  } else if (input.clipCount > 0) {
    generate = step("generate-clips", "done");
  } else {
    generate = step("generate-clips", "pending");
  }

  return [ingest, transcribe, generate];
}
