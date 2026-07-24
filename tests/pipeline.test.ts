import { describe, expect, it } from "vitest";

import { derivePipeline, type PipelineInput, type PipelineJob } from "../src/lib/pipeline";

function input(partial: Partial<PipelineInput> & { jobs?: PipelineJob[] } = {}): PipelineInput {
  return {
    jobs: partial.jobs ?? [],
    projectStatus: partial.projectStatus ?? "uploaded",
    hasAudio: partial.hasAudio ?? null,
    transcribed: partial.transcribed ?? false,
    clipCount: partial.clipCount ?? 0,
  };
}

/** The three steps always come back in pipeline order. */
function statuses(input: PipelineInput) {
  return derivePipeline(input).map((s) => s.status);
}

describe("derivePipeline", () => {
  it("labels and orders the three steps", () => {
    const steps = derivePipeline(input());
    expect(steps.map((s) => s.key)).toEqual(["ingest", "transcribe", "generate-clips"]);
    expect(steps.map((s) => s.label)).toEqual(["Ingest", "Transcribe", "Generate clips"]);
  });

  it("fresh project: ingest running, the rest pending", () => {
    // Ingest job claimed, nothing downstream enqueued yet.
    expect(
      statuses(
        input({
          projectStatus: "uploaded",
          jobs: [{ type: "ingest", status: "running", error: null }],
        }),
      ),
    ).toEqual(["running", "pending", "pending"]);
  });

  it("mid-transcribe: ingest done, transcribe running, generate pending", () => {
    expect(
      statuses(
        input({
          projectStatus: "ready",
          hasAudio: true,
          jobs: [
            { type: "ingest", status: "done", error: null },
            { type: "transcribe", status: "running", error: null },
          ],
        }),
      ),
    ).toEqual(["done", "running", "pending"]);
  });

  it("failed generate-clips: ingest+transcribe done, generate failed with its error", () => {
    const steps = derivePipeline(
      input({
        projectStatus: "ready",
        hasAudio: true,
        transcribed: true,
        clipCount: 0,
        jobs: [
          { type: "ingest", status: "done", error: null },
          { type: "transcribe", status: "done", error: null },
          { type: "generate-clips", status: "failed", error: "detector blew up" },
        ],
      }),
    );
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "failed"]);
    expect(steps[2].error).toBe("detector blew up");
  });

  it("no-audio project: transcribe is skipped even though a transcribe job ran", () => {
    // The no-audio path marks the transcribe job done and moves straight to clips.
    const steps = derivePipeline(
      input({
        projectStatus: "ready",
        hasAudio: false,
        transcribed: false,
        clipCount: 3,
        jobs: [
          { type: "ingest", status: "done", error: null },
          { type: "transcribe", status: "done", error: null },
          { type: "generate-clips", status: "done", error: null },
        ],
      }),
    );
    expect(steps.map((s) => s.status)).toEqual(["done", "skipped", "done"]);
  });

  it("uses the latest job of a type (a regenerate supersedes an earlier run)", () => {
    expect(
      statuses(
        input({
          projectStatus: "ready",
          hasAudio: true,
          transcribed: true,
          clipCount: 5,
          jobs: [
            { type: "ingest", status: "done", error: null },
            { type: "transcribe", status: "done", error: null },
            { type: "generate-clips", status: "done", error: null },
            { type: "generate-clips", status: "running", error: null },
          ],
        }),
      ),
    ).toEqual(["done", "done", "running"]);
  });

  it("carries no error field on a non-failed step", () => {
    const steps = derivePipeline(input({ jobs: [{ type: "ingest", status: "running", error: null }] }));
    expect(steps[0].error).toBeUndefined();
  });

  it("ingest falls back to the project status when there is no ingest job row", () => {
    expect(statuses(input({ projectStatus: "ready", jobs: [] }))[0]).toBe("done");
    expect(statuses(input({ projectStatus: "failed", jobs: [] }))[0]).toBe("failed");
    expect(statuses(input({ projectStatus: "created", jobs: [] }))[0]).toBe("pending");
  });
});
