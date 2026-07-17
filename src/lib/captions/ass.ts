/**
 * Render a clip's caption document to an ASS (Advanced SubStation Alpha)
 * subtitle file (SPEC.md § Captions, Phase 05 `toAss`).
 *
 * This is the bridge between the pure caption model (`clipCaptions` cues +
 * a resolved `CaptionStyle`) and ffmpeg's `ass` burn-in filter. Like the rest
 * of the caption core it is pure text-in/text-out — no ffmpeg, no clock — so
 * the exact bytes are unit-testable. Burn-in itself (`burnIn`) only feeds this
 * string to the filter; render fidelity is verified at export (Phase 10).
 *
 * Two things this file gets right and the test pins down:
 *  - Each style preset maps to one ASS `Style:` line whose font/size/colours
 *    come from the resolved `CaptionStyle`.
 *  - Karaoke uses `\k` tags built from the word timings. The tags for a cue
 *    tile its whole time span (gap tags fill the silence between words), so the
 *    highlight sweep stays in sync with speech instead of drifting on pauses.
 *
 * Colours are converted from the model's user-facing `#RRGGBB` to ASS's
 * `&HAABBGGRR` (alpha-blue-green-red, alpha 00 = opaque). Positions map to the
 * numpad `Alignment` (horizontal always centred): top→8, middle→5, bottom→2.
 */

import type { CaptionCue } from "./clip";
import type { CaptionPosition, CaptionStyle } from "./style";

/**
 * A clip's caption document: the on-screen cues plus the style to render them
 * with. Stored inside `clip_edits.state`; consumed here and by the editor UI.
 * `name` is the ASS style identifier (defaults to `"Caption"`); the caption
 * editor passes the active preset name so the file is self-describing.
 */
export interface CaptionDoc {
  cues: CaptionCue[];
  style: CaptionStyle;
  /** ASS `Style:` name. Defaults to `"Caption"`. */
  name?: string;
}

/** Fallback ASS style name when a doc carries none. */
export const DEFAULT_STYLE_NAME = "Caption";

/** Horizontal margins (px) so long lines never touch the frame edge. */
const MARGIN_H = 40;

/** Convert seconds to whole centiseconds (ASS's time unit). */
export function centiseconds(seconds: number): number {
  return Math.max(0, Math.round(seconds * 100));
}

/** Format seconds as ASS `H:MM:SS.cc`. */
export function assTime(seconds: number): string {
  const cs = centiseconds(seconds);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(c)}`;
}

/**
 * Convert a `#RRGGBB` hex colour to ASS `&HAABBGGRR`.
 *
 * ASS orders the bytes alpha, blue, green, red and treats alpha `00` as fully
 * opaque, `FF` as fully transparent — the inverse of a normal alpha channel.
 */
export function hexToAss(hex: string, alpha = 0): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  const rgb = m ? m[1].toUpperCase() : "FFFFFF";
  const rr = rgb.slice(0, 2);
  const gg = rgb.slice(2, 4);
  const bb = rgb.slice(4, 6);
  const aa = pad2Hex(clampByte(alpha));
  return `&H${aa}${bb}${gg}${rr}`;
}

/** ASS numpad alignment for a vertical position (horizontal always centred). */
export function alignment(position: CaptionPosition): number {
  switch (position) {
    case "top":
      return 8;
    case "middle":
      return 5;
    case "bottom":
    default:
      return 2;
  }
}

/**
 * Build the complete ASS document for a caption doc at the given video size.
 * The `[Script Info]` play-res is the real video dimensions so pixel sizes and
 * margins in the style map 1:1 to the burned-in frame.
 */
export function toAss(doc: CaptionDoc, videoW: number, videoH: number): string {
  const name = styleName(doc.name);
  const sections = [
    scriptInfo(videoW, videoH),
    styles(name, doc.style),
    events(name, doc.cues, doc.style),
  ];
  // ASS is CRLF-terminated by convention; libass accepts LF too, but matching
  // the format keeps generated files portable.
  return sections.join("\n") + "\n";
}

function scriptInfo(videoW: number, videoH: number): string {
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    // WrapStyle 2 = no automatic wrapping; we control line breaks with \N.
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${Math.round(videoW)}`,
    `PlayResY: ${Math.round(videoH)}`,
    "",
  ].join("\n");
}

const STYLE_FORMAT =
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, " +
  "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, " +
  "ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, " +
  "MarginR, MarginV, Encoding";

function styles(name: string, style: CaptionStyle): string {
  return ["[V4+ Styles]", STYLE_FORMAT, styleLine(name, style), ""].join("\n");
}

/**
 * One `Style:` line. PrimaryColour is what a word becomes once its `\k` fires
 * (the highlight colour when karaoke is on, otherwise just the text colour);
 * SecondaryColour is the not-yet-spoken colour. A background box uses
 * BorderStyle 3 with the box colour + opacity in BackColour; otherwise an
 * outline of `strokeWidth` is drawn.
 */
export function styleLine(name: string, style: CaptionStyle): string {
  const primary = hexToAss(style.karaoke ? style.highlightColor : style.textColor);
  const secondary = hexToAss(style.textColor);
  const outline = hexToAss(style.strokeColor);
  const back = style.box
    ? hexToAss(style.boxColor, opacityToAlpha(style.boxOpacity))
    : hexToAss("#000000", 0);
  const borderStyle = style.box ? 3 : 1;
  const fields = [
    name,
    style.fontFamily,
    round(style.fontSize),
    primary,
    secondary,
    outline,
    back,
    0, // Bold
    0, // Italic
    0, // Underline
    0, // StrikeOut
    100, // ScaleX
    100, // ScaleY
    0, // Spacing
    0, // Angle
    borderStyle,
    round(style.strokeWidth),
    0, // Shadow
    alignment(style.position),
    MARGIN_H, // MarginL
    MARGIN_H, // MarginR
    round(style.marginV),
    1, // Encoding
  ];
  return `Style: ${fields.join(",")}`;
}

const EVENT_FORMAT =
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, Effect, Text";

function events(name: string, cues: CaptionCue[], style: CaptionStyle): string {
  const lines = ["[Events]", EVENT_FORMAT];
  for (const cue of cues) {
    lines.push(dialogue(name, cue, style));
  }
  lines.push("");
  return lines.join("\n");
}

/** One `Dialogue:` line per cue (a cue = one on-screen block, up to 2 lines). */
export function dialogue(
  name: string,
  cue: CaptionCue,
  style: CaptionStyle,
): string {
  const start = assTime(cue.start);
  const end = assTime(cue.end);
  const text = cueText(cue, style);
  return `Dialogue: 0,${start},${end},${name},,0,0,,${text}`;
}

/**
 * Render a cue's on-screen text. Lines are joined with `\N`. With karaoke on,
 * each word is prefixed by a `{\k<cs>}` tag of its spoken duration, and any
 * silence before a word becomes a leading `{\k<cs>}` gap tag — so the tags for
 * the cue tile its full `[start, end]` span and the sweep never drifts.
 */
export function cueText(cue: CaptionCue, style: CaptionStyle): string {
  const parts: string[] = [];
  let cursor = cue.start;
  cue.lines.forEach((line, li) => {
    if (li > 0) parts.push("\\N");
    line.words.forEach((word, wi) => {
      const text = escapeText(style.uppercase ? word.text.toUpperCase() : word.text);
      if (style.karaoke) {
        const gap = centiseconds(word.start - cursor);
        if (gap > 0) parts.push(`{\\k${gap}}`);
        parts.push(`{\\k${centiseconds(word.end - word.start)}}${text}`);
        cursor = word.end;
      } else {
        parts.push(text);
      }
      if (wi < line.words.length - 1) parts.push(" ");
    });
  });
  return parts.join("");
}

/**
 * Neutralise ASS control characters in caption text. `{`/`}` open/close
 * override blocks and `\` starts an escape, so a stray one from a transcript
 * would corrupt the line — replace braces with parens and drop backslashes.
 * Newlines collapse to spaces (line breaks are the cue's job, via `\N`).
 */
export function escapeText(text: string): string {
  return text
    .replace(/\\/g, "")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/[\r\n]+/g, " ");
}

function styleName(name: string | undefined): string {
  const trimmed = name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_STYLE_NAME;
}

/** Map opacity 0..1 to an ASS alpha byte (0 = opaque, 255 = transparent). */
function opacityToAlpha(opacity: number): number {
  const clamped = Math.min(1, Math.max(0, opacity));
  return Math.round((1 - clamped) * 255);
}

function clampByte(n: number): number {
  return Math.min(255, Math.max(0, Math.round(n)));
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function pad2Hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, "0");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
