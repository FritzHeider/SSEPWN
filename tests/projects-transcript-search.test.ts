import { describe, expect, it } from "vitest";

import type { TranscriptSegment } from "../src/lib/transcribe/types";
import {
  NO_SELECTION,
  firstSegmentInRange,
  highlightParts,
  isSelected,
  matchingSegmentIndices,
  searchCountLabel,
  selectionBounds,
  selectionTimeRange,
} from "../src/lib/projects/transcript-search";

const segments: TranscriptSegment[] = [
  { start: 0, end: 3, text: "The secret nobody tells you", words: [] },
  { start: 3, end: 6, text: "is that consistency wins", words: [] },
  { start: 6, end: 9, text: "The secret is simple", words: [] },
];

describe("matchingSegmentIndices", () => {
  it("matches case-insensitively as a substring", () => {
    expect(matchingSegmentIndices(segments, "secret")).toEqual([0, 2]);
    expect(matchingSegmentIndices(segments, "SECRET")).toEqual([0, 2]);
  });

  it("returns every index for an empty or whitespace query", () => {
    expect(matchingSegmentIndices(segments, "")).toEqual([0, 1, 2]);
    expect(matchingSegmentIndices(segments, "   ")).toEqual([0, 1, 2]);
  });

  it("returns nothing when no segment matches", () => {
    expect(matchingSegmentIndices(segments, "zzz")).toEqual([]);
  });
});

describe("searchCountLabel", () => {
  it("shows the total when the query is empty", () => {
    expect(searchCountLabel(3, 3, "")).toBe("3 segments");
    expect(searchCountLabel(1, 1, "")).toBe("1 segment");
  });

  it("shows n of m while filtering", () => {
    expect(searchCountLabel(2, 3, "secret")).toBe("2 of 3 segments");
  });
});

describe("highlightParts", () => {
  it("splits a text into matched and unmatched runs preserving case", () => {
    expect(highlightParts("The secret", "secret")).toEqual([
      { text: "The ", match: false },
      { text: "secret", match: true },
    ]);
  });

  it("returns the whole text as one run for an empty query", () => {
    expect(highlightParts("The secret", "")).toEqual([{ text: "The secret", match: false }]);
  });

  it("handles multiple occurrences", () => {
    expect(highlightParts("aXaXa", "x")).toEqual([
      { text: "a", match: false },
      { text: "X", match: true },
      { text: "a", match: false },
      { text: "X", match: true },
      { text: "a", match: false },
    ]);
  });
});

describe("selection helpers", () => {
  it("orders a selection regardless of click order", () => {
    expect(selectionBounds(2, 0)).toEqual([0, 2]);
    expect(selectionBounds(0, 2)).toEqual([0, 2]);
  });

  it("is null when an endpoint is unset", () => {
    expect(selectionBounds(NO_SELECTION, 2)).toBeNull();
    expect(selectionBounds(1, NO_SELECTION)).toBeNull();
  });

  it("marks the inclusive span as selected", () => {
    expect(isSelected(1, 0, 2)).toBe(true);
    expect(isSelected(2, 0, 2)).toBe(true);
    expect(isSelected(3, 0, 2)).toBe(false);
  });

  it("spans the earliest start to the latest end for the clip range", () => {
    expect(selectionTimeRange(segments, 2, 0)).toEqual({ start: 0, end: 9 });
  });

  it("is null for an out-of-range or incomplete selection", () => {
    expect(selectionTimeRange(segments, 0, 9)).toBeNull();
    expect(selectionTimeRange(segments, NO_SELECTION, 1)).toBeNull();
  });
});

describe("firstSegmentInRange", () => {
  it("finds the first segment overlapping a clip's time range", () => {
    expect(firstSegmentInRange(segments, 3.5, 8)).toBe(1);
  });

  it("counts a segment that merely overlaps the boundary", () => {
    expect(firstSegmentInRange(segments, 2, 2.5)).toBe(0);
  });

  it("is NO_SELECTION when nothing overlaps", () => {
    expect(firstSegmentInRange(segments, 100, 200)).toBe(NO_SELECTION);
  });
});
