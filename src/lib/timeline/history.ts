/**
 * Undo/redo state stack over the pure {@link TimelineDoc} (Phase 07:
 * "undo/redo (state stack over the pure doc, ≥50 steps)"). Every editor edit is
 * an op in `ops.ts` returning a whole new doc, so history is just a stack of
 * those immutable snapshots — no reverse operations, no diffing. Kept here as
 * pure data alongside the model so the React layer holds a `TimelineHistory` and
 * calls these transitions, never bookkeeping the stack itself.
 *
 * Shape follows the classic past/present/future split: `undo` shuttles the
 * present into `future` and pops `past`; `redo` mirrors it; a fresh `push`
 * (a new edit) discards any pending `future` (the redo branch). All four
 * transitions return a new `TimelineHistory` and never mutate their input.
 */

import type { TimelineDoc } from "./types";

/**
 * Smallest undo depth Phase 07 mandates ("≥50 steps"). {@link createHistory}
 * clamps any smaller requested limit up to this so no caller can accidentally
 * configure a stack shallower than the spec allows.
 */
export const MIN_HISTORY_LIMIT = 50;

/**
 * Default retained-edit depth. Comfortably above {@link MIN_HISTORY_LIMIT};
 * bounded so a long editing session can't grow the stack without limit.
 */
export const DEFAULT_HISTORY_LIMIT = 100;

/**
 * An undo/redo stack of timeline snapshots. `present` is what the editor
 * renders; `past` holds prior docs oldest-first (the most recent is the one an
 * `undo` restores); `future` holds undone docs in redo order (index 0 is the
 * next `redo`). `limit` caps `past` length — older entries fall off the bottom,
 * so undo can always reach back at least `limit` edits.
 */
export interface TimelineHistory {
  /** Prior docs, oldest first; the last entry is the next `undo` target. */
  past: TimelineDoc[];
  /** The doc currently in effect (what the UI renders and persists). */
  present: TimelineDoc;
  /** Undone docs, in redo order (index 0 is the next `redo` target). */
  future: TimelineDoc[];
  /** Maximum retained `past` depth (`≥ MIN_HISTORY_LIMIT`). */
  limit: number;
}

/** Drop the oldest entries so `past` never exceeds `limit`. */
function capPast(past: TimelineDoc[], limit: number): TimelineDoc[] {
  return past.length > limit ? past.slice(past.length - limit) : past;
}

/**
 * Start a history at `present` with an empty undo/redo stack. `limit` is floored
 * to a whole number and clamped up to {@link MIN_HISTORY_LIMIT}, so the returned
 * stack always satisfies the Phase-07 minimum regardless of the caller's ask.
 */
export function createHistory(
  present: TimelineDoc,
  limit: number = DEFAULT_HISTORY_LIMIT,
): TimelineHistory {
  const safeLimit = Math.max(MIN_HISTORY_LIMIT, Math.floor(limit) || 0);
  return { past: [], present, future: [], limit: safeLimit };
}

/**
 * Record a new edit: `next` becomes the present, the old present is pushed onto
 * `past` (capped to `limit`), and any pending redo branch (`future`) is
 * discarded — the standard "new action clears redo" rule. Pushing the exact same
 * doc reference the present already holds is a no-op (returns the input
 * unchanged), so a drag or click that produces no real change doesn't bloat the
 * undo stack with duplicate steps.
 */
export function pushHistory(
  history: TimelineHistory,
  next: TimelineDoc,
): TimelineHistory {
  if (next === history.present) return history;
  return {
    past: capPast([...history.past, history.present], history.limit),
    present: next,
    future: [],
    limit: history.limit,
  };
}

/** True when there is a prior doc to undo to. */
export function canUndo(history: TimelineHistory): boolean {
  return history.past.length > 0;
}

/** True when there is an undone doc to redo. */
export function canRedo(history: TimelineHistory): boolean {
  return history.future.length > 0;
}

/**
 * Step back one edit: the last `past` doc becomes present and the old present
 * moves to the front of `future` (so a following `redo` restores it exactly).
 * A no-op returning the input unchanged when `past` is empty.
 */
export function undoHistory(history: TimelineHistory): TimelineHistory {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    limit: history.limit,
  };
}

/**
 * Step forward one edit (reverses an {@link undoHistory}): the first `future`
 * doc becomes present and the old present is pushed back onto `past` (capped to
 * `limit`). A no-op returning the input unchanged when `future` is empty.
 */
export function redoHistory(history: TimelineHistory): TimelineHistory {
  if (history.future.length === 0) return history;
  const [next, ...rest] = history.future;
  return {
    past: capPast([...history.past, history.present], history.limit),
    present: next,
    future: rest,
    limit: history.limit,
  };
}
