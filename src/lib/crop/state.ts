import {
  ASPECT_RATIOS,
  type AspectRatio,
  type CropKeyframe,
} from "./types";

/**
 * A single manual crop override, as sent by `PATCH /api/clips/:id/crop` when a
 * user drags the crop rectangle in the editor: one keyframe (source pixels) to
 * write at its time `t`, and — for the case where the clip has no auto crop yet —
 * the target aspect ratio to anchor it to.
 */
export interface CropOverride {
  /** The manual keyframe to upsert into the crop's keyframe list. */
  keyframe: CropKeyframe;
  /**
   * Target aspect ratio. Required when the clip has no existing crop (there is
   * nothing to inherit from); optional otherwise. Supplying an AR that differs
   * from the existing crop's re-anchors the plan to the new ratio, discarding
   * keyframes sized for the old window.
   */
  aspectRatio?: AspectRatio;
}

/** Thrown by {@link parseCropOverride}/{@link applyCropOverride} on bad input. */
export class CropOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CropOverrideError";
  }
}

/**
 * The crop portion of a clip's `clip_edits.state` blob (SPEC.md § Smart crop:
 * "result stored in `clip_edits.crop` — keyframes + chosen AR"). Written by the
 * smart-crop job and the crop API, read by `cropFilter` at export time and by the
 * editor overlay.
 *
 * `srcWidth`/`srcHeight` travel with the keyframes because those keyframes are in
 * SOURCE PIXELS (see {@link CropKeyframe}); a consumer needs the source size to
 * turn them back into normalised overlay positions without re-reading the project
 * row. `locked` records that a human overrode the crop by hand, so the auto job
 * leaves it alone — see {@link CropState.locked}.
 */
export interface CropState {
  /** Chosen reframe target, stored verbatim so it round-trips through JSON. */
  aspectRatio: AspectRatio;
  /** Crop-window keyframes in source pixels, ascending by `t` (clip-relative). */
  keyframes: CropKeyframe[];
  /** Source video width in pixels (the space `keyframes` live in). */
  srcWidth: number;
  /** Source video height in pixels. */
  srcHeight: number;
  /**
   * True once a user manually overrode the crop. The smart-crop job refuses to
   * overwrite a locked crop, so "re-run auto" cannot clobber a hand-tuned
   * override (phase-06 acceptance: "survives re-run auto only when flagged
   * `locked: true`"). Auto-generated crops are always `false`.
   */
  locked: boolean;
}

function isAspectRatio(value: unknown): value is AspectRatio {
  return typeof value === "string" && (ASPECT_RATIOS as readonly string[]).includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isKeyframe(value: unknown): value is CropKeyframe {
  if (typeof value !== "object" || value === null) return false;
  const kf = value as Record<string, unknown>;
  return (
    isFiniteNumber(kf.t) &&
    isFiniteNumber(kf.x) &&
    isFiniteNumber(kf.y) &&
    isFiniteNumber(kf.w) &&
    isFiniteNumber(kf.h)
  );
}

/**
 * Assemble a {@link CropState} from a finished plan. A tiny constructor rather
 * than an object literal at each call site so the `locked` default (`false` for
 * anything the auto job produced) lives in one place.
 */
export function buildCropState(
  aspectRatio: AspectRatio,
  keyframes: CropKeyframe[],
  srcWidth: number,
  srcHeight: number,
  locked = false,
): CropState {
  return { aspectRatio, keyframes, srcWidth, srcHeight, locked };
}

/**
 * Read a crop state back out of a parsed `clip_edits.state` blob, or `null` when
 * it is absent or malformed. This is our own persisted data, not a client body,
 * so the guard is light — enough to reject a half-written or hand-corrupted blob
 * rather than let a bad shape flow into `cropFilter` and surface far away as an
 * invalid filtergraph. Mirrors `readCaptionDoc` for the caption half of the blob.
 */
export function readCropState(state: unknown): CropState | null {
  if (typeof state !== "object" || state === null) return null;
  const crop = (state as Record<string, unknown>).crop;
  if (typeof crop !== "object" || crop === null) return null;
  const c = crop as Record<string, unknown>;
  if (!isAspectRatio(c.aspectRatio)) return null;
  if (!Array.isArray(c.keyframes) || !c.keyframes.every(isKeyframe)) return null;
  if (!isFiniteNumber(c.srcWidth) || !isFiniteNumber(c.srcHeight)) return null;
  return {
    aspectRatio: c.aspectRatio,
    keyframes: c.keyframes as CropKeyframe[],
    srcWidth: c.srcWidth,
    srcHeight: c.srcHeight,
    // Older/partial blobs may predate the flag; absent means "not locked".
    locked: c.locked === true,
  };
}

/**
 * Merge a crop state into a (possibly empty) parsed state blob, returning a new
 * object so the caller can serialise it. Only the `crop` key is touched — a
 * clip's captions/timeline in the same blob are preserved untouched, exactly as
 * the caption route preserves `crop` when it writes `captions`.
 */
export function withCropState(
  state: Record<string, unknown>,
  crop: CropState,
): Record<string, unknown> {
  return { ...state, crop };
}

/**
 * Validate an untrusted `PATCH /api/clips/:id/crop` body into a {@link CropOverride}.
 * A manual override is a client body, so the guard is strict (unlike the light
 * `readCropState` guard for our own persisted blobs): every keyframe field must be
 * a finite number and `aspectRatio`, when present, must be a known ratio. Throws
 * {@link CropOverrideError} so the route can turn it into a single 400.
 */
export function parseCropOverride(raw: unknown): CropOverride {
  if (typeof raw !== "object" || raw === null) {
    throw new CropOverrideError("Body must be an object with a { keyframe } field");
  }
  const obj = raw as Record<string, unknown>;
  const kf = obj.keyframe;
  if (typeof kf !== "object" || kf === null) {
    throw new CropOverrideError("keyframe must be an object { t, x, y, w, h }");
  }
  const k = kf as Record<string, unknown>;
  for (const field of ["t", "x", "y", "w", "h"] as const) {
    if (!isFiniteNumber(k[field])) {
      throw new CropOverrideError(`keyframe.${field} must be a finite number`);
    }
  }
  if ((k.w as number) <= 0 || (k.h as number) <= 0) {
    throw new CropOverrideError("keyframe.w and keyframe.h must be positive");
  }
  if ((k.t as number) < 0) {
    throw new CropOverrideError("keyframe.t must be at or after the clip start (>= 0)");
  }
  const keyframe: CropKeyframe = {
    t: k.t as number,
    x: k.x as number,
    y: k.y as number,
    w: k.w as number,
    h: k.h as number,
  };

  let aspectRatio: AspectRatio | undefined;
  if (obj.aspectRatio !== undefined) {
    if (!isAspectRatio(obj.aspectRatio)) {
      throw new CropOverrideError(
        `aspectRatio must be one of ${ASPECT_RATIOS.join(", ")} when present`,
      );
    }
    aspectRatio = obj.aspectRatio;
  }

  return { keyframe, aspectRatio };
}

/**
 * Insert or replace a keyframe by its time `t`, returning a new list sorted
 * ascending by `t`. A drag at a time that already has a keyframe replaces it (the
 * user is re-positioning that moment); a drag at a new time inserts, so overriding
 * one moment leaves the rest of an auto plan intact.
 */
function upsertKeyframe(keyframes: CropKeyframe[], kf: CropKeyframe): CropKeyframe[] {
  const kept = keyframes.filter((existing) => existing.t !== kf.t);
  kept.push(kf);
  kept.sort((a, b) => a.t - b.t);
  return kept;
}

/**
 * Apply a manual {@link CropOverride} to a clip's current crop state, producing a
 * new `locked` {@link CropState}. Locking is the whole point of a manual edit: a
 * locked crop is skipped by the smart-crop job, so "re-run auto" cannot clobber a
 * hand-tuned override (phase-06 acceptance: "survives re-run auto only when
 * flagged `locked: true`").
 *
 * When the clip already has a crop and the override keeps (or omits) its aspect
 * ratio, the keyframe is merged into the existing plan. When there is no crop yet,
 * or the override switches aspect ratio, the plan is re-anchored to just this
 * keyframe — the old keyframes were sized for a different window. Source
 * dimensions come from the existing crop, or `fallback` (the project's ingested
 * size) for a first override.
 */
export function applyCropOverride(
  existing: CropState | null,
  override: CropOverride,
  fallback: { srcWidth: number; srcHeight: number },
): CropState {
  const aspectRatio = override.aspectRatio ?? existing?.aspectRatio;
  if (!aspectRatio) {
    throw new CropOverrideError(
      "aspectRatio is required for the first crop override (no auto crop exists yet)",
    );
  }

  const srcWidth = existing?.srcWidth ?? fallback.srcWidth;
  const srcHeight = existing?.srcHeight ?? fallback.srcHeight;
  if (!isFiniteNumber(srcWidth) || !isFiniteNumber(srcHeight) || srcWidth <= 0 || srcHeight <= 0) {
    throw new CropOverrideError(
      "Cannot place a crop override without known source dimensions (project not ingested yet)",
    );
  }

  // Keep the existing keyframes only when the override stays on the same aspect
  // ratio; a ratio switch means the old window size no longer applies.
  const sameRatio = existing !== null && aspectRatio === existing.aspectRatio;
  const base = sameRatio ? existing.keyframes : [];
  const keyframes = upsertKeyframe(base, override.keyframe);

  return buildCropState(aspectRatio, keyframes, srcWidth, srcHeight, true);
}
