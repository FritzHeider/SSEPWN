import { describe, expect, it } from "vitest";

import { deleteSegment, reorder, splitAt, trim } from "../src/lib/timeline/ops";
import { buildTimelineDoc, readTimelineDoc, withTimelineDoc } from "../src/lib/timeline/state";
import {
  CUT,
  clampTransitionDuration,
  DEFAULT_TRANSITION_DURATION,
  getTransition,
  isTransitionKind,
  listTransitions,
  MAX_TRANSITION_DURATION,
  maxTransitionDuration,
  MIN_TRANSITION_DURATION,
  removeTransition,
  rightNeighborId,
  setTransition,
  TRANSITION_KINDS,
  transitionFits,
} from "../src/lib/timeline/transitions";
import { TimelineError, type TimelineDoc } from "../src/lib/timeline/types";

/** 0–20s clip split into seg-1 (0–5, dur 5), seg-2 (5–12, dur 7), seg-3 (12–20, dur 8). */
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

describe("transition kinds", () => {
  it("exposes cut first, then the animated kinds", () => {
    expect(TRANSITION_KINDS).toEqual(["cut", "crossfade", "slide-left", "slide-right"]);
  });

  it("isTransitionKind accepts known kinds, rejects others", () => {
    expect(isTransitionKind("crossfade")).toBe(true);
    expect(isTransitionKind("cut")).toBe(true);
    expect(isTransitionKind("wipe")).toBe(false);
    expect(isTransitionKind(3)).toBe(false);
  });
});

describe("clampTransitionDuration", () => {
  it("clamps into [MIN, MAX] and passes an in-band value", () => {
    expect(clampTransitionDuration(5)).toBe(MAX_TRANSITION_DURATION);
    expect(clampTransitionDuration(0.05)).toBe(MIN_TRANSITION_DURATION);
    expect(clampTransitionDuration(0.7)).toBe(0.7);
  });

  it("falls back to the default for a non-finite input", () => {
    expect(clampTransitionDuration(Number.NaN)).toBe(DEFAULT_TRANSITION_DURATION);
    expect(clampTransitionDuration(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TRANSITION_DURATION);
  });
});

describe("boundary geometry", () => {
  it("rightNeighborId walks playback order; last/unknown → null", () => {
    const d = multiSeg();
    expect(rightNeighborId(d, "seg-1")).toBe("seg-2");
    expect(rightNeighborId(d, "seg-2")).toBe("seg-3");
    expect(rightNeighborId(d, "seg-3")).toBeNull();
    expect(rightNeighborId(d, "nope")).toBeNull();
  });

  it("maxTransitionDuration is capped by MAX and by each neighbour", () => {
    const d = multiSeg();
    expect(maxTransitionDuration(d, "seg-1")).toBe(MAX_TRANSITION_DURATION); // min(1.5,5,7)
    expect(maxTransitionDuration(d, "seg-3")).toBe(0); // no boundary
    // short neighbour caps below MIN → no animated transition fits
    const s = shortNeighbor();
    expect(maxTransitionDuration(s, "seg-1")).toBeCloseTo(0.15, 6);
  });

  it("transitionFits requires strictly shorter than both neighbours", () => {
    const d = multiSeg();
    expect(transitionFits(d, "seg-1", 0.5)).toBe(true);
    expect(transitionFits(d, "seg-1", 4.9)).toBe(true); // < 5 and < 7
    expect(transitionFits(d, "seg-1", 5)).toBe(false); // equals the left neighbour
    expect(transitionFits(d, "seg-3", 0.1)).toBe(false); // no boundary
    expect(transitionFits(shortNeighbor(), "seg-1", 0.5)).toBe(false); // > 0.15 neighbour
  });
});

describe("getTransition / listTransitions defaults", () => {
  it("a fresh boundary is CUT and lists nothing", () => {
    const d = multiSeg();
    expect(getTransition(d, "seg-1")).toEqual(CUT);
    expect(listTransitions(d)).toEqual([]);
  });
});

describe("setTransition", () => {
  it("stores an animated transition keyed by the left segment", () => {
    const d = multiSeg();
    const next = setTransition(d, "seg-1", "crossfade", 0.6);
    expect(getTransition(next, "seg-1")).toEqual({ kind: "crossfade", duration: 0.6 });
    expect(next.transitions).toEqual({ "seg-1": { kind: "crossfade", duration: 0.6 } });
    expect(listTransitions(next)).toEqual([
      { leftId: "seg-1", rightId: "seg-2", transition: { kind: "crossfade", duration: 0.6 } },
    ]);
    // pure: original untouched
    expect(d.transitions).toEqual({});
  });

  it("defaults the duration to DEFAULT_TRANSITION_DURATION", () => {
    const d = setTransition(multiSeg(), "seg-2", "slide-left");
    expect(getTransition(d, "seg-2").duration).toBe(DEFAULT_TRANSITION_DURATION);
  });

  it("cut clears a stored transition (and is a no-op when none stored)", () => {
    const d = setTransition(multiSeg(), "seg-1", "crossfade", 0.5);
    const cleared = setTransition(d, "seg-1", "cut");
    expect(getTransition(cleared, "seg-1")).toEqual(CUT);
    expect(cleared.transitions).toEqual({});
    // no-op path returns an equal doc without throwing
    expect(setTransition(cleared, "seg-1", "cut").transitions).toEqual({});
    expect(removeTransition(d, "seg-1").transitions).toEqual({});
  });

  it("rejects a transition on the last segment", () => {
    expect(() => setTransition(multiSeg(), "seg-3", "crossfade", 0.5)).toThrow(TimelineError);
  });

  it("rejects an unknown segment or kind", () => {
    const d = multiSeg();
    expect(() => setTransition(d, "seg-9", "crossfade", 0.5)).toThrow(TimelineError);
    // @ts-expect-error deliberately invalid kind
    expect(() => setTransition(d, "seg-1", "wipe", 0.5)).toThrow(TimelineError);
  });

  it("rejects a duration outside the 0.2–1.5s band", () => {
    const d = multiSeg();
    expect(() => setTransition(d, "seg-1", "crossfade", 0.1)).toThrow(TimelineError);
    expect(() => setTransition(d, "seg-1", "crossfade", 2)).toThrow(TimelineError);
    expect(() => setTransition(d, "seg-1", "crossfade", Number.NaN)).toThrow(TimelineError);
  });

  it("rejects a duration longer than an adjacent segment", () => {
    // seg-1 boundary of shortNeighbor has a 0.15s right neighbour; 0.5s is in-band
    // but longer than that neighbour → rejected.
    expect(() => setTransition(shortNeighbor(), "seg-1", "crossfade", 0.5)).toThrow(TimelineError);
  });

  it("is deterministic — same doc+args → deep-equal result", () => {
    const d = multiSeg();
    expect(setTransition(d, "seg-1", "crossfade", 0.5)).toEqual(
      setTransition(d, "seg-1", "crossfade", 0.5),
    );
  });
});

describe("transitions survive / prune through segment ops", () => {
  it("follows its left segment through a trim (ids stable)", () => {
    let d = setTransition(multiSeg(), "seg-1", "crossfade", 0.5);
    d = trim(d, "seg-2", "out", 11); // shortens seg-2 to dur 6, still > 0.5
    expect(getTransition(d, "seg-1")).toEqual({ kind: "crossfade", duration: 0.5 });
  });

  it("goes inert (listed as none) once its left segment is deleted", () => {
    let d = setTransition(multiSeg(), "seg-1", "crossfade", 0.5);
    d = deleteSegment(d, "seg-1");
    // stale key may linger in the map, but the boundary is gone
    expect(getTransition(d, "seg-1")).toEqual(CUT);
    expect(listTransitions(d)).toEqual([]);
  });

  it("goes inert when a reorder makes its left segment last", () => {
    let d = setTransition(multiSeg(), "seg-1", "crossfade", 0.5);
    d = reorder(d, "seg-1", 2); // seg-1 to the end → no following segment
    expect(getTransition(d, "seg-1")).toEqual(CUT);
    expect(listTransitions(d)).toEqual([]);
  });
});

describe("round-trip through state blob", () => {
  it("persists and re-reads a transition, preserving other tracks", () => {
    const d = setTransition(multiSeg(), "seg-2", "slide-right", 0.9);
    const blob = withTimelineDoc({ captions: { words: [1] } }, d);
    const read = readTimelineDoc(blob);
    expect(read?.transitions).toEqual({ "seg-2": { kind: "slide-right", duration: 0.9 } });
    expect((blob as { captions: unknown }).captions).toEqual({ words: [1] });
  });

  it("drops malformed and cut entries on read", () => {
    const blob = {
      timeline: {
        version: 1,
        bounds: { in: 0, out: 20 },
        segments: [{ id: "seg-1", sourceIn: 0, sourceOut: 20 }],
        transitions: {
          "seg-1": { kind: "cut", duration: 0 }, // default → dropped
          "seg-x": { kind: "crossfade", duration: 0.5 }, // kept
          "seg-y": { kind: "bogus", duration: 0.5 }, // bad kind → dropped
          "seg-z": { kind: "crossfade", duration: "nope" }, // bad duration → dropped
        },
      },
    };
    const read = readTimelineDoc(blob);
    expect(read?.transitions).toEqual({ "seg-x": { kind: "crossfade", duration: 0.5 } });
  });

  it("defaults to an empty map when the blob has no transitions", () => {
    const read = readTimelineDoc(withTimelineDoc({}, buildTimelineDoc(0, 10)));
    expect(read?.transitions).toEqual({});
  });
});
