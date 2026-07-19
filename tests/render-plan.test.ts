import { describe, expect, it } from "vitest";

import { groupCues, type CaptionLine, type CaptionWord } from "../src/lib/captions/clip";
import type { CaptionDoc } from "../src/lib/captions/ass";
import { resolveStyle } from "../src/lib/captions/style";
import { buildCropState } from "../src/lib/crop/state";
import type { CropKeyframe } from "../src/lib/crop/types";
import {
  isDependencyOrdered,
  renderPlan,
  type RenderNode,
  type RenderPlan,
  type RenderPlanInput,
} from "../src/lib/render/plan";
import { addBroll } from "../src/lib/timeline/broll";
import { addCta } from "../src/lib/timeline/cta";
import { splitAt } from "../src/lib/timeline/ops";
import { addSfx } from "../src/lib/timeline/sfx";
import { buildTimelineDoc } from "../src/lib/timeline/state";
import { setTransition } from "../src/lib/timeline/transitions";
import type { TimelineDoc } from "../src/lib/timeline/types";

/** Count the nodes of a given kind in a plan. */
function count(plan: RenderPlan, kind: RenderNode["kind"]): number {
  return plan.nodes.filter((n) => n.kind === kind).length;
}

/** The single node of a kind (throws if not exactly one — keeps tests honest). */
function only<K extends RenderNode["kind"]>(
  plan: RenderPlan,
  kind: K,
): Extract<RenderNode, { kind: K }> {
  const found = plan.nodes.filter((n) => n.kind === kind);
  expect(found).toHaveLength(1);
  return found[0] as Extract<RenderNode, { kind: K }>;
}

function word(text: string, start: number, end: number): CaptionWord {
  return { text, start, end };
}

function line(words: CaptionWord[]): CaptionLine {
  return {
    words,
    text: words.map((w) => w.text).join(" "),
    start: words[0].start,
    end: words[words.length - 1].end,
  };
}

function captionDoc(lines: CaptionLine[]): CaptionDoc {
  return { cues: groupCues(lines, 1), style: resolveStyle(undefined), name: "Caption" };
}

/** One 9:16 crop keyframe over a 1920×1080 source (values are arbitrary here). */
function cropKeyframe(): CropKeyframe {
  return { t: 0, x: 420, y: 0, w: 1080, h: 1920 };
}

/**
 * The full Phase-08 acceptance scenario: a 20s clip cut into two 10s segments
 * joined by a crossfade, with one pip B-roll, one SFX cue, one text CTA,
 * captions, and a 9:16 crop.
 */
function fullEdit(): RenderPlanInput {
  let doc: TimelineDoc = buildTimelineDoc(0, 20);
  doc = splitAt(doc, 10); // seg-1 0..10, seg-2 10..20
  doc = setTransition(doc, doc.segments[0].id, "crossfade", 0.5);
  doc = addBroll(doc, { assetId: 5, start: 2, end: 6, mode: "pip" });
  doc = addSfx(doc, { assetId: 7, t: 4, volume: 1, duckMain: true });
  doc = addCta(doc, { variant: "text", content: "Follow for more", start: 1, end: 5 });
  const crop = buildCropState("9:16", [cropKeyframe()], 1920, 1080);
  const captions = captionDoc([line([word("hello", 1, 3)]), line([word("world", 5, 7)])]);
  return { timeline: doc, crop, captions };
}

describe("renderPlan — full-feature compilation", () => {
  it("contains each feature node exactly once (segments per segment)", () => {
    const plan = renderPlan(fullEdit());
    expect(count(plan, "segment")).toBe(2);
    expect(count(plan, "transition")).toBe(1);
    expect(count(plan, "concat")).toBe(1);
    expect(count(plan, "crop")).toBe(1);
    expect(count(plan, "broll")).toBe(1);
    expect(count(plan, "cta")).toBe(1);
    expect(count(plan, "captions")).toBe(1);
    expect(count(plan, "audio")).toBe(1);
    expect(count(plan, "sfx")).toBe(1);
    expect(count(plan, "mix")).toBe(1);
  });

  it("emits the nodes in dependency (topological) order", () => {
    const plan = renderPlan(fullEdit());
    expect(isDependencyOrdered(plan)).toBe(true);
  });

  it("threads the video pipeline segments → concat → crop → broll → cta → captions", () => {
    const plan = renderPlan(fullEdit());
    const concat = only(plan, "concat");
    const crop = only(plan, "crop");
    const broll = only(plan, "broll");
    const cta = only(plan, "cta");
    const captions = only(plan, "captions");

    // The transition joins the two segments; concat consumes the run.
    const transition = only(plan, "transition");
    expect(transition.inputs).toEqual(["seg:seg-1", "seg:seg-2"]);
    expect(concat.inputs).toEqual([transition.id]);

    expect(crop.inputs).toEqual([concat.id]);
    expect(broll.inputs[0]).toBe(crop.id);
    expect(cta.inputs[0]).toBe(broll.id);
    expect(captions.inputs).toEqual([cta.id]);
    expect(plan.output.video).toBe(captions.id);
  });

  it("threads the audio pipeline main → mix over the SFX cue", () => {
    const plan = renderPlan(fullEdit());
    const audio = only(plan, "audio");
    const sfx = only(plan, "sfx");
    const mix = only(plan, "mix");
    expect(audio.inputs).toEqual(["seg:seg-1", "seg:seg-2"]);
    expect(mix.inputs).toEqual([audio.id, sfx.id]);
    expect(mix.duckMain).toBe(true);
    expect(plan.output.audio).toBe(mix.id);
  });

  it("preserves feature parameters faithfully", () => {
    const plan = renderPlan(fullEdit());
    const transition = only(plan, "transition");
    expect(transition.transition).toBe("crossfade");
    expect(transition.duration).toBe(0.5);

    const crop = only(plan, "crop");
    expect(crop.aspectRatio).toBe("9:16");
    expect(crop.keyframes).toEqual([cropKeyframe()]);
    expect(plan.aspectRatio).toBe("9:16");

    const broll = only(plan, "broll");
    expect(broll.mode).toBe("pip");
    expect(broll.assetId).toBe(5);
    expect({ start: broll.start, end: broll.end }).toEqual({ start: 2, end: 6 });

    const cta = only(plan, "cta");
    expect(cta.variant).toBe("text");
    expect(cta.content).toBe("Follow for more");

    const captions = only(plan, "captions");
    // Two clip-relative lines re-map + re-group (maxLines=2) into one on-screen cue.
    expect(captions.cues).toBe(1);
    expect(captions.styleName).toBe("Caption");

    expect(plan.duration).toBe(20);
  });

  it("registers a media input per distinct asset, deduped, main first", () => {
    const plan = renderPlan(fullEdit());
    expect(plan.inputs[0]).toEqual({ id: "in:main", role: "main", assetId: null });
    // B-roll asset 5 and SFX asset 7; the text CTA references no asset.
    expect(plan.inputs.map((i) => i.assetId)).toEqual([null, 5, 7]);
    expect(plan.inputs.find((i) => i.assetId === 5)?.role).toBe("broll");
    expect(plan.inputs.find((i) => i.assetId === 7)?.role).toBe("sfx");
  });
});

describe("renderPlan — determinism", () => {
  it("compiles the same edit to a deep-equal plan", () => {
    const a = renderPlan(fullEdit());
    const b = renderPlan(fullEdit());
    expect(a).toEqual(b);
  });

  it("does not mutate its input timeline", () => {
    const input = fullEdit();
    const before = JSON.parse(JSON.stringify(input.timeline));
    renderPlan(input);
    expect(input.timeline).toEqual(before);
  });
});

describe("renderPlan — minimal edit", () => {
  it("compiles a single un-edited segment to segment → concat → audio", () => {
    const plan = renderPlan({ timeline: buildTimelineDoc(0, 12) });
    expect(count(plan, "segment")).toBe(1);
    expect(count(plan, "concat")).toBe(1);
    expect(count(plan, "audio")).toBe(1);
    expect(count(plan, "transition")).toBe(0);
    expect(count(plan, "crop")).toBe(0);
    expect(count(plan, "captions")).toBe(0);
    expect(count(plan, "mix")).toBe(0);
    expect(plan.aspectRatio).toBeNull();
    expect(plan.inputs).toEqual([{ id: "in:main", role: "main", assetId: null }]);
    expect(plan.output).toEqual({ video: "concat:v", audio: "audio:main" });
    expect(isDependencyOrdered(plan)).toBe(true);
  });
});

describe("renderPlan — transitions and runs", () => {
  it("chains a crossfade run and closes it at a cut", () => {
    // 3 segments (0..10, 10..20, 20..30): crossfade seg1→seg2, cut seg2→seg3.
    let doc = buildTimelineDoc(0, 30);
    doc = splitAt(doc, 10);
    doc = splitAt(doc, 20);
    doc = setTransition(doc, doc.segments[0].id, "crossfade", 0.4);
    const plan = renderPlan({ timeline: doc });

    expect(count(plan, "transition")).toBe(1);
    const concat = only(plan, "concat");
    // Two runs: the transition-joined pair, then the lone third segment.
    expect(concat.pieces).toBe(2);
    expect(concat.inputs).toHaveLength(2);
    expect(concat.inputs[1]).toBe(`seg:${doc.segments[2].id}`);
    expect(isDependencyOrdered(plan)).toBe(true);
  });

  it("folds two consecutive crossfades into one run (xfade chain)", () => {
    let doc = buildTimelineDoc(0, 30);
    doc = splitAt(doc, 10);
    doc = splitAt(doc, 20);
    doc = setTransition(doc, doc.segments[0].id, "crossfade", 0.4);
    doc = setTransition(doc, doc.segments[1].id, "slide-left", 0.4);
    const plan = renderPlan({ timeline: doc });

    expect(count(plan, "transition")).toBe(2);
    const concat = only(plan, "concat");
    expect(concat.pieces).toBe(1); // one run spanning all three segments
    // Second transition consumes the first transition's output (the chain).
    const transitions = plan.nodes.filter((n) => n.kind === "transition");
    expect(transitions[1].inputs[0]).toBe(transitions[0].id);
    expect(isDependencyOrdered(plan)).toBe(true);
  });
});

describe("renderPlan — image CTA", () => {
  it("adds an image input and wires it into the CTA node", () => {
    let doc = buildTimelineDoc(0, 20);
    doc = addCta(doc, { variant: "image", assetId: 9, start: 1, end: 5 });
    const plan = renderPlan({ timeline: doc });

    const cta = only(plan, "cta");
    expect(cta.variant).toBe("image");
    expect(cta.assetId).toBe(9);
    expect(cta.inputs).toHaveLength(2);
    expect(cta.inputs[1]).toBe("in:asset-9");
    expect(plan.inputs.find((i) => i.assetId === 9)?.role).toBe("cta-image");
  });
});

describe("isDependencyOrdered", () => {
  it("rejects a plan whose nodes are out of order", () => {
    const plan = renderPlan(fullEdit());
    const broken: RenderPlan = { ...plan, nodes: [...plan.nodes].reverse() };
    expect(isDependencyOrdered(broken)).toBe(false);
  });
});
