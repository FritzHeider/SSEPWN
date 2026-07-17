import { describe, expect, it } from "vitest";

import { clipCaptions, type CaptionCue } from "../src/lib/captions/clip";
import {
  CAPTION_PRESET_NAMES,
  resolveStyle,
  type CaptionStyle,
} from "../src/lib/captions/style";
import {
  alignment,
  assTime,
  centiseconds,
  cueText,
  escapeText,
  hexToAss,
  toAss,
  type CaptionDoc,
} from "../src/lib/captions/ass";
import type { TranscriptSegment } from "../src/lib/transcribe/types";

/**
 * Centisecond-aligned, contiguous words (each word ends exactly where the next
 * begins) so a line's karaoke `\k` tags tile it with no rounding slop and no
 * gaps — the sum of `\k` durations equals the line's word-time span exactly.
 */
function contiguousTranscript(texts: string[], from = 0): TranscriptSegment[] {
  let t = from;
  const words = texts.map((word) => {
    const start = t;
    const end = t + 0.4;
    t = end;
    return { word, start, end };
  });
  return [
    {
      text: texts.join(" "),
      start: words[0].start,
      end: words[words.length - 1].end,
      words,
    },
  ];
}

/** Sum of the `\k<cs>` centisecond values in a Dialogue text run. */
function sumKaraoke(text: string): number {
  const matches = text.matchAll(/\\k(\d+)/g);
  let sum = 0;
  for (const m of matches) sum += Number(m[1]);
  return sum;
}

function dialogueLines(ass: string): string[] {
  return ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
}

describe("hexToAss", () => {
  it("reorders #RRGGBB to &HAABBGGRR with opaque alpha by default", () => {
    // #123456 -> RR=12 GG=34 BB=56 -> &H00 + BB GG RR
    expect(hexToAss("#123456")).toBe("&H00563412");
    expect(hexToAss("#FFFFFF")).toBe("&H00FFFFFF");
    expect(hexToAss("#000000")).toBe("&H00000000");
  });

  it("encodes an alpha byte in the high pair", () => {
    expect(hexToAss("#FFFFFF", 255)).toBe("&HFFFFFFFF");
    expect(hexToAss("#FFFFFF", 128)).toBe("&H80FFFFFF");
  });

  it("falls back to white for malformed input rather than emitting garbage", () => {
    expect(hexToAss("not-a-color")).toBe("&H00FFFFFF");
  });
});

describe("assTime", () => {
  it("formats seconds as H:MM:SS.cc", () => {
    expect(assTime(0)).toBe("0:00:00.00");
    expect(assTime(1.5)).toBe("0:00:01.50");
    expect(assTime(75.25)).toBe("0:01:15.25");
    expect(assTime(3661.07)).toBe("1:01:01.07");
  });
});

describe("alignment", () => {
  it("maps position to the numpad alignment", () => {
    expect(alignment("top")).toBe(8);
    expect(alignment("middle")).toBe(5);
    expect(alignment("bottom")).toBe(2);
  });
});

describe("escapeText", () => {
  it("neutralises ASS control characters", () => {
    expect(escapeText("a{b}c")).toBe("a(b)c");
    expect(escapeText("back\\slash")).toBe("backslash");
    expect(escapeText("two\nlines")).toBe("two lines");
  });
});

describe("toAss structure", () => {
  const doc: CaptionDoc = {
    cues: clipCaptions(contiguousTranscript(["hello", "world"]), 0, 1),
    style: resolveStyle({ preset: "clean-sub" }),
    name: "clean-sub",
  };
  const ass = toAss(doc, 1080, 1920);

  it("emits the three required ASS sections", () => {
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("[Events]");
  });

  it("uses the real video dimensions as the play resolution", () => {
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
  });

  it("names the Style after the doc and references it in Dialogue events", () => {
    expect(ass).toMatch(/^Style: clean-sub,/m);
    for (const line of dialogueLines(ass)) {
      expect(line).toContain(",clean-sub,");
    }
  });

  it("defaults the style name to Caption when the doc carries none", () => {
    const ass2 = toAss({ ...doc, name: undefined }, 1080, 1920);
    expect(ass2).toMatch(/^Style: Caption,/m);
  });
});

describe("toAss presets", () => {
  it("renders a Style line for every preset with its font and size", () => {
    const cues = clipCaptions(contiguousTranscript(["one", "two"]), 0, 1);
    for (const preset of CAPTION_PRESET_NAMES) {
      const style = resolveStyle({ preset });
      const ass = toAss({ cues, style, name: preset }, 1080, 1920);
      const styleLine = ass
        .split("\n")
        .find((l) => l.startsWith(`Style: ${preset},`));
      expect(styleLine, `Style line for ${preset}`).toBeDefined();
      // Field 2 = Fontname, field 3 = Fontsize.
      const fields = styleLine!.replace(/^Style:\s*/, "").split(",");
      expect(fields[1]).toBe(style.fontFamily);
      expect(Number(fields[2])).toBe(style.fontSize);
    }
  });

  it("switches BorderStyle to the opaque box (3) only for boxed presets", () => {
    const cues = clipCaptions(contiguousTranscript(["x"]), 0, 1);
    const borderStyleOf = (preset: (typeof CAPTION_PRESET_NAMES)[number]) => {
      const ass = toAss(
        { cues, style: resolveStyle({ preset }), name: preset },
        1080,
        1920,
      );
      const line = ass.split("\n").find((l) => l.startsWith(`Style: ${preset},`))!;
      return line.replace(/^Style:\s*/, "").split(",")[15]; // BorderStyle field
    };
    expect(borderStyleOf("boxed")).toBe("3");
    expect(borderStyleOf("clean-sub")).toBe("1");
  });
});

describe("toAss karaoke", () => {
  it("emits \\k tags whose durations sum to each line's word-time span", () => {
    // bold-pop has karaoke on. One line per cue (maxLines 1) so every Dialogue
    // event corresponds to exactly one caption line.
    const transcript = contiguousTranscript(
      ["alpha", "beta", "gamma", "delta"],
      0,
    );
    const cues = clipCaptions(transcript, 0, 2, { maxChars: 12, maxLines: 1 });
    expect(cues.length).toBeGreaterThan(0);
    const style = resolveStyle({ preset: "bold-pop" });
    const ass = toAss({ cues, style, name: "bold-pop" }, 1080, 1920);

    const dialogues = dialogueLines(ass);
    expect(dialogues.length).toBe(cues.length);

    dialogues.forEach((line, i) => {
      const cue: CaptionCue = cues[i];
      const captionLine = cue.lines[0];
      const span = centiseconds(captionLine.end - captionLine.start);
      expect(sumKaraoke(line)).toBe(span);
      // Every word in the line carries text after its \k tag.
      for (const word of captionLine.words) {
        expect(line.toUpperCase()).toContain(word.text.toUpperCase());
      }
    });
  });

  it("bridges silence between words with a gap \\k tag so the sweep stays synced", () => {
    // Words 0.2s long with 0.3s of silence between them: k-sum must include the
    // gaps, covering the full cue span.
    const transcript: TranscriptSegment[] = [
      {
        text: "a b",
        start: 0,
        end: 0.7,
        words: [
          { word: "a", start: 0, end: 0.2 },
          { word: "b", start: 0.5, end: 0.7 },
        ],
      },
    ];
    const cues = clipCaptions(transcript, 0, 1, { maxLines: 1 });
    const style = resolveStyle({ preset: "bold-pop" });
    const ass = toAss({ cues, style, name: "bold-pop" }, 1080, 1920);
    const dialogue = dialogueLines(ass)[0];
    // 20cs (a) + 30cs (gap) + 20cs (b) = 70cs = full line span.
    expect(sumKaraoke(dialogue)).toBe(70);
    expect(dialogue).toContain("{\\k30}");
  });

  it("omits \\k tags entirely when the style has karaoke off", () => {
    const cues = clipCaptions(contiguousTranscript(["no", "karaoke"]), 0, 1, {
      maxLines: 1,
    });
    const style = resolveStyle({ preset: "clean-sub" }); // karaoke off
    const ass = toAss({ cues, style, name: "clean-sub" }, 1080, 1920);
    expect(ass).not.toContain("\\k");
  });

  it("applies uppercase from the style to the rendered word text", () => {
    const cue = clipCaptions(contiguousTranscript(["quiet"]), 0, 1, {
      maxLines: 1,
    })[0];
    const upper = resolveStyle({ preset: "bold-pop" }); // uppercase on
    const lower = resolveStyle({ preset: "clean-sub" }); // uppercase off
    expect(cueText(cue, upper)).toContain("QUIET");
    expect(cueText(cue, lower)).toContain("quiet");
  });
});
