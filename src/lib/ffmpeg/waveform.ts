import { mkdir } from "node:fs/promises";
import path from "node:path";

import { runFfmpeg } from "./exec";

/** Default waveform image size — wide and short, a scrubber-strip aspect. */
export const WAVEFORM_WIDTH = 4096;
export const WAVEFORM_HEIGHT = 128;

export interface WaveformOptions {
  width?: number;
  height?: number;
}

/**
 * Render a single audio-waveform PNG for a media file with ffmpeg's
 * `showwavespic` (phase-BE task 5). One channel (the source downmixed to mono so
 * a stereo track draws one strip, not two stacked), white on a transparent
 * background — the frontend overlays it on the timeline.
 *
 * Lives in `src/lib/ffmpeg/` like every other ffmpeg call. Rejects with execa's
 * error (ffmpeg stderr) if the source has no audio or cannot be read; the ingest
 * handler treats that as non-fatal and skips the waveform.
 */
export async function generateWaveform(
  sourcePath: string,
  destPath: string,
  options: WaveformOptions = {},
): Promise<string> {
  const width = options.width ?? WAVEFORM_WIDTH;
  const height = options.height ?? WAVEFORM_HEIGHT;

  await mkdir(path.dirname(destPath), { recursive: true });

  // aformat=mono downmixes so one waveform is drawn; showwavespic defaults to a
  // transparent background, and `-frames:v 1` keeps just the single still it emits.
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    sourcePath,
    "-filter_complex",
    `aformat=channel_layouts=mono,showwavespic=s=${width}x${height}:colors=white`,
    "-frames:v",
    "1",
    "-y",
    destPath,
  ];

  await runFfmpeg(args);
  return destPath;
}
