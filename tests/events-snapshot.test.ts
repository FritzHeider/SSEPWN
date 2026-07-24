import { describe, expect, it } from "vitest";

import {
  diffHomeSnapshot,
  diffProjectSnapshot,
  formatSseFrame,
  snapshotFrame,
  type ProjectSnapshot,
} from "../src/lib/events/snapshot";

function snap(partial: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return { jobs: partial.jobs ?? [], clips: partial.clips ?? [], exports: partial.exports ?? [] };
}

const job = { id: 1, type: "ingest", status: "running", attempts: 1, error: null, progress: 10, updatedAt: 5 };
const clip = { id: 1, title: "c", inPoint: 0, outPoint: 4, status: "candidate" };
const exp = { id: 1, clipId: 1, status: "running", progress: 42 };

describe("diffProjectSnapshot", () => {
  it("emits every section on the first tick (prev = null)", () => {
    const frames = diffProjectSnapshot(null, snap({ jobs: [job], clips: [clip], exports: [exp] }));
    expect(frames.map((f) => f.event)).toEqual(["jobs", "clips", "exports"]);
  });

  it("emits nothing when nothing changed", () => {
    const prev = snap({ jobs: [job], clips: [clip], exports: [exp] });
    const next = snap({ jobs: [job], clips: [clip], exports: [exp] });
    expect(diffProjectSnapshot(prev, next)).toEqual([]);
  });

  it("emits only the section that changed", () => {
    const prev = snap({ jobs: [job], clips: [clip], exports: [exp] });
    const next = snap({ jobs: [{ ...job, progress: 55 }], clips: [clip], exports: [exp] });
    const frames = diffProjectSnapshot(prev, next);
    expect(frames.map((f) => f.event)).toEqual(["jobs"]);
    expect(frames[0].data).toEqual([{ ...job, progress: 55 }]);
  });

  it("detects an export progress change independently of jobs and clips", () => {
    const prev = snap({ jobs: [job], clips: [clip], exports: [exp] });
    const next = snap({ jobs: [job], clips: [clip], exports: [{ ...exp, progress: 100, status: "done" }] });
    expect(diffProjectSnapshot(prev, next).map((f) => f.event)).toEqual(["exports"]);
  });
});

describe("diffHomeSnapshot", () => {
  const p = { id: 1, name: "A", status: "ready", clipCount: 2, exportCount: 1 };

  it("emits projects on the first tick", () => {
    expect(diffHomeSnapshot(null, { projects: [p] }).map((f) => f.event)).toEqual(["projects"]);
  });

  it("emits nothing when the list is unchanged", () => {
    expect(diffHomeSnapshot({ projects: [p] }, { projects: [p] })).toEqual([]);
  });

  it("emits projects when a count changes", () => {
    expect(diffHomeSnapshot({ projects: [p] }, { projects: [{ ...p, clipCount: 3 }] })).toHaveLength(1);
  });
});

describe("formatSseFrame / snapshotFrame", () => {
  it("serializes as an SSE event block with a single-line data payload", () => {
    expect(formatSseFrame({ event: "jobs", data: [job] })).toBe(`event: jobs\ndata: ${JSON.stringify([job])}\n\n`);
  });

  it("wraps a full snapshot under the `snapshot` event", () => {
    const s = snap({ jobs: [job] });
    expect(snapshotFrame(s)).toEqual({ event: "snapshot", data: s });
  });
});
