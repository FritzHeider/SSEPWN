import { describe, expect, it } from "vitest";

import type { Candidate } from "../src/lib/highlights/score";
import { selectClips } from "../src/lib/highlights/select";

/** A candidate is fully determined for selection by its start/end/score. */
function cand(start: number, end: number, score: number): Candidate {
  const zero = { raw: 0, weight: 0, score: 0, reason: "" };
  return {
    start,
    end,
    score,
    signals: { energy: zero, speechDensity: zero, hook: zero, emphasis: zero, laughter: zero },
    reasons: [],
  };
}

/** True when two clips overlap or sit closer than `minGap` seconds. */
function tooClose(a: Candidate, b: Candidate, minGap: number): boolean {
  const [first, second] = a.start <= b.start ? [a, b] : [b, a];
  return second.start - first.end < minGap - 1e-6;
}

describe("selectClips — top-N non-overlapping, ranked by score", () => {
  it("returns clips ranked by descending score", () => {
    // Spaced 30 s apart so the gap never forces a drop; only ranking is tested.
    const clips = selectClips([
      cand(0, 20, 3),
      cand(60, 80, 9),
      cand(120, 140, 5),
      cand(180, 200, 7),
    ]);
    expect(clips.map((c) => c.score)).toEqual([9, 7, 5, 3]);
  });

  it("caps the result at n", () => {
    const many = Array.from({ length: 10 }, (_, i) => cand(i * 30, i * 30 + 20, 10 - i));
    expect(selectClips(many, { n: 3 })).toHaveLength(3);
    expect(selectClips(many, { n: 3 }).map((c) => c.score)).toEqual([10, 9, 8]);
  });

  it("selected clips never overlap and are all ≥ minGap apart", () => {
    const minGap = 5;
    // A dense field: many candidates within a few seconds of each other.
    const dense: Candidate[] = [];
    for (let start = 0; start <= 100; start += 5) {
      dense.push(cand(start, start + 20, (start % 30) + 1));
    }
    const picked = selectClips(dense, { n: 10, minGap });
    for (let i = 0; i < picked.length; i++) {
      for (let j = i + 1; j < picked.length; j++) {
        expect(tooClose(picked[i], picked[j], minGap)).toBe(false);
      }
    }
  });

  it("drops a high-scoring candidate that overlaps an even higher one", () => {
    const clips = selectClips(
      [
        cand(0, 30, 10), // winner
        cand(10, 40, 9), // overlaps the winner → dropped despite high score
        cand(50, 70, 8), // clears the gap from the winner (end 30 → start 50) → kept
      ],
      { minGap: 5 },
    );
    expect(clips.map((c) => c.start)).toEqual([0, 50]);
    expect(clips.map((c) => c.score)).toEqual([10, 8]);
  });

  it("enforces minGap even when clips do not overlap", () => {
    // Gap between them is exactly 4 s (< default 5) → only the best survives.
    const clips = selectClips([cand(0, 20, 5), cand(24, 44, 4)]);
    expect(clips).toHaveLength(1);
    expect(clips[0].start).toBe(0);
  });

  it("keeps clips exactly minGap apart (boundary is inclusive)", () => {
    // Later clip starts 5 s after the first ends: gap == minGap → both kept.
    const clips = selectClips([cand(0, 20, 5), cand(25, 45, 4)], { minGap: 5 });
    expect(clips.map((c) => c.start)).toEqual([0, 25]);
  });

  it("breaks score ties deterministically by earliest start", () => {
    // Same score; input order shuffled — earliest start must rank first, and the
    // result must not depend on the order the candidates arrive in.
    const a = cand(0, 20, 5);
    const b = cand(100, 120, 5);
    expect(selectClips([b, a]).map((c) => c.start)).toEqual([0, 100]);
    expect(selectClips([a, b]).map((c) => c.start)).toEqual([0, 100]);
  });

  it("returns [] for empty input or non-positive n", () => {
    expect(selectClips([])).toEqual([]);
    expect(selectClips([cand(0, 20, 5)], { n: 0 })).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [cand(60, 80, 1), cand(0, 20, 9)];
    const snapshot = input.map((c) => c.start);
    selectClips(input);
    expect(input.map((c) => c.start)).toEqual(snapshot);
  });
});
