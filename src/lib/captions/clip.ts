/**
 * Pure caption slicing and grouping (SPEC.md § Captions, Phase 05
 * `clipCaptions`).
 *
 * Turns a project transcript into a clip-local caption document: word-timed,
 * re-based so a clip that starts at 42 s in the source begins at 0 s, and
 * grouped into display lines and cues. Like the highlight scorer this is pure
 * data-in/data-out — no ffmpeg, no database, no clock — so the whole
 * caption core is deterministic and unit-testable, and later stages (`toAss`,
 * the editor UI, burn-in) all read the same shape.
 *
 * Two rules drive the design:
 *  - Partial-overlap words are CLAMPED, never dropped. A word that begins
 *    before the clip's in-point but is still being spoken when the clip starts
 *    belongs to the clip; its timing is trimmed to the clip window, not
 *    discarded. Dropping it would swallow the first (or last) spoken word.
 *  - A word is never split across lines. Grouping packs whole words up to a
 *    character budget; an over-long single word overflows its own line rather
 *    than being broken.
 */

import type { TranscriptSegment } from "../transcribe/types";

/** One caption word, timed relative to the START of the clip (0-based). */
export interface CaptionWord {
  text: string;
  /** Seconds from the start of the clip (not the source media). */
  start: number;
  end: number;
}

/** A single line of caption text: whole words that fit one character budget. */
export interface CaptionLine {
  words: CaptionWord[];
  /** The line's words joined by single spaces. */
  text: string;
  /** First word's start / last word's end, clip-relative. */
  start: number;
  end: number;
}

/**
 * A caption cue — the unit that shows on screen at once. Up to `maxLines`
 * lines (default 2) stacked together; one cue becomes one ASS Dialogue event
 * downstream.
 */
export interface CaptionCue {
  lines: CaptionLine[];
  /** First line's start / last line's end, clip-relative. */
  start: number;
  end: number;
}

export interface ClipCaptionsOptions {
  /** Max characters per line (whole words only). Default 32. */
  maxChars?: number;
  /** Max lines stacked in one on-screen cue. Default 2. */
  maxLines?: number;
}

export const DEFAULT_MAX_CHARS = 32;
export const DEFAULT_MAX_LINES = 2;

/** Floating-point slop so a word ending exactly at the in-point is excluded. */
const EPS = 1e-6;

/**
 * Slice, clamp and re-base the transcript's words to a clip window, then group
 * them into lines and cues.
 *
 * A word is kept when it OVERLAPS `[clipIn, clipOut)` at all — i.e. it starts
 * before the clip ends and ends after the clip begins. Kept words are clamped
 * to the window and shifted so the clip starts at time 0.
 */
export function clipCaptions(
  transcript: TranscriptSegment[],
  clipIn: number,
  clipOut: number,
  options: ClipCaptionsOptions = {},
): CaptionCue[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  if (!(clipOut > clipIn)) return [];

  const words = sliceWords(transcript, clipIn, clipOut);
  const lines = groupLines(words, maxChars);
  return groupCues(lines, maxLines);
}

/** Keep overlapping words, clamp to the window, re-base to clip-relative time. */
export function sliceWords(
  transcript: TranscriptSegment[],
  clipIn: number,
  clipOut: number,
): CaptionWord[] {
  const kept: CaptionWord[] = [];
  for (const segment of transcript) {
    for (const word of segment.words) {
      // Overlap test: starts before the clip ends AND ends after it begins.
      if (word.start >= clipOut - EPS || word.end <= clipIn + EPS) continue;
      const start = Math.max(word.start, clipIn) - clipIn;
      const end = Math.min(word.end, clipOut) - clipIn;
      const text = word.word.trim();
      if (text.length === 0) continue;
      kept.push({ text, start, end });
    }
  }
  // Words arrive in transcript order; enforce start-time order defensively so
  // grouping and karaoke timing never depend on segment authoring order.
  kept.sort((a, b) => a.start - b.start || a.end - b.end);
  return kept;
}

/** Greedy-pack whole words into lines no wider than `maxChars` characters. */
export function groupLines(words: CaptionWord[], maxChars: number): CaptionLine[] {
  const budget = Math.max(1, maxChars);
  const lines: CaptionLine[] = [];
  let current: CaptionWord[] = [];
  let width = 0;

  const flush = () => {
    if (current.length === 0) return;
    lines.push(makeLine(current));
    current = [];
    width = 0;
  };

  for (const word of words) {
    // Width if this word joins the current line (+1 for the leading space).
    const added = current.length === 0 ? word.text.length : width + 1 + word.text.length;
    if (current.length > 0 && added > budget) flush();
    current.push(word);
    width = current.length === 1 ? word.text.length : added;
  }
  flush();
  return lines;
}

/** Stack consecutive lines into cues of at most `maxLines` lines each. */
export function groupCues(lines: CaptionLine[], maxLines: number): CaptionCue[] {
  const perCue = Math.max(1, maxLines);
  const cues: CaptionCue[] = [];
  for (let i = 0; i < lines.length; i += perCue) {
    const group = lines.slice(i, i + perCue);
    cues.push({
      lines: group,
      start: group[0].start,
      end: group[group.length - 1].end,
    });
  }
  return cues;
}

function makeLine(words: CaptionWord[]): CaptionLine {
  return {
    words,
    text: words.map((w) => w.text).join(" "),
    start: words[0].start,
    end: words[words.length - 1].end,
  };
}
