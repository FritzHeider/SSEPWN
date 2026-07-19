/**
 * Execute a {@link RenderPlan} against ffmpeg (SPEC.md § Export, phase-10). This
 * is the counterpart to the pure {@link renderPlan} compiler: it turns the
 * ordered filter-graph plan into a concrete ffmpeg invocation and runs it,
 * producing the platform-ready MP4.
 *
 * THIS FILE IS BUILT UP IN CHUNKS (see phase-10 checklist). This first chunk
 * renders the BASE video/audio spine of every plan — segment cuts, concat,
 * crop/scale to the platform preset resolution, and the main audio track — and
 * encodes H.264 high + AAC 192k with `+faststart`. Nodes for transitions,
 * B-roll, CTA overlays, caption burn-in and SFX are added in later chunks; until
 * then {@link executePlan} rejects a plan containing them with a clear message
 * rather than silently dropping the feature.
 *
 * All ffmpeg args are assembled as an execa argv array (never a shell string),
 * per the global constraint that every ffmpeg invocation lives in
 * `src/lib/ffmpeg/`-shaped code and is passed argv, not shell.
 */

import { cropFilter } from "../crop/filter";
import { runFfmpeg } from "../ffmpeg/exec";
import type { PlatformPreset } from "../presets";
import type { AudioNode, CropNode, RenderNode, RenderPlan, SegmentNode } from "./plan";

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
  "concat",
  "crop",
  "audio",
]);

/** Everything {@link executePlan} needs to render one clip. */
export interface ExecutePlanInput {
  /** The compiled plan (from {@link renderPlan}). */
  plan: RenderPlan;
  /**
   * Filesystem path for each media input id in `plan.inputs`. Must include
   * `in:main`; asset inputs are only referenced by nodes this chunk rejects.
   */
  inputPaths: Record<string, string>;
  /** Where to write the encoded MP4 (overwritten if present). */
  outputPath: string;
  /** Delivery preset — supplies the exact output resolution. */
  preset: PlatformPreset;
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

  const segments = segmentNodes(plan);
  if (segments.length === 0) throw new Error("render plan has no segments to render");

  const parts: string[] = [];
  const vLabels: string[] = [];
  const aLabels: string[] = [];

  // Trim each segment to its source window and reset timestamps.
  segments.forEach((seg, i) => {
    parts.push(
      `[0:v]trim=start=${seg.sourceIn}:end=${seg.sourceOut},setpts=PTS-STARTPTS[v${i}]`,
    );
    parts.push(
      `[0:a]atrim=start=${seg.sourceIn}:end=${seg.sourceOut},asetpts=PTS-STARTPTS[a${i}]`,
    );
    vLabels.push(`[v${i}]`);
    aLabels.push(`[a${i}]`);
  });

  // Concatenate the cut segments into the edited spine (transitions come later).
  const n = segments.length;
  parts.push(`${vLabels.join("")}concat=n=${n}:v=1:a=0[vcat]`);
  parts.push(`${aLabels.join("")}concat=n=${n}:v=0:a=1[acat]`);

  // Reframe to the delivery resolution.
  parts.push(reframeFilter(findCropNode(plan), preset, "vcat", "vout"));

  // Main audio: apply the clip's volume / mute.
  const audio = findAudioNode(plan);
  const gain = audio.muted ? 0 : audio.volume;
  parts.push(`[acat]volume=${gain}[aout]`);

  return [
    "-y",
    "-i",
    mainPath,
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
