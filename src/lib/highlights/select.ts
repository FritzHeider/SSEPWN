/**
 * Clip selection (SPEC.md § Highlight scoring, Phase 04 `selectClips`).
 *
 * `scoreWindows` + `snapBoundaries` produce many overlapping candidates — the
 * sliding window steps every few seconds, so a strong moment shows up in several
 * neighbouring windows at once. This step reduces that dense field to the final
 * short-list the product actually clips: the best few candidates that don't sit
 * on top of one another.
 *
 * The rule (SPEC/Phase-04) is: take the top-N candidates by score such that no
 * two selected clips overlap and every pair is at least `minGap` seconds apart.
 * We pick greedily in descending score order — the highest-scoring candidate is
 * always taken, then each next-best is taken only if it clears the gap from
 * everything already chosen. Greedy-by-score is the natural reading of "top-N …
 * ranked by score": a clip is never dropped in favour of a lower-scoring one.
 *
 * Pure and deterministic like the rest of `src/lib/highlights`: same candidates
 * in, same clips out — ties broken by earliest start so ordering never depends
 * on input order or a clock.
 */

import type { Candidate } from "./score";

/** Floating-point slop for time comparisons (sub-millisecond). */
const EPS = 1e-6;

export interface SelectClipsOptions {
  /** Maximum clips to return (SPEC: project setting, 5–10). Default 5. */
  n?: number;
  /**
   * Minimum silence, seconds, required between two selected clips: the later
   * clip must start at least this long after the earlier one ends (SPEC: ≥5 s).
   * Also enforces non-overlap, since overlapping clips have a negative gap.
   * Default 5.
   */
  minGap?: number;
}

/**
 * True when clips `a` and `b` can both be selected: they don't overlap AND the
 * gap between them is at least `minGap`. Whichever ends first must end at least
 * `minGap` before the other starts.
 */
function compatible(a: Candidate, b: Candidate, minGap: number): boolean {
  const [first, second] = a.start <= b.start ? [a, b] : [b, a];
  return second.start - first.end >= minGap - EPS;
}

/**
 * Rank candidates and greedily pick the top-N non-overlapping, ≥`minGap`-apart
 * clips.
 *
 * Selection order is descending score; ties break by earliest start, then
 * earliest end, so the result is fully determined by the input values (never by
 * their order). The returned array is in that same rank order — highest score
 * first — which is the order the clips panel lists them and the order clip rows
 * are written.
 *
 * @param candidates scored, boundary-snapped candidates. Not mutated.
 * @param options `n` (max clips) and `minGap` (seconds between clips).
 * @returns up to `n` selected clips, best-scoring first.
 */
export function selectClips(
  candidates: Candidate[],
  options: SelectClipsOptions = {},
): Candidate[] {
  const n = options.n ?? 5;
  const minGap = options.minGap ?? 5;
  if (n <= 0 || candidates.length === 0) return [];

  const ranked = [...candidates].sort(
    (a, b) => b.score - a.score || a.start - b.start || a.end - b.end,
  );

  const selected: Candidate[] = [];
  for (const candidate of ranked) {
    if (selected.length >= n) break;
    if (selected.every((chosen) => compatible(candidate, chosen, minGap))) {
      selected.push(candidate);
    }
  }
  return selected;
}
