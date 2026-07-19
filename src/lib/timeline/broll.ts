/**
 * B-roll overlay slots (Phase 08). A B-roll slot plays a second video asset
 * over the main timeline for a bounded range, either as a floating
 * picture-in-picture box (`pip`) or replacing the main video image while the
 * main audio keeps playing (`full`). Slots live on the shared
 * {@link TimelineDoc.overlayTrack} (Phase 07 left it an open blob array so a
 * Phase-08 payload survives a Phase-07 op untouched); they are discriminated
 * from CTA overlays by `kind: "broll"`.
 *
 * Everything here is pure `(doc, args) → doc`, mirroring `ops.ts`: the editor's
 * React layer holds the resulting docs on the undo stack and never does the
 * range/geometry arithmetic itself. `renderPlan` (Phase 08 crux) and the
 * preview both read slots back with {@link listBroll}.
 */

import { totalDuration } from "./ops";
import { assertValidDoc } from "./state";
import { TimelineError, type TimelineDoc, type TimelineOverlay } from "./types";

/** Placement of a `pip` B-roll box, in normalised frame units (0 = left/top,
 * 1 = right/bottom). `x`/`y` are the box's top-left corner; `scale` is the
 * box's side length as a fraction of the frame. `full` slots ignore geometry
 * but keep it so a mode switch is reversible. */
export interface BrollPip {
  x: number;
  y: number;
  scale: number;
}

/** `pip` = floating box (position + scale); `full` = B-roll image replaces the
 * main video, main audio continues (SPEC.md Phase 08). */
export type BrollMode = "pip" | "full";

/** The two accepted modes, for picker UIs and validation. */
export const BROLL_MODES: readonly BrollMode[] = ["pip", "full"] as const;

/** One B-roll slot on the overlay track. `start`/`end` are TIMELINE seconds
 * (edited-playback clock), so a slot follows the edited sequence, not raw
 * source time. */
export interface BrollSlot extends TimelineOverlay {
  id: string;
  kind: "broll";
  /** Row id of the source asset in the `assets` table (a B-roll video). */
  assetId: number;
  /** Slot start in timeline seconds (`>= 0`). */
  start: number;
  /** Slot end in timeline seconds (`> start`, `<= totalDuration`). */
  end: number;
  mode: BrollMode;
  /** Geometry for `pip` mode; retained (unused) in `full`. */
  pip: BrollPip;
}

/** Shortest a B-roll slot may be (seconds). Small but non-zero so a slot always
 * occupies a real, clampable range even on a very short clip. */
export const MIN_BROLL_DURATION = 0.05;

/** Smallest allowed pip box side (fraction of frame) — below this the box is
 * invisible; above 1 it would exceed the frame. */
export const MIN_PIP_SCALE = 0.05;
export const MAX_PIP_SCALE = 1;

/** Default pip placement: a ~third-frame box tucked into the top-right corner. */
export const DEFAULT_PIP: BrollPip = { x: 0.62, y: 0.05, scale: 0.33 };

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** True when `value` is a well-formed B-roll slot (used to filter the mixed
 * overlay track, which may also hold CTA blobs). */
export function isBrollSlot(value: unknown): value is BrollSlot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === "broll" &&
    typeof v.id === "string" &&
    isFiniteNumber(v.assetId) &&
    isFiniteNumber(v.start) &&
    isFiniteNumber(v.end) &&
    (v.mode === "pip" || v.mode === "full") &&
    typeof v.pip === "object" &&
    v.pip !== null
  );
}

/** Clamp a pip box so it stays fully inside the frame: `scale` into
 * `[MIN_PIP_SCALE, MAX_PIP_SCALE]`, then `x`/`y` so the box's far edge never
 * crosses 1. A non-finite field falls back to the default. */
export function clampPip(pip: Partial<BrollPip> | undefined): BrollPip {
  const scale = clamp(
    isFiniteNumber(pip?.scale) ? (pip!.scale as number) : DEFAULT_PIP.scale,
    MIN_PIP_SCALE,
    MAX_PIP_SCALE,
  );
  const x = clamp(isFiniteNumber(pip?.x) ? (pip!.x as number) : DEFAULT_PIP.x, 0, 1 - scale);
  const y = clamp(isFiniteNumber(pip?.y) ? (pip!.y as number) : DEFAULT_PIP.y, 0, 1 - scale);
  return { x, y, scale };
}

/** Clamp a `[start, end]` range to the timeline: both into `[0, total]`, with a
 * {@link MIN_BROLL_DURATION} gap enforced by pushing whichever edge was given
 * more freedom. On a timeline shorter than the minimum the whole span is used. */
export function clampBrollRange(
  doc: TimelineDoc,
  start: number,
  end: number,
): { start: number; end: number } {
  const total = totalDuration(doc);
  if (!isFiniteNumber(start) || !isFiniteNumber(end)) {
    throw new TimelineError("B-roll range must be finite numbers");
  }
  if (total <= MIN_BROLL_DURATION) return { start: 0, end: total };
  const s = clamp(start, 0, total - MIN_BROLL_DURATION);
  const e = clamp(end, s + MIN_BROLL_DURATION, total);
  return { start: s, end: e };
}

/** All valid B-roll slots on the overlay track, in track order. */
export function listBroll(doc: TimelineDoc): BrollSlot[] {
  return doc.overlayTrack.filter(isBrollSlot);
}

/** Arguments to {@link addBroll}. `mode` defaults to `pip`; `end` defaults to a
 * {@link MIN_BROLL_DURATION}-plus slot from `start`. */
export interface AddBrollArgs {
  assetId: number;
  start: number;
  end?: number;
  mode?: BrollMode;
  pip?: Partial<BrollPip>;
}

/** Insert a B-roll slot, clamping its range to the timeline and its pip box to
 * the frame. Gets a fresh deterministic id from `doc.seq` (shared with segment
 * ids but prefixed `ov-`, so pure — no `Math.random`). */
export function addBroll(doc: TimelineDoc, args: AddBrollArgs): TimelineDoc {
  if (!isFiniteNumber(args.assetId) || args.assetId <= 0) {
    throw new TimelineError("B-roll assetId must be a positive number");
  }
  const mode: BrollMode = args.mode === "full" ? "full" : "pip";
  const end = isFiniteNumber(args.end) ? args.end : args.start + MIN_BROLL_DURATION;
  const range = clampBrollRange(doc, args.start, end);
  const seq = doc.seq + 1;
  const slot: BrollSlot = {
    id: `ov-${seq}`,
    kind: "broll",
    assetId: args.assetId,
    start: range.start,
    end: range.end,
    mode,
    pip: clampPip(args.pip),
  };
  return assertValidDoc({ ...doc, overlayTrack: [...doc.overlayTrack, slot], seq });
}

/** Patch accepted by {@link updateBroll}: move/resize the range, switch mode,
 * reposition/resize the pip box, or repoint the asset. */
export interface UpdateBrollPatch {
  assetId?: number;
  start?: number;
  end?: number;
  mode?: BrollMode;
  pip?: Partial<BrollPip>;
}

/** Update one B-roll slot in place (identity/order preserved), re-clamping the
 * range and pip geometry so an out-of-frame drag or over-long resize can never
 * be persisted. Unknown id (or an overlay that is not a B-roll slot) throws. */
export function updateBroll(doc: TimelineDoc, id: string, patch: UpdateBrollPatch): TimelineDoc {
  const index = doc.overlayTrack.findIndex((o) => o.id === id && isBrollSlot(o));
  if (index === -1) throw new TimelineError(`No B-roll slot ${id} on the overlay track`);
  const current = doc.overlayTrack[index] as BrollSlot;

  if (patch.assetId !== undefined && (!isFiniteNumber(patch.assetId) || patch.assetId <= 0)) {
    throw new TimelineError("B-roll assetId must be a positive number");
  }
  const nextStart = patch.start !== undefined ? patch.start : current.start;
  const nextEnd = patch.end !== undefined ? patch.end : current.end;
  const range = clampBrollRange(doc, nextStart, nextEnd);
  const mode: BrollMode =
    patch.mode === "pip" || patch.mode === "full" ? patch.mode : current.mode;
  const pip = patch.pip !== undefined ? clampPip({ ...current.pip, ...patch.pip }) : current.pip;

  const updated: BrollSlot = {
    ...current,
    assetId: patch.assetId ?? current.assetId,
    start: range.start,
    end: range.end,
    mode,
    pip,
  };
  const overlayTrack = doc.overlayTrack.map((o, i) => (i === index ? updated : o));
  return assertValidDoc({ ...doc, overlayTrack });
}

/** Remove a B-roll slot by id. Unknown id (or a non-B-roll overlay) throws, so
 * a stale UI reference surfaces rather than silently no-op'ing. */
export function removeBroll(doc: TimelineDoc, id: string): TimelineDoc {
  const exists = doc.overlayTrack.some((o) => o.id === id && isBrollSlot(o));
  if (!exists) throw new TimelineError(`No B-roll slot ${id} on the overlay track`);
  const overlayTrack = doc.overlayTrack.filter((o) => o.id !== id);
  return assertValidDoc({ ...doc, overlayTrack });
}
