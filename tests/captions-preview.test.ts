import { describe, expect, it } from "vitest";

import type { CaptionDoc } from "../src/lib/captions/ass";
import type { CaptionCue, CaptionLine, CaptionWord } from "../src/lib/captions/clip";
import {
  NO_ACTIVE_LINE,
  NO_ACTIVE_WORD,
  PRESET_OPTIONS,
  activeCue,
  activeLineIndex,
  activeWordIndex,
  clipRelativeTime,
  displayText,
  editorLines,
  overlayLineStyle,
  overlayWordStyle,
  overlayWrapperStyle,
  rgba,
} from "../src/lib/captions/preview";
import { PRESETS, getPreset } from "../src/lib/captions/style";

function word(text: string, start: number, end: number): CaptionWord {
  return { text, start, end };
}

function line(words: CaptionWord[]): CaptionLine {
  return {
    words,
    text: words.map((w) => w.text).join(" "),
    start: words[0].start,
    end: words[words.length - 1].end,
  };
}

function cue(lines: CaptionLine[]): CaptionCue {
  return { lines, start: lines[0].start, end: lines[lines.length - 1].end };
}

function docWith(cues: CaptionCue[], style = getPreset("bold-pop")): CaptionDoc {
  return { cues, style, name: "bold-pop" };
}

const SAMPLE = docWith([
  cue([line([word("hello", 0, 0.5), word("there", 0.5, 1)])]),
  cue([line([word("second", 1, 1.5), word("cue", 1.5, 2)])]),
]);

describe("editorLines", () => {
  it("flattens cues to lines with a flat index across all cues", () => {
    const lines = editorLines(SAMPLE);
    expect(lines.map((l) => l.index)).toEqual([0, 1]);
    expect(lines.map((l) => l.cue)).toEqual([0, 1]);
    expect(lines[0].line.text).toBe("hello there");
    expect(lines[1].line.text).toBe("second cue");
  });

  it("indexes multiple lines within one cue continuously", () => {
    const two = docWith([
      cue([line([word("a", 0, 1)]), line([word("b", 1, 2)])]),
      cue([line([word("c", 2, 3)])]),
    ]);
    expect(editorLines(two).map((l) => ({ i: l.index, c: l.cue }))).toEqual([
      { i: 0, c: 0 },
      { i: 1, c: 0 },
      { i: 2, c: 1 },
    ]);
  });
});

describe("clipRelativeTime", () => {
  it("subtracts the clip in-point and clamps at zero", () => {
    expect(clipRelativeTime(42, 40)).toBeCloseTo(2);
    expect(clipRelativeTime(39, 40)).toBe(0);
  });
});

describe("activeLineIndex", () => {
  const lines = editorLines(SAMPLE);

  it("finds the line whose window contains the time", () => {
    expect(activeLineIndex(lines, 0.25)).toBe(0);
    expect(activeLineIndex(lines, 1.75)).toBe(1);
  });

  it("returns -1 before the first and after the last line", () => {
    expect(activeLineIndex(lines, -1)).toBe(NO_ACTIVE_LINE);
    expect(activeLineIndex(lines, 5)).toBe(NO_ACTIVE_LINE);
  });

  it("advances to the later line at a shared boundary", () => {
    // line 0 ends at 1.0, line 1 starts at 1.0 — the boundary belongs to line 1.
    expect(activeLineIndex(lines, 1)).toBe(1);
  });
});

describe("activeWordIndex", () => {
  const l = line([word("hello", 0, 0.5), word("there", 0.5, 1)]);

  it("finds the spoken word", () => {
    expect(activeWordIndex(l, 0.1)).toBe(0);
    expect(activeWordIndex(l, 0.7)).toBe(1);
  });

  it("returns -1 outside every word", () => {
    expect(activeWordIndex(l, 2)).toBe(NO_ACTIVE_WORD);
  });
});

describe("activeCue", () => {
  it("returns the on-screen cue, or null in a gap", () => {
    expect(activeCue(SAMPLE, 0.3)?.lines[0].text).toBe("hello there");
    expect(activeCue(SAMPLE, 1.3)?.lines[0].text).toBe("second cue");
    expect(activeCue(SAMPLE, 9)).toBeNull();
  });
});

describe("displayText", () => {
  it("uppercases only when the style says so", () => {
    expect(displayText("hi there", { ...getPreset("bold-pop"), uppercase: true })).toBe("HI THERE");
    expect(displayText("hi there", { ...getPreset("bold-pop"), uppercase: false })).toBe("hi there");
  });
});

describe("PRESET_OPTIONS", () => {
  it("lists every preset with a label", () => {
    expect(PRESET_OPTIONS.map((o) => o.value)).toEqual(Object.keys(PRESETS));
    expect(PRESET_OPTIONS.every((o) => o.label.length > 0)).toBe(true);
  });
});

describe("rgba", () => {
  it("converts #RRGGBB + opacity to rgba()", () => {
    expect(rgba("#000000", 0.75)).toBe("rgba(0, 0, 0, 0.75)");
    expect(rgba("#FFE600", 1)).toBe("rgba(255, 230, 0, 1)");
  });

  it("clamps opacity into [0,1]", () => {
    expect(rgba("#ffffff", 2)).toBe("rgba(255, 255, 255, 1)");
    expect(rgba("#ffffff", -1)).toBe("rgba(255, 255, 255, 0)");
  });
});

describe("overlay styles", () => {
  it("maps position to vertical flex alignment", () => {
    expect(overlayWrapperStyle({ ...getPreset("bold-pop"), position: "top" }).justifyContent).toBe(
      "flex-start",
    );
    expect(overlayWrapperStyle({ ...getPreset("bold-pop"), position: "middle" }).justifyContent).toBe(
      "center",
    );
    expect(overlayWrapperStyle({ ...getPreset("bold-pop"), position: "bottom" }).justifyContent).toBe(
      "flex-end",
    );
  });

  it("scales font size by the player scale factor", () => {
    const style = { ...getPreset("bold-pop"), fontSize: 64 };
    expect(overlayLineStyle(style, 1).fontSize).toBe("64px");
    expect(overlayLineStyle(style, 0.5).fontSize).toBe("32px");
  });

  it("draws the box background only for box presets", () => {
    expect(overlayLineStyle(getPreset("boxed")).backgroundColor).toBe("rgba(0, 0, 0, 0.75)");
    expect(overlayLineStyle(getPreset("minimal-caps")).backgroundColor).toBeUndefined();
  });

  it("highlights the active word only when karaoke is on", () => {
    const on = getPreset("bold-pop"); // karaoke true
    expect(overlayWordStyle(on, true).color).toBe(on.highlightColor);
    expect(overlayWordStyle(on, false).color).toBe(on.textColor);
    const off = getPreset("clean-sub"); // karaoke false
    expect(overlayWordStyle(off, true).color).toBe(off.textColor);
  });

  it("adds a text stroke only when strokeWidth > 0", () => {
    expect(overlayWordStyle(getPreset("bold-pop"), false).WebkitTextStroke).toBe("6px #000000");
    expect(overlayWordStyle(getPreset("minimal-caps"), false).WebkitTextStroke).toBeUndefined();
  });
});
