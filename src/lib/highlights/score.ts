/**
 * Pure highlight scoring (SPEC.md § Highlight scoring, Phase 04 `scoreWindows`).
 *
 * Takes plain data — a transcript and a per-second energy array — and NOTHING
 * else: no ffmpeg, no database, no clock, no randomness. Same inputs always
 * produce the same candidates, which is what makes the AI-feeling core of the
 * product unit-testable and reproducible (SPEC: "Deterministic: same inputs →
 * same clips").
 *
 * The scorer slides a fixed-length window across the timeline and scores each
 * position from a set of NAMED signals. Every candidate carries not just a
 * total but a per-signal breakdown, because those signal names are exactly the
 * human-readable "reasons" the UI shows ("high energy", "hook phrase: …").
 */

import type { TranscriptSegment, TranscriptWord } from "../transcribe/types";

/** The signals that vote on a window. The keys double as breakdown labels. */
export type SignalName = "energy" | "speechDensity" | "hook" | "emphasis" | "laughter";

/**
 * Default hook phrases (SPEC/Phase-04: "the secret", "here's why", "nobody
 * tells you", …). Lowercase; matched as substrings of the window's spoken text,
 * so "the secret" also fires inside "here's the secret:". Callers override this
 * per project — the list is config, not a constant, so a project can tune what
 * counts as a hook and change which clip ranks first.
 */
export const DEFAULT_HOOK_PHRASES: readonly string[] = [
  "the secret",
  "here's why",
  "here's the",
  "nobody tells you",
  "nobody actually",
  "the truth is",
  "what nobody",
  "the trick",
  "the mistake",
  "let me show you",
  "i want to show you",
  "the point is",
  "changed everything",
];

/** Default per-signal weights. Hook phrases dominate; energy and laughter next. */
export const DEFAULT_WEIGHTS: Record<SignalName, number> = {
  energy: 1.0,
  speechDensity: 0.8,
  hook: 2.0,
  emphasis: 0.7,
  laughter: 1.0,
};

/** Words/sec that saturate the speech-density signal to 1. */
const DENSITY_FULL = 3;
/** Hook-phrase matches that saturate the hook signal to 1. */
const HOOK_FULL = 2;
/** `!`/`?` word count that saturates the emphasis signal to 1. */
const EMPHASIS_FULL = 2;

export interface ScoreWindowsOptions {
  /** Shortest clip a candidate may be, seconds (SPEC: 15–90). Default 15. */
  minLen?: number;
  /** Longest clip a candidate may be, seconds. Default 90. */
  maxLen?: number;
  /**
   * Length of the sliding window, seconds. Clamped into [minLen, maxLen].
   * Default 30. snapBoundaries later nudges the edges to sentence/scene lines;
   * this is just where the scan looks.
   */
  windowLen?: number;
  /** How far the window advances each step, seconds. Default 5. Must be > 0. */
  step?: number;
  /** Hook phrases to match (lowercased internally). Default {@link DEFAULT_HOOK_PHRASES}. */
  hookPhrases?: readonly string[];
  /** Per-signal weight overrides merged over {@link DEFAULT_WEIGHTS}. */
  weights?: Partial<Record<SignalName, number>>;
}

/** One signal's verdict on a window. */
export interface SignalScore {
  /** Normalised signal strength in [0, 1] before weighting. */
  raw: number;
  /** Weight applied to `raw`. */
  weight: number;
  /** Contribution to the candidate total (`weight * raw`). */
  score: number;
  /** Human-readable reason, e.g. "high energy" or "hook phrase: the secret". */
  reason: string;
}

/** A scored window: a clip candidate before boundary-snapping and selection. */
export interface Candidate {
  /** Window start, seconds into the source. */
  start: number;
  /** Window end, seconds into the source. */
  end: number;
  /** Sum of every signal's weighted contribution. Higher = more clippable. */
  score: number;
  /** Per-signal breakdown, keyed by signal name. */
  signals: Record<SignalName, SignalScore>;
  /**
   * Reasons for the signals that actually fired (raw > 0), most-influential
   * first. This is what the clips panel renders as the clip's "why".
   */
  reasons: string[];
}

const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, value));

/** A laughter marker token like `[laughter]` or `(laughs)` — not a spoken word. */
const LAUGHTER = /\[laughter\]|\[laughs?\]|\(laughs?\)/i;
/** A word carrying spoken emphasis. */
const EMPHASIS = /[!?]/;

function isLaughter(token: string): boolean {
  return LAUGHTER.test(token);
}

/** Flatten every word out of the segments into one time-ordered stream. */
function flattenWords(transcript: TranscriptSegment[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const segment of transcript) {
    for (const word of segment.words) words.push(word);
  }
  return words;
}

/**
 * Score the `energy` signal for a window: the loudest per-second value inside
 * it, relative to the loudest anywhere. A window sitting on an energy peak
 * scores near 1; a quiet stretch scores near 0. Returns 0 when there is no
 * energy data or the whole track is silent.
 */
function energySignal(energy: number[], start: number, end: number, globalMax: number): number {
  if (energy.length === 0 || globalMax <= 0) return 0;
  const from = clamp(Math.floor(start), 0, energy.length - 1);
  const to = clamp(Math.ceil(end) - 1, 0, energy.length - 1);
  let peak = 0;
  for (let i = from; i <= to; i++) {
    if (energy[i] > peak) peak = energy[i];
  }
  return clamp(peak / globalMax, 0, 1);
}

interface TextSignals {
  density: number;
  hookMatches: string[];
  emphasisCount: number;
  laughterCount: number;
}

/** Compute every text-derived signal from the words that fall inside a window. */
function textSignals(
  windowWords: TranscriptWord[],
  windowLen: number,
  hookPhrases: readonly string[],
): TextSignals {
  let spoken = 0;
  let emphasisCount = 0;
  let laughterCount = 0;
  const spokenTokens: string[] = [];

  for (const { word } of windowWords) {
    if (isLaughter(word)) {
      laughterCount++;
      continue;
    }
    spoken++;
    spokenTokens.push(word.toLowerCase());
    if (EMPHASIS.test(word)) emphasisCount++;
  }

  const haystack = spokenTokens.join(" ");
  const hookMatches: string[] = [];
  for (const phrase of hookPhrases) {
    if (phrase && haystack.includes(phrase.toLowerCase())) hookMatches.push(phrase);
  }

  return {
    density: windowLen > 0 ? spoken / windowLen : 0,
    hookMatches,
    emphasisCount,
    laughterCount,
  };
}

function signal(raw: number, weight: number, reason: string): SignalScore {
  return { raw, weight, score: weight * raw, reason };
}

/**
 * Slide a window across the transcript and score every position, returning one
 * {@link Candidate} per window in start order.
 *
 * The scan runs from 0 to the last word's end, one window of `windowLen`
 * seconds at a time, advancing by `step`. A transcript shorter than the window
 * yields a single candidate spanning what exists.
 *
 * @param transcript word-timed segments (the transcription output).
 * @param energy per-second RMS energy; index `i` covers `[i, i+1)` s. May be
 *   empty — the energy signal then simply contributes nothing.
 */
export function scoreWindows(
  transcript: TranscriptSegment[],
  energy: number[],
  options: ScoreWindowsOptions = {},
): Candidate[] {
  const minLen = options.minLen ?? 15;
  const maxLen = options.maxLen ?? 90;
  if (minLen <= 0 || maxLen < minLen) {
    throw new Error(`invalid clip length bounds: minLen=${minLen}, maxLen=${maxLen}`);
  }
  const windowLen = clamp(options.windowLen ?? 30, minLen, maxLen);
  const step = options.step ?? 5;
  if (step <= 0) throw new Error(`step must be > 0, got ${step}`);
  const hookPhrases = options.hookPhrases ?? DEFAULT_HOOK_PHRASES;
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };

  const words = flattenWords(transcript);
  if (words.length === 0) return [];

  const timelineEnd = words.reduce((max, w) => Math.max(max, w.end), 0);
  const globalMax = energy.reduce((max, v) => Math.max(max, v), 0);

  // Last window starts so it ends at the timeline end; never past it. When the
  // whole transcript is shorter than one window, scan the single [0, end] slot.
  const lastStart = Math.max(0, timelineEnd - windowLen);
  const candidates: Candidate[] = [];

  for (let start = 0; start <= lastStart + 1e-9; start += step) {
    const end = Math.min(start + windowLen, timelineEnd);
    const windowWords = words.filter((w) => w.start >= start && w.start < end);
    const text = textSignals(windowWords, end - start, hookPhrases);

    const signals: Record<SignalName, SignalScore> = {
      energy: signal(energySignal(energy, start, end, globalMax), weights.energy, "high energy"),
      speechDensity: signal(
        clamp(text.density / DENSITY_FULL, 0, 1),
        weights.speechDensity,
        `dense speech (${text.density.toFixed(1)} words/s)`,
      ),
      hook: signal(
        clamp(text.hookMatches.length / HOOK_FULL, 0, 1),
        weights.hook,
        text.hookMatches.length > 0
          ? `hook phrase: ${text.hookMatches.join(", ")}`
          : "hook phrase",
      ),
      emphasis: signal(
        clamp(text.emphasisCount / EMPHASIS_FULL, 0, 1),
        weights.emphasis,
        "emphatic delivery",
      ),
      laughter: signal(
        text.laughterCount > 0 ? 1 : 0,
        weights.laughter,
        "laughter",
      ),
    };

    const total = (Object.keys(signals) as SignalName[]).reduce(
      (sum, name) => sum + signals[name].score,
      0,
    );
    const reasons = (Object.keys(signals) as SignalName[])
      .filter((name) => signals[name].raw > 0)
      .sort((a, b) => signals[b].score - signals[a].score)
      .map((name) => signals[name].reason);

    candidates.push({ start, end, score: total, signals, reasons });

    if (lastStart === 0) break; // single-window transcript: no second position
  }

  return candidates;
}
