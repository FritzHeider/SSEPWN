/**
 * CTA overlays (Phase 08). A call-to-action overlay renders a short text or an
 * image asset over the edited timeline for a bounded range, anchored to one of
 * nine grid cells (plus a small normalised offset) and animated in/out. Overlays
 * live on the shared {@link TimelineDoc.overlayTrack} (Phase 07 left it an open
 * blob array so a Phase-08 payload survives a Phase-07 op untouched); they are
 * discriminated from B-roll slots by `kind: "cta"` (B-roll uses `kind: "broll"`),
 * and a CTA's own `variant` distinguishes a text card from an image.
 *
 * Everything here is pure `(doc, args) → doc`, mirroring `broll.ts`/`sfx.ts`: the
 * editor's React layer holds the resulting docs on the undo stack and never does
 * the range/position/style arithmetic itself. The animated DOM preview and
 * `renderPlan` (Phase 08 crux) both read overlays back with {@link listCta}.
 */

import { totalDuration } from "./ops";
import { assertValidDoc } from "./state";
import { TimelineError, type TimelineDoc, type TimelineOverlay } from "./types";

/** A text card or an image asset. */
export type CtaVariant = "text" | "image";

/** In/out animation for a CTA overlay. `none` snaps; `fade` cross-fades opacity;
 * `slide` translates in from the anchored edge. Drives the CSS preview and the
 * `renderPlan` fade/slide nodes. */
export type CtaAnim = "none" | "fade" | "slide";

/** One of nine anchor cells (row × column) the overlay is pinned to. */
export type CtaPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "middle-center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

/** The variants, in picker order. */
export const CTA_VARIANTS: readonly CtaVariant[] = ["text", "image"] as const;

/** The animations, in picker order (`none` first = default). */
export const CTA_ANIMS: readonly CtaAnim[] = ["none", "fade", "slide"] as const;

/** The nine anchor cells, in reading order (top-left → bottom-right). */
export const CTA_POSITIONS: readonly CtaPosition[] = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

/** Visual style of a text CTA card. `fontSize` is a fraction of the frame height
 * (resolution-independent, like pip geometry); `color`/`background` are CSS
 * colour strings passed straight through to the preview and `renderPlan`. */
export interface CtaStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  background: string;
}

/** A small nudge off the anchored grid cell, in normalised frame units
 * (`0` = centred on the cell). */
export interface CtaOffset {
  x: number;
  y: number;
}

/** One CTA overlay on the overlay track. `start`/`end` are TIMELINE seconds
 * (edited-playback clock), like a B-roll slot. */
export interface CtaOverlay extends TimelineOverlay {
  id: string;
  kind: "cta";
  variant: CtaVariant;
  /** Text content (`text` variant); empty string for an image. */
  content: string;
  /** Row id of the image asset in the `assets` table (`image` variant); `null`
   * for a text card. */
  assetId: number | null;
  position: CtaPosition;
  offset: CtaOffset;
  /** Overlay start in timeline seconds (`>= 0`). */
  start: number;
  /** Overlay end in timeline seconds (`> start`, `<= totalDuration`). */
  end: number;
  animIn: CtaAnim;
  animOut: CtaAnim;
  style: CtaStyle;
}

/** Shortest a CTA overlay may be (seconds); matches the B-roll minimum so both
 * overlay kinds clamp identically on a very short clip. */
export const MIN_CTA_DURATION = 0.05;

/** Font-size band (fraction of frame height): below the minimum the text is
 * unreadable, above the maximum it swamps the frame. */
export const MIN_CTA_FONT_SIZE = 0.02;
export const MAX_CTA_FONT_SIZE = 0.25;

/** Largest allowed absolute offset (fraction of frame) off the anchor cell, so a
 * nudge can never fling the overlay right off-screen. */
export const MAX_CTA_OFFSET = 0.5;

/** Defaults for a freshly placed CTA. */
export const DEFAULT_CTA_POSITION: CtaPosition = "bottom-center";
export const DEFAULT_CTA_OFFSET: CtaOffset = { x: 0, y: 0 };
export const DEFAULT_CTA_STYLE: CtaStyle = {
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 0.06,
  color: "#ffffff",
  background: "rgba(0, 0, 0, 0.6)",
};

/** A built-in text CTA preset the picker can drop in with one click. */
export interface CtaPreset {
  id: string;
  label: string;
  content: string;
  position: CtaPosition;
  animIn: CtaAnim;
  animOut: CtaAnim;
  style: CtaStyle;
}

/** Built-in text CTA presets (SPEC.md Phase 08 requires ≥2). */
export const CTA_PRESETS: readonly CtaPreset[] = [
  {
    id: "follow-for-more",
    label: "Follow for more",
    content: "Follow for more",
    position: "bottom-center",
    animIn: "slide",
    animOut: "fade",
    style: {
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: 0.07,
      color: "#ffffff",
      background: "rgba(0, 0, 0, 0.65)",
    },
  },
  {
    id: "link-in-bio",
    label: "Link in bio",
    content: "Link in bio",
    position: "top-center",
    animIn: "fade",
    animOut: "fade",
    style: {
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: 0.06,
      color: "#ffffff",
      background: "#e11d48",
    },
  },
] as const;

/** Look up a built-in preset by id, or `undefined` when none matches. */
export function getCtaPreset(id: string): CtaPreset | undefined {
  return CTA_PRESETS.find((p) => p.id === id);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** True when `value` is one of the nine grid cells. */
export function isCtaPosition(value: unknown): value is CtaPosition {
  return typeof value === "string" && (CTA_POSITIONS as readonly string[]).includes(value);
}

/** True when `value` is a valid animation kind. */
export function isCtaAnim(value: unknown): value is CtaAnim {
  return typeof value === "string" && (CTA_ANIMS as readonly string[]).includes(value);
}

/** True when `value` is `"text"` or `"image"`. */
export function isCtaVariant(value: unknown): value is CtaVariant {
  return value === "text" || value === "image";
}

/** True when `value` is a well-formed CTA overlay (used to filter the mixed
 * overlay track, which also holds B-roll slots). */
export function isCtaOverlay(value: unknown): value is CtaOverlay {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === "cta" &&
    typeof v.id === "string" &&
    isCtaVariant(v.variant) &&
    typeof v.content === "string" &&
    (v.assetId === null || isFiniteNumber(v.assetId)) &&
    isCtaPosition(v.position) &&
    isFiniteNumber(v.start) &&
    isFiniteNumber(v.end) &&
    isCtaAnim(v.animIn) &&
    isCtaAnim(v.animOut) &&
    typeof v.style === "object" &&
    v.style !== null &&
    typeof v.offset === "object" &&
    v.offset !== null
  );
}

/** Clamp an offset into `[-MAX_CTA_OFFSET, MAX_CTA_OFFSET]` on both axes; a
 * non-finite field falls back to the default `0`. */
export function clampCtaOffset(offset: Partial<CtaOffset> | undefined): CtaOffset {
  const x = clamp(
    isFiniteNumber(offset?.x) ? (offset!.x as number) : DEFAULT_CTA_OFFSET.x,
    -MAX_CTA_OFFSET,
    MAX_CTA_OFFSET,
  );
  const y = clamp(
    isFiniteNumber(offset?.y) ? (offset!.y as number) : DEFAULT_CTA_OFFSET.y,
    -MAX_CTA_OFFSET,
    MAX_CTA_OFFSET,
  );
  return { x, y };
}

/** Clamp a font size into `[MIN_CTA_FONT_SIZE, MAX_CTA_FONT_SIZE]`, falling back
 * to the default for a non-finite input. */
export function clampCtaFontSize(size: number | undefined): number {
  if (!isFiniteNumber(size)) return DEFAULT_CTA_STYLE.fontSize;
  return clamp(size, MIN_CTA_FONT_SIZE, MAX_CTA_FONT_SIZE);
}

/** Merge a partial style over the default, clamping the font size and keeping
 * non-empty string colours/family (empty/other types fall back to the default). */
export function clampCtaStyle(style: Partial<CtaStyle> | undefined): CtaStyle {
  const str = (value: unknown, fallback: string): string =>
    typeof value === "string" && value.trim() !== "" ? value : fallback;
  return {
    fontFamily: str(style?.fontFamily, DEFAULT_CTA_STYLE.fontFamily),
    fontSize: clampCtaFontSize(style?.fontSize),
    color: str(style?.color, DEFAULT_CTA_STYLE.color),
    background: str(style?.background, DEFAULT_CTA_STYLE.background),
  };
}

/** Clamp a `[start, end]` range to the timeline, mirroring `clampBrollRange`:
 * both edges into `[0, total]` with a {@link MIN_CTA_DURATION} gap; on a timeline
 * shorter than the minimum the whole span is used. Throws on a non-finite edge. */
export function clampCtaRange(
  doc: TimelineDoc,
  start: number,
  end: number,
): { start: number; end: number } {
  if (!isFiniteNumber(start) || !isFiniteNumber(end)) {
    throw new TimelineError("CTA range must be finite numbers");
  }
  const total = totalDuration(doc);
  if (total <= MIN_CTA_DURATION) return { start: 0, end: total };
  const s = clamp(start, 0, total - MIN_CTA_DURATION);
  const e = clamp(end, s + MIN_CTA_DURATION, total);
  return { start: s, end: e };
}

/** All valid CTA overlays on the overlay track, in track order. */
export function listCta(doc: TimelineDoc): CtaOverlay[] {
  return doc.overlayTrack.filter(isCtaOverlay);
}

/** Assert the variant carries the data it needs: a text CTA has non-empty
 * content, an image CTA a positive `assetId`. Throws otherwise. */
function assertVariantPayload(variant: CtaVariant, content: string, assetId: number | null): void {
  if (variant === "text") {
    if (content.trim() === "") {
      throw new TimelineError("A text CTA must have non-empty content");
    }
  } else {
    if (!isFiniteNumber(assetId) || assetId <= 0) {
      throw new TimelineError("An image CTA must reference a positive assetId");
    }
  }
}

/** Arguments to {@link addCta}. `variant` defaults to `text`; `end` defaults to a
 * {@link MIN_CTA_DURATION}-plus slot from `start`. */
export interface AddCtaArgs {
  variant?: CtaVariant;
  content?: string;
  assetId?: number | null;
  position?: CtaPosition;
  offset?: Partial<CtaOffset>;
  start: number;
  end?: number;
  animIn?: CtaAnim;
  animOut?: CtaAnim;
  style?: Partial<CtaStyle>;
}

/** Insert a CTA overlay, clamping its range to the timeline and its
 * offset/style/font into range. Gets a fresh deterministic id from `doc.seq`
 * (shared with segment/B-roll ids but the `kind` keeps them distinct — pure, no
 * `Math.random`). Throws when the variant's payload is missing. */
export function addCta(doc: TimelineDoc, args: AddCtaArgs): TimelineDoc {
  const variant: CtaVariant = args.variant === "image" ? "image" : "text";
  const content = typeof args.content === "string" ? args.content : "";
  const assetId = variant === "image" ? (args.assetId ?? null) : null;
  assertVariantPayload(variant, content, assetId);

  const end = isFiniteNumber(args.end) ? args.end : args.start + MIN_CTA_DURATION;
  const range = clampCtaRange(doc, args.start, end);
  const seq = doc.seq + 1;
  const overlay: CtaOverlay = {
    id: `ov-${seq}`,
    kind: "cta",
    variant,
    content: variant === "image" ? "" : content,
    assetId,
    position: isCtaPosition(args.position) ? args.position : DEFAULT_CTA_POSITION,
    offset: clampCtaOffset(args.offset),
    start: range.start,
    end: range.end,
    animIn: isCtaAnim(args.animIn) ? args.animIn : "none",
    animOut: isCtaAnim(args.animOut) ? args.animOut : "none",
    style: clampCtaStyle(args.style),
  };
  return assertValidDoc({ ...doc, overlayTrack: [...doc.overlayTrack, overlay], seq });
}

/** Insert a CTA from a built-in {@link CtaPreset} at the given range. Unknown
 * preset id throws. */
export function addCtaPreset(
  doc: TimelineDoc,
  presetId: string,
  range: { start: number; end?: number },
): TimelineDoc {
  const preset = getCtaPreset(presetId);
  if (!preset) throw new TimelineError(`No CTA preset ${presetId}`);
  return addCta(doc, {
    variant: "text",
    content: preset.content,
    position: preset.position,
    animIn: preset.animIn,
    animOut: preset.animOut,
    style: preset.style,
    start: range.start,
    end: range.end,
  });
}

/** Patch accepted by {@link updateCta}: edit any field. Range, offset and style
 * are re-clamped; a variant switch must still carry that variant's payload. */
export interface UpdateCtaPatch {
  variant?: CtaVariant;
  content?: string;
  assetId?: number | null;
  position?: CtaPosition;
  offset?: Partial<CtaOffset>;
  start?: number;
  end?: number;
  animIn?: CtaAnim;
  animOut?: CtaAnim;
  style?: Partial<CtaStyle>;
}

/** Update one CTA overlay in place (identity/order preserved), re-clamping range,
 * offset and style so an out-of-frame or over-long edit can never be persisted.
 * Unknown id (or an overlay that is not a CTA) throws. */
export function updateCta(doc: TimelineDoc, id: string, patch: UpdateCtaPatch): TimelineDoc {
  const index = doc.overlayTrack.findIndex((o) => o.id === id && isCtaOverlay(o));
  if (index === -1) throw new TimelineError(`No CTA overlay ${id} on the overlay track`);
  const current = doc.overlayTrack[index] as CtaOverlay;

  const variant: CtaVariant = isCtaVariant(patch.variant) ? patch.variant : current.variant;
  const content = patch.content !== undefined ? patch.content : current.content;
  const assetId =
    patch.assetId !== undefined ? patch.assetId : current.assetId;
  // A text card carries no asset; an image carries no text.
  const nextContent = variant === "image" ? "" : content;
  const nextAssetId = variant === "image" ? assetId : null;
  assertVariantPayload(variant, nextContent, nextAssetId);

  const nextStart = patch.start !== undefined ? patch.start : current.start;
  const nextEnd = patch.end !== undefined ? patch.end : current.end;
  const range = clampCtaRange(doc, nextStart, nextEnd);

  const updated: CtaOverlay = {
    ...current,
    variant,
    content: nextContent,
    assetId: nextAssetId,
    position: isCtaPosition(patch.position) ? patch.position : current.position,
    offset: patch.offset !== undefined ? clampCtaOffset({ ...current.offset, ...patch.offset }) : current.offset,
    start: range.start,
    end: range.end,
    animIn: isCtaAnim(patch.animIn) ? patch.animIn : current.animIn,
    animOut: isCtaAnim(patch.animOut) ? patch.animOut : current.animOut,
    style: patch.style !== undefined ? clampCtaStyle({ ...current.style, ...patch.style }) : current.style,
  };
  const overlayTrack = doc.overlayTrack.map((o, i) => (i === index ? updated : o));
  return assertValidDoc({ ...doc, overlayTrack });
}

/** Remove a CTA overlay by id. Unknown id (or a non-CTA overlay) throws, so a
 * stale UI reference surfaces rather than silently no-op'ing. */
export function removeCta(doc: TimelineDoc, id: string): TimelineDoc {
  const exists = doc.overlayTrack.some((o) => o.id === id && isCtaOverlay(o));
  if (!exists) throw new TimelineError(`No CTA overlay ${id} on the overlay track`);
  const overlayTrack = doc.overlayTrack.filter((o) => o.id !== id);
  return assertValidDoc({ ...doc, overlayTrack });
}
