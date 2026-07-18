/**
 * Pure timeline operations and time mapping (Phase 07). Every mutating op is
 * `(doc, args) → doc`, returns a NEW immutable doc (so the editor can push it on
 * an undo stack), and ends by asserting the structural invariants via
 * {@link assertValidDoc} — a bug in an op fails at its source, not in playback.
 *
 * All time is in ABSOLUTE source seconds inside segments; TIMELINE time is the
 * edited-playback clock that walks segments front to back. `sourceTimeAt` and
 * `timelineTimeAt` convert between the two and are the ONLY place the React
 * layer gets time arithmetic from.
 */

import { assertValidDoc } from "./state";
import {
  AUDIO_MAX_VOLUME,
  MIN_SEGMENT_DURATION,
  TIME_EPSILON,
  TimelineError,
  type TimelineDoc,
  type TimelineSegment,
  type TrimEdge,
} from "./types";

/** Clip a value into `[lo, hi]` (returns `lo` if the range is inverted). */
function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function findSegment(doc: TimelineDoc, segId: string): { index: number; segment: TimelineSegment } {
  const index = doc.segments.findIndex((s) => s.id === segId);
  if (index === -1) throw new TimelineError(`No segment ${segId} in this timeline`);
  return { index, segment: doc.segments[index] };
}

/**
 * Total edited-playback length: the sum of every segment's source length. This
 * is the timeline's own definition of duration, independent of segment order.
 */
export function totalDuration(doc: TimelineDoc): number {
  return doc.segments.reduce((sum, s) => sum + (s.sourceOut - s.sourceIn), 0);
}

/**
 * Timeline start time of each segment, in the same order as `doc.segments` — a
 * running sum of prior segment lengths. The UI lays out the strip from these;
 * the mapping helpers below walk the same accumulation.
 */
export function segmentStarts(doc: TimelineDoc): number[] {
  const starts: number[] = [];
  let acc = 0;
  for (const seg of doc.segments) {
    starts.push(acc);
    acc += seg.sourceOut - seg.sourceIn;
  }
  return starts;
}

/**
 * Map an EDITED-playback time to the SOURCE time the single `<video>` element
 * should seek to. `timelineT` is clamped to `[0, totalDuration]`. Boundary times
 * resolve to the earlier segment (`<=`), which keeps `sourceTimeAt` a left
 * inverse of {@link timelineTimeAt} at shared cut points.
 */
export function sourceTimeAt(doc: TimelineDoc, timelineT: number): number {
  const total = totalDuration(doc);
  const clamped = clamp(timelineT, 0, total);
  let acc = 0;
  for (const seg of doc.segments) {
    const dur = seg.sourceOut - seg.sourceIn;
    if (clamped <= acc + dur + TIME_EPSILON) {
      return seg.sourceIn + (clamped - acc);
    }
    acc += dur;
  }
  const last = doc.segments[doc.segments.length - 1];
  return last.sourceOut;
}

/**
 * Inverse of {@link sourceTimeAt}: the edited-playback time at which a given
 * SOURCE time plays, or `null` when that source instant was trimmed/deleted out
 * of the timeline (it plays at no time). The first segment covering `sourceT`
 * wins; since segment source ranges are pairwise disjoint this is unambiguous
 * except at shared cut points, where the earlier segment is chosen to agree with
 * `sourceTimeAt`. Used to re-map caption timings through edits.
 */
export function timelineTimeAt(doc: TimelineDoc, sourceT: number): number | null {
  let acc = 0;
  for (const seg of doc.segments) {
    const dur = seg.sourceOut - seg.sourceIn;
    if (sourceT >= seg.sourceIn - TIME_EPSILON && sourceT <= seg.sourceOut + TIME_EPSILON) {
      return acc + (sourceT - seg.sourceIn);
    }
    acc += dur;
  }
  return null;
}

/**
 * Move one edge of a segment to source time `t`, clamped so the segment keeps
 * the {@link MIN_SEGMENT_DURATION} margin against its own opposite edge and does
 * not cross its nearest SOURCE neighbour (the segment immediately before it in
 * source for the `in` edge, immediately after for `out`) or the clip `bounds`.
 * Clamping against source neighbours — not array neighbours — keeps segment
 * ranges disjoint no matter how they were reordered.
 */
export function trim(doc: TimelineDoc, segId: string, edge: TrimEdge, t: number): TimelineDoc {
  const { index, segment } = findSegment(doc, segId);
  if (!Number.isFinite(t)) throw new TimelineError("Trim target must be a finite number");

  let next: TimelineSegment;
  if (edge === "in") {
    // Floor: the clip start, or the end of the nearest segment that lies before
    // this one in source (so trimming left can't swallow the left neighbour).
    let floor = doc.bounds.in;
    for (const other of doc.segments) {
      if (other.id === segId) continue;
      if (other.sourceOut <= segment.sourceIn + TIME_EPSILON) {
        floor = Math.max(floor, other.sourceOut);
      }
    }
    const ceil = segment.sourceOut - MIN_SEGMENT_DURATION;
    next = { ...segment, sourceIn: clamp(t, floor, ceil) };
  } else {
    let ceil = doc.bounds.out;
    for (const other of doc.segments) {
      if (other.id === segId) continue;
      if (other.sourceIn >= segment.sourceOut - TIME_EPSILON) {
        ceil = Math.min(ceil, other.sourceIn);
      }
    }
    const floor = segment.sourceIn + MIN_SEGMENT_DURATION;
    next = { ...segment, sourceOut: clamp(t, floor, ceil) };
  }

  const segments = doc.segments.map((s, i) => (i === index ? next : s));
  return assertValidDoc({ ...doc, segments });
}

/**
 * Split the segment playing at edited-playback time `timelineT` into two
 * contiguous segments that together cover the original range. The left half
 * keeps the original id; the right half gets a fresh deterministic id from
 * `seq`. A split within {@link MIN_SEGMENT_DURATION} of either edge is a no-op —
 * it would create a degenerate slice — so `splitAt` is safe to wire straight to
 * a "split at playhead" button without guarding the playhead position.
 */
export function splitAt(doc: TimelineDoc, timelineT: number): TimelineDoc {
  const total = totalDuration(doc);
  const clamped = clamp(timelineT, 0, total);
  let acc = 0;
  for (let i = 0; i < doc.segments.length; i++) {
    const seg = doc.segments[i];
    const dur = seg.sourceOut - seg.sourceIn;
    if (clamped < acc + dur - TIME_EPSILON) {
      const splitSrc = seg.sourceIn + (clamped - acc);
      if (
        splitSrc - seg.sourceIn < MIN_SEGMENT_DURATION ||
        seg.sourceOut - splitSrc < MIN_SEGMENT_DURATION
      ) {
        return doc; // too close to an edge to split cleanly
      }
      const left: TimelineSegment = { id: seg.id, sourceIn: seg.sourceIn, sourceOut: splitSrc };
      const right: TimelineSegment = {
        id: `seg-${doc.seq + 1}`,
        sourceIn: splitSrc,
        sourceOut: seg.sourceOut,
      };
      const segments = [...doc.segments];
      segments.splice(i, 1, left, right);
      return assertValidDoc({ ...doc, segments, seq: doc.seq + 1 });
    }
    acc += dur;
  }
  return doc; // playhead at/after the end — nothing to split
}

/**
 * Remove a segment. Refuses to empty the timeline (the "at least one segment"
 * invariant) and refuses an unknown id, both as {@link TimelineError} so the API
 * turns them into a single 400 rather than silently no-op'ing.
 */
export function deleteSegment(doc: TimelineDoc, segId: string): TimelineDoc {
  findSegment(doc, segId); // throws on unknown id
  if (doc.segments.length === 1) {
    throw new TimelineError("Cannot delete the only segment in a timeline");
  }
  const segments = doc.segments.filter((s) => s.id !== segId);
  return assertValidDoc({ ...doc, segments });
}

/**
 * Set the clip's audio gain, clamped to `[0, AUDIO_MAX_VOLUME]` (the same range
 * `readAudio` enforces on load) so the slider can never persist an out-of-range
 * value. A non-finite input throws rather than silently zeroing the track. Audio
 * settings are not structural, but the op still round-trips through
 * `assertValidDoc` so it composes with the others on the undo stack.
 */
export function setVolume(doc: TimelineDoc, volume: number): TimelineDoc {
  if (!Number.isFinite(volume)) throw new TimelineError("Volume must be a finite number");
  const clamped = clamp(volume, 0, AUDIO_MAX_VOLUME);
  return assertValidDoc({ ...doc, audio: { ...doc.audio, volume: clamped } });
}

/** Mute or unmute the clip's source audio (independent of the volume value). */
export function setMuted(doc: TimelineDoc, muted: boolean): TimelineDoc {
  return assertValidDoc({ ...doc, audio: { ...doc.audio, muted } });
}

/**
 * Move a segment to a new position in playback order. `toIndex` is clamped to a
 * valid slot, so a UI drag past either end lands the segment at the start/end
 * rather than throwing. Order is the only thing that changes; source ranges are
 * untouched, so invariants hold by construction.
 */
export function reorder(doc: TimelineDoc, segId: string, toIndex: number): TimelineDoc {
  const { index } = findSegment(doc, segId);
  const target = clamp(Math.trunc(toIndex), 0, doc.segments.length - 1);
  if (target === index) return doc;
  const segments = [...doc.segments];
  const [moved] = segments.splice(index, 1);
  segments.splice(target, 0, moved);
  return assertValidDoc({ ...doc, segments });
}
