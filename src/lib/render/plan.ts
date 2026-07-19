/**
 * The render plan compiler (Phase 08 crux; SPEC.md § "renderPlan compiles the
 * full edit doc into an ordered ffmpeg filter-graph plan"). {@link renderPlan}
 * is a PURE function that turns a clip's edit — its timeline (segments,
 * transitions, B-roll/CTA overlays, SFX cues, audio), crop, and captions — into
 * a typed, ordered filter-graph plan. It is the GROUND TRUTH for a clip's edited
 * render: the editor's DOM/WebAudio preview only approximates, but every feature
 * that lands in the editor must appear here, exactly once, in dependency order.
 *
 * Phase 10 executes this plan against ffmpeg; this phase only has to produce it,
 * completely and deterministically. Nothing here shells out or reads the clock —
 * like the rest of the timeline lib it is pure data, so the same edit always
 * compiles to a deep-equal plan (a hard Phase-08 acceptance criterion).
 *
 * The plan is a small DAG: a flat list of media {@link RenderMediaInput}s (the
 * source plus each referenced asset, deduped) and an ordered {@link RenderNode}
 * list. A node names its inputs by id; the video pipeline threads a single label
 * forward (segments → transitions → concat → crop → B-roll → CTA → captions) and
 * the audio pipeline runs alongside (main track → SFX → mix), so every node's
 * node-inputs already appear earlier in the list — the plan is topologically
 * ordered by construction (see {@link isDependencyOrdered}).
 */

import type { CaptionDoc } from "../captions/ass";
import { DEFAULT_STYLE_NAME } from "../captions/ass";
import type { CropState } from "../crop/state";
import type { AspectRatio, CropKeyframe } from "../crop/types";
import type { BrollMode, BrollPip } from "../timeline/broll";
import { listBroll } from "../timeline/broll";
import { remapCaptions } from "../timeline/captions";
import type {
  CtaAnim,
  CtaOffset,
  CtaPosition,
  CtaStyle,
  CtaVariant,
} from "../timeline/cta";
import { listCta } from "../timeline/cta";
import { segmentStarts, totalDuration } from "../timeline/ops";
import { listSfx } from "../timeline/sfx";
import { CUT, getTransition } from "../timeline/transitions";
import type { TimelineDoc, TransitionKind } from "../timeline/types";

/**
 * A media file feeding the graph: the clip's source (`main`) or an asset row
 * referenced by an overlay/cue. Deduped by id so an asset used by two slots is
 * decoded once; `assetId` is `null` only for the main source.
 */
export interface RenderMediaInput {
  /** Stable id referenced by node `inputs` (`in:main` | `in:asset-<id>`). */
  id: string;
  role: "main" | "broll" | "cta-image" | "sfx";
  /** `assets` row id, or `null` for the clip's own source video. */
  assetId: number | null;
}

/** Fields every filter-graph node shares: a unique id and the ids of the
 * streams (media inputs or earlier nodes) it consumes. */
export interface RenderNodeBase {
  id: string;
  /** Ids of this node's inputs, each an earlier node id or a media input id. */
  inputs: string[];
}

/** Trim the source to one playable segment's `[sourceIn, sourceOut]` window. */
export interface SegmentNode extends RenderNodeBase {
  kind: "segment";
  /** Playback-order index (0-based). */
  index: number;
  segmentId: string;
  sourceIn: number;
  sourceOut: number;
}

/** Blend two adjacent segments at a boundary (`crossfade`/`slide-*`). Cuts are
 * not nodes — they are handled by {@link ConcatNode}. In a run of transitioned
 * segments these chain: the left input may be an earlier transition's output. */
export interface TransitionNode extends RenderNodeBase {
  kind: "transition";
  transition: Exclude<TransitionKind, "cut">;
  duration: number;
  leftSegmentId: string;
  rightSegmentId: string;
  /** Timeline time the blend begins (right segment's start minus `duration`). */
  offset: number;
}

/** Concatenate the ordered video runs (transition-joined or lone segments) into
 * the single edited-timeline video stream. */
export interface ConcatNode extends RenderNodeBase {
  kind: "concat";
  /** Number of runs joined (segments minus non-cut boundaries). */
  pieces: number;
}

/** Reframe the edited video to the chosen aspect ratio, panning across the
 * source-pixel crop keyframes. */
export interface CropNode extends RenderNodeBase {
  kind: "crop";
  aspectRatio: AspectRatio;
  keyframes: CropKeyframe[];
  srcWidth: number;
  srcHeight: number;
}

/** Overlay a B-roll asset over the timeline for its range, as a floating `pip`
 * box or a `full`-frame replacement. */
export interface BrollNode extends RenderNodeBase {
  kind: "broll";
  overlayId: string;
  assetId: number;
  mode: BrollMode;
  start: number;
  end: number;
  pip: BrollPip;
}

/** Overlay a text card or an image CTA for its range, anchored + animated. */
export interface CtaNode extends RenderNodeBase {
  kind: "cta";
  overlayId: string;
  variant: CtaVariant;
  content: string;
  assetId: number | null;
  position: CtaPosition;
  offset: CtaOffset;
  start: number;
  end: number;
  animIn: CtaAnim;
  animOut: CtaAnim;
  style: CtaStyle;
}

/** Burn the clip's caption track (re-mapped to edited-timeline time) over the
 * video. `cues` is the count after re-mapping, so a doc that lost cues to
 * deleted segments compiles to the right node deterministically. */
export interface CaptionsNode extends RenderNodeBase {
  kind: "captions";
  cues: number;
  styleName: string;
}

/** The main audio track: the segments' audio concatenated in playback order,
 * with the clip's volume/mute applied. */
export interface AudioNode extends RenderNodeBase {
  kind: "audio";
  volume: number;
  muted: boolean;
}

/** Schedule one one-shot SFX asset at timeline time `t`. */
export interface SfxNode extends RenderNodeBase {
  kind: "sfx";
  cueId: string;
  assetId: number;
  t: number;
  volume: number;
  duckMain: boolean;
}

/** Mix the main audio with every SFX cue; `duckMain` when any cue ducks. */
export interface AudioMixNode extends RenderNodeBase {
  kind: "mix";
  duckMain: boolean;
}

/** A node in the compiled filter graph (discriminated by `kind`). */
export type RenderNode =
  | SegmentNode
  | TransitionNode
  | ConcatNode
  | CropNode
  | BrollNode
  | CtaNode
  | CaptionsNode
  | AudioNode
  | SfxNode
  | AudioMixNode;

/** The compiled, ordered filter-graph plan for one clip's edited render. */
export interface RenderPlan {
  version: 1;
  /** Total edited-playback length in seconds. */
  duration: number;
  /** Target aspect ratio when the clip is cropped, else `null`. */
  aspectRatio: AspectRatio | null;
  /** Every media file the graph decodes, deduped, main first. */
  inputs: RenderMediaInput[];
  /** Filter-graph nodes in dependency (topological) order. */
  nodes: RenderNode[];
  /** Final stream labels the muxer reads. */
  output: { video: string; audio: string };
}

/** The clip edit renderPlan compiles: its timeline plus the crop and captions
 * that live beside it in `clip_edits.state`. */
export interface RenderPlanInput {
  timeline: TimelineDoc;
  crop?: CropState | null;
  captions?: CaptionDoc | null;
}

/** Node id for a segment's trim node. */
function segNodeId(segId: string): string {
  return `seg:${segId}`;
}

/**
 * Compile a clip edit into its {@link RenderPlan}. Pure and deterministic: the
 * same input always yields a deep-equal plan. The returned `nodes` are in
 * dependency order — every node's node-typed inputs appear earlier — so a Phase-10
 * executor can emit the filtergraph in a single forward pass.
 */
export function renderPlan(input: RenderPlanInput): RenderPlan {
  const { timeline } = input;
  const crop = input.crop ?? null;
  const captions = input.captions ?? null;

  const { segments } = timeline;
  const starts = segmentStarts(timeline);
  const duration = totalDuration(timeline);

  const nodes: RenderNode[] = [];
  const inputs: RenderMediaInput[] = [{ id: "in:main", role: "main", assetId: null }];
  const seenInputs = new Set<string>(["in:main"]);

  /** Register (or reuse) a media input for an asset, returning its id. First
   * use fixes the recorded `role`; later uses of the same asset reuse it. */
  function assetInput(assetId: number, role: RenderMediaInput["role"]): string {
    const id = `in:asset-${assetId}`;
    if (!seenInputs.has(id)) {
      seenInputs.add(id);
      inputs.push({ id, role, assetId });
    }
    return id;
  }

  // 1. One trim node per segment, in playback order.
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    nodes.push({
      kind: "segment",
      id: segNodeId(s.id),
      inputs: ["in:main"],
      index: i,
      segmentId: s.id,
      sourceIn: s.sourceIn,
      sourceOut: s.sourceOut,
    });
  }

  // 2. Walk boundaries, building runs of transition-joined segments. A non-cut
  // boundary emits a transition node and folds into the run; a cut (or the last
  // segment) closes the current run. Cuts are stitched by the concat node.
  const runLabels: string[] = [];
  let runLabel: string | null = null;
  for (let i = 0; i < segments.length; i++) {
    const cur = segments[i];
    if (runLabel === null) runLabel = segNodeId(cur.id);
    const boundary = i < segments.length - 1 ? getTransition(timeline, cur.id) : CUT;
    if (i < segments.length - 1 && boundary.kind !== "cut") {
      const right = segments[i + 1];
      const xfId = `xf:${cur.id}`;
      nodes.push({
        kind: "transition",
        id: xfId,
        inputs: [runLabel, segNodeId(right.id)],
        transition: boundary.kind,
        duration: boundary.duration,
        leftSegmentId: cur.id,
        rightSegmentId: right.id,
        offset: Math.max(0, starts[i + 1] - boundary.duration),
      });
      runLabel = xfId;
    } else {
      runLabels.push(runLabel);
      runLabel = null;
    }
  }

  // 3. Concatenate the runs into the edited-timeline video.
  nodes.push({ kind: "concat", id: "concat:v", inputs: runLabels, pieces: runLabels.length });
  let videoLabel = "concat:v";

  // 4. Crop / reframe (optional).
  let aspectRatio: AspectRatio | null = null;
  if (crop) {
    aspectRatio = crop.aspectRatio;
    nodes.push({
      kind: "crop",
      id: "crop:v",
      inputs: [videoLabel],
      aspectRatio: crop.aspectRatio,
      keyframes: crop.keyframes,
      srcWidth: crop.srcWidth,
      srcHeight: crop.srcHeight,
    });
    videoLabel = "crop:v";
  }

  // 5. B-roll overlays (track order) — under the CTAs and captions.
  for (const slot of listBroll(timeline)) {
    const id = `broll:${slot.id}`;
    nodes.push({
      kind: "broll",
      id,
      inputs: [videoLabel, assetInput(slot.assetId, "broll")],
      overlayId: slot.id,
      assetId: slot.assetId,
      mode: slot.mode,
      start: slot.start,
      end: slot.end,
      pip: slot.pip,
    });
    videoLabel = id;
  }

  // 6. CTA overlays (track order) — above B-roll, below captions.
  for (const cta of listCta(timeline)) {
    const nodeInputs = [videoLabel];
    if (cta.variant === "image" && cta.assetId !== null) {
      nodeInputs.push(assetInput(cta.assetId, "cta-image"));
    }
    const id = `cta:${cta.id}`;
    nodes.push({
      kind: "cta",
      id,
      inputs: nodeInputs,
      overlayId: cta.id,
      variant: cta.variant,
      content: cta.content,
      assetId: cta.assetId,
      position: cta.position,
      offset: cta.offset,
      start: cta.start,
      end: cta.end,
      animIn: cta.animIn,
      animOut: cta.animOut,
      style: cta.style,
    });
    videoLabel = id;
  }

  // 7. Captions burned last, on top of everything (optional).
  if (captions) {
    const remapped = remapCaptions(captions, timeline);
    nodes.push({
      kind: "captions",
      id: "captions:v",
      inputs: [videoLabel],
      cues: remapped.cues.length,
      styleName: captions.name ?? DEFAULT_STYLE_NAME,
    });
    videoLabel = "captions:v";
  }

  // 8. Main audio: the segments' audio concatenated, with volume/mute.
  nodes.push({
    kind: "audio",
    id: "audio:main",
    inputs: segments.map((s) => segNodeId(s.id)),
    volume: timeline.audio.volume,
    muted: timeline.audio.muted,
  });
  let audioLabel = "audio:main";

  // 9. SFX cues, then a mix node when there is at least one.
  const cues = listSfx(timeline);
  const sfxIds: string[] = [];
  for (const cue of cues) {
    const id = `sfx:${cue.id}`;
    nodes.push({
      kind: "sfx",
      id,
      inputs: [assetInput(cue.assetId, "sfx")],
      cueId: cue.id,
      assetId: cue.assetId,
      t: cue.t,
      volume: cue.volume,
      duckMain: cue.duckMain,
    });
    sfxIds.push(id);
  }
  if (sfxIds.length > 0) {
    nodes.push({
      kind: "mix",
      id: "mix:a",
      inputs: [audioLabel, ...sfxIds],
      duckMain: cues.some((c) => c.duckMain),
    });
    audioLabel = "mix:a";
  }

  return {
    version: 1,
    duration,
    aspectRatio,
    inputs,
    nodes,
    output: { video: videoLabel, audio: audioLabel },
  };
}

/**
 * True when {@link RenderPlan.nodes} is in dependency order: every input that
 * names a node (not a media input) refers to a node earlier in the list. Media
 * input ids are available from the start, so they always satisfy the check. Used
 * by the tests to assert the plan is a valid single-pass filtergraph.
 */
export function isDependencyOrdered(plan: RenderPlan): boolean {
  const available = new Set<string>(plan.inputs.map((i) => i.id));
  for (const node of plan.nodes) {
    for (const dep of node.inputs) {
      if (!available.has(dep)) return false;
    }
    available.add(node.id);
  }
  return true;
}
