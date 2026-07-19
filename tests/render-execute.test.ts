import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { probe, probeFaststart } from "../src/lib/ffmpeg/exec";
import {
  buildRenderArgs,
  executePlan,
  RENDER_QUALITY,
  UnsupportedNodeError,
} from "../src/lib/render/execute";
import { renderPlan } from "../src/lib/render/plan";
import { PLATFORM_PRESETS } from "../src/lib/presets";
import { addBroll } from "../src/lib/timeline/broll";
import { splitAt } from "../src/lib/timeline/ops";
import { buildTimelineDoc } from "../src/lib/timeline/state";
import { setTransition } from "../src/lib/timeline/transitions";

const SHORT_SAMPLE = "fixtures/short-sample.mp4";

/** A 4 s clip cut into two 2 s segments joined by a plain cut. */
function twoSegmentPlan() {
  let doc = buildTimelineDoc(0, 4);
  doc = splitAt(doc, 2); // seg 0..2, seg 2..4
  return renderPlan({ timeline: doc });
}

/** The same 4 s two-segment clip, but with a `crossfade` blend at the boundary. */
function crossfadePlan(kind: "crossfade" | "slide-left" = "crossfade", duration = 0.5) {
  let doc = buildTimelineDoc(0, 4);
  doc = splitAt(doc, 2); // seg-1 0..2, seg-2 2..4
  doc = setTransition(doc, "seg-1", kind, duration);
  return renderPlan({ timeline: doc });
}

describe("render/execute — buildRenderArgs (pure)", () => {
  it("builds a cut+concat+scale/pad graph for the tiktok preset", () => {
    const args = buildRenderArgs({
      plan: twoSegmentPlan(),
      inputPaths: { "in:main": "/tmp/in.mp4" },
      outputPath: "/tmp/out.mp4",
      preset: PLATFORM_PRESETS.tiktok,
      quality: "draft",
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    // Two trimmed segments, both video and audio.
    expect(graph).toContain("trim=start=0:end=2");
    expect(graph).toContain("trim=start=2:end=4");
    expect(graph).toContain("concat=n=2:v=1:a=0[vcat]");
    expect(graph).toContain("concat=n=2:v=0:a=1[acat]");
    // No crop node → scale-to-fit + pad to the exact preset resolution.
    expect(graph).toContain("scale=1080:1920:force_original_aspect_ratio=decrease");
    expect(graph).toContain("pad=1080:1920");
    // Encoder + container flags.
    expect(args).toContain("libx264");
    expect(args).toContain("+faststart");
    expect(args).toContain(String(RENDER_QUALITY.draft.crf));
  });

  it("requires an in:main input path", () => {
    expect(() =>
      buildRenderArgs({
        plan: twoSegmentPlan(),
        inputPaths: {},
        outputPath: "/tmp/out.mp4",
        preset: PLATFORM_PRESETS.tiktok,
      }),
    ).toThrow(/in:main/);
  });

  it("blends a crossfade boundary with xfade (video) + acrossfade (audio)", () => {
    const args = buildRenderArgs({
      plan: crossfadePlan("crossfade", 0.5),
      inputPaths: { "in:main": "/tmp/in.mp4" },
      outputPath: "/tmp/out.mp4",
      preset: PLATFORM_PRESETS.tiktok,
      quality: "draft",
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    // Left segment is 2 s → the 0.5 s blend starts at offset 1.5 s.
    expect(graph).toContain("xfade=transition=fade:duration=0.5:offset=1.5");
    expect(graph).toContain("acrossfade=d=0.5");
    // A single blended run → no multi-way concat; the run feeds reframe directly.
    expect(graph).not.toContain("concat=n=");
  });

  it("maps slide-left to the xfade slideleft transition", () => {
    const args = buildRenderArgs({
      plan: crossfadePlan("slide-left", 0.4),
      inputPaths: { "in:main": "/tmp/in.mp4" },
      outputPath: "/tmp/out.mp4",
      preset: PLATFORM_PRESETS.tiktok,
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("xfade=transition=slideleft:duration=0.4:offset=1.6");
  });

  it("rejects a plan with a not-yet-supported node kind (B-roll)", () => {
    let doc = buildTimelineDoc(0, 4);
    doc = addBroll(doc, { assetId: 9, start: 1, end: 3, mode: "pip" });
    expect(() =>
      buildRenderArgs({
        plan: renderPlan({ timeline: doc }),
        inputPaths: { "in:main": "/tmp/in.mp4", "in:asset-9": "/tmp/b.mp4" },
        outputPath: "/tmp/out.mp4",
        preset: PLATFORM_PRESETS.tiktok,
      }),
    ).toThrow(UnsupportedNodeError);
  });
});

describe("render/execute — executePlan (ffmpeg integration)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sseclone-render-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("fixtures exist (run `npm run fixtures` first)", () => {
    expect(existsSync(SHORT_SAMPLE), `${SHORT_SAMPLE} missing`).toBe(true);
  });

  it("renders a 2-segment cut to 1080×1920 h264+aac faststart (draft)", async () => {
    const out = path.join(dir, "out.mp4");
    const progress: number[] = [];
    await executePlan({
      plan: twoSegmentPlan(),
      inputPaths: { "in:main": SHORT_SAMPLE },
      outputPath: out,
      preset: PLATFORM_PRESETS.tiktok,
      quality: "draft",
      onProgress: (p) => progress.push(p),
    });

    expect(existsSync(out)).toBe(true);
    const info = await probe(out);
    // Two 2 s segments → ~4 s output.
    expect(info.duration).toBeGreaterThan(4 - 0.3);
    expect(info.duration).toBeLessThan(4 + 0.3);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.hasAudio).toBe(true);
    expect(await probeFaststart(out)).toBe(true);
    expect(progress).toEqual([0, 100]);
  }, 60_000);

  it("crossfade export duration = segments − overlap", async () => {
    const out = path.join(dir, "xfade.mp4");
    await executePlan({
      plan: crossfadePlan("crossfade", 0.5),
      inputPaths: { "in:main": SHORT_SAMPLE },
      outputPath: out,
      preset: PLATFORM_PRESETS.tiktok,
      quality: "draft",
    });

    expect(existsSync(out)).toBe(true);
    const info = await probe(out);
    // 2 s + 2 s − 0.5 s blend = 3.5 s (both video xfade and audio acrossfade
    // shorten by the overlap, so the muxed duration follows).
    expect(info.duration).toBeGreaterThan(3.5 - 0.3);
    expect(info.duration).toBeLessThan(3.5 + 0.3);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.hasAudio).toBe(true);
  }, 60_000);
});
