/**
 * Accepted video types (SPEC.md § Feature checklist 1: mp4/mov/webm). The
 * declared mime type and the filename extension must AGREE — a client that
 * sends either one alone is not trusted.
 *
 * This module is deliberately dependency-free so the browser dropzone can share
 * these rules with the server. `receive.ts` (busboy, node:fs, node:stream) is
 * the enforcing authority and re-exports this constant; importing it from a
 * client component would drag Node builtins into the browser bundle.
 */
export const ALLOWED_VIDEO_TYPES: Readonly<Record<string, readonly string[]>> = {
  "video/mp4": [".mp4"],
  "video/quicktime": [".mov"],
  "video/webm": [".webm"],
};

/** Every accepted extension, e.g. ".mp4, .mov, .webm" — for prose and `accept`. */
export function allowedExtensions(): string[] {
  return Object.values(ALLOWED_VIDEO_TYPES).flat();
}

/**
 * The `accept` attribute for a file input: mime types AND extensions, because
 * browsers match them inconsistently (a .mov is `video/quicktime` on macOS but
 * has been seen as an empty type on some Linux/Windows pickers).
 */
export function fileInputAccept(): string {
  return [...Object.keys(ALLOWED_VIDEO_TYPES), ...allowedExtensions()].join(",");
}

/**
 * Client-side pre-filter mirroring the server's rule: the mime type must be
 * known AND the extension must be one that type permits.
 *
 * This is a fast-feedback convenience, never a security boundary — `receive.ts`
 * re-checks every upload on the server, where the client cannot lie to it.
 */
export function isAcceptedVideoFile(file: { name: string; type: string }): boolean {
  const allowedExts = ALLOWED_VIDEO_TYPES[(file.type ?? "").toLowerCase()];
  if (!allowedExts) return false;
  return allowedExts.includes(fileExtension(file.name ?? ""));
}

/**
 * Lowercased final extension, or "" when there is none.
 *
 * Hand-rolled rather than `node:path`.extname: this module is imported by a
 * client component, and Next does not polyfill Node builtins into the browser
 * bundle. Matches extname's contract for the cases that matter here — a leading
 * dot is not an extension (".mp4" is a dotfile, not a video).
 */
function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}
