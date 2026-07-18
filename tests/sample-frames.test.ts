import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { probe } from "../src/lib/ffmpeg/exec";
import { sampleFrames } from "../src/lib/ffmpeg/frames";

const SHORT_SAMPLE = "fixtures/short-sample.mp4"; // exactly 5s, 1280×720

describe("sampleFrames — validation", () => {
  it("rejects a non-positive interval", async () => {
    await expect(sampleFrames(SHORT_SAMPLE, 0, tmpdir())).rejects.toThrow(/positive number/);
    await expect(sampleFrames(SHORT_SAMPLE, -1, tmpdir())).rejects.toThrow(/positive number/);
    await expect(sampleFrames(SHORT_SAMPLE, Number.NaN, tmpdir())).rejects.toThrow(
      /positive number/,
    );
  });

  it("rejects a non-integer / non-positive width", async () => {
    await expect(sampleFrames(SHORT_SAMPLE, 1, tmpdir(), { width: 0 })).rejects.toThrow(
      /positive integer/,
    );
    await expect(sampleFrames(SHORT_SAMPLE, 1, tmpdir(), { width: 320.5 })).rejects.toThrow(
      /positive integer/,
    );
  });

  it("rejects a negative startSec or non-positive durationSec", async () => {
    await expect(sampleFrames(SHORT_SAMPLE, 1, tmpdir(), { startSec: -1 })).rejects.toThrow(
      /non-negative/,
    );
    await expect(sampleFrames(SHORT_SAMPLE, 1, tmpdir(), { durationSec: 0 })).rejects.toThrow(
      /positive number/,
    );
  });
});

describe("sampleFrames — real ffmpeg extraction", () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "sseclone-frames-"));

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("fixture exists (run `npm run fixtures` first)", () => {
    expect(existsSync(SHORT_SAMPLE), `${SHORT_SAMPLE} missing`).toBe(true);
  });

  it("extracts one frame per second with index-derived timestamps", async () => {
    const dest = path.join(workDir, "every-1s");
    const frames = await sampleFrames(SHORT_SAMPLE, 1, dest);

    // A 5s source at 1 fps yields frames at t = 0,1,2,3,4.
    expect(frames.length).toBe(5);
    frames.forEach((f, i) => {
      expect(f.t).toBe(i); // i * everyNSec, everyNSec = 1
      expect(existsSync(f.path)).toBe(true);
      expect(f.path.endsWith(".png")).toBe(true);
    });

    // Timestamps are strictly ascending — the contract planCrop relies on.
    const ts = frames.map((f) => f.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(new Set(ts).size).toBe(ts.length);
  });

  it("honours a wider interval (fewer frames, spaced by everyNSec)", async () => {
    const dest = path.join(workDir, "every-2s");
    const frames = await sampleFrames(SHORT_SAMPLE, 2, dest);

    // 5s at one frame / 2s → t = 0,2,4.
    expect(frames.map((f) => f.t)).toEqual([0, 2, 4]);
  });

  it("downscales frames to the requested width, preserving aspect ratio", async () => {
    const dest = path.join(workDir, "scaled");
    const frames = await sampleFrames(SHORT_SAMPLE, 1, dest, { width: 320 });

    expect(frames.length).toBeGreaterThan(0);
    // 1280×720 → 320×180 keeps the 16:9 source ratio; height stayed even.
    const probed = await probe(frames[0].path);
    expect(probed.width).toBe(320);
    expect(probed.height).toBe(180);
  });

  it("samples only a clip window, with window-relative timestamps", async () => {
    const dest = path.join(workDir, "window");
    // Clip [1, 4) of the 5s source: 3s window at 1 fps ⇒ 3 frames.
    const frames = await sampleFrames(SHORT_SAMPLE, 1, dest, { startSec: 1, durationSec: 3 });

    // t is relative to the window start (0,1,2), not the source (1,2,3) — the
    // clip-relative timestamps the smart-crop job hands planCrop unchanged.
    expect(frames.map((f) => f.t)).toEqual([0, 1, 2]);
    expect(frames.every((f) => existsSync(f.path))).toBe(true);
  });

  it("writes frames only to the given directory, leaving siblings untouched", async () => {
    const destA = path.join(workDir, "iso-a");
    const destB = path.join(workDir, "iso-b");
    const a = await sampleFrames(SHORT_SAMPLE, 2, destA);
    const b = await sampleFrames(SHORT_SAMPLE, 1, destB);

    // Each call's frames live under its own dir; counts differ, no cross-talk.
    expect(a.every((f) => f.path.startsWith(destA))).toBe(true);
    expect(b.every((f) => f.path.startsWith(destB))).toBe(true);
    expect(a.length).toBe(3);
    expect(b.length).toBe(5);
  });
});
