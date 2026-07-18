import {
  ASPECT_RATIOS,
  type AspectRatio,
  type CropKeyframe,
} from "./types";

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
