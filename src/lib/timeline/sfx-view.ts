/**
 * Pure presentation logic for the Phase-08 SFX (sound-effect) WebAudio preview.
 *
 * React- and Node-free by design (DEC-005, mirroring `broll-view.ts` /
 * `cta-view.ts`): the thin `<SfxPreview>` / `<SfxPanel>` components only wire
 * these decisions to WebAudio and the DOM and the pure ops in {@link ./sfx}.
 * The one piece of arithmetic — turning cues on the timeline into a play-relative
 * schedule (which cues fire, how long after playback starts, at what gain) — lives
 * here where it is unit-tested apart from the `AudioContext` plumbing.
 */

import { assetFileUrl } from "./broll-view";
import { listSfx } from "./sfx";
import type { TimelineDoc } from "./types";

/** The route that streams an SFX audio asset's raw bytes (shared with B-roll):
 * the preview fetches this once per asset and decodes it into an `AudioBuffer`. */
export { assetFileUrl as sfxAssetUrl };

/** One cue resolved for playback: fire `assetId` `offset` seconds after playback
 * starts, at linear `gain`. `duckMain` is carried through for parity with
 * `renderPlan` (the ground truth); the preview does not attenuate the main track,
 * since a one-shot cue has no modelled duration to duck over. */
export interface ScheduledSfx {
  id: string;
  assetId: number;
  offset: number;
  gain: number;
  duckMain: boolean;
}

/**
 * The SFX cues to schedule when preview playback starts from timeline second
 * `fromT`, in fire order. Only cues at or after `fromT` are included (a cue whose
 * time has already passed is not replayed); each cue's `offset` is how long after
 * the start moment it should sound. `listSfx` already sorts by time, so the result
 * is ordered by `offset`.
 */
export function sfxSchedule(doc: TimelineDoc, fromT: number): ScheduledSfx[] {
  return listSfx(doc)
    .filter((cue) => cue.t >= fromT)
    .map((cue) => ({
      id: cue.id,
      assetId: cue.assetId,
      offset: cue.t - fromT,
      gain: cue.volume,
      duckMain: cue.duckMain,
    }));
}
