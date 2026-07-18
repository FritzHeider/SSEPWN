import { describe, expect, it } from "vitest";

import { splitAt } from "../src/lib/timeline/ops";
import { buildTimelineDoc } from "../src/lib/timeline/state";
import {
  DEFAULT_PX_PER_SEC,
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC,
  ZOOM_FACTOR,
  clampPxPerSec,
  dropIndexAt,
  segmentLayout,
  snapValue,
  timeToX,
  timelineCutTimes,
  xToTime,
  zoomBy,
} from "../src/lib/timeline/strip";
import type { TimelineDoc } from "../src/lib/timeline/types";

/** A 20s clip (source 10–30) split into three segments of 5s, 7s, 8s timeline. */
function threeSeg(): TimelineDoc {
  let d = buildTimelineDoc(10, 30);
  d = splitAt(d, 5); // [10–15][15–30]
  d = splitAt(d, 12); // [10–15][15–22][22–30]
  return d;
}

describe("zoom", () => {
  it("clamps density into the allowed range", () => {
    expect(clampPxPerSec(1)).toBe(MIN_PX_PER_SEC);
    expect(clampPxPerSec(10_000)).toBe(MAX_PX_PER_SEC);
    expect(clampPxPerSec(DEFAULT_PX_PER_SEC)).toBe(DEFAULT_PX_PER_SEC);
    expect(clampPxPerSec(Number.NaN)).toBe(DEFAULT_PX_PER_SEC);
  });

  it("zoomBy multiplies in and divides out, clamped at the limits", () => {
    expect(zoomBy(DEFAULT_PX_PER_SEC, 1)).toBeCloseTo(DEFAULT_PX_PER_SEC * ZOOM_FACTOR, 6);
    expect(zoomBy(DEFAULT_PX_PER_SEC, -1)).toBeCloseTo(DEFAULT_PX_PER_SEC / ZOOM_FACTOR, 6);
    expect(zoomBy(MAX_PX_PER_SEC, 1)).toBe(MAX_PX_PER_SEC);
    expect(zoomBy(MIN_PX_PER_SEC, -1)).toBe(MIN_PX_PER_SEC);
  });
});

describe("segmentLayout", () => {
  it("tiles boxes gap-free in playback order at the given zoom", () => {
    const boxes = segmentLayout(threeSeg(), 10);
    expect(boxes.map((b) => b.id)).toEqual(["seg-1", "seg-2", "seg-3"]);
    expect(boxes.map((b) => b.timelineStart)).toEqual([0, 5, 12]);
    expect(boxes.map((b) => b.duration)).toEqual([5, 7, 8]);
    expect(boxes.map((b) => b.leftPx)).toEqual([0, 50, 120]);
    expect(boxes.map((b) => b.widthPx)).toEqual([50, 70, 80]);
    // Each box starts exactly where the previous ends.
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].leftPx).toBe(boxes[i - 1].leftPx + boxes[i - 1].widthPx);
    }
    // Source ranges are carried through for the trim handlers.
    expect(boxes.map((b) => [b.sourceIn, b.sourceOut])).toEqual([
      [10, 15],
      [15, 22],
      [22, 30],
    ]);
  });
});

describe("time <-> pixel mapping", () => {
  it("timeToX and xToTime round-trip inside the sequence", () => {
    expect(timeToX(7, 10)).toBe(70);
    expect(xToTime(70, 10, 20)).toBe(7);
  });

  it("xToTime clamps to [0, total] and guards a zero density", () => {
    expect(xToTime(-50, 10, 20)).toBe(0);
    expect(xToTime(10_000, 10, 20)).toBe(20);
    expect(xToTime(50, 0, 20)).toBe(0);
  });
});

describe("snapValue", () => {
  it("snaps to the nearest target within threshold, else leaves the value", () => {
    const targets = [0, 5, 12, 20];
    expect(snapValue(5.3, targets, 0.5)).toBe(5); // within threshold
    expect(snapValue(5.3, targets, 0.2)).toBe(5.3); // beyond threshold, unchanged
    expect(snapValue(11.6, targets, 0.5)).toBe(12); // nearest is 12, not 5
    expect(snapValue(100, targets, 0.5)).toBe(100); // no target near
  });

  it("returns the value unchanged when there are no targets", () => {
    expect(snapValue(3.14, [], 1)).toBe(3.14);
  });
});

describe("timelineCutTimes", () => {
  it("lists every segment boundary including start and end", () => {
    expect(timelineCutTimes(threeSeg())).toEqual([0, 5, 12, 20]);
    expect(timelineCutTimes(buildTimelineDoc(10, 30))).toEqual([0, 20]);
  });
});

describe("dropIndexAt", () => {
  it("returns the slot whose midpoint sits right of the drop x", () => {
    const d = threeSeg();
    // boxes at 10 px/s: [0–50][50–120][120–200], midpoints 25 / 85 / 160.
    expect(dropIndexAt(d, 10, 0)).toBe(0); // before first midpoint
    expect(dropIndexAt(d, 10, 60)).toBe(1); // between mid1 and mid2
    expect(dropIndexAt(d, 10, 130)).toBe(2); // between mid2 and mid3
    expect(dropIndexAt(d, 10, 500)).toBe(3); // past every midpoint -> end
  });
});
