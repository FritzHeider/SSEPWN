/**
 * Building, validating, and persisting a {@link TimelineDoc} within the shared
 * `clip_edits.state` blob. Mirrors `crop/state.ts`: a small constructor, a light
 * read guard for our own persisted data, and a `with…` merge that touches only
 * the `timeline` key so a clip's captions/crop in the same blob survive.
 */

import {
  AUDIO_MAX_VOLUME,
  MIN_SEGMENT_DURATION,
  SFX_MAX_VOLUME,
  TIME_EPSILON,
  TimelineError,
  TRANSITION_KINDS,
  type SfxCue,
  type TimelineAudio,
  type TimelineDoc,
  type TimelineOverlay,
  type TimelineSegment,
  type Transition,
  type TransitionKind,
} from "./types";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A fresh timeline for a clip: one segment spanning the clip's whole source
 * window. `bounds` are the clip's `in_point`/`out_point`; they become the hard
 * limits every later `trim` clamps to. Throws on a degenerate window so a
 * malformed clip row fails loudly here rather than producing an invalid doc.
 */
export function buildTimelineDoc(sourceIn: number, sourceOut: number): TimelineDoc {
  if (!isFiniteNumber(sourceIn) || !isFiniteNumber(sourceOut)) {
    throw new TimelineError("Clip bounds must be finite numbers");
  }
  if (sourceOut - sourceIn < MIN_SEGMENT_DURATION) {
    throw new TimelineError(
      `Clip window ${sourceIn}–${sourceOut}s is too short for a timeline`,
    );
  }
  return {
    version: 1,
    bounds: { in: sourceIn, out: sourceOut },
    segments: [{ id: "seg-1", sourceIn, sourceOut }],
    captionTrackRef: null,
    overlayTrack: [],
    transitions: {},
    sfxTrack: [],
    audio: { volume: 1, muted: false },
    seq: 1,
  };
}

/**
 * Assert the structural invariants a valid doc must uphold, throwing
 * {@link TimelineError} on the first violation. Called at the end of every op so
 * a bug in an operation surfaces at its source, not far downstream in playback
 * math. Checks: at least one segment; each `sourceIn < sourceOut` with the
 * minimum duration; every segment inside `bounds`; source ranges pairwise
 * disjoint (sorted, no overlap); ids unique.
 */
export function assertValidDoc(doc: TimelineDoc): TimelineDoc {
  const { segments, bounds } = doc;
  if (segments.length === 0) {
    throw new TimelineError("A timeline must have at least one segment");
  }
  const ids = new Set<string>();
  for (const seg of segments) {
    if (ids.has(seg.id)) throw new TimelineError(`Duplicate segment id ${seg.id}`);
    ids.add(seg.id);
    if (seg.sourceOut - seg.sourceIn < MIN_SEGMENT_DURATION - TIME_EPSILON) {
      throw new TimelineError(
        `Segment ${seg.id} is too short (${seg.sourceIn}–${seg.sourceOut})`,
      );
    }
    if (
      seg.sourceIn < bounds.in - TIME_EPSILON ||
      seg.sourceOut > bounds.out + TIME_EPSILON
    ) {
      throw new TimelineError(
        `Segment ${seg.id} (${seg.sourceIn}–${seg.sourceOut}) is outside clip bounds ${bounds.in}–${bounds.out}`,
      );
    }
  }
  // Disjointness is order-independent, so check on a source-sorted copy.
  const sorted = [...segments].sort((a, b) => a.sourceIn - b.sourceIn);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].sourceIn < sorted[i - 1].sourceOut - TIME_EPSILON) {
      throw new TimelineError(
        `Segments ${sorted[i - 1].id} and ${sorted[i].id} overlap in source time`,
      );
    }
  }
  return doc;
}

function isSegment(value: unknown): value is TimelineSegment {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    isFiniteNumber(s.sourceIn) &&
    isFiniteNumber(s.sourceOut)
  );
}

function isTransitionKind(value: unknown): value is TransitionKind {
  return typeof value === "string" && (TRANSITION_KINDS as readonly string[]).includes(value);
}

/**
 * Read the per-boundary transition map back out of a persisted blob, keeping only
 * well-formed non-`cut` entries (a valid kind + finite duration). A `cut` entry
 * is dropped since `cut` is the implicit default; anything malformed is ignored
 * rather than rejecting the whole doc, matching the light-guard style here.
 */
function readTransitions(value: unknown): Record<string, Transition> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, Transition> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (!isTransitionKind(r.kind) || r.kind === "cut") continue;
    if (!isFiniteNumber(r.duration)) continue;
    out[key] = { kind: r.kind, duration: r.duration };
  }
  return out;
}

/**
 * Read the SFX track back out of a persisted blob, keeping only well-formed cues
 * (finite positive `assetId`, finite `t`) and clamping each cue's `volume` into
 * `[0, SFX_MAX_VOLUME]`. Malformed entries are dropped rather than rejecting the
 * whole doc, matching the light-guard style of `readTransitions`.
 */
function readSfxTrack(value: unknown): SfxCue[] {
  if (!Array.isArray(value)) return [];
  const out: SfxCue[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string") continue;
    if (!isFiniteNumber(r.assetId) || r.assetId <= 0) continue;
    if (!isFiniteNumber(r.t)) continue;
    const volume = isFiniteNumber(r.volume)
      ? Math.min(SFX_MAX_VOLUME, Math.max(0, r.volume))
      : 1;
    out.push({ id: r.id, assetId: r.assetId, t: r.t, volume, duckMain: r.duckMain === true });
  }
  return out;
}

function readAudio(value: unknown): TimelineAudio {
  if (typeof value !== "object" || value === null) return { volume: 1, muted: false };
  const a = value as Record<string, unknown>;
  const volume = isFiniteNumber(a.volume)
    ? Math.min(AUDIO_MAX_VOLUME, Math.max(0, a.volume))
    : 1;
  return { volume, muted: a.muted === true };
}

/**
 * Read a timeline back out of a parsed `clip_edits.state` blob, or `null` when
 * absent or malformed. Like `readCropState` this is a LIGHT guard over our own
 * persisted data — enough to reject a half-written blob rather than let a bad
 * shape reach the ops — not a strict client-body validator. Missing optional
 * tracks (overlay/caption/audio) get sane defaults so older blobs still load.
 */
export function readTimelineDoc(state: unknown): TimelineDoc | null {
  if (typeof state !== "object" || state === null) return null;
  const timeline = (state as Record<string, unknown>).timeline;
  if (typeof timeline !== "object" || timeline === null) return null;
  const t = timeline as Record<string, unknown>;

  if (!Array.isArray(t.segments) || t.segments.length === 0) return null;
  if (!t.segments.every(isSegment)) return null;
  if (typeof t.bounds !== "object" || t.bounds === null) return null;
  const bounds = t.bounds as Record<string, unknown>;
  if (!isFiniteNumber(bounds.in) || !isFiniteNumber(bounds.out)) return null;

  const overlayTrack = Array.isArray(t.overlayTrack)
    ? (t.overlayTrack as TimelineOverlay[])
    : [];
  const captionTrackRef = typeof t.captionTrackRef === "string" ? t.captionTrackRef : null;
  // `seq` must cover every existing id so a re-derived counter never collides;
  // fall back to the segment count when an older blob lacks it.
  const seq = isFiniteNumber(t.seq) ? t.seq : (t.segments as TimelineSegment[]).length;

  return {
    version: 1,
    bounds: { in: bounds.in, out: bounds.out },
    segments: (t.segments as TimelineSegment[]).map((s) => ({
      id: s.id,
      sourceIn: s.sourceIn,
      sourceOut: s.sourceOut,
    })),
    captionTrackRef,
    overlayTrack,
    transitions: readTransitions(t.transitions),
    sfxTrack: readSfxTrack(t.sfxTrack),
    audio: readAudio(t.audio),
    seq,
  };
}

/**
 * Merge a timeline doc into a (possibly empty) parsed state blob, returning a
 * new object to serialise. Only the `timeline` key is written — a clip's crop
 * and captions in the same blob are preserved, exactly as `withCropState` leaves
 * captions untouched.
 */
export function withTimelineDoc(
  state: Record<string, unknown>,
  timeline: TimelineDoc,
): Record<string, unknown> {
  return { ...state, timeline };
}
