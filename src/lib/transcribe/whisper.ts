import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";

import { extractWav } from "../ffmpeg/audio";
import type { Transcriber, TranscriptSegment, TranscriptWord } from "./types";

/** Defaults documented in README.md § Transcription. */
export const DEFAULT_WHISPER_BIN = "whisper-cli";
export const DEFAULT_WHISPER_MODEL = "models/ggml-base.en.bin";

export function whisperBin(): string {
  return process.env.WHISPER_BIN || DEFAULT_WHISPER_BIN;
}

export function whisperModel(): string {
  return process.env.WHISPER_MODEL || DEFAULT_WHISPER_MODEL;
}

/**
 * whisper.cpp's own control tokens: `[_BEG_]`, `[_TT_128]`, `[_SOT_]`, …
 *
 * The leading `[_` is the whole signal — anchoring on a trailing `_]` instead
 * would miss `[_TT_128]` (it ends `8]`), and matching brackets alone would eat
 * transcript markers like `[laughter]` that Phase 04 scores on.
 */
const SPECIAL_TOKEN = /^\[_.*\]$/;

interface WhisperToken {
  text?: string;
  offsets?: { from?: number; to?: number };
}

interface WhisperSegment {
  text?: string;
  offsets?: { from?: number; to?: number };
  tokens?: WhisperToken[];
}

interface WhisperOutput {
  transcription?: WhisperSegment[];
}

/** whisper.cpp reports offsets in milliseconds; the rest of the app is seconds. */
function toSeconds(ms: number | undefined): number {
  return (ms ?? 0) / 1000;
}

/**
 * Rebuild words from whisper's sub-word tokens.
 *
 * whisper.cpp emits BPE pieces, not words: "nobody" arrives as " nob" + "ody"
 * and "unbelievable" as " unbeliev" + "able". A leading space is the only
 * signal that a new word starts, so pieces are glued onto the current word
 * until the next space-prefixed token. Emitting tokens as-is would give
 * captions that visibly break words in half.
 */
export function wordsFromTokens(tokens: WhisperToken[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];

  for (const token of tokens) {
    const raw = token.text ?? "";
    // Control tokens carry no speech and would otherwise be rendered as words.
    // Matched by the `[_..._]` shape specifically, so a transcript marker like
    // "[laughter]" — which Phase 04 scores as a laughter signal — survives.
    if (!raw || SPECIAL_TOKEN.test(raw.trim())) continue;

    const start = toSeconds(token.offsets?.from);
    const end = toSeconds(token.offsets?.to);
    const startsWord = raw.startsWith(" ");
    const text = raw.trim();
    if (!text) continue;

    const current = words[words.length - 1];
    if (startsWord || !current) {
      words.push({ word: text, start, end });
    } else {
      current.word += text;
      current.end = end;
    }
  }

  return words;
}

/**
 * Parse whisper.cpp's `--output-json --output-json-full` document into the
 * app's `TranscriptSegment[]`.
 *
 * Exported so it can be tested against a checked-in sample of the real output
 * format without whisper installed (tests/samples/whisper-full-output.json).
 */
export function parseWhisperJson(raw: string): TranscriptSegment[] {
  let parsed: WhisperOutput;
  try {
    parsed = JSON.parse(raw) as WhisperOutput;
  } catch {
    throw new Error("whisper.cpp produced output that is not valid JSON");
  }

  const transcription = parsed.transcription;
  if (!Array.isArray(transcription)) {
    throw new Error(
      "whisper.cpp JSON has no `transcription` array — expected output from `--output-json-full`",
    );
  }

  return transcription.map((segment) => ({
    text: (segment.text ?? "").trim(),
    start: toSeconds(segment.offsets?.from),
    end: toSeconds(segment.offsets?.to),
    words: wordsFromTokens(segment.tokens ?? []),
  }));
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export interface WhisperCppOptions {
  bin?: string;
  model?: string;
  /** Scratch space for the extracted WAV; defaults to the OS temp dir. */
  tmpDir?: string;
}

/**
 * `Transcriber` backed by the whisper.cpp CLI (SPEC.md § Tech stack).
 *
 * Never used by the default test suite — tests select `FakeTranscriber` — so
 * `npm test` passes on a machine with no whisper binary and no model.
 */
export class WhisperCppTranscriber implements Transcriber {
  private readonly bin: string;
  private readonly model: string;
  private readonly tmp: string;

  constructor(options: WhisperCppOptions = {}) {
    this.bin = options.bin ?? whisperBin();
    this.model = options.model ?? whisperModel();
    this.tmp = options.tmpDir ?? tmpdir();
  }

  async transcribe(audioPath: string): Promise<TranscriptSegment[]> {
    if (!(await exists(audioPath))) {
      throw new Error(`Cannot transcribe "${audioPath}": file not found.`);
    }
    // Checked before spawning: whisper.cpp reports a missing model with an
    // opaque non-zero exit, and "load failed" tells the user nothing about
    // which path to fix.
    if (!(await exists(this.model))) {
      throw new Error(
        `whisper model not found at "${this.model}". Download a ggml model and set WHISPER_MODEL ` +
          `to its path (see README.md § Transcription).`,
      );
    }

    const workDir = path.join(this.tmp, `sseclone-whisper-${randomUUID()}`);
    await mkdir(workDir, { recursive: true });
    const wavPath = path.join(workDir, "audio.wav");
    const outBase = path.join(workDir, "out");

    try {
      await extractWav(audioPath, wavPath);

      await execa(this.bin, [
        "--model",
        this.model,
        "--file",
        wavPath,
        "--output-json",
        "--output-json-full",
        "--output-file",
        outBase,
        "--no-prints",
      ]);

      return parseWhisperJson(await readFile(`${outBase}.json`, "utf8"));
    } catch (error) {
      throw new Error(this.describeFailure(error), { cause: error });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * A spawn ENOENT here means the *binary* is missing, but the raw message
   * ("spawn whisper-cli ENOENT") reads like an app bug and names no fix. Every
   * other failure keeps whisper's own stderr, which is the useful part.
   */
  private describeFailure(error: unknown): string {
    const code = (error as { code?: string })?.code;
    const message = error instanceof Error ? error.message : String(error);

    if (code === "ENOENT" && message.includes(this.bin)) {
      return (
        `whisper.cpp binary not found at "${this.bin}". Install whisper.cpp and set WHISPER_BIN ` +
        `to the built CLI (see README.md § Transcription).`
      );
    }
    return `whisper.cpp transcription failed: ${message}`;
  }
}
