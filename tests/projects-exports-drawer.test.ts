import { describe, expect, it } from "vitest";

import {
  aggregateExportCounts,
  buildDrawerRows,
  type ExportHistoryRow,
  type LiveExport,
} from "../src/lib/projects/exports-drawer";

const history: ExportHistoryRow[] = [
  { id: 10, clipId: 1, preset: "tiktok", status: "done", outputPath: "/x/10.mp4" },
  { id: 11, clipId: 2, preset: "square", status: "queued", outputPath: null },
];

const titles = new Map<number, string>([
  [1, "The secret"],
  [2, "  "],
]);

describe("buildDrawerRows", () => {
  it("overlays live status/progress and joins the clip title, newest first", () => {
    const live = new Map<number, LiveExport>([[11, { id: 11, clipId: 2, status: "running", progress: 42 }]]);
    const rows = buildDrawerRows(history, live, titles);

    expect(rows.map((r) => r.id)).toEqual([11, 10]);
    const rendering = rows.find((r) => r.id === 11)!;
    expect(rendering.status).toBe("running");
    expect(rendering.progress).toBe(42);
    expect(rendering.clipTitle).toBe("Clip 2"); // blank title falls back
    expect(rendering.downloadable).toBe(false);
  });

  it("pins a done export to 100 and marks it downloadable", () => {
    const rows = buildDrawerRows(history, new Map(), titles);
    const done = rows.find((r) => r.id === 10)!;
    expect(done.progress).toBe(100);
    expect(done.downloadable).toBe(true);
    expect(done.clipTitle).toBe("The secret");
  });

  it("falls back to the history status when the live overlay lacks the export", () => {
    const rows = buildDrawerRows(history, new Map(), titles);
    expect(rows.find((r) => r.id === 11)!.status).toBe("queued");
    expect(rows.find((r) => r.id === 11)!.progress).toBe(0);
  });
});

describe("aggregateExportCounts", () => {
  it("tallies each status bucket", () => {
    const counts = aggregateExportCounts([
      { status: "queued" },
      { status: "running" },
      { status: "running" },
      { status: "done" },
      { status: "failed" },
    ]);
    expect(counts).toEqual({ queued: 1, rendering: 2, done: 1, failed: 1, total: 5 });
  });
});
