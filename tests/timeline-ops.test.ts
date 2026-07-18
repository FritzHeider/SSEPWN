import { describe, expect, it } from "vitest";

import {
  deleteSegment,
  reorder,
  segmentStarts,
  setMuted,
  setVolume,
  sourceTimeAt,
  splitAt,
  timelineTimeAt,
  totalDuration,
  trim,
} from "../src/lib/timeline/ops";
import {
  assertValidDoc,
  buildTimelineDoc,
  readTimelineDoc,
  withTimelineDoc,
} from "../src/lib/timeline/state";
import {
  AUDIO_MAX_VOLUME,
  MIN_SEGMENT_DURATION,
  TimelineError,
  type TimelineDoc,
} from "../src/lib/timeline/types";

/** A clip from 10s to 30s of the source (20s window). */
function doc(): TimelineDoc {
  return buildTimelineDoc(10, 30);
}

describe("buildTimelineDoc", () => {
  it("makes one segment spanning the whole clip window", () => {
    const d = doc();
    expect(d.segments).toEqual([{ id: "seg-1", sourceIn: 10, sourceOut: 30 }]);
    expect(d.bounds).toEqual({ in: 10, out: 30 });
    expect(d.audio).toEqual({ volume: 1, muted: false });
    expect(totalDuration(d)).toBe(20);
  });

  it("rejects a degenerate window", () => {
    expect(() => buildTimelineDoc(10, 10)).toThrow(TimelineError);
    expect(() => buildTimelineDoc(Number.NaN, 5)).toThrow(TimelineError);
  });
});

describe("splitAt", () => {
  it("splits into two contiguous segments covering the original range", () => {
    const d = splitAt(doc(), 5); // 5s into playback = source 15
    expect(d.segments).toEqual([
      { id: "seg-1", sourceIn: 10, sourceOut: 15 },
      { id: "seg-2", sourceIn: 15, sourceOut: 30 },
    ]);
    expect(totalDuration(d)).toBe(20); // duration preserved
  });

  it("is a no-op at (or beyond) the ends and near an edge", () => {
    const base = doc();
    expect(splitAt(base, 0)).toBe(base);
    expect(splitAt(base, 20)).toBe(base);
    expect(splitAt(base, 100)).toBe(base);
    expect(splitAt(base, MIN_SEGMENT_DURATION / 2)).toBe(base);
  });

  it("splits the correct segment after an earlier split", () => {
    let d = splitAt(doc(), 5); // seg-1 10-15, seg-2 15-30
    d = splitAt(d, 12); // 12s playback -> source 22, inside seg-2
    expect(d.segments).toEqual([
      { id: "seg-1", sourceIn: 10, sourceOut: 15 },
      { id: "seg-2", sourceIn: 15, sourceOut: 22 },
      { id: "seg-3", sourceIn: 22, sourceOut: 30 },
    ]);
  });
});

describe("trim", () => {
  it("moves an edge and clamps to the clip bounds", () => {
    const d = trim(doc(), "seg-1", "in", 5); // below bounds.in=10
    expect(d.segments[0].sourceIn).toBe(10); // clamped to bounds
    const e = trim(doc(), "seg-1", "out", 99); // above bounds.out=30
    expect(e.segments[0].sourceOut).toBe(30);
  });

  it("clamps a trim to its source neighbours, never overlapping them", () => {
    const split = splitAt(doc(), 5); // seg-1 10-15, seg-2 15-30
    // Growing seg-1's out past seg-2's start clamps to the neighbour (15).
    const grown = trim(split, "seg-1", "out", 25);
    expect(grown.segments[0].sourceOut).toBe(15);
    // Growing seg-2's in below seg-1's end clamps to the neighbour (15).
    const grown2 = trim(split, "seg-2", "in", 4);
    expect(grown2.segments[1].sourceIn).toBe(15);
  });

  it("keeps a minimum segment duration when trimming toward the opposite edge", () => {
    const d = trim(doc(), "seg-1", "in", 29.9995); // almost onto the out edge
    expect(d.segments[0].sourceOut - d.segments[0].sourceIn).toBeGreaterThanOrEqual(
      MIN_SEGMENT_DURATION - 1e-9,
    );
  });

  it("rejects a non-finite target and an unknown segment", () => {
    expect(() => trim(doc(), "seg-1", "in", Number.NaN)).toThrow(TimelineError);
    expect(() => trim(doc(), "nope", "in", 12)).toThrow(TimelineError);
  });
});

describe("deleteSegment", () => {
  it("removes a segment and keeps invariants", () => {
    const split = splitAt(doc(), 5);
    const d = deleteSegment(split, "seg-1");
    expect(d.segments).toEqual([{ id: "seg-2", sourceIn: 15, sourceOut: 30 }]);
    expect(totalDuration(d)).toBe(15);
  });

  it("refuses to delete the only segment or an unknown id", () => {
    expect(() => deleteSegment(doc(), "seg-1")).toThrow(TimelineError);
    expect(() => deleteSegment(doc(), "nope")).toThrow(TimelineError);
  });
});

describe("reorder", () => {
  it("moves a segment to a new playback position", () => {
    let d = splitAt(doc(), 5); // seg-1, seg-2
    d = splitAt(d, 12); // seg-1, seg-2, seg-3
    const moved = reorder(d, "seg-3", 0);
    expect(moved.segments.map((s) => s.id)).toEqual(["seg-3", "seg-1", "seg-2"]);
    // Reorder changes playback order but not total duration.
    expect(totalDuration(moved)).toBe(totalDuration(d));
  });

  it("clamps the target index and no-ops a same-position move", () => {
    const d = splitAt(doc(), 5);
    expect(reorder(d, "seg-1", 99).segments.map((s) => s.id)).toEqual(["seg-2", "seg-1"]);
    expect(reorder(d, "seg-1", 0)).toBe(d);
  });
});

describe("audio ops", () => {
  it("setVolume clamps into [0, AUDIO_MAX_VOLUME] and keeps other fields", () => {
    const d = doc();
    expect(setVolume(d, 0.5).audio).toEqual({ volume: 0.5, muted: false });
    expect(setVolume(d, 99).audio.volume).toBe(AUDIO_MAX_VOLUME);
    expect(setVolume(d, -3).audio.volume).toBe(0);
    // Volume does not disturb the mute flag or segments.
    const muted = setMuted(d, true);
    expect(setVolume(muted, 1.5).audio).toEqual({ volume: 1.5, muted: true });
    expect(setVolume(d, 1).segments).toEqual(d.segments);
  });

  it("setVolume rejects a non-finite value", () => {
    expect(() => setVolume(doc(), Number.NaN)).toThrow(TimelineError);
    expect(() => setVolume(doc(), Number.POSITIVE_INFINITY)).toThrow(TimelineError);
  });

  it("setMuted toggles the flag without touching volume", () => {
    const d = setVolume(doc(), 1.5);
    expect(setMuted(d, true).audio).toEqual({ volume: 1.5, muted: true });
    expect(setMuted(setMuted(d, true), false).audio).toEqual({ volume: 1.5, muted: false });
  });
});

describe("time mapping", () => {
  it("maps timeline time to source time across a reorder", () => {
    let d = splitAt(doc(), 5); // seg-1 10-15, seg-2 15-30
    d = reorder(d, "seg-2", 0); // now plays seg-2 (15-30) then seg-1 (10-15)
    expect(segmentStarts(d)).toEqual([0, 15]);
    expect(sourceTimeAt(d, 0)).toBe(15); // start of reordered first segment
    expect(sourceTimeAt(d, 15)).toBe(30); // the cut resolves to the earlier segment's end
    expect(sourceTimeAt(d, 15.5)).toBe(10.5); // just past the cut = into the second segment
    expect(sourceTimeAt(d, 3)).toBe(18);
  });

  it("clamps out-of-range timeline times", () => {
    const d = doc();
    expect(sourceTimeAt(d, -5)).toBe(10);
    expect(sourceTimeAt(d, 999)).toBe(30);
  });

  it("timelineTimeAt inverts sourceTimeAt and returns null for cut-out source time", () => {
    let d = splitAt(doc(), 5); // seg-1 10-15, seg-2 15-30
    d = deleteSegment(d, "seg-1"); // source 10-15 no longer plays
    expect(timelineTimeAt(d, 12)).toBeNull(); // inside the deleted range
    expect(timelineTimeAt(d, 20)).toBe(5); // 20 is 5s into the surviving segment
    expect(sourceTimeAt(d, timelineTimeAt(d, 20)!)).toBeCloseTo(20, 6);
  });
});

// A tiny deterministic PRNG so the property test is reproducible (no Math.random).
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("property: random op sequences preserve invariants", () => {
  it("totalDuration equals the segment-length sum and sourceTimeAt∘inverse is identity", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = makeRng(seed);
      let d = buildTimelineDoc(0, 100);
      for (let step = 0; step < 25; step++) {
        const total = totalDuration(d);
        const pick = rng();
        try {
          if (pick < 0.35) {
            d = splitAt(d, rng() * total);
          } else if (pick < 0.55 && d.segments.length > 1) {
            const seg = d.segments[Math.floor(rng() * d.segments.length)];
            d = deleteSegment(d, seg.id);
          } else if (pick < 0.75) {
            const seg = d.segments[Math.floor(rng() * d.segments.length)];
            d = reorder(d, seg.id, Math.floor(rng() * d.segments.length));
          } else {
            const seg = d.segments[Math.floor(rng() * d.segments.length)];
            const edge = rng() < 0.5 ? "in" : "out";
            d = trim(d, seg.id, edge, rng() * 100);
          }
        } catch (err) {
          // Only the documented "can't delete the last segment" guard may throw.
          expect(err).toBeInstanceOf(TimelineError);
        }

        // Invariant 1: the doc is always structurally valid.
        expect(() => assertValidDoc(d)).not.toThrow();
        // Invariant 2: totalDuration is the literal sum of segment lengths.
        const manual = d.segments.reduce((s, seg) => s + (seg.sourceOut - seg.sourceIn), 0);
        expect(totalDuration(d)).toBeCloseTo(manual, 9);

        // Invariant 3: for an interior point of any segment, mapping to source
        // and back is the identity (±1 ms). Interior avoids cut-point ties.
        for (const seg of d.segments) {
          const src = seg.sourceIn + (seg.sourceOut - seg.sourceIn) / 2;
          const tl = timelineTimeAt(d, src);
          expect(tl).not.toBeNull();
          expect(sourceTimeAt(d, tl!)).toBeCloseTo(src, 3);
        }
      }
    }
  });
});

describe("readTimelineDoc / withTimelineDoc", () => {
  it("round-trips a doc through the shared state blob", () => {
    const d = splitAt(doc(), 5);
    const blob = withTimelineDoc({ crop: { some: "thing" } }, d);
    expect(blob.crop).toEqual({ some: "thing" }); // sibling keys preserved
    const back = readTimelineDoc(blob);
    expect(back).toEqual(d);
  });

  it("returns null for absent or malformed timelines", () => {
    expect(readTimelineDoc(null)).toBeNull();
    expect(readTimelineDoc({})).toBeNull();
    expect(readTimelineDoc({ timeline: { segments: [] } })).toBeNull();
    expect(readTimelineDoc({ timeline: { segments: [{ id: "x" }], bounds: { in: 0, out: 1 } } })).toBeNull();
  });

  it("defaults missing optional tracks and clamps a stored volume", () => {
    const back = readTimelineDoc({
      timeline: {
        segments: [{ id: "seg-1", sourceIn: 0, sourceOut: 5 }],
        bounds: { in: 0, out: 5 },
        audio: { volume: 99, muted: true },
      },
    });
    expect(back?.overlayTrack).toEqual([]);
    expect(back?.captionTrackRef).toBeNull();
    expect(back?.audio).toEqual({ volume: 2, muted: true }); // clamped to AUDIO_MAX_VOLUME
    expect(back?.seq).toBe(1);
  });
});
