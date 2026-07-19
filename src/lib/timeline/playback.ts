/**
 * Edited-sequence preview playback logic (Phase 07). The editor previews the
 * edited timeline with a single `<video>` element and `timeupdate`-based seeking:
 * the player walks each segment's SOURCE range in playback order, jumping over
 * deleted ranges and reordered gaps. Because reordering makes segment source
 * ranges non-monotonic, the player tracks WHICH segment (by playback-order index)
 * it is currently in rather than inferring it from the source clock.
 *
 * These are the pure decision functions behind that player — the React component
 * owns the `<video>` and the current-segment ref but does no time arithmetic
 * itself (a hard Phase-07 constraint). `advancePlayback` is called on every
 * `timeupdate`/`ended`; `segmentIndexAt` re-seeds the current segment after a
 * seek or a structural edit.
 */

import { segmentStarts, totalDuration } from "./ops";
import { TIME_EPSILON, type TimelineDoc } from "./types";

/** Clip a value into `[lo, hi]` (returns `lo` if the range is inverted). */
function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * The playback-order segment index that edited-timeline time `timelineT` falls
 * in. Boundary times resolve to the LATER segment (the one that *starts* there),
 * so seeking to a cut point begins playing the following segment; a time at or
 * past the end resolves to the last segment. Used to seed the current-segment ref
 * after a seek or a structural edit.
 */
export function segmentIndexAt(doc: TimelineDoc, timelineT: number): number {
  let acc = 0;
  for (let i = 0; i < doc.segments.length; i++) {
    const seg = doc.segments[i];
    acc += seg.sourceOut - seg.sourceIn;
    if (timelineT < acc - TIME_EPSILON) return i;
  }
  return Math.max(0, doc.segments.length - 1);
}

/** One `timeupdate` decision for edited-sequence preview playback. */
export interface PlaybackStep {
  /** The segment index (playback order) that should be playing after this step. */
  segIndex: number;
  /** SOURCE time to seek the `<video>` to before continuing, or `null` to let it play on. */
  seekSource: number | null;
  /** Edited-timeline time the playhead should show. */
  timelineT: number;
  /** True once playback has run off the end of the last segment. */
  ended: boolean;
}

/**
 * Advance edited-sequence preview by one `timeupdate`. Given the segment index
 * currently playing (`segIndex`, playback order — the caller keeps it in a ref)
 * and the `<video>`'s current SOURCE time, decide whether to keep playing this
 * segment, jump to the next segment's source range (skipping the deleted or
 * reordered gap in between), or stop at the end of the sequence.
 *
 * While `sourceT` sits inside the current segment the player keeps rolling and
 * the playhead tracks it. Once `sourceT` reaches the segment's `sourceOut` the
 * step points at the next segment and asks the caller to seek to its `sourceIn`;
 * on the last segment it reports `ended`. `segIndex` is clamped, so a stale index
 * (e.g. after an edit shrank the timeline) still yields a valid step.
 */
export function advancePlayback(doc: TimelineDoc, segIndex: number, sourceT: number): PlaybackStep {
  const { segments } = doc;
  const starts = segmentStarts(doc);
  const i = clamp(Math.trunc(segIndex), 0, segments.length - 1);
  const seg = segments[i];

  // Still inside the current segment: keep playing, playhead follows the source
  // clock. Clamp the offset at 0 so a not-yet-caught-up seek can't go negative.
  if (sourceT < seg.sourceOut - TIME_EPSILON) {
    const within = Math.max(0, sourceT - seg.sourceIn);
    return { segIndex: i, seekSource: null, timelineT: starts[i] + within, ended: false };
  }

  // Reached the segment's out edge → hand off to the next segment in playback
  // order (its source range may be anywhere, so we seek to it explicitly).
  if (i + 1 < segments.length) {
    const next = segments[i + 1];
    return { segIndex: i + 1, seekSource: next.sourceIn, timelineT: starts[i + 1], ended: false };
  }

  // The last segment ran out: the edited sequence is over.
  return { segIndex: i, seekSource: null, timelineT: totalDuration(doc), ended: true };
}
