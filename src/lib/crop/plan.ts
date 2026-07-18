import {
  aspectRatioValue,
  type AspectRatio,
  type Box,
  type CropKeyframe,
  type FrameSample,
} from "./types";

/**
 * Pure smart-crop planner (phase-06 / SPEC.md § Smart crop). Turns a time-ordered
 * run of per-frame subject detections into a sparse list of crop-window keyframes
 * that `cropFilter` interpolates for ffmpeg. No ffmpeg, no TF.js, no DB — every
 * behaviour below is exercised by `tests/crop-plan.test.ts` with `FakeDetector`
 * data and hand-written numbers, which is why `Box` coordinates are normalised
 * and the output is plain pixels.
 *
 * The three behaviours the spec calls out, and how they show up here:
 *  - the window has EXACTLY the target aspect ratio and is the largest such
 *    rectangle that fits the source (`cropSize`); it only pans, never resizes;
 *  - it centres on the highest-confidence subject, and falls back to the frame
 *    centre when a frame has no subject (`desiredTopLeft`);
 *  - it holds still while the subject stays inside a dead-zone, and when it does
 *    move the pan speed between emitted keyframes never exceeds a cap — so a big
 *    relocation is eased across several keyframes instead of snapping (the loop
 *    in `planCrop`). "No jitter" falls out of the dead-zone; "eased over ≥0.5 s"
 *    falls out of the speed cap making a full-width pan take proportionally long.
 */

export interface PlanCropOptions {
  /**
   * Half-width of the dead-zone as a fraction of the crop dimension: the window
   * only re-centres once the desired position drifts more than this from where
   * the window sits. Larger = steadier (absorbs more subject wobble), smaller =
   * twitchier. Default 0.15 comfortably swallows a ±2 % jitter.
   */
  deadZoneRatio?: number;
  /**
   * Maximum pan speed as a fraction of the source dimension per second. The
   * per-keyframe step is capped at `maxPanRatio * srcDim * dt`, so the speed
   * between any two emitted keyframes is ≤ `maxPanRatio * srcDim` px/s. Default
   * 0.5 keeps even a full-frame relocation from snapping in a single step.
   */
  maxPanRatio?: number;
}

export const DEFAULT_DEAD_ZONE_RATIO = 0.15;
export const DEFAULT_MAX_PAN_RATIO = 0.5;

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/**
 * Largest rectangle with exactly `arValue` (= width ÷ height) that fits inside a
 * `srcW × srcH` frame. If the target is narrower than the source it is
 * height-limited (full source height, narrower width); otherwise width-limited.
 * Rounded to whole pixels — the ≤0.5 px rounding keeps the realised ratio within
 * the spec's 1 px tolerance while giving ffmpeg integer crop dimensions.
 */
function cropSize(srcW: number, srcH: number, arValue: number): { w: number; h: number } {
  const srcAR = srcW / srcH;
  let w: number;
  let h: number;
  if (arValue <= srcAR) {
    h = srcH;
    w = srcH * arValue;
  } else {
    w = srcW;
    h = srcW / arValue;
  }
  return { w: Math.round(w), h: Math.round(h) };
}

function highestConfidenceBox(boxes: Box[]): Box | null {
  let best: Box | null = null;
  for (const b of boxes) {
    if (best === null || b.confidence > best.confidence) {
      best = b;
    }
  }
  return best;
}

/**
 * Where the crop window's top-left "wants" to be for one frame: centred on the
 * highest-confidence subject, or on the frame centre when there is none
 * (center-weighted fallback). Clamped so the window never leaves the source.
 */
function desiredTopLeft(
  sample: FrameSample,
  srcW: number,
  srcH: number,
  cropW: number,
  cropH: number,
  maxX: number,
  maxY: number,
): { x: number; y: number } {
  const box = highestConfidenceBox(sample.boxes);
  let cx: number;
  let cy: number;
  if (box) {
    cx = (box.x + box.w / 2) * srcW;
    cy = (box.y + box.h / 2) * srcH;
  } else {
    cx = srcW / 2;
    cy = srcH / 2;
  }
  return {
    x: clamp(cx - cropW / 2, 0, maxX),
    y: clamp(cy - cropH / 2, 0, maxY),
  };
}

/**
 * Plan the reframe of a `srcW × srcH` source to `targetAR` given time-ordered
 * subject detections. Returns at least one keyframe (the first frame's position,
 * or a centred window when there are no frames). Subsequent keyframes are emitted
 * only when the window actually pans, so a still subject yields a single
 * stationary keyframe.
 */
export function planCrop(
  frames: FrameSample[],
  srcW: number,
  srcH: number,
  targetAR: AspectRatio,
  options: PlanCropOptions = {},
): CropKeyframe[] {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) {
    throw new Error(
      `planCrop needs positive finite source dimensions, got ${srcW}×${srcH}`,
    );
  }

  const arValue = aspectRatioValue(targetAR);
  const { w: cropW, h: cropH } = cropSize(srcW, srcH, arValue);
  const maxX = Math.max(srcW - cropW, 0);
  const maxY = Math.max(srcH - cropH, 0);

  if (frames.length === 0) {
    return [
      {
        t: 0,
        x: Math.round(clamp((srcW - cropW) / 2, 0, maxX)),
        y: Math.round(clamp((srcH - cropH) / 2, 0, maxY)),
        w: cropW,
        h: cropH,
      },
    ];
  }

  const deadZoneRatio = options.deadZoneRatio ?? DEFAULT_DEAD_ZONE_RATIO;
  const maxPanRatio = options.maxPanRatio ?? DEFAULT_MAX_PAN_RATIO;
  const dzX = deadZoneRatio * cropW;
  const dzY = deadZoneRatio * cropH;
  const maxSpeedX = maxPanRatio * srcW;
  const maxSpeedY = maxPanRatio * srcH;

  const first = desiredTopLeft(frames[0], srcW, srcH, cropW, cropH, maxX, maxY);
  let curX = Math.round(first.x);
  let curY = Math.round(first.y);
  let lastT = frames[0].t;
  const keyframes: CropKeyframe[] = [{ t: lastT, x: curX, y: curY, w: cropW, h: cropH }];

  for (let i = 1; i < frames.length; i++) {
    const f = frames[i];
    const des = desiredTopLeft(f, srcW, srcH, cropW, cropH, maxX, maxY);
    const dx = des.x - curX;
    const dy = des.y - curY;
    // Dead-zone: ignore drift smaller than the zone — this is what turns subject
    // jitter into a single stationary keyframe.
    const wantX = Math.abs(dx) > dzX;
    const wantY = Math.abs(dy) > dzY;
    if (!wantX && !wantY) continue;

    // Speed cap relative to the last EMITTED keyframe, so the pan speed between
    // any two output keyframes stays ≤ maxSpeed regardless of how many frames
    // were absorbed by the dead-zone in between.
    const dt = Math.max(f.t - lastT, 0);
    const capX = maxSpeedX * dt;
    const capY = maxSpeedY * dt;
    const nx = wantX ? Math.round(clamp(curX + clamp(dx, -capX, capX), 0, maxX)) : curX;
    const ny = wantY ? Math.round(clamp(curY + clamp(dy, -capY, capY), 0, maxY)) : curY;
    if (nx === curX && ny === curY) continue;

    curX = nx;
    curY = ny;
    lastT = f.t;
    keyframes.push({ t: f.t, x: curX, y: curY, w: cropW, h: cropH });
  }

  return keyframes;
}
