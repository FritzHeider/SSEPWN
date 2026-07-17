import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { probe } from "../src/lib/ffmpeg/exec";

const SHORT_SAMPLE = "fixtures/short-sample.mp4";
const NO_AUDIO = "fixtures/no-audio.mp4";
const NOT_A_VIDEO = "fixtures/not-a-video.txt";

describe("ffmpeg", () => {
  it("fixtures exist (run `npm run fixtures` first)", () => {
    for (const f of [SHORT_SAMPLE, NO_AUDIO, NOT_A_VIDEO]) {
      expect(existsSync(f), `${f} missing`).toBe(true);
    }
  });

  it("probes short-sample.mp4: ~5s, 1280x720, has audio", async () => {
    const result = await probe(SHORT_SAMPLE);
    expect(result.duration).toBeGreaterThan(4.5);
    expect(result.duration).toBeLessThan(5.5);
    expect(result.width).toBe(1280);
    expect(result.height).toBe(720);
    expect(result.fps).toBeGreaterThan(0);
    expect(result.hasAudio).toBe(true);
  });

  it("probes no-audio.mp4: video stream but hasAudio false", async () => {
    const result = await probe(NO_AUDIO);
    expect(result.width).toBe(1280);
    expect(result.height).toBe(720);
    expect(result.hasAudio).toBe(false);
  });

  it("rejects not-a-video.txt", async () => {
    await expect(probe(NOT_A_VIDEO)).rejects.toThrow();
  });

  it("rejects a nonexistent path", async () => {
    await expect(probe("fixtures/does-not-exist.mp4")).rejects.toThrow();
  });
});
