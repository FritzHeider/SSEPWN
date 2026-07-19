/**
 * Edge-state clip candidates (SPEC.md § edge/empty states, Phase 11).
 *
 * The main scorer (`scoreWindows`) is transcript-driven: it needs word-timed
 * segments to slide a window over and returns nothing without them. Two real
 * projects have no usable transcript to score:
 *
 *   1. a **no-audio** video (or one with audio but no detectable speech) — there
 *      is nothing to transcribe, so clips must come from the picture: energy
 *      peaks where there is a soundtrack, and scene cuts for boundaries;
 *   2. a **very short** upload, shorter than one minimum clip — there is no room
 *      to cut anything, so the whole video becomes a single clip.
 *
 * Both produce plain {@link Candidate}s that flow through the same
 * `selectClips` step as the transcript path, so the rest of the pipeline (title,
 * persistence, UI) is unchanged. Pure and deterministic like the rest of
 * `src/lib/highlights`: same duration/energy/scenes in, same clips out.
 */

import type { Candidate, SignalName, SignalScore } from "./score";

const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, value));

/** Every signal at zero — the base a fallback candidate fills selectively. */
function zeroSignals(): Record<SignalName, SignalScore> {
  const blank = (reason: string): SignalScore => ({ raw: 0, weight: 0, score: 0, reason });
  return {
    energy: blank("high energy"),
    speechDensity: blank("dense speech"),
    hook: blank("hook phrase"),
    emphasis: blank("emphatic delivery"),
    laughter: blank("laughter"),
  };
}

export interface FallbackOptions {
  /** Shortest a fallback clip may be, seconds. Default 15. */
  minLen?: number;
  /** Longest a fallback clip may be, seconds. Default 90. */
  maxLen?: number;
  /** Sliding-window length the scan tiles with, seconds. Default 30. */
  windowLen?: number;
  /** How far the window advances each step, seconds. Default 5. */
  step?: number;
  /** How close a scene change must be to an edge to be snapped to. Default 1.5. */
  sceneWindow?: number;
}

/**
 * A single clip spanning the whole source — the very-short case (SPEC/Phase-11:
 * "< min clip length → whole video becomes one clip"). Carries a plain reason so
 * the clip is never left without a "why", and a zero score (there was no ranking
 * to do — it is the only clip).
 */
export function wholeVideoCandidate(duration: number): Candidate {
  const end = Math.max(0, duration);
  return {
    start: 0,
    end,
    score: 0,
    signals: zeroSignals(),
    reasons: ["whole video (shorter than one clip)"],
  };
}

/** Nearest scene change within `window` of `target`, or `target` unchanged. */
function snapToScene(target: number, scenes: number[], window: number): number {
  let best = target;
  let bestDist = window;
  for (const s of scenes) {
    const d = Math.abs(s - target);
    if (d <= bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

/**
 * Peak energy inside `[start, end)` relative to the loudest second anywhere, in
 * [0, 1]. Returns 0 for a silent or absent track — a no-audio project then
 * scores every window equally and selection tiles the video by scene cuts alone.
 */
function energyPeak(energy: number[], start: number, end: number, globalMax: number): number {
  if (energy.length === 0 || globalMax <= 0) return 0;
  const from = clamp(Math.floor(start), 0, energy.length - 1);
  const to = clamp(Math.ceil(end) - 1, 0, energy.length - 1);
  let peak = 0;
  for (let i = from; i <= to; i++) {
    if (energy[i] > peak) peak = energy[i];
  }
  return clamp(peak / globalMax, 0, 1);
}

/**
 * Candidate clips for a project with no transcript to score (SPEC/Phase-11:
 * "clips by scene/energy only"). Tiles a window across `[0, duration]`, scoring
 * each position by its peak audio energy, and snaps both edges to nearby scene
 * cuts so clips open and close on a hard visual boundary.
 *
 * The returned candidates are ranked later by `selectClips` exactly like the
 * transcript path. When there is genuinely no audio, every window scores 0 and
 * selection falls back to evenly tiled, scene-aligned clips.
 *
 * @param duration source length, seconds. `<= 0` yields no candidates.
 * @param energy per-second RMS energy; may be empty (no/silent audio).
 * @param scenes scene-change timestamps, seconds; may be empty.
 */
export function fallbackCandidates(
  duration: number,
  energy: number[],
  scenes: number[],
  options: FallbackOptions = {},
): Candidate[] {
  const minLen = options.minLen ?? 15;
  const maxLen = options.maxLen ?? 90;
  if (minLen <= 0 || maxLen < minLen) {
    throw new Error(`invalid clip length bounds: minLen=${minLen}, maxLen=${maxLen}`);
  }
  if (duration <= 0) return [];

  const windowLen = clamp(options.windowLen ?? 30, minLen, maxLen);
  const step = options.step ?? 5;
  if (step <= 0) throw new Error(`step must be > 0, got ${step}`);
  const sceneWindow = options.sceneWindow ?? 1.5;

  // A source shorter than the window can still be cut once; longer sources tile.
  const lastStart = Math.max(0, duration - windowLen);
  const globalMax = energy.reduce((max, v) => Math.max(max, v), 0);
  const candidates: Candidate[] = [];

  for (let rawStart = 0; rawStart <= lastStart + 1e-9; rawStart += step) {
    // Snap the window edges to scene cuts, then keep the length in bounds and
    // inside the timeline — the same guarantees the transcript path gives.
    let start = snapToScene(rawStart, scenes, sceneWindow);
    start = clamp(start, 0, Math.max(0, duration - minLen));
    let end = snapToScene(start + windowLen, scenes, sceneWindow);
    end = clamp(end, start + minLen, Math.min(duration, start + maxLen));

    const raw = energyPeak(energy, start, end, globalMax);
    const signals = zeroSignals();
    signals.energy = { raw, weight: 1, score: raw, reason: "high energy" };

    candidates.push({
      start,
      end,
      score: raw,
      signals,
      reasons: [raw > 0 ? "high energy" : "scene segment"],
    });

    if (lastStart === 0) break; // single-window source: no second position
  }

  return candidates;
}
