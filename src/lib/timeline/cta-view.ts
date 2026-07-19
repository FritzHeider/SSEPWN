/**
 * Pure presentation logic for the Phase-08 CTA overlay preview.
 *
 * React- and Node-free by design (DEC-005, mirroring `broll-view.ts`): the thin
 * `<CtaPreview>` / `<CtaPanel>` components only wire these decisions to the DOM
 * and the pure ops in {@link ./cta}. Everything that is arithmetic — which
 * overlays cover the playhead, where a 9-grid + offset anchor sits in the frame,
 * the resolution-independent font size, and which CSS keyframe animation (scrubbed
 * to the exact frame) plays at a given playhead — lives here where it is
 * unit-tested apart from the JSX.
 */

import { assetFileUrl } from "./broll-view";
import type { CtaAnim, CtaOverlay, CtaPosition } from "./cta";
import { listCta } from "./cta";
import type { TimelineDoc } from "./types";

/** The route that streams a CTA image asset's raw bytes (shared with B-roll). */
export { assetFileUrl as ctaImageUrl };

/** Inset (in % of frame) a corner/edge anchor keeps from the frame edge, so a
 * corner CTA is not flush against it. */
export const CTA_ANCHOR_MARGIN = 4;

/** Default in/out animation length (seconds); clamped to half the overlay span so
 * a very short CTA still shows a steady middle. */
export const CTA_ANIM_DURATION = 0.4;

/** How far (in % of the animated element) a slide travels. Matches the keyframes
 * `cta-slide-*` in `globals.css`. */
export const CTA_SLIDE_DISTANCE = 12;

/**
 * CTA overlays covering timeline second `t`, in track order. Active on the
 * half-open range `[start, end)` so the frame a CTA ends is already gone and two
 * abutting overlays never both render on the seam (mirrors `activeBrollAt`).
 */
export function activeCtaAt(doc: TimelineDoc, t: number): CtaOverlay[] {
  return listCta(doc).filter((cta) => t >= cta.start && t < cta.end);
}

/** The grid row an anchor sits in. */
export function ctaRow(position: CtaPosition): "top" | "middle" | "bottom" {
  return position.split("-")[0] as "top" | "middle" | "bottom";
}

/** The grid column an anchor sits in. */
export function ctaColumn(position: CtaPosition): "left" | "center" | "right" {
  return position.split("-")[1] as "left" | "center" | "right";
}

/** Where a CTA anchors in the frame: `left`/`top` are % of the frame; `translateX`/
 * `translateY` are the % self-translate that pins the element to its cell (so a
 * right-anchored box hangs off its right edge, a centred box straddles the line).
 * The normalised offset (`[-0.5, 0.5]`) nudges the anchor without changing which
 * edge it hangs from. */
export interface CtaAnchor {
  left: number;
  top: number;
  translateX: number;
  translateY: number;
}

/** Compute the frame anchor for a CTA from its 9-grid position and offset. */
export function ctaAnchor(cta: Pick<CtaOverlay, "position" | "offset">): CtaAnchor {
  const col = ctaColumn(cta.position);
  const row = ctaRow(cta.position);
  const offX = cta.offset.x * 100;
  const offY = cta.offset.y * 100;

  const left = col === "left" ? CTA_ANCHOR_MARGIN : col === "right" ? 100 - CTA_ANCHOR_MARGIN : 50;
  const top = row === "top" ? CTA_ANCHOR_MARGIN : row === "bottom" ? 100 - CTA_ANCHOR_MARGIN : 50;
  const translateX = col === "left" ? 0 : col === "right" ? -100 : -50;
  const translateY = row === "top" ? 0 : row === "bottom" ? -100 : -50;

  return { left: left + offX, top: top + offY, translateX, translateY };
}

/** The CTA text size expressed in container-query height units (`cqh`): the style
 * carries a fraction of the frame height, and `1cqh` is 1% of the preview frame's
 * height, so the label scales with the frame at any resolution. */
export function ctaFontSizeCqh(cta: Pick<CtaOverlay, "style">): number {
  return cta.style.fontSize * 100;
}

/** The effective in/out animation length for a CTA: {@link CTA_ANIM_DURATION}, but
 * never more than half the overlay span so `in` and `out` windows stay disjoint. */
export function ctaAnimDuration(cta: Pick<CtaOverlay, "start" | "end">): number {
  return Math.min(CTA_ANIM_DURATION, (cta.end - cta.start) / 2);
}

/** The `@keyframes` name (in `globals.css`) for an animation kind, direction and
 * grid row, or `null` for `none` (the CTA snaps and stays put). A slide enters
 * from — and exits toward — the anchored vertical edge (top cells drop in from
 * above; middle/bottom rise in from below). */
export function ctaAnimName(
  anim: CtaAnim,
  direction: "in" | "out",
  row: "top" | "middle" | "bottom",
): string | null {
  if (anim === "none") return null;
  if (anim === "fade") return `cta-fade-${direction}`;
  const fromAbove = row === "top";
  if (direction === "in") return fromAbove ? "cta-slide-in-down" : "cta-slide-in-up";
  return fromAbove ? "cta-slide-out-up" : "cta-slide-out-down";
}

/** The CSS animation to apply to a CTA at timeline second `t`: which keyframe,
 * how long it runs, and how far into it the playhead sits. The component scrubs
 * the animation to that exact frame with a negative `animation-delay`, so a paused
 * scrub freezes on the right frame and a playing transport runs on from it. `name`
 * is `null` while the CTA is in its steady middle (fully shown, no animation). */
export interface CtaAnimState {
  name: string | null;
  duration: number;
  elapsed: number;
}

/** Resolve the CSS animation for a CTA at timeline second `t` (assumes the CTA is
 * active, i.e. `start <= t < end`). Picks the in-window near the start, the
 * out-window near the end, and no animation in between. */
export function ctaAnimState(cta: CtaOverlay, t: number): CtaAnimState {
  const d = ctaAnimDuration(cta);
  const row = ctaRow(cta.position);
  if (cta.animIn !== "none" && t < cta.start + d) {
    return { name: ctaAnimName(cta.animIn, "in", row), duration: d, elapsed: t - cta.start };
  }
  if (cta.animOut !== "none" && t >= cta.end - d) {
    return { name: ctaAnimName(cta.animOut, "out", row), duration: d, elapsed: t - (cta.end - d) };
  }
  return { name: null, duration: d, elapsed: 0 };
}
