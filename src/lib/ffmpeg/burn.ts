import { mkdir } from "node:fs/promises";
import path from "node:path";

import { runFfmpeg } from "./exec";

/**
 * Escape a filesystem path for use as the value of an ffmpeg filtergraph option.
 *
 * In a filtergraph, `\`, `:` and `'` are all meta-characters — an unescaped
 * colon (Windows drive letters, timestamps) or quote in the path would end the
 * option early and corrupt the graph. The `ass` filter reads its `filename`
 * option through this same parser, so the path has to survive it intact.
 */
export function escapeFilterPath(p: string): string {
  return p
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

/**
 * Burn an ASS subtitle file into `inputPath`, writing the captioned video to
 * `outputPath` (SPEC.md § Captions, Phase 05 `burnIn`).
 *
 * The `ass` filter (not `subtitles`) is used deliberately: it renders the ASS
 * styling — fonts, karaoke `\k` sweeps, outline/box — that `toAss` encodes,
 * whereas `subtitles` would flatten most of it. The style's pixel sizes assume
 * the ASS `PlayResX/Y` matches the real frame, which `toAss` already guarantees.
 *
 * The video stream is re-encoded (the captions have to be rasterised into the
 * pixels); the audio is stream-copied so it stays bit-identical and the output
 * duration tracks the input. Lives in `src/lib/ffmpeg/` because it is an ffmpeg
 * invocation (global constraint); the caption math that produces the ASS is
 * pure and lives in `src/lib/captions/`.
 *
 * Rejects with execa's error (including ffmpeg's stderr) if the input cannot be
 * decoded or the ASS file is missing/unreadable.
 */
export async function burnIn(
  inputPath: string,
  assPath: string,
  outputPath: string,
): Promise<string> {
  await mkdir(path.dirname(outputPath), { recursive: true });

  await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-vf",
    `ass=${escapeFilterPath(assPath)}`,
    "-c:a",
    "copy",
    "-y",
    outputPath,
  ]);

  return outputPath;
}
