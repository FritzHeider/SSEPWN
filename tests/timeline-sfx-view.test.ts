import { describe, expect, it } from "vitest";

import { addSfx } from "../src/lib/timeline/sfx";
import { sfxAssetUrl, sfxSchedule } from "../src/lib/timeline/sfx-view";
import { buildTimelineDoc } from "../src/lib/timeline/state";
import type { TimelineDoc } from "../src/lib/timeline/types";

/** A 20s timeline with three cues: #3 @2s (0.5), #5 @8s (unity, ducking),
 * #7 @14s (default volume). */
function docWithThreeSfx(): TimelineDoc {
  let d = buildTimelineDoc(0, 20);
  d = addSfx(d, { assetId: 3, t: 2, volume: 0.5 });
  d = addSfx(d, { assetId: 5, t: 8, volume: 1, duckMain: true });
  d = addSfx(d, { assetId: 7, t: 14 });
  return d;
}

describe("sfxAssetUrl", () => {
  it("points at the shared asset file-serving route", () => {
    expect(sfxAssetUrl(11)).toBe("/api/assets/11/file");
  });
});

describe("sfxSchedule", () => {
  const d = docWithThreeSfx();

  it("resolves every cue to a play-relative offset when starting from 0", () => {
    expect(sfxSchedule(d, 0)).toEqual([
      { id: "sfx-2", assetId: 3, offset: 2, gain: 0.5, duckMain: false },
      { id: "sfx-3", assetId: 5, offset: 8, gain: 1, duckMain: true },
      { id: "sfx-4", assetId: 7, offset: 14, gain: 1, duckMain: false },
    ]);
  });

  it("is ordered by offset (fire order)", () => {
    expect(sfxSchedule(d, 0).map((c) => c.offset)).toEqual([2, 8, 14]);
  });

  it("drops cues whose time has already passed and re-bases the rest", () => {
    // Start at 8s: the 2s cue is gone; the 8s cue fires immediately.
    expect(sfxSchedule(d, 8)).toEqual([
      { id: "sfx-3", assetId: 5, offset: 0, gain: 1, duckMain: true },
      { id: "sfx-4", assetId: 7, offset: 6, gain: 1, duckMain: false },
    ]);
  });

  it("returns nothing once the playhead is past every cue", () => {
    expect(sfxSchedule(d, 15)).toEqual([]);
  });

  it("carries a cue's default volume through as unity gain", () => {
    expect(sfxSchedule(d, 14)).toEqual([
      { id: "sfx-4", assetId: 7, offset: 0, gain: 1, duckMain: false },
    ]);
  });
});
