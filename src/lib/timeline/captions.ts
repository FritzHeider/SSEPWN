/**
 * Re-mapping a clip's caption document through its timeline edits (Phase 07;
 * SPEC.md § Timeline editor invariant "captions re-map through `sourceTimeAt`").
 *
 * A {@link CaptionDoc} is authored against the ORIGINAL clip window: every
 * `CaptionWord.start`/`end` is clip-relative (0 = the clip's `in_point`, which is
 * exactly `timeline.bounds.in`). Once the timeline is edited — segments trimmed,
 * split, reordered, or deleted — the words no longer line up with what actually
 * plays. This module produces the DERIVED caption doc for the edited sequence:
 * word timings expressed in EDITED-timeline seconds, with words over deleted
 * source ranges dropped and partial-overlap words clamped to the surviving part.
 *
 * The original caption doc stays canonical (it is what `PATCH …/captions` edits);
 * this is a pure read-only projection the preview overlay and export consume, so
 * nothing is persisted here. Like the rest of the timeline lib it is pure data —
 * no React, no ffmpeg, no clock — and it is the ONLY place caption times cross
 * from clip space into edited-timeline space.
 */

import {
  DEFAULT_MAX_LINES,
  groupCues,
  type CaptionLine,
  type CaptionWord,
} from "../captions/clip";
import type { CaptionDoc } from "../captions/ass";
import { flattenLines } from "../captions/edit";
import { TIME_EPSILON, type TimelineDoc } from "./types";

/**
 * Map one caption word from clip-relative time into edited-timeline time, or
 * `null` when the word's entire source range was trimmed/deleted out of the
 * timeline (it plays at no time and is dropped).
 *
 * The word's source range `[bounds.in + start, bounds.in + end]` is intersected
 * with each segment in playback order; the surviving timeline interval is the
 * union of every non-empty overlap. For a word that sits inside a single kept
 * segment this is an exact shift; a word straddling a cut is clamped to the part
 * that still plays. Segment source ranges are pairwise disjoint, so overlaps
 * never double-count.
 */
export function remapCaptionWord(doc: TimelineDoc, word: CaptionWord): CaptionWord | null {
  const s0 = doc.bounds.in + word.start;
  const s1 = doc.bounds.in + word.end;
  let acc = 0;
  let outStart: number | null = null;
  let outEnd = 0;
  for (const seg of doc.segments) {
    const dur = seg.sourceOut - seg.sourceIn;
    const lo = Math.max(s0, seg.sourceIn);
    const hi = Math.min(s1, seg.sourceOut);
    if (hi - lo > TIME_EPSILON) {
      const tStart = acc + (lo - seg.sourceIn);
      const tEnd = acc + (hi - seg.sourceIn);
      if (outStart === null || tStart < outStart) outStart = tStart;
      if (tEnd > outEnd) outEnd = tEnd;
    }
    acc += dur;
  }
  if (outStart === null) return null;
  return { ...word, start: outStart, end: outEnd };
}

/** Rebuild a line's derived text/start/end from its (re-mapped) words. */
function rebuildLine(words: CaptionWord[]): CaptionLine {
  const sorted = [...words].sort((a, b) => a.start - b.start || a.end - b.end);
  return {
    words: sorted,
    text: sorted.map((w) => w.text).join(" "),
    start: sorted[0].start,
    end: sorted[sorted.length - 1].end,
  };
}

/**
 * Project a caption document onto a timeline: re-map every word into edited
 * playback time (via {@link remapCaptionWord}), drop words whose source range was
 * deleted, and drop lines left with no surviving words. Existing line partitions
 * are preserved (only their words shift/vanish); the survivors are re-grouped
 * into cues with the same `maxLines` used when the doc was built, so the returned
 * doc has the exact shape the editor and export already consume.
 *
 * The style/name are carried through untouched — only timing changes.
 */
export function remapCaptions(
  caption: CaptionDoc,
  timeline: TimelineDoc,
  maxLines: number = DEFAULT_MAX_LINES,
): CaptionDoc {
  const lines = flattenLines(caption);
  const remapped: CaptionLine[] = [];
  for (const line of lines) {
    const words: CaptionWord[] = [];
    for (const w of line.words) {
      const rw = remapCaptionWord(timeline, w);
      if (rw) words.push(rw);
    }
    if (words.length === 0) continue; // whole line fell in a deleted range
    remapped.push(rebuildLine(words));
  }
  return { ...caption, cues: groupCues(remapped, maxLines) };
}
