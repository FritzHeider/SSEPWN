import { describe, expect, it } from "vitest";

import type { CaptionDoc } from "../src/lib/captions/ass";
import type { CaptionLine, CaptionWord } from "../src/lib/captions/clip";
import {
  applyCaptionEdit,
  buildCaptionDoc,
  CaptionEditError,
  flattenLines,
  parseEdit,
  readCaptionDoc,
} from "../src/lib/captions/edit";
import { resolveStyle } from "../src/lib/captions/style";
import type { TranscriptSegment } from "../src/lib/transcribe/types";

function word(text: string, start: number, end: number): CaptionWord {
  return { text, start, end };
}

function line(words: CaptionWord[]): CaptionLine {
  return {
    words,
    text: words.map((w) => w.text).join(" "),
    start: words[0].start,
    end: words[words.length - 1].end,
  };
}

/** 3 lines across 2 cues (maxLines 2): [l0,l1] and [l2]. */
function sampleDoc(): CaptionDoc {
  const l0 = line([word("hello", 0, 0.5), word("world", 0.5, 1)]);
  const l1 = line([word("foo", 1, 1.5), word("bar", 1.5, 2)]);
  const l2 = line([word("baz", 2, 2.5), word("qux", 2.5, 3)]);
  return {
    cues: [
      { lines: [l0, l1], start: 0, end: 2 },
      { lines: [l2], start: 2, end: 3 },
    ],
    style: resolveStyle(),
    name: "bold-pop",
  };
}

describe("parseEdit", () => {
  it("accepts each well-formed operation", () => {
    expect(parseEdit({ op: "set-word", line: 0, word: 1, text: "hi" })).toEqual({
      op: "set-word",
      line: 0,
      word: 1,
      text: "hi",
    });
    expect(parseEdit({ op: "shift-line", line: 2, delta: -1.5 })).toEqual({
      op: "shift-line",
      line: 2,
      delta: -1.5,
    });
    expect(parseEdit({ op: "merge-line", line: 0 })).toEqual({ op: "merge-line", line: 0 });
    expect(parseEdit({ op: "split-line", line: 0, word: 1 })).toEqual({
      op: "split-line",
      line: 0,
      word: 1,
    });
    expect(parseEdit({ op: "set-style", style: { preset: "boxed" } })).toEqual({
      op: "set-style",
      style: { preset: "boxed" },
    });
  });

  it("rejects malformed bodies", () => {
    expect(parseEdit(null)).toBeNull();
    expect(parseEdit({ op: "nope" })).toBeNull();
    expect(parseEdit({ op: "set-word", line: 0, word: 1 })).toBeNull(); // no text
    expect(parseEdit({ op: "set-word", line: -1, word: 0, text: "x" })).toBeNull(); // neg index
    expect(parseEdit({ op: "set-word", line: 0.5, word: 0, text: "x" })).toBeNull(); // non-int
    expect(parseEdit({ op: "shift-line", line: 0, delta: "1" })).toBeNull(); // delta not number
    expect(parseEdit({ op: "shift-line", line: 0, delta: Infinity })).toBeNull(); // not finite
    expect(parseEdit({ op: "set-style", style: null })).toBeNull(); // no style object
  });
});

describe("applyCaptionEdit — set-word", () => {
  it("replaces a word's text without touching its timing or other lines", () => {
    const doc = sampleDoc();
    const next = applyCaptionEdit(doc, { op: "set-word", line: 1, word: 0, text: "FOO!" });
    const lines = flattenLines(next);
    expect(lines[1].text).toBe("FOO! bar");
    expect(lines[1].words[0]).toMatchObject({ text: "FOO!", start: 1, end: 1.5 });
    // Untouched lines are unchanged.
    expect(lines[0].text).toBe("hello world");
    expect(lines[2].text).toBe("baz qux");
  });

  it("throws for an out-of-range word or empty text", () => {
    const doc = sampleDoc();
    expect(() => applyCaptionEdit(doc, { op: "set-word", line: 0, word: 9, text: "x" })).toThrow(
      CaptionEditError,
    );
    expect(() => applyCaptionEdit(doc, { op: "set-word", line: 0, word: 0, text: "  " })).toThrow(
      CaptionEditError,
    );
  });
});

describe("applyCaptionEdit — shift-line", () => {
  it("shifts every word in a line and clamps at zero", () => {
    const doc = sampleDoc();
    const forward = flattenLines(applyCaptionEdit(doc, { op: "shift-line", line: 0, delta: 5 }));
    expect(forward[0].words.map((w) => [w.start, w.end])).toEqual([
      [5, 5.5],
      [5.5, 6],
    ]);
    expect(forward[0].start).toBe(5);

    const clamped = flattenLines(applyCaptionEdit(doc, { op: "shift-line", line: 0, delta: -10 }));
    expect(clamped[0].words.every((w) => w.start >= 0 && w.end >= 0)).toBe(true);
    expect(clamped[0].start).toBe(0);
  });
});

describe("applyCaptionEdit — merge/split", () => {
  it("merges a line with the next into one", () => {
    const doc = sampleDoc();
    const next = applyCaptionEdit(doc, { op: "merge-line", line: 0 });
    const lines = flattenLines(next);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("hello world foo bar");
    expect(lines[0].start).toBe(0);
    expect(lines[0].end).toBe(2);
    // Re-grouped back into cues (maxLines 2).
    expect(next.cues).toHaveLength(1);
    expect(next.cues[0].lines).toHaveLength(2);
  });

  it("throws when merging the last line", () => {
    const doc = sampleDoc();
    expect(() => applyCaptionEdit(doc, { op: "merge-line", line: 2 })).toThrow(CaptionEditError);
  });

  it("splits a line before a word", () => {
    const doc = sampleDoc();
    const next = applyCaptionEdit(doc, { op: "split-line", line: 0, word: 1 });
    const lines = flattenLines(next);
    expect(lines).toHaveLength(4);
    expect(lines[0].text).toBe("hello");
    expect(lines[1].text).toBe("world");
  });

  it("throws for an invalid split point", () => {
    const doc = sampleDoc();
    expect(() => applyCaptionEdit(doc, { op: "split-line", line: 0, word: 0 })).toThrow(
      CaptionEditError,
    );
    expect(() => applyCaptionEdit(doc, { op: "split-line", line: 0, word: 2 })).toThrow(
      CaptionEditError,
    );
  });
});

describe("applyCaptionEdit — set-style", () => {
  it("switches the whole look on a preset change", () => {
    const doc = sampleDoc();
    const next = applyCaptionEdit(doc, { op: "set-style", style: { preset: "clean-sub" } });
    expect(next.style.fontFamily).toBe("Arial");
    expect(next.style.karaoke).toBe(false);
    expect(next.name).toBe("clean-sub");
  });

  it("layers a field override on the current style, keeping the rest and the name", () => {
    const doc = sampleDoc();
    const next = applyCaptionEdit(doc, { op: "set-style", style: { textColor: "#FF0000" } });
    expect(next.style.textColor).toBe("#FF0000");
    expect(next.style.fontFamily).toBe(doc.style.fontFamily); // unchanged
    expect(next.name).toBe("bold-pop");
  });

  it("drops malformed style fields at the boundary", () => {
    const doc = sampleDoc();
    const next = applyCaptionEdit(doc, {
      op: "set-style",
      style: { textColor: "red", fontSize: -4, uppercase: false },
    });
    expect(next.style.textColor).toBe(doc.style.textColor); // "red" rejected
    expect(next.style.fontSize).toBe(doc.style.fontSize); // negative rejected
    expect(next.style.uppercase).toBe(false); // valid, applied
  });
});

describe("edit purity", () => {
  it("never mutates the input document", () => {
    const doc = sampleDoc();
    const snapshot = JSON.parse(JSON.stringify(doc));
    applyCaptionEdit(doc, { op: "set-word", line: 0, word: 0, text: "changed" });
    applyCaptionEdit(doc, { op: "merge-line", line: 0 });
    applyCaptionEdit(doc, { op: "set-style", style: { preset: "boxed" } });
    expect(doc).toEqual(snapshot);
  });
});

describe("buildCaptionDoc / readCaptionDoc", () => {
  const transcript: TranscriptSegment[] = [
    {
      text: "one two three",
      start: 10,
      end: 13,
      words: [
        { word: "one", start: 10, end: 11 },
        { word: "two", start: 11, end: 12 },
        { word: "three", start: 12, end: 13 },
      ],
    },
  ];

  it("builds a re-based document with a resolved style and preset name", () => {
    const doc = buildCaptionDoc(transcript, 10, 13, { preset: "boxed" });
    expect(doc.cues.length).toBeGreaterThan(0);
    // Re-based to clip-relative time (clip starts at 10s -> 0s).
    expect(flattenLines(doc)[0].start).toBe(0);
    expect(doc.style.box).toBe(true);
    expect(doc.name).toBe("boxed");
  });

  it("round-trips through a state blob and rejects malformed blobs", () => {
    const doc = buildCaptionDoc(transcript, 10, 13);
    const state = { captions: doc, crop: {} };
    expect(readCaptionDoc(state)).toEqual(doc);
    expect(readCaptionDoc(null)).toBeNull();
    expect(readCaptionDoc({})).toBeNull();
    expect(readCaptionDoc({ captions: { style: {} } })).toBeNull(); // no cues
  });
});
