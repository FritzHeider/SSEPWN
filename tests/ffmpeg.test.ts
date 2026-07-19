import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ffmpegFilterNames, ffmpegHasFilter, parseFfmpegProgress, probe } from "../src/lib/ffmpeg/exec";

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

describe("parseFfmpegProgress", () => {
  it("maps out_time_us against total duration to a percent", () => {
    // 2 s of a 4 s render = 50%.
    expect(parseFfmpegProgress("out_time_us=2000000\nprogress=continue\n", 4)).toBe(50);
  });

  it("takes the LAST out_time_us in a multi-block chunk", () => {
    const chunk =
      "out_time_us=1000000\nprogress=continue\nout_time_us=3000000\nprogress=continue\n";
    expect(parseFfmpegProgress(chunk, 4)).toBe(75);
  });

  it("clamps to 99 so a tick never reports completion early", () => {
    // out_time can momentarily exceed the estimate; the terminal 100 is the
    // caller's to emit once ffmpeg exits.
    expect(parseFfmpegProgress("out_time_us=8000000\n", 4)).toBe(99);
  });

  it("returns null for a chunk with no out_time_us", () => {
    expect(parseFfmpegProgress("frame=10\nfps=30\nprogress=continue\n", 4)).toBeNull();
  });

  it("returns null when total duration is non-positive", () => {
    expect(parseFfmpegProgress("out_time_us=2000000\n", 0)).toBeNull();
    expect(parseFfmpegProgress("out_time_us=2000000\n", -1)).toBeNull();
  });

  it("floors at 0 for a zero time", () => {
    expect(parseFfmpegProgress("out_time_us=0\n", 4)).toBe(0);
  });
});

describe("ffmpeg filter capability", () => {
  it("lists this build's filters and reports staples as present", async () => {
    const names = await ffmpegFilterNames();
    expect(names.size).toBeGreaterThan(0);
    // `scale` and `crop` ship in every ffmpeg build; the export's reframe relies
    // on them, so their presence is a safe invariant.
    expect(names.has("scale")).toBe(true);
    expect(names.has("crop")).toBe(true);
  });

  it("reports a nonexistent filter as absent (so callers can degrade)", async () => {
    expect(await ffmpegHasFilter("scale")).toBe(true);
    expect(await ffmpegHasFilter("definitely-not-a-real-filter")).toBe(false);
  });
});
