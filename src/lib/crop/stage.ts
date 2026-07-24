/**
 * Pure geometry for the target-aspect ("Export") preview stage (item 8). The
 * editor can preview a clip two ways: SOURCE (the raw video, letterboxed to the
 * source aspect) or EXPORT (a stage sized to the effective platform preset's
 * aspect that shows only the active crop window). This module holds the maths for
 * the second mode so it is unit-testable without React or a DOM, exactly as
 * `crop/overlay.ts` factors the crop-rectangle maths out of its component.
 *
 * The technique: wrap the single `<video>` in an `overflow-hidden` stage sized to
 * the target aspect, then position the video absolutely and scale it so the crop
 * window fills the stage. Because the crop window carries the target aspect ratio
 * (see {@link CropKeyframe}), the horizontal and vertical scale agree, so the
 * frame is never distorted — only enlarged and offset.
 */

import type { PixelRect } from "./overlay";

/** Where and how big the video element sits inside the stage, in stage pixels. */
export interface StageTransform {
  /** Video display width in px (larger than the stage: the crop window is a slice). */
  width: number;
  /** Video display height in px. */
  height: number;
  /** Left offset in px (negative: the crop window's left edge sits at stage x=0). */
  left: number;
  /** Top offset in px. */
  top: number;
}

/** A stage box (px) fitted inside a container at a target aspect ratio. */
export interface StageSize {
  width: number;
  height: number;
}

function positive(...values: number[]): boolean {
  return values.every((v) => Number.isFinite(v) && v > 0);
}

/**
 * The largest `targetAspect`-shaped box (width ÷ height) that fits inside a
 * `containerW × containerH` area — the letterboxed stage the Export preview draws
 * the video into. Returns a zero box when any input is non-positive so a
 * not-yet-measured container simply renders nothing rather than `NaN`.
 */
export function fitStage(containerW: number, containerH: number, targetAspect: number): StageSize {
  if (!positive(containerW, containerH, targetAspect)) return { width: 0, height: 0 };
  const containerAspect = containerW / containerH;
  if (containerAspect > targetAspect) {
    // Container is wider than the target → height-limited.
    return { width: containerH * targetAspect, height: containerH };
  }
  // Container is narrower (or equal) → width-limited.
  return { width: containerW, height: containerW / targetAspect };
}

/**
 * Position + size (stage px) for the video so the crop window `rect` (source
 * pixels) exactly fills a `stageW × stageH` stage. Scaling the video to
 * `stageW / (rect.w / srcW)` makes the crop window's width equal the stage width;
 * the equal vertical scale follows because the crop window already carries the
 * stage's aspect ratio. Returns `null` when any dimension is non-positive.
 */
export function cropStageTransform(
  rect: PixelRect,
  srcW: number,
  srcH: number,
  stageW: number,
  stageH: number,
): StageTransform | null {
  if (!positive(srcW, srcH, stageW, stageH, rect.w, rect.h)) return null;
  const nx = rect.x / srcW;
  const ny = rect.y / srcH;
  const nw = rect.w / srcW;
  const nh = rect.h / srcH;
  if (nw <= 0 || nh <= 0) return null;
  const width = stageW / nw;
  const height = stageH / nh;
  return { width, height, left: -nx * width, top: -ny * height };
}

/**
 * Position + size (stage px) for a centre-crop of the source onto the stage when
 * the clip has no crop plan — the video is scaled to COVER the stage and centred,
 * so the middle of the frame shows at the target aspect. Returns `null` when any
 * dimension is non-positive.
 */
export function centerCropTransform(
  srcW: number,
  srcH: number,
  stageW: number,
  stageH: number,
): StageTransform | null {
  if (!positive(srcW, srcH, stageW, stageH)) return null;
  const sourceAspect = srcW / srcH;
  const stageAspect = stageW / stageH;
  if (sourceAspect > stageAspect) {
    // Source is wider than the stage → match height, overflow width, centre X.
    const height = stageH;
    const width = stageH * sourceAspect;
    return { width, height, left: (stageW - width) / 2, top: 0 };
  }
  // Source is taller/narrower → match width, overflow height, centre Y.
  const width = stageW;
  const height = stageW / sourceAspect;
  return { width, height, left: 0, top: (stageH - height) / 2 };
}
