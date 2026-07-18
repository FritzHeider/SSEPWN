import { describe, expect, it } from "vitest";

import {
  remapCaptionWord,
  remapCaptions,
} from "../src/lib/timeline/captions";
import { buildTimelineDoc } from "../src/lib/timeline/state";
import { deleteSegment, splitAt, trim } from "../src/lib/timeline/ops";
import { groupCues, type CaptionLine, type CaptionWord } from "../src/lib/captions/clip";
import { flattenLines } from "../src/lib/captions/edit";
import { resolveStyle } from "../src/lib/captions/style";
import type { CaptionDoc } from "../src/lib/captions/ass";

/** A caption word timed clip-relative (0 = clip in-point). */
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

/** A caption doc over lines, grouped one line per cue for easy addressing. */
function captionDoc(lines: CaptionLine[]): CaptionDoc {
  return { cues: groupCues(lines, 1), style: resolveStyle(undefined), name: "Caption" };
}

/** Clip window 10s..30s of the source (so clip-relative t ↔ source t+10). */
function clipTimeline() {
  return buildTimelineDoc(10, 30);
}

describe("remapCaptionWord", () => {
  it("is identity on a fresh (un-edited) timeline", () => {
    const doc = clipTimeline();
    const w = remapCaptionWord(doc, word("hi", 2, 4));
    expect(w).toEqual({ text: "hi", start: 2, end: 4 });
  });

  it("returns null when the word's source range was deleted", () => {
    // Split the 20s window at edited t=8 and t=12, delete the middle segment
    // (source 18..22). A word at clip-relative 9..11 (source 19..21) is gone.
    let doc = clipTimeline();
    doc = splitAt(doc, 8);
    doc = splitAt(doc, 12);
    const mid = doc.segments[1];
    doc = deleteSegment(doc, mid.id);
    expect(remapCaptionWord(doc, word("gone", 9, 11))).toBeNull();
  });

  it("shifts a word after a deleted middle earlier by the deleted length", () => {
    let doc = clipTimeline();
    doc = splitAt(doc, 8); // -> seg 10..18, seg 18..30
    doc = splitAt(doc, 12); // second seg splits at source 22 -> 18..22, 22..30
    doc = deleteSegment(doc, doc.segments[1].id); // remove 18..22 (4s)
    // Word at clip-relative 15..16 => source 25..26, still in kept seg 22..30.
    // Edited timeline: seg 10..18 occupies 0..8, then 22..30 occupies 8..16.
    // source 25 -> 8 + (25-22) = 11.
    const w = remapCaptionWord(doc, word("after", 15, 16));
    expect(w?.start).toBeCloseTo(11, 9);
    expect(w?.end).toBeCloseTo(12, 9);
  });

  it("clamps a word straddling a trimmed edge to the surviving part", () => {
    // Trim seg-1's in-edge from source 10 to source 15 (drop first 5s).
    let doc = clipTimeline();
    doc = trim(doc, "seg-1", "in", 15);
    // Word clip-relative 3..8 => source 13..18; only 15..18 survives.
    // Edited timeline starts at source 15 -> t0. source 15->0, 18->3.
    const w = remapCaptionWord(doc, word("edge", 3, 8));
    expect(w?.start).toBeCloseTo(0, 9);
    expect(w?.end).toBeCloseTo(3, 9);
  });
});

describe("remapCaptions", () => {
  it("carries style/name through and is identity on a fresh timeline", () => {
    const doc = captionDoc([line([word("a", 0, 1), word("b", 1, 2)])]);
    const out = remapCaptions(doc, clipTimeline());
    expect(out.style).toBe(doc.style);
    expect(out.name).toBe("Caption");
    expect(flattenLines(out)).toEqual(flattenLines(doc));
  });

  it("excludes lines over deleted ranges and shifts survivors after split+delete", () => {
    // Three lines: before / middle / after the deleted segment.
    const before = line([word("intro", 0, 3)]); // source 10..13
    const middle = line([word("cut", 9, 11)]); // source 19..21 -> deleted
    const after = line([word("outro", 15, 17)]); // source 25..27
    const doc = captionDoc([before, middle, after]);

    let tl = clipTimeline();
    tl = splitAt(tl, 8); // 10..18 | 18..30
    tl = splitAt(tl, 12); // 10..18 | 18..22 | 22..30
    tl = deleteSegment(tl, tl.segments[1].id); // drop 18..22

    const out = remapCaptions(doc, tl);
    const lines = flattenLines(out);
    // Middle line dropped entirely; two lines remain.
    expect(lines.map((l) => l.text)).toEqual(["intro", "outro"]);
    // "intro" unchanged (its source is in the first kept segment).
    expect(lines[0].start).toBeCloseTo(0, 9);
    expect(lines[0].end).toBeCloseTo(3, 9);
    // "outro" (source 25..27) plays at 8 + (25-22) = 11..13.
    expect(lines[1].start).toBeCloseTo(11, 9);
    expect(lines[1].end).toBeCloseTo(13, 9);
  });

  it("drops words in a deleted range but keeps a line's surviving words", () => {
    // One line spanning the cut: "keep" survives, "drop" is deleted.
    const spanning = line([word("keep", 2, 4), word("drop", 9, 11)]);
    const doc = captionDoc([spanning]);

    let tl = clipTimeline();
    tl = splitAt(tl, 8);
    tl = splitAt(tl, 12);
    tl = deleteSegment(tl, tl.segments[1].id);

    const out = remapCaptions(doc, tl);
    const lines = flattenLines(out);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("keep");
    expect(lines[0].words).toHaveLength(1);
  });

  it("re-groups survivors into cues of maxLines", () => {
    const doc = captionDoc([
      line([word("l0", 0, 1)]),
      line([word("l1", 1, 2)]),
      line([word("l2", 2, 3)]),
    ]);
    const out = remapCaptions(doc, clipTimeline(), 2);
    expect(out.cues).toHaveLength(2); // 3 lines / 2 per cue
    expect(out.cues[0].lines).toHaveLength(2);
    expect(out.cues[1].lines).toHaveLength(1);
  });
});
