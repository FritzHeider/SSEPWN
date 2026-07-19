/**
 * Pure presentation logic for the Phase-08 transitions picker — one control per
 * segment boundary in the timeline. React/Node-free by design (DEC-005): the
 * thin `<TransitionsPanel>` only wires these decisions to selects/sliders and
 * the pure ops in {@link ./transitions}. Everything arithmetic — which
 * boundaries exist, the live kind/duration on each, whether any animated blend
 * fits, and clamping a requested duration so `setTransition` never throws —
 * lives here, unit-tested apart from the JSX.
 */

import {
  DEFAULT_TRANSITION_DURATION,
  getTransition,
  MAX_TRANSITION_DURATION,
  MIN_TRANSITION_DURATION,
  maxTransitionDuration,
} from "./transitions";
import { TIME_EPSILON, type TimelineDoc, type TransitionKind } from "./types";

/**
 * A single picker slot: the boundary after `leftId`, the live transition on it,
 * and the animation bounds the UI needs to render controls and stay in range.
 */
export interface BoundaryPicker {
  /** Left segment id — the boundary is keyed by (and follows) this segment. */
  leftId: string;
  /** The segment that plays immediately after `leftId`. */
  rightId: string;
  /** 0-based boundary index in playback order (there are `segments-1` of them). */
  index: number;
  /** Live transition kind (`cut` when nothing valid is stored). */
  kind: TransitionKind;
  /** Live blend length in seconds; `0` for a `cut`. */
  duration: number;
  /** Longest blend the boundary could hold (`min(MAX, leftDur, rightDur)`). */
  maxDuration: number;
  /** Whether an animated transition fits — both segments long enough for MIN. */
  canAnimate: boolean;
}

/**
 * True when the boundary after `leftId` can hold an animated blend at all: the
 * shorter neighbour must exceed {@link MIN_TRANSITION_DURATION} strictly (a
 * blend consumes time from both, and the minimum is MIN). Mirrors
 * `transitionFits` at its smallest legal duration so the picker only offers
 * animated kinds where at least one is settable.
 */
export function boundaryCanAnimate(doc: TimelineDoc, leftId: string): boolean {
  return maxTransitionDuration(doc, leftId) > MIN_TRANSITION_DURATION + TIME_EPSILON;
}

/**
 * Every segment boundary in playback order with its live transition state.
 * There are `segments.length - 1` boundaries; the last segment has none. The
 * component renders one row per entry.
 */
export function transitionBoundaries(doc: TimelineDoc): BoundaryPicker[] {
  const out: BoundaryPicker[] = [];
  for (let i = 0; i < doc.segments.length - 1; i++) {
    const leftId = doc.segments[i].id;
    const rightId = doc.segments[i + 1].id;
    const live = getTransition(doc, leftId);
    out.push({
      leftId,
      rightId,
      index: i,
      kind: live.kind,
      duration: live.duration,
      maxDuration: maxTransitionDuration(doc, leftId),
      canAnimate: boundaryCanAnimate(doc, leftId),
    });
  }
  return out;
}

/**
 * Clamp a requested blend length to one the boundary after `leftId` will
 * actually accept: at least {@link MIN_TRANSITION_DURATION}, and STRICTLY
 * shorter than both neighbours (and {@link MAX_TRANSITION_DURATION}). A slider
 * or number input pipes its raw value through this so `setTransition` never
 * throws — `requested` may be non-finite (falls back to the default) or out of
 * band. Returns MIN when nothing fits; callers should gate on
 * {@link boundaryCanAnimate} first.
 */
export function fitTransitionDuration(
  doc: TimelineDoc,
  leftId: string,
  requested: number,
): number {
  const base = Number.isFinite(requested) ? requested : DEFAULT_TRANSITION_DURATION;
  // Strict-fit ceiling: a hair under the shorter neighbour so `duration < dur`
  // holds even at exact equality (transitionFits compares with TIME_EPSILON).
  const ceil = Math.min(MAX_TRANSITION_DURATION, maxTransitionDuration(doc, leftId) - 2 * TIME_EPSILON);
  if (ceil < MIN_TRANSITION_DURATION) return MIN_TRANSITION_DURATION;
  return Math.max(MIN_TRANSITION_DURATION, Math.min(ceil, base));
}
