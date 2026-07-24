/**
 * Pure logic for transcript search, range selection, and reason→segment linking
 * (items 17, 18).
 *
 * React-free and Node-free (DEC-005): the substring match that drives the filter
 * and the `<mark>` highlight, the order-agnostic selection range, and the lookup
 * that maps a clip's time range back to its first transcript segment all live
 * here where vitest can pin the edges (empty query, no match, reversed
 * selection), so the transcript rail component stays a thin renderer.
 */

import type { TranscriptSegment } from "@/lib/transcribe/types";

/** No segment is selected as a range endpoint yet. */
export const NO_SELECTION = -1;

/** Trimmed, lower-cased query — the single normalization both the filter and the
 * highlighter share so they never disagree on what "matches". An all-whitespace
 * query is treated as empty (matches everything / highlights nothing). */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Indices of the segments whose text contains `query` (case-insensitive
 * substring), in order. An empty query returns every index — "no filter" shows
 * the whole transcript rather than nothing.
 */
export function matchingSegmentIndices(
  segments: ReadonlyArray<Pick<TranscriptSegment, "text">>,
  query: string,
): number[] {
  const needle = normalizeQuery(query);
  const all = segments.map((_, index) => index);
  if (needle === "") return all;
  return all.filter((index) => segments[index].text.toLowerCase().includes(needle));
}

/** "3 of 12 segments" (or "12 segments" when the query is empty), for the count
 * beside the search box. Singular on exactly one total. */
export function searchCountLabel(matchCount: number, total: number, query: string): string {
  const noun = total === 1 ? "segment" : "segments";
  if (normalizeQuery(query) === "") return `${total} ${noun}`;
  return `${matchCount} of ${total} ${noun}`;
}

/** One run of a segment's text, flagged whether it is a query match to wrap in
 * `<mark>`. */
export interface HighlightPart {
  text: string;
  match: boolean;
}

/**
 * Split a segment's text into matched/unmatched runs so the component can wrap
 * matches in `<mark>` without dangerouslySetInnerHTML. An empty query yields a
 * single unmatched run (the whole text). The scan is case-insensitive but the
 * returned `text` preserves the original casing.
 */
export function highlightParts(text: string, query: string): HighlightPart[] {
  const needle = normalizeQuery(query);
  if (needle === "") return [{ text, match: false }];

  const parts: HighlightPart[] = [];
  const haystack = text.toLowerCase();
  let cursor = 0;
  for (;;) {
    const hit = haystack.indexOf(needle, cursor);
    if (hit === -1) {
      if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (hit > cursor) parts.push({ text: text.slice(cursor, hit), match: false });
    parts.push({ text: text.slice(hit, hit + needle.length), match: true });
    cursor = hit + needle.length;
  }
  return parts;
}

/** The `[low, high]` bounds of a two-click selection, order-agnostic: clicking
 * a later segment first still yields a forward range. Either endpoint unset
 * (`NO_SELECTION`) yields `null`. */
export function selectionBounds(a: number, b: number): [number, number] | null {
  if (a === NO_SELECTION || b === NO_SELECTION) return null;
  return a <= b ? [a, b] : [b, a];
}

/** Whether a segment index falls inside the current selection (inclusive), for
 * highlighting the selected span. */
export function isSelected(index: number, a: number, b: number): boolean {
  const bounds = selectionBounds(a, b);
  return bounds !== null && index >= bounds[0] && index <= bounds[1];
}

/**
 * The source time range a selection covers: the earliest segment's `start` to
 * the latest segment's `end`. This is what the "Create clip" button posts to the
 * manual-clip endpoint. `null` when the selection is incomplete or the indices
 * fall outside the list.
 */
export function selectionTimeRange(
  segments: ReadonlyArray<Pick<TranscriptSegment, "start" | "end">>,
  a: number,
  b: number,
): { start: number; end: number } | null {
  const bounds = selectionBounds(a, b);
  if (bounds === null) return null;
  const [low, high] = bounds;
  if (low < 0 || high >= segments.length) return null;
  return { start: segments[low].start, end: segments[high].end };
}

/**
 * The index of the first transcript segment that falls inside a clip's `[in,
 * out]` source range — where clicking that clip's reason chip should scroll and
 * flash-highlight (item 18). "Falls inside" means the segment overlaps the
 * range at all (its start is before the out-point and its end after the
 * in-point), so a clip that begins mid-sentence still links to that sentence.
 * `NO_SELECTION` when nothing overlaps.
 */
export function firstSegmentInRange(
  segments: ReadonlyArray<Pick<TranscriptSegment, "start" | "end">>,
  inPoint: number,
  outPoint: number,
): number {
  return segments.findIndex((segment) => segment.start < outPoint && segment.end > inPoint);
}
