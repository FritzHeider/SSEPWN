import { describe, expect, it } from "vitest";

import { splitAt } from "../src/lib/timeline/ops";
import { buildTimelineDoc } from "../src/lib/timeline/state";
import {
  DEFAULT_TRANSITION_DURATION,
  MAX_TRANSITION_DURATION,
  MIN_TRANSITION_DURATION,
  setTransition,
  transitionFits,
} from "../src/lib/timeline/transitions";
import {
  boundaryCanAnimate,
  fitTransitionDuration,
  transitionBoundaries,
} from "../src/lib/timeline/transitions-view";
import type { TimelineDoc } from "../src/lib/timeline/types";

/** 0–20s clip → seg-1 (0–5, dur 5), seg-2 (5–12, dur 7), seg-3 (12–20, dur 8). */
function multiSeg(): TimelineDoc {
  let d = buildTimelineDoc(0, 20);
  d = splitAt(d, 5);
  d = splitAt(d, 12);
  return d;
}

/** seg-1 (0–5, dur 5) then a very short seg-2 (5–5.15, dur 0.15). */
function shortNeighbor(): TimelineDoc {
  let d = buildTimelineDoc(0, 20);
  d = splitAt(d, 5);
  d = splitAt(d, 5.15);
  return d;
}

describe("transitionBoundaries", () => {
  it("has one entry per boundary in playback order, defaulting to cut", () => {
    const doc = multiSeg();
    const boundaries = transitionBoundaries(doc);
    expect(boundaries.map((b) => b.leftId)).toEqual([doc.segments[0].id, doc.segments[1].id]);
    expect(boundaries.map((b) => b.rightId)).toEqual([doc.segments[1].id, doc.segments[2].id]);
    expect(boundaries.map((b) => b.index)).toEqual([0, 1]);
    expect(boundaries.every((b) => b.kind === "cut" && b.duration === 0)).toBe(true);
  });

  it("has no boundaries for a single-segment doc", () => {
    expect(transitionBoundaries(buildTimelineDoc(0, 10))).toEqual([]);
  });

  it("reflects a stored animated transition's kind and duration", () => {
    const doc = setTransition(multiSeg(), transitionBoundaries(multiSeg())[0].leftId, "crossfade", 0.5);
    const first = transitionBoundaries(doc)[0];
    expect(first.kind).toBe("crossfade");
    expect(first.duration).toBe(0.5);
  });

  it("exposes maxDuration and canAnimate per boundary", () => {
    const boundaries = transitionBoundaries(multiSeg());
    // seg-1 (5) / seg-2 (7): capped by MAX (1.5), both long enough to animate.
    expect(boundaries[0].maxDuration).toBe(MAX_TRANSITION_DURATION);
    expect(boundaries[0].canAnimate).toBe(true);
  });

  it("marks a boundary with a too-short neighbour as not animatable", () => {
    const boundaries = transitionBoundaries(shortNeighbor());
    expect(boundaries[0].maxDuration).toBeCloseTo(0.15, 5);
    expect(boundaries[0].canAnimate).toBe(false);
  });
});

describe("boundaryCanAnimate", () => {
  it("is false at exactly MIN_TRANSITION_DURATION neighbour length", () => {
    let d = buildTimelineDoc(0, 20);
    d = splitAt(d, MIN_TRANSITION_DURATION); // seg-1 is exactly MIN long
    expect(boundaryCanAnimate(d, d.segments[0].id)).toBe(false);
  });

  it("is true when both neighbours exceed MIN", () => {
    const doc = multiSeg();
    expect(boundaryCanAnimate(doc, doc.segments[0].id)).toBe(true);
  });
});

describe("fitTransitionDuration", () => {
  it("clamps below MIN up to MIN", () => {
    const doc = multiSeg();
    expect(fitTransitionDuration(doc, doc.segments[0].id, 0.01)).toBe(MIN_TRANSITION_DURATION);
  });

  it("falls back to the default for a non-finite request", () => {
    const doc = multiSeg();
    expect(fitTransitionDuration(doc, doc.segments[0].id, Number.NaN)).toBe(DEFAULT_TRANSITION_DURATION);
  });

  it("caps at a value that setTransition accepts, even against a tight neighbour", () => {
    // seg-2 is 0.6s; a request of MAX must be clamped to strictly under 0.6.
    let d = buildTimelineDoc(0, 20);
    d = splitAt(d, 5);
    d = splitAt(d, 5.6);
    const leftId = d.segments[1].id; // boundary between the 0.6s seg and its neighbour
    const fitted = fitTransitionDuration(d, leftId, MAX_TRANSITION_DURATION);
    expect(fitted).toBeLessThan(0.6);
    expect(transitionFits(d, leftId, fitted)).toBe(true);
    // and the clamped value round-trips through the op without throwing.
    expect(() => setTransition(d, leftId, "crossfade", fitted)).not.toThrow();
  });

  it("passes an in-band request through unchanged", () => {
    const doc = multiSeg();
    expect(fitTransitionDuration(doc, doc.segments[0].id, 0.5)).toBe(0.5);
  });
});
