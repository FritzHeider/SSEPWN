import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { cropFilter } from "../src/lib/crop/filter";
import { planCrop } from "../src/lib/crop/plan";
import { probe, runFfmpeg } from "../src/lib/ffmpeg/exec";
import type { AspectRatio, Box, CropKeyframe, FrameSample } from "../src/lib/crop/types";

const SHORT_SAMPLE = "fixtures/short-sample.mp4";
const SRC_W = 1280;
const SRC_H = 720;

function kf(t: number, x: number, y: number, w = 405, h = 720): CropKeyframe {
  return { t, x, y, w, h };
}

describe("cropFilter — pure builder", () => {
  it("emits a crop+scale graph; a single keyframe gives constant, unescaped positions", () => {
    const f = cropFilter([kf(0, 100, 0)]);
    // Four colon-separated crop options, then a real (unescaped) comma to scale.
    expect(f).toBe("crop=405:720:100:0,scale=404:720");
    // A lone keyframe has nothing to interpolate — no conditional, no escaped comma.
    expect(f).not.toContain("if(");
    expect(f).not.toContain("\\,");
  });

  it("honours an explicit even output size (exact target AR)", () => {
    const f = cropFilter([kf(0, 100, 0)], { outputWidth: 180, outputHeight: 320 });
    expect(f.endsWith(",scale=180:320")).toBe(true);
  });

  it("carries the constant crop window size from the keyframes", () => {
    const f = cropFilter([kf(0, 0, 0, 720, 720), kf(2, 200, 0, 720, 720)]);
    expect(f.startsWith("crop=720:720:")).toBe(true);
  });

  it("interpolates piecewise-linearly with escaped commas and time guards", () => {
    const f = cropFilter([kf(0, 0, 0), kf(1, 100, 0), kf(2, 300, 0)]);
    // Commas inside the expression must be escaped so the filtergraph does not
    // split mid-if; the only bare comma is the crop→scale separator.
    const bareCommas = f.replace(/\\,/g, "").split(",").length - 1;
    expect(bareCommas).toBe(1);
    // Piecewise: a branch per segment boundary, plus the pre-first-keyframe guard.
    expect(f).toContain("lt(t\\,0)");
    expect(f).toContain("lt(t\\,1)");
    expect(f).toContain("lt(t\\,2)");
    // Linear blend of the first segment's endpoints appears verbatim.
    expect(f).toContain("0+(100-0)*(t-0)/(1-0)");
  });

  it("collapses non-advancing timestamps to avoid a divide-by-zero segment", () => {
    // Two keyframes sharing t=1 would make (Tb-Ta)=0; the later one wins.
    const f = cropFilter([kf(0, 0, 0), kf(1, 100, 0), kf(1, 150, 0), kf(2, 300, 0)]);
    expect(f).not.toContain("/(1-1)");
    // The surviving value at t=1 is the later one (150), used as the next segment start.
    expect(f).toContain("150+(300-150)");
  });

  it("throws on an empty plan", () => {
    expect(() => cropFilter([])).toThrow(/at least one keyframe/);
  });
});

// One real ffmpeg run proves the built graph actually parses and produces a
// video with the target aspect ratio's dimensions (phase-06 acceptance).
describe("cropFilter — real ffmpeg integration", () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "sseclone-crop-"));

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function box(cx: number): Box {
    return { x: cx - 0.1, y: 0.4, w: 0.2, h: 0.2, confidence: 1 };
  }

  // A subject drifting left→right so the crop x expression is genuinely non-trivial.
  const frames: FrameSample[] = [0, 1, 2, 3, 4].map((t, i) => ({
    t,
    boxes: [box(0.25 + i * 0.1)],
  }));

  const targets: Array<{ ar: AspectRatio; w: number; h: number }> = [
    { ar: "9:16", w: 180, h: 320 },
    { ar: "1:1", w: 240, h: 240 },
    { ar: "16:9", w: 320, h: 180 },
  ];

  it("fixture exists (run `npm run fixtures` first)", () => {
    expect(existsSync(SHORT_SAMPLE), `${SHORT_SAMPLE} missing`).toBe(true);
  });

  for (const { ar, w, h } of targets) {
    it(`renders ${ar} → ${w}×${h} through real ffmpeg`, async () => {
      const keyframes = planCrop(frames, SRC_W, SRC_H, ar);
      const filter = cropFilter(keyframes, { outputWidth: w, outputHeight: h });
      const out = path.join(workDir, `crop-${ar.replace(":", "x")}.mp4`);

      await runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        SHORT_SAMPLE,
        "-vf",
        filter,
        "-frames:v",
        "3",
        "-an",
        "-pix_fmt",
        "yuv420p",
        "-y",
        out,
      ]);

      const probed = await probe(out);
      expect(probed.width).toBe(w);
      expect(probed.height).toBe(h);
    });
  }
});
