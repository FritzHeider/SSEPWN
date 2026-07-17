import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOOK_PHRASES,
  scoreWindows,
  type Candidate,
  type ScoreWindowsOptions,
} from "../src/lib/highlights/score";
import type { TranscriptSegment } from "../src/lib/transcribe/types";

const LONG_SAMPLE = "tests/samples/transcripts/long-sample.json";
const fixture: TranscriptSegment[] = JSON.parse(readFileSync(LONG_SAMPLE, "utf8"));

/**
 * Per-second energy for the fixture: loud (0.9) over the hook-dense regions
 * ([15,31) around "Here's the secret…", [50,66) around "changed everything /
 * Tripled!", [80,90) around "nobody tells you") and near-silent (0.03)
 * everywhere else, including the two filler stretches at ~40 s and ~77 s.
 */
function fixtureEnergy(): number[] {
  const energy = new Array(91).fill(0.03);
  const loud = (from: number, to: number) => {
    for (let i = from; i < to; i++) energy[i] = 0.9;
  };
  loud(15, 30);
  loud(50, 66);
  loud(80, 90);
  return energy;
}

/** The candidate whose [start,end) contains time `t`, or the first one. */
function windowAt(candidates: Candidate[], t: number): Candidate {
  return candidates.find((c) => t >= c.start && t < c.end) ?? candidates[0];
}

/** A tiny synthetic transcript: one word per second, no punctuation/hooks. */
function flatTranscript(seconds: number, prefix = "word"): TranscriptSegment[] {
  const words = Array.from({ length: seconds }, (_, i) => ({
    word: `${prefix}${i}`,
    start: i + 0.1,
    end: i + 0.6,
  }));
  return [{ text: words.map((w) => w.word).join(" "), start: 0.1, end: seconds, words }];
}

/**
 * `count` plain words packed into `[0, span)` plus a sentinel word past `span`,
 * so a `windowLen === span` window is a FULL span-second window (its end is not
 * clamped to the timeline) holding exactly `count` words. That makes the
 * words/sec the density signal sees exact and independent of the tail handling.
 */
function packedTranscript(count: number, span: number): TranscriptSegment[] {
  const words = Array.from({ length: count }, (_, i) => ({
    word: `w${i}`,
    start: (i * span) / count,
    end: (i * span) / count + 0.05,
  }));
  words.push({ word: "sentinel", start: span + 1, end: span + 1.05 });
  return [{ text: words.map((w) => w.word).join(" "), start: 0, end: span + 1.05, words }];
}

describe("scoreWindows — per-signal breakdown", () => {
  it("every candidate exposes all five named signals with score = weight*raw", () => {
    const candidates = scoreWindows(fixture, fixtureEnergy());
    expect(candidates.length).toBeGreaterThan(0);

    const names = ["energy", "speechDensity", "hook", "emphasis", "laughter"] as const;
    for (const c of candidates) {
      expect(c.end).toBeGreaterThan(c.start);
      for (const name of names) {
        const s = c.signals[name];
        expect(s.raw).toBeGreaterThanOrEqual(0);
        expect(s.raw).toBeLessThanOrEqual(1);
        expect(s.score).toBeCloseTo(s.weight * s.raw, 10);
      }
      // Total is exactly the sum of the weighted contributions.
      const sum = names.reduce((acc, n) => acc + c.signals[n].score, 0);
      expect(c.score).toBeCloseTo(sum, 10);
    }
  });

  it("names the matched hook phrase in the reason text", () => {
    const candidates = scoreWindows(fixture, fixtureEnergy());
    const hookWindow = windowAt(candidates, 18); // "Here's the secret: nobody actually…"
    expect(hookWindow.signals.hook.raw).toBeGreaterThan(0);
    expect(hookWindow.signals.hook.reason).toContain("the secret");
    expect(hookWindow.reasons.some((r) => r.includes("the secret"))).toBe(true);
  });

  it("reasons are ordered most-influential first and omit silent signals", () => {
    const candidates = scoreWindows(fixture, fixtureEnergy());
    for (const c of candidates) {
      const fired = (["energy", "speechDensity", "hook", "emphasis", "laughter"] as const).filter(
        (n) => c.signals[n].raw > 0,
      );
      expect(c.reasons).toHaveLength(fired.length);
      // Rebuild the expected contribution-ordered reason list and compare.
      const ordered = fired
        .sort((a, b) => c.signals[b].score - c.signals[a].score)
        .map((n) => c.signals[n].reason);
      expect(c.reasons).toEqual(ordered);
    }
  });
});

describe("scoreWindows — the loud/hook-dense region outranks quiet filler", () => {
  it("the top-ranked window overlaps a hook, not the filler stretches", () => {
    // 15 s windows so the "Um, so, anyway…" filler at ~40 s is isolated from the
    // loud, hook-dense regions on either side of it.
    const candidates = scoreWindows(fixture, fixtureEnergy(), { windowLen: 15, step: 5 });
    const top = [...candidates].sort((a, b) => b.score - a.score)[0];

    // The top window sits on a hook-dense, loud region…
    expect(top.signals.hook.raw).toBeGreaterThan(0);
    expect(top.signals.energy.raw).toBeGreaterThan(0.5);

    // …and it decisively beats a window over the "Um, so, anyway…" filler at
    // ~40 s, which is quiet (energy 0.03) and hookless.
    const filler = windowAt(candidates, 41);
    expect(filler.signals.hook.raw).toBe(0);
    expect(filler.signals.energy.raw).toBeLessThan(0.1);
    expect(top.score).toBeGreaterThan(filler.score * 1.5);
  });

  it("a loud+hook window outscores the same window made quiet and hookless", () => {
    const opts: ScoreWindowsOptions = { windowLen: 15, step: 5 };
    const loud = scoreWindows(fixture, fixtureEnergy(), opts);

    // Same track, but the energy peak that sat over the 18 s hook is moved away:
    // quiet (0.03) around 18 s, loud (0.9) only near the end. The energy signal
    // is relative to the loudest point, so the hook window now reads quiet while
    // the hook itself still fires.
    const quietAt18 = new Array(91).fill(0.03);
    for (let i = 80; i < 90; i++) quietAt18[i] = 0.9;
    const shifted = scoreWindows(fixture, quietAt18, opts);

    const loudHook = windowAt(loud, 18);
    const quietHook = windowAt(shifted, 18);
    expect(loudHook.signals.energy.raw).toBeGreaterThan(quietHook.signals.energy.raw);
    // Dropping the energy only lowers the score; the hook still fires either way.
    expect(loudHook.score).toBeGreaterThan(quietHook.score);
    expect(quietHook.signals.hook.raw).toBeGreaterThan(0);
  });
});

describe("scoreWindows — configurable (config is live, not baked in)", () => {
  it("a custom hook-phrase list makes a previously-plain window score as a hook", () => {
    // "retention" is not a default hook, so the window at 45 s has no hook.
    const withDefaults = scoreWindows(fixture, fixtureEnergy());
    const plain = windowAt(withDefaults, 46);
    expect(plain.signals.hook.raw).toBe(0);

    const withCustom = scoreWindows(fixture, fixtureEnergy(), {
      hookPhrases: [...DEFAULT_HOOK_PHRASES, "retention"],
    });
    const promoted = windowAt(withCustom, 46);
    expect(promoted.signals.hook.raw).toBeGreaterThan(0);
    expect(promoted.signals.hook.reason).toContain("retention");
    expect(promoted.score).toBeGreaterThan(plain.score);
  });

  it("zeroing a signal's weight removes its contribution", () => {
    const base = scoreWindows(fixture, fixtureEnergy());
    const noEnergy = scoreWindows(fixture, fixtureEnergy(), { weights: { energy: 0 } });
    const b = windowAt(base, 18);
    const n = windowAt(noEnergy, 18);
    expect(n.signals.energy.score).toBe(0);
    expect(n.score).toBeCloseTo(b.score - b.signals.energy.score, 10);
  });
});

describe("scoreWindows — signal maths on synthetic input", () => {
  it("speech density rises with words/sec and saturates at 1", () => {
    // 45 words over a full 15 s window = 3 words/s = DENSITY_FULL → raw 1.
    const dense = scoreWindows(packedTranscript(45, 15), [], { windowLen: 15, step: 15 });
    expect(dense[0].signals.speechDensity.raw).toBeCloseTo(1, 6);
    // 15 words over 15 s = 1 word/s → raw 1/3.
    const sparse = scoreWindows(packedTranscript(15, 15), [], { windowLen: 15, step: 15 });
    expect(sparse[0].signals.speechDensity.raw).toBeCloseTo(1 / 3, 6);
  });

  it("laughter fires on marker tokens but the marker is not a spoken word", () => {
    const t: TranscriptSegment[] = [
      {
        text: "so funny [laughter]",
        start: 0.1,
        end: 3,
        words: [
          { word: "so", start: 0.1, end: 0.5 },
          { word: "funny", start: 0.6, end: 1.0 },
          { word: "[laughter]", start: 1.1, end: 1.5 },
          // Sentinel past the window so [0,15] is a full 15 s window (its end is
          // not clamped to the timeline); it is not counted inside the window.
          { word: "later", start: 16, end: 16.3 },
        ],
      },
    ];
    const [c] = scoreWindows(t, [], { windowLen: 15, minLen: 15, step: 15 });
    expect(c.end - c.start).toBeCloseTo(15, 6);
    expect(c.signals.laughter.raw).toBe(1);
    // Two spoken words in the 15 s window: the laughter marker was excluded.
    expect(c.signals.speechDensity.raw).toBeCloseTo(2 / 15 / 3, 6);
  });

  it("empty transcript yields no candidates; empty energy is safe (energy raw 0)", () => {
    expect(scoreWindows([], [1, 2, 3])).toEqual([]);
    const c = scoreWindows(flatTranscript(20), [], { windowLen: 15, step: 5 });
    expect(c.length).toBeGreaterThan(0);
    expect(c.every((x) => x.signals.energy.raw === 0)).toBe(true);
  });

  it("is deterministic: identical inputs produce identical candidates", () => {
    const a = scoreWindows(fixture, fixtureEnergy());
    const b = scoreWindows(fixture, fixtureEnergy());
    expect(a).toEqual(b);
  });

  it("rejects invalid length bounds and a non-positive step", () => {
    expect(() => scoreWindows(fixture, [], { minLen: 0 })).toThrow(/minLen/);
    expect(() => scoreWindows(fixture, [], { minLen: 90, maxLen: 30 })).toThrow(/maxLen/);
    expect(() => scoreWindows(fixture, [], { step: 0 })).toThrow(/step/);
  });
});
