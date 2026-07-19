import { describe, expect, it } from "vitest";

import { addBroll } from "../src/lib/timeline/broll";
import {
  addCta,
  addCtaPreset,
  clampCtaFontSize,
  clampCtaOffset,
  clampCtaRange,
  clampCtaStyle,
  CTA_PRESETS,
  DEFAULT_CTA_POSITION,
  DEFAULT_CTA_STYLE,
  getCtaPreset,
  isCtaOverlay,
  listCta,
  MAX_CTA_FONT_SIZE,
  MAX_CTA_OFFSET,
  MIN_CTA_DURATION,
  MIN_CTA_FONT_SIZE,
  removeCta,
  updateCta,
  type CtaOverlay,
} from "../src/lib/timeline/cta";
import { splitAt } from "../src/lib/timeline/ops";
import { buildTimelineDoc, readTimelineDoc, withTimelineDoc } from "../src/lib/timeline/state";
import { TimelineError, type TimelineDoc } from "../src/lib/timeline/types";

/** A clip from 0s to 20s → a 20s timeline. */
function doc(): TimelineDoc {
  return buildTimelineDoc(0, 20);
}

function onlyCta(d: TimelineDoc): CtaOverlay {
  const list = listCta(d);
  expect(list).toHaveLength(1);
  return list[0];
}

describe("isCtaOverlay", () => {
  it("accepts a well-formed overlay and rejects malformed / B-roll shapes", () => {
    const good = addCta(doc(), { content: "hi", start: 1, end: 5 });
    expect(isCtaOverlay(onlyCta(good))).toBe(true);
    expect(isCtaOverlay({ id: "ov-1", kind: "broll", assetId: 3, start: 1, end: 5 })).toBe(false);
    expect(isCtaOverlay({ id: "ov-1", kind: "cta", variant: "banner" })).toBe(false);
    expect(isCtaOverlay(null)).toBe(false);
    expect(isCtaOverlay("nope")).toBe(false);
  });
});

describe("clampCtaOffset", () => {
  it("clamps both axes into [-MAX, MAX] and defaults non-finite to 0", () => {
    expect(clampCtaOffset({ x: 0.3, y: -0.2 })).toEqual({ x: 0.3, y: -0.2 });
    expect(clampCtaOffset({ x: 9, y: -9 })).toEqual({ x: MAX_CTA_OFFSET, y: -MAX_CTA_OFFSET });
    expect(clampCtaOffset({ x: Number.NaN, y: Infinity })).toEqual({ x: 0, y: 0 });
    expect(clampCtaOffset(undefined)).toEqual({ x: 0, y: 0 });
  });
});

describe("clampCtaFontSize", () => {
  it("clamps into the font band and defaults non-finite", () => {
    expect(clampCtaFontSize(0.1)).toBe(0.1);
    expect(clampCtaFontSize(0.001)).toBe(MIN_CTA_FONT_SIZE);
    expect(clampCtaFontSize(9)).toBe(MAX_CTA_FONT_SIZE);
    expect(clampCtaFontSize(Number.NaN)).toBe(DEFAULT_CTA_STYLE.fontSize);
  });
});

describe("clampCtaStyle", () => {
  it("merges over the default, clamps font, keeps only non-empty strings", () => {
    expect(clampCtaStyle({ color: "#f00", fontSize: 99 })).toEqual({
      fontFamily: DEFAULT_CTA_STYLE.fontFamily,
      fontSize: MAX_CTA_FONT_SIZE,
      color: "#f00",
      background: DEFAULT_CTA_STYLE.background,
    });
    expect(clampCtaStyle({ color: "   " }).color).toBe(DEFAULT_CTA_STYLE.color);
    expect(clampCtaStyle(undefined)).toEqual(DEFAULT_CTA_STYLE);
  });
});

describe("clampCtaRange", () => {
  it("clamps both edges into [0, total] with a minimum gap", () => {
    const d = doc();
    expect(clampCtaRange(d, 3, 8)).toEqual({ start: 3, end: 8 });
    expect(clampCtaRange(d, -5, 999)).toEqual({ start: 0, end: 20 });
    const tiny = clampCtaRange(d, 19.99, 19.995);
    expect(tiny.end - tiny.start).toBeGreaterThanOrEqual(MIN_CTA_DURATION - 1e-9);
  });

  it("uses the whole span on a timeline shorter than the minimum", () => {
    const d = buildTimelineDoc(0, 0.02);
    expect(clampCtaRange(d, 0, 0.02).end).toBeCloseTo(0.02, 6);
  });

  it("throws on a non-finite edge", () => {
    expect(() => clampCtaRange(doc(), Number.NaN, 5)).toThrow(TimelineError);
  });
});

describe("CTA presets", () => {
  it("ships at least the two required text presets", () => {
    expect(CTA_PRESETS.length).toBeGreaterThanOrEqual(2);
    const contents = CTA_PRESETS.map((p) => p.content);
    expect(contents).toContain("Follow for more");
    expect(contents).toContain("Link in bio");
  });

  it("getCtaPreset finds by id and misses cleanly", () => {
    expect(getCtaPreset("follow-for-more")?.content).toBe("Follow for more");
    expect(getCtaPreset("nope")).toBeUndefined();
  });

  it("addCtaPreset drops a text CTA carrying the preset's style/position", () => {
    const d = addCtaPreset(doc(), "link-in-bio", { start: 2, end: 6 });
    const cta = onlyCta(d);
    expect(cta.variant).toBe("text");
    expect(cta.content).toBe("Link in bio");
    expect(cta.position).toBe("top-center");
    expect(cta.style.background).toBe("#e11d48");
  });

  it("addCtaPreset throws on an unknown preset", () => {
    expect(() => addCtaPreset(doc(), "ghost", { start: 0 })).toThrow(TimelineError);
  });
});

describe("addCta", () => {
  it("adds a text CTA with clamped range and sensible defaults", () => {
    const d = addCta(doc(), { content: "Subscribe", start: -5, end: 999 });
    const cta = onlyCta(d);
    expect(cta.variant).toBe("text");
    expect(cta.content).toBe("Subscribe");
    expect(cta.assetId).toBeNull();
    expect(cta.start).toBe(0);
    expect(cta.end).toBe(20);
    expect(cta.position).toBe(DEFAULT_CTA_POSITION);
    expect(cta.animIn).toBe("none");
  });

  it("adds an image CTA and forces content empty", () => {
    const d = addCta(doc(), { variant: "image", assetId: 7, content: "ignored", start: 1, end: 4 });
    const cta = onlyCta(d);
    expect(cta.variant).toBe("image");
    expect(cta.assetId).toBe(7);
    expect(cta.content).toBe("");
  });

  it("defaults end to a minimum-length slot from start", () => {
    const cta = onlyCta(addCta(doc(), { content: "x", start: 5 }));
    expect(cta.end - cta.start).toBeCloseTo(MIN_CTA_DURATION, 6);
  });

  it("throws on an empty text CTA and an image CTA without an asset", () => {
    expect(() => addCta(doc(), { content: "   ", start: 0 })).toThrow(TimelineError);
    expect(() => addCta(doc(), { variant: "image", start: 0 })).toThrow(TimelineError);
    expect(() => addCta(doc(), { variant: "image", assetId: 0, start: 0 })).toThrow(TimelineError);
  });

  it("is pure and deterministic (same input → deep-equal output, input untouched)", () => {
    const base = doc();
    const snapshot = JSON.parse(JSON.stringify(base));
    const a = addCta(base, { content: "hi", start: 2, end: 6 });
    const b = addCta(base, { content: "hi", start: 2, end: 6 });
    expect(a).toEqual(b);
    expect(base).toEqual(snapshot);
  });

  it("hands out ids that never collide with segment ids from a later split", () => {
    const withCta = addCta(doc(), { content: "hi", start: 1, end: 5 });
    const ctaId = onlyCta(withCta).id;
    const split = splitAt(withCta, 10);
    const segIds = split.segments.map((s) => s.id);
    expect(segIds).not.toContain(ctaId);
  });
});

describe("updateCta", () => {
  it("moves the range in place, preserving identity and order", () => {
    let d = addCta(doc(), { content: "a", start: 1, end: 3 });
    d = addCta(d, { content: "b", start: 5, end: 7 });
    const first = listCta(d)[0];
    const moved = updateCta(d, first.id, { start: 8, end: 12 });
    const list = listCta(moved);
    expect(list.map((c) => c.id)).toEqual(listCta(d).map((c) => c.id));
    expect(list[0]).toMatchObject({ id: first.id, start: 8, end: 12 });
  });

  it("switches a text CTA to an image (requires an asset) and back", () => {
    const d = addCta(doc(), { content: "hi", start: 1, end: 5 });
    const id = onlyCta(d).id;
    const asImage = updateCta(d, id, { variant: "image", assetId: 9 });
    expect(onlyCta(asImage)).toMatchObject({ variant: "image", assetId: 9, content: "" });
    const backToText = updateCta(asImage, id, { variant: "text", content: "again" });
    expect(onlyCta(backToText)).toMatchObject({ variant: "text", assetId: null, content: "again" });
  });

  it("throws switching to image without an asset", () => {
    const d = addCta(doc(), { content: "hi", start: 1, end: 5 });
    expect(() => updateCta(d, onlyCta(d).id, { variant: "image" })).toThrow(TimelineError);
  });

  it("re-clamps offset and merges a partial style patch", () => {
    const d = addCta(doc(), { content: "hi", start: 1, end: 5, style: { color: "#abc" } });
    const id = onlyCta(d).id;
    const updated = updateCta(d, id, { offset: { x: 99 }, style: { fontSize: 99 } });
    const cta = onlyCta(updated);
    expect(cta.offset.x).toBe(MAX_CTA_OFFSET);
    expect(cta.style.color).toBe("#abc"); // merged, not reset
    expect(cta.style.fontSize).toBe(MAX_CTA_FONT_SIZE);
  });

  it("throws on an unknown id or a non-CTA overlay", () => {
    const d = addBroll(doc(), { assetId: 4, start: 1, end: 5 });
    const brollId = d.overlayTrack[0].id;
    expect(() => updateCta(d, "ov-999", { content: "x" })).toThrow(TimelineError);
    expect(() => updateCta(d, brollId, { content: "x" })).toThrow(TimelineError);
  });
});

describe("removeCta", () => {
  it("removes by id and throws on unknown / non-CTA overlay", () => {
    let d = addCta(doc(), { content: "a", start: 1, end: 3 });
    d = addBroll(d, { assetId: 4, start: 5, end: 8 });
    const ctaId = listCta(d)[0].id;
    const brollId = d.overlayTrack.find((o) => o.id !== ctaId)!.id;
    const removed = removeCta(d, ctaId);
    expect(listCta(removed)).toHaveLength(0);
    expect(removed.overlayTrack).toHaveLength(1); // B-roll survives
    expect(() => removeCta(d, "ov-999")).toThrow(TimelineError);
    expect(() => removeCta(d, brollId)).toThrow(TimelineError);
  });
});

describe("listCta", () => {
  it("returns only CTA overlays, leaving B-roll blobs untouched", () => {
    let d = addBroll(doc(), { assetId: 1, start: 0, end: 4 });
    d = addCta(d, { content: "hi", start: 5, end: 9 });
    expect(listCta(d)).toHaveLength(1);
    expect(d.overlayTrack).toHaveLength(2);
  });
});

describe("round-trip through persisted state", () => {
  it("survives withTimelineDoc → readTimelineDoc alongside a B-roll blob", () => {
    let d = addBroll(doc(), { assetId: 2, start: 0, end: 3 });
    d = addCta(d, { variant: "image", assetId: 6, start: 4, end: 9, position: "top-left", animIn: "slide" });
    const blob = withTimelineDoc({}, d);
    const round = readTimelineDoc(JSON.parse(JSON.stringify(blob)));
    expect(round).not.toBeNull();
    const cta = onlyCta(round!);
    expect(cta).toMatchObject({
      variant: "image",
      assetId: 6,
      position: "top-left",
      animIn: "slide",
      start: 4,
      end: 9,
    });
    expect(round!.overlayTrack).toHaveLength(2); // B-roll preserved
  });
});
