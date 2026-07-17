import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractWav, WHISPER_CHANNELS, WHISPER_SAMPLE_RATE } from "../src/lib/ffmpeg/audio";
import { probeAudio } from "../src/lib/ffmpeg/exec";
import { parseWhisperJson, WhisperCppTranscriber, wordsFromTokens } from "../src/lib/transcribe/whisper";

// Stereo 48 kHz on purpose: the other fixtures are already mono, so they cannot
// tell a real downmix apart from a missing `-ac 1`. See scripts/make-fixtures.sh.
const STEREO_SAMPLE = "fixtures/stereo-sample.mp4";
const NO_AUDIO = "fixtures/no-audio.mp4";
const SAMPLE_JSON = "tests/samples/whisper-full-output.json";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "sseclone-wav-test-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("extractWav", () => {
  it("produces 16 kHz mono PCM from a stereo 48 kHz source", async () => {
    const dest = path.join(workDir, "out.wav");
    await extractWav(STEREO_SAMPLE, dest);

    const source = await probeAudio(STEREO_SAMPLE);
    expect(source.channels, "fixture must be stereo or this test proves nothing").toBe(2);
    expect(source.sampleRate).toBe(48_000);

    const wav = await probeAudio(dest);
    expect(wav.sampleRate).toBe(WHISPER_SAMPLE_RATE);
    expect(wav.channels).toBe(WHISPER_CHANNELS);
    expect(wav.codec).toBe("pcm_s16le");
    expect(wav.duration).toBeGreaterThan(2.5);
  });

  it("creates the destination directory if it does not exist", async () => {
    const dest = path.join(workDir, "nested", "deeper", "out.wav");
    await extractWav(STEREO_SAMPLE, dest);
    expect((await probeAudio(dest)).sampleRate).toBe(WHISPER_SAMPLE_RATE);
  });

  it("rejects a source with no audio track", async () => {
    await expect(extractWav(NO_AUDIO, path.join(workDir, "silent.wav"))).rejects.toThrow();
  });

  it("rejects a nonexistent source", async () => {
    await expect(
      extractWav("fixtures/does-not-exist.mp4", path.join(workDir, "missing.wav")),
    ).rejects.toThrow();
  });
});

describe("parseWhisperJson", () => {
  let segments: Awaited<ReturnType<typeof parseWhisperJson>>;

  beforeAll(async () => {
    segments = parseWhisperJson(await readFile(SAMPLE_JSON, "utf8"));
  });

  it("parses every segment, not just the first", () => {
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe("Here's the secret nobody tells you.");
    expect(segments[1].text).toBe("That result was unbelievable. [laughter]");
  });

  it("reads numeric second offsets, not the formatted timestamp strings", () => {
    expect(segments[0].start).toBe(0);
    expect(segments[0].end).toBeCloseTo(2.56, 5);
    expect(segments[1].start).toBeCloseTo(2.56, 5);
    expect(segments[1].end).toBeCloseTo(5.12, 5);
    for (const segment of segments) {
      expect(typeof segment.start).toBe("number");
      expect(typeof segment.end).toBe("number");
    }
  });

  it("emits word-level timings that are monotonic and inside the segment", () => {
    for (const segment of segments) {
      expect(segment.words.length).toBeGreaterThan(0);
      let previousEnd = -Infinity;
      for (const word of segment.words) {
        expect(word.start).toBeGreaterThanOrEqual(previousEnd);
        expect(word.end).toBeGreaterThanOrEqual(word.start);
        expect(word.start).toBeGreaterThanOrEqual(segment.start);
        expect(word.end).toBeLessThanOrEqual(segment.end + 1e-9);
        previousEnd = word.start;
      }
    }
  });

  it("glues sub-word tokens back into whole words", () => {
    // " nob" + "ody" and " unbeliev" + "able" — a per-token parser would leak
    // the pieces instead. Punctuation has no leading space, so it lands on the
    // word it follows ("you."), which is what a caption should render.
    const first = segments[0].words.map((w) => w.word);
    expect(first).toEqual(["Here's", "the", "secret", "nobody", "tells", "you."]);

    const nobody = segments[0].words.find((w) => w.word === "nobody");
    expect(nobody).toBeDefined();
    // Spans both tokens: starts at " nob" (1.10) and ends at "ody" (1.60).
    expect(nobody?.start).toBeCloseTo(1.1, 5);
    expect(nobody?.end).toBeCloseTo(1.6, 5);

    expect(segments[1].words.map((w) => w.word)).toContain("unbelievable.");
  });

  it("drops whisper control tokens but keeps transcript markers like [laughter]", () => {
    const allWords = segments.flatMap((s) => s.words.map((w) => w.word));
    expect(allWords).not.toContain("[_BEG_]");
    expect(allWords).not.toContain("[_TT_128]");
    expect(allWords.some((w) => w.includes("_BEG_") || w.includes("_TT_"))).toBe(false);
    // Phase 04 scores laughter, so an over-broad bracket filter would be a bug.
    expect(allWords).toContain("[laughter]");
  });

  it("rejects non-JSON and JSON without a transcription array", () => {
    expect(() => parseWhisperJson("not json at all")).toThrow(/not valid JSON/i);
    expect(() => parseWhisperJson(JSON.stringify({ result: {} }))).toThrow(/transcription/i);
  });

  it("wordsFromTokens returns nothing for an empty token list", () => {
    expect(wordsFromTokens([])).toEqual([]);
  });

  it("wordsFromTokens drops only `[_..._]` control tokens, not single-token markers", () => {
    // The sample fixture splits "[laughter]" across three tokens, so it cannot
    // tell a precise filter from a bracket-greedy one — the word is assembled
    // after filtering, and no single token ever looks like "[...]". whisper does
    // emit whole-bracket tokens though ("[BLANK_AUDIO]", and markers Phase 04
    // scores), so the distinction is pinned here at the unit level instead.
    const words = wordsFromTokens([
      { text: "[_BEG_]", offsets: { from: 0, to: 0 } },
      { text: " [laughter]", offsets: { from: 100, to: 400 } },
      { text: " [BLANK_AUDIO]", offsets: { from: 400, to: 900 } },
      { text: " okay", offsets: { from: 900, to: 1200 } },
      { text: "[_TT_310]", offsets: { from: 1200, to: 1200 } },
    ]);

    expect(words.map((w) => w.word)).toEqual(["[laughter]", "[BLANK_AUDIO]", "okay"]);
    expect(words[0].start).toBeCloseTo(0.1, 5);
    expect(words[0].end).toBeCloseTo(0.4, 5);
  });
});

describe("WhisperCppTranscriber errors", () => {
  it("names WHISPER_MODEL when the model file is missing", async () => {
    const transcriber = new WhisperCppTranscriber({
      bin: "whisper-cli",
      model: "models/definitely-not-here.bin",
    });
    await expect(transcriber.transcribe(STEREO_SAMPLE)).rejects.toThrow(/WHISPER_MODEL/);
  });

  it("names WHISPER_BIN when the binary is missing", async () => {
    // The model check runs first, so point it at a file that really exists.
    const transcriber = new WhisperCppTranscriber({
      bin: "sseclone-no-such-whisper-binary",
      model: SAMPLE_JSON,
      tmpDir: workDir,
    });
    await expect(transcriber.transcribe(STEREO_SAMPLE)).rejects.toThrow(/WHISPER_BIN/);
  });

  it("reports a missing input file before touching whisper", async () => {
    const transcriber = new WhisperCppTranscriber({ model: SAMPLE_JSON });
    await expect(transcriber.transcribe("fixtures/does-not-exist.mp4")).rejects.toThrow(
      /file not found/i,
    );
  });
});
