import { describe, expect, it } from "vitest";

import { buildCropState, readCropState, withCropState } from "../src/lib/crop/state";
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
