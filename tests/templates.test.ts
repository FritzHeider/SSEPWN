import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CaptionDoc } from "../src/lib/captions/ass";
import { resolveStyle } from "../src/lib/captions/style";
import { buildCropState } from "../src/lib/crop/state";
import {
  PLATFORM_PRESETS,
  exceedsMaxLength,
  formatMaxLength,
  maxLengthWarning,
  readClipPreset,
  resolvePlatformPreset,
  resolvePresetSelection,
  withClipPreset,
} from "../src/lib/presets";
import { templates as templatesTable } from "../src/lib/db/schema";
import { addSfx } from "../src/lib/timeline/sfx";
import { addCta, listCta } from "../src/lib/timeline/cta";
import { splitAt, totalDuration } from "../src/lib/timeline/ops";
import { buildTimelineDoc } from "../src/lib/timeline/state";
import type { TimelineDoc } from "../src/lib/timeline/types";
import {
  applyTemplate,
  saveAsTemplate,
  undoTemplate,
  type ClipEditState,
} from "../src/lib/templates/apply";
import { BUILTIN_TEMPLATE_KEYS, seedBuiltinTemplates } from "../src/lib/templates/builtins";
import { getTemplate, listTemplates } from "../src/lib/templates/db";
import { parseTemplateInput, type Template, type TemplateInput } from "../src/lib/templates/types";
import { createTestDb, type TestDb } from "./helpers/db";

/** Promote a bundle to a full Template (as if it had been persisted). */
function asTemplate(input: TemplateInput, id = 1, builtin = false): Template {
  return { ...input, id, builtin };
}

/** A caption doc with a distinct, non-default style so replacement is visible. */
function captionDoc(): CaptionDoc {
  return {
    cues: [{ start: 0, end: 1, lines: [] }] as unknown as CaptionDoc["cues"],
    style: resolveStyle({ preset: "clean-sub", textColor: "#ABCDEF" }),
    name: "clean-sub",
  };
}

/** A clip edit state blob with a two-segment timeline, an SFX cue, a locked
 * crop, and a caption doc — everything a template must either replace or keep. */
function seedState(): { state: ClipEditState; timeline: TimelineDoc } {
  let tl = buildTimelineDoc(0, 10);
  tl = splitAt(tl, 4); // now two segments — a "trim/segment edit" to preserve
  tl = addSfx(tl, { assetId: 7, t: 2, volume: 0.5, duckMain: true });
  // An existing CTA that the template must remove/replace.
  tl = addCta(tl, { variant: "text", content: "old cta", start: 1, end: 3 });
  const crop = buildCropState(
    "16:9",
    [{ t: 0, x: 10, y: 20, w: 100, h: 56 }],
    1280,
    720,
    true, // locked — a manual override the template must preserve
  );
  const state: ClipEditState = { timeline: tl, crop, captions: captionDoc() };
  return { state, timeline: tl };
}

describe("platform presets", () => {
  it("warns when a clip exceeds the preset max length, not when it fits", () => {
    const shorts = PLATFORM_PRESETS["youtube-shorts"];
    expect(exceedsMaxLength(shorts, 61)).toBe(true);
    expect(exceedsMaxLength(shorts, 59)).toBe(false);
    expect(exceedsMaxLength(shorts, 60)).toBe(false); // exactly on the limit is fine
    expect(maxLengthWarning(shorts, 61)).toBe("YouTube Shorts ≤ 60 s");
    expect(maxLengthWarning(shorts, 59)).toBeNull();
  });

  it("never warns for presets with no length limit", () => {
    expect(exceedsMaxLength(PLATFORM_PRESETS.square, 10_000)).toBe(false);
    expect(maxLengthWarning(PLATFORM_PRESETS.landscape, 10_000)).toBeNull();
  });

  it("formats thresholds the way the SPEC table labels them", () => {
    expect(formatMaxLength(600)).toBe("10 min");
    expect(formatMaxLength(60)).toBe("60 s");
    expect(formatMaxLength(90)).toBe("90 s");
  });

  it("resolves unknown ids to the default preset", () => {
    expect(resolvePlatformPreset("nope").id).toBe("tiktok");
    expect(resolvePlatformPreset("square").id).toBe("square");
  });
});

describe("platform preset selection & persistence", () => {
  it("reads a per-clip override out of a state blob, or null when unset/invalid", () => {
    expect(readClipPreset({ platformPreset: "square" })).toBe("square");
    expect(readClipPreset({ timeline: {} })).toBeNull();
    expect(readClipPreset({ platformPreset: "nope" })).toBeNull();
    expect(readClipPreset(null)).toBeNull();
    expect(readClipPreset("not an object")).toBeNull();
  });

  it("writes/clears only the platformPreset key, preserving the rest of the blob", () => {
    const blob = { timeline: { x: 1 }, crop: { y: 2 } };
    const set = withClipPreset(blob, "instagram-reels");
    expect(set).toEqual({ ...blob, platformPreset: "instagram-reels" });
    // Original untouched (pure).
    expect(blob).not.toHaveProperty("platformPreset");

    const cleared = withClipPreset(set, null);
    expect(cleared).toEqual(blob);
    expect(cleared).not.toHaveProperty("platformPreset");
  });

  it("layers clip override over project default over product default", () => {
    // Clip override wins.
    expect(resolvePresetSelection("square", "youtube-shorts")).toEqual({
      preset: PLATFORM_PRESETS.square,
      source: "clip",
    });
    // No clip override → project default.
    expect(resolvePresetSelection(null, "youtube-shorts")).toEqual({
      preset: PLATFORM_PRESETS["youtube-shorts"],
      source: "project",
    });
    // Neither → product default (tiktok).
    expect(resolvePresetSelection(null, null)).toEqual({
      preset: PLATFORM_PRESETS.tiktok,
      source: "default",
    });
    // Garbage at either level falls through rather than sticking.
    expect(resolvePresetSelection("bogus", "landscape").source).toBe("project");
    expect(resolvePresetSelection("bogus", "bogus").source).toBe("default");
  });
});

describe("built-in template seeding", () => {
  let testDb: TestDb;
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => {
    testDb.close();
  });

  it("seeds exactly 3 built-ins and is idempotent across repeated runs", () => {
    const first = seedBuiltinTemplates(testDb.db);
    expect(first).toBe(3);
    const second = seedBuiltinTemplates(testDb.db); // run twice
    expect(second).toBe(0);

    const rows = testDb.db.select().from(templatesTable).all();
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.builtin)).toBe(true);
    expect(rows.map((r) => r.key).sort()).toEqual([...BUILTIN_TEMPLATE_KEYS].sort());
  });

  it("round-trips a seeded built-in through the db mapper", () => {
    seedBuiltinTemplates(testDb.db);
    const all = listTemplates(testDb.db);
    const tiktok = all.find((t) => t.key === "tiktok-bold");
    expect(tiktok).toBeDefined();
    expect(tiktok!.captionPreset).toBe("bold-pop");
    expect(tiktok!.aspectRatio).toBe("9:16");
    // Its "Follow for more" CTA survives JSON storage.
    expect(tiktok!.ctas.length).toBe(1);
    expect(tiktok!.ctas[0].content).toBe("Follow for more");
    // highlightColor === brandPrimary invariant holds after storage.
    expect(tiktok!.captionStyle.highlightColor).toBe(tiktok!.brandPrimary);
    expect(getTemplate(testDb.db, tiktok!.id)?.name).toBe(tiktok!.name);
  });
});

describe("applyTemplate", () => {
  it("replaces caption style, AR, and CTAs but preserves segments, trims, SFX, and locked crop", () => {
    const { state, timeline } = seedState();
    const before = JSON.parse(JSON.stringify(state)) as ClipEditState;

    const template = asTemplate(
      parseTemplateInput({
        name: "T",
        captionPreset: "bold-pop",
        aspectRatio: "9:16",
        brandPrimary: "#FFE600",
        brandSecondary: "#123456",
        ctas: [
          { variant: "text", content: "Follow for more", start: 0, end: 9999, fontSize: 0.07 },
        ],
      }),
      42,
    );

    const next = applyTemplate(state, template);

    // Input blob is never mutated.
    expect(state).toEqual(before);

    // Caption style replaced (preset + brand highlight); cues preserved.
    const nextCaptions = next.captions as CaptionDoc;
    expect(nextCaptions.name).toBe("bold-pop");
    expect(nextCaptions.style.highlightColor).toBe("#FFE600");
    expect(nextCaptions.cues.length).toBe((before.captions as CaptionDoc).cues.length);

    // Aspect ratio replaced; locked keyframes preserved.
    const nextCrop = next.crop as ReturnType<typeof buildCropState>;
    expect(nextCrop.aspectRatio).toBe("9:16");
    expect(nextCrop.locked).toBe(true);
    expect(nextCrop.keyframes).toEqual([{ t: 0, x: 10, y: 20, w: 100, h: 56 }]);

    // Segments + trims preserved (still two segments, same source ranges).
    const nextTl = next.timeline as TimelineDoc;
    expect(nextTl.segments).toEqual(timeline.segments);
    // SFX preserved.
    expect(nextTl.sfxTrack).toEqual(timeline.sfxTrack);

    // Old CTA gone, template CTA present with the brand background.
    const ctas = listCta(nextTl);
    expect(ctas.length).toBe(1);
    expect(ctas[0].content).toBe("Follow for more");
    expect(ctas[0].style.background).toBe("#123456");
    // CTA end clamped to the clip's real length (was 9999).
    expect(ctas[0].end).toBeLessThanOrEqual(totalDuration(nextTl));

    // Records which template was applied.
    expect(next.templateId).toBe(42);
  });

  it("drops unlocked keyframes when the AR changes so smart-crop re-derives them", () => {
    const { state } = seedState();
    // Make the crop unlocked.
    (state.crop as { locked: boolean }).locked = false;
    const template = asTemplate(parseTemplateInput({ aspectRatio: "9:16" }));
    const next = applyTemplate(state, template);
    const nextCrop = next.crop as { aspectRatio: string; keyframes: unknown[] };
    expect(nextCrop.aspectRatio).toBe("9:16");
    expect(nextCrop.keyframes).toEqual([]);
  });

  it("apply-then-undo restores the exact previous clip_edits JSON", () => {
    const { state } = seedState();
    const beforeJson = JSON.stringify(state);

    const template = asTemplate(
      parseTemplateInput({ name: "T", captionPreset: "boxed", aspectRatio: "1:1" }),
      9,
    );
    const next = applyTemplate(state, template);
    expect(JSON.stringify(next)).not.toBe(beforeJson); // it did change something

    const restored = undoTemplate(next);
    expect(restored).not.toBeNull();
    expect(JSON.stringify(restored)).toBe(beforeJson);
  });

  it("returns null from undoTemplate when there is no snapshot", () => {
    const { state } = seedState();
    expect(undoTemplate(state)).toBeNull();
  });
});

describe("saveAsTemplate round-trip", () => {
  it("captures clip A's caption style so applying to clip B reproduces it exactly", () => {
    // Clip A: a distinctive caption style.
    const aStyle = resolveStyle({
      preset: "bold-pop",
      textColor: "#FF00AA",
      highlightColor: "#00FFAA",
      fontSize: 72,
    });
    const stateA: ClipEditState = {
      timeline: buildTimelineDoc(0, 5),
      crop: buildCropState("1:1", [], 1080, 1080, false),
      captions: { cues: [], style: aStyle, name: "bold-pop" } as CaptionDoc,
    };

    const saved = saveAsTemplate(stateA, "My Look");
    expect(saved.name).toBe("My Look");

    // Clip B: an unrelated style.
    const stateB: ClipEditState = {
      timeline: buildTimelineDoc(0, 8),
      crop: buildCropState("16:9", [], 1920, 1080, false),
      captions: {
        cues: [],
        style: resolveStyle({ preset: "clean-sub" }),
        name: "clean-sub",
      } as CaptionDoc,
    };

    const nextB = applyTemplate(stateB, asTemplate(saved, 5));
    expect((nextB.captions as CaptionDoc).style).toEqual(aStyle);
  });
});
