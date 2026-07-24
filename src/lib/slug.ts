/**
 * URL/filename-safe slug from arbitrary text (shared by the caption-export
 * filenames in tasks 6 and 8). Pure — no IO — so the exact output is
 * unit-testable and the download route and the .srt/.vtt routes agree on how a
 * clip title becomes a filename.
 *
 * Diacritics are folded to ASCII, everything that is not `[a-z0-9]` collapses to
 * a single dash, and leading/trailing dashes are trimmed. The result is capped so
 * a pathological title can never produce an unwieldy filename; an empty result
 * (a title of only punctuation, or an empty string) is returned as-is so the
 * caller can substitute its own fallback (e.g. `"clip"`).
 */
export const SLUG_MAX = 80;

export function slugify(input: string, max = SLUG_MAX): string {
  return input
    .normalize("NFKD")
    // Strip combining marks (U+0300–U+036F) left by the decomposition above.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, Math.max(1, max))
    // A trailing dash can reappear after the slice; trim once more.
    .replace(/-+$/g, "");
}
