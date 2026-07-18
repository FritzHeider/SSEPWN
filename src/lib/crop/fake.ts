import type { Box, SubjectDetector } from "./types";

/**
 * What a `FakeDetector` should return once its script runs out — i.e. `detect`
 * is called more times than there are scripted frames.
 *
 *  - `"empty"` (default): `[]`, "no subject in this frame". A legitimate outcome
 *    the crop planner handles with its center-weighted fallback, and the honest
 *    answer for a script that only covers the frames the test cares about.
 *  - `"last"`: repeat the final frame's boxes forever. Handy when a test wants a
 *    subject to hold still past the end of an explicit motion script.
 */
export type ExhaustedBehavior = "empty" | "last";

export interface FakeDetectorOptions {
  /**
   * Boxes to return for each sampled frame, in frame order: the first `detect`
   * call gets `frames[0]`, the second `frames[1]`, and so on.
   */
  frames: Box[][];
  /** Behaviour once the script is exhausted. Defaults to `"empty"`. */
  onExhausted?: ExhaustedBehavior;
}

function cloneBox(box: Box): Box {
  return { x: box.x, y: box.y, w: box.w, h: box.h, confidence: box.confidence };
}

/**
 * `SubjectDetector` that replays a fixed script instead of running a real face
 * detector (SPEC.md § Tech stack / phase-06: the default suite must pass with no
 * TF.js models present). Selected wherever the smart-crop pipeline is exercised
 * under test.
 *
 * Boxes are addressed by FRAME INDEX in call order, not by the frame's filename:
 * the smart-crop job samples frames sequentially and calls `detect` once per
 * frame in that order, so the i-th call maps to `frames[i]`. The frame path is
 * ignored — a fake has no image to read — which also means a crafted path can't
 * steer it anywhere.
 *
 * Every call returns a fresh copy of its scripted boxes, so a caller that mutates
 * the result (clamping, re-basing) can't corrupt a later replay. `reset()`
 * rewinds the cursor so one instance can drive several passes (e.g. the same
 * clip re-cropped to a second aspect ratio) and stay deterministic.
 */
export class FakeDetector implements SubjectDetector {
  private readonly frames: Box[][];
  private readonly onExhausted: ExhaustedBehavior;
  private index = 0;

  constructor(options: FakeDetectorOptions) {
    if (!Array.isArray(options.frames)) {
      throw new Error("FakeDetector requires a `frames` array of scripted boxes per frame");
    }
    this.frames = options.frames;
    this.onExhausted = options.onExhausted ?? "empty";
  }

  /** Rewind to the first scripted frame. */
  reset(): void {
    this.index = 0;
  }

  async detect(_framePngPath: string): Promise<Box[]> {
    const i = this.index++;
    if (i < this.frames.length) {
      return this.frames[i].map(cloneBox);
    }
    if (this.onExhausted === "last" && this.frames.length > 0) {
      return this.frames[this.frames.length - 1].map(cloneBox);
    }
    return [];
  }
}
