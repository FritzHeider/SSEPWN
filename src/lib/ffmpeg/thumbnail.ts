import { mkdir } from "node:fs/promises";
import path from "node:path";

import { runFfmpeg } from "./exec";

export interface ThumbnailOptions {
  /** Seconds into the source to grab. Clamped to the source duration by the caller. */
  atSeconds?: number;
  /** Scale the poster to this width, preserving aspect ratio. Omit to keep source size. */
  width?: number;
}

/**
 * Pick the poster timestamp for a video of `duration` seconds.
 *
 * One second in avoids the black//fade-in frame most encodes open with, but a
 * clip shorter than that would seek past the end and produce no frame at all,
 * so short sources fall back to their midpoint.
 */
export function posterTimestamp(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return duration > 2 ? 1 : duration / 2;
}

/**
 * Extract a single frame as a JPEG poster (phase-02: `ffmpeg -ss ... -frames:v 1`).
 *
 * `-ss` precedes `-i` so ffmpeg seeks by keyframe before decoding rather than
 * decoding the whole file up to the timestamp — on a 90-minute source that is
 * the difference between milliseconds and minutes.
 *
 * Rejects with execa's error (including ffmpeg's stderr) if the frame cannot be
 * extracted.
 */
export async function generateThumbnail(
  sourcePath: string,
  destPath: string,
  options: ThumbnailOptions = {},
): Promise<string> {
  const { atSeconds = 0, width } = options;

  await mkdir(path.dirname(destPath), { recursive: true });

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(atSeconds),
    "-i",
    sourcePath,
    "-frames:v",
    "1",
  ];
  if (width !== undefined) {
    // -2 keeps the height even, which JPEG's chroma subsampling requires.
    args.push("-vf", `scale=${width}:-2`);
  }
  args.push("-y", destPath);

  await runFfmpeg(args);
  return destPath;
}
