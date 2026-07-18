import { describe, expect, it } from "vitest";

import {
  applyCropOverride,
  buildCropState,
  CropOverrideError,
  parseCropOverride,
  readCropState,
  withCropState,
} from "../src/lib/crop/state";
import type { CropKeyframe } from "../src/lib/crop/types";

const KEYFRAMES: CropKeyframe[] = [
  { t: 0, x: 100, y: 0, w: 405, h: 720 },
  { t: 2, x: 200, y: 0, w: 405, h: 720 },
];

describe("buildCropState", () => {
  it("captures ar, keyframes, source dims, and defaults locked to false", () => {
    const s = buildCropState("9:16", KEYFRAMES, 1280, 720);
    expect(s).toEqual({
      aspectRatio: "9:16",
      keyframes: KEYFRAMES,
      srcWidth: 1280,
      srcHeight: 720,
      locked: false,
    });
  });

  it("carries an explicit locked flag", () => {
    expect(buildCropState("1:1", KEYFRAMES, 1280, 720, true).locked).toBe(true);
  });
});

describe("withCropState", () => {
  it("adds crop without disturbing sibling keys (captions/timeline survive)", () => {
    const state = { captions: { cues: [], style: {} }, timeline: { foo: 1 } };
    const next = withCropState(state, buildCropState("16:9", KEYFRAMES, 1280, 720));
    expect(next.captions).toBe(state.captions);
    expect(next.timeline).toBe(state.timeline);
    expect(readCropState(next)?.aspectRatio).toBe("16:9");
  });

  it("returns a new object (does not mutate the input blob)", () => {
    const state: Record<string, unknown> = {};
    const next = withCropState(state, buildCropState("9:16", KEYFRAMES, 1280, 720));
    expect(next).not.toBe(state);
    expect(state.crop).toBeUndefined();
  });
});

describe("readCropState", () => {
  it("round-trips a state written by buildCropState/withCropState", () => {
    const crop = buildCropState("9:16", KEYFRAMES, 1280, 720, true);
    const blob = JSON.parse(JSON.stringify(withCropState({}, crop)));
    expect(readCropState(blob)).toEqual(crop);
  });

  it("treats a missing locked flag as unlocked", () => {
    const blob = { crop: { aspectRatio: "1:1", keyframes: KEYFRAMES, srcWidth: 1280, srcHeight: 720 } };
    expect(readCropState(blob)?.locked).toBe(false);
  });

  it.each([
    ["null state", null],
    ["non-object state", 42],
    ["no crop key", { captions: {} }],
    ["bad aspect ratio", { crop: { aspectRatio: "4:3", keyframes: [], srcWidth: 1, srcHeight: 1 } }],
    ["keyframes not an array", { crop: { aspectRatio: "9:16", keyframes: {}, srcWidth: 1, srcHeight: 1 } }],
    [
      "malformed keyframe",
      { crop: { aspectRatio: "9:16", keyframes: [{ t: 0, x: 0 }], srcWidth: 1, srcHeight: 1 } },
    ],
    [
      "non-finite source dim",
      { crop: { aspectRatio: "9:16", keyframes: [], srcWidth: Number.NaN, srcHeight: 1 } },
    ],
  ])("returns null for %s", (_label, blob) => {
    expect(readCropState(blob)).toBeNull();
  });
});

const KF: CropKeyframe = { t: 1, x: 300, y: 0, w: 405, h: 720 };

describe("parseCropOverride", () => {
  it("accepts a well-formed keyframe with optional aspect ratio", () => {
    expect(parseCropOverride({ keyframe: KF, aspectRatio: "9:16" })).toEqual({
      keyframe: KF,
      aspectRatio: "9:16",
    });
    expect(parseCropOverride({ keyframe: KF })).toEqual({ keyframe: KF, aspectRatio: undefined });
  });

  it.each([
    ["non-object body", 5],
    ["missing keyframe", {}],
    ["keyframe missing a field", { keyframe: { t: 0, x: 0, y: 0, w: 10 } }],
    ["non-finite field", { keyframe: { t: 0, x: Number.NaN, y: 0, w: 10, h: 10 } }],
    ["non-positive size", { keyframe: { t: 0, x: 0, y: 0, w: 0, h: 10 } }],
    ["negative time", { keyframe: { t: -1, x: 0, y: 0, w: 10, h: 10 } }],
    ["bad aspect ratio", { keyframe: KF, aspectRatio: "4:3" }],
  ])("throws CropOverrideError for %s", (_label, body) => {
    expect(() => parseCropOverride(body)).toThrow(CropOverrideError);
  });
});

describe("applyCropOverride", () => {
  const FALLBACK = { srcWidth: 1280, srcHeight: 720 };

  it("locks and re-anchors when the clip has no crop yet (AR required)", () => {
    const out = applyCropOverride(null, { keyframe: KF, aspectRatio: "9:16" }, FALLBACK);
    expect(out).toEqual({
      aspectRatio: "9:16",
      keyframes: [KF],
      srcWidth: 1280,
      srcHeight: 720,
      locked: true,
    });
  });

  it("requires an aspect ratio for the first override", () => {
    expect(() => applyCropOverride(null, { keyframe: KF }, FALLBACK)).toThrow(CropOverrideError);
  });

  it("rejects an override when source dimensions are unknown", () => {
    expect(() =>
      applyCropOverride(null, { keyframe: KF, aspectRatio: "9:16" }, { srcWidth: 0, srcHeight: 0 }),
    ).toThrow(CropOverrideError);
  });

  it("merges a new-time keyframe into an existing plan and locks it", () => {
    const existing = buildCropState(
      "9:16",
      [
        { t: 0, x: 100, y: 0, w: 405, h: 720 },
        { t: 2, x: 500, y: 0, w: 405, h: 720 },
      ],
      1280,
      720,
      false,
    );
    const out = applyCropOverride(existing, { keyframe: KF }, FALLBACK);
    expect(out.locked).toBe(true);
    expect(out.keyframes.map((k) => k.t)).toEqual([0, 1, 2]); // inserted, sorted
    expect(out.keyframes[1]).toEqual(KF);
  });

  it("replaces the keyframe at a matching time rather than duplicating it", () => {
    const existing = buildCropState("9:16", [{ t: 1, x: 0, y: 0, w: 405, h: 720 }], 1280, 720, false);
    const out = applyCropOverride(existing, { keyframe: KF }, FALLBACK);
    expect(out.keyframes).toEqual([KF]);
  });

  it("re-anchors to the single keyframe when the override switches aspect ratio", () => {
    const existing = buildCropState(
      "9:16",
      [
        { t: 0, x: 100, y: 0, w: 405, h: 720 },
        { t: 2, x: 500, y: 0, w: 405, h: 720 },
      ],
      1280,
      720,
      false,
    );
    const square: CropKeyframe = { t: 0, x: 280, y: 0, w: 720, h: 720 };
    const out = applyCropOverride(existing, { keyframe: square, aspectRatio: "1:1" }, FALLBACK);
    expect(out.aspectRatio).toBe("1:1");
    expect(out.keyframes).toEqual([square]);
    expect(out.srcWidth).toBe(1280); // source dims inherited from existing crop
  });
});
