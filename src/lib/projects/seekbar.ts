/**
 * Pure geometry + timecode math for the project seekbar with in/out handles
 * (item 12).
 *
 * React-free and Node-free (DEC-005): the px↔seconds mapping, the range
 * clamping that keeps in < out inside the source, and the arrow-key nudge all
 * live here where vitest can pin the boundaries, so `seekbar.tsx` only wires
 * pointer/keyboard events to these functions and never does its own arithmetic.
 */

/**
 * A pixel offset within the track (0 = left edge) to a time in seconds.
 *
 * `duration` maps to the full `trackWidth`, so the ratio is `px / trackWidth`.
 * A zero or non-finite width (before layout, or a hidden track) yields 0 rather
 * than a divide-by-zero, and the result is clamped to `[0, duration]` so a drag
 * that overshoots the track edge never seeks past either end.
 */
export function pxToSeconds(px: number, trackWidth: number, duration: number): number {
  if (!Number.isFinite(trackWidth) || trackWidth <= 0 || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  const seconds = (px / trackWidth) * duration;
  return Math.max(0, Math.min(duration, seconds));
}

/** A time in seconds to a percent (0–100) of the track width, clamped. The
 * inverse of `pxToSeconds` in the unit the component styles with (`left: %`),
 * so it needs no pixel width. A non-positive duration pins everything to 0. */
export function secondsToPercent(seconds: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(seconds)) return 0;
  const pct = (seconds / duration) * 100;
  return Math.max(0, Math.min(100, pct));
}

/** How far one arrow-key press nudges a handle. Small enough to place a mark
 * precisely, large enough that holding the key is not glacial. */
export const NUDGE_STEP_SEC = 0.5;

/** Nudge a handle value by `delta`, clamped to `[0, duration]`. Used for the
 * arrow-key handlers on the in/out sliders. */
export function nudge(value: number, delta: number, duration: number): number {
  const next = value + delta;
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, next);
  return Math.max(0, Math.min(duration, next));
}

/**
 * Move the in-point, keeping it a hair before the out-point so the marked band
 * never inverts or collapses. `EPSILON` mirrors the manual-clip route's own
 * `out > in` rule: dragging the in-handle up to (or past) the out-handle parks
 * it just short instead of crossing over.
 */
const EPSILON = 1e-3;

export function clampIn(next: number, outPoint: number | null, duration: number): number {
  const lower = Math.max(0, next);
  const upper = outPoint === null ? duration : outPoint - EPSILON;
  return Number.isFinite(upper) ? Math.min(lower, Math.max(0, upper)) : lower;
}

/** Move the out-point, keeping it a hair after the in-point (mirror of
 * `clampIn`) and never past the source duration. */
export function clampOut(next: number, inPoint: number | null, duration: number): number {
  const upper = Number.isFinite(duration) && duration > 0 ? Math.min(next, duration) : next;
  const lower = inPoint === null ? 0 : inPoint + EPSILON;
  // A collapsed range (in-point pinned near the end) resolves to the lower bound
  // rather than snapping backward past the in-point.
  return upper < lower ? lower : Math.max(lower, upper);
}

/**
 * `m:ss.d` (or `h:mm:ss.d` past an hour) with a tenth-of-a-second, for the
 * handles' `aria-valuetext` and the scrub tooltip. A whole `formatDuration`
 * "0:12" would hide the half-second the 0.5 s nudge moves, so the seekbar needs
 * its own finer-grained timecode. Non-finite/negative input reads as "0:00.0".
 */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.0";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const tenths = Math.floor((seconds * 10) % 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
  return `${base}.${tenths}`;
}
