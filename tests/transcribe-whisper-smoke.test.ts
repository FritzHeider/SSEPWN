import { describe, expect, it } from "vitest";

import { probeAudio } from "../src/lib/ffmpeg/exec";
import { WhisperCppTranscriber } from "../src/lib/transcribe/whisper";
import type { TranscriptSegment } from "../src/lib/transcribe/types";

/**
 * The only test that runs REAL whisper.cpp (phase-03: "Optional real-whisper
 * smoke test, skipped unless WHISPER_SMOKE=1").
 *
 * Opt-in rather than auto-detected: probing for the binary and silently skipping
 * would make "whisper is broken" and "whisper is absent" look identical, so CI
 * would stay green the day the spawn path regresses. Requiring an explicit
 * WHISPER_SMOKE=1 means the machines that set it have whisper on purpose, and a
 * failure there is a real failure. Everything below is covered without whisper
 * by transcribe-whisper.test.ts (parser against a checked-in sample, WAV
 * extraction, error paths); what only a real run can prove is that the binary
 * spawns, accepts our exact arg array, and emits JSON our parser still reads.
 *
 * Enable with:
 *   WHISPER_SMOKE=1 WHISPER_BIN=/path/to/whisper-cli WHISPER_MODEL=/path/to/ggml-base.en.bin npm test
 */

const SHORT_SAMPLE = "fixtures/short-sample.mp4";
const enabled = process.env.WHISPER_SMOKE === "1";

describe.skipIf(!enabled)("WhisperCppTranscriber against the real binary", () => {
  it("transcribes a fixture into well-formed segments", async () => {
    const { duration } = await probeAudio(SHORT_SAMPLE);
    const segments: TranscriptSegment[] = await new WhisperCppTranscriber().transcribe(SHORT_SAMPLE);

    // Deliberately NOT asserting any text. scripts/make-fixtures.sh builds this
    // fixture from a 440 Hz sine — there is no speech in it, so whisper may
    // legitimately return zero segments, and pinning expected words here would
    // assert a hallucination. What is being smoke-tested is the contract:
    // the binary ran, exited 0, and produced JSON the parser turned into the
    // app's shape. Anything it DID hear must still be well-formed.
    expect(Array.isArray(segments)).toBe(true);

    for (const segment of segments) {
      expect(typeof segment.text).toBe("string");
      expect(segment.end).toBeGreaterThanOrEqual(segment.start);
      expect(segment.start).toBeGreaterThanOrEqual(0);
      // Whisper pads to the analysis window, so allow a small tail past the
      // source duration rather than flaking on a boundary that is not a bug.
      expect(segment.end).toBeLessThanOrEqual(duration + 1);

      let previousStart = -Infinity;
      for (const word of segment.words) {
        expect(word.word.length).toBeGreaterThan(0);
        expect(word.end).toBeGreaterThanOrEqual(word.start);
        expect(word.start).toBeGreaterThanOrEqual(previousStart);
        previousStart = word.start;
      }
    }
  }, 120_000);
});
