/**
 * Pure caption-document editing (SPEC.md § Captions, Phase 05 "Caption editing
 * API"). Backs `PATCH /api/clips/:id/captions`.
 *
 * A caption document (`CaptionDoc` = cues of lines of words + a style) is built
 * once from the project transcript with `buildCaptionDoc`, then edited
 * clip-locally: every operation here returns a NEW document and NEVER touches
 * the transcript it was sliced from. That is the isolation rule the SPEC
 * requires — word edits are the clip's own copy, so the same transcript can
 * back many clips with divergent captions.
 *
 * The operations are the four the SPEC lists — edit a word's text, merge two
 * lines, split a line, shift a line's timing — plus a style change. All are
 * pure data-in/data-out (no ffmpeg, no database, no clock) so the whole edit
 * core is deterministic and unit-testable.
 *
 * Lines are addressed by a FLAT index across every cue, because cue grouping is
 * a display detail (`maxLines` lines per on-screen block) that the editor should
 * not have to reason about. After each edit the flat line list is re-grouped
 * into cues with the same `groupCues` used when the document was first built, so
 * the structure stays consistent no matter how the lines were reshaped.
 */

import {
  DEFAULT_MAX_LINES,
  clipCaptions,
  groupCues,
  type CaptionLine,
  type CaptionWord,
  type ClipCaptionsOptions,
} from "./clip";
import {
  DEFAULT_CAPTION_PRESET,
  getPreset,
  parseStyle,
  resolveStyle,
  type CaptionStyle,
} from "./style";
import type { CaptionDoc } from "./ass";
import type { TranscriptSegment } from "../transcribe/types";

/** Thrown when an edit references a line/word that does not exist, or is malformed. */
export class CaptionEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptionEditError";
  }
}

/** Replace the text of a single word (timing untouched). */
export interface SetWordEdit {
  op: "set-word";
  line: number;
  word: number;
  text: string;
}

/** Shift every word in a line by `delta` seconds (clamped so no time goes negative). */
export interface ShiftLineEdit {
  op: "shift-line";
  line: number;
  delta: number;
}

/** Merge line `line` with the line after it into one line. */
export interface MergeLineEdit {
  op: "merge-line";
  line: number;
}

/** Split line `line` before word `word`; words `[word..]` become a new line. */
export interface SplitLineEdit {
  op: "split-line";
  line: number;
  word: number;
}

/** Change the caption style — a preset switch and/or field overrides. */
export interface SetStyleEdit {
  op: "set-style";
  /** Raw client style object; cleaned by `parseStyle`. */
  style: unknown;
}

export type CaptionEdit =
  | SetWordEdit
  | ShiftLineEdit
  | MergeLineEdit
  | SplitLineEdit
  | SetStyleEdit;

export const CAPTION_EDIT_OPS: readonly CaptionEdit["op"][] = [
  "set-word",
  "shift-line",
  "merge-line",
  "split-line",
  "set-style",
];

/** Build a fresh caption document for a clip from the project transcript. */
export function buildCaptionDoc(
  transcript: TranscriptSegment[],
  clipIn: number,
  clipOut: number,
  style?: unknown,
  options: ClipCaptionsOptions = {},
): CaptionDoc {
  const clean = parseStyle(style);
  return {
    cues: clipCaptions(transcript, clipIn, clipOut, options),
    style: resolveStyle(style),
    // Self-describing ASS Style name = the preset the look came from, so the
    // downstream `.ass` file carries which preset produced it.
    name: clean.preset ?? DEFAULT_CAPTION_PRESET,
  };
}

/** Read a caption document back out of a `clip_edits.state` blob, or null if absent/malformed. */
export function readCaptionDoc(state: unknown): CaptionDoc | null {
  if (typeof state !== "object" || state === null) return null;
  const captions = (state as Record<string, unknown>).captions;
  if (typeof captions !== "object" || captions === null) return null;
  const doc = captions as Record<string, unknown>;
  // Light shape guard — this is our own persisted data, not a client body.
  if (!Array.isArray(doc.cues)) return null;
  if (typeof doc.style !== "object" || doc.style === null) return null;
  return captions as CaptionDoc;
}

/**
 * Validate an untrusted PATCH body into a `CaptionEdit`, or null if malformed.
 * Field-shape only — whether the referenced line/word actually exists is checked
 * against the live document in `applyCaptionEdit`.
 */
export function parseEdit(input: unknown): CaptionEdit | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  switch (raw.op) {
    case "set-word":
      if (!isIndex(raw.line) || !isIndex(raw.word) || typeof raw.text !== "string") return null;
      return { op: "set-word", line: raw.line, word: raw.word, text: raw.text };
    case "shift-line":
      if (!isIndex(raw.line) || typeof raw.delta !== "number" || !Number.isFinite(raw.delta)) {
        return null;
      }
      return { op: "shift-line", line: raw.line, delta: raw.delta };
    case "merge-line":
      if (!isIndex(raw.line)) return null;
      return { op: "merge-line", line: raw.line };
    case "split-line":
      if (!isIndex(raw.line) || !isIndex(raw.word)) return null;
      return { op: "split-line", line: raw.line, word: raw.word };
    case "set-style":
      if (typeof raw.style !== "object" || raw.style === null) return null;
      return { op: "set-style", style: raw.style };
    default:
      return null;
  }
}

/**
 * Apply one edit to a caption document, returning a new document. The input is
 * never mutated. Throws `CaptionEditError` when the edit references a
 * non-existent line or word (a client mistake the route surfaces as a 400).
 */
export function applyCaptionEdit(
  doc: CaptionDoc,
  edit: CaptionEdit,
  maxLines: number = DEFAULT_MAX_LINES,
): CaptionDoc {
  if (edit.op === "set-style") return applyStyleEdit(doc, edit);

  const lines = flattenLines(doc);
  switch (edit.op) {
    case "set-word": {
      const line = lineAt(lines, edit.line);
      const words = wordsCopy(line);
      if (edit.word >= words.length) {
        throw new CaptionEditError(`Word ${edit.word} out of range on line ${edit.line}`);
      }
      const text = edit.text.trim();
      if (text.length === 0) throw new CaptionEditError("Word text cannot be empty");
      words[edit.word] = { ...words[edit.word], text };
      lines[edit.line] = rebuildLine(words);
      break;
    }
    case "shift-line": {
      const line = lineAt(lines, edit.line);
      const words = line.words.map((w) => ({
        ...w,
        start: Math.max(0, w.start + edit.delta),
        end: Math.max(0, w.end + edit.delta),
      }));
      lines[edit.line] = rebuildLine(words);
      break;
    }
    case "merge-line": {
      lineAt(lines, edit.line);
      if (edit.line + 1 >= lines.length) {
        throw new CaptionEditError(`No line after ${edit.line} to merge with`);
      }
      const merged = rebuildLine([...lines[edit.line].words, ...lines[edit.line + 1].words]);
      lines.splice(edit.line, 2, merged);
      break;
    }
    case "split-line": {
      const line = lineAt(lines, edit.line);
      if (edit.word <= 0 || edit.word >= line.words.length) {
        throw new CaptionEditError(`Cannot split line ${edit.line} at word ${edit.word}`);
      }
      const left = rebuildLine(line.words.slice(0, edit.word));
      const right = rebuildLine(line.words.slice(edit.word));
      lines.splice(edit.line, 1, left, right);
      break;
    }
  }

  return { ...doc, cues: groupCues(lines, maxLines) };
}

function applyStyleEdit(doc: CaptionDoc, edit: SetStyleEdit): CaptionDoc {
  const { preset, ...overrides } = parseStyle(edit.style);
  // A preset switch rebases the whole look; field overrides layer on the
  // CURRENT style so a lone color change keeps everything else the clip had.
  const base: CaptionStyle = preset ? getPreset(preset) : doc.style;
  return {
    ...doc,
    style: { ...base, ...overrides },
    name: preset ?? doc.name,
  };
}

/** Every line across every cue, in order, as a fresh array (safe to mutate). */
export function flattenLines(doc: CaptionDoc): CaptionLine[] {
  return doc.cues.flatMap((cue) => cue.lines);
}

function lineAt(lines: CaptionLine[], index: number): CaptionLine {
  const line = lines[index];
  if (!line) throw new CaptionEditError(`Line ${index} out of range (have ${lines.length})`);
  return line;
}

function wordsCopy(line: CaptionLine): CaptionWord[] {
  return line.words.map((w) => ({ ...w }));
}

/** Rebuild a line's derived text/start/end from its (possibly reordered) words. */
function rebuildLine(words: CaptionWord[]): CaptionLine {
  const sorted = [...words].sort((a, b) => a.start - b.start || a.end - b.end);
  return {
    words: sorted,
    text: sorted.map((w) => w.text).join(" "),
    start: sorted[0].start,
    end: sorted[sorted.length - 1].end,
  };
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
