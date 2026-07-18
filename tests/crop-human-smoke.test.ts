import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HumanFaceDetector } from "../src/lib/crop/human";
import { sampleFrames } from "../src/lib/ffmpeg/frames";
import type { Box } from "../src/lib/crop/types";

/**
 * The only test that runs the REAL `HumanFaceDetector` (phase-06: "one optional
 * smoke test behind CROP_SMOKE=1"). Everything about the crop pipeline is covered
 * without TF.js by the default suite via `FakeDetector` (crop-plan, crop-filter,
 * smart-crop-handler, crop-api); what only a real run can prove is that the
 * package loads, the models decode, and Human's face output maps into the
 * app's normalised `Box` shape.
 *
 * Opt-in rather than auto-detected — the same reasoning as the whisper smoke
 * test: probing for the backend and silently skipping would make "the detector
 * regressed" and "the detector is absent" look identical. Enable with the
 * package, the tfjs-node backend, and the models installed (README § Smart crop):
 *
 *   CROP_SMOKE=1 npm test   # plus HUMAN_MODELS_PATH if not the default
 */

const SHORT_SAMPLE = "fixtures/short-sample.mp4";
const enabled = process.env.CROP_SMOKE === "1";

describe.skipIf(!enabled)("HumanFaceDetector against the real backend", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sseclone-crop-smoke-"));
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("detects on a sampled frame and returns well-formed normalised boxes", async () => {
    const frames = await sampleFrames(SHORT_SAMPLE, 1, dir);
    expect(frames.length).toBeGreaterThan(0);

    const detector = new HumanFaceDetector();
    const boxes: Box[] = await detector.detect(frames[0].path);

    // Deliberately NOT asserting any faces are found: scripts/make-fixtures.sh
    // builds short-sample.mp4 from ffmpeg's `testsrc2` pattern — there are no
    // faces in it, so an empty result is legitimate and pinning a count would
    // assert a hallucination. What is smoke-tested is the CONTRACT: the backend
    // ran and whatever it returned is well-formed for planCrop.
    expect(Array.isArray(boxes)).toBe(true);
    for (const box of boxes) {
      for (const field of ["x", "y", "w", "h", "confidence"] as const) {
        expect(typeof box[field]).toBe("number");
        expect(box[field]).toBeGreaterThanOrEqual(0);
        expect(box[field]).toBeLessThanOrEqual(1);
      }
      expect(box.w).toBeGreaterThan(0);
      expect(box.h).toBeGreaterThan(0);
      // The box stays inside the frame — planCrop clamps, but a detector that
      // handed back x + w > 1 would mean the normalisation is wrong.
      expect(box.x + box.w).toBeLessThanOrEqual(1 + 1e-6);
      expect(box.y + box.h).toBeLessThanOrEqual(1 + 1e-6);
    }
  }, 120_000);
});
