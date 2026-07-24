import { describe, expect, it } from "vitest";

import { slugify } from "../src/lib/slug";

describe("slugify", () => {
  it("lowercases and dashes a normal title", () => {
    expect(slugify("My Great Clip")).toBe("my-great-clip");
  });

  it("collapses runs of punctuation and whitespace to a single dash", () => {
    expect(slugify("Hello,   World!! -- yes")).toBe("hello-world-yes");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("  --Trimmed--  ")).toBe("trimmed");
    expect(slugify("!!!edges!!!")).toBe("edges");
  });

  it("folds diacritics to ASCII", () => {
    expect(slugify("Café Déjà Vu")).toBe("cafe-deja-vu");
  });

  it("keeps digits", () => {
    expect(slugify("Top 10 Moments")).toBe("top-10-moments");
  });

  it("returns empty for a title with nothing sluggable, so callers can fall back", () => {
    expect(slugify("")).toBe("");
    expect(slugify("!!!")).toBe("");
    expect(slugify("   ")).toBe("");
  });

  it("caps the length and never leaves a trailing dash after the cut", () => {
    const long = "word ".repeat(40).trim(); // 40 words
    const out = slugify(long, 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith("-")).toBe(false);
  });
});
