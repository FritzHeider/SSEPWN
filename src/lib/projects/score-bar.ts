/**
 * Pure model for a clip's score bar (item 15).
 *
 * The old card printed a raw "score 0.82" chip, but highlight scores are not a
 * 0–1 probability — the scorer sums weighted signals, so a top clip can score
 * 3.5 and a weak one 0.4 (see `clips-panel.test.ts`). A bar whose width is
 * `score × 100%` would blow past the track. So the bar is normalized against the
 * ranked list's own top score: the best clip fills the track, the rest read as a
 * fraction of it, and the tone grades from muted to accent with that fraction.
 * Manual clips (no score) get no bar, matching `clipScoreLabel` returning null.
 * The numeric label stays raw (`clipScoreLabel`) so its existing tests hold.
 */

/** The largest finite score in a list, or 0 when there are none (all manual, or
 * empty). Used as the denominator so the highest-scoring clip fills the bar. */
export function maxClipScore(clips: readonly { score: number | null }[]): number {
  let max = 0;
  for (const clip of clips) {
    if (clip.score !== null && Number.isFinite(clip.score) && clip.score > max) {
      max = clip.score;
    }
  }
  return max;
}

/**
 * A clip's score as a fraction of the list's top score, in `[0, 1]` — or `null`
 * when the clip has no score (manual) or the list has no positive scores to
 * normalize against. A zero `max` (every clip manual) yields `null` rather than
 * a divide-by-zero, so the caller draws no bar.
 */
export function scoreFraction(score: number | null, maxScore: number): number | null {
  if (score === null || !Number.isFinite(score)) return null;
  if (!Number.isFinite(maxScore) || maxScore <= 0) return null;
  return Math.max(0, Math.min(1, score / maxScore));
}

/**
 * The bar width as a CSS percent string ("82%") for a given fraction. A tiny
 * floor keeps a non-null-but-near-zero score visible as a sliver rather than an
 * empty track that reads as "no bar".
 */
export function scoreBarWidth(fraction: number): string {
  const pct = Math.max(4, Math.round(fraction * 100));
  return `${pct}%`;
}

/**
 * The bar's fill colour: `color-mix` between the muted text colour (weak) and
 * the accent (strong), weighted by the fraction. Higher-ranked clips read
 * pinker, lower ones greyer, so the list's ranking is legible at a glance
 * without reading the numbers. Returns a CSS value the component drops into
 * `background`.
 */
export function scoreBarColor(fraction: number): string {
  const accentPct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return `color-mix(in oklab, var(--accent) ${accentPct}%, var(--text-muted))`;
}
