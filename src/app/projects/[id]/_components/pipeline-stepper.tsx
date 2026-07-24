"use client";

import { Check, Clock, Loader2, SkipForward, X } from "lucide-react";

import { RetryPipelineButton } from "./retry-pipeline-button";
import type { PipelineStep, PipelineStepStatus } from "@/lib/pipeline";
import { PIPELINE_STEP_LABELS } from "@/lib/projects/retry";

/**
 * The ingest → transcribe → generate-clips stepper (item 20), rendered from the
 * rich `derivePipeline` shape and re-derived live from SSE job updates in the
 * workspace. Each step shows a status icon (done/running/queued/failed/skipped/
 * pending), a failed step surfaces its error message with the retry button
 * beside it, and a skipped transcribe notes the no-audio reason.
 *
 * Reduced motion is handled globally (globals.css zeroes animation-duration), so
 * the running spinner calms itself without a per-component check.
 */
function StepIcon({ status }: { status: PipelineStepStatus }) {
  switch (status) {
    case "done":
      return <Check className="h-4 w-4" aria-hidden />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin" aria-hidden />;
    case "queued":
      return <Clock className="h-4 w-4" aria-hidden />;
    case "failed":
      return <X className="h-4 w-4" aria-hidden />;
    case "skipped":
      return <SkipForward className="h-4 w-4" aria-hidden />;
    default:
      return <span className="h-2 w-2 rounded-full bg-current" aria-hidden />;
  }
}

const DOT_CLASS: Readonly<Record<PipelineStepStatus, string>> = {
  done: "border-[var(--success)] bg-[color-mix(in_oklab,var(--success)_18%,transparent)] text-[var(--success)]",
  running: "border-[var(--timeline)] bg-[color-mix(in_oklab,var(--timeline)_18%,transparent)] text-[var(--timeline)]",
  queued: "border-[var(--border-subtle)] text-[var(--text-muted)]",
  failed: "border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_18%,transparent)] text-[var(--danger)]",
  skipped: "border-[var(--border-subtle)] text-[var(--text-muted)]",
  pending: "border-[var(--border-subtle)] text-[var(--text-muted)]",
};

const LABEL_CLASS: Readonly<Record<PipelineStepStatus, string>> = {
  done: "text-[var(--text)]",
  running: "text-[var(--text)]",
  queued: "text-[var(--text-muted)]",
  failed: "text-[var(--danger)]",
  skipped: "text-[var(--text-muted)]",
  pending: "text-[var(--text-muted)]",
};

const STATUS_NOTE: Partial<Record<PipelineStepStatus, string>> = {
  queued: "Queued",
  running: "Running…",
  skipped: "Skipped — no audio",
};

export function PipelineStepper({ steps, projectId }: { steps: PipelineStep[]; projectId: number }) {
  const failed = steps.find((step) => step.status === "failed");

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-3" aria-label="Pipeline progress">
        {steps.map((step, index) => (
          <li key={step.key} data-testid="pipeline-step" data-status={step.status} className="flex items-center gap-2">
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${DOT_CLASS[step.status]}`}
            >
              <StepIcon status={step.status} />
            </span>
            <span className="flex flex-col leading-tight">
              <span className={`text-sm font-medium ${LABEL_CLASS[step.status]}`}>{step.label}</span>
              {step.status === "failed" && step.error ? (
                <span className="text-xs text-[var(--danger)]">{step.error}</span>
              ) : STATUS_NOTE[step.status] ? (
                <span className="text-xs text-[var(--text-muted)]">{STATUS_NOTE[step.status]}</span>
              ) : null}
            </span>
            {index < steps.length - 1 ? (
              <span className="mx-1 h-px w-6 bg-[var(--border-subtle)]" aria-hidden />
            ) : null}
          </li>
        ))}
      </ol>
      {failed ? (
        <RetryPipelineButton
          projectId={projectId}
          stepLabel={PIPELINE_STEP_LABELS[failed.key] ?? failed.key}
        />
      ) : null}
    </div>
  );
}
