import { describe, expect, it } from "vitest";

import {
  addBroll,
  BROLL_MODES,
  clampBrollRange,
  clampPip,
  DEFAULT_PIP,
  isBrollSlot,
  listBroll,
  MAX_PIP_SCALE,
  MIN_BROLL_DURATION,
  MIN_PIP_SCALE,
  removeBroll,
  updateBroll,
  type BrollSlot,
} from "../src/lib/timeline/broll";
import { splitAt } from "../src/lib/timeline/ops";
import { buildTimelineDoc, readTimelineDoc, withTimelineDoc } from "../src/lib/timeline/state";
import { TimelineError, type TimelineDoc } from "../src/lib/timeline/types";

/** A clip from 0s to 20s → a 20s timeline. */
function doc(): TimelineDoc {
  return buildTimelineDoc(0, 20);
}

describe("clampPip", () => {
  it("keeps an in-frame box unchanged", () => {
    expect(clampPip({ x: 0.1, y: 0.2, scale: 0.3 })).toEqual({ x: 0.1, y: 0.2, scale: 0.3 });
  });

  it("clamps a box that overflows the right/bottom edge back inside the frame", () => {
    const p = clampPip({ x: 0.9, y: 0.95, scale: 0.4 });
    expect(p.scale).toBe(0.4);
    expect(p.x).toBeCloseTo(0.6, 10); // 1 - scale
    expect(p.y).toBeCloseTo(0.6, 10);
    expect(p.x + p.scale).toBeLessThanOrEqual(1 + 1e-9);
    expect(p.y + p.scale).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("clamps scale into [MIN_PIP_SCALE, MAX_PIP_SCALE] and rejects negatives", () => {
    expect(clampPip({ x: 0.5, y: 0.5, scale: 2 }).scale).toBe(MAX_PIP_SCALE);
    expect(clampPip({ x: 0.5, y: 0.5, scale: 0.001 }).scale).toBe(MIN_PIP_SCALE);
    const neg = clampPip({ x: -0.5, y: -0.3, scale: 0.3 });
    expect(neg.x).toBe(0);
    expect(neg.y).toBe(0);
  });

  it("falls back to defaults on non-finite / missing fields", () => {
    expect(clampPip(undefined)).toEqual(DEFAULT_PIP);
    expect(clampPip({ x: Number.NaN, y: Infinity, scale: 0.25 })).toEqual({
      x: DEFAULT_PIP.x,
      y: DEFAULT_PIP.y,
      scale: 0.25,
    });
  });
});

describe("clampBrollRange", () => {
  it("clamps a range that runs past the timeline end", () => {
    expect(clampBrollRange(doc(), 5, 999)).toEqual({ start: 5, end: 20 });
  });

  it("clamps a negative start to 0", () => {
    expect(clampBrollRange(doc(), -3, 4)).toEqual({ start: 0, end: 4 });
  });

  it("enforces the minimum duration when end <= start", () => {
    const r = clampBrollRange(doc(), 10, 10);
    expect(r.start).toBe(10);
    expect(r.end).toBeCloseTo(10 + MIN_BROLL_DURATION, 10);
  });

  it("throws on non-finite bounds", () => {
    expect(() => clampBrollRange(doc(), Number.NaN, 5)).toThrow(TimelineError);
  });
});

describe("addBroll", () => {
  it("appends a clamped, deterministically-id'd pip slot", () => {
    const d = addBroll(doc(), { assetId: 7, start: 2, end: 6 });
    const slots = listBroll(d);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toEqual<BrollSlot>({
      id: "ov-2", // seq started at 1 (one segment) → next is 2
      kind: "broll",
      assetId: 7,
      start: 2,
      end: 6,
      mode: "pip",
      pip: DEFAULT_PIP,
    });
    expect(d.seq).toBe(2);
  });

  it("defaults end to a minimum-length slot and mode to pip", () => {
    const d = addBroll(doc(), { assetId: 1, start: 3 });
    const slot = listBroll(d)[0];
    expect(slot.end).toBeCloseTo(3 + MIN_BROLL_DURATION, 10);
    expect(BROLL_MODES).toContain(slot.mode);
  });

  it("clamps an inserted range and pip geometry to legal values", () => {
    const d = addBroll(doc(), {
      assetId: 2,
      start: -5,
      end: 999,
      mode: "full",
      pip: { x: 0.95, y: 0.95, scale: 0.5 },
    });
    const slot = listBroll(d)[0];
    expect(slot.start).toBe(0);
    expect(slot.end).toBe(20);
    expect(slot.mode).toBe("full");
    expect(slot.pip.x + slot.pip.scale).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("is deterministic and pure (same doc+args → deep-equal result, input untouched)", () => {
    const base = doc();
    const a = addBroll(base, { assetId: 9, start: 1, end: 5 });
    const b = addBroll(base, { assetId: 9, start: 1, end: 5 });
    expect(a).toEqual(b);
    expect(base.overlayTrack).toHaveLength(0); // original not mutated
  });

  it("rejects a non-positive assetId", () => {
    expect(() => addBroll(doc(), { assetId: 0, start: 1 })).toThrow(TimelineError);
    expect(() => addBroll(doc(), { assetId: -4, start: 1 })).toThrow(TimelineError);
  });

  it("does not collide ids with a later segment split", () => {
    const withBroll = addBroll(doc(), { assetId: 1, start: 1, end: 3 }); // seq 2, ov-2
    const afterSplit = splitAt(withBroll, 10); // seq 3, seg-3
    const ids = [
      ...afterSplit.segments.map((s) => s.id),
      ...afterSplit.overlayTrack.map((o) => o.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("updateBroll", () => {
  it("moves and resizes a slot, re-clamping to the timeline", () => {
    const d = addBroll(doc(), { assetId: 1, start: 2, end: 6 });
    const moved = updateBroll(d, "ov-2", { start: 15, end: 100 });
    const slot = listBroll(moved)[0];
    expect(slot.start).toBe(15);
    expect(slot.end).toBe(20);
  });

  it("switches mode while preserving pip geometry", () => {
    const d = addBroll(doc(), { assetId: 1, start: 2, end: 6, pip: { x: 0.1, y: 0.1, scale: 0.4 } });
    const full = updateBroll(d, "ov-2", { mode: "full" });
    expect(listBroll(full)[0].mode).toBe("full");
    expect(listBroll(full)[0].pip).toEqual({ x: 0.1, y: 0.1, scale: 0.4 });
  });

  it("merges a partial pip patch and re-clamps it into frame", () => {
    const d = addBroll(doc(), { assetId: 1, start: 2, end: 6, pip: { x: 0.2, y: 0.2, scale: 0.3 } });
    const nudged = updateBroll(d, "ov-2", { pip: { x: 0.95 } });
    const pip = listBroll(nudged)[0].pip;
    expect(pip.scale).toBe(0.3); // unchanged
    expect(pip.x).toBeCloseTo(0.7, 10); // 1 - scale
    expect(pip.y).toBe(0.2); // unchanged
  });

  it("throws on an unknown id", () => {
    expect(() => updateBroll(doc(), "ov-99", { start: 1 })).toThrow(TimelineError);
  });

  it("rejects a non-positive assetId patch", () => {
    const d = addBroll(doc(), { assetId: 1, start: 2, end: 6 });
    expect(() => updateBroll(d, "ov-2", { assetId: 0 })).toThrow(TimelineError);
  });
});

describe("removeBroll", () => {
  it("removes the named slot and leaves others", () => {
    let d = addBroll(doc(), { assetId: 1, start: 1, end: 3 }); // ov-2
    d = addBroll(d, { assetId: 2, start: 5, end: 8 }); // ov-3
    const after = removeBroll(d, "ov-2");
    const slots = listBroll(after);
    expect(slots).toHaveLength(1);
    expect(slots[0].id).toBe("ov-3");
  });

  it("throws on an unknown id", () => {
    expect(() => removeBroll(doc(), "ov-99")).toThrow(TimelineError);
  });
});

describe("overlay round-trip", () => {
  it("preserves B-roll slots (and unknown overlays) through persist + reload", () => {
    let d = addBroll(doc(), { assetId: 4, start: 3, end: 9, mode: "full" });
    // A non-B-roll overlay blob (e.g. a future CTA) must survive untouched.
    d = { ...d, overlayTrack: [...d.overlayTrack, { id: "cta-1", kind: "cta", text: "hi" }] };
    const state = withTimelineDoc({}, d);
    const reloaded = readTimelineDoc(JSON.parse(JSON.stringify(state)));
    expect(reloaded).not.toBeNull();
    expect(listBroll(reloaded!)).toEqual(listBroll(d));
    expect(reloaded!.overlayTrack.find((o) => o.id === "cta-1")).toEqual({
      id: "cta-1",
      kind: "cta",
      text: "hi",
    });
  });

  it("isBrollSlot rejects malformed / foreign overlays", () => {
    expect(isBrollSlot({ id: "x", kind: "cta" })).toBe(false);
    expect(isBrollSlot({ id: "x", kind: "broll", assetId: 1, start: 0, end: 1, mode: "pip" })).toBe(
      false, // missing pip
    );
    expect(isBrollSlot(null)).toBe(false);
  });
});
