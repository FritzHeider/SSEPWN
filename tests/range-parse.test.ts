import { describe, expect, it } from "vitest";

import { parseRangeHeader, rangeLength } from "../src/lib/api/range";

/**
 * Pure Range arithmetic (RFC 9110 §14). The route test drives real bytes off a
 * real fd; this one pins the edges that are tedious to express there — an empty
 * file, a suffix longer than the resource, `bytes=-0`.
 *
 * SIZE is deliberately odd and not a round number: with a size like 100 a
 * suffix range (`bytes=-40`, last 40 bytes) and a mis-read "from byte 40" range
 * both start at 60 for some inputs, and an off-by-one lands on a plausible
 * boundary. 101 makes those coincidences stop happening.
 */
const SIZE = 101;

describe("parseRangeHeader — no range to honour", () => {
  it("treats an absent header as a request for the whole resource", () => {
    expect(parseRangeHeader(null, SIZE)).toEqual({ kind: "full" });
    expect(parseRangeHeader(undefined, SIZE)).toEqual({ kind: "full" });
    expect(parseRangeHeader("", SIZE)).toEqual({ kind: "full" });
  });

  it.each([
    ["a unit it does not understand", "items=0-10"],
    ["a non-numeric range", "bytes=abc"],
    ["an empty range", "bytes="],
    ["a bare dash", "bytes=-"],
    ["an inverted range", "bytes=5-2"],
    ["a negative-looking first byte", "bytes=--5"],
    ["a fractional offset", "bytes=1.5-9"],
  ])("ignores %s and serves the whole resource", (_label, header) => {
    expect(parseRangeHeader(header, SIZE)).toEqual({ kind: "full" });
  });

  /**
   * A multi-range request needs a multipart/byteranges body. Honouring only its
   * FIRST range with a plain 206 would claim to have answered the whole request
   * while dropping half of it — a silent wrong answer, which is worse than the
   * client refetching everything.
   */
  it("ignores a multi-range request rather than answering only its first range", () => {
    expect(parseRangeHeader("bytes=0-1,5-6", SIZE)).toEqual({ kind: "full" });
    expect(parseRangeHeader("bytes=0-1, 5-6", SIZE)).toEqual({ kind: "full" });
  });
});

describe("parseRangeHeader — satisfiable ranges", () => {
  it("reads a closed range inclusively on both ends", () => {
    expect(parseRangeHeader("bytes=10-19", SIZE)).toEqual({ kind: "partial", start: 10, end: 19 });
    expect(rangeLength({ start: 10, end: 19 })).toBe(10);
  });

  /**
   * A single-byte range is 100% error under an `end - start` length mutant, so
   * it cannot be fudged by a fixture that happens to line up.
   */
  it("treats bytes=0-0 as exactly one byte", () => {
    const range = parseRangeHeader("bytes=0-0", SIZE);
    expect(range).toEqual({ kind: "partial", start: 0, end: 0 });
    expect(rangeLength({ start: 0, end: 0 })).toBe(1);
  });

  it("runs an open-ended range to the last byte", () => {
    expect(parseRangeHeader("bytes=40-", SIZE)).toEqual({ kind: "partial", start: 40, end: SIZE - 1 });
  });

  it("reads a suffix range as the LAST n bytes, not as an offset", () => {
    // 61 would be the answer if `-40` were misread as "from byte 40"; the last
    // 40 bytes of 101 start at 61... which is why SIZE is 101 and not 100.
    expect(parseRangeHeader("bytes=-40", SIZE)).toEqual({ kind: "partial", start: 61, end: 100 });
    expect(rangeLength({ start: 61, end: 100 })).toBe(40);
  });

  it("clamps a suffix longer than the resource to the whole resource", () => {
    expect(parseRangeHeader(`bytes=-${SIZE * 2}`, SIZE)).toEqual({ kind: "partial", start: 0, end: SIZE - 1 });
  });

  /**
   * Browsers speculatively ask for more than exists. 416 there breaks playback
   * of a perfectly good video, so the end clamps instead.
   */
  it("clamps an end past EOF instead of rejecting the range", () => {
    expect(parseRangeHeader("bytes=0-999999", SIZE)).toEqual({ kind: "partial", start: 0, end: SIZE - 1 });
    expect(parseRangeHeader(`bytes=${SIZE - 1}-999999`, SIZE)).toEqual({
      kind: "partial",
      start: SIZE - 1,
      end: SIZE - 1,
    });
  });

  it("accepts a range covering the whole resource exactly", () => {
    expect(parseRangeHeader(`bytes=0-${SIZE - 1}`, SIZE)).toEqual({ kind: "partial", start: 0, end: SIZE - 1 });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseRangeHeader("  bytes=10-19  ", SIZE)).toEqual({ kind: "partial", start: 10, end: 19 });
  });
});

describe("parseRangeHeader — unsatisfiable ranges", () => {
  /**
   * Past-EOF must NOT collapse into "full": a 200 tells the UA its seek
   * succeeded, and it then renders whatever arrived at the wrong offset.
   */
  it("rejects a first byte at or past EOF", () => {
    expect(parseRangeHeader(`bytes=${SIZE}-`, SIZE)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader(`bytes=${SIZE}-${SIZE + 10}`, SIZE)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader(`bytes=${SIZE + 500}-`, SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("accepts the last byte but rejects the one after it", () => {
    expect(parseRangeHeader(`bytes=${SIZE - 1}-`, SIZE)).toEqual({
      kind: "partial",
      start: SIZE - 1,
      end: SIZE - 1,
    });
    expect(parseRangeHeader(`bytes=${SIZE}-`, SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  /** There is no such thing as an empty 206. */
  it("rejects a zero-length suffix", () => {
    expect(parseRangeHeader("bytes=-0", SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("rejects every range over an empty resource without blowing up", () => {
    expect(parseRangeHeader("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=0-0", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=-10", 0)).toEqual({ kind: "unsatisfiable" });
    // ...but an empty file with no Range is still a legitimate empty 200.
    expect(parseRangeHeader(null, 0)).toEqual({ kind: "full" });
  });
});
