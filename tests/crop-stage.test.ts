import { describe, expect, it } from "vitest";

import { centerCropTransform, cropStageTransform, fitStage } from "../src/lib/crop/stage";

describe("fitStage", () => {
  it("height-limits when the container is wider than the target", () => {
    // 16:9 container (1600x900), 9:16 target (0.5625) → tall box limited by height.
    expect(fitStage(1600, 900, 9 / 16)).toEqual({ width: 900 * (9 / 16), height: 900 });
  });

  it("width-limits when the container is narrower than the target", () => {
    // 400x900 container, 16:9 target → wide box limited by width.
    expect(fitStage(400, 900, 16 / 9)).toEqual({ width: 400, height: 400 / (16 / 9) });
  });

  it("returns a zero box for non-positive inputs", () => {
    expect(fitStage(0, 900, 1)).toEqual({ width: 0, height: 0 });
    expect(fitStage(400, 0, 1)).toEqual({ width: 0, height: 0 });
    expect(fitStage(400, 900, 0)).toEqual({ width: 0, height: 0 });
  });
});

describe("cropStageTransform", () => {
  it("scales the video so the crop window fills the stage", () => {
    // Source 1000x1000, crop window is the left half-width, full height, placed at
    // (0,0): a 500x1000 window. Onto a 500x1000 stage the video doubles? no — the
    // window is already 500 wide; scale = stageW / nw = 500 / 0.5 = 1000 wide video.
    const t = cropStageTransform({ x: 0, y: 0, w: 500, h: 1000 }, 1000, 1000, 500, 1000);
    expect(t).not.toBeNull();
    expect(t!.width).toBeCloseTo(1000, 6);
    expect(t!.height).toBeCloseTo(1000, 6);
    expect(t!.left).toBeCloseTo(0, 6);
    expect(t!.top).toBeCloseTo(0, 6);
  });

  it("offsets the video so an inset crop window aligns to the stage origin", () => {
    // Crop window is the centre quarter of a 1000x1000 source.
    const t = cropStageTransform({ x: 250, y: 250, w: 500, h: 500 }, 1000, 1000, 500, 500);
    expect(t).not.toBeNull();
    // nw = nh = 0.5 → video scaled to 2x the stage (1000x1000).
    expect(t!.width).toBeCloseTo(1000, 6);
    expect(t!.height).toBeCloseTo(1000, 6);
    // nx = ny = 0.25 → shift the video up-left by a quarter of its scaled size.
    expect(t!.left).toBeCloseTo(-250, 6);
    expect(t!.top).toBeCloseTo(-250, 6);
  });

  it("returns null for non-positive dimensions", () => {
    expect(cropStageTransform({ x: 0, y: 0, w: 0, h: 10 }, 100, 100, 50, 50)).toBeNull();
    expect(cropStageTransform({ x: 0, y: 0, w: 10, h: 10 }, 0, 100, 50, 50)).toBeNull();
    expect(cropStageTransform({ x: 0, y: 0, w: 10, h: 10 }, 100, 100, 0, 50)).toBeNull();
  });
});

describe("centerCropTransform", () => {
  it("covers a portrait stage from a landscape source, centring horizontally", () => {
    // 1920x1080 source (aspect 1.78) into a 405x720 (9:16) stage.
    const t = centerCropTransform(1920, 1080, 405, 720);
    expect(t).not.toBeNull();
    expect(t!.height).toBeCloseTo(720, 6);
    expect(t!.width).toBeCloseTo(720 * (1920 / 1080), 6);
    expect(t!.left).toBeCloseTo((405 - 720 * (1920 / 1080)) / 2, 6);
    expect(t!.top).toBeCloseTo(0, 6);
  });

  it("covers a landscape stage from a portrait source, centring vertically", () => {
    const t = centerCropTransform(1080, 1920, 1600, 900);
    expect(t).not.toBeNull();
    expect(t!.width).toBeCloseTo(1600, 6);
    expect(t!.height).toBeCloseTo(1600 / (1080 / 1920), 6);
    expect(t!.left).toBeCloseTo(0, 6);
    expect(t!.top).toBeCloseTo((900 - 1600 / (1080 / 1920)) / 2, 6);
  });

  it("returns null for non-positive dimensions", () => {
    expect(centerCropTransform(0, 100, 50, 50)).toBeNull();
  });
});
