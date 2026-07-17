import { beforeAll, describe, expect, it } from "vitest";

import { FakeTranscriber } from "../src/lib/transcribe/fake";
import { NO_ACTIVE_SEGMENT, activeSegmentIndex, formatTimestamp } from "../src/lib/transcribe/panel";
import type { TranscriptSegment } from "../src/lib/transcribe/types";

/**
 * The real 90 s fixture, loaded through the real FakeTranscriber — the same data
 * the pipeline feeds the panel. A hand-written array here would let the panel and
 * the fixture drift apart while both stayed green.
 */
let fixture: TranscriptSegment[];

beforeAll(async () => {
  fixture = await new FakeTranscriber().transcribe("long-sample.mp4");
});

describe("formatTimestamp", () => {
  it.each([
    [0, "0:00"],
    [4.3, "0:04"],
    [65, "1:05"],
    [90, "1:30"],
    // Past an hour it must roll over rather than render "125:00" — the fixture
    // never reaches this, a real podcast does.
    [3725, "1:02:05"],
  ])("formats %ss as %s", (seconds, expected) => {
    expect(formatTimestamp(seconds)).toBe(expected);
  });
});

describe("activeSegmentIndex", () => {
  it("finds the segment being spoken at a time inside it", () => {
    const third = fixture[2];
    const midpoint = (third.start + third.end) / 2;

    expect(activeSegmentIndex(fixture, midpoint)).toBe(2);
  });

  // U7: an inclusive `end` matches BOTH segments at a shared boundary and
  // returns the earlier one. The 90 s fixture cannot test this — every one of its
  // segments is separated from the next by a gap, so it has no shared boundary to
  // stand on (checked below, so this stays true). Whisper on continuous speech
  // does emit abutting segments, so the case is real even though the fixture
  // cannot express it: it needs a synthetic pair, not more fixture assertions.
  it("treats a segment as [start, end) — a boundary time belongs to the later segment", () => {
    const abutting = [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ];

    expect(activeSegmentIndex(abutting, 2)).toBe(1);
    expect(activeSegmentIndex(abutting, 1.999)).toBe(0);
    expect(activeSegmentIndex(abutting, 4)).toBe(NO_ACTIVE_SEGMENT);
  });

  it("has no abutting segments in the fixture — the case above is synthetic for a reason", () => {
    const abutting = fixture.filter((seg, i) => i > 0 && seg.start === fixture[i - 1].end);

    expect(abutting).toHaveLength(0);
  });

  // U6: the reason the fixture has a >=6 s quiet gap. The gap is MEASURED, not
  // hardcoded to an index, so re-cutting the fixture cannot silently move it out
  // from under this test.
  it("returns no active segment inside a quiet gap rather than sticking to the previous one", () => {
    let gapIndex = -1;
    let widest = 0;
    for (let i = 1; i < fixture.length; i++) {
      const gap = fixture[i].start - fixture[i - 1].end;
      if (gap > widest) {
        widest = gap;
        gapIndex = i;
      }
    }
    expect(widest, "fixture must contain a quiet gap for this to test anything").toBeGreaterThanOrEqual(1);

    const insideGap = (fixture[gapIndex - 1].end + fixture[gapIndex].start) / 2;

    expect(activeSegmentIndex(fixture, insideGap)).toBe(NO_ACTIVE_SEGMENT);
  });

  // U8: the fixture's speech starts at 0.6 s, so t=0 is silence — a scan that
  // assumes the first segment starts the video reports index 0 here.
  it("returns no active segment before speech begins", () => {
    expect(fixture[0].start).toBeGreaterThan(0);
    expect(activeSegmentIndex(fixture, 0)).toBe(NO_ACTIVE_SEGMENT);
  });

  it("returns no active segment after the transcript ends", () => {
    const last = fixture[fixture.length - 1];

    expect(activeSegmentIndex(fixture, last.end + 5)).toBe(NO_ACTIVE_SEGMENT);
  });

  it.each([NaN, Infinity])("returns no active segment for a non-finite time (%s)", (time) => {
    // A <video> reports NaN currentTime before metadata loads; that must read as
    // "nothing active", not throw and not match segment 0.
    expect(activeSegmentIndex(fixture, time)).toBe(NO_ACTIVE_SEGMENT);
  });

  it("returns no active segment for an empty transcript", () => {
    expect(activeSegmentIndex([], 1)).toBe(NO_ACTIVE_SEGMENT);
  });
});
