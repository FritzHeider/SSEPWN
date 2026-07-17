/**
 * HTTP Range header parsing (RFC 9110 §14), pure and file-free.
 *
 * Split out from the route it serves for the same reason as projects/view.ts and
 * transcribe/panel.ts: this is where the off-by-ones live — Range is inclusive
 * on BOTH ends, so a range's length is `end - start + 1` — and that arithmetic
 * deserves tests that need no database, no file descriptor and no server.
 */

/**
 * What to send for a Range request.
 *
 * `full` covers both "no Range asked for" and "a Range we will not honour": RFC
 * 9110 §14.2 says a server that cannot satisfy a range specification MUST ignore
 * the header and respond as if it were absent. Ignoring is the safe answer —
 * worst case the client refetches from byte 0 — whereas guessing at a malformed
 * range means silently serving bytes nobody asked for.
 */
export type RangeRequest =
  | { kind: "full" }
  /** Inclusive byte offsets, both already clamped into `[0, size - 1]`. */
  | { kind: "partial"; start: number; end: number }
  /** The range is well-formed but starts past EOF — the caller must answer 416. */
  | { kind: "unsatisfiable" };

const FULL: RangeRequest = { kind: "full" };

/** `bytes=<first>-<last>`, `bytes=<first>-`, or `bytes=-<suffix-length>`. */
const SINGLE_RANGE = /^bytes=(?:(\d+)-(\d+)?|-(\d+))$/;

/**
 * Decide what a `Range` header asks for against a resource of `size` bytes.
 *
 * Deliberately handles exactly one range. A multi-range request
 * (`bytes=0-1,5-6`) needs a `multipart/byteranges` body; serving only its first
 * range with a plain 206 would be a silent lie about what was answered, so those
 * fall back to `full` like any other range we will not honour. No real
 * `<video>` element sends one.
 *
 * @param header the raw `Range` header value, or null when absent
 * @param size   the resource's total length in bytes
 */
export function parseRangeHeader(header: string | null | undefined, size: number): RangeRequest {
  if (!header) return FULL;

  const match = SINGLE_RANGE.exec(header.trim());
  // Covers a bad unit ("items=0-1"), a multi-range list, and outright garbage.
  // All three are "cannot satisfy" and so are all ignored.
  if (!match) return FULL;

  const [, firstRaw, lastRaw, suffixRaw] = match;

  if (suffixRaw !== undefined) {
    const suffixLength = Number(suffixRaw);
    // `bytes=-0` asks for the last zero bytes. There is no such thing as an
    // empty 206, and RFC 9110 §14.1.2 calls the form invalid outright.
    if (suffixLength === 0) return { kind: "unsatisfiable" };
    if (size === 0) return { kind: "unsatisfiable" };
    // Asking for more trailing bytes than exist is satisfiable: it means the
    // whole file, still as a 206.
    return { kind: "partial", start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(firstRaw);
  // An empty resource has no byte 0, so every range over it starts past EOF.
  if (start >= size) return { kind: "unsatisfiable" };

  if (lastRaw === undefined) {
    return { kind: "partial", start, end: size - 1 };
  }

  const last = Number(lastRaw);
  // Inverted ranges are malformed, not unsatisfiable — the distinction matters:
  // 416 says "your offset is past the end", which would be a wrong diagnosis.
  if (last < start) return FULL;

  // Clamp rather than reject: browsers routinely ask for more than exists (a
  // speculative `bytes=0-999999` on a small file is normal), and answering 416
  // to that breaks playback of a perfectly good video.
  return { kind: "partial", start, end: Math.min(last, size - 1) };
}

/** Byte count of an inclusive range — the `+ 1` this module exists to get right. */
export function rangeLength(range: { start: number; end: number }): number {
  return range.end - range.start + 1;
}
