import { describe, expect, it } from "vitest";

import { maxClipScore, scoreBarColor, scoreBarWidth, scoreFraction } from "../src/lib/projects/score-bar";

describe("maxClipScore", () => {
  it("finds the top finite score", () => {
    expect(maxClipScore([{ score: 3.5 }, { score: 0.4 }, { score: 1.2 }])).toBe(3.5);
  });

  it("ignores null and non-finite scores", () => {
    expect(maxClipScore([{ score: null }, { score: NaN }, { score: 2 }])).toBe(2);
  });

  it("is zero when nothing has a score", () => {
    expect(maxClipScore([{ score: null }, { score: null }])).toBe(0);
    expect(maxClipScore([])).toBe(0);
  });
});

describe("scoreFraction", () => {
  it("normalizes a score against the list max into [0,1]", () => {
    expect(scoreFraction(3.5, 3.5)).toBe(1);
    expect(scoreFraction(1.75, 3.5)).toBe(0.5);
  });

  it("returns null for a manual clip (no score)", () => {
    expect(scoreFraction(null, 3.5)).toBeNull();
  });

  it("returns null when there is no positive max to normalize against", () => {
    expect(scoreFraction(2, 0)).toBeNull();
  });

  it("clamps a score above the max to 1", () => {
    expect(scoreFraction(4, 3.5)).toBe(1);
  });
});

describe("scoreBarWidth", () => {
  it("renders a percent, with a visible floor for tiny fractions", () => {
    expect(scoreBarWidth(0.82)).toBe("82%");
    expect(scoreBarWidth(1)).toBe("100%");
    expect(scoreBarWidth(0.01)).toBe("4%");
  });
});

describe("scoreBarColor", () => {
  it("mixes accent into muted by the fraction", () => {
    expect(scoreBarColor(1)).toContain("var(--accent) 100%");
    expect(scoreBarColor(0.5)).toContain("var(--accent) 50%");
    expect(scoreBarColor(0)).toContain("var(--accent) 0%");
  });
});
