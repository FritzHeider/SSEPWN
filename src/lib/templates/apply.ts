/**
 * Applying / saving templates (SPEC.md § Feature checklist 11, Phase 09).
 *
 * `applyTemplate` is the pure heart of the feature: it takes a clip's parsed
 * `clip_edits.state` blob and a {@link Template}, and returns a NEW blob with the
 * template's look imposed — caption style, aspect ratio, CTA overlays, watermark,
 * brand colors — while leaving every structural edit untouched: segments, trims,
 * transitions, SFX cues, audio, and any manual-locked crop keyframes all survive.
 * The API route just wraps this (Phase-09 constraint: "application logic is a
 * pure function … unit-tested; the API route just wraps it").
 *
 * Applying is undoable: the exact previous blob is snapshotted (as a JSON
 * string) under a reserved `templateUndo` key so `undoTemplate` can restore it
 * byte-for-byte. `saveAsTemplate` is the inverse — it reads a clip's current
 * look back out into a {@link TemplateInput}.
 */

import type { CaptionDoc } from "../captions/ass";
import { readCaptionDoc } from "../captions/edit";
import { DEFAULT_CAPTION_PRESET, resolveStyle } from "../captions/style";
import { buildCropState, readCropState, withCropState } from "../crop/state";
import type { AspectRatio } from "../crop/types";
import { addCta } from "../timeline/cta";
import { listCta } from "../timeline/cta";
import { totalDuration } from "../timeline/ops";
import { readTimelineDoc, withTimelineDoc } from "../timeline/state";
import type { TimelineDoc, TimelineOverlay } from "../timeline/types";
import type { Template, TemplateCta, TemplateInput } from "./types";

/** Reserved key holding the pre-apply blob (JSON string) for one-level undo. */
const UNDO_KEY = "templateUndo";
/** Reserved key recording which template was last applied. */
const TEMPLATE_ID_KEY = "templateId";

/** A parsed `clip_edits.state` blob. Open shape: it also carries `timeline`,
 * `crop`, `captions`, and the reserved template keys. */
export type ClipEditState = Record<string, unknown>;

/** Place a template's CTA entries (and watermark) onto a timeline: drop the
 * clip's existing CTA overlays, keep B-roll/other overlays, then add the
 * template's, clamped to the clip's real length with brand-colored backgrounds. */
function applyCtas(timeline: TimelineDoc, template: Template): TimelineDoc {
  // Keep everything on the overlay track that is NOT a CTA (B-roll etc.).
  const kept = timeline.overlayTrack.filter(
    (ov: TimelineOverlay) => (ov as { kind?: unknown }).kind !== "cta",
  );
  let tl: TimelineDoc = { ...timeline, overlayTrack: kept };

  for (const cta of template.ctas) {
    tl = addCta(tl, {
      variant: cta.variant,
      content: cta.content,
      assetId: cta.assetId,
      position: cta.position,
      offset: cta.offset,
      start: cta.start,
      end: cta.end,
      animIn: cta.animIn,
      animOut: cta.animOut,
      style: { background: template.brandSecondary, fontSize: cta.fontSize },
    });
  }

  if (template.watermarkAssetId != null) {
    tl = addCta(tl, {
      variant: "image",
      assetId: template.watermarkAssetId,
      position: "top-right",
      start: 0,
      end: totalDuration(tl),
      animIn: "none",
      animOut: "none",
      style: { fontSize: 0.06 },
    });
  }
  return tl;
}

/**
 * Apply `template` to a clip's edit `state`, returning a new blob. Overwrites the
 * caption style, aspect ratio, CTA overlays, and watermark; preserves segments,
 * trims, transitions, SFX, audio, and manual-locked crop keyframes. Records an
 * undo snapshot so {@link undoTemplate} can restore the exact previous blob.
 *
 * Pure: `state` is never mutated (new objects throughout). When the clip has no
 * timeline yet, CTA placement is skipped (there is no playback clock to clamp
 * to) but caption style and AR are still imposed.
 */
export function applyTemplate(state: ClipEditState, template: Template): ClipEditState {
  const snapshot = JSON.stringify(state);

  let next: ClipEditState = { ...state };

  // Caption style — replace on the existing doc (keep its cues), or seed a
  // style-only doc when the clip has none yet.
  const style = resolveStyle({ preset: template.captionPreset, ...template.captionStyle });
  style.highlightColor = template.brandPrimary; // brand primary drives highlight
  const existingCaptions = readCaptionDoc(state);
  const nextCaptions: CaptionDoc = existingCaptions
    ? { ...existingCaptions, style, name: template.captionPreset }
    : { cues: [], style, name: template.captionPreset };
  next.captions = nextCaptions;

  // Aspect ratio — replace on the crop, preserving locked (manual) keyframes;
  // drop keyframes sized for a different AR so smart-crop re-derives them.
  const crop = readCropState(state);
  if (crop) {
    const keepKeyframes = crop.locked || crop.aspectRatio === template.aspectRatio;
    next = withCropState(next, {
      ...crop,
      aspectRatio: template.aspectRatio,
      keyframes: keepKeyframes ? crop.keyframes : [],
    });
  } else {
    // No crop yet: record the target AR so the smart-crop enqueue has a target.
    next = withCropState(next, buildCropState(template.aspectRatio, [], 0, 0, false));
  }

  // CTA overlays + watermark — only when there is a timeline to place them on.
  const timeline = readTimelineDoc(state);
  if (timeline) {
    next = withTimelineDoc(next, applyCtas(timeline, template));
  }

  next[TEMPLATE_ID_KEY] = template.id;
  next[UNDO_KEY] = snapshot;
  return next;
}

/**
 * Restore the blob captured by the last {@link applyTemplate}, or `null` when no
 * undo snapshot is present (or it is corrupt). Returns the exact previous blob
 * — including whatever `templateUndo`/`templateId` it carried — so a chain of
 * applies can be unwound one step at a time.
 */
export function undoTemplate(state: ClipEditState): ClipEditState | null {
  const undo = state[UNDO_KEY];
  if (typeof undo !== "string") return null;
  try {
    const parsed = JSON.parse(undo);
    return typeof parsed === "object" && parsed !== null ? (parsed as ClipEditState) : null;
  } catch {
    return null;
  }
}

/** Whether a blob currently carries an undoable template application. */
export function hasTemplateUndo(state: ClipEditState): boolean {
  return typeof state[UNDO_KEY] === "string";
}

/**
 * Read a clip's current look back out into a {@link TemplateInput}, for
 * "save as template". Captures the caption style (complete, so a round-trip
 * reproduces it exactly), aspect ratio, and CTA overlays; brand primary tracks
 * the caption highlight so the invariant `highlightColor === brandPrimary` holds
 * through save→apply. `name` is supplied by the caller (the save dialog).
 */
export function saveAsTemplate(state: ClipEditState, name: string): TemplateInput {
  const captions = readCaptionDoc(state);
  const style = captions ? resolveStyle(captions.style) : resolveStyle(undefined);
  const preset =
    captions && typeof captions.name === "string" ? captions.name : DEFAULT_CAPTION_PRESET;
  const captionPreset = (
    ["bold-pop", "clean-sub", "minimal-caps", "boxed"] as const
  ).includes(preset as never)
    ? (preset as TemplateInput["captionPreset"])
    : DEFAULT_CAPTION_PRESET;

  const crop = readCropState(state);
  const aspectRatio: AspectRatio = crop ? crop.aspectRatio : "9:16";

  const timeline = readTimelineDoc(state);
  const ctas: TemplateCta[] = timeline
    ? listCta(timeline).map((c) => ({
        variant: c.variant,
        content: c.content,
        assetId: c.assetId,
        position: c.position,
        offset: c.offset,
        start: c.start,
        end: c.end,
        animIn: c.animIn,
        animOut: c.animOut,
        fontSize: c.style.fontSize,
      }))
    : [];

  return {
    key: null,
    name: name.trim() !== "" ? name.trim() : "Untitled template",
    captionPreset,
    // highlight is the brand primary (invariant kept by parseTemplateInput too).
    captionStyle: { ...style, highlightColor: style.highlightColor },
    aspectRatio,
    ctas,
    brandPrimary: style.highlightColor,
    brandSecondary: "#000000",
    watermarkAssetId: null,
  };
}
