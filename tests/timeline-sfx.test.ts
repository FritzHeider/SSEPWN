import { describe, expect, it } from "vitest";

import { splitAt } from "../src/lib/timeline/ops";
import {
  addSfx,
  clampSfxTime,
  clampSfxVolume,
  DEFAULT_SFX_VOLUME,
  isSfxCue,
  listSfx,
  removeSfx,
  SFX_MAX_VOLUME,
  updateSfx,
} from "../src/lib/timeline/sfx";
import { buildTimelineDoc, readTimelineDoc, withTimelineDoc } from "../src/lib/timeline/state";
import { TimelineError, type TimelineDoc } from "../src/lib/timeline/types";

/** A clip from 0s to 20s → a 20s timeline. */
function doc(): TimelineDoc {
  return buildTimelineDoc(0, 20);
}

describe("isSfxCue", () => {
  it("accepts a well-formed cue and rejects malformed shapes", () => {
    expect(isSfxCue({ id: "sfx-1", assetId: 3, t: 2, volume: 1, duckMain: false })).toBe(true);
    expect(isSfxCue({ id: "sfx-1", assetId: 3, t: 2, volume: 1 })).toBe(false); // no duckMain
    expect(isSfxCue({ id: "sfx-1", assetId: "3", t: 2, volume: 1, duckMain: true })).toBe(false);
    expect(isSfxCue({ assetId: 3, t: 2, volume: 1, duckMain: true })).toBe(false); // no id
    expect(isSfxCue(null)).toBe(false);
    expect(isSfxCue("nope")).toBe(false);
  });
});

describe("clampSfxTime", () => {
  it("clamps into the timeline [0, total]", () => {
    const d = doc();
    expect(clampSfxTime(d, 5)).toBe(5);
    expect(clampSfxTime(d, -3)).toBe(0);
    expect(clampSfxTime(d, 999)).toBe(20);
  });

  it("throws on a non-finite time", () => {
    expect(() => clampSfxTime(doc(), Number.NaN)).toThrow(TimelineError);
    expect(() => clampSfxTime(doc(), Infinity)).toThrow(TimelineError);
  });
});

describe("clampSfxVolume", () => {
  it("clamps into [0, SFX_MAX_VOLUME] and defaults on non-finite", () => {
    expect(clampSfxVolume(0.5)).toBe(0.5);
    expect(clampSfxVolume(-1)).toBe(0);
    expect(clampSfxVolume(99)).toBe(SFX_MAX_VOLUME);
    expect(clampSfxVolume(undefined)).toBe(DEFAULT_SFX_VOLUME);
    expect(clampSfxVolume(Number.NaN)).toBe(DEFAULT_SFX_VOLUME);
  });
});

describe("addSfx", () => {
  it("places a cue with a deterministic id, clamped time and default volume", () => {
    const d = addSfx(doc(), { assetId: 7, t: 3 });
    const cues = listSfx(d);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toEqual({ id: "sfx-2", assetId: 7, t: 3, volume: 1, duckMain: false });
  });

  it("clamps an out-of-range time and volume, records duckMain", () => {
    const d = addSfx(doc(), { assetId: 7, t: 100, volume: 5, duckMain: true });
    expect(listSfx(d)[0]).toEqual({ id: "sfx-2", assetId: 7, t: 20, volume: SFX_MAX_VOLUME, duckMain: true });
  });

  it("is pure and deterministic (same doc → same result, input untouched)", () => {
    const base = doc();
    const a = addSfx(base, { assetId: 7, t: 3 });
    const b = addSfx(base, { assetId: 7, t: 3 });
    expect(a).toEqual(b);
    expect(base.sfxTrack).toEqual([]);
  });

  it("hands out ids that never collide with segment ids", () => {
    let d = splitAt(doc(), 10); // bumps seq, makes seg-2
    d = addSfx(d, { assetId: 7, t: 5 });
    const ids = [...d.segments.map((s) => s.id), ...d.sfxTrack.map((c) => c.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(d.sfxTrack[0].id.startsWith("sfx-")).toBe(true);
  });

  it("rejects a non-positive or non-finite assetId", () => {
    expect(() => addSfx(doc(), { assetId: 0, t: 1 })).toThrow(TimelineError);
    expect(() => addSfx(doc(), { assetId: -2, t: 1 })).toThrow(TimelineError);
    expect(() => addSfx(doc(), { assetId: Number.NaN, t: 1 })).toThrow(TimelineError);
  });

  it("throws on a non-finite time", () => {
    expect(() => addSfx(doc(), { assetId: 7, t: Number.NaN })).toThrow(TimelineError);
  });
});

describe("updateSfx", () => {
  it("nudges time, sets volume and toggles duck in place", () => {
    let d = addSfx(doc(), { assetId: 7, t: 3 });
    d = updateSfx(d, "sfx-2", { t: 8, volume: 0.25, duckMain: true });
    expect(listSfx(d)[0]).toEqual({ id: "sfx-2", assetId: 7, t: 8, volume: 0.25, duckMain: true });
  });

  it("re-clamps a nudged time and volume", () => {
    let d = addSfx(doc(), { assetId: 7, t: 3 });
    d = updateSfx(d, "sfx-2", { t: -5, volume: 99 });
    expect(listSfx(d)[0].t).toBe(0);
    expect(listSfx(d)[0].volume).toBe(SFX_MAX_VOLUME);
  });

  it("repoints the asset and leaves untouched fields alone", () => {
    let d = addSfx(doc(), { assetId: 7, t: 3, volume: 0.5, duckMain: true });
    d = updateSfx(d, "sfx-2", { assetId: 9 });
    expect(listSfx(d)[0]).toEqual({ id: "sfx-2", assetId: 9, t: 3, volume: 0.5, duckMain: true });
  });

  it("throws on an unknown id or a bad assetId patch", () => {
    const d = addSfx(doc(), { assetId: 7, t: 3 });
    expect(() => updateSfx(d, "sfx-99", { t: 1 })).toThrow(TimelineError);
    expect(() => updateSfx(d, "sfx-2", { assetId: 0 })).toThrow(TimelineError);
  });
});

describe("removeSfx", () => {
  it("removes a cue by id", () => {
    let d = addSfx(doc(), { assetId: 7, t: 3 });
    d = addSfx(d, { assetId: 8, t: 6 });
    d = removeSfx(d, "sfx-2");
    expect(listSfx(d).map((c) => c.id)).toEqual(["sfx-3"]);
  });

  it("throws on an unknown id", () => {
    expect(() => removeSfx(doc(), "sfx-99")).toThrow(TimelineError);
  });
});

describe("listSfx", () => {
  it("returns cues sorted by time then id", () => {
    let d = addSfx(doc(), { assetId: 7, t: 9 }); // sfx-2
    d = addSfx(d, { assetId: 8, t: 2 }); // sfx-3
    d = addSfx(d, { assetId: 9, t: 9 }); // sfx-4 (ties with sfx-2 → id order)
    expect(listSfx(d).map((c) => c.id)).toEqual(["sfx-3", "sfx-2", "sfx-4"]);
  });
});

describe("SFX round-trip through the state blob", () => {
  it("persists cues and preserves a foreign track", () => {
    let d = addSfx(doc(), { assetId: 7, t: 3, volume: 0.5, duckMain: true });
    d = addSfx(d, { assetId: 8, t: 6 });
    const blob = withTimelineDoc({ captions: { words: [1] } }, d);
    const read = readTimelineDoc(blob);
    expect(read?.sfxTrack).toEqual([
      { id: "sfx-2", assetId: 7, t: 3, volume: 0.5, duckMain: true },
      { id: "sfx-3", assetId: 8, t: 6, volume: 1, duckMain: false },
    ]);
    expect((blob as { captions: unknown }).captions).toEqual({ words: [1] });
  });

  it("drops malformed cues and clamps volume on read", () => {
    const blob = {
      timeline: {
        version: 1,
        bounds: { in: 0, out: 20 },
        segments: [{ id: "seg-1", sourceIn: 0, sourceOut: 20 }],
        sfxTrack: [
          { id: "sfx-1", assetId: 7, t: 3, volume: 99, duckMain: true }, // volume clamped
          { id: "sfx-2", assetId: 0, t: 3, volume: 1 }, // bad assetId → dropped
          { id: "sfx-3", assetId: 8, t: "nope", volume: 1 }, // bad t → dropped
          { assetId: 9, t: 3, volume: 1 }, // no id → dropped
        ],
      },
    };
    const read = readTimelineDoc(blob);
    expect(read?.sfxTrack).toEqual([{ id: "sfx-1", assetId: 7, t: 3, volume: SFX_MAX_VOLUME, duckMain: true }]);
  });

  it("defaults to an empty track when the blob has none", () => {
    const read = readTimelineDoc(withTimelineDoc({}, buildTimelineDoc(0, 10)));
    expect(read?.sfxTrack).toEqual([]);
  });
});
