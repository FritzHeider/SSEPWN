/**
 * Pure presentation logic for the clip caption editor (SPEC.md § Captions,
 * Phase 05 "UI (clip editor page): caption list synced to preview … live overlay
 * preview rendered in HTML/CSS approximating the style").
 *
 * Like `clipCaptions`/`toAss`, this module is pure and Node-testable — no React,
 * no DOM, no clock. The editor component wires these decisions to a `<video>`
 * and to the PATCH API, but every "what is active" / "what does the style look
 * like in CSS" answer is computed here so it can be unit-tested without a
 * browser (DEC-005: pure logic in libs, thin JSX).
 *
 * Two jobs:
 *  - Address lines the way the edit API does. Cues are a display grouping; the
 *    caption edit API (`applyCaptionEdit`) addresses lines by a FLAT index
 *    across every cue. `editorLines` produces exactly that flat list (with the
 *    owning cue recorded), so the list the user clicks and the index the PATCH
 *    body carries are the same number.
 *  - Approximate the burned-in ASS look in HTML/CSS. `overlay*Style` map a
 *    `CaptionStyle` to plain CSS property objects — position → flex alignment,
 *    stroke → text-stroke, box → translucent background, karaoke → the spoken
 *    word taking `highlightColor`. Burn-in exactness is verified at export
 *    (Phase 10); this is the live approximation the editor shows.
 */

import type { CSSProperties } from "react";

import type { CaptionCue, CaptionLine } from "./clip";
import type { CaptionDoc } from "./ass";
import { CAPTION_PRESET_NAMES, type CaptionPreset, type CaptionStyle } from "./style";

/** Returned when no line/word is active at the current time. */
export const NO_ACTIVE_LINE = -1;
export const NO_ACTIVE_WORD = -1;

/** Floating-point slop so a boundary time counts as inside the earlier unit. */
const EPS = 1e-6;

/** A flat line plus the flat index the caption edit API addresses it by. */
export interface EditorLine {
  /** Flat index across every cue — the `line` value a PATCH edit carries. */
  index: number;
  /** Which cue (on-screen block) this line belongs to. */
  cue: number;
  line: CaptionLine;
}

/**
 * Flatten a document's cues into the flat line list the editor renders and the
 * edit API addresses. `index` counts lines across all cues in order, matching
 * `flattenLines`/`applyCaptionEdit`, so clicking list row N and PATCHing
 * `{ line: N }` refer to the same line.
 */
export function editorLines(doc: CaptionDoc): EditorLine[] {
  const out: EditorLine[] = [];
  let index = 0;
  doc.cues.forEach((cue, cueIndex) => {
    for (const line of cue.lines) {
      out.push({ index, cue: cueIndex, line });
      index += 1;
    }
  });
  return out;
}

/** Clip-relative time from the player's absolute time and the clip in-point. */
export function clipRelativeTime(currentTime: number, clipIn: number): number {
  return Math.max(0, currentTime - clipIn);
}

/**
 * Index (in `lines`) of the line active at clip-relative time `t`, or
 * `NO_ACTIVE_LINE`. A line is active over `[start, end)`; when lines abut, the
 * later one wins at the shared boundary so the highlight advances cleanly.
 */
export function activeLineIndex(lines: EditorLine[], t: number): number {
  let active = NO_ACTIVE_LINE;
  for (let i = 0; i < lines.length; i++) {
    const { line } = lines[i];
    if (t + EPS >= line.start && t < line.end - EPS) active = i;
  }
  return active;
}

/**
 * Index of the word active within a line at clip-relative time `t`, or
 * `NO_ACTIVE_WORD`. Used to move the karaoke highlight across a line's words.
 */
export function activeWordIndex(line: CaptionLine, t: number): number {
  let active = NO_ACTIVE_WORD;
  for (let i = 0; i < line.words.length; i++) {
    const word = line.words[i];
    if (t + EPS >= word.start && t < word.end - EPS) active = i;
  }
  return active;
}

/** The cue on screen at clip-relative time `t`, or null (gap / no captions). */
export function activeCue(doc: CaptionDoc, t: number): CaptionCue | null {
  let found: CaptionCue | null = null;
  for (const cue of doc.cues) {
    if (t + EPS >= cue.start && t < cue.end - EPS) found = cue;
  }
  return found;
}

/** Apply the style's uppercase toggle to a piece of caption text for display. */
export function displayText(text: string, style: CaptionStyle): string {
  return style.uppercase ? text.toUpperCase() : text;
}

const PRESET_LABELS: Record<CaptionPreset, string> = {
  "bold-pop": "Bold pop",
  "clean-sub": "Clean sub",
  "minimal-caps": "Minimal caps",
  boxed: "Boxed",
};

/** Preset choices for the style panel, in the canonical order. */
export const PRESET_OPTIONS: readonly { value: CaptionPreset; label: string }[] =
  CAPTION_PRESET_NAMES.map((value) => ({ value, label: PRESET_LABELS[value] }));

/** `#RRGGBB` + opacity (0…1) → a CSS `rgba(...)` string. */
export function rgba(hex: string, opacity: number): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  const a = Math.min(1, Math.max(0, opacity));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Vertical flex alignment for a caption `position`. Horizontal is centered. */
function verticalAlign(position: CaptionStyle["position"]): string {
  if (position === "top") return "flex-start";
  if (position === "middle") return "center";
  return "flex-end";
}

/**
 * CSS for the overlay wrapper that fills the player and stacks the active cue's
 * lines. `scale` maps the style's reference-height pixels onto the rendered
 * player size (rendered height ÷ reference height) so the preview tracks the
 * scaled-down video; at `scale === 1` the raw model values are used.
 */
export function overlayWrapperStyle(style: CaptionStyle, scale = 1): CSSProperties {
  return {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: verticalAlign(style.position),
    paddingTop: `${style.marginV * scale}px`,
    paddingBottom: `${style.marginV * scale}px`,
    paddingLeft: `${40 * scale}px`,
    paddingRight: `${40 * scale}px`,
    pointerEvents: "none",
    textAlign: "center",
  };
}

/**
 * CSS for one caption line block (font, box background, padding). Words inside
 * get `overlayWordStyle`; this styles the wrapper they sit in.
 */
export function overlayLineStyle(style: CaptionStyle, scale = 1): CSSProperties {
  const css: CSSProperties = {
    fontFamily: `"${style.fontFamily}", sans-serif`,
    fontSize: `${style.fontSize * scale}px`,
    fontWeight: 800,
    lineHeight: 1.2,
    display: "inline-block",
    maxWidth: "100%",
  };
  if (style.box) {
    css.backgroundColor = rgba(style.boxColor, style.boxOpacity);
    css.padding = `${0.1 * style.fontSize * scale}px ${0.25 * style.fontSize * scale}px`;
    css.borderRadius = `${0.08 * style.fontSize * scale}px`;
  }
  return css;
}

/**
 * CSS for a single word span. The spoken word takes `highlightColor` when
 * karaoke is on and it is `active`; otherwise the base `textColor`. Stroke is
 * approximated with `WebkitTextStroke` (burn-in uses the real ASS outline).
 */
export function overlayWordStyle(style: CaptionStyle, active: boolean, scale = 1): CSSProperties {
  const highlighted = style.karaoke && active;
  const css: CSSProperties = {
    color: highlighted ? style.highlightColor : style.textColor,
    whiteSpace: "pre",
  };
  if (style.strokeWidth > 0) {
    css.WebkitTextStroke = `${style.strokeWidth * scale}px ${style.strokeColor}`;
    // paintOrder keeps the fill on top of the stroke so thin glyphs stay legible.
    css.paintOrder = "stroke fill";
  }
  return css;
}
