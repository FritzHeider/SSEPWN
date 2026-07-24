import { describe, expect, it } from "vitest";

import {
  clampIn,
  clampOut,
  formatTimecode,
  NUDGE_STEP_SEC,
  nudge,
  pxToSeconds,
  secondsToPercent,
} from "../src/lib/projects/seekbar";

describe("pxToSeconds", () => {
  it("maps a pixel offset to a time along the track", () => {
    expect(pxToSeconds(50, 200, 90)).toBeCloseTo(22.5);
    expect(pxToSeconds(0, 200, 90)).toBe(0);
    expect(pxToSeconds(200, 200, 90)).toBe(90);
  });

  it("clamps an overshoot to the ends and guards a zero width", () => {
    expect(pxToSeconds(-10, 200, 90)).toBe(0);
    expect(pxToSeconds(9999, 200, 90)).toBe(90);
    expect(pxToSeconds(50, 0, 90)).toBe(0);
    expect(pxToSeconds(50, 200, 0)).toBe(0);
  });
});

describe("secondsToPercent", () => {
  it("maps a time to a clamped percent of the duration", () => {
    expect(secondsToPercent(45, 90)).toBe(50);
    expect(secondsToPercent(0, 90)).toBe(0);
    expect(secondsToPercent(120, 90)).toBe(100);
    expect(secondsToPercent(10, 0)).toBe(0);
  });
});

describe("nudge", () => {
  it("moves by the step and clamps to the source", () => {
    expect(nudge(10, NUDGE_STEP_SEC, 90)).toBe(10.5);
    expect(nudge(0, -NUDGE_STEP_SEC, 90)).toBe(0);
    expect(nudge(90, NUDGE_STEP_SEC, 90)).toBe(90);
  });
});

describe("clampIn / clampOut", () => {
  it("keeps the in-point a hair before the out-point", () => {
    expect(clampIn(50, 40, 90)).toBeLessThan(40);
    expect(clampIn(20, 40, 90)).toBe(20);
    expect(clampIn(-5, 40, 90)).toBe(0);
  });

  it("keeps the out-point a hair after the in-point and within the source", () => {
    expect(clampOut(10, 20, 90)).toBeGreaterThan(20);
    expect(clampOut(50, 20, 90)).toBe(50);
    expect(clampOut(200, 20, 90)).toBe(90);
  });

  it("treats a null opposite handle as the source bound", () => {
    expect(clampIn(50, null, 90)).toBe(50);
    expect(clampOut(50, null, 90)).toBe(50);
  });
});

describe("formatTimecode", () => {
  it("shows a tenth of a second", () => {
    expect(formatTimecode(12.5)).toBe("0:12.5");
    expect(formatTimecode(65.2)).toBe("1:05.2");
  });

  it("rolls past an hour", () => {
    expect(formatTimecode(3661.4)).toBe("1:01:01.4");
  });

  it("floors a negative or non-finite time to zero", () => {
    expect(formatTimecode(-1)).toBe("0:00.0");
    expect(formatTimecode(NaN)).toBe("0:00.0");
  });
});
