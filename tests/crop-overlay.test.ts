import { describe, expect, it } from "vitest";

import {
  centeredWindow,
  clampWindow,
  cropWindowAt,
  cropWindowSize,
  normaliseRect,
} from "../src/lib/crop/overlay";
import type { CropKeyframe } from "../src/lib/crop/types";

describe("cropWindowSize", () => {
  it("sizes an AR-exact window that fits a 1280x720 source", () => {
    // 9:16 is taller than the source → height-limited (full 720 height).
    expect(cropWindowSize("9:16", 1280, 720)).toEqual({ w: 405, h: 720 });
    // 1:1 → square of the shorter side.
    expect(cropWindowSize("1:1", 1280, 720)).toEqual({ w: 720, h: 720 });
    // 16:9 equals the source ratio → the whole frame.
    expect(cropWindowSize("16:9", 1280, 720)).toEqual({ w: 1280, h: 720 });
  });
});

describe("centeredWindow", () => {
  it("centres the AR window in the source", () => {
    expect(centeredWindow("9:16", 1280, 720)).toEqual({
      x: Math.round((1280 - 405) / 2),
      y: 0,
      w: 405,
      h: 720,
    });
  });
});

describe("cropWindowAt", () => {
  const kfs: CropKeyframe[] = [
    { t: 0, x: 0, y: 0, w: 400, h: 720 },
    { t: 2, x: 200, y: 0, w: 400, h: 720 },
    { t: 4, x: 800, y: 0, w: 400, h: 720 },
  ];

  it("returns null for an empty plan", () => {
    expect(cropWindowAt([], 1)).toBeNull();
  });

  it("holds the first keyframe before its time (no extrapolation)", () => {
    expect(cropWindowAt(kfs, -5)).toEqual({ x: 0, y: 0, w: 400, h: 720 });
  });

  it("holds the last keyframe after its time (no extrapolation)", () => {
    expect(cropWindowAt(kfs, 99)).toEqual({ x: 800, y: 0, w: 400, h: 720 });
  });

  it("interpolates linearly between two keyframes", () => {
    // Halfway between t=0 (x=0) and t=2 (x=200) → x=100.
    expect(cropWindowAt(kfs, 1)?.x).toBeCloseTo(100, 6);
    // A quarter of the way from t=2 (x=200) to t=4 (x=800) → x=350.
    expect(cropWindowAt(kfs, 2.5)?.x).toBeCloseTo(350, 6);
  });

  it("returns a keyframe exactly at its time", () => {
    expect(cropWindowAt(kfs, 2)).toEqual({ x: 200, y: 0, w: 400, h: 720 });
  });

  it("does not divide by zero when two keyframes share a time", () => {
    const dup: CropKeyframe[] = [
      { t: 1, x: 0, y: 0, w: 100, h: 100 },
      { t: 1, x: 50, y: 0, w: 100, h: 100 },
    ];
    // t between the shared time and itself collapses to the earlier one.
    expect(cropWindowAt(dup, 1)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });
});

describe("normaliseRect", () => {
  it("maps source pixels to 0..1 fractions of the frame", () => {
    expect(normaliseRect({ x: 320, y: 180, w: 640, h: 360 }, 1280, 720)).toEqual({
      left: 0.25,
      top: 0.25,
      width: 0.5,
      height: 0.5,
    });
  });

  it("yields a zero rect (not NaN) for a non-positive source dimension", () => {
    expect(normaliseRect({ x: 0, y: 0, w: 10, h: 10 }, 0, 720)).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });
});

describe("clampWindow", () => {
  it("keeps the window inside the source", () => {
    // Pushed past the right/bottom edge → pinned so the window still fits.
    expect(clampWindow(2000, 2000, 400, 720, 1280, 720)).toEqual({ x: 880, y: 0 });
    // Pushed past the top-left → pinned to the origin.
    expect(clampWindow(-50, -50, 400, 720, 1280, 720)).toEqual({ x: 0, y: 0 });
  });

  it("leaves an in-bounds window untouched", () => {
    expect(clampWindow(300, 0, 400, 720, 1280, 720)).toEqual({ x: 300, y: 0 });
  });
});
