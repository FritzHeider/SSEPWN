import { describe, expect, it } from "vitest";

import { deleteSegment, reorder, splitAt, totalDuration } from "../src/lib/timeline/ops";
import { advancePlayback, segmentIndexAt } from "../src/lib/timeline/playback";
import { buildTimelineDoc } from "../src/lib/timeline/state";
import type { TimelineDoc } from "../src/lib/timeline/types";

/** A 20s clip (source 10–30) cut into three segments: [10–15][15–22][22–30]. */
function threeSeg(): TimelineDoc {
  let d = buildTimelineDoc(10, 30);
  d = splitAt(d, 5); // [10–15][15–30]
  d = splitAt(d, 12); // [10–15][15–22][22–30]
  return d;
}

describe("segmentIndexAt", () => {
  it("maps interior times to their segment", () => {
    const d = threeSeg();
    expect(segmentIndexAt(d, 2)).toBe(0); // inside [0–5)
    expect(segmentIndexAt(d, 8)).toBe(1); // inside [5–12)
    expect(segmentIndexAt(d, 15)).toBe(2); // inside [12–20)
  });

  it("resolves a cut boundary to the LATER (starting) segment", () => {
    const d = threeSeg();
    expect(segmentIndexAt(d, 5)).toBe(1);
    expect(segmentIndexAt(d, 12)).toBe(2);
    expect(segmentIndexAt(d, 0)).toBe(0);
  });

  it("clamps a time at or past the end to the last segment", () => {
    const d = threeSeg();
    expect(segmentIndexAt(d, 20)).toBe(2);
    expect(segmentIndexAt(d, 999)).toBe(2);
  });
});

describe("advancePlayback", () => {
  it("keeps playing and tracks the playhead inside a segment", () => {
    const d = threeSeg();
    const step = advancePlayback(d, 0, 12); // source 12 is inside seg0 [10–15]
    expect(step).toEqual({ segIndex: 0, seekSource: null, timelineT: 2, ended: false });
  });

  it("hands off to the next contiguous segment at the out edge", () => {
    const d = threeSeg();
    // seg0 ends at source 15; seg1 is contiguous [15–22].
    const step = advancePlayback(d, 0, 15);
    expect(step).toEqual({ segIndex: 1, seekSource: 15, timelineT: 5, ended: false });
  });

  it("ends playback when the last segment runs out", () => {
    const d = threeSeg();
    const step = advancePlayback(d, 2, 30); // seg2 [22–30] out edge
    expect(step).toEqual({ segIndex: 2, seekSource: null, timelineT: totalDuration(d), ended: true });
  });

  it("skips a deleted middle range by seeking to the surviving segment", () => {
    let d = threeSeg(); // [10–15][15–22][22–30]
    const middle = d.segments[1].id;
    d = deleteSegment(d, middle); // now [10–15][22–30]
    // Finishing seg0 (source 15) must jump the deleted 15–22 gap to source 22.
    const step = advancePlayback(d, 0, 15);
    expect(step.segIndex).toBe(1);
    expect(step.seekSource).toBe(22);
    expect(step.ended).toBe(false);
  });

  it("honours reordered playback by seeking backward in source", () => {
    let d = threeSeg(); // [10–15][15–22][22–30]
    // Move the last segment to the front: playback order [22–30][10–15][15–22].
    d = reorder(d, d.segments[2].id, 0);
    // Finishing the first-played segment (source 30) seeks back to source 10.
    const step = advancePlayback(d, 0, 30);
    expect(step.segIndex).toBe(1);
    expect(step.seekSource).toBe(10);
    expect(step.ended).toBe(false);
  });

  it("clamps a stale segment index into range", () => {
    const d = threeSeg();
    // Index 9 no longer exists (e.g. after a delete); treat it as the last segment.
    const step = advancePlayback(d, 9, 30);
    expect(step.segIndex).toBe(2);
    expect(step.ended).toBe(true);
  });

  it("never emits a negative playhead when the source clock lags the segment", () => {
    const d = threeSeg();
    // sourceT below seg1.sourceIn (15) — mid-seek — pins to the segment start.
    const step = advancePlayback(d, 1, 14);
    expect(step.timelineT).toBe(5);
    expect(step.seekSource).toBeNull();
  });
});
