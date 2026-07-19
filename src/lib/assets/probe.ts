import path from "node:path";

import { probe, probeAudio, type AudioProbeResult, type ProbeResult } from "../ffmpeg/exec";
import { generateThumbnail, posterTimestamp } from "../ffmpeg/thumbnail";

import type { AssetKind } from "./kind";

/**
 * Metadata the asset-probe job discovers for a freshly uploaded asset. Every
 * field is optional: audio has no dimensions or thumbnail, and an image has no
 * meaningful duration. Written back onto the asset row by `updateAssetMetadata`.
 */
export interface AssetMetadata {
  width: number | null;
  height: number | null;
  duration: number | null;
  thumbnailPath: string | null;
}

/** Where asset poster frames land; shares the source-video thumbnail dir. */
export function assetThumbnailDir(): string {
  return process.env.SSECLONE_THUMBNAIL_DIR ?? path.join("data", "thumbnails");
}

/** Poster width — matches the source-video poster so the picker grid is uniform. */
export const ASSET_THUMBNAIL_WIDTH = 480;

export interface ProbeAssetOptions {
  /** Injected in tests; default to the real ffprobe/ffmpeg wrappers. */
  probeFn?: (path: string) => Promise<ProbeResult>;
  probeAudioFn?: (path: string) => Promise<AudioProbeResult>;
  generateThumbnailFn?: typeof generateThumbnail;
  /** Thumbnail output directory. */
  dir?: () => string;
}

/**
 * Probe one uploaded asset and, for video/image, render a poster thumbnail.
 *
 * Dispatch is by media class, because the three kinds report different things:
 *   - `video`: ffprobe gives width/height/duration; poster grabbed a second in
 *     (or the midpoint of a very short clip), just like source ingest.
 *   - `image`: ffprobe still reports it as a single video stream, so width and
 *     height come from the same call; there is no duration, and the poster is
 *     the image itself scaled down.
 *   - `audio`: only a duration is meaningful — no dimensions, no thumbnail.
 *
 * `assetId` names the thumbnail file (`asset-<id>.jpg`) so re-probing overwrites
 * rather than accumulating orphans. Rejects with the underlying ffprobe/ffmpeg
 * error, which the worker turns into a job retry-then-fail.
 */
export async function probeAsset(
  assetId: number,
  kind: AssetKind,
  sourcePath: string,
  options: ProbeAssetOptions = {},
): Promise<AssetMetadata> {
  const probeFn = options.probeFn ?? probe;
  const probeAudioFn = options.probeAudioFn ?? probeAudio;
  const generateThumbnailFn = options.generateThumbnailFn ?? generateThumbnail;
  const dir = options.dir ?? assetThumbnailDir;

  if (kind === "audio") {
    const meta = await probeAudioFn(sourcePath);
    return { width: null, height: null, duration: meta.duration, thumbnailPath: null };
  }

  // video and image both expose a video stream to ffprobe.
  const meta = await probeFn(sourcePath);
  const thumbnailPath = path.join(dir(), `asset-${assetId}.jpg`);
  await generateThumbnailFn(sourcePath, thumbnailPath, {
    // Images have no duration, so posterTimestamp(0) -> 0 grabs the only frame.
    atSeconds: posterTimestamp(meta.duration),
    width: ASSET_THUMBNAIL_WIDTH,
  });

  return {
    width: meta.width || null,
    height: meta.height || null,
    // A still image reports duration 0; store null rather than a misleading 0 s.
    duration: kind === "image" ? null : meta.duration,
    thumbnailPath,
  };
}
