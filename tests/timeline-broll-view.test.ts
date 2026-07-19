import { describe, expect, it } from "vitest";

import { addBroll, type BrollSlot } from "../src/lib/timeline/broll";
import {
  activeBrollAt,
  assetFileUrl,
  brollLocalTime,
  pipBoxPercent,
} from "../src/lib/timeline/broll-view";
import { buildTimelineDoc } from "../src/lib/timeline/state";
import type { TimelineDoc } from "../src/lib/timeline/types";

/** A 20s timeline with two B-roll slots: [2,6) and [6,10). */
function docWithTwoBroll(): TimelineDoc {
  let d = buildTimelineDoc(0, 20);
  d = addBroll(d, { assetId: 7, start: 2, end: 6, mode: "full" });
  d = addBroll(d, { assetId: 9, start: 6, end: 10, mode: "pip" });
  return d;
}

describe("assetFileUrl", () => {
  it("points at the asset file-serving route", () => {
    expect(assetFileUrl(42)).toBe("/api/assets/42/file");
  });
});

describe("activeBrollAt", () => {
  const d = docWithTwoBroll();

  it("returns the slot covering the playhead", () => {
    expect(activeBrollAt(d, 3).map((s) => s.assetId)).toEqual([7]);
    expect(activeBrollAt(d, 8).map((s) => s.assetId)).toEqual([9]);
  });

  it("is empty before, between-none, and after all slots", () => {
    expect(activeBrollAt(d, 0)).toEqual([]);
    expect(activeBrollAt(d, 15)).toEqual([]);
  });

  it("treats the range as half-open so abutting slots never both fire", () => {
    // t === 6 is the end of slot #7 and the start of slot #9 → only #9.
    expect(activeBrollAt(d, 6).map((s) => s.assetId)).toEqual([9]);
    // t === 10 is the (exclusive) end of the last slot → none.
    expect(activeBrollAt(d, 10)).toEqual([]);
  });
});

describe("pipBoxPercent", () => {
  it("maps normalised geometry to percentage box metrics", () => {
    expect(pipBoxPercent({ x: 0.62, y: 0.05, scale: 0.33 })).toEqual({
      left: 62,
      top: 5,
      width: 33,
      height: 33,
    });
  });
});

describe("brollLocalTime", () => {
  const slot = { start: 4 } as Pick<BrollSlot, "start">;

  it("is the offset from the slot start", () => {
    expect(brollLocalTime(slot, 7)).toBe(3);
  });

  it("never goes negative before the slot starts", () => {
    expect(brollLocalTime(slot, 1)).toBe(0);
  });
});
