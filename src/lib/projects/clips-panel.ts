/**
 * Pure presentation logic for the clips panel (DEC-005).
 *
 * React-free and Node-free, like view.ts and transcribe/panel.ts: the decisions
 * a clip card makes — how its range reads, whether it shows a score or the word
 * "Manual", when the "Add clip" button is allowed to fire — live here where
 * node-env vitest can test them honestly, and the JSX that consumes them stays
 * thin enough to read at a glance.
 */

import type { ProjectClip } from "@/lib/projects/clips";
import { formatDuration } from "@/lib/projects/view";

/** Shown on a clip whose title was never set (manual clip, no custom name). */
const UNTITLED = "Untitled clip";

/**
 * A clip's display title, never blank.
 *
 * The auto-titler and the manual-add route both write a title, but a title
 * column can still be null (a candidate whose range held no hook sentence) or
 * whitespace, and a card with an empty heading reads as broken. Falls back to a
 * neutral label rather than to the range, which the card already shows.
 */
export function clipTitle(clip: Pick<ProjectClip, "title">): string {
  const trimmed = clip.title?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : UNTITLED;
}

/** `m:ss` length of a clip, from its in/out points. */
export function clipDurationLabel(clip: Pick<ProjectClip, "inPoint" | "outPoint">): string {
  return formatDuration(clip.outPoint - clip.inPoint);
}

/** `m:ss – m:ss` source range of a clip. En dash, not a hyphen, between times. */
export function clipRangeLabel(clip: Pick<ProjectClip, "inPoint" | "outPoint">): string {
  return `${formatDuration(clip.inPoint)} – ${formatDuration(clip.outPoint)}`;
}

/**
 * A clip's score as a short label, or `null` when it has none.
 *
 * Manual clips carry no score (the user chose the range, the scorer never ran),
 * so `null` here is the signal the card uses to print "Manual" instead of a
 * number. A non-finite score — which should never reach the UI but would render
 * as "NaN" if it did — is treated the same as absent.
 */
export function clipScoreLabel(clip: Pick<ProjectClip, "score">): string | null {
  if (clip.score === null || !Number.isFinite(clip.score)) return null;
  return clip.score.toFixed(2);
}

/**
 * Why the clips list is empty, in words the user can act on — or `null` when
 * there are clips and the panel should just render them.
 *
 * An empty list is the normal first state of a ready project whose generate-clips
 * job has not run yet, not an error, so it reads as an invitation rather than a
 * failure.
 *
 * `generationComplete` splits the two empty states apart, because they mean
 * opposite things to the user. Before generation finishes the list is empty only
 * because there is nothing yet — "come back". Once generation has run and STILL
 * found nothing (a zero-highlight video: no speech, flat energy, no scene cuts),
 * regenerating will keep finding nothing, so the honest next step is to offer
 * manual clipping directly. Defaults to `false` so existing callers — and any
 * caller that cannot cheaply learn the job state — keep the neutral message.
 */
export function clipsEmptyMessage(
  clips: readonly unknown[],
  generationComplete = false,
): string | null {
  if (clips.length > 0) return null;
  if (generationComplete) {
    return "No highlights were found automatically. Mark an in-point and out-point on the player above to add a clip yourself.";
  }
  return "No clips yet. Regenerate highlights or add one from the player.";
}

/**
 * The reason "Add clip" is disabled for the current mark-in/mark-out selection,
 * or `null` when the range is valid and the button may fire.
 *
 * Mirrors the boundary rules of `POST /api/projects/:id/clips` so the button
 * never sends a request the route is bound to reject — the API is still the
 * authority (this is a hint, not the guard), but a user who has not marked both
 * ends, or marked them backwards, learns why here instead of from a 400.
 *
 * `null` in/out means "not marked yet"; the epsilon on the duration check
 * matches the route so an out-point exactly at the end passes both.
 */
export function manualRangeError(
  inPoint: number | null,
  outPoint: number | null,
  duration: number | null,
): string | null {
  if (inPoint === null || outPoint === null) return "Mark both an in-point and an out-point.";
  if (!Number.isFinite(inPoint) || !Number.isFinite(outPoint)) {
    return "Mark both an in-point and an out-point.";
  }
  if (inPoint < 0) return "The in-point must be at or after the start.";
  if (outPoint <= inPoint) return "The out-point must come after the in-point.";
  if (duration !== null && Number.isFinite(duration) && outPoint > duration + 1e-3) {
    return "The range must fall within the video.";
  }
  return null;
}

/**
 * Whether a range preview has reached its out-point and the player should pause.
 *
 * The panel plays a clip by seeking to its in-point and letting the element run;
 * this is what a `timeupdate` handler asks each tick to know when to stop. The
 * bound is `>=` (inclusive) so playback stops AT the out-point, not one tick
 * past it, and a non-finite `currentTime` — a `<video>` reports NaN before
 * metadata loads — never trips it (every comparison against NaN is false).
 */
export function shouldPausePreview(currentTime: number, outPoint: number): boolean {
  return currentTime >= outPoint;
}
