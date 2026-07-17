import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_TRANSCRIPT_DIR,
  FakeTranscriber,
  parseTranscriptFixture,
} from "../src/lib/transcribe/fake";
import { probe } from "../src/lib/ffmpeg/exec";
import type { TranscriptSegment } from "../src/lib/transcribe/types";

const LONG_SAMPLE = "fixtures/long-sample.mp4";

let workDir: string;

/** Write a throwaway fixture into a scratch dir and read it back through the fake. */
async function transcribeFixture(name: string, body: string): Promise<TranscriptSegment[]> {
  await writeFile(path.join(workDir, `${name}.json`), body);
  return new FakeTranscriber({ dir: workDir }).transcribe(`/media/${name}.mp4`);
}

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "sseclone-fake-test-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("FakeTranscriber", () => {
  it("replays the transcript matching the media basename", async () => {
    const transcriber = new FakeTranscriber();

    const long = await transcriber.transcribe(LONG_SAMPLE);
    const short = await transcriber.transcribe("fixtures/short-sample.mp4");

    // Two fixtures with different content on purpose: with only one on disk, a
    // transcribe() that ignored audioPath entirely would pass this file.
    expect(long[0].text).not.toBe(short[0].text);
    expect(long.length).toBeGreaterThan(short.length);
    expect(short[short.length - 1].text).toBe("That is all.");
    expect(long[0].text).toContain("six months");
  });

  it("matches on the basename, not the literal path or extension", async () => {
    const transcriber = new FakeTranscriber();

    // The job handler hands over an absolute path, and the whisper path
    // transcribes an extracted .wav — both must find the same transcript.
    const absolute = await transcriber.transcribe(path.resolve(LONG_SAMPLE));
    const wav = await transcriber.transcribe("/tmp/scratch/long-sample.wav");

    expect(absolute).toEqual(await transcriber.transcribe(LONG_SAMPLE));
    expect(wav).toEqual(absolute);
  });

  it("rejects with an actionable error when no fixture matches", async () => {
    const transcriber = new FakeTranscriber();

    // Must not resolve to []: an empty transcript is indistinguishable from a
    // silent video, so a missing fixture would look like a working pipeline.
    const error = await transcriber.transcribe("fixtures/nope.mp4").catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    // Actionable: names the file it wanted, where to put it, and the way out.
    expect((error as Error).message).toContain('No fake transcript for "nope.mp4"');
    expect((error as Error).message).toContain("tests/samples/transcripts/nope.json");
    expect((error as Error).message).toContain("TRANSCRIBER=fake");
  });

  it("defaults to the committed transcript directory", async () => {
    expect(DEFAULT_TRANSCRIPT_DIR).toBe("tests/samples/transcripts");
  });
});

describe("FakeTranscriber sourceName lookup", () => {
  // An upload is stored as data/uploads/<uuid>.mp4, so the path carries no trace
  // of what the media is. These pin the one key that survives that rename.
  const UPLOADED = "/data/uploads/01bf9021-4c1e-4d0a-9d3f-6f2b8a7e5c11.mp4";

  it("resolves the fixture from sourceName when the path is a stored UUID", async () => {
    const segments = await new FakeTranscriber().transcribe(UPLOADED, {
      sourceName: "long-sample.mp4",
    });

    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0].text).toContain("six months");
  });

  it("prefers sourceName over the path when the two name different fixtures", async () => {
    // Both fixtures exist and differ, so this can actually see the ordering — if
    // they named the same transcript the precedence would be inexpressible.
    const segments = await new FakeTranscriber().transcribe("fixtures/short-sample.mp4", {
      sourceName: "long-sample.mp4",
    });

    const short = await new FakeTranscriber().transcribe("fixtures/short-sample.mp4");
    expect(segments[0].text).toContain("six months");
    expect(segments[0].text).not.toBe(short[0].text);
  });

  it("still resolves from the path when no sourceName is given", async () => {
    // The direct-path contract every other caller (unit tests, scripts, an
    // extracted long-sample.wav) relies on. Dropping it would break them all.
    const segments = await new FakeTranscriber().transcribe(LONG_SAMPLE);

    expect(segments[0].text).toContain("six months");
  });

  it("falls through to the path when sourceName has no fixture", async () => {
    const segments = await new FakeTranscriber().transcribe(LONG_SAMPLE, {
      sourceName: "renamed by the user.mp4",
    });

    expect(segments[0].text).toContain("six months");
  });

  it("rejects, naming both candidates, when neither the name nor the path matches", async () => {
    // The failure mode this whole option exists to prevent is a SILENT one: a
    // fake that fell back to its only/first fixture would succeed no matter how
    // badly the pipeline was wired, hiding exactly the bug that produced it.
    const error = await new FakeTranscriber()
      .transcribe(UPLOADED, { sourceName: "My Podcast" })
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('No fake transcript for "My Podcast"');
    // Names the stored path too — seeing the bare UUID is the clue that the
    // name, not the path, is the only usable key.
    expect(message).toContain(UPLOADED);
    expect(message).toContain("tests/samples/transcripts/My Podcast.json");
    expect(message).toContain("01bf9021-4c1e-4d0a-9d3f-6f2b8a7e5c11.json");
  });

  it("cannot be walked out of the transcript directory by a crafted sourceName", async () => {
    // sourceName comes from an uploaded filename — user data at a boundary.
    // A readable fixture sits one level ABOVE the configured dir, so a lookup
    // that traversed would succeed and return its contents. It must not.
    const nested = path.join(workDir, "nested");
    await writeFile(
      path.join(workDir, "escape.json"),
      JSON.stringify([{ text: "escaped", start: 0, end: 1, words: [] }]),
    );

    const error = await new FakeTranscriber({ dir: nested })
      .transcribe("/data/uploads/x.mp4", { sourceName: "../escape.mp4" })
      .catch((e: Error) => e);

    // Rejecting (rather than resolving to the file above) is the whole point:
    // the traversal collapsed to a plain lookup inside the configured dir.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(path.join(nested, "escape.json"));
    expect((error as Error).message).not.toContain(path.join(workDir, "escape.json"));
  });
});

describe("FakeTranscriber fixture validation", () => {
  it("rejects a fixture that is not JSON", async () => {
    await expect(transcribeFixture("broken", "{not json")).rejects.toThrow(/not valid JSON/);
  });

  it("rejects a fixture that is not an array of segments", async () => {
    await expect(transcribeFixture("object", '{"segments": []}')).rejects.toThrow(
      /must be an array of segments, got object/,
    );
  });

  it("rejects a malformed segment even when it is the last one", async () => {
    // Last, not first: a validator that only checked parsed[0] would pass here.
    const body = JSON.stringify([
      { text: "fine", start: 0, end: 1, words: [{ word: "fine", start: 0, end: 1 }] },
      { text: "bad", start: "0.5", end: 2, words: [] },
    ]);

    await expect(transcribeFixture("late", body)).rejects.toThrow(
      /segment\[1\] must have numeric start\/end/,
    );
  });

  it("rejects a segment whose words are missing or malformed", async () => {
    const noWords = JSON.stringify([{ text: "hi", start: 0, end: 1 }]);
    await expect(transcribeFixture("nowords", noWords)).rejects.toThrow(
      /segment\[0\]\.words must be an array/,
    );

    const badWord = JSON.stringify([
      { text: "hi", start: 0, end: 1, words: [{ word: "hi", start: "0", end: 1 }] },
    ]);
    await expect(transcribeFixture("badword", badWord)).rejects.toThrow(
      /segment\[0\]\.words\[0\] must have numeric start\/end/,
    );
  });

  it("rejects backwards timings", async () => {
    const body = JSON.stringify([
      { text: "hi", start: 2, end: 1, words: [{ word: "hi", start: 2, end: 1 }] },
    ]);
    await expect(transcribeFixture("backwards", body)).rejects.toThrow(/ends \(1\) before/);
  });

  it("accepts a well-formed fixture and drops nothing", () => {
    const segments = parseTranscriptFixture(
      JSON.stringify([
        { text: "a b", start: 0, end: 1, words: [{ word: "a", start: 0, end: 0.5 }, { word: "b", start: 0.5, end: 1 }] },
      ]),
      "inline",
    );

    expect(segments).toEqual([
      { text: "a b", start: 0, end: 1, words: [{ word: "a", start: 0, end: 0.5 }, { word: "b", start: 0.5, end: 1 }] },
    ]);
  });
});

/**
 * The 90 s transcript is the input Phase 04's highlight heuristics are built on,
 * so its SHAPE is a contract, not just test data. These assertions are what stop
 * it being quietly edited into something with no hooks, no laughter, or no quiet
 * stretch to score against.
 */
describe("long-sample.json fixture", () => {
  let segments: TranscriptSegment[];
  let duration: number;

  beforeAll(async () => {
    segments = await new FakeTranscriber().transcribe(LONG_SAMPLE);
    duration = (await probe(LONG_SAMPLE)).duration;
  });

  it("covers ~15 sentences within the real media duration", () => {
    expect(duration).toBeCloseTo(90, 1);
    expect(segments.length).toBeGreaterThanOrEqual(15);

    const last = segments[segments.length - 1];
    expect(segments[0].start).toBeGreaterThanOrEqual(0);
    expect(last.end).toBeLessThan(duration);
  });

  it("has word timings that are monotonic across the whole file", () => {
    const words = segments.flatMap((s) => s.words);
    expect(words.length).toBeGreaterThan(100);

    let previousEnd = 0;
    for (const word of words) {
      expect(word.start).toBeGreaterThanOrEqual(previousEnd);
      expect(word.end).toBeGreaterThan(word.start);
      expect(word.end).toBeLessThanOrEqual(duration);
      previousEnd = word.end;
    }
  });

  it("keeps every word inside its own segment", () => {
    for (const segment of segments) {
      expect(segment.words.length).toBeGreaterThan(0);
      expect(segment.words[0].start).toBeGreaterThanOrEqual(segment.start);
      expect(segment.words[segment.words.length - 1].end).toBeLessThanOrEqual(segment.end);
      // The joined words must actually be the sentence, not placeholder filler.
      expect(segment.words.map((w) => w.word).join(" ")).toBe(segment.text);
    }
  });

  it("carries the signals Phase 04 scores on", () => {
    const text = segments.map((s) => s.text).join(" ").toLowerCase();

    expect(text.match(/here's the secret/g)?.length).toBeGreaterThanOrEqual(2);
    expect(segments.flatMap((s) => s.words).filter((w) => w.word === "[laughter]").length)
      .toBeGreaterThanOrEqual(1);
    expect(text).toMatch(/!/);
  });

  it("contains quiet filler stretches to score against", () => {
    // Measured, not hardcoded to an index: a highlight detector needs a real
    // low-energy region, and a fixture of wall-to-wall speech gives it nothing
    // to reject.
    let longestGap = 0;
    for (let i = 1; i < segments.length; i++) {
      longestGap = Math.max(longestGap, segments[i].start - segments[i - 1].end);
    }

    expect(longestGap).toBeGreaterThanOrEqual(6);
  });
});
