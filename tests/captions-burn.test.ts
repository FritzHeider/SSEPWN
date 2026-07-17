import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { burnIn, escapeFilterPath } from "../src/lib/ffmpeg/burn";
import { probe } from "../src/lib/ffmpeg/exec";
import { toAss, type CaptionDoc } from "../src/lib/captions/ass";
import type { CaptionCue } from "../src/lib/captions/clip";
import { getPreset } from "../src/lib/captions/style";

const SHORT_SAMPLE = "fixtures/short-sample.mp4";

/**
 * Whether the local ffmpeg was built with the `ass` filter (i.e. libass).
 * The real burn-in acceptance requires it; minimal ffmpeg builds omit it, and
 * `npm test` must stay green there (README's "new machine can `npm test`"
 * guarantee), so the burn assertion is gated on this probe. See DEC-010.
 */
async function assFilterAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execa("ffmpeg", ["-hide_banner", "-filters"]);
    return stdout
      .split("\n")
      .some((line) => line.trim().split(/\s+/)[1] === "ass");
  } catch {
    return false;
  }
}

const ASS_AVAILABLE = await assFilterAvailable();

/** A single cue with two stacked lines — the "2-line ASS" the acceptance asks for. */
function twoLineCue(): CaptionCue {
  const line1 = {
    words: [
      { text: "hello", start: 0.5, end: 1.0 },
      { text: "there", start: 1.0, end: 1.6 },
    ],
    text: "hello there",
    start: 0.5,
    end: 1.6,
  };
  const line2 = {
    words: [
      { text: "brave", start: 1.6, end: 2.2 },
      { text: "world", start: 2.2, end: 2.8 },
    ],
    text: "brave world",
    start: 1.6,
    end: 2.8,
  };
  return { lines: [line1, line2], start: 0.5, end: 2.8 };
}

describe("burnIn", () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "sseclone-burn-test-"));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("escapes filtergraph meta-characters in the ass path", () => {
    // No meta-chars → path unchanged.
    expect(escapeFilterPath("/tmp/a.ass")).toBe("/tmp/a.ass");
    // Backslash then colon (Windows drive) both escaped; order matters.
    expect(escapeFilterPath("C:\\subs\\a.ass")).toBe("C\\:\\\\subs\\\\a.ass");
    // Single quote escaped so it can't close a quoted option value.
    expect(escapeFilterPath("/tmp/o'brien.ass")).toBe("/tmp/o\\'brien.ass");
  });

  it.runIf(ASS_AVAILABLE)(
    "burns a 2-line ASS into short-sample.mp4: same duration, video stream present",
    async () => {
      expect(existsSync(SHORT_SAMPLE), `${SHORT_SAMPLE} missing (run npm run fixtures)`).toBe(true);

      const doc: CaptionDoc = {
        cues: [twoLineCue()],
        style: getPreset("bold-pop"),
        name: "bold-pop",
      };
      const source = await probe(SHORT_SAMPLE);
      const ass = toAss(doc, source.width, source.height);
      // Sanity: the ASS we feed the filter really does carry two stacked lines.
      expect(ass).toContain("\\N");

      const assPath = path.join(workDir, "captions.ass");
      const outPath = path.join(workDir, "burned.mp4");
      await writeFile(assPath, ass, "utf8");

      const result = await burnIn(SHORT_SAMPLE, assPath, outPath);
      expect(result).toBe(outPath);
      expect(existsSync(outPath)).toBe(true);

      const burned = await probe(outPath);
      expect(burned.width).toBe(source.width);
      expect(burned.height).toBe(source.height);
      expect(Math.abs(burned.duration - source.duration)).toBeLessThan(0.2);
    },
    60_000,
  );

  it.skipIf(ASS_AVAILABLE)(
    "burn-in skipped: this ffmpeg build lacks the `ass` filter (libass)",
    () => {
      // Documented no-op: on a libass-capable ffmpeg the runIf test above runs
      // the real burn and verifies the playable-mp4 acceptance. See DEC-010.
      expect(ASS_AVAILABLE).toBe(false);
    },
  );

  it("rejects when the input cannot be decoded", async () => {
    const assPath = path.join(workDir, "bad-input.ass");
    await writeFile(assPath, "[Script Info]\n", "utf8");
    await expect(
      burnIn("fixtures/does-not-exist.mp4", assPath, path.join(workDir, "nope.mp4")),
    ).rejects.toThrow();
  });
});
