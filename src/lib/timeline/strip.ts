/**
 * Pixel layout, zoom, and snapping math for the timeline strip UI (Phase 07).
 * The React strip renders segment boxes, a playhead, and a ruler, and reacts to
 * pointer drags — none of which it is allowed to compute itself: "components
 * contain no time arithmetic" is a hard Phase-07 constraint. Every conversion
 * between edited-timeline seconds and horizontal pixels, every zoom step, and the
 * snap rule live here as pure functions so they can be unit-tested and the
 * component stays a thin wiring layer.
 *
 * Horizontal position is a linear function of edited-timeline time: `x =
 * timelineT * pxPerSec`. `pxPerSec` (pixels per second) is the single zoom knob;
 * bigger means a longer, more detailed strip.
 */

import { segmentStarts, totalDuration } from "./ops";
import type { TimelineDoc } from "./types";

/** Most zoomed-out density (px per second) — a long clip still fits on screen. */
export const MIN_PX_PER_SEC = 8;
/** Most zoomed-in density (px per second) — frame-level trimming precision. */
export const MAX_PX_PER_SEC = 400;
/** Starting zoom density when the editor first opens. */
export const DEFAULT_PX_PER_SEC = 60;
/** Multiplicative step for one zoom-in; zoom-out divides by the same factor. */
export const ZOOM_FACTOR = 1.5;
/**
 * How close (in pixels) a dragged edge/playhead must come to a snap target
 * before it locks onto it. Converted to seconds by the caller via the current
 * `pxPerSec` so the feel is constant regardless of zoom.
 */
export const SNAP_THRESHOLD_PX = 8;

/** Clamp a zoom density into `[MIN_PX_PER_SEC, MAX_PX_PER_SEC]`. */
export function clampPxPerSec(pxPerSec: number): number {
  if (!Number.isFinite(pxPerSec)) return DEFAULT_PX_PER_SEC;
  return Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, pxPerSec));
}

/**
 * One zoom step from `pxPerSec`: `direction >= 0` zooms in (denser), otherwise
 * out. The result is clamped, so repeatedly zooming saturates at the limits
 * rather than overshooting.
 */
export function zoomBy(pxPerSec: number, direction: number): number {
  const factor = direction >= 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
  return clampPxPerSec(pxPerSec * factor);
}

/**
 * A segment's on-strip geometry: its edited-timeline placement (start/duration)
 * plus the pixel box the component renders. `sourceIn`/`sourceOut` are carried
 * through so a trim handler can address the segment without re-deriving them.
 */
export interface SegmentBox {
  id: string;
  sourceIn: number;
  sourceOut: number;
  /** Edited-timeline start (seconds), from the running sum of prior segments. */
  timelineStart: number;
  /** Edited-playback length (seconds). */
  duration: number;
  /** Left offset in pixels at the current zoom. */
  leftPx: number;
  /** Width in pixels at the current zoom. */
  widthPx: number;
}

/**
 * Lay every segment out along the strip in playback order at the given zoom. The
 * boxes tile without gaps (each starts where the previous ends), so the strip is
 * a faithful picture of the edited sequence.
 */
export function segmentLayout(doc: TimelineDoc, pxPerSec: number): SegmentBox[] {
  const starts = segmentStarts(doc);
  return doc.segments.map((seg, i) => {
    const duration = seg.sourceOut - seg.sourceIn;
    const timelineStart = starts[i];
    return {
      id: seg.id,
      sourceIn: seg.sourceIn,
      sourceOut: seg.sourceOut,
      timelineStart,
      duration,
      leftPx: timelineStart * pxPerSec,
      widthPx: duration * pxPerSec,
    };
  });
}

/** Edited-timeline seconds → horizontal pixels at the current zoom. */
export function timeToX(timelineT: number, pxPerSec: number): number {
  return timelineT * pxPerSec;
}

/**
 * Horizontal pixels → edited-timeline seconds, clamped to `[0, total]` so a
 * click or drag past either end resolves to a valid time (never negative, never
 * past the sequence). `total` is normally {@link totalDuration}.
 */
export function xToTime(x: number, pxPerSec: number, total: number): number {
  if (pxPerSec <= 0) return 0;
  return Math.max(0, Math.min(total, x / pxPerSec));
}

/**
 * Snap `value` to the nearest target within `thresholdSec`, else return it
 * unchanged. Ties go to the first-listed target. Used for both the playhead
 * (timeline-space targets) and trim edges (source-space targets) — the helper is
 * space-agnostic; the caller supplies targets in whatever space it is working.
 */
export function snapValue(value: number, targets: readonly number[], thresholdSec: number): number {
  let best = value;
  let bestDist = thresholdSec;
  for (const target of targets) {
    const dist = Math.abs(target - value);
    if (dist < bestDist) {
      bestDist = dist;
      best = target;
    }
  }
  return best;
}

/**
 * Every segment boundary in edited-timeline seconds: each segment's start plus
 * the sequence end. These are the "segment edges" the spec snaps the playhead and
 * split point to; the component unions them with caption-cue boundaries.
 */
export function timelineCutTimes(doc: TimelineDoc): number[] {
  return [...segmentStarts(doc), totalDuration(doc)];
}

/**
 * The playback-order index a segment dropped at pixel `x` should occupy: the
 * first box whose horizontal midpoint lies right of `x`, or the end of the list
 * when `x` is past every midpoint. Feeds {@link reorder}, which clamps the index
 * into range, so a drop past the end lands the segment last.
 */
export function dropIndexAt(doc: TimelineDoc, pxPerSec: number, x: number): number {
  const boxes = segmentLayout(doc, pxPerSec);
  for (let i = 0; i < boxes.length; i++) {
    const midpoint = boxes[i].leftPx + boxes[i].widthPx / 2;
    if (x < midpoint) return i;
  }
  return boxes.length;
}
