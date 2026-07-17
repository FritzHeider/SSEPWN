/**
 * Pure presentation logic for the transcript panel (DEC-005).
 *
 * React-free and Node-free, like projects/view.ts: the decisions live here where
 * node-env vitest can test them honestly, and the JSX that consumes them stays
 * thin enough to read at a glance.
 */

import { formatDuration } from "@/lib/projects/view";
import type { TranscriptSegment } from "@/lib/transcribe/types";

/** No segment is being spoken at this time — a gap, or before speech starts. */
export const NO_ACTIVE_SEGMENT = -1;

/**
 * `m:ss` (or `h:mm:ss` past an hour) for a segment's start time.
 *
 * Delegates to the list's formatter rather than growing a second one: two mm:ss
 * implementations drift, and that one already handles both the hour rollover
 * (a 2 h podcast is a real input even though the 90 s fixture never reaches it)
 * and the negative/non-finite guards.
 */
export function formatTimestamp(seconds: number): string {
  return formatDuration(seconds);
}

/**
 * Index of the segment being spoken at `currentTime`, or `NO_ACTIVE_SEGMENT`.
 *
 * The interval is half-open, `[start, end)`: sentences abut, so an inclusive end
 * would match two segments at every boundary and silently return whichever came
 * first. A time inside a quiet gap — of which the 90 s fixture has several, and
 * real speech has many — belongs to NO segment. Returning the previous one there
 * would leave a sentence highlighted while nobody is speaking, which reads as a
 * frozen player rather than as silence.
 *
 * A non-finite `currentTime` (a `<video>` reports NaN before metadata loads)
 * needs no guard: every comparison against NaN is false, so the scan finds
 * nothing and returns NO_ACTIVE_SEGMENT on its own. An explicit check here would
 * be unreachable — the tests pin the behaviour either way.
 */
export function activeSegmentIndex(
  segments: ReadonlyArray<Pick<TranscriptSegment, "start" | "end">>,
  currentTime: number,
): number {
  return segments.findIndex((segment) => currentTime >= segment.start && currentTime < segment.end);
}
