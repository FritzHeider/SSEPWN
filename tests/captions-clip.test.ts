import { describe, expect, it } from "vitest";

import {
  clipCaptions,
  groupLines,
  sliceWords,
  type CaptionWord,
} from "../src/lib/captions/clip";
import type { TranscriptSegment } from "../src/lib/transcribe/types";

/**
 * A transcript with one word per second, each word 0.8 s long inside its
 * second (start=i, end=i+0.8), so gaps between words are unambiguous and
 * clamping is easy to reason about.
 */
function evenTranscript(texts: string[], from = 0): TranscriptSegment {
  const words = texts.map((word, i) => ({
    word,
    start: from + i,
    end: from + i + 0.8,
  }));
  return {
    text: texts.join(" "),
    start: words[0].start,
    end: words[words.length - 1].end,
    words,
  };
}

describe("sliceWords", () => {
  it("re-bases kept words so the clip starts at time 0", () => {
    const t = [evenTranscript(["a", "b", "c", "d", "e"])]; // 0..4
    const words = sliceWords(t, 2, 4); // keep c (2), d (3)
    expect(words.map((w) => w.text)).toEqual(["c", "d"]);
    expect(words[0].start).toBeCloseTo(0); // 2 - 2
    expect(words[0].end).toBeCloseTo(0.8);
    expect(words[1].start).toBeCloseTo(1); // 3 - 2
  });

  it("clamps a partial-overlap word at the in-point instead of dropping it", () => {
    // Word spans 1.5..2.5, clip starts at 2.0 — it is mid-utterance at cut in.
    const seg: TranscriptSegment = {
      text: "mid tail",
      start: 1.5,
      end: 3.3,
      words: [
        { word: "mid", start: 1.5, end: 2.5 },
        { word: "tail", start: 2.5, end: 3.3 },
      ],
    };
    const words = sliceWords([seg], 2, 5);
    expect(words.map((w) => w.text)).toEqual(["mid", "tail"]);
    // "mid" clamped: source 1.5..2.5 → clip 0..0.5
    expect(words[0].start).toBeCloseTo(0);
    expect(words[0].end).toBeCloseTo(0.5);
  });

  it("clamps a word overrunning the out-point to the clip end", () => {
    const seg: TranscriptSegment = {
      text: "over",
      start: 3.5,
      end: 4.5,
      words: [{ word: "over", start: 3.5, end: 4.5 }],
    };
    const words = sliceWords([seg], 0, 4); // clip 0..4
    expect(words).toHaveLength(1);
    expect(words[0].end).toBeCloseTo(4); // 4.5 clamped to out=4 → 4-0
  });

  it("drops words wholly outside the window and empty/whitespace tokens", () => {
    const seg: TranscriptSegment = {
      text: "before inside blank after",
      start: 0,
      end: 10,
      words: [
        { word: "before", start: 0, end: 1 },
        { word: "inside", start: 5, end: 6 },
        { word: "   ", start: 5.5, end: 5.9 },
        { word: "after", start: 9, end: 10 },
      ],
    };
    const words = sliceWords([seg], 4, 7);
    expect(words.map((w) => w.text)).toEqual(["inside"]);
  });

  it("treats a word ending exactly at the in-point as outside", () => {
    const seg: TranscriptSegment = {
      text: "touch keep",
      start: 1,
      end: 3,
      words: [
        { word: "touch", start: 1, end: 2 },
        { word: "keep", start: 2, end: 3 },
      ],
    };
    const words = sliceWords([seg], 2, 5);
    expect(words.map((w) => w.text)).toEqual(["keep"]);
  });
});

describe("groupLines", () => {
  it("respects maxChars and never splits a word", () => {
    const words: CaptionWord[] = "aa bb cc dd ee".split(" ").map((text, i) => ({
      text,
      start: i,
      end: i + 0.5,
    }));
    // budget 8: "aa bb cc" = 8 chars fits; "dd ee" on next line.
    const lines = groupLines(words, 8);
    expect(lines.map((l) => l.text)).toEqual(["aa bb cc", "dd ee"]);
    for (const line of lines) expect(line.text.length).toBeLessThanOrEqual(8);
  });

  it("overflows a single word longer than the budget onto its own line", () => {
    const words: CaptionWord[] = [
      { text: "supercalifragilistic", start: 0, end: 1 },
      { text: "ok", start: 1, end: 2 },
    ];
    const lines = groupLines(words, 6);
    expect(lines.map((l) => l.text)).toEqual(["supercalifragilistic", "ok"]);
  });

  it("carries first-word-start and last-word-end onto each line", () => {
    const words: CaptionWord[] = [
      { text: "one", start: 0, end: 0.5 },
      { text: "two", start: 0.6, end: 1.2 },
    ];
    const [line] = groupLines(words, 32);
    expect(line.start).toBeCloseTo(0);
    expect(line.end).toBeCloseTo(1.2);
    expect(line.words).toHaveLength(2);
  });
});

describe("clipCaptions", () => {
  it("groups sliced words into cues of at most maxLines lines", () => {
    const t = [evenTranscript(["a", "b", "c", "d", "e", "f", "g", "h"])];
    // maxChars 3 → each line is one word ("a" etc, since "a b" = 3 fits... )
    const cues = clipCaptions(t, 0, 8, { maxChars: 3, maxLines: 2 });
    for (const cue of cues) expect(cue.lines.length).toBeLessThanOrEqual(2);
    // Every word is present exactly once across all cues.
    const words = cues.flatMap((c) => c.lines.flatMap((l) => l.words.map((w) => w.text)));
    expect(words).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });

  it("propagates cue start/end from its member lines", () => {
    const t = [evenTranscript(["a", "b", "c", "d"])];
    const cues = clipCaptions(t, 0, 4, { maxChars: 1, maxLines: 2 });
    // maxChars 1 → one word per line; maxLines 2 → 2 words per cue.
    expect(cues).toHaveLength(2);
    expect(cues[0].start).toBeCloseTo(0);
    expect(cues[0].end).toBeCloseTo(1.8); // second word "b" ends at 1+0.8
  });

  it("returns no cues for an empty or inverted window", () => {
    const t = [evenTranscript(["a", "b", "c"])];
    expect(clipCaptions(t, 3, 3)).toEqual([]);
    expect(clipCaptions(t, 5, 2)).toEqual([]);
  });

  it("merges words across multiple segments in time order", () => {
    const t = [evenTranscript(["a", "b"], 0), evenTranscript(["c", "d"], 2)];
    const cues = clipCaptions(t, 0, 4, { maxChars: 32, maxLines: 2 });
    const words = cues.flatMap((c) => c.lines.flatMap((l) => l.words.map((w) => w.text)));
    expect(words).toEqual(["a", "b", "c", "d"]);
  });
});
