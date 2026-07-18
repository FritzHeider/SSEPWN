/**
 * Smart-crop contract (SPEC.md § Tech stack: subject-tracked reframing behind a
 * `SubjectDetector` interface, "face detection via @vladmandic/human ... with
 * center-weighted fallback when no face is found").
 *
 * Everything downstream — `planCrop`, the smart-crop job, the crop API — speaks
 * these types, never a detector-specific shape, so the `FakeDetector` used by
 * the default test suite and the real face detector are interchangeable
 * (phase-06: "Default `npm test` must not require Human models").
 */

/**
 * A detected subject, expressed as a rectangle in NORMALISED source coordinates:
 * every field is a fraction of the frame, so the same box is meaningful at any
 * resolution and `planCrop` can be tested with hand-written numbers instead of
 * pixels tied to a fixture's size.
 */
export interface Box {
  /** Left edge, 0–1 fraction of source width. */
  x: number;
  /** Top edge, 0–1 fraction of source height. */
  y: number;
  /** Width, 0–1 fraction of source width. */
  w: number;
  /** Height, 0–1 fraction of source height. */
  h: number;
  /** Detector confidence, 0–1. `planCrop` follows the highest-confidence box. */
  confidence: number;
}

/**
 * Pulls candidate subject boxes out of a single already-extracted frame.
 *
 * The frame is a PNG on disk (produced by `sampleFrames`) rather than raw pixels
 * so the interface stays cheap to fake and cheap to shell out to whichever
 * backend the real detector uses. An implementation with no backend available
 * (missing models/binary) must reject with an actionable Error rather than
 * resolving to `[]`, so a misconfigured environment fails loudly instead of
 * silently looking like "every frame has no subject" — which `planCrop` would
 * dutifully turn into a static center crop with no hint anything was wrong.
 */
export interface SubjectDetector {
  detect(framePngPath: string): Promise<Box[]>;
}

/**
 * The three reframe targets a clip can be cropped to (SPEC.md § Smart crop).
 * Stored verbatim in `clip_edits.crop` and accepted by the crop API, so it is a
 * string the UI and JSON round-trip untouched, not a numeric ratio that would
 * turn 9:16 into a lossy float on the way to disk.
 */
export type AspectRatio = "9:16" | "1:1" | "16:9";

export const ASPECT_RATIOS: readonly AspectRatio[] = ["9:16", "1:1", "16:9"];

/**
 * Width ÷ height for a target ratio — what `planCrop` needs to size the crop
 * window. Kept as a total function over the union (a `switch` the type-checker
 * proves exhaustive) so adding a ratio later can't silently forget the value.
 */
export function aspectRatioValue(ar: AspectRatio): number {
  switch (ar) {
    case "9:16":
      return 9 / 16;
    case "1:1":
      return 1;
    case "16:9":
      return 16 / 9;
  }
}

/**
 * Validate an untrusted aspect-ratio value at the API boundary. Throws on
 * anything outside the union so a malformed `POST /api/clips/:id/crop` body is
 * rejected with a clear message instead of flowing an unknown string into the
 * job payload and surfacing far away as a wrong-sized crop.
 */
export function parseAspectRatio(value: unknown): AspectRatio {
  if (typeof value === "string" && (ASPECT_RATIOS as readonly string[]).includes(value)) {
    return value as AspectRatio;
  }
  throw new Error(
    `Invalid aspectRatio ${JSON.stringify(value)} — expected one of ${ASPECT_RATIOS.join(", ")}`,
  );
}
