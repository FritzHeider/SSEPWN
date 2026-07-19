/**
 * Build the audio half of a render filtergraph (SPEC.md § Export, phase-10):
 * the main track's volume/mute, one-shot SFX cues mixed in via `adelay` + `amix`,
 * optional sidechain ducking of the main under those cues, and a final EBU R128
 * loudness normalise to the platform's −14 LUFS target.
 *
 * PURE — assembles filtergraph strings only (no ffmpeg call, no IO) so tests can
 * assert the graph. The video half lives in {@link buildRenderArgs}; this module
 * owns everything from the concatenated audio spine to the muxed `outLabel`.
 */

import type { AudioNode, SfxNode } from "./plan";

/** EBU R128 loudness target for delivery: integrated −14 LUFS, −1.5 dBTP ceiling,
 * 11 LU range — the value platforms (TikTok/Reels/Shorts) normalise toward. */
const LOUDNORM = "loudnorm=I=-14:TP=-1.5:LRA=11";

/** Common sample format for every audio branch so `amix`/`sidechaincompress`
 * inputs agree without relying on implicit resample negotiation. */
const AFORMAT = "aformat=sample_rates=48000:channel_layouts=stereo";

/** Sidechain-compressor knobs used to duck the main track under an SFX cue: a low
 * threshold + high ratio so the dip is clearly audible/measurable, with a short
 * attack and a longer release so the main recovers smoothly after the cue. */
const DUCK = "sidechaincompress=threshold=0.03:ratio=12:attack=20:release=300";

/** Everything {@link buildAudioGraph} needs to emit the audio chain. */
export interface AudioGraphInput {
  /** Bare label of the concatenated main-audio spine (no brackets). */
  aSpine: string;
  /** The plan's main {@link AudioNode} (clip volume + mute). */
  audio: AudioNode;
  /** SFX cues to schedule, in plan order (may be empty). */
  sfx: SfxNode[];
  /** ffmpeg `-i` index for each media input id (asset SFX resolve via this). */
  inputIndex: Map<string, number>;
  /** Apply the −14 LUFS loudness normalise as the final step. Tests measuring raw
   * ducking set this `false` so the normaliser doesn't compensate the dip (DEC). */
  loudnorm: boolean;
  /** Bare label the final muxed audio stream must carry (e.g. `aout`). */
  outLabel: string;
}

/**
 * Emit the audio filtergraph fragments. Main audio gets its gain and a common
 * format; each SFX cue is gain-adjusted and delayed to its timeline time; ducking
 * cues also drive a sidechain compressor on the main; everything mixes with
 * `duration=first` so an SFX never lengthens the export; then loudnorm (optional).
 */
export function buildAudioGraph(input: AudioGraphInput): string[] {
  const { aSpine, audio, sfx, inputIndex, loudnorm, outLabel } = input;
  const parts: string[] = [];
  const gain = audio.muted ? 0 : audio.volume;

  // Main audio: clip volume, normalised to the common format the mix expects.
  let main = "amain";
  parts.push(`[${aSpine}]volume=${gain},${AFORMAT}[${main}]`);

  // Each SFX: gain + delay to its start time. A ducking cue is split so the same
  // stream both mixes into the output and drives the compressor's sidechain.
  const mixLabels: string[] = [];
  const duckLabels: string[] = [];
  sfx.forEach((cue, k) => {
    const assetId = cue.inputs[0];
    const idx = inputIndex.get(assetId);
    if (idx === undefined) throw new Error(`sfx ${cue.id} references unknown input ${assetId}`);
    const delayMs = Math.max(0, Math.round(cue.t * 1000));
    const chain = `[${idx}:a]volume=${cue.volume},${AFORMAT},adelay=${delayMs}:all=1`;
    if (cue.duckMain) {
      parts.push(`${chain},asplit=2[sfxm${k}][sfxd${k}]`);
      duckLabels.push(`sfxd${k}`);
    } else {
      parts.push(`${chain}[sfxm${k}]`);
    }
    mixLabels.push(`sfxm${k}`);
  });

  // Sidechain ducking: compress the main under the summed ducking-cue trigger, so
  // it dips exactly while those cues sound (their length need not be known).
  if (duckLabels.length > 0) {
    let trigger: string;
    if (duckLabels.length === 1) {
      trigger = duckLabels[0];
    } else {
      parts.push(
        `${duckLabels.map((l) => `[${l}]`).join("")}` +
          `amix=inputs=${duckLabels.length}:duration=longest:normalize=0[sfxduck]`,
      );
      trigger = "sfxduck";
    }
    parts.push(`[${main}][${trigger}]${DUCK}[amaind]`);
    main = "amaind";
  }

  // Mix main + every SFX. duration=first pins the length to the main track (an SFX
  // near the end is truncated, never extends the export); normalize=0 preserves
  // levels — loudnorm scales the sum afterwards.
  if (mixLabels.length > 0) {
    const inputs = 1 + mixLabels.length;
    parts.push(
      `[${main}]${mixLabels.map((l) => `[${l}]`).join("")}` +
        `amix=inputs=${inputs}:duration=first:normalize=0:dropout_transition=0[amix]`,
    );
    main = "amix";
  }

  // Loudness normalise to −14 LUFS (delivery target), unless a caller disabled it.
  parts.push(loudnorm ? `[${main}]${LOUDNORM}[${outLabel}]` : `[${main}]anull[${outLabel}]`);
  return parts;
}
