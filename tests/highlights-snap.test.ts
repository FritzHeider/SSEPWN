import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Candidate } from "../src/lib/highlights/score";
import { snapBoundaries } from "../src/lib/highlights/snap";
import type { TranscriptSegment, TranscriptWord } from "../src/lib/transcribe/types";

const LONG_SAMPLE = "tests/samples/transcripts/long-sample.json";
const fixture: TranscriptSegment[] = JSON.parse(readFileSync(LONG_SAMPLE, "utf8"));

const words: TranscriptWord[] = fixture.flatMap((s) => s.words);
const timelineEnd = words.reduce((m, w) => Math.max(m, w.end), 0);
const sentenceStarts = fixture.map((s) => s.start);
const sentenceEnds = fixture.map((s) => s.end);

/** True when `t` splits a word (strictly between its start and end). */
function strictlyInsideAnyWord(t: number): boolean {
  return words.some((w) => t > w.start + 1e-6 && t < w.end - 1e-6);
}

/** A bare candidate at [start, end]; signals/reasons are irrelevant to snapping. */
function candidateAt(start: number, end: number): Candidate {
  const zero = { raw: 0, weight: 0, score: 0, reason: "" };
  return {
    start,
    end,
    score: 1,
    signals: { energy: zero, speechDensity: zero, hook: zero, emphasis: zero, laughter: zero },
    reasons: [],
  };
}

/** Deterministic LCG so the "property" sweep is reproducible (no Math.random). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

describe("snapBoundaries — never cuts inside a word, respects length", () => {
  it("property: over many candidates, edges are word-safe and length ∈ [minLen, maxLen]", () => {
    const rand = lcg(20260717);
    const minLen = 15;
    const maxLen = 60;
    for (let i = 0; i < 400; i++) {
      const start = rand() * (timelineEnd - minLen);
      const len = minLen + rand() * (maxLen - minLen);
      const snapped = snapBoundaries(candidateAt(start, start + len), fixture, [], {
        minLen,
        maxLen,
      });
      // 1. neither edge splits a word
      expect(strictlyInsideAnyWord(snapped.start)).toBe(false);
      expect(strictlyInsideAnyWord(snapped.end)).toBe(false);
      // 2. duration stays within [minLen, maxLen]
      const dur = snapped.end - snapped.start;
      expect(dur).toBeGreaterThanOrEqual(minLen - 1e-6);
      expect(dur).toBeLessThanOrEqual(maxLen + 1e-6);
      // 3. stays inside the source timeline
      expect(snapped.start).toBeGreaterThanOrEqual(-1e-6);
      expect(snapped.end).toBeLessThanOrEqual(timelineEnd + 1e-6);
    }
  });

  it("property: also holds with wide bounds that let a clip span the whole clip", () => {
    const rand = lcg(999);
    for (let i = 0; i < 200; i++) {
      const start = rand() * timelineEnd;
      const len = 15 + rand() * 75;
      const snapped = snapBoundaries(candidateAt(start, start + len), fixture, []);
      expect(strictlyInsideAnyWord(snapped.start)).toBe(false);
      expect(strictlyInsideAnyWord(snapped.end)).toBe(false);
      const dur = snapped.end - snapped.start;
      expect(dur).toBeGreaterThanOrEqual(15 - 1e-6);
      expect(dur).toBeLessThanOrEqual(90 + 1e-6);
    }
  });
});

describe("snapBoundaries — snaps to sentence boundaries", () => {
  it("with no scenes, each edge lands on a transcript segment boundary", () => {
    // A window loosely straddling the "Here's the secret" sentence (18–22.8).
    const snapped = snapBoundaries(candidateAt(17.4, 41.2), fixture, []);
    const near = (value: number, set: number[]) => set.some((b) => Math.abs(b - value) < 1e-6);
    expect(near(snapped.start, sentenceStarts)).toBe(true);
    expect(near(snapped.end, sentenceEnds)).toBe(true);
  });

  it("snaps the start to the NEAREST sentence start, not just any", () => {
    // 18.1 is closest to the segment that starts at 18.0.
    const snapped = snapBoundaries(candidateAt(18.1, 55), fixture, []);
    expect(snapped.start).toBeCloseTo(18.0, 6);
  });
});

describe("snapBoundaries — prefers a nearby scene change", () => {
  it("prefers a scene change within 1.5 s over the sentence boundary", () => {
    // Sentence starts at 18.0; put a scene cut at 17.7 — in the silence gap
    // between segments (ends 17.6 / starts 18.0), 0.3 s from the raw edge and
    // inside the 1.5 s window — and confirm the edge snaps to the cut.
    const snapped = snapBoundaries(candidateAt(18.0, 55), fixture, [17.7], { sceneWindow: 1.5 });
    expect(snapped.start).toBeCloseTo(17.7, 6);
  });

  it("ignores a scene change beyond the window and uses the sentence boundary", () => {
    // Scene cut 3 s away from the raw edge → outside 1.5 s → sentence wins.
    const snapped = snapBoundaries(candidateAt(18.0, 55), fixture, [15.0], { sceneWindow: 1.5 });
    const onSentence = sentenceStarts.some((b) => Math.abs(b - snapped.start) < 1e-6);
    expect(onSentence).toBe(true);
    expect(snapped.start).not.toBeCloseTo(15.0, 3);
  });

  it("a scene change landing mid-word is still not used as a raw cut", () => {
    // Find a word and aim a candidate/scene at its exact middle.
    const w = words.find((x) => x.end - x.start > 0.2)!;
    const mid = (w.start + w.end) / 2;
    const snapped = snapBoundaries(candidateAt(mid, mid + 30), fixture, [mid], {
      sceneWindow: 1.5,
    });
    expect(strictlyInsideAnyWord(snapped.start)).toBe(false);
  });
});

describe("snapBoundaries — degenerate inputs", () => {
  it("returns the candidate unchanged when the transcript has no words", () => {
    const c = candidateAt(3, 40);
    expect(snapBoundaries(c, [], [])).toEqual(c);
  });

  it("rejects invalid length bounds", () => {
    expect(() => snapBoundaries(candidateAt(0, 30), fixture, [], { minLen: 0 })).toThrow(/minLen/);
    expect(() =>
      snapBoundaries(candidateAt(0, 30), fixture, [], { minLen: 90, maxLen: 30 }),
    ).toThrow(/maxLen/);
  });

  it("is deterministic: identical inputs snap identically", () => {
    const a = snapBoundaries(candidateAt(18.1, 50.3), fixture, [17.2, 40.0]);
    const b = snapBoundaries(candidateAt(18.1, 50.3), fixture, [17.2, 40.0]);
    expect(a).toEqual(b);
  });
});
