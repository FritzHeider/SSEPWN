import { describe, expect, it } from "vitest";

import { fallbackCandidates, wholeVideoCandidate } from "../src/lib/highlights/fallback";

describe("wholeVideoCandidate", () => {
  it("spans the whole source with a non-empty reason", () => {
    const clip = wholeVideoCandidate(8);
    expect(clip.start).toBe(0);
    expect(clip.end).toBe(8);
    expect(clip.score).toBe(0);
    expect(clip.reasons.length).toBeGreaterThanOrEqual(1);
    expect(clip.reasons[0]).toMatch(/whole video/i);
  });

  it("never returns a negative-length clip for a bogus duration", () => {
    expect(wholeVideoCandidate(-3).end).toBe(0);
  });
});

describe("fallbackCandidates", () => {
  const opts = { minLen: 15, maxLen: 90, windowLen: 20, step: 5 };

  it("returns nothing for a non-positive duration", () => {
    expect(fallbackCandidates(0, [], [], opts)).toHaveLength(0);
    expect(fallbackCandidates(-10, [1, 2], [3], opts)).toHaveLength(0);
  });

  it("tiles a long silent source into in-bounds candidates by scene/energy only", () => {
    // No energy at all (no audio): every window scores 0, and selection later
    // tiles the timeline. Each candidate must still respect the length bounds.
    const candidates = fallbackCandidates(120, [], [], opts);
    expect(candidates.length).toBeGreaterThan(1);
    for (const c of candidates) {
      const len = c.end - c.start;
      expect(len).toBeGreaterThanOrEqual(opts.minLen);
      expect(len).toBeLessThanOrEqual(opts.maxLen);
      expect(c.start).toBeGreaterThanOrEqual(0);
      expect(c.end).toBeLessThanOrEqual(120);
      expect(c.reasons[0]).toBe("scene segment");
    }
  });

  it("scores a window on its peak energy relative to the loudest second", () => {
    // A single loud second near t=40 should make the window covering it outscore
    // a quiet window at the start.
    const energy = Array.from({ length: 120 }, (_, i) => (i === 40 ? 10 : 1));
    const candidates = fallbackCandidates(120, energy, [], opts);
    const early = candidates.find((c) => c.start === 0);
    const onPeak = candidates.find((c) => c.start <= 40 && c.end > 40);
    expect(early?.score).toBeCloseTo(0.1, 5);
    expect(onPeak?.score).toBeCloseTo(1, 5);
    expect(onPeak?.reasons[0]).toBe("high energy");
  });

  it("snaps edges to nearby scene cuts", () => {
    // A scene cut at 4.5 s is within the 1.5 s snap window of the first window's
    // start (0) — no; but a cut at 1 s is. Assert the start lands on it.
    const candidates = fallbackCandidates(120, [], [1], { ...opts, sceneWindow: 1.5 });
    expect(candidates[0].start).toBe(1);
  });

  it("cuts a single window when the source is shorter than the window", () => {
    const candidates = fallbackCandidates(18, [], [], opts);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].start).toBe(0);
    const len = candidates[0].end - candidates[0].start;
    expect(len).toBeGreaterThanOrEqual(opts.minLen);
    expect(candidates[0].end).toBeLessThanOrEqual(18);
  });
});
