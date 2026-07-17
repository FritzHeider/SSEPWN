import { describe, expect, it } from "vitest";

import { fileInputAccept, isAcceptedVideoFile } from "@/lib/upload/allowed";
import {
  EMPTY,
  formatDuration,
  formatResolution,
  hasPendingWork,
  shouldShowThumbnail,
  statusBadge,
  thumbnailUrl,
} from "@/lib/projects/view";

// The pure decision logic behind the project list (DEC-005). Browser gestures
// (drag-drop, the poll timer firing) are phase-11 Playwright's job; everything
// here is a real property, not a description of a mock.

describe("formatDuration", () => {
  // M1: a mutant rendering raw seconds ("3661s") passes any test that only
  // checks for a non-empty string.
  it("renders h:mm:ss past an hour and m:ss below it", () => {
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(42.4)).toBe("0:42");
    expect(formatDuration(90)).toBe("1:30");
    expect(formatDuration(3600)).toBe("1:00:00");
  });

  it("pads seconds and minutes so widths never jump between polls", () => {
    expect(formatDuration(5)).toBe("0:05");
    expect(formatDuration(3605)).toBe("1:00:05");
  });

  // M2: the live window between upload and ready has null metadata on EVERY
  // project. "NaN" or a confident "0:00" would both be lies.
  it("renders unprobed metadata as EMPTY, never NaN or a misleading 0:00", () => {
    expect(formatDuration(null)).toBe(EMPTY);
    expect(formatDuration(undefined)).toBe(EMPTY);
    expect(formatDuration(Number.NaN)).toBe(EMPTY);
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe(EMPTY);
    expect(formatDuration(-1)).toBe(EMPTY);
  });

  it("renders a genuine zero-length source as 0:00, not EMPTY", () => {
    // Distinct from null: 0 is a probed fact, absence is not.
    expect(formatDuration(0)).toBe("0:00");
  });
});

describe("formatResolution", () => {
  it("renders width×height once probed", () => {
    expect(formatResolution(1280, 720)).toBe("1280×720");
  });

  // M2's sibling: a half-probed row must not render "1280×null".
  it("renders EMPTY unless both dimensions are known", () => {
    expect(formatResolution(null, null)).toBe(EMPTY);
    expect(formatResolution(1280, null)).toBe(EMPTY);
    expect(formatResolution(null, 720)).toBe(EMPTY);
    expect(formatResolution(0, 0)).toBe(EMPTY);
  });
});

describe("statusBadge", () => {
  // M4: a mutant collapsing every status to one tone/label passes a
  // single-status fixture. All four must be distinguishable.
  it("maps the four project statuses to distinct labels and tones", () => {
    const badges = ["created", "uploaded", "ready", "failed"].map((status) =>
      statusBadge({ status, error: null }),
    );

    expect(badges.map((b) => b.label)).toEqual(["Created", "Processing", "Ready", "Failed"]);
    expect(new Set(badges.map((b) => b.tone)).size).toBe(4);
  });

  // M3: projects.error exists precisely so the badge can explain the failure in
  // prose (DEC-003, mem-1784272334-9a38). Dropping it defeats the column.
  it("surfaces the human-readable error on a failed project", () => {
    const badge = statusBadge({
      status: "failed",
      error: '"My Podcast.mp4" is not a readable video file',
    });

    expect(badge.tone).toBe("danger");
    expect(badge.detail).toBe('"My Podcast.mp4" is not a readable video file');
  });

  it("has no detail when there is no error, and ignores a blank one", () => {
    expect(statusBadge({ status: "ready", error: null }).detail).toBeNull();
    expect(statusBadge({ status: "ready", error: "   " }).detail).toBeNull();
  });

  // Phases 03-10 add statuses; an unknown one must degrade, not crash.
  it("renders an unknown status as itself rather than throwing", () => {
    expect(statusBadge({ status: "transcribing", error: null }).label).toBe("transcribing");
    expect(statusBadge({ status: "", error: null }).label).toBe("Unknown");
  });

  it("marks only in-flight statuses pending", () => {
    expect(statusBadge({ status: "created", error: null }).pending).toBe(true);
    expect(statusBadge({ status: "uploaded", error: null }).pending).toBe(true);
    expect(statusBadge({ status: "ready", error: null }).pending).toBe(false);
    expect(statusBadge({ status: "failed", error: null }).pending).toBe(false);
  });
});

describe("hasPendingWork", () => {
  it("is true while any project is still expected to change", () => {
    expect(hasPendingWork([{ status: "ready", error: null }])).toBe(false);
    expect(hasPendingWork([{ status: "ready", error: null }, { status: "uploaded", error: null }])).toBe(
      true,
    );
    // A settled list has nothing to poll for; a failed project is settled.
    expect(hasPendingWork([{ status: "failed", error: "bad file" }])).toBe(false);
    expect(hasPendingWork([])).toBe(false);
  });
});

describe("shouldShowThumbnail", () => {
  // M7: the poster route 404s cleanly mid-ingest (DEC-004), so requesting one
  // the DB says is absent means a knowingly broken <img> on every poll.
  it("only renders a poster the database says exists", () => {
    expect(shouldShowThumbnail({ status: "ready", thumbnailPath: "data/thumbnails/project-1.jpg" })).toBe(
      true,
    );
    expect(shouldShowThumbnail({ status: "ready", thumbnailPath: null })).toBe(false);
    expect(shouldShowThumbnail({ status: "uploaded", thumbnailPath: null })).toBe(false);
    // Stale path on a failed project: the row says failed, so no poster.
    expect(shouldShowThumbnail({ status: "failed", thumbnailPath: "data/thumbnails/project-2.jpg" })).toBe(
      false,
    );
  });

  it("points at the serving route, never the filesystem path", () => {
    // data/ is outside public/; only the route can serve these bytes (DEC-004).
    expect(thumbnailUrl(7)).toBe("/api/projects/7/thumbnail");
  });
});

describe("isAcceptedVideoFile", () => {
  // M5: `return true` passes any test that only feeds it valid files.
  it("rejects a non-video, mirroring the API's 400", () => {
    expect(isAcceptedVideoFile({ name: "not-a-video.txt", type: "text/plain" })).toBe(false);
    expect(isAcceptedVideoFile({ name: "clip.mp3", type: "audio/mpeg" })).toBe(false);
    expect(isAcceptedVideoFile({ name: "", type: "" })).toBe(false);
  });

  // M5': an mp4-only mutant passes a suite that only ever tries mp4.
  it("accepts all three SPEC formats, not just mp4", () => {
    expect(isAcceptedVideoFile({ name: "a.mp4", type: "video/mp4" })).toBe(true);
    expect(isAcceptedVideoFile({ name: "b.mov", type: "video/quicktime" })).toBe(true);
    expect(isAcceptedVideoFile({ name: "c.webm", type: "video/webm" })).toBe(true);
    expect(isAcceptedVideoFile({ name: "SHOUTING.MP4", type: "video/mp4" })).toBe(true);
  });

  // M6: accepting on mime OR extension instead of AND. The server requires the
  // two to agree; a client hint that disagreed would promise an upload the API
  // then rejects with a 400.
  it("requires the mime type and extension to agree", () => {
    expect(isAcceptedVideoFile({ name: "sneaky.txt", type: "video/mp4" })).toBe(false);
    expect(isAcceptedVideoFile({ name: "sneaky.mp4", type: "text/plain" })).toBe(false);
    expect(isAcceptedVideoFile({ name: "mismatch.webm", type: "video/mp4" })).toBe(false);
  });

  it("does not treat a dotfile as an extension", () => {
    expect(isAcceptedVideoFile({ name: ".mp4", type: "video/mp4" })).toBe(false);
  });
});

describe("fileInputAccept", () => {
  it("offers mime types and extensions, since pickers match them inconsistently", () => {
    const accept = fileInputAccept();
    expect(accept).toContain("video/mp4");
    expect(accept).toContain(".mov");
    expect(accept).toContain(".webm");
  });
});
