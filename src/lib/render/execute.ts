/**
 * Execute a {@link RenderPlan} against ffmpeg (SPEC.md § Export, phase-10). This
 * is the counterpart to the pure {@link renderPlan} compiler: it turns the
 * ordered filter-graph plan into a concrete ffmpeg invocation and runs it,
 * producing the platform-ready MP4.
 *
 * THIS FILE IS BUILT UP IN CHUNKS (see phase-10 checklist). It renders the
 * video/audio spine of every plan — segment cuts, xfade/slide transitions
 * (mirrored as audio acrossfades so the export shortens by the blend), concat,
 * crop/scale to the platform preset resolution, B-roll overlays (floating `pip`
 * box or `full`-frame replacement over the overlay's timeline window), CTA cards
 * (drawtext / image with fades), caption burn-in (the `ass` filter, last in the
 * video chain), the main audio track, one-shot SFX cues (`adelay` + `amix`) with
 * optional sidechain ducking of the main under them, and a −14 LUFS loudness
 * normalise (see {@link buildAudioGraph}) — and encodes H.264 high + AAC 192k with
 * `+faststart`.
 *
 * All ffmpeg args are assembled as an execa argv array (never a shell string),
 * per the global constraint that every ffmpeg invocation lives in
 * `src/lib/ffmpeg/`-shaped code and is passed argv, not shell.
 */

import { cropFilter } from "../crop/filter";
import { escapeFilterPath } from "../ffmpeg/burn";
import { runFfmpeg } from "../ffmpeg/exec";
import type { PlatformPreset } from "../presets";
import { buildAudioGraph } from "./audio";
import type {
  AudioNode,
  BrollNode,
  CaptionsNode,
  ConcatNode,
  CropNode,
  CtaNode,
  RenderNode,
  RenderPlan,
  SegmentNode,
  SfxNode,
  TransitionNode,
} from "./plan";

/** Encoding quality tiers (phase-10). Output RESOLUTION is always the platform
 * preset's — quality only trades encode speed/size for fidelity (see DEC-012). */
export type RenderQuality = "draft" | "final";

/** x264 knobs per quality tier. */
export interface RenderQualitySettings {
  /** Constant Rate Factor — lower is higher quality/larger. */
  crf: number;
  /** libx264 `-preset` (encode speed vs. compression). */
  x264Preset: string;
}

/** Draft favours speed for the "quick preview render"; final favours quality. */
export const RENDER_QUALITY: Record<RenderQuality, RenderQualitySettings> = {
  draft: { crf: 28, x264Preset: "veryfast" },
  final: { crf: 19, x264Preset: "medium" },
};

/** Node kinds this chunk of the executor can render. A plan containing any other
 * kind is rejected (later phase-10 chunks widen this set). */
const SUPPORTED_KINDS: ReadonlySet<RenderNode["kind"]> = new Set<RenderNode["kind"]>([
  "segment",
  "transition",
  "concat",
  "crop",
  "broll",
  "cta",
  "captions",
  "audio",
  "sfx",
  "mix",
]);

/** Inset (fraction of frame) a corner/edge-anchored CTA keeps from the frame edge,
 * matching the preview's `CTA_ANCHOR_MARGIN` (4%) so the burn lands where the
 * editor showed it. */
const CTA_ANCHOR_MARGIN = 0.04;

/** In/out CTA animation length (seconds), clamped to half the overlay span so the
 * in and out fades never overlap. Mirrors the preview's `CTA_ANIM_DURATION`. */
const CTA_ANIM_DURATION = 0.4;

/**
 * ffmpeg `xfade` transition name for each animated {@link TransitionNode.transition}
 * kind. `crossfade` dissolves; `slide-left`/`slide-right` push the outgoing frame
 * off-screen. (`cut` is never a node — plain cuts are stitched by concat.)
 */
const XFADE_TRANSITION: Record<TransitionNode["transition"], string> = {
  crossfade: "fade",
  "slide-left": "slideleft",
  "slide-right": "slideright",
};

/** Format a timeline time for a filter expression: integers stay bare, floats
 * are trimmed to millisecond precision so the graph string stays deterministic
 * (no `0.30000000000000004` noise from binary floats). */
function fmtSeconds(t: number): string {
  return String(Math.round(t * 1000) / 1000);
}

/** Largest even integer `<= n` (ffmpeg's H.264/yuv420p needs even dimensions). */
function evenFloor(n: number): number {
  const i = Math.floor(n);
  return i - (i % 2);
}

/**
 * Filtergraph fragment(s) that overlay one B-roll node onto the reframed video.
 *
 * A `pip` slot scales the asset to a box `pip.scale` of the frame wide (height
 * follows the source aspect ratio) and drops it at the normalised `pip.x`/`pip.y`
 * corner. A `full` slot scales-to-cover and centre-crops the asset to the whole
 * frame, replacing the main image while its audio keeps playing (audio is a
 * separate pipeline). Both trim the asset to the window length and shift its PTS
 * so it plays from its own start across the window, then gate drawing with
 * `enable='between(t,start,end)'`. Trimming keeps the overlay stream inside the
 * base video's span, so overlay (whose output runs as long as its longest input)
 * never lengthens the export — the duration is unchanged. `assetIdx` is the
 * ffmpeg `-i` index of the B-roll input.
 */
function brollFilter(
  node: BrollNode,
  assetIdx: number,
  i: number,
  preset: PlatformPreset,
  inLabel: string,
  outLabel: string,
): string[] {
  const { width: W, height: H } = preset;
  const enable = `enable='between(t,${fmtSeconds(node.start)},${fmtSeconds(node.end)})'`;
  // Take the asset's first `window` seconds and re-base its PTS to the window
  // start, so the overlay stream occupies exactly [start, end] of the timeline.
  const window = fmtSeconds(Math.max(0, node.end - node.start));
  const place = `trim=0:${window},setpts=PTS-STARTPTS+${fmtSeconds(node.start)}/TB`;
  if (node.mode === "full") {
    const src = `bfull${i}`;
    return [
      `[${assetIdx}:v]${place},scale=${W}:${H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H}[${src}]`,
      `[${inLabel}][${src}]overlay=x=0:y=0:${enable}[${outLabel}]`,
    ];
  }
  const boxW = Math.max(2, evenFloor(node.pip.scale * W));
  const x = Math.round(node.pip.x * W);
  const y = Math.round(node.pip.y * H);
  const src = `bpip${i}`;
  return [
    `[${assetIdx}:v]${place},scale=${boxW}:-2[${src}]`,
    `[${inLabel}][${src}]overlay=x=${x}:y=${y}:${enable}[${outLabel}]`,
  ];
}

/** Where a CTA anchors in the frame, as fractions (`leftFrac`/`topFrac`) plus the
 * self-translate (`tX`/`tY`, fraction of the element) that pins it to its 9-grid
 * cell — mirrors {@link ctaAnchor} in `cta-view.ts` so burn == preview. */
function ctaAnchorFrac(node: CtaNode): {
  leftFrac: number;
  topFrac: number;
  tX: number;
  tY: number;
} {
  const [row, col] = node.position.split("-") as [string, string];
  const leftFrac =
    (col === "left" ? CTA_ANCHOR_MARGIN : col === "right" ? 1 - CTA_ANCHOR_MARGIN : 0.5) +
    node.offset.x;
  const topFrac =
    (row === "top" ? CTA_ANCHOR_MARGIN : row === "bottom" ? 1 - CTA_ANCHOR_MARGIN : 0.5) +
    node.offset.y;
  const tX = col === "left" ? 0 : col === "right" ? -1 : -0.5;
  const tY = row === "top" ? 0 : row === "bottom" ? -1 : -0.5;
  return { leftFrac, topFrac, tX, tY };
}

/** Effective in/out fade length for a CTA: {@link CTA_ANIM_DURATION}, capped at
 * half the overlay span so the in/out windows stay disjoint. */
function ctaFadeDur(node: CtaNode): number {
  return Math.min(CTA_ANIM_DURATION, (node.end - node.start) / 2);
}

/**
 * Convert a CSS colour string (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`,
 * or a bare CSS/ffmpeg colour name) to an ffmpeg colour token (`0xRRGGBB` with an
 * optional `@alpha` suffix). Falls back to the raw string for anything unrecognised
 * (ffmpeg already understands named colours like `white`/`black`).
 */
function cssColorToFfmpeg(css: string): string {
  const s = css.trim();
  const hexN = (h: string): string => `0x${h.toUpperCase()}`;
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) {
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    }
    if (h.length === 6) return hexN(h);
    if (h.length === 8) {
      const a = parseInt(h.slice(6, 8), 16) / 255;
      return `${hexN(h.slice(0, 6))}@${fmtSeconds(a)}`;
    }
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/.exec(s);
  if (rgb) {
    const toHex = (n: string): string => Math.min(255, parseInt(n, 10)).toString(16).padStart(2, "0");
    const base = hexN(toHex(rgb[1]) + toHex(rgb[2]) + toHex(rgb[3]));
    return rgb[4] !== undefined ? `${base}@${fmtSeconds(Math.max(0, Math.min(1, Number(rgb[4]))))}` : base;
  }
  return s;
}

/** Escape a run of text so it survives the filtergraph parser as a `drawtext`
 * value: backslash, colon, single-quote, comma and percent are the meta-chars a
 * filter-option value must escape. */
function drawtextEscape(text: string): string {
  return text.replace(/[\\':,%]/g, (c) => `\\${c}`);
}

/**
 * The alpha expression that fades a CTA in at its start and out at its end, or
 * `null` when neither edge animates. `slide` is treated as a fade in this burn
 * pass (see DEC-013). The two edge ramps are combined with `min` so an overlap on
 * a very short span still resolves in `[0,1]`.
 */
function ctaAlphaExpr(node: CtaNode): string | null {
  const d = ctaFadeDur(node);
  const s = fmtSeconds(node.start);
  const e = fmtSeconds(node.end);
  const sd = fmtSeconds(node.start + d);
  const ed = fmtSeconds(node.end - d);
  const dd = fmtSeconds(d);
  const animates = (a: CtaNode["animIn"]): boolean => a === "fade" || a === "slide";
  const terms: string[] = [];
  if (animates(node.animIn)) terms.push(`if(lt(t,${s}),0,if(lt(t,${sd}),(t-${s})/${dd},1))`);
  if (animates(node.animOut)) terms.push(`if(gt(t,${e}),0,if(gt(t,${ed}),(${e}-t)/${dd},1))`);
  if (terms.length === 0) return null;
  return terms.length === 1 ? terms[0] : `min(${terms[0]},${terms[1]})`;
}

/**
 * Filtergraph fragment(s) for a text CTA: a `drawtext` card anchored to its 9-grid
 * cell (+ normalised offset), sized as a fraction of frame height, with the box
 * background, gated to its window and fading in/out via an alpha ramp. `text_w`/
 * `text_h` centre/right-anchor the box relative to its own measured size, matching
 * the preview's translate. (Requires an ffmpeg built with libfreetype; the render
 * is capability-gated, see DEC-013.)
 */
function ctaTextFilter(
  node: CtaNode,
  preset: PlatformPreset,
  inLabel: string,
  outLabel: string,
): string[] {
  const { width: W, height: H } = preset;
  const { leftFrac, topFrac, tX, tY } = ctaAnchorFrac(node);
  const fontSize = Math.max(1, Math.round(node.style.fontSize * H));
  const anchorX = Math.round(leftFrac * W);
  const anchorY = Math.round(topFrac * H);
  const x = `${anchorX}${tX ? `+(${tX})*text_w` : ""}`;
  const y = `${anchorY}${tY ? `+(${tY})*text_h` : ""}`;
  const enable = `enable='between(t,${fmtSeconds(node.start)},${fmtSeconds(node.end)})'`;
  const opts = [
    `text=${drawtextEscape(node.content)}`,
    `fontcolor=${cssColorToFfmpeg(node.style.color)}`,
    `fontsize=${fontSize}`,
    `box=1`,
    `boxcolor=${cssColorToFfmpeg(node.style.background)}`,
    `boxborderw=${Math.max(1, Math.round(fontSize * 0.35))}`,
    `x=${x}`,
    `y=${y}`,
  ];
  const alpha = ctaAlphaExpr(node);
  if (alpha) opts.push(`alpha='${alpha}'`);
  opts.push(enable);
  return [`[${inLabel}]drawtext=${opts.join(":")}[${outLabel}]`];
}

/**
 * Filtergraph fragment(s) for an image CTA: scale the asset to a box `0.4` of the
 * frame wide (aspect preserved), give it an alpha channel, fade it in/out, then
 * overlay it at the anchored cell, gated to its window. The asset is fed as a
 * looped still (`-loop 1 -t duration`) so `fade` has frames to ramp over and the
 * overlay persists across the window. `assetIdx` is the ffmpeg `-i` index.
 */
function ctaImageFilter(
  node: CtaNode,
  assetIdx: number,
  i: number,
  preset: PlatformPreset,
  inLabel: string,
  outLabel: string,
): string[] {
  const { width: W, height: H } = preset;
  const { leftFrac, topFrac, tX, tY } = ctaAnchorFrac(node);
  const boxW = Math.max(2, evenFloor(0.4 * W));
  const d = ctaFadeDur(node);
  const chain = [`scale=${boxW}:-2`, `format=rgba`];
  const animates = (a: CtaNode["animIn"]): boolean => a === "fade" || a === "slide";
  if (animates(node.animIn)) chain.push(`fade=t=in:st=${fmtSeconds(node.start)}:d=${fmtSeconds(d)}:alpha=1`);
  if (animates(node.animOut))
    chain.push(`fade=t=out:st=${fmtSeconds(node.end - d)}:d=${fmtSeconds(d)}:alpha=1`);
  const src = `cimg${i}`;
  const x = `${Math.round(leftFrac * W)}${tX ? `+(${tX})*overlay_w` : ""}`;
  const y = `${Math.round(topFrac * H)}${tY ? `+(${tY})*overlay_h` : ""}`;
  const enable = `enable='between(t,${fmtSeconds(node.start)},${fmtSeconds(node.end)})'`;
  return [
    `[${assetIdx}:v]${chain.join(",")}[${src}]`,
    `[${inLabel}][${src}]overlay=x=${x}:y=${y}:${enable}[${outLabel}]`,
  ];
}

/**
 * Dispatch a CTA node to its variant renderer. A text card burns via `drawtext`;
 * an image card overlays its asset. An `image` CTA with no asset (degenerate) is a
 * pass-through so the video label still threads forward.
 */
function ctaFilter(
  node: CtaNode,
  inputIndex: Map<string, number>,
  i: number,
  preset: PlatformPreset,
  inLabel: string,
  outLabel: string,
): string[] {
  if (node.variant === "image") {
    const assetId = node.inputs[1];
    if (assetId === undefined) return [`[${inLabel}]null[${outLabel}]`];
    const assetIdx = inputIndex.get(assetId);
    if (assetIdx === undefined) {
      throw new Error(`cta ${node.id} references unknown input ${assetId}`);
    }
    return ctaImageFilter(node, assetIdx, i, preset, inLabel, outLabel);
  }
  return ctaTextFilter(node, preset, inLabel, outLabel);
}

/**
 * Filtergraph fragment that burns the clip's caption track over the video via the
 * `ass` filter (libass) — the same filter as the phase-05 {@link burnIn}, so the
 * karaoke sweeps / outline / box the `toAss` document encodes render identically.
 * Captions burn LAST (over B-roll and CTAs), per plan order. The ASS file is a
 * derived artifact the caller writes (from the plan's caption doc at the preset's
 * resolution) and hands in as {@link ExecutePlanInput.captionsAssPath}; the path is
 * escaped so colons/quotes survive the filtergraph parser. (Requires an ffmpeg
 * built with libass; the burn is capability-gated, see DEC-010/DEC-013.)
 */
function captionsFilter(assPath: string, inLabel: string, outLabel: string): string[] {
  return [`[${inLabel}]ass=${escapeFilterPath(assPath)}[${outLabel}]`];
}

/** Everything {@link executePlan} needs to render one clip. */
export interface ExecutePlanInput {
  /** The compiled plan (from {@link renderPlan}). */
  plan: RenderPlan;
  /**
   * Filesystem path for each media input id in `plan.inputs`. Must include
   * `in:main` plus every asset input a supported node references (e.g. each
   * `in:asset-<id>` used by a B-roll overlay).
   */
  inputPaths: Record<string, string>;
  /** Where to write the encoded MP4 (overwritten if present). */
  outputPath: string;
  /** Delivery preset — supplies the exact output resolution. */
  preset: PlatformPreset;
  /**
   * Path to the ASS subtitle file to burn in, required iff the plan contains a
   * `captions` node. The caller renders it from the clip's caption doc with
   * {@link toAss} at the preset's resolution and writes it to disk; the executor
   * feeds the path to the `ass` filter. Ignored when the plan has no captions.
   */
  captionsAssPath?: string;
  /** Apply the −14 LUFS loudness normalise to the output audio. Defaults to
   * `true` (every delivered export is normalised); tests measuring the raw
   * ducking dip disable it so the normaliser can't compensate (see DEC). */
  loudnorm?: boolean;
  /** Encoding tier; defaults to `final`. */
  quality?: RenderQuality;
  /** Coarse progress callback (0–100). Detailed `-progress` parsing lands in a
   * later chunk; this chunk reports start/end only. */
  onProgress?: (pct: number) => void;
  /** Injectable ffmpeg runner (tests can stub it to assert args without running). */
  runFfmpegFn?: (args: string[]) => Promise<unknown>;
}

/** Thrown when a plan uses a feature this chunk of the executor cannot yet render. */
export class UnsupportedNodeError extends Error {
  constructor(kind: string) {
    super(`execute.ts does not yet render node kind "${kind}" (phase-10 pending)`);
    this.name = "UnsupportedNodeError";
  }
}

function segmentNodes(plan: RenderPlan): SegmentNode[] {
  return plan.nodes.filter((n): n is SegmentNode => n.kind === "segment");
}

function findAudioNode(plan: RenderPlan): AudioNode {
  const audio = plan.nodes.find((n): n is AudioNode => n.kind === "audio");
  if (!audio) throw new Error("render plan has no audio node");
  return audio;
}

function findCropNode(plan: RenderPlan): CropNode | undefined {
  return plan.nodes.find((n): n is CropNode => n.kind === "crop");
}

function findConcatNode(plan: RenderPlan): ConcatNode {
  const concat = plan.nodes.find((n): n is ConcatNode => n.kind === "concat");
  if (!concat) throw new Error("render plan has no concat node");
  return concat;
}

/**
 * The rendered video+audio stream a plan node produces, plus its running length.
 * A segment carries its trimmed source window; a transition carries the xfade of
 * its two inputs. Durations chain through a run so each xfade/acrossfade lands at
 * the right offset regardless of where the run sits on the edited timeline.
 */
interface StreamInfo {
  /** Bare filtergraph label for this node's video stream (no brackets). */
  v: string;
  /** Bare filtergraph label for this node's audio stream (no brackets). */
  a: string;
  /** Duration in seconds of the stream this node emits. */
  dur: number;
}

/**
 * Build the video-reframe filter that lands the edited stream on the preset's
 * exact resolution. With a crop node we pan/scale the source-pixel crop window
 * to the target size (via {@link cropFilter}); without one we letterbox the
 * whole frame (scale-to-fit + pad) so the output still probes to exactly
 * `width×height`. `setsar=1` keeps square pixels so probed dimensions are literal.
 */
function reframeFilter(
  crop: CropNode | undefined,
  preset: PlatformPreset,
  inLabel: string,
  outLabel: string,
): string {
  if (crop) {
    const cf = cropFilter(crop.keyframes, {
      outputWidth: preset.width,
      outputHeight: preset.height,
    });
    return `[${inLabel}]${cf},setsar=1[${outLabel}]`;
  }
  const { width: w, height: h } = preset;
  return (
    `[${inLabel}]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[${outLabel}]`
  );
}

/**
 * Assemble the ffmpeg argv for the base render of a plan. PURE — builds strings
 * only, so tests can assert the graph without invoking ffmpeg. Rejects any plan
 * node this chunk cannot render, and requires the `in:main` input path.
 */
export function buildRenderArgs(input: ExecutePlanInput): string[] {
  const { plan, inputPaths, outputPath, preset } = input;
  const quality = RENDER_QUALITY[input.quality ?? "final"];

  for (const node of plan.nodes) {
    if (!SUPPORTED_KINDS.has(node.kind)) throw new UnsupportedNodeError(node.kind);
  }

  const mainPath = inputPaths["in:main"];
  if (!mainPath) throw new Error("executePlan: inputPaths must include in:main");

  // ffmpeg `-i` order mirrors plan.inputs (main first), so `[0:*]` is always the
  // source and each asset gets the next index. Every listed input needs a path;
  // unsupported nodes already threw above, so at this point only main + the
  // assets that supported nodes (B-roll) reference remain.
  const inputIndex = new Map<string, number>();
  const inputArgs: string[] = [];
  plan.inputs.forEach((mi, idx) => {
    const p = inputPaths[mi.id];
    if (!p) throw new Error(`executePlan: inputPaths missing path for ${mi.id}`);
    inputIndex.set(mi.id, idx);
    // A CTA image asset is a still: loop it across the edited timeline so `fade`
    // has real frames and `overlay` holds it for its whole window.
    if (mi.role === "cta-image") {
      inputArgs.push("-loop", "1", "-t", fmtSeconds(plan.duration), "-i", p);
    } else {
      inputArgs.push("-i", p);
    }
  });

  const segments = segmentNodes(plan);
  if (segments.length === 0) throw new Error("render plan has no segments to render");

  const parts: string[] = [];
  // Rendered stream per plan node id — segments trim the source; transitions
  // xfade/acrossfade the streams before them, chaining durations along the run.
  const streams = new Map<string, StreamInfo>();

  // Trim each segment to its source window and reset timestamps.
  segments.forEach((seg, i) => {
    parts.push(
      `[0:v]trim=start=${seg.sourceIn}:end=${seg.sourceOut},setpts=PTS-STARTPTS[v${i}]`,
    );
    parts.push(
      `[0:a]atrim=start=${seg.sourceIn}:end=${seg.sourceOut},asetpts=PTS-STARTPTS[a${i}]`,
    );
    streams.set(seg.id, { v: `v${i}`, a: `a${i}`, dur: seg.sourceOut - seg.sourceIn });
  });

  // Blend transitioned boundaries: xfade the video and acrossfade the audio,
  // each shortening its run by the transition duration. The xfade offset is the
  // left stream's accumulated length minus the blend, so chained transitions in
  // one run land correctly (plan nodes are already in dependency order).
  const transitions = plan.nodes.filter((n): n is TransitionNode => n.kind === "transition");
  transitions.forEach((xf, k) => {
    const left = streams.get(xf.inputs[0]);
    const right = streams.get(xf.inputs[1]);
    if (!left || !right) throw new Error(`transition ${xf.id} references an unbuilt stream`);
    const name = XFADE_TRANSITION[xf.transition];
    const offset = left.dur - xf.duration;
    parts.push(
      `[${left.v}][${right.v}]xfade=transition=${name}:duration=${xf.duration}:offset=${offset}[xfv${k}]`,
    );
    parts.push(`[${left.a}][${right.a}]acrossfade=d=${xf.duration}[xfa${k}]`);
    streams.set(xf.id, {
      v: `xfv${k}`,
      a: `xfa${k}`,
      dur: left.dur + right.dur - xf.duration,
    });
  });

  // Concatenate the runs (lone segments and transition chains) into the spine.
  const runs = findConcatNode(plan).inputs.map((id) => {
    const info = streams.get(id);
    if (!info) throw new Error(`concat references an unbuilt run ${id}`);
    return info;
  });
  let vSpine: string;
  let aSpine: string;
  if (runs.length > 1) {
    const n = runs.length;
    parts.push(`${runs.map((r) => `[${r.v}]`).join("")}concat=n=${n}:v=1:a=0[vcat]`);
    parts.push(`${runs.map((r) => `[${r.a}]`).join("")}concat=n=${n}:v=0:a=1[acat]`);
    vSpine = "vcat";
    aSpine = "acat";
  } else {
    // Single run (every boundary blended): the run's own stream is the spine.
    vSpine = runs[0].v;
    aSpine = runs[0].a;
  }

  // Reframe to the delivery resolution, then thread the video through the overlay
  // chain in plan order: B-roll (under), then CTA (over), then caption burn-in
  // (last, on top of everything). The last step outputs the muxed `vout`; with no
  // steps the reframe is `vout` directly.
  const brolls = plan.nodes.filter((n): n is BrollNode => n.kind === "broll");
  const ctas = plan.nodes.filter((n): n is CtaNode => n.kind === "cta");
  const captionsNode = plan.nodes.find((n): n is CaptionsNode => n.kind === "captions");
  const steps: Array<
    | { kind: "broll"; node: BrollNode }
    | { kind: "cta"; node: CtaNode }
    | { kind: "captions"; node: CaptionsNode }
  > = [
    ...brolls.map((node) => ({ kind: "broll" as const, node })),
    ...ctas.map((node) => ({ kind: "cta" as const, node })),
  ];
  if (captionsNode) steps.push({ kind: "captions", node: captionsNode });
  const reframeOut = steps.length > 0 ? "vbase" : "vout";
  parts.push(reframeFilter(findCropNode(plan), preset, vSpine, reframeOut));

  let videoLabel = reframeOut;
  steps.forEach((step, i) => {
    const outLabel = i === steps.length - 1 ? "vout" : `vov${i}`;
    if (step.kind === "broll") {
      const assetId = step.node.inputs[1];
      const assetIdx = inputIndex.get(assetId);
      if (assetIdx === undefined) {
        throw new Error(`broll ${step.node.id} references unknown input ${assetId}`);
      }
      parts.push(...brollFilter(step.node, assetIdx, i, preset, videoLabel, outLabel));
    } else if (step.kind === "cta") {
      parts.push(...ctaFilter(step.node, inputIndex, i, preset, videoLabel, outLabel));
    } else {
      if (!input.captionsAssPath) {
        throw new Error(
          "executePlan: plan has a captions node but no captionsAssPath was provided",
        );
      }
      parts.push(...captionsFilter(input.captionsAssPath, videoLabel, outLabel));
    }
    videoLabel = outLabel;
  });

  // Audio: main track (volume/mute) + one-shot SFX (adelay/amix) with optional
  // sidechain ducking, then a −14 LUFS loudness normalise. See buildAudioGraph.
  const sfx = plan.nodes.filter((n): n is SfxNode => n.kind === "sfx");
  parts.push(
    ...buildAudioGraph({
      aSpine,
      audio: findAudioNode(plan),
      sfx,
      inputIndex,
      loudnorm: input.loudnorm ?? true,
      outLabel: "aout",
    }),
  );

  return [
    "-y",
    ...inputArgs,
    "-filter_complex",
    parts.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    quality.x264Preset,
    "-crf",
    String(quality.crf),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

/**
 * Render a plan to `outputPath`. Builds the argv with {@link buildRenderArgs}
 * and runs ffmpeg (or the injected runner). Reports coarse progress; a failing
 * ffmpeg run rejects with execa's error (stderr included) so the caller can
 * surface it into the job's error column.
 */
export async function executePlan(input: ExecutePlanInput): Promise<void> {
  const args = buildRenderArgs(input);
  input.onProgress?.(0);
  const run = input.runFfmpegFn ?? runFfmpeg;
  await run(args);
  input.onProgress?.(100);
}
