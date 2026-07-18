import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_PAN_RATIO,
  planCrop,
  type PlanCropOptions,
} from "../src/lib/crop/plan";
import {
  aspectRatioValue,
  type AspectRatio,
  type Box,
  type FrameSample,
} from "../src/lib/crop/types";

const SRC_W = 1280;
const SRC_H = 720;

function box(cx: number, cy = 0.5, size = 0.2, confidence = 1): Box {
  // A `size × size` box centred on (cx, cy) in normalised coordinates.
  return { x: cx - size / 2, y: cy - size / 2, w: size, h: size, confidence };
}

function frame(t: number, boxes: Box[]): FrameSample {
  return { t, boxes };
}

/** A subject centred at cx for every frame in a fixed time grid. */
function track(times: number[], cxs: number[]): FrameSample[] {
  return times.map((t, i) => frame(t, [box(cxs[i])]));
}

describe("planCrop — crop window sizing", () => {
  it("produces exactly the target aspect ratio within 1px on a 1280×720 source", () => {
    const cases: Array<{ ar: AspectRatio; w: number; h: number }> = [
      { ar: "9:16", w: 405, h: 720 },
      { ar: "1:1", w: 720, h: 720 },
      { ar: "16:9", w: 1280, h: 720 },
    ];
    for (const { ar, w, h } of cases) {
      const [kf] = planCrop([], SRC_W, SRC_H, ar);
      expect(kf.w).toBe(w);
      expect(kf.h).toBe(h);
      // Realised ratio is within 1px of the ideal for this height.
      expect(Math.abs(kf.w - kf.h * aspectRatioValue(ar))).toBeLessThanOrEqual(1);
      // And the window fits inside the source.
      expect(kf.w).toBeLessThanOrEqual(SRC_W);
      expect(kf.h).toBeLessThanOrEqual(SRC_H);
    }
  });

  it("keeps the crop-window size constant across every keyframe", () => {
    const frames = track([0, 0.25, 0.5, 0.75, 1], [0.15, 0.35, 0.55, 0.75, 0.9]);
    const kfs = planCrop(frames, SRC_W, SRC_H, "9:16");
    for (const kf of kfs) {
      expect(kf.w).toBe(405);
      expect(kf.h).toBe(720);
    }
  });
});

describe("planCrop — subject follow", () => {
  it("pans monotonically for a left→right subject, never exceeding the speed cap", () => {
    const times = [0, 0.25, 0.5, 0.75, 1.0, 1.25];
    const cxs = [0.2, 0.35, 0.5, 0.65, 0.8, 0.9];
    const kfs = planCrop(track(times, cxs), SRC_W, SRC_H, "9:16");

    expect(kfs.length).toBeGreaterThan(1);
    const cap = DEFAULT_MAX_PAN_RATIO * SRC_W; // px/s

    for (let i = 1; i < kfs.length; i++) {
      const dx = kfs[i].x - kfs[i - 1].x;
      const dtv = kfs[i].t - kfs[i - 1].t;
      // Non-decreasing x — the window follows the subject rightward, no backtrack.
      expect(dx).toBeGreaterThanOrEqual(0);
      // Speed never exceeds the cap (+1px slack for integer rounding).
      expect(dx).toBeLessThanOrEqual(cap * dtv + 1);
      // y is pinned: a 9:16 window on a 16:9 source is full-height.
      expect(kfs[i].y).toBe(0);
    }
  });

  it("eases a large relocation over ≥0.5s instead of snapping", () => {
    // Subject sits left, then jumps hard right and holds.
    const frames: FrameSample[] = [
      frame(0, [box(0.15)]),
      frame(0.25, [box(0.15)]),
      frame(0.5, [box(0.85)]),
      frame(0.75, [box(0.85)]),
      frame(1.0, [box(0.85)]),
      frame(1.25, [box(0.85)]),
      frame(1.5, [box(0.85)]),
      frame(1.75, [box(0.85)]),
      frame(2.0, [box(0.85)]),
    ];
    const kfs = planCrop(frames, SRC_W, SRC_H, "9:16");
    const cap = DEFAULT_MAX_PAN_RATIO * SRC_W;

    // The move is spread across several keyframes, not one snap.
    const moving = kfs.filter((_, i) => i > 0);
    expect(moving.length).toBeGreaterThanOrEqual(2);
    // First pan starts at t=0.5, last keyframe lands ≥0.5s later.
    const panStart = kfs[1].t;
    const panEnd = kfs[kfs.length - 1].t;
    expect(panEnd - panStart).toBeGreaterThanOrEqual(0.5);

    for (let i = 1; i < kfs.length; i++) {
      const dx = kfs[i].x - kfs[i - 1].x;
      const dtv = kfs[i].t - kfs[i - 1].t;
      expect(dx).toBeGreaterThanOrEqual(0);
      expect(dx).toBeLessThanOrEqual(cap * dtv + 1);
    }
    // Converges near the clamped right edge (maxX = 1280 - 405 = 875).
    expect(kfs[kfs.length - 1].x).toBeGreaterThan(800);
  });
});

describe("planCrop — dead-zone", () => {
  it("collapses ±2% jitter into a single stationary keyframe", () => {
    const times = [0, 0.25, 0.5, 0.75, 1.0, 1.25];
    const cxs = [0.5, 0.52, 0.48, 0.51, 0.49, 0.5];
    const kfs = planCrop(track(times, cxs), SRC_W, SRC_H, "9:16");
    expect(kfs).toHaveLength(1);
    expect(kfs[0].t).toBe(0);
  });
});

describe("planCrop — no-subject fallback", () => {
  it("centres the crop window when no frame has a subject", () => {
    const frames = [frame(0, []), frame(0.5, []), frame(1, [])];
    const kfs = planCrop(frames, SRC_W, SRC_H, "9:16");
    expect(kfs).toHaveLength(1);
    // maxX = 875, centre = round(875/2) = 438; y full-height → 0.
    expect(kfs[0].x).toBe(Math.round((SRC_W - 405) / 2));
    expect(kfs[0].y).toBe(0);
  });

  it("centres for an empty frame list too", () => {
    const kfs = planCrop([], SRC_W, SRC_H, "1:1");
    expect(kfs).toHaveLength(1);
    expect(kfs[0].x).toBe(Math.round((SRC_W - 720) / 2));
    expect(kfs[0].y).toBe(0);
  });
});

describe("planCrop — highest-confidence subject wins", () => {
  it("follows the most confident box when several are present", () => {
    const frames: FrameSample[] = [
      frame(0, [box(0.2, 0.5, 0.2, 0.9), box(0.8, 0.5, 0.2, 0.3)]),
    ];
    const kfs = planCrop(frames, SRC_W, SRC_H, "9:16");
    // Centred on cx=0.2 (the 0.9-confidence box): 0.2*1280 - 405/2 = 256 - 202.5 → 54 clamped ≥0.
    expect(kfs[0].x).toBe(Math.round(0.2 * SRC_W - 405 / 2));
  });
});

describe("planCrop — input validation", () => {
  it("rejects non-positive or non-finite source dimensions", () => {
    const opts: PlanCropOptions = {};
    for (const [w, h] of [
      [0, 720],
      [1280, 0],
      [-1, 720],
      [Number.NaN, 720],
      [1280, Number.POSITIVE_INFINITY],
    ]) {
      expect(() => planCrop([], w, h, "9:16", opts)).toThrow(
        /positive finite source dimensions/,
      );
    }
  });
});
