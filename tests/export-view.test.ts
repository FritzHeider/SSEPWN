import { describe, expect, it } from "vitest";

import {
  canDownloadExport,
  canRetryExport,
  clampProgress,
  exportDownloadUrl,
  exportErrorMessage,
  exportPresetLabel,
  exportQualityLabel,
  exportStatusLabel,
  isTerminalExport,
  progressBarWidth,
  shouldPollExport,
  type ExportRow,
} from "../src/lib/export/view";

/** A queued export row with sensible defaults; override the field under test. */
function row(over: Partial<ExportRow> = {}): ExportRow {
  return {
    id: 7,
    clipId: 3,
    preset: "tiktok",
    outputPath: null,
    status: "queued",
    jobId: 11,
    error: null,
    createdAt: 0,
    ...over,
  };
}

describe("isTerminalExport / shouldPollExport", () => {
  it.each(["done", "failed"])("treats %s as terminal (stop polling)", (status) => {
    expect(isTerminalExport(status)).toBe(true);
    expect(shouldPollExport(status)).toBe(false);
  });

  it.each(["queued", "running"])("keeps polling while %s", (status) => {
    expect(isTerminalExport(status)).toBe(false);
    expect(shouldPollExport(status)).toBe(true);
  });

  // An unrecognised status is not terminal, so the poller keeps looking rather
  // than freezing a row the client's schema has not caught up to.
  it("polls an unknown status", () => {
    expect(shouldPollExport("paused")).toBe(true);
  });
});

describe("exportStatusLabel", () => {
  it.each([
    ["queued", "Queued"],
    ["running", "Rendering…"],
    ["done", "Ready"],
    ["failed", "Failed"],
  ])("labels %s as %s", (status, label) => {
    expect(exportStatusLabel(status)).toBe(label);
  });

  it("falls back to the raw value for an unknown status", () => {
    expect(exportStatusLabel("paused")).toBe("paused");
  });

  it("never renders blank", () => {
    expect(exportStatusLabel("   ")).toBe("Unknown");
  });
});

describe("clampProgress", () => {
  it("rounds to an integer in range", () => {
    expect(clampProgress(42.6)).toBe(43);
  });

  it.each([
    [-5, 0],
    [150, 100],
  ])("clamps %p to %p", (value, expected) => {
    expect(clampProgress(value)).toBe(expected);
  });

  it.each([NaN, Infinity, -Infinity])("maps non-finite %p to 0", (value) => {
    expect(clampProgress(value)).toBe(0);
  });
});

describe("progressBarWidth", () => {
  it("reflects clamped live progress while running", () => {
    expect(progressBarWidth("running", 37)).toBe("37%");
  });

  // A done row pins to 100% even if the last live tick was lower — mirrors the
  // API's own `done → 100` pin so the bar never finishes short.
  it("pins a done row to 100% regardless of the tick", () => {
    expect(progressBarWidth("done", 0)).toBe("100%");
  });

  it("clamps an over-range tick", () => {
    expect(progressBarWidth("running", 250)).toBe("100%");
  });
});

describe("canDownloadExport", () => {
  it("allows download for a done row with an output file", () => {
    expect(canDownloadExport(row({ status: "done", outputPath: "/data/exports/3-tiktok.mp4" }))).toBe(true);
  });

  it("refuses a done row that never wrote a file", () => {
    expect(canDownloadExport(row({ status: "done", outputPath: null }))).toBe(false);
  });

  it.each(["queued", "running", "failed"])("refuses download while %s", (status) => {
    expect(canDownloadExport(row({ status, outputPath: "/data/exports/x.mp4" }))).toBe(false);
  });
});

describe("canRetryExport", () => {
  it("offers retry only on failure", () => {
    expect(canRetryExport("failed")).toBe(true);
  });

  it.each(["queued", "running", "done"])("does not offer retry while %s", (status) => {
    expect(canRetryExport(status)).toBe(false);
  });
});

describe("exportDownloadUrl", () => {
  it("points at the download route for the export id", () => {
    expect(exportDownloadUrl(42)).toBe("/api/exports/42/download");
  });
});

describe("exportPresetLabel", () => {
  it("labels a known preset id", () => {
    expect(exportPresetLabel("tiktok")).toBe("TikTok");
  });

  // An unknown id must not render blank — resolvePlatformPreset falls back.
  it("falls back for an unknown preset id", () => {
    expect(exportPresetLabel("nope")).toBeTruthy();
  });
});

describe("exportQualityLabel", () => {
  it.each([
    ["draft", "Draft (fast)"],
    ["final", "Final"],
  ])("labels %s", (q, label) => {
    expect(exportQualityLabel(q)).toBe(label);
  });
});

describe("exportErrorMessage", () => {
  it("returns null when there is no error", () => {
    expect(exportErrorMessage(null)).toBeNull();
    expect(exportErrorMessage(undefined)).toBeNull();
    expect(exportErrorMessage("   ")).toBeNull();
  });

  it("trims a real message", () => {
    expect(exportErrorMessage("  ffmpeg exited 1  ")).toBe("ffmpeg exited 1");
  });

  it("caps a long stderr tail with an ellipsis", () => {
    const long = "x".repeat(500);
    const out = exportErrorMessage(long, 100);
    expect(out).toHaveLength(100);
    expect(out?.endsWith("…")).toBe(true);
  });
});
