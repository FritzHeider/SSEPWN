import { mkdir } from "node:fs/promises";
import path from "node:path";

import { runFfmpeg } from "./exec";

/** whisper.cpp only accepts 16 kHz mono PCM; anything else it refuses outright. */
export const WHISPER_SAMPLE_RATE = 16_000;
export const WHISPER_CHANNELS = 1;

/**
 * Extract the audio track of `sourcePath` as a 16 kHz mono 16-bit PCM WAV.
 *
 * The resampling is not cosmetic: whisper.cpp rejects any other rate/layout, so
 * `-ar`/`-ac` are load-bearing rather than a normalisation nicety. `-vn` drops
 * the video stream so a 90-minute source does not get re-encoded frame by frame.
 *
 * Rejects with execa's error (including ffmpeg's stderr) if the source has no
 * audio track or cannot be decoded.
 */
export async function extractWav(sourcePath: string, destPath: string): Promise<string> {
  await mkdir(path.dirname(destPath), { recursive: true });

  await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    sourcePath,
    "-vn",
    "-ac",
    String(WHISPER_CHANNELS),
    "-ar",
    String(WHISPER_SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
    "-y",
    destPath,
  ]);

  return destPath;
}
