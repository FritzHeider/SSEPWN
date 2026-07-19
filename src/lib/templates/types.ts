/**
 * Template model (SPEC.md § Feature checklist 11 "Templates", Phase 09).
 *
 * A template is a saved bundle of look-and-feel that can be applied to any clip:
 * caption style/preset, reframe aspect ratio, CTA entries, brand colors, and an
 * optional watermark image. Applying a template overwrites those aspects of a
 * clip's edit state but never its structural edits (segments, trims, SFX,
 * transitions) — see `applyTemplate` in `./apply`.
 *
 * Everything here is pure data + boundary validation, mirroring the caption /
 * crop / CTA models: `parseTemplateInput` keeps only well-typed fields from an
 * untrusted body (a save-as-template request or a hand-edited row) so a bad
 * shape can never corrupt a stored template or flow into `applyTemplate`.
 */

import {
  CAPTION_PRESET_NAMES,
  DEFAULT_CAPTION_PRESET,
  type CaptionPreset,
  type CaptionStyle,
  parseStyle,
  resolveStyle,
} from "../captions/style";
import { ASPECT_RATIOS, type AspectRatio } from "../crop/types";
import {
  CTA_ANIMS,
  CTA_POSITIONS,
  clampCtaFontSize,
  clampCtaOffset,
  type CtaAnim,
  type CtaOffset,
  type CtaPosition,
  type CtaVariant,
} from "../timeline/cta";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * A CTA entry carried by a template. Unlike a live {@link CtaOverlay} it has no
 * `id` (one is minted when applied) and no resolved style/background (the
 * template's brand colors drive that at apply time). `start`/`end` are timeline
 * seconds; `applyTemplate` clamps them to the target clip's real length, so an
 * `end` far past the clip simply means "to the end".
 */
export interface TemplateCta {
  variant: CtaVariant;
  /** Text content for a `text` CTA; empty for an `image` CTA. */
  content: string;
  /** Image asset id for an `image` CTA; `null` for a text card. */
  assetId: number | null;
  position: CtaPosition;
  offset: CtaOffset;
  start: number;
  end: number;
  animIn: CtaAnim;
  animOut: CtaAnim;
  /** Text size as a fraction of frame height (like {@link CtaStyle.fontSize}). */
  fontSize: number;
}

/**
 * A fully-resolved template as used by `applyTemplate` and returned to the UI.
 * `id`/`builtin` are DB-assigned; the rest is the bundle. `captionStyle` is a
 * COMPLETE {@link CaptionStyle} (every field present) so a save→apply round-trip
 * reproduces the source clip's look exactly, not just its preset name.
 */
export interface Template {
  id: number;
  /** Stable slug for a built-in (unique, used for idempotent seeding); `null`
   * for a user-saved template. */
  key: string | null;
  name: string;
  /** Built-ins are undeletable in the manage UI. */
  builtin: boolean;
  captionPreset: CaptionPreset;
  captionStyle: CaptionStyle;
  aspectRatio: AspectRatio;
  ctas: TemplateCta[];
  /** Brand primary `#RRGGBB` — drives the caption highlight color. */
  brandPrimary: string;
  /** Brand secondary `#RRGGBB` — drives the CTA background. */
  brandSecondary: string;
  /** Image asset id for a corner watermark, or `null` for none. */
  watermarkAssetId: number | null;
}

/**
 * The template bundle without DB identity — what a save-as-template request
 * carries and what a built-in is defined as. `parseTemplateInput` produces this.
 */
export type TemplateInput = Omit<Template, "id" | "builtin">;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

function isCaptionPreset(value: unknown): value is CaptionPreset {
  return typeof value === "string" && (CAPTION_PRESET_NAMES as readonly string[]).includes(value);
}

function isAspectRatio(value: unknown): value is AspectRatio {
  return typeof value === "string" && (ASPECT_RATIOS as readonly string[]).includes(value);
}

function isCtaPosition(value: unknown): value is CtaPosition {
  return typeof value === "string" && (CTA_POSITIONS as readonly string[]).includes(value);
}

function isCtaAnim(value: unknown): value is CtaAnim {
  return typeof value === "string" && (CTA_ANIMS as readonly string[]).includes(value);
}

/** Keep only a well-formed CTA entry from an untrusted object, or `null`. A text
 * CTA needs non-empty content; an image CTA a positive asset id. */
export function parseTemplateCta(value: unknown): TemplateCta | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const variant: CtaVariant = v.variant === "image" ? "image" : "text";
  const content = typeof v.content === "string" ? v.content : "";
  const assetId = isFiniteNumber(v.assetId) ? v.assetId : null;
  if (variant === "text" && content.trim() === "") return null;
  if (variant === "image" && (assetId === null || assetId <= 0)) return null;
  const start = isFiniteNumber(v.start) && v.start >= 0 ? v.start : 0;
  const end = isFiniteNumber(v.end) && v.end > start ? v.end : start + 3;
  return {
    variant,
    content: variant === "image" ? "" : content,
    assetId: variant === "image" ? assetId : null,
    position: isCtaPosition(v.position) ? v.position : "bottom-center",
    offset: clampCtaOffset(v.offset as Partial<CtaOffset> | undefined),
    start,
    end,
    animIn: isCtaAnim(v.animIn) ? v.animIn : "fade",
    animOut: isCtaAnim(v.animOut) ? v.animOut : "fade",
    fontSize: clampCtaFontSize(isFiniteNumber(v.fontSize) ? v.fontSize : undefined),
  };
}

/**
 * Validate an untrusted template bundle into a clean {@link TemplateInput},
 * filling any missing/invalid field with a safe default so the result is always
 * complete and directly applicable. `name` defaults to "Untitled template".
 */
export function parseTemplateInput(value: unknown): TemplateInput {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const captionPreset = isCaptionPreset(raw.captionPreset)
    ? raw.captionPreset
    : DEFAULT_CAPTION_PRESET;
  // resolveStyle layers the preset + any overrides into a complete style.
  const captionStyle = resolveStyle({ preset: captionPreset, ...parseStyle(raw.captionStyle) });
  const brandPrimary = isColor(raw.brandPrimary)
    ? raw.brandPrimary
    : captionStyle.highlightColor;
  const brandSecondary = isColor(raw.brandSecondary) ? raw.brandSecondary : "#000000";
  const ctas = Array.isArray(raw.ctas)
    ? raw.ctas.map(parseTemplateCta).filter((c): c is TemplateCta => c !== null)
    : [];
  return {
    key: typeof raw.key === "string" && raw.key.trim() !== "" ? raw.key.trim() : null,
    name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : "Untitled template",
    captionPreset,
    // Keep the caption highlight in lockstep with the brand primary so a
    // save→apply round-trip is a fixed point (applyTemplate re-imposes this).
    captionStyle: { ...captionStyle, highlightColor: brandPrimary },
    aspectRatio: isAspectRatio(raw.aspectRatio) ? raw.aspectRatio : "9:16",
    ctas,
    brandPrimary,
    brandSecondary,
    watermarkAssetId: isFiniteNumber(raw.watermarkAssetId) && raw.watermarkAssetId > 0
      ? raw.watermarkAssetId
      : null,
  };
}
