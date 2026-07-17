import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Transcriber, TranscriptSegment, TranscriptWord } from "./types";

/**
 * Where the canned transcripts live.
 *
 * SPEC/phase-03 wording says `fixtures/transcripts/`, but `.gitignore` has a
 * bare `fixtures/` rule that git applies at ANY depth, so a transcript written
 * there would never be committed and `npm test` would fail on a fresh clone
 * while passing locally. These are hand-authored source, not `make-fixtures.sh`
 * output, so they live beside the whisper sample instead. See DEC-006/DEC-007.
 */
export const DEFAULT_TRANSCRIPT_DIR = "tests/samples/transcripts";

export interface FakeTranscriberOptions {
  /** Directory holding `<media-basename>.json` transcripts. */
  dir?: string;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function describe(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "an array" : typeof value;
}

function parseWord(value: unknown, where: string): TranscriptWord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object, got ${describe(value)}`);
  }
  const word = value as Record<string, unknown>;
  if (typeof word.word !== "string" || word.word.length === 0) {
    throw new Error(`${where}.word must be a non-empty string`);
  }
  if (!isFiniteNumber(word.start) || !isFiniteNumber(word.end)) {
    throw new Error(`${where} must have numeric start/end in seconds`);
  }
  if (word.end < word.start) {
    throw new Error(`${where} ends (${word.end}) before it starts (${word.start})`);
  }
  return { word: word.word, start: word.start, end: word.end };
}

function parseSegment(value: unknown, where: string): TranscriptSegment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object, got ${describe(value)}`);
  }
  const segment = value as Record<string, unknown>;
  if (typeof segment.text !== "string") {
    throw new Error(`${where}.text must be a string`);
  }
  if (!isFiniteNumber(segment.start) || !isFiniteNumber(segment.end)) {
    throw new Error(`${where} must have numeric start/end in seconds`);
  }
  if (segment.end < segment.start) {
    throw new Error(`${where} ends (${segment.end}) before it starts (${segment.start})`);
  }
  if (!Array.isArray(segment.words)) {
    throw new Error(`${where}.words must be an array of { word, start, end }`);
  }

  return {
    text: segment.text,
    start: segment.start,
    end: segment.end,
    words: segment.words.map((word, i) => parseWord(word, `${where}.words[${i}]`)),
  };
}

/**
 * Validate a transcript fixture into `TranscriptSegment[]`.
 *
 * Exported for tests. The checking is not ceremony: these files are hand-edited,
 * and TypeScript's types evaporate at runtime — an unvalidated `JSON.parse` cast
 * would let a typo (`start: "1.5"`) travel all the way into Phase 04's scoring
 * arithmetic, where it surfaces as a silent NaN rather than a bad fixture.
 */
export function parseTranscriptFixture(raw: string, source: string): TranscriptSegment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Transcript fixture "${source}" is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Transcript fixture "${source}" must be an array of segments, got ${describe(parsed)}`,
    );
  }
  return parsed.map((segment, i) => {
    try {
      return parseSegment(segment, `segment[${i}]`);
    } catch (error) {
      throw new Error(`Transcript fixture "${source}": ${(error as Error).message}`);
    }
  });
}

/**
 * `Transcriber` that replays a checked-in transcript instead of running
 * whisper.cpp (SPEC.md § Tech stack: "never call real whisper in the default
 * test suite"). Selected by `TRANSCRIBER=fake`.
 *
 * The transcript is chosen by the media file's basename — `long-sample.mp4`
 * (or an extracted `long-sample.wav`) replays `long-sample.json` — so the fake
 * runs through the exact same pipeline the real transcriber does, keyed off the
 * path the job handler already has.
 */
export class FakeTranscriber implements Transcriber {
  private readonly dir: string;

  constructor(options: FakeTranscriberOptions = {}) {
    this.dir = options.dir ?? DEFAULT_TRANSCRIPT_DIR;
  }

  async transcribe(audioPath: string): Promise<TranscriptSegment[]> {
    const stem = path.basename(audioPath, path.extname(audioPath));
    const fixture = path.join(this.dir, `${stem}.json`);

    let raw: string;
    try {
      raw = await readFile(fixture, "utf8");
    } catch (error) {
      // Resolving to [] here would be indistinguishable from a silent video and
      // would quietly produce an empty transcript, so this fails loudly instead.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `No fake transcript for "${path.basename(audioPath)}" — expected a fixture at ` +
            `"${fixture}". Add one, or unset TRANSCRIBER=fake to use real whisper.cpp ` +
            `(see README.md § Transcription).`,
        );
      }
      throw error;
    }

    return parseTranscriptFixture(raw, fixture);
  }
}
