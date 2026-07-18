/**
 * Timeline model contract (SPEC.md § Feature checklist 6 "Timeline editor",
 * Phase 07). A clip's timeline lives in `clip_edits.timeline` next to its crop
 * and captions, and describes the EDITED playback of a single source video:
 * which slices of the source play, in what order, plus caption/overlay/audio
 * tracks.
 *
 * Everything in this module is pure data (no React, no ffmpeg, no clock): the
 * ops in `ops.ts` are `(doc, args) → doc` and the editor's React layer holds a
 * stack of these docs for undo/redo. Keeping all the time arithmetic here is a
 * hard Phase-07 constraint ("components contain no time arithmetic").
 */

/**
 * One playable slice of the source video, expressed in ABSOLUTE source seconds
 * (the same space as `clips.in_point`/`out_point`), so a segment round-trips
 * through JSON without needing the clip row to interpret it. `id` is stable
 * across ops so the UI can key rows, follow a segment through a reorder, and
 * address it in `trim`/`delete`.
 *
 * Invariant (enforced by every op): `sourceIn < sourceOut`, both inside the
 * clip's `bounds`, and segment source ranges are pairwise disjoint — the
 * timeline never plays the same source instant twice.
 */
export interface TimelineSegment {
  /** Stable identifier, unique within a doc (e.g. "seg-3"). */
  id: string;
  /** Slice start, absolute seconds into the source video. */
  sourceIn: number;
  /** Slice end, absolute seconds into the source video (`> sourceIn`). */
  sourceOut: number;
}

/**
 * A CTA/B-roll overlay slot on the overlay track. Phase 07 only carries these
 * through untouched (round-trip preservation); Phase 08 populates timing and
 * payload. Kept open (`id` plus arbitrary extra keys) so a Phase-08 blob
 * survives a Phase-07 op without being silently dropped.
 */
export interface TimelineOverlay {
  /** Stable identifier, unique within the overlay track. */
  id: string;
  [key: string]: unknown;
}

/** Audio-track settings for the whole clip (SPEC.md: "audio track with volume"). */
export interface TimelineAudio {
  /** Linear gain; 1 = unity. Clamped to `[0, AUDIO_MAX_VOLUME]`. */
  volume: number;
  /** When true the clip's source audio is silenced regardless of `volume`. */
  muted: boolean;
}

/**
 * The timeline portion of a clip's `clip_edits.state` blob. `bounds` are the
 * clip's original source in/out points, copied in at build time so every op is
 * self-contained — `trim` can clamp to the clip window without re-reading the
 * `clips` row. `seq` is a monotonic counter that hands out fresh segment ids
 * deterministically (so `splitAt` is pure — no `Math.random`).
 */
export interface TimelineDoc {
  /** Schema version, for forward migration of persisted blobs. */
  version: 1;
  /** The clip's source window; hard limits every segment must stay inside. */
  bounds: { in: number; out: number };
  /** Ordered playable slices; playback walks these front to back. */
  segments: TimelineSegment[];
  /**
   * Marker that this clip has a caption track (captions themselves live under
   * `clip_edits.captions`); `null` when there is none. Phase 07 keeps this a
   * plain ref — the caption words are re-mapped through edits separately.
   */
  captionTrackRef: string | null;
  /** Overlay slots (B-roll/CTA), populated in Phase 08. */
  overlayTrack: TimelineOverlay[];
  /** Whole-clip audio settings. */
  audio: TimelineAudio;
  /** Monotonic counter backing deterministic segment-id generation. */
  seq: number;
}

/** Which edge of a segment a `trim` moves. */
export type TrimEdge = "in" | "out";

/** Thrown by timeline ops and `readTimelineDoc` parsing on invalid input. */
export class TimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimelineError";
  }
}

/**
 * Shortest a segment may become (seconds). A `trim` that would cross the
 * opposite edge closer than this is clamped, and `splitAt` refuses to carve off
 * a slice shorter than this — both guarantee the `sourceIn < sourceOut`
 * invariant with a meaningful margin rather than a degenerate zero-length slice.
 */
export const MIN_SEGMENT_DURATION = 0.001;

/** Tolerance for boundary comparisons (1 µs), well under the ±1 ms test budget. */
export const TIME_EPSILON = 1e-6;

/** Upper clamp for {@link TimelineAudio.volume} (allow up to +6 dB ≈ 2×). */
export const AUDIO_MAX_VOLUME = 2;
