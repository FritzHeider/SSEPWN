/**
 * Sound-effect (SFX) cues (Phase 08). A cue plays a one-shot audio asset at a
 * point on the edited timeline: `{ assetId, t, volume, duckMain }`. Unlike a
 * B-roll slot a cue has no explicit end — its length is the asset's own
 * duration — so only its start time `t` is modelled; the WebAudio preview and
 * `renderPlan` (Phase 08 crux) read cues back with {@link listSfx} and schedule
 * each asset from `t`.
 *
 * Cues live on their own {@link TimelineDoc.sfxTrack} (separate from the visual
 * `overlayTrack`). Everything here is pure `(doc, args) → doc`, mirroring
 * `ops.ts`/`broll.ts`/`transitions.ts`: the editor's React layer holds the
 * resulting docs on the undo stack and never does the time/volume arithmetic
 * itself. `t` is always clamped into the timeline and `volume` into its band, so
 * an out-of-range placement can never be persisted.
 */

import { totalDuration } from "./ops";
import { assertValidDoc } from "./state";
import {
  DEFAULT_SFX_VOLUME,
  SFX_MAX_VOLUME,
  TimelineError,
  type SfxCue,
  type TimelineDoc,
} from "./types";

export { DEFAULT_SFX_VOLUME, SFX_MAX_VOLUME, type SfxCue } from "./types";

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** True when `value` is a well-formed SFX cue (used by the read guard/tests). */
export function isSfxCue(value: unknown): value is SfxCue {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    isFiniteNumber(v.assetId) &&
    isFiniteNumber(v.t) &&
    isFiniteNumber(v.volume) &&
    typeof v.duckMain === "boolean"
  );
}

/** Clamp a placement time into the timeline `[0, totalDuration]`. Throws on a
 * non-finite input so a bad drag surfaces at its source. */
export function clampSfxTime(doc: TimelineDoc, t: number): number {
  if (!isFiniteNumber(t)) throw new TimelineError("SFX time must be a finite number");
  return clamp(t, 0, totalDuration(doc));
}

/** Clamp a gain into `[0, SFX_MAX_VOLUME]`, falling back to
 * {@link DEFAULT_SFX_VOLUME} for a non-finite input. */
export function clampSfxVolume(volume: number | undefined): number {
  if (!isFiniteNumber(volume)) return DEFAULT_SFX_VOLUME;
  return clamp(volume, 0, SFX_MAX_VOLUME);
}

/** All SFX cues, in timeline order (sorted by `t`, then id for stability). */
export function listSfx(doc: TimelineDoc): SfxCue[] {
  return [...doc.sfxTrack]
    .filter(isSfxCue)
    .sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Arguments to {@link addSfx}. `volume` defaults to {@link DEFAULT_SFX_VOLUME},
 * `duckMain` to `false`. */
export interface AddSfxArgs {
  assetId: number;
  t: number;
  volume?: number;
  duckMain?: boolean;
}

/** Place a new SFX cue, clamping its time to the timeline and its volume to the
 * allowed band. Gets a fresh deterministic id from `doc.seq` (shared counter,
 * prefixed `sfx-`, so pure — no `Math.random`). */
export function addSfx(doc: TimelineDoc, args: AddSfxArgs): TimelineDoc {
  if (!isFiniteNumber(args.assetId) || args.assetId <= 0) {
    throw new TimelineError("SFX assetId must be a positive number");
  }
  const seq = doc.seq + 1;
  const cue: SfxCue = {
    id: `sfx-${seq}`,
    assetId: args.assetId,
    t: clampSfxTime(doc, args.t),
    volume: clampSfxVolume(args.volume),
    duckMain: args.duckMain === true,
  };
  return assertValidDoc({ ...doc, sfxTrack: [...doc.sfxTrack, cue], seq });
}

/** Patch accepted by {@link updateSfx}: nudge the time, set the volume, toggle
 * ducking, or repoint the asset. */
export interface UpdateSfxPatch {
  assetId?: number;
  t?: number;
  volume?: number;
  duckMain?: boolean;
}

/** Update one SFX cue in place (identity/order preserved), re-clamping time and
 * volume. Unknown id throws so a stale UI reference surfaces rather than silently
 * no-op'ing. */
export function updateSfx(doc: TimelineDoc, id: string, patch: UpdateSfxPatch): TimelineDoc {
  const index = doc.sfxTrack.findIndex((c) => c.id === id && isSfxCue(c));
  if (index === -1) throw new TimelineError(`No SFX cue ${id} on the SFX track`);
  const current = doc.sfxTrack[index];

  if (patch.assetId !== undefined && (!isFiniteNumber(patch.assetId) || patch.assetId <= 0)) {
    throw new TimelineError("SFX assetId must be a positive number");
  }
  const updated: SfxCue = {
    ...current,
    assetId: patch.assetId ?? current.assetId,
    t: patch.t !== undefined ? clampSfxTime(doc, patch.t) : current.t,
    volume: patch.volume !== undefined ? clampSfxVolume(patch.volume) : current.volume,
    duckMain: patch.duckMain !== undefined ? patch.duckMain === true : current.duckMain,
  };
  const sfxTrack = doc.sfxTrack.map((c, i) => (i === index ? updated : c));
  return assertValidDoc({ ...doc, sfxTrack });
}

/** Remove an SFX cue by id. Unknown id throws, so a stale UI reference surfaces
 * rather than silently no-op'ing. */
export function removeSfx(doc: TimelineDoc, id: string): TimelineDoc {
  const exists = doc.sfxTrack.some((c) => c.id === id);
  if (!exists) throw new TimelineError(`No SFX cue ${id} on the SFX track`);
  const sfxTrack = doc.sfxTrack.filter((c) => c.id !== id);
  return assertValidDoc({ ...doc, sfxTrack });
}
