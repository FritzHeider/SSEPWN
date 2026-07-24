/**
 * Filesystem locations for the derived media the worker generates alongside a
 * project: per-clip poster thumbnails and per-project audio waveforms.
 *
 * A single exported path helper per file kind, imported by every side that
 * touches it (the generating handler, the serving route, the cascade-delete file
 * list, the per-clip delete) — the same idiom as `thumbnailDir`/`exportOutputPath`
 * so the location can never drift between writer and reader. Both directories are
 * env-overridable so tests and CI never write into the real `data/` tree.
 */
import path from "node:path";

/** Where per-clip poster frames land (`<clipId>.jpg`). */
export function clipThumbnailDir(): string {
  return process.env.SSECLONE_CLIP_THUMB_DIR ?? path.join("data", "derived", "clip-thumbs");
}

export function clipThumbnailPath(clipId: number): string {
  return path.join(clipThumbnailDir(), `${clipId}.jpg`);
}

/** Where per-project audio waveform images land (`<projectId>.png`). */
export function waveformDir(): string {
  return process.env.SSECLONE_WAVEFORM_DIR ?? path.join("data", "derived", "waveforms");
}

export function waveformPath(projectId: number): string {
  return path.join(waveformDir(), `${projectId}.png`);
}
