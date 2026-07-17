import { execa } from "execa";

/**
 * Default scene-change sensitivity. ffmpeg's `scene` score is 0–1 (fraction of
 * the frame that changed); 0.3 catches hard cuts and strong dissolves without
 * firing on every camera wobble. Tunable per call.
 */
export const DEFAULT_SCENE_THRESHOLD = 0.3;

/** Matches `pts_time:12.400000` in ffmpeg's `metadata=print` output. */
const PTS_TIME = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;

/**
 * Timestamps (seconds) of scene changes in `videoPath`, ascending.
 *
 * Uses ffmpeg's `select='gt(scene,threshold)'` to keep only frames whose
 * scene-change score clears `threshold`, then `metadata=print:file=-` to emit
 * each kept frame's `pts_time` to stdout — far easier to parse reliably than
 * scraping `showinfo` lines out of stderr. `-f null -` discards the frames
 * themselves; we only want their timestamps.
 *
 * Lives here (not in `src/lib/highlights`) because it is an ffmpeg invocation
 * (global constraint). The result feeds `snapBoundaries`, which prefers to land
 * a clip edge on a nearby scene change. An empty array is a valid answer — a
 * source with no hard cuts simply offers no scene boundaries to snap to.
 *
 * Rejects with execa's error if ffmpeg cannot read the file.
 */
export async function detectSceneChanges(
  videoPath: string,
  threshold: number = DEFAULT_SCENE_THRESHOLD,
): Promise<number[]> {
  const { stdout } = await execa("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    videoPath,
    "-vf",
    `select='gt(scene,${threshold})',metadata=print:file=-`,
    "-an",
    "-f",
    "null",
    "-",
  ]);

  const times: number[] = [];
  for (const match of stdout.matchAll(PTS_TIME)) {
    const t = Number(match[1]);
    if (Number.isFinite(t)) times.push(t);
  }
  // metadata=print emits in decode order, which is presentation order here, but
  // sort defensively so the contract ("ascending") holds regardless of ffmpeg's
  // frame ordering.
  return times.sort((a, b) => a - b);
}
