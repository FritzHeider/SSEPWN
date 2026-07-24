import { describe, expect, it } from "vitest";

import { waveformSlice } from "../src/lib/timeline/waveform";

describe("waveformSlice", () => {
  it("stretches the clip window to the strip width and offsets to its start", () => {
    // A 60 s project, clip window 10–20 s (10 s long), strip 600 px wide.
    // pxPerSec = 600 / 10 = 60 → full image is 60*60 = 3600 px, offset = -10*60.
    const slice = waveformSlice(10, 20, 60, 600);
    expect(slice.backgroundWidthPx).toBeCloseTo(3600, 6);
    expect(slice.offsetPx).toBeCloseTo(-600, 6);
  });

  it("shows the whole image at zero offset when the clip spans the project", () => {
    const slice = waveformSlice(0, 30, 30, 900);
    expect(slice.backgroundWidthPx).toBeCloseTo(900, 6);
    expect(slice.offsetPx).toBeCloseTo(0, 6);
  });

  it("returns a zero slice for degenerate inputs", () => {
    expect(waveformSlice(0, 0, 60, 600)).toEqual({ backgroundWidthPx: 0, offsetPx: 0 });
    expect(waveformSlice(10, 20, 0, 600)).toEqual({ backgroundWidthPx: 0, offsetPx: 0 });
    expect(waveformSlice(10, 20, 60, 0)).toEqual({ backgroundWidthPx: 0, offsetPx: 0 });
    expect(waveformSlice(-1, 20, 60, 600)).toEqual({ backgroundWidthPx: 0, offsetPx: 0 });
  });
});
