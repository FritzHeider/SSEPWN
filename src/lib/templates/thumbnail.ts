/**
 * Pure style→CSS mapping for the template preview thumbnail (item 27). A template
 * card / manage row renders a small dark 9:16 tile with a few sample caption words
 * styled from the template's stored {@link CaptionStyle} — font, colours, outline,
 * and the highlight colour on the middle word — so the gallery previews the actual
 * look, not just swatches.
 *
 * This reuses the caption overlay's CSS mapping (`overlayLineStyle` /
 * `overlayWordStyle` in `captions/preview.ts`) rather than duplicating it, and
 * adds only the two thumbnail-specific decisions — the down-scale factor for a
 * small tile and which word is highlighted — so both stay unit-testable apart
 * from React (DEC-005). The middle word always takes the highlight colour here
 * (even when the template's `karaoke` toggle is off) so the tile previews the
 * brand highlight, which is the whole point of the swatch it replaces.
 */

import type { CSSProperties } from "react";

import { overlayLineStyle, overlayWordStyle } from "../captions/preview";
import type { CaptionStyle } from "../captions/style";

/** Reference design height the caption style's pixel sizes are relative to. */
export const THUMB_REFERENCE_HEIGHT = 1080;

/** The sample words a template tile shows. Three words → a clear middle to highlight. */
export const THUMB_SAMPLE_WORDS: readonly string[] = ["Your", "story", "here"];

/** One sample word plus the CSS it renders with on the tile. */
export interface ThumbWord {
  text: string;
  style: CSSProperties;
}

/**
 * Down-scale factor mapping the caption style's reference-height pixels onto a
 * `tileHeightPx`-tall tile (rendered height ÷ reference height) — the same
 * `scale` the live overlay uses, just derived from the tile instead of a video.
 * A non-positive tile height yields `0` so a not-yet-measured tile renders nothing.
 */
export function thumbnailScale(tileHeightPx: number, referenceHeight = THUMB_REFERENCE_HEIGHT): number {
  if (!Number.isFinite(tileHeightPx) || tileHeightPx <= 0 || referenceHeight <= 0) return 0;
  return tileHeightPx / referenceHeight;
}

/** Index of the word that gets the highlight colour: the middle of the list. */
export function thumbHighlightIndex(wordCount: number): number {
  if (wordCount <= 0) return -1;
  return Math.floor(wordCount / 2);
}

/** CSS for the sample line block (font, box) at the tile scale. */
export function thumbLineStyle(style: CaptionStyle, scale: number): CSSProperties {
  return overlayLineStyle(style, scale);
}

/**
 * The sample words for a tile, each with its CSS. The middle word is forced to
 * the style's `highlightColor` (regardless of the `karaoke` toggle) so the tile
 * previews the brand highlight; the rest take the base look from
 * `overlayWordStyle`. `words` defaults to {@link THUMB_SAMPLE_WORDS}.
 */
export function thumbWords(
  style: CaptionStyle,
  scale: number,
  words: readonly string[] = THUMB_SAMPLE_WORDS,
): ThumbWord[] {
  const highlight = thumbHighlightIndex(words.length);
  return words.map((raw, i) => {
    const text = style.uppercase ? raw.toUpperCase() : raw;
    const base = overlayWordStyle(style, false, scale);
    const css: CSSProperties = i === highlight ? { ...base, color: style.highlightColor } : base;
    return { text, style: css };
  });
}
