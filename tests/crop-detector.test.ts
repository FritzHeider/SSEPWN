import { describe, expect, it } from "vitest";

import { FakeDetector } from "../src/lib/crop/fake";
import {
  ASPECT_RATIOS,
  aspectRatioValue,
  parseAspectRatio,
  type Box,
} from "../src/lib/crop/types";

function box(x: number, y: number, w: number, h: number, confidence = 1): Box {
  return { x, y, w, h, confidence };
}

describe("aspect ratio helpers", () => {
  it("maps each ratio to width ÷ height", () => {
    expect(aspectRatioValue("9:16")).toBeCloseTo(9 / 16, 10);
    expect(aspectRatioValue("1:1")).toBe(1);
    expect(aspectRatioValue("16:9")).toBeCloseTo(16 / 9, 10);
  });

  it("exposes exactly the three spec ratios", () => {
    expect([...ASPECT_RATIOS]).toEqual(["9:16", "1:1", "16:9"]);
  });

  it("parses valid ratios at the boundary", () => {
    for (const ar of ASPECT_RATIOS) {
      expect(parseAspectRatio(ar)).toBe(ar);
    }
  });

  it("rejects anything outside the union", () => {
    for (const bad of ["4:3", "916", "", "9:16 ", 1, null, undefined, {}]) {
      expect(() => parseAspectRatio(bad)).toThrow(/Invalid aspectRatio/);
    }
  });
});

describe("FakeDetector", () => {
  it("returns scripted boxes per frame index in call order", async () => {
    const detector = new FakeDetector({
      frames: [[box(0, 0, 0.2, 0.2)], [box(0.4, 0, 0.2, 0.2)], []],
    });

    expect(await detector.detect("frame-a.png")).toEqual([box(0, 0, 0.2, 0.2)]);
    expect(await detector.detect("frame-b.png")).toEqual([box(0.4, 0, 0.2, 0.2)]);
    expect(await detector.detect("frame-c.png")).toEqual([]);
  });

  it("ignores the frame path — index is driven by call order, not the filename", async () => {
    const detector = new FakeDetector({ frames: [[box(0.1, 0.1, 0.3, 0.3)]] });
    // A crafted path must not steer the fake anywhere; it is index 0 regardless.
    expect(await detector.detect("../../etc/passwd")).toEqual([box(0.1, 0.1, 0.3, 0.3)]);
  });

  it("returns copies so a caller mutating the result can't corrupt a replay", async () => {
    const detector = new FakeDetector({ frames: [[box(0.1, 0.1, 0.3, 0.3)]] });
    const first = await detector.detect("f.png");
    first[0].x = 0.99;
    detector.reset();
    const second = await detector.detect("f.png");
    expect(second[0].x).toBe(0.1);
  });

  it("defaults to empty (no subject) once the script is exhausted", async () => {
    const detector = new FakeDetector({ frames: [[box(0.1, 0.1, 0.3, 0.3)]] });
    await detector.detect("f0.png");
    expect(await detector.detect("f1.png")).toEqual([]);
    expect(await detector.detect("f2.png")).toEqual([]);
  });

  it("repeats the last frame when onExhausted is 'last'", async () => {
    const detector = new FakeDetector({
      frames: [[box(0, 0, 0.2, 0.2)], [box(0.5, 0, 0.2, 0.2)]],
      onExhausted: "last",
    });
    await detector.detect("f0.png");
    await detector.detect("f1.png");
    expect(await detector.detect("f2.png")).toEqual([box(0.5, 0, 0.2, 0.2)]);
    expect(await detector.detect("f3.png")).toEqual([box(0.5, 0, 0.2, 0.2)]);
  });

  it("'last' still yields empty when the script is empty", async () => {
    const detector = new FakeDetector({ frames: [], onExhausted: "last" });
    expect(await detector.detect("f0.png")).toEqual([]);
  });

  it("reset() rewinds so one instance can drive several deterministic passes", async () => {
    const detector = new FakeDetector({ frames: [[box(0, 0, 0.2, 0.2)], [box(0.5, 0, 0.2, 0.2)]] });
    const pass1 = [await detector.detect("a"), await detector.detect("b")];
    detector.reset();
    const pass2 = [await detector.detect("a"), await detector.detect("b")];
    expect(pass2).toEqual(pass1);
  });

  it("rejects a non-array frames option at construction", () => {
    // @ts-expect-error — exercising the runtime guard against a bad caller.
    expect(() => new FakeDetector({ frames: null })).toThrow(/frames/);
  });
});
