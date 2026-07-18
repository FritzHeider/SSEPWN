import { describe, expect, it } from "vitest";

import {
  canRedo,
  canUndo,
  createHistory,
  DEFAULT_HISTORY_LIMIT,
  MIN_HISTORY_LIMIT,
  pushHistory,
  redoHistory,
  undoHistory,
} from "../src/lib/timeline/history";
import { deleteSegment, splitAt, totalDuration } from "../src/lib/timeline/ops";
import { buildTimelineDoc } from "../src/lib/timeline/state";

const baseDoc = () => buildTimelineDoc(0, 10);

describe("createHistory", () => {
  it("starts at the given present with empty undo/redo stacks", () => {
    const doc = baseDoc();
    const h = createHistory(doc);
    expect(h.present).toBe(doc);
    expect(h.past).toEqual([]);
    expect(h.future).toEqual([]);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it("defaults to a limit that satisfies the ≥50 minimum", () => {
    expect(createHistory(baseDoc()).limit).toBe(DEFAULT_HISTORY_LIMIT);
    expect(DEFAULT_HISTORY_LIMIT).toBeGreaterThanOrEqual(MIN_HISTORY_LIMIT);
  });

  it("clamps a too-small requested limit up to the minimum", () => {
    expect(createHistory(baseDoc(), 5).limit).toBe(MIN_HISTORY_LIMIT);
    expect(createHistory(baseDoc(), 0).limit).toBe(MIN_HISTORY_LIMIT);
    expect(createHistory(baseDoc(), 200).limit).toBe(200);
  });
});

describe("pushHistory", () => {
  it("records the new doc as present and the old one on the undo stack", () => {
    const a = baseDoc();
    const b = splitAt(a, 4);
    const h = pushHistory(createHistory(a), b);
    expect(h.present).toBe(b);
    expect(h.past).toEqual([a]);
    expect(canUndo(h)).toBe(true);
    expect(canRedo(h)).toBe(false);
  });

  it("does not mutate the input history", () => {
    const a = baseDoc();
    const h0 = createHistory(a);
    pushHistory(h0, splitAt(a, 4));
    expect(h0.past).toEqual([]);
    expect(h0.present).toBe(a);
  });

  it("is a no-op when pushing the same doc reference", () => {
    const a = baseDoc();
    const h0 = createHistory(a);
    expect(pushHistory(h0, a)).toBe(h0);
  });

  it("clears the redo branch when a new edit is pushed", () => {
    const a = baseDoc();
    const b = splitAt(a, 4);
    const c = splitAt(a, 7);
    const undone = undoHistory(pushHistory(createHistory(a), b));
    expect(canRedo(undone)).toBe(true);
    const branched = pushHistory(undone, c);
    expect(branched.present).toBe(c);
    expect(branched.future).toEqual([]);
    expect(canRedo(branched)).toBe(false);
  });
});

describe("undo/redo round-trips", () => {
  it("undo restores the previous doc, redo restores the undone doc (by reference)", () => {
    const a = baseDoc();
    const b = splitAt(a, 4);
    const pushed = pushHistory(createHistory(a), b);

    const undone = undoHistory(pushed);
    expect(undone.present).toBe(a);
    expect(canRedo(undone)).toBe(true);
    expect(canUndo(undone)).toBe(false);

    const redone = redoHistory(undone);
    expect(redone.present).toBe(b);
    expect(redone.past).toEqual([a]);
    expect(canRedo(redone)).toBe(false);
  });

  it("round-trips a multi-edit sequence back to the origin and forward again", () => {
    const a = baseDoc();
    const b = splitAt(a, 3);
    const c = splitAt(b, 6);
    let h = pushHistory(pushHistory(createHistory(a), b), c);
    expect(h.present).toBe(c);

    h = undoHistory(h);
    expect(h.present).toBe(b);
    h = undoHistory(h);
    expect(h.present).toBe(a);
    expect(canUndo(h)).toBe(false);

    h = redoHistory(h);
    expect(h.present).toBe(b);
    h = redoHistory(h);
    expect(h.present).toBe(c);
    expect(canRedo(h)).toBe(false);
  });

  it("undo on an empty past and redo on an empty future are no-ops", () => {
    const h = createHistory(baseDoc());
    expect(undoHistory(h)).toBe(h);
    expect(redoHistory(h)).toBe(h);
  });
});

describe("history depth limit", () => {
  it("caps the undo stack at the limit, dropping the oldest edits", () => {
    const limit = MIN_HISTORY_LIMIT;
    let h = createHistory(baseDoc(), limit);
    // Apply far more edits than the limit; each split is at a distinct fresh
    // point (0.1s apart, well over MIN_SEGMENT_DURATION) so every push is a
    // real new edit that grows the undo stack.
    const total = limit + 20;
    for (let i = 0; i < total; i++) {
      h = pushHistory(h, splitAt(h.present, (i + 1) * 0.1));
    }
    expect(h.past.length).toBe(limit);

    // Undo as far as possible: exactly `limit` steps, never more.
    let steps = 0;
    while (canUndo(h)) {
      h = undoHistory(h);
      steps++;
      expect(steps).toBeLessThanOrEqual(limit);
    }
    expect(steps).toBe(limit);
  });
});

describe("integration with real ops", () => {
  it("preserves doc validity and duration through undo/redo", () => {
    const a = buildTimelineDoc(2, 12); // 10s window
    const split = splitAt(a, 5);
    const deleted = deleteSegment(split, split.segments[0].id);

    let h = pushHistory(pushHistory(createHistory(a), split), deleted);
    expect(totalDuration(h.present)).toBeCloseTo(totalDuration(deleted), 9);

    h = undoHistory(h); // back to split
    expect(totalDuration(h.present)).toBeCloseTo(totalDuration(split), 9);
    expect(h.present.segments.length).toBe(2);

    h = undoHistory(h); // back to original single segment
    expect(h.present.segments.length).toBe(1);
    expect(totalDuration(h.present)).toBeCloseTo(10, 9);

    h = redoHistory(h); // forward to split again
    expect(h.present).toBe(split);
  });
});
