import { cropSize } from "./plan";
import { aspectRatioValue, type AspectRatio, type CropKeyframe } from "./types";

/**
 * Pure geometry for the crop editor overlay (phase-06 UI). The editor draws the
 * crop window as a rectangle over the source-video preview and lets the user drag
 * it to write a manual keyframe. All the maths that has to agree with `planCrop`
 * and `cropFilter` — how a window is sized for an aspect ratio, where it sits at a
 * given time, how it maps onto the normalised preview box — lives here so it is
 * unit-tested without React, ffmpeg, or a DOM (`tests/crop-overlay.test.ts`),
 * exactly as `captions/preview.ts` factors the caption overlay's maths out of its
 * component.
 *
 * Two coordinate spaces appear below:
 *  - SOURCE PIXELS: the space `CropKeyframe`/`CropState` live in (`0..srcW`, etc.).
 *  - NORMALISED: fractions `0..1` of the displayed frame, which is all CSS needs
 *    to place the rectangle regardless of how big the `<video>` renders.
 */

/** A crop window in source pixels — the shape stored in a `CropKeyframe`. */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A crop window as fractions of the displayed frame, for CSS positioning. */
export interface NormalisedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/**
 * The crop-window size (source pixels) for an aspect ratio against a source —
 * the largest AR-exact rectangle that fits, identical to what `planCrop` uses so
 * a freshly-dragged window matches an auto-planned one. Delegates to the same
 * `cropSize` the planner uses; kept here as an AR-typed convenience for the UI.
 */
export function cropWindowSize(ar: AspectRatio, srcW: number, srcH: number): { w: number; h: number } {
  return cropSize(srcW, srcH, aspectRatioValue(ar));
}

/**
 * The default crop window for an aspect ratio: the AR-exact window centred in the
 * source. Shown as the overlay's starting position for a clip that has no crop for
 * the chosen ratio yet, before the user drags or runs auto.
 */
export function centeredWindow(ar: AspectRatio, srcW: number, srcH: number): PixelRect {
  const { w, h } = cropWindowSize(ar, srcW, srcH);
  return { x: Math.round((srcW - w) / 2), y: Math.round((srcH - h) / 2), w, h };
}

/**
 * The crop window at clip-relative time `t`, interpolated piecewise-linearly
 * between keyframes — the overlay's counterpart to what `cropFilter` hands ffmpeg.
 * Holds the first keyframe before its time and the last after its time (no
 * extrapolation), matching `cropFilter`'s outer guards, so the rectangle never
 * flies off-frame at the clip's edges. Returns `null` for an empty plan.
 *
 * Assumes `keyframes` is ascending by `t` (how `CropState` stores them). A zero or
 * negative time span between two keyframes collapses to the earlier one rather
 * than dividing by zero.
 */
export function cropWindowAt(keyframes: CropKeyframe[], t: number): PixelRect | null {
  if (keyframes.length === 0) return null;
  const first = keyframes[0];
  if (t <= first.t) return { x: first.x, y: first.y, w: first.w, h: first.h };
  const last = keyframes[keyframes.length - 1];
  if (t >= last.t) return { x: last.x, y: last.y, w: last.w, h: last.h };

  for (let i = 1; i < keyframes.length; i++) {
    const b = keyframes[i];
    if (t <= b.t) {
      const a = keyframes[i - 1];
      const span = b.t - a.t;
      const f = span <= 0 ? 0 : (t - a.t) / span;
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        w: a.w + (b.w - a.w) * f,
        h: a.h + (b.h - a.h) * f,
      };
    }
  }
  // Unreachable: t < last.t was handled by the loop; kept total for the checker.
  return { x: last.x, y: last.y, w: last.w, h: last.h };
}

/**
 * Turn a source-pixel window into normalised fractions of the frame for CSS. A
 * non-positive source dimension (project not ingested yet) yields a zero rect
 * rather than `NaN`/`Infinity`, so the overlay simply doesn't render instead of
 * blowing up.
 */
export function normaliseRect(rect: PixelRect, srcW: number, srcH: number): NormalisedRect {
  if (srcW <= 0 || srcH <= 0) return { left: 0, top: 0, width: 0, height: 0 };
  return {
    left: rect.x / srcW,
    top: rect.y / srcH,
    width: rect.w / srcW,
    height: rect.h / srcH,
  };
}

/**
 * Clamp a proposed window top-left so the whole `w × h` window stays inside the
 * source — the drag constraint. The overlay drags by pointer delta, then calls
 * this so a window can slide to the frame edge but never past it. When the window
 * is as large as the source on an axis (`w === srcW`), that axis pins to 0.
 */
export function clampWindow(
  x: number,
  y: number,
  w: number,
  h: number,
  srcW: number,
  srcH: number,
): { x: number; y: number } {
  return {
    x: clamp(x, 0, Math.max(0, srcW - w)),
    y: clamp(y, 0, Math.max(0, srcH - h)),
  };
}
