/**
 * Pure presentation logic for the Phase-08 B-roll preview overlay and editor.
 *
 * React- and Node-free by design (DEC-005): the thin `<BrollPreview>` /
 * `<BrollPanel>` components only wire these decisions to the DOM and the pure
 * ops in {@link ./broll}. Everything that is arithmetic — which slots cover the
 * playhead, where a pip box sits in the frame, how far into the B-roll asset the
 * playhead has travelled, and the URL that serves the asset's bytes — lives here
 * where it is unit-tested apart from the JSX.
 */

import type { BrollPip, BrollSlot } from "./broll";
import { listBroll } from "./broll";
import type { TimelineDoc } from "./types";

/** The route that streams an asset's raw file (Range-capable), for a preview
 * `<video>`. Ids come from B-roll slots (DB rows), never from user text. */
export function assetFileUrl(assetId: number): string {
  return `/api/assets/${assetId}/file`;
}

/**
 * B-roll slots covering timeline second `t`, in track order. A slot is active on
 * the half-open range `[start, end)` so the moment a slot ends is already the
 * next frame's state and two abutting slots never both render on the seam.
 */
export function activeBrollAt(doc: TimelineDoc, t: number): BrollSlot[] {
  return listBroll(doc).filter((slot) => t >= slot.start && t < slot.end);
}

/** A pip box as CSS percentages of the frame, derived from the slot's
 * normalised `[0, 1]` geometry (already clamped in-frame by `clampPip`). */
export interface PipBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Map a normalised pip placement to percentage box metrics for `style`. */
export function pipBoxPercent(pip: BrollPip): PipBox {
  return {
    left: pip.x * 100,
    top: pip.y * 100,
    width: pip.scale * 100,
    height: pip.scale * 100,
  };
}

/**
 * How far into the B-roll asset the preview should be seeked when the timeline
 * playhead sits at `t`: the offset from the slot's start, never negative. The
 * asset plays from its own zero at the slot's start (SPEC: B-roll length is the
 * asset's own duration; no in-point trimming in this phase).
 */
export function brollLocalTime(slot: Pick<BrollSlot, "start">, t: number): number {
  return Math.max(0, t - slot.start);
}
