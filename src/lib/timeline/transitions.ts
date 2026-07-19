/**
 * Per-boundary transitions (Phase 08). A transition sits at the boundary between
 * two segments that are adjacent in PLAYBACK order and describes how the earlier
 * one blends into the later one: an instant `cut` (default) or an animated
 * `crossfade`/`slide-left`/`slide-right` lasting 0.2–1.5 s.
 *
 * Transitions are stored on {@link TimelineDoc.transitions}, keyed by the LEFT
 * segment's id, so they follow that segment through `trim`/`split`/`reorder`
 * without the segment ops needing to touch them. Everything here is pure
 * `(doc, args) → doc`, mirroring `ops.ts` and `broll.ts`; the picker UI holds the
 * resulting docs on the undo stack, and `renderPlan` (Phase 08 crux) reads live
 * transitions back with {@link listTransitions}.
 *
 * Validation (SPEC.md Phase 08): an animated transition must last no longer than
 * either adjacent segment — it consumes time from both — and its duration is
 * bounded to 0.2–1.5 s. A boundary only exists when the left segment has a
 * following segment, so a transition on the last segment is rejected.
 */

import { assertValidDoc } from "./state";
import {
  DEFAULT_TRANSITION_DURATION,
  MAX_TRANSITION_DURATION,
  MIN_TRANSITION_DURATION,
  TIME_EPSILON,
  TRANSITION_KINDS,
  TimelineError,
  type TimelineDoc,
  type TimelineSegment,
  type Transition,
  type TransitionKind,
} from "./types";

export {
  DEFAULT_TRANSITION_DURATION,
  MAX_TRANSITION_DURATION,
  MIN_TRANSITION_DURATION,
  TRANSITION_KINDS,
  type Transition,
  type TransitionKind,
} from "./types";

/** The implicit default at every boundary: an instant switch, no blend. */
export const CUT: Transition = { kind: "cut", duration: 0 };

/** True when `value` is one of the accepted {@link TransitionKind}s. */
export function isTransitionKind(value: unknown): value is TransitionKind {
  return typeof value === "string" && (TRANSITION_KINDS as readonly string[]).includes(value);
}

function segmentDuration(seg: TimelineSegment): number {
  return seg.sourceOut - seg.sourceIn;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Clamp a requested blend length into the allowed `[MIN, MAX]` band, falling back
 * to {@link DEFAULT_TRANSITION_DURATION} for a non-finite input. Handy for a
 * slider that should never emit an out-of-band value; the neighbour-fit check is
 * separate ({@link transitionFits}).
 */
export function clampTransitionDuration(duration: number): number {
  if (!Number.isFinite(duration)) return DEFAULT_TRANSITION_DURATION;
  return clamp(duration, MIN_TRANSITION_DURATION, MAX_TRANSITION_DURATION);
}

/**
 * The id of the segment that plays immediately after `leftSegId`, or `null` when
 * `leftSegId` is unknown or is the last segment (no boundary follows it).
 */
export function rightNeighborId(doc: TimelineDoc, leftSegId: string): string | null {
  const idx = doc.segments.findIndex((s) => s.id === leftSegId);
  if (idx === -1 || idx === doc.segments.length - 1) return null;
  return doc.segments[idx + 1].id;
}

/**
 * The longest transition the boundary after `leftSegId` can hold: capped at
 * {@link MAX_TRANSITION_DURATION} and by each adjacent segment's length. Returns
 * `0` when there is no boundary. A value below {@link MIN_TRANSITION_DURATION}
 * means no animated transition fits — the picker should keep only `cut`.
 */
export function maxTransitionDuration(doc: TimelineDoc, leftSegId: string): number {
  const idx = doc.segments.findIndex((s) => s.id === leftSegId);
  if (idx === -1 || idx === doc.segments.length - 1) return 0;
  const left = segmentDuration(doc.segments[idx]);
  const right = segmentDuration(doc.segments[idx + 1]);
  return Math.min(MAX_TRANSITION_DURATION, left, right);
}

/**
 * Whether a `duration`-second blend fits the boundary after `leftSegId`: it must
 * be strictly shorter than BOTH adjacent segments (it consumes time from each).
 * `false` when there is no boundary. This is the neighbour half of validation;
 * the band `[MIN, MAX]` is checked separately by {@link setTransition}.
 */
export function transitionFits(doc: TimelineDoc, leftSegId: string, duration: number): boolean {
  const idx = doc.segments.findIndex((s) => s.id === leftSegId);
  if (idx === -1 || idx === doc.segments.length - 1) return false;
  if (!Number.isFinite(duration)) return false;
  const left = segmentDuration(doc.segments[idx]);
  const right = segmentDuration(doc.segments[idx + 1]);
  return duration < left - TIME_EPSILON && duration < right - TIME_EPSILON;
}

/**
 * The live transition at the boundary after `leftSegId`: the stored one when the
 * segment still exists, still has a following segment, and holds a valid animated
 * kind; otherwise {@link CUT}. Never returns a stored `cut` (that is the default).
 */
export function getTransition(doc: TimelineDoc, leftSegId: string): Transition {
  if (rightNeighborId(doc, leftSegId) === null) return CUT;
  const stored = doc.transitions[leftSegId];
  if (!stored || !isTransitionKind(stored.kind) || stored.kind === "cut") return CUT;
  return { kind: stored.kind, duration: stored.duration };
}

/** A live transition together with the segment ids it joins, in playback order. */
export interface TransitionBoundary {
  leftId: string;
  rightId: string;
  transition: Transition;
}

/**
 * Every live animated transition, in playback order. Walks the real segment
 * boundaries, so an orphaned entry (its left segment was deleted, or is no longer
 * followed by another) is silently skipped — `renderPlan` and the preview only
 * ever see transitions that still join two adjacent segments.
 */
export function listTransitions(doc: TimelineDoc): TransitionBoundary[] {
  const out: TransitionBoundary[] = [];
  for (let i = 0; i < doc.segments.length - 1; i++) {
    const leftId = doc.segments[i].id;
    const stored = doc.transitions[leftId];
    if (!stored || !isTransitionKind(stored.kind) || stored.kind === "cut") continue;
    out.push({
      leftId,
      rightId: doc.segments[i + 1].id,
      transition: { kind: stored.kind, duration: stored.duration },
    });
  }
  return out;
}

/**
 * Set (or clear) the transition at the boundary after `leftSegId`.
 *
 * `cut` clears any stored transition (a no-op when none is stored). An animated
 * kind requires the segment to have a following segment, a duration inside
 * `[MIN, MAX]`, and a duration shorter than both adjacent segments — each
 * violation throws {@link TimelineError} so the API turns it into one 400 rather
 * than silently persisting an invalid blend. `duration` defaults to
 * {@link DEFAULT_TRANSITION_DURATION}.
 */
export function setTransition(
  doc: TimelineDoc,
  leftSegId: string,
  kind: TransitionKind,
  duration: number = DEFAULT_TRANSITION_DURATION,
): TimelineDoc {
  if (!isTransitionKind(kind)) {
    throw new TimelineError(`Unknown transition kind ${String(kind)}`);
  }
  if (!doc.segments.some((s) => s.id === leftSegId)) {
    throw new TimelineError(`No segment ${leftSegId} in this timeline`);
  }

  if (kind === "cut") {
    if (!(leftSegId in doc.transitions)) return doc;
    const transitions = { ...doc.transitions };
    delete transitions[leftSegId];
    return assertValidDoc({ ...doc, transitions });
  }

  if (rightNeighborId(doc, leftSegId) === null) {
    throw new TimelineError(`Segment ${leftSegId} is last; no boundary for a transition`);
  }
  if (!Number.isFinite(duration)) {
    throw new TimelineError("Transition duration must be a finite number");
  }
  if (
    duration < MIN_TRANSITION_DURATION - TIME_EPSILON ||
    duration > MAX_TRANSITION_DURATION + TIME_EPSILON
  ) {
    throw new TimelineError(
      `Transition duration ${duration}s is outside ${MIN_TRANSITION_DURATION}-${MAX_TRANSITION_DURATION}s`,
    );
  }
  if (!transitionFits(doc, leftSegId, duration)) {
    throw new TimelineError(
      `Transition ${duration}s is not shorter than both adjacent segments`,
    );
  }

  const transitions = { ...doc.transitions, [leftSegId]: { kind, duration } };
  return assertValidDoc({ ...doc, transitions });
}

/** Clear the transition at the boundary after `leftSegId` (revert to `cut`). */
export function removeTransition(doc: TimelineDoc, leftSegId: string): TimelineDoc {
  return setTransition(doc, leftSegId, "cut");
}
