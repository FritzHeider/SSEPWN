import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { toAss, type CaptionDoc } from "../src/lib/captions/ass";
import type { CaptionCue } from "../src/lib/captions/clip";
import { getPreset } from "../src/lib/captions/style";
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
import { addCta } from "../src/lib/timeline/cta";
import { splitAt } from "../src/lib/timeline/ops";
import { addSfx } from "../src/lib/timeline/sfx";
import { buildTimelineDoc } from "../src/lib/timeline/state";
import { setTransition } from "../src/lib/timeline/transitions";

const SHORT_SAMPLE = "fixtures/short-sample.mp4";
const BROLL_SAMPLE = "fixtures/broll-sample.mp4";
const LOGO_SAMPLE = "fixtures/logo-sample.png";
const SFX_SAMPLE = "fixtures/sfx-sample.wav";

/**
 * Whether the local ffmpeg was built with the `drawtext` filter (libfreetype).
 * A text CTA burns via `drawtext`; minimal ffmpeg builds omit it, and `npm test`
 * must stay green there, so the real text-burn assertion is gated on this probe
 * (mirrors the `ass`/libass gate — DEC-010, DEC-013).
 */
async function drawtextAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execa("ffmpeg", ["-hide_banner", "-filters"]);
    return stdout.split("\n").some((line) => line.trim().split(/\s+/)[1] === "drawtext");
  } catch {
    return false;
  }
}

const DRAWTEXT_AVAILABLE = await drawtextAvailable();

/**
 * Whether the local ffmpeg was built with the `ass` filter (libass). Caption
 * burn-in rasterises via `ass`; minimal builds omit it, and `npm test` must stay
 * green there, so the real pixel-diff burn assertion is gated on this probe
 * (mirrors {@link drawtextAvailable} and the phase-05 `ass` gate — DEC-010/DEC-013).
 */
async function assFilterAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execa("ffmpeg", ["-hide_banner", "-filters"]);
    return stdout.split("\n").some((line) => line.trim().split(/\s+/)[1] === "ass");
  } catch {
    return false;
  }
}

const ASS_AVAILABLE = await assFilterAvailable();

/** A caption doc with one 2-line cue spanning ~0.5–2.8 s, for burn-in tests. */
function captionDoc(): CaptionDoc {
  const cue: CaptionCue = {
    lines: [
      {
        words: [
          { text: "hello", start: 0.5, end: 1.0 },
          { text: "there", start: 1.0, end: 1.6 },
        ],
        text: "hello there",
        start: 0.5,
        end: 1.6,
      },
      {
        words: [
          { text: "brave", start: 1.6, end: 2.2 },
          { text: "world", start: 2.2, end: 2.8 },
        ],
        text: "brave world",
        start: 1.6,
        end: 2.8,
      },
    ],
    start: 0.5,
    end: 2.8,
  };
  return { cues: [cue], style: getPreset("bold-pop"), name: "bold-pop" };
}

/**
 * Extract one RGB24 frame at `t` seconds from `file` as a raw pixel buffer (no
 * PNG compression) so two renders can be compared pixel-for-pixel. Returns the
 * decoded `width*height*3` bytes.
 */
async function rawFrame(file: string, t: number): Promise<Buffer> {
  const { stdout } = await execa(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(t),
      "-i",
      file,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return Buffer.from(stdout);
}

/** Mean absolute per-byte difference between two equal-length RGB frames (0–255). */
function meanAbsDiff(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n;
}

/**
 * Mean audio volume (dBFS) of `file` over the window `[ss, ss+dur]`, via ffmpeg's
 * `volumedetect`. More negative = quieter — used to prove the main track ducks
 * during an SFX cue (a lower mean volume with ducking on than off).
 */
async function meanVolumeDb(file: string, ss: number, dur: number): Promise<number> {
  const { stderr } = await execa(
    "ffmpeg",
    ["-hide_banner", "-ss", String(ss), "-t", String(dur), "-i", file, "-af", "volumedetect", "-f", "null", "-"],
    { reject: false },
  );
  const m = /mean_volume:\s*(-?[0-9.]+) dB/.exec(stderr);
  if (!m) throw new Error(`no mean_volume in ffmpeg output:\n${stderr}`);
  return Number(m[1]);
}

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

  it("overlays a pip B-roll slot with a scaled, PTS-shifted, time-gated overlay", () => {
    let doc = buildTimelineDoc(0, 4);
    doc = addBroll(doc, {
      assetId: 9,
      start: 1,
      end: 3,
      mode: "pip",
      pip: { x: 0.5, y: 0.25, scale: 0.5 },
    });
    const args = buildRenderArgs({
      plan: renderPlan({ timeline: doc }),
      inputPaths: { "in:main": "/tmp/in.mp4", "in:asset-9": "/tmp/b.mp4" },
      outputPath: "/tmp/out.mp4",
      preset: PLATFORM_PRESETS.tiktok,
    });
    // The asset is a second ffmpeg input, referenced as [1:v].
    expect(args.filter((a) => a === "-i")).toHaveLength(2);
    const graph = args[args.indexOf("-filter_complex") + 1];
    // Trim to the 2 s window + shift to t=1, scale to 0.5*1080=540 wide, drop at
    // x=0.5*1080=540, y=0.25*1920=480, gated to 1..3 s.
    expect(graph).toContain("[1:v]trim=0:2,setpts=PTS-STARTPTS+1/TB,scale=540:-2");
    expect(graph).toContain("overlay=x=540:y=480:enable='between(t,1,3)'[vout]");
    // Base reframe now feeds the overlay chain, not the muxer directly.
    expect(graph).toContain("[vbase]");
  });

  it("replaces the frame for a full-mode B-roll slot (cover scale + centre crop)", () => {
    let doc = buildTimelineDoc(0, 4);
    doc = addBroll(doc, { assetId: 7, start: 0.5, end: 2, mode: "full" });
    const args = buildRenderArgs({
      plan: renderPlan({ timeline: doc }),
      inputPaths: { "in:main": "/tmp/in.mp4", "in:asset-7": "/tmp/b.mp4" },
      outputPath: "/tmp/out.mp4",
      preset: PLATFORM_PRESETS.tiktok,
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain(
      "[1:v]trim=0:1.5,setpts=PTS-STARTPTS+0.5/TB," +
        "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
    );
    expect(graph).toContain("overlay=x=0:y=0:enable='between(t,0.5,2)'[vout]");
  });

  it("burns a text CTA with drawtext: anchored box, gated + faded to its window", () => {
    let doc = buildTimelineDoc(0, 4);
    doc = addCta(doc, {
      variant: "text",
      content: "Follow for more",
      start: 1,
      end: 3,
      position: "bottom-center",
      animIn: "fade",
      animOut: "fade",
      style: { fontSize: 0.05, color: "#ffffff", background: "rgba(0, 0, 0, 0.6)" },
    });
    const args = buildRenderArgs({
      plan: renderPlan({ timeline: doc }),
      inputPaths: { "in:main": "/tmp/in.mp4" },
      outputPath: "/tmp/out.mp4",
      preset: PLATFORM_PRESETS.tiktok,
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    // Reframe feeds the overlay chain, and the CTA outputs the muxed vout.
    expect(graph).toContain("[vbase]");
    expect(graph).toContain("drawtext=");
    // Escaped text + converted CSS colours (rgba → 0xRRGGBB@a).
    expect(graph).toContain("text=Follow for more");
    expect(graph).toContain("boxcolor=0x000000@0.6");
    expect(graph).toContain("fontcolor=0xFFFFFF");
    // 5% of 1920 = 96 px text, bottom-center anchor centres on x (−0.5*text_w).
    expect(graph).toContain("fontsize=96");
    expect(graph).toContain("(-0.5)*text_w");
    // Gated to 1..3 s and fading both edges (0.4 s) via an alpha ramp.
    expect(graph).toContain("enable='between(t,1,3)'[vout]");
    expect(graph).toContain("alpha='min(");
  });

  it("overlays an image CTA: scaled + faded asset over the anchored cell", () => {
    let doc = buildTimelineDoc(0, 4);
    doc = addCta(doc, {
      variant: "image",
      assetId: 12,
      start: 0.5,
      end: 2.5,
      position: "top-right",
      animIn: "fade",
      animOut: "none",
    });
    const args = buildRenderArgs({
      plan: renderPlan({ timeline: doc }),
      inputPaths: { "in:main": "/tmp/in.mp4", "in:asset-12": "/tmp/logo.png" },
      outputPath: "/tmp/out.mp4",
      preset: PLATFORM_PRESETS.tiktok,
    });
    // The still image is looped across the timeline as a second input.
    expect(args).toContain("-loop");
    const graph = args[args.indexOf("-filter_complex") + 1];
    // 0.4*1080 = 432 wide box, alpha channel, fade in only.
    expect(graph).toContain("[1:v]scale=432:-2,format=rgba,fade=t=in:st=0.5:d=0.4:alpha=1[cimg0]");
    // top-right anchor: right edge hangs off the anchor (−1*overlay_w), gated 0.5..2.5.
    expect(graph).toContain("overlay=x=1037+(-1)*overlay_w:y=77:enable='between(t,0.5,2.5)'[vout]");
  });

  it("layers B-roll under a CTA in plan order (broll → cta → vout)", () => {
    let doc = buildTimelineDoc(0, 4);
    doc = addBroll(doc, { assetId: 9, start: 1, end: 3, mode: "pip", pip: { x: 0.5, y: 0.5, scale: 0.4 } });
    doc = addCta(doc, { variant: "text", content: "Hi", start: 1, end: 3 });
    const args = buildRenderArgs({
      plan: renderPlan({ timeline: doc }),
      inputPaths: { "in:main": "/tmp/in.mp4", "in:asset-9": "/tmp/b.mp4" },
      outputPath: "/tmp/out.mp4",
      preset: PLATFORM_PRESETS.tiktok,
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    // B-roll is the first overlay (outputs vov0), the CTA closes the chain (vout).
    expect(graph).toContain("[vbase][bpip0]overlay=x=540:y=960:enable='between(t,1,3)'[vov0]");
    expect(graph).toContain("[vov0]drawtext=");
    expect(graph).toContain("[vout]");
  });

  it("burns captions last in the video chain via the ass filter", () => {
    const doc = buildTimelineDoc(0, 4);
    const assPath = "/tmp/captions.ass";
    const args = buildRenderArgs({
      plan: renderPlan({ timeline: doc, captions: captionDoc() }),
      inputPaths: { "in:main": "/tmp/in.mp4" },
      outputPath: "/tmp/out.mp4",
      preset: PLATFORM_PRESETS.tiktok,
      captionsAssPath: assPath,
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    // Reframe feeds the caption burn, which outputs the muxed vout.
    expect(graph).toContain("[vbase]");
    expect(graph).toContain(`ass=${assPath}[vout]`);
  });

  it("layers B-roll and a CTA under the caption burn (broll → cta → captions)", () => {
    let doc = buildTimelineDoc(0, 4);
    doc = addBroll(doc, { assetId: 9, start: 1, end: 3, mode: "pip", pip: { x: 0.5, y: 0.5, scale: 0.4 } });
    doc = addCta(doc, { variant: "text", content: "Hi", start: 1, end: 3 });
    const args = buildRenderArgs({
      plan: renderPlan({ timeline: doc, captions: captionDoc() }),
      inputPaths: { "in:main": "/tmp/in.mp4", "in:asset-9": "/tmp/b.mp4" },
      outputPath: "/tmp/out.mp4",
      preset: PLATFORM_PRESETS.tiktok,
      captionsAssPath: "/tmp/c.ass",
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    // B-roll (vov0) → CTA (vov1) → captions (vout): captions closes the chain.
    expect(graph).toContain("[vbase][bpip0]");
    expect(graph).toContain("[vov0]drawtext=");
    expect(graph).toContain("[vov1]ass=/tmp/c.ass[vout]");
  });

  it("rejects a captions plan when no captionsAssPath is provided", () => {
    const doc = buildTimelineDoc(0, 4);
    expect(() =>
      buildRenderArgs({
        plan: renderPlan({ timeline: doc, captions: captionDoc() }),
        inputPaths: { "in:main": "/tmp/in.mp4" },
        outputPath: "/tmp/out.mp4",
        preset: PLATFORM_PRESETS.tiktok,
      }),
    ).toThrow(/captionsAssPath/);
  });

  it("escapes filtergraph meta-characters in the ass path", () => {
    const doc = buildTimelineDoc(0, 4);
    const args = buildRenderArgs({
      plan: renderPlan({ timeline: doc, captions: captionDoc() }),
      inputPaths: { "in:main": "/tmp/in.mp4" },
      outputPath: "/tmp/out.mp4",
      preset: PLATFORM_PRESETS.tiktok,
      captionsAssPath: "/tmp/o'brien.ass",
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    // Single quote escaped so it can't close the filter-option value.
    expect(graph).toContain("ass=/tmp/o\\'brien.ass[vout]");
  });

  it("mixes an SFX cue: gained, delayed to its time, amixed into the main + loudnorm", () => {
    let doc = buildTimelineDoc(0, 4);
    doc = addSfx(doc, { assetId: 5, t: 1, volume: 0.8 });
    const args = buildRenderArgs({
      plan: renderPlan({ timeline: doc }),
      inputPaths: { "in:main": "/tmp/in.mp4", "in:asset-5": "/tmp/sfx.wav" },
      outputPath: "/tmp/out.mp4",
      preset: PLATFORM_PRESETS.tiktok,
    });
    // The SFX asset is a second ffmpeg input.
    expect(args.filter((a) => a === "-i")).toHaveLength(2);
    const graph = args[args.indexOf("-filter_complex") + 1];
    // Gained to 0.8, delayed 1000 ms to t=1, mixed with the main (main first so
    // duration=first pins the output length to the main track).
    expect(graph).toContain("volume=0.8");
    expect(graph).toContain("adelay=1000:all=1[sfxm0]");
    expect(graph).toContain(
      "amix=inputs=2:duration=first:normalize=0:dropout_transition=0[amix]",
    );
    // No ducking cue → no sidechain compressor. Loudnorm on by default.
    expect(graph).not.toContain("sidechaincompress");
    expect(graph).toContain("loudnorm=I=-14");
  });

  it("ducks the main under a ducking SFX cue via a split sidechain compressor", () => {
    let doc = buildTimelineDoc(0, 4);
    doc = addSfx(doc, { assetId: 5, t: 2, volume: 1, duckMain: true });
    const args = buildRenderArgs({
      plan: renderPlan({ timeline: doc }),
      inputPaths: { "in:main": "/tmp/in.mp4", "in:asset-5": "/tmp/sfx.wav" },
      outputPath: "/tmp/out.mp4",
      preset: PLATFORM_PRESETS.tiktok,
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    // The cue is split: one branch mixes into the output, one drives the sidechain.
    expect(graph).toContain("adelay=2000:all=1,asplit=2[sfxm0][sfxd0]");
    expect(graph).toContain("[sfxd0]sidechaincompress");
    expect(graph).toContain("[amaind]");
  });

  it("passes audio through (anull → aout) when loudnorm is disabled", () => {
    const args = buildRenderArgs({
      plan: twoSegmentPlan(),
      inputPaths: { "in:main": "/tmp/in.mp4" },
      outputPath: "/tmp/out.mp4",
      preset: PLATFORM_PRESETS.tiktok,
      loudnorm: false,
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).not.toContain("loudnorm");
    expect(graph).toContain("anull[aout]");
  });

  it("rejects a plan with an unknown node kind (guardrail still trips)", () => {
    const plan = twoSegmentPlan();
    const bogus = { kind: "bogus", id: "bogus:1", inputs: [] } as unknown as (typeof plan.nodes)[number];
    const withBogus = { ...plan, nodes: [...plan.nodes, bogus] };
    expect(() =>
      buildRenderArgs({
        plan: withBogus,
        inputPaths: { "in:main": "/tmp/in.mp4" },
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

  it("renders a pip B-roll overlay clip; probe OK, duration unchanged", async () => {
    let doc = buildTimelineDoc(0, 4);
    doc = addBroll(doc, {
      assetId: 42,
      start: 1,
      end: 3,
      mode: "pip",
      pip: { x: 0.6, y: 0.1, scale: 0.3 },
    });
    const out = path.join(dir, "broll-pip.mp4");
    await executePlan({
      plan: renderPlan({ timeline: doc }),
      inputPaths: { "in:main": SHORT_SAMPLE, "in:asset-42": BROLL_SAMPLE },
      outputPath: out,
      preset: PLATFORM_PRESETS.tiktok,
      quality: "draft",
    });

    expect(existsSync(out)).toBe(true);
    const info = await probe(out);
    // Overlay never lengthens the base → single 4 s segment stays ~4 s.
    expect(info.duration).toBeGreaterThan(4 - 0.3);
    expect(info.duration).toBeLessThan(4 + 0.3);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.hasAudio).toBe(true);
  }, 60_000);

  it("renders a full-mode B-roll switch; probe OK, duration unchanged", async () => {
    let doc = buildTimelineDoc(0, 4);
    doc = addBroll(doc, { assetId: 42, start: 1, end: 3, mode: "full" });
    const out = path.join(dir, "broll-full.mp4");
    await executePlan({
      plan: renderPlan({ timeline: doc }),
      inputPaths: { "in:main": SHORT_SAMPLE, "in:asset-42": BROLL_SAMPLE },
      outputPath: out,
      preset: PLATFORM_PRESETS.tiktok,
      quality: "draft",
    });

    expect(existsSync(out)).toBe(true);
    const info = await probe(out);
    expect(info.duration).toBeGreaterThan(4 - 0.3);
    expect(info.duration).toBeLessThan(4 + 0.3);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.hasAudio).toBe(true);
  }, 60_000);

  it("renders a pip B-roll + image CTA clip; probe OK, duration unchanged", async () => {
    expect(existsSync(LOGO_SAMPLE), `${LOGO_SAMPLE} missing (run npm run fixtures)`).toBe(true);
    let doc = buildTimelineDoc(0, 4);
    doc = addBroll(doc, {
      assetId: 42,
      start: 1,
      end: 3,
      mode: "pip",
      pip: { x: 0.6, y: 0.1, scale: 0.3 },
    });
    doc = addCta(doc, {
      variant: "image",
      assetId: 7,
      start: 0.5,
      end: 3.5,
      position: "top-right",
      animIn: "fade",
      animOut: "fade",
    });
    const out = path.join(dir, "broll-cta.mp4");
    await executePlan({
      plan: renderPlan({ timeline: doc }),
      inputPaths: {
        "in:main": SHORT_SAMPLE,
        "in:asset-42": BROLL_SAMPLE,
        "in:asset-7": LOGO_SAMPLE,
      },
      outputPath: out,
      preset: PLATFORM_PRESETS.tiktok,
      quality: "draft",
    });

    expect(existsSync(out)).toBe(true);
    const info = await probe(out);
    // Overlays never lengthen the base → the single 4 s segment stays ~4 s.
    expect(info.duration).toBeGreaterThan(4 - 0.3);
    expect(info.duration).toBeLessThan(4 + 0.3);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.hasAudio).toBe(true);
  }, 60_000);

  // Real drawtext burn — gated on a libfreetype ffmpeg build (DEC-013). On a
  // minimal build the graph is still asserted by the pure tests above.
  it.runIf(DRAWTEXT_AVAILABLE)(
    "renders a text CTA (drawtext) clip; probe OK, duration unchanged",
    async () => {
      let doc = buildTimelineDoc(0, 4);
      doc = addCta(doc, {
        variant: "text",
        content: "Follow for more",
        start: 1,
        end: 3,
        position: "bottom-center",
        animIn: "fade",
        animOut: "fade",
        style: { fontSize: 0.06, color: "#ffffff", background: "rgba(0, 0, 0, 0.6)" },
      });
      const out = path.join(dir, "cta-text.mp4");
      await executePlan({
        plan: renderPlan({ timeline: doc }),
        inputPaths: { "in:main": SHORT_SAMPLE },
        outputPath: out,
        preset: PLATFORM_PRESETS.tiktok,
        quality: "draft",
      });

      expect(existsSync(out)).toBe(true);
      const info = await probe(out);
      expect(info.duration).toBeGreaterThan(4 - 0.3);
      expect(info.duration).toBeLessThan(4 + 0.3);
      expect(info.width).toBe(1080);
      expect(info.height).toBe(1920);
    },
    60_000,
  );

  it.skipIf(DRAWTEXT_AVAILABLE)(
    "text CTA burn skipped: this ffmpeg build lacks the `drawtext` filter (libfreetype)",
    () => {
      expect(DRAWTEXT_AVAILABLE).toBe(false);
    },
  );

  // Real caption burn — gated on a libass ffmpeg build (DEC-010/DEC-013). Proves
  // burn-in happened by pixel-diffing a frame taken during a caption line against
  // the same frame of a captionless render of the identical timeline.
  it.runIf(ASS_AVAILABLE)(
    "burns captions: a frame during a caption line differs from the captionless render",
    async () => {
      const doc = buildTimelineDoc(0, 4);
      const source = await probe(SHORT_SAMPLE);

      // Captionless render (no captions node → no ass path needed).
      const plain = path.join(dir, "plain.mp4");
      await executePlan({
        plan: renderPlan({ timeline: doc }),
        inputPaths: { "in:main": SHORT_SAMPLE },
        outputPath: plain,
        preset: PLATFORM_PRESETS.tiktok,
        quality: "draft",
      });

      // Captioned render of the same timeline, burning the ASS built at preset res.
      const assPath = path.join(dir, "captions.ass");
      await writeFile(assPath, toAss(captionDoc(), source.width, source.height), "utf8");
      const captioned = path.join(dir, "captioned.mp4");
      await executePlan({
        plan: renderPlan({ timeline: doc, captions: captionDoc() }),
        inputPaths: { "in:main": SHORT_SAMPLE },
        outputPath: captioned,
        preset: PLATFORM_PRESETS.tiktok,
        quality: "draft",
        captionsAssPath: assPath,
      });

      expect(existsSync(captioned)).toBe(true);
      const info = await probe(captioned);
      expect(info.width).toBe(1080);
      expect(info.height).toBe(1920);
      // Burn-in must not change the duration.
      expect(info.duration).toBeGreaterThan(4 - 0.3);
      expect(info.duration).toBeLessThan(4 + 0.3);

      // t = 1.0 s is inside the caption's 0.5–2.8 s span → the burned frame must
      // differ measurably from the captionless one; a captionless-vs-captionless
      // baseline stays near zero, so the caption is what moved the pixels.
      const plainFrame = await rawFrame(plain, 1.0);
      const captionedFrame = await rawFrame(captioned, 1.0);
      expect(meanAbsDiff(plainFrame, captionedFrame)).toBeGreaterThan(1);
    },
    120_000,
  );

  it.skipIf(ASS_AVAILABLE)(
    "caption burn skipped: this ffmpeg build lacks the `ass` filter (libass)",
    () => {
      expect(ASS_AVAILABLE).toBe(false);
    },
  );

  it("renders an SFX-mixed clip; audio present, duration unchanged", async () => {
    expect(existsSync(SFX_SAMPLE), `${SFX_SAMPLE} missing (run npm run fixtures)`).toBe(true);
    let doc = buildTimelineDoc(0, 4);
    doc = addSfx(doc, { assetId: 3, t: 1, volume: 0.6 });
    const out = path.join(dir, "sfx.mp4");
    await executePlan({
      plan: renderPlan({ timeline: doc }),
      inputPaths: { "in:main": SHORT_SAMPLE, "in:asset-3": SFX_SAMPLE },
      outputPath: out,
      preset: PLATFORM_PRESETS.tiktok,
      quality: "draft",
    });

    expect(existsSync(out)).toBe(true);
    const info = await probe(out);
    // amix duration=first pins length to the main track → the 4 s clip stays ~4 s.
    expect(info.duration).toBeGreaterThan(4 - 0.3);
    expect(info.duration).toBeLessThan(4 + 0.3);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.hasAudio).toBe(true);
  }, 60_000);

  it("ducking lowers the main's volume during the SFX window vs no ducking", async () => {
    // Render the same cue with ducking on and off, loudnorm disabled so the
    // normaliser can't compensate the dip (isolates the ducking DSP — DEC).
    const planFor = (duck: boolean) => {
      let doc = buildTimelineDoc(0, 4);
      doc = addSfx(doc, { assetId: 3, t: 1, volume: 0.4, duckMain: duck });
      return renderPlan({ timeline: doc });
    };
    const inputs = { "in:main": SHORT_SAMPLE, "in:asset-3": SFX_SAMPLE };
    const ducked = path.join(dir, "ducked.mp4");
    const plain = path.join(dir, "sfx-noduck.mp4");
    await executePlan({
      plan: planFor(true),
      inputPaths: inputs,
      outputPath: ducked,
      preset: PLATFORM_PRESETS.tiktok,
      quality: "draft",
      loudnorm: false,
    });
    await executePlan({
      plan: planFor(false),
      inputPaths: inputs,
      outputPath: plain,
      preset: PLATFORM_PRESETS.tiktok,
      quality: "draft",
      loudnorm: false,
    });

    expect((await probe(ducked)).hasAudio).toBe(true);
    // Measure a window inside the SFX (1–3 s) after the compressor's attack settles.
    const duckedVol = await meanVolumeDb(ducked, 1.2, 0.6);
    const plainVol = await meanVolumeDb(plain, 1.2, 0.6);
    expect(duckedVol).toBeLessThan(plainVol);
  }, 90_000);
});
