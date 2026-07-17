import { describe, expect, it } from "vitest";

import {
  CAPTION_PRESET_NAMES,
  DEFAULT_CAPTION_PRESET,
  PRESETS,
  getPreset,
  parseStyle,
  resolveStyle,
  type CaptionStyle,
} from "../src/lib/captions/style";

const HEX = /^#[0-9A-Fa-f]{6}$/;
const REQUIRED_KEYS: (keyof CaptionStyle)[] = [
  "fontFamily",
  "fontSize",
  "textColor",
  "highlightColor",
  "strokeColor",
  "strokeWidth",
  "box",
  "boxColor",
  "boxOpacity",
  "position",
  "marginV",
  "uppercase",
  "karaoke",
];

describe("presets", () => {
  it("ships the four required named presets", () => {
    expect(CAPTION_PRESET_NAMES).toEqual([
      "bold-pop",
      "clean-sub",
      "minimal-caps",
      "boxed",
    ]);
  });

  it("every preset is a complete, valid CaptionStyle", () => {
    for (const name of CAPTION_PRESET_NAMES) {
      const s = PRESETS[name];
      for (const key of REQUIRED_KEYS) {
        expect(s[key], `${name}.${key}`).not.toBeUndefined();
      }
      for (const color of [s.textColor, s.highlightColor, s.strokeColor, s.boxColor]) {
        expect(color).toMatch(HEX);
      }
      expect(s.fontSize).toBeGreaterThan(0);
      expect(s.strokeWidth).toBeGreaterThanOrEqual(0);
      expect(s.boxOpacity).toBeGreaterThanOrEqual(0);
      expect(s.boxOpacity).toBeLessThanOrEqual(1);
      expect(["top", "middle", "bottom"]).toContain(s.position);
    }
  });

  it("bold-pop is the default and turns karaoke on", () => {
    expect(DEFAULT_CAPTION_PRESET).toBe("bold-pop");
    expect(PRESETS["bold-pop"].karaoke).toBe(true);
    expect(PRESETS["bold-pop"].uppercase).toBe(true);
  });

  it("boxed enables the background box; clean-sub keeps karaoke off", () => {
    expect(PRESETS.boxed.box).toBe(true);
    expect(PRESETS["clean-sub"].box).toBe(false);
    expect(PRESETS["clean-sub"].karaoke).toBe(false);
  });

  it("getPreset returns a defensive copy (mutation cannot leak)", () => {
    const a = getPreset("bold-pop");
    a.fontSize = 999;
    expect(PRESETS["bold-pop"].fontSize).not.toBe(999);
  });

  it("getPreset falls back to the default for unknown names", () => {
    expect(getPreset("nope")).toEqual(PRESETS[DEFAULT_CAPTION_PRESET]);
    expect(getPreset(undefined)).toEqual(PRESETS[DEFAULT_CAPTION_PRESET]);
  });
});

describe("parseStyle", () => {
  it("keeps well-typed fields and drops unknown keys", () => {
    const clean = parseStyle({
      preset: "boxed",
      fontSize: 50,
      textColor: "#ABCDEF",
      uppercase: true,
      bogus: "x",
    });
    expect(clean).toEqual({
      preset: "boxed",
      fontSize: 50,
      textColor: "#ABCDEF",
      uppercase: true,
    });
  });

  it("drops malformed colors, bad enums and out-of-range numbers", () => {
    const clean = parseStyle({
      preset: "not-a-preset",
      textColor: "red",
      strokeColor: "#GGGGGG",
      fontSize: -10,
      strokeWidth: -1,
      boxOpacity: 2,
      position: "left",
      marginV: -5,
      box: "yes",
    });
    expect(clean).toEqual({});
  });

  it("accepts boundary opacity values 0 and 1", () => {
    expect(parseStyle({ boxOpacity: 0 }).boxOpacity).toBe(0);
    expect(parseStyle({ boxOpacity: 1 }).boxOpacity).toBe(1);
  });

  it("rejects non-object input", () => {
    expect(parseStyle(null)).toEqual({});
    expect(parseStyle("bold-pop")).toEqual({});
    expect(parseStyle(42)).toEqual({});
  });

  it("trims fontFamily and rejects blank", () => {
    expect(parseStyle({ fontFamily: "  Impact  " }).fontFamily).toBe("Impact");
    expect(parseStyle({ fontFamily: "   " }).fontFamily).toBeUndefined();
  });
});

describe("resolveStyle", () => {
  it("with no input returns the default preset, fully populated", () => {
    const s = resolveStyle();
    expect(s).toEqual(PRESETS[DEFAULT_CAPTION_PRESET]);
    for (const key of REQUIRED_KEYS) expect(s[key]).not.toBeUndefined();
  });

  it("uses the named preset as the base", () => {
    expect(resolveStyle({ preset: "clean-sub" })).toEqual(PRESETS["clean-sub"]);
  });

  it("layers overrides over the preset base", () => {
    const s = resolveStyle({ preset: "clean-sub", fontSize: 100, karaoke: true });
    expect(s.fontSize).toBe(100);
    expect(s.karaoke).toBe(true);
    // untouched fields come from the preset
    expect(s.fontFamily).toBe(PRESETS["clean-sub"].fontFamily);
    expect(s.position).toBe(PRESETS["clean-sub"].position);
  });

  it("ignores invalid override fields, keeping the preset value", () => {
    const s = resolveStyle({ preset: "boxed", fontSize: -5, textColor: "nope" });
    expect(s.fontSize).toBe(PRESETS.boxed.fontSize);
    expect(s.textColor).toBe(PRESETS.boxed.textColor);
  });

  it("does not mutate the shared preset object", () => {
    resolveStyle({ preset: "bold-pop", fontSize: 12 });
    expect(PRESETS["bold-pop"].fontSize).not.toBe(12);
  });
});
