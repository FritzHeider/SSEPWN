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
  /** Seconds from the start of the video, `index * everyNSec`. */
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

  await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    videoPath,
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
