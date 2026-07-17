import { decodePcmMono } from "../ffmpeg/pcm";
import { detectSceneChanges } from "../ffmpeg/scenes";
import { rmsPerWindow } from "./signals";

/**
 * Sample rate the energy series is computed at. Speech energy is a coarse,
 * low-frequency signal — 16 kHz is ample and matches the WAV the transcription
 * step already produces, so a 16 kHz mono WAV is decoded without resampling.
 */
export const ENERGY_SAMPLE_RATE = 16_000;

/** One energy value per second of audio (SPEC.md § Highlight scoring). */
export const ENERGY_WINDOW_SEC = 1;

/**
 * Audio RMS energy of `wavPath`, one value per 1 s window (SPEC.md § Highlight
 * scoring — "audio RMS energy peaks"). Index `i` is the energy of the audio in
 * `[i, i+1)` seconds, so the array aligns 1:1 with transcript timestamps.
 *
 * Accepts any file ffmpeg can decode, not only a 16 kHz mono WAV, because the
 * decode step downmixes and resamples anyway; the name reflects its normal
 * caller (the transcription WAV) rather than a hard requirement.
 */
export async function audioEnergy(wavPath: string): Promise<number[]> {
  const samples = await decodePcmMono(wavPath, ENERGY_SAMPLE_RATE);
  return rmsPerWindow(samples, ENERGY_SAMPLE_RATE, ENERGY_WINDOW_SEC);
}

/**
 * Scene-change timestamps (seconds, ascending) in `videoPath` — the boundaries
 * `snapBoundaries` prefers to land a clip edge on. Thin pass-through to the
 * ffmpeg detector so highlight code imports one module for both extractors.
 */
export async function sceneChanges(videoPath: string, threshold?: number): Promise<number[]> {
  return detectSceneChanges(videoPath, threshold);
}
