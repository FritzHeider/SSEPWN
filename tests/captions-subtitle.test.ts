import { describe, expect, it } from "vitest";

import type { CaptionDoc } from "../src/lib/captions/ass";
import type { CaptionCue, CaptionLine } from "../src/lib/captions/clip";
import { resolveStyle } from "../src/lib/captions/style";
import { captionDocToSrt, captionDocToVtt, srtTime, vttTime } from "../src/lib/captions/subtitle";

/** Build a caption line from plain text at a fixed span (word timings don't
 * matter for the subtitle converters — they read line text and cue spans). */
function line(text: string, start: number, end: number): CaptionLine {
  return {
    words: text.split(" ").map((t) => ({ text: t, start, end })),
    text,
    start,
    end,
  };
}

function cue(start: number, end: number, ...lines: CaptionLine[]): CaptionCue {
  return { lines, start, end };
}

function doc(...cues: CaptionCue[]): CaptionDoc {
  return { cues, style: resolveStyle(undefined), name: "Caption" };
}

describe("srtTime / vttTime", () => {
  it("formats sub-second times with a comma (SRT) vs a dot (VTT)", () => {
    expect(srtTime(1.5)).toBe("00:00:01,500");
    expect(vttTime(1.5)).toBe("00:00:01.500");
  });

  it("formats hours, minutes and milliseconds", () => {
    // 1h 1m 1.234s
    const t = 3600 + 60 + 1.234;
    expect(srtTime(t)).toBe("01:01:01,234");
    expect(vttTime(t)).toBe("01:01:01.234");
  });

  it("clamps a negative time to zero", () => {
    expect(srtTime(-5)).toBe("00:00:00,000");
  });

  it("rounds to the nearest millisecond", () => {
    expect(srtTime(0.0004)).toBe("00:00:00,000");
    expect(srtTime(0.0006)).toBe("00:00:00,001");
  });
});

describe("captionDocToSrt", () => {
  it("emits sequential indices, comma timestamps, and blank-line separation", () => {
    const out = captionDocToSrt(doc(cue(0, 1.2, line("hello there", 0, 1.2)), cue(1.2, 2.5, line("world", 1.2, 2.5))));
    expect(out).toBe(
      "1\n00:00:00,000 --> 00:00:01,200\nhello there\n\n" +
        "2\n00:00:01,200 --> 00:00:02,500\nworld\n",
    );
  });

  it("joins the lines of a multi-line cue with a newline", () => {
    const out = captionDocToSrt(doc(cue(0, 2, line("first line", 0, 1), line("second line", 1, 2))));
    expect(out).toContain("first line\nsecond line");
  });

  it("skips empty cues and keeps indices sequential with no gaps", () => {
    const out = captionDocToSrt(
      doc(cue(0, 1, line("kept", 0, 1)), cue(1, 2, line("", 1, 2)), cue(2, 3, line("also", 2, 3))),
    );
    expect(out).toBe("1\n00:00:00,000 --> 00:00:01,000\nkept\n\n2\n00:00:02,000 --> 00:00:03,000\nalso\n");
  });

  it("is an empty string for a doc with no renderable cues", () => {
    expect(captionDocToSrt(doc())).toBe("");
    expect(captionDocToSrt(doc(cue(0, 1, line("", 0, 1))))).toBe("");
  });
});

describe("captionDocToVtt", () => {
  it("starts with the WEBVTT header and uses dot timestamps, no indices", () => {
    const out = captionDocToVtt(doc(cue(0, 1.2, line("hello", 0, 1.2))));
    expect(out).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:01.200\nhello\n");
  });

  it("emits just the header for an empty doc", () => {
    expect(captionDocToVtt(doc())).toBe("WEBVTT\n");
  });

  it("skips empty cues", () => {
    const out = captionDocToVtt(doc(cue(0, 1, line("a", 0, 1)), cue(1, 2, line("", 1, 2))));
    expect(out).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\na\n");
  });
});
