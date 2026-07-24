import { describe, expect, it } from "vitest";

import { formatBytes, formatRate, transferredLabel, uploadPercent } from "../src/lib/projects/format";

describe("formatBytes", () => {
  it("keeps bytes whole", () => {
    expect(formatBytes(820)).toBe("820 B");
  });

  it("shows one decimal from KB up", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1_300_000)).toBe("1.2 MB");
    expect(formatBytes(2 * 1024 ** 3)).toBe("2.0 GB");
  });

  it("never renders NaN or a negative size", () => {
    expect(formatBytes(NaN)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(0)).toBe("0 B");
  });
});

describe("formatRate", () => {
  it("suffixes a byte rate with /s", () => {
    expect(formatRate(3.4 * 1024 ** 2)).toBe("3.4 MB/s");
  });

  it("is empty before a rate exists", () => {
    expect(formatRate(0)).toBe("");
    expect(formatRate(NaN)).toBe("");
  });
});

describe("uploadPercent", () => {
  it("rounds loaded/total to a whole percent", () => {
    expect(uploadPercent(50, 200)).toBe(25);
    expect(uploadPercent(1, 3)).toBe(33);
  });

  it("clamps and guards divide-by-zero", () => {
    expect(uploadPercent(10, 0)).toBe(0);
    expect(uploadPercent(300, 200)).toBe(100);
    expect(uploadPercent(NaN, 100)).toBe(0);
  });
});

describe("transferredLabel", () => {
  it("reads transferred / total", () => {
    expect(transferredLabel(1_300_000, 3_400_000)).toBe("1.2 MB / 3.2 MB");
  });
});
