import { describe, expect, it } from "vitest";

import type { ProjectClip } from "../src/lib/projects/clips";
import {
  clipDurationLabel,
  clipRangeLabel,
  clipScoreLabel,
  clipTitle,
  clipsEmptyMessage,
  manualRangeError,
  shouldPausePreview,
} from "../src/lib/projects/clips-panel";

/** A candidate clip with sensible defaults; override the field under test. */
function clip(over: Partial<ProjectClip> = {}): ProjectClip {
  return {
    id: 1,
    projectId: 1,
    inPoint: 12,
    outPoint: 42,
    score: 3.5,
    title: "The secret nobody tells you",
    reasons: ["high energy", "hook phrase: the secret"],
    status: "candidate",
    createdAt: 0,
    ...over,
  };
}

describe("clipTitle", () => {
  it("uses the clip's own title when it has one", () => {
    expect(clipTitle(clip({ title: "Tripled overnight" }))).toBe("Tripled overnight");
  });

  it("trims surrounding whitespace", () => {
    expect(clipTitle(clip({ title: "  hi  " }))).toBe("hi");
  });

  // A null title is a real state — a candidate whose range held no hook sentence,
  // and every manual clip before a custom name is typed. It must not render blank.
  it.each([null, "", "   "])("falls back to a label for a missing title (%p)", (title) => {
    expect(clipTitle(clip({ title }))).toBe("Untitled clip");
  });
});

describe("clipDurationLabel", () => {
  it("formats the out−in span as m:ss", () => {
    expect(clipDurationLabel(clip({ inPoint: 12, outPoint: 42 }))).toBe("0:30");
  });

  it("rolls a long clip past a minute", () => {
    expect(clipDurationLabel(clip({ inPoint: 10, outPoint: 100 }))).toBe("1:30");
  });
});

describe("clipRangeLabel", () => {
  it("shows both endpoints separated by an en dash", () => {
    expect(clipRangeLabel(clip({ inPoint: 5, outPoint: 65 }))).toBe("0:05 – 1:05");
  });
});

describe("clipScoreLabel", () => {
  it("formats a numeric score to two decimals", () => {
    expect(clipScoreLabel(clip({ score: 3.14159 }))).toBe("3.14");
  });

  // Manual clips have no score; null is the signal the card prints "Manual".
  it("returns null for a manual clip with no score", () => {
    expect(clipScoreLabel(clip({ score: null }))).toBeNull();
  });

  it.each([NaN, Infinity, -Infinity])("returns null for a non-finite score (%p)", (score) => {
    expect(clipScoreLabel(clip({ score }))).toBeNull();
  });

  it("keeps a zero score as a number, not as absent", () => {
    expect(clipScoreLabel(clip({ score: 0 }))).toBe("0.00");
  });
});

describe("clipsEmptyMessage", () => {
  it("says nothing when there are clips to render", () => {
    expect(clipsEmptyMessage([clip()])).toBeNull();
  });

  it("invites action when the list is empty", () => {
    expect(clipsEmptyMessage([])).toMatch(/no clips yet/i);
  });
});

describe("manualRangeError", () => {
  it("accepts a valid in/out range inside the video", () => {
    expect(manualRangeError(10, 40, 90)).toBeNull();
  });

  it("accepts a range when the duration is unknown", () => {
    expect(manualRangeError(10, 40, null)).toBeNull();
  });

  // Exactly at the end passes — the epsilon matches the API's 1e-3 slop.
  it("accepts an out-point exactly at the source end", () => {
    expect(manualRangeError(10, 90, 90)).toBeNull();
  });

  it.each([
    [null, 40],
    [10, null],
  ])("asks to mark both ends when one is unset (%p, %p)", (a, b) => {
    expect(manualRangeError(a, b, 90)).toMatch(/mark both/i);
  });

  it("rejects a negative in-point", () => {
    expect(manualRangeError(-1, 40, 90)).toMatch(/at or after the start/i);
  });

  it.each([
    [40, 40],
    [40, 30],
  ])("rejects an out-point not after the in-point (%p, %p)", (a, b) => {
    expect(manualRangeError(a, b, 90)).toMatch(/after the in-point/i);
  });

  it("rejects a range that runs past the source", () => {
    expect(manualRangeError(10, 95, 90)).toMatch(/within the video/i);
  });

  it("rejects a non-finite endpoint", () => {
    expect(manualRangeError(NaN, 40, 90)).toMatch(/mark both/i);
  });
});

describe("shouldPausePreview", () => {
  it("pauses once playback reaches the out-point", () => {
    expect(shouldPausePreview(42, 42)).toBe(true);
    expect(shouldPausePreview(42.5, 42)).toBe(true);
  });

  it("keeps playing before the out-point", () => {
    expect(shouldPausePreview(41.9, 42)).toBe(false);
  });

  // A <video> reports NaN currentTime before metadata loads; that must not pause.
  it("does not pause on a non-finite time", () => {
    expect(shouldPausePreview(NaN, 42)).toBe(false);
  });
});
