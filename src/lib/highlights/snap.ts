/**
 * Boundary snapping (SPEC.md § Highlight scoring, Phase 04 `snapBoundaries`).
 *
 * A raw {@link Candidate} from `scoreWindows` has arbitrary edges — wherever the
 * fixed-length window happened to land. Cutting a clip there would slice through
 * the middle of a spoken word and start/end mid-sentence, which reads as broken.
 * This step nudges each edge to a natural place:
 *
 *   1. snap to the nearest SENTENCE boundary (a transcript segment edge), so the
 *      clip opens and closes on a complete thought;
 *   2. PREFER a scene change within 1.5 s of the edge, because a hard visual cut
 *      is an even cleaner place to start/end than a sentence boundary;
 *   3. NEVER let an edge fall strictly inside a word's [start, end] — a half-word
 *      is worse than either including or excluding the whole word;
 *   4. keep the resulting duration within [minLen, maxLen].
 *
 * Like the rest of `src/lib/highlights`, this is pure: it takes the transcript,
 * the scene-change list, and options as plain data — no ffmpeg, no database, no
 * randomness — so the same candidate always snaps to the same clip.
 */

import type { TranscriptSegment, TranscriptWord } from "../transcribe/types";
import type { Candidate } from "./score";

/** Floating-point slop for time comparisons (sub-millisecond). */
const EPS = 1e-6;

export interface SnapOptions {
  /** Shortest a snapped clip may be, seconds (SPEC: 15–90). Default 15. */
  minLen?: number;
  /** Longest a snapped clip may be, seconds. Default 90. */
  maxLen?: number;
  /**
   * How close (seconds) a scene change must be to an edge to be preferred over
   * the nearest sentence boundary. Default 1.5 (SPEC/Phase-04).
   */
  sceneWindow?: number;
}

const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, value));

/** Flatten every word out of the segments into one time-ordered stream. */
function flattenWords(transcript: TranscriptSegment[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const segment of transcript) {
    for (const word of segment.words) words.push(word);
  }
  return words.sort((a, b) => a.start - b.start);
}

/** Unique, ascending list of `values`, collapsing near-duplicates within EPS. */
function uniqueSorted(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || v - out[out.length - 1] > EPS) out.push(v);
  }
  return out;
}

/** True when `t` falls STRICTLY inside some word — i.e. cutting there splits it. */
function insideAnyWord(t: number, words: TranscriptWord[]): boolean {
  return words.some((w) => t > w.start + EPS && t < w.end - EPS);
}

/** The value in `sorted` closest to `target`, or `undefined` when empty. */
function nearest(sorted: number[], target: number): number | undefined {
  if (sorted.length === 0) return undefined;
  let best = sorted[0];
  let bestDist = Math.abs(sorted[0] - target);
  for (let i = 1; i < sorted.length; i++) {
    const d = Math.abs(sorted[i] - target);
    if (d < bestDist) {
      bestDist = d;
      best = sorted[i];
    }
  }
  return best;
}

/**
 * Snap `target` to the nearest `boundaries` value, but PREFER the nearest scene
 * change lying within `sceneWindow` of `target` — a hard cut beats a sentence
 * edge. Falls back to `target` itself when there are no boundaries at all.
 */
function snapEdge(
  target: number,
  boundaries: number[],
  scenes: number[],
  sceneWindow: number,
): number {
  let scene: number | undefined;
  let sceneDist = Infinity;
  for (const s of scenes) {
    const d = Math.abs(s - target);
    if (d <= sceneWindow + EPS && d < sceneDist) {
      sceneDist = d;
      scene = s;
    }
  }
  if (scene !== undefined) return scene;
  return nearest(boundaries, target) ?? target;
}

/**
 * Move `t` off the middle of a word so no edge splits a word. A `start` edge
 * expands LEFT to the word's start (include the whole word); an `end` edge
 * expands RIGHT to the word's end. One pass suffices for non-overlapping words;
 * the `while` guards the rare overlapping-word case without looping forever.
 */
function avoidMidWord(t: number, words: TranscriptWord[], edge: "start" | "end"): number {
  let current = t;
  for (let guard = 0; guard < words.length + 1; guard++) {
    const hit = words.find((w) => current > w.start + EPS && current < w.end - EPS);
    if (!hit) return current;
    current = edge === "start" ? hit.start : hit.end;
  }
  return current;
}

/**
 * Choose the clip's end given a fixed `start`: the valid cut point (never
 * mid-word) closest to `desiredEnd` whose distance from `start` lands in
 * [minLen, maxLen] and within the timeline. `validPoints` is the pre-filtered
 * menu of non-mid-word times; it always contains `timelineEnd`, so a clip that
 * cannot reach `maxLen` still has at least the timeline end to snap to.
 */
function pickEnd(
  start: number,
  desiredEnd: number,
  validPoints: number[],
  minLen: number,
  maxLen: number,
  timelineEnd: number,
): number {
  const lo = start + minLen;
  const hi = Math.min(start + maxLen, timelineEnd);
  let best: number | undefined;
  let bestDist = Infinity;
  for (const v of validPoints) {
    if (v < lo - EPS || v > hi + EPS) continue;
    const d = Math.abs(v - desiredEnd);
    if (d < bestDist) {
      bestDist = d;
      best = v;
    }
  }
  if (best !== undefined) return best;
  // No valid cut point inside [lo, hi] (a degenerate, word-sparse transcript):
  // fall back to the clamped target, nudged off any word toward `start` so the
  // duration stays ≤ maxLen.
  return avoidMidWord(clamp(desiredEnd, lo, hi), [], "start");
}

/**
 * Snap a scored {@link Candidate} to natural, word-safe boundaries, returning a
 * candidate with the same score/signals/reasons and adjusted `start`/`end`.
 *
 * Guarantees on the returned clip:
 *  - neither edge falls strictly inside any word interval;
 *  - `end - start` is within [minLen, maxLen] (as far as the timeline allows);
 *  - edges prefer scene changes within `sceneWindow`, else sentence boundaries.
 *
 * Assumes the source is at least `minLen` long — clips come from real videos of
 * minutes; a shorter transcript is returned spanning what exists.
 *
 * @param candidate a scored window from {@link scoreWindows}.
 * @param transcript the word-timed segments the candidate was scored against.
 * @param scenes scene-change timestamps (seconds); may be empty.
 */
export function snapBoundaries(
  candidate: Candidate,
  transcript: TranscriptSegment[],
  scenes: number[] = [],
  options: SnapOptions = {},
): Candidate {
  const minLen = options.minLen ?? 15;
  const maxLen = options.maxLen ?? 90;
  if (minLen <= 0 || maxLen < minLen) {
    throw new Error(`invalid clip length bounds: minLen=${minLen}, maxLen=${maxLen}`);
  }
  const sceneWindow = options.sceneWindow ?? 1.5;

  const words = flattenWords(transcript);
  if (words.length === 0) return candidate;

  const timelineStart = Math.max(0, words.reduce((min, w) => Math.min(min, w.start), Infinity));
  const timelineEnd = words.reduce((max, w) => Math.max(max, w.end), 0);

  // Source shorter than one minimum clip: nothing to snap to — span it all.
  if (timelineEnd - timelineStart <= minLen + EPS) {
    return { ...candidate, start: timelineStart, end: timelineEnd };
  }

  const sentenceStarts = uniqueSorted(transcript.map((s) => s.start));
  const sentenceEnds = uniqueSorted(transcript.map((s) => s.end));
  // Every place a cut is guaranteed not to split a word: word edges, sentence
  // edges, in-word-safe scene changes, and the timeline ends. pickEnd draws the
  // final end from this menu so the length constraint can never force a mid-word.
  const validPoints = uniqueSorted(
    [
      timelineStart,
      timelineEnd,
      ...words.flatMap((w) => [w.start, w.end]),
      ...sentenceStarts,
      ...sentenceEnds,
      ...scenes,
    ].filter((t) => t >= timelineStart - EPS && t <= timelineEnd + EPS),
  ).filter((t) => !insideAnyWord(t, words));

  // Latest a clip may start and still fit minLen before the timeline ends.
  const maxStart = Math.max(timelineStart, timelineEnd - minLen);

  let start = snapEdge(candidate.start, sentenceStarts, scenes, sceneWindow);
  start = avoidMidWord(start, words, "start");
  start = clamp(start, timelineStart, maxStart);
  if (insideAnyWord(start, words)) start = avoidMidWord(start, words, "start");

  const desiredEnd = snapEdge(candidate.end, sentenceEnds, scenes, sceneWindow);
  const end = pickEnd(start, desiredEnd, validPoints, minLen, maxLen, timelineEnd);

  return { ...candidate, start, end };
}
