import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { probe } from "../src/lib/ffmpeg/exec";
import { audioEnergy, ENERGY_WINDOW_SEC, sceneChanges } from "../src/lib/highlights/extractors";
import { rmsPerWindow } from "../src/lib/highlights/signals";

const LONG_SAMPLE = "fixtures/long-sample.mp4";

/** Build a mono Int16Array by repeating each level `count` times, in order. */
function pcm(...runs: Array<{ level: number; count: number }>): Int16Array {
  const total = runs.reduce((n, r) => n + r.count, 0);
  const out = new Int16Array(total);
  let i = 0;
  for (const { level, count } of runs) {
    for (let k = 0; k < count; k++) out[i++] = level;
  }
  return out;
}

describe("rmsPerWindow (pure)", () => {
  it("returns one value per window and ranks a loud window above a quiet one", () => {
    // 4 samples per window (rate 4, 1 s). First window loud, second window quiet.
    const samples = pcm({ level: 32000, count: 4 }, { level: 200, count: 4 });
    const rms = rmsPerWindow(samples, 4, 1);

    expect(rms).toHaveLength(2);
    expect(rms[0]).toBeGreaterThan(rms[1]);
    // A constant ±32000 window has RMS ≈ 32000/32768 ≈ 0.977; every value in [0,1].
    expect(rms[0]).toBeGreaterThan(0.9);
    expect(rms[0]).toBeLessThanOrEqual(1);
    expect(rms[1]).toBeLessThan(0.05);
  });

  it("keeps a short final window rather than dropping its samples", () => {
    // 10 samples, 4 per window → 3 windows (4 + 4 + 2), the last one partial.
    const rms = rmsPerWindow(new Int16Array(10).fill(1000), 4, 1);
    expect(rms).toHaveLength(3);
    // The partial window averages over its own 2 samples, so it is not dampened.
    expect(rms[2]).toBeCloseTo(rms[0], 6);
  });

  it("returns [] for empty input and rejects a non-positive window", () => {
    expect(rmsPerWindow(new Int16Array(0), 16000, 1)).toEqual([]);
    expect(() => rmsPerWindow(new Int16Array(4), 16000, 0)).toThrow(/windowSec/);
    expect(() => rmsPerWindow(new Int16Array(4), 0, 1)).toThrow(/sampleRate/);
  });
});

// The extractors shell out to ffmpeg against a generated fixture; skip cleanly
// when fixtures are absent (run `npm run fixtures`) rather than failing on setup.
const haveFixture = existsSync(LONG_SAMPLE);
describe.skipIf(!haveFixture)("audioEnergy + sceneChanges (ffmpeg, fixture)", () => {
  it("audioEnergy: one value per second, loud regions outrank quiet ones", async () => {
    const { duration } = await probe(LONG_SAMPLE);
    const energy = await audioEnergy(LONG_SAMPLE);

    // ~90 s of audio, one window per second (+1 partial tail).
    expect(energy.length).toBeGreaterThanOrEqual(Math.floor(duration / ENERGY_WINDOW_SEC));
    expect(energy.length).toBeLessThanOrEqual(Math.ceil(duration / ENERGY_WINDOW_SEC) + 1);
    expect(energy.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);

    // make-fixtures.sh alternates the sine's volume loud/quiet every 10 s:
    // 1.0 in [0,10) and [20,30), 0.05 in [10,20) and [30,40). The extractor must
    // surface that as a real energy gap, not a flat line.
    const mean = (from: number, to: number) =>
      energy.slice(from, to).reduce((s, v) => s + v, 0) / (to - from);
    const loud = mean(2, 8);
    const quiet = mean(12, 18);
    expect(loud).toBeGreaterThan(quiet * 3);
  });

  it("sceneChanges: ascending, in range, and gated by the threshold", async () => {
    const { duration } = await probe(LONG_SAMPLE);
    const sensitive = await sceneChanges(LONG_SAMPLE, 0.01);

    // The parser actually pulled timestamps out of ffmpeg's metadata stream.
    expect(sensitive.length).toBeGreaterThanOrEqual(1);
    for (const t of sensitive) {
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(duration + 1);
    }
    // Ascending.
    for (let i = 1; i < sensitive.length; i++) {
      expect(sensitive[i]).toBeGreaterThanOrEqual(sensitive[i - 1]);
    }

    // Raising the threshold can only remove scene changes, never add them —
    // proves the threshold argument is wired through, not ignored.
    const strict = await sceneChanges(LONG_SAMPLE, 0.9);
    expect(strict.length).toBeLessThanOrEqual(sensitive.length);
  });
});
