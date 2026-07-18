import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { runFfmpeg } from "./exec";

/**
 * One extracted sample frame: an absolute PNG path plus the source timestamp it
 * was taken from. The smart-crop job walks these in time order, runs a
 * `SubjectDetector` on each `path`, and pairs the resulting boxes with `t` to
 * build the `FrameSample[]` that `planCrop` consumes.
 */
export interface SampledFrame {
  /**
   * Seconds from the start of the sample window, `index * everyNSec`. Without
   * `startSec` this is time from the start of the video; with it, time from the
   * seek point — so the smart-crop job gets clip-relative timestamps directly.
   */
  t: number;
  /** Absolute path to the extracted PNG frame. */
  path: string;
}

export interface SampleFramesOptions {
  /**
   * Downscale each frame to this width, preserving aspect ratio (even height for
   * yuv-friendly encoders). Omit to keep the source resolution. Boxes are
   * normalised 0–1 so scaling never changes `planCrop`'s result — it only makes
   * detection cheaper on a big source.
   */
  width?: number;
  /**
   * Seek this many seconds into the source before sampling (ffmpeg input `-ss`).
   * The smart-crop job samples only a clip's `[in, out]` range, not the whole
   * source, so it passes the clip's in-point here. With this set the returned
   * `t` values stay `index * everyNSec` — i.e. relative to the sample window's
   * start, so the smart-crop job gets clip-relative timestamps for free.
   */
  startSec?: number;
  /**
   * Sample at most this many seconds from `startSec` (ffmpeg `-t`). Omit to
   * sample to the end of the source. The job passes the clip's duration so no
   * frames past the clip's out-point are extracted.
   */
  durationSec?: number;
}

/** `frame-00001.png`, `frame-00002.png`, … — image2's default 1-based numbering. */
const FRAME_PREFIX = "frame-";
const FRAME_PATTERN = /^frame-\d+\.png$/;

/**
 * Extract one frame every `everyNSec` seconds of `videoPath` into `destDir` as
 * PNGs, returning them in ascending time order (phase-06: `sampleFrames`).
 *
 * Lives in `src/lib/ffmpeg/` (not `src/lib/crop/`) because it is an ffmpeg
 * invocation — the global constraint keeps every ffmpeg call in this directory,
 * exactly as `detectSceneChanges` does for the highlights pipeline. The crop
 * layer proper (`planCrop`, `cropFilter`) stays pure and ffmpeg-free.
 *
 * The `fps=1/N` filter picks one frame per N-second window; ffmpeg renumbers the
 * kept frames sequentially, so output frame `i` (0-based, sorted by filename)
 * corresponds to source time `i * everyNSec`. We derive `t` from the index
 * rather than probing each PNG's pts because the index mapping is exact and
 * deterministic, which is what `planCrop` keyframes are tested against.
 *
 * An empty result is possible only for a zero-length source; any real clip
 * yields at least one frame. Rejects with execa's error (ffmpeg stderr) if the
 * source cannot be read.
 */
export async function sampleFrames(
  videoPath: string,
  everyNSec: number,
  destDir: string,
  options: SampleFramesOptions = {},
): Promise<SampledFrame[]> {
  if (!Number.isFinite(everyNSec) || everyNSec <= 0) {
    throw new Error(`sampleFrames: everyNSec must be a positive number, got ${everyNSec}`);
  }

  await mkdir(destDir, { recursive: true });

  let filter = `fps=1/${everyNSec}`;
  if (options.width !== undefined) {
    if (!Number.isInteger(options.width) || options.width <= 0) {
      throw new Error(`sampleFrames: width must be a positive integer, got ${options.width}`);
    }
    // -2 keeps the height even, which most encoders (and yuv420p) require.
    filter += `,scale=${options.width}:-2`;
  }

  // Optional clip window: `-ss` (input seek) before `-i`, `-t` (duration) after.
  // Input-side seeking is fast and the fps filter counts from the seek point, so
  // frame `i` is still at `startSec + i*everyNSec` in the source and `i*everyNSec`
  // relative to the window — which is what the returned `t` reports.
  const seek: string[] = [];
  if (options.startSec !== undefined) {
    if (!Number.isFinite(options.startSec) || options.startSec < 0) {
      throw new Error(`sampleFrames: startSec must be a non-negative number, got ${options.startSec}`);
    }
    seek.push("-ss", String(options.startSec));
  }
  const duration: string[] = [];
  if (options.durationSec !== undefined) {
    if (!Number.isFinite(options.durationSec) || options.durationSec <= 0) {
      throw new Error(`sampleFrames: durationSec must be a positive number, got ${options.durationSec}`);
    }
    duration.push("-t", String(options.durationSec));
  }

  await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    ...seek,
    "-i",
    videoPath,
    ...duration,
    "-vf",
    filter,
    "-y",
    path.join(destDir, `${FRAME_PREFIX}%05d.png`),
  ]);

  const entries = (await readdir(destDir))
    .filter((name) => FRAME_PATTERN.test(name))
    .sort();

  return entries.map((name, i) => ({
    t: i * everyNSec,
    path: path.join(destDir, name),
  }));
}
