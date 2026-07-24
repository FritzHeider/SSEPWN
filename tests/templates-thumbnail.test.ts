import { describe, expect, it } from "vitest";

import { resolveStyle } from "../src/lib/captions/style";
import {
  THUMB_SAMPLE_WORDS,
  thumbHighlightIndex,
  thumbWords,
  thumbnailScale,
} from "../src/lib/templates/thumbnail";

describe("thumbnailScale", () => {
  it("is rendered height over reference height", () => {
    expect(thumbnailScale(108)).toBeCloseTo(0.1, 6);
    expect(thumbnailScale(540)).toBeCloseTo(0.5, 6);
  });

  it("is zero for a non-positive tile height", () => {
    expect(thumbnailScale(0)).toBe(0);
    expect(thumbnailScale(-10)).toBe(0);
  });
});

describe("thumbHighlightIndex", () => {
  it("picks the middle word", () => {
    expect(thumbHighlightIndex(3)).toBe(1);
    expect(thumbHighlightIndex(5)).toBe(2);
    expect(thumbHighlightIndex(1)).toBe(0);
  });

  it("is -1 for an empty list", () => {
    expect(thumbHighlightIndex(0)).toBe(-1);
  });
});

describe("thumbWords", () => {
  it("highlights the middle word with the style highlight colour", () => {
    const style = resolveStyle({ preset: "bold-pop" }); // highlight #FFE600, uppercase
    const words = thumbWords(style, 0.1);
    expect(words).toHaveLength(THUMB_SAMPLE_WORDS.length);
    // Middle word takes the highlight colour; the others take the base text colour.
    expect(words[1].style.color).toBe(style.highlightColor);
    expect(words[0].style.color).toBe(style.textColor);
    expect(words[2].style.color).toBe(style.textColor);
  });

  it("applies the uppercase toggle to the sample text", () => {
    const upper = thumbWords(resolveStyle({ preset: "bold-pop" }), 0.1);
    expect(upper[0].text).toBe("YOUR");
    const lower = thumbWords(resolveStyle({ preset: "clean-sub" }), 0.1);
    expect(lower[0].text).toBe("Your");
  });

  it("accepts custom words", () => {
    const words = thumbWords(resolveStyle({ preset: "clean-sub" }), 0.1, ["a", "b"]);
    expect(words.map((w) => w.text)).toEqual(["a", "b"]);
  });
});
