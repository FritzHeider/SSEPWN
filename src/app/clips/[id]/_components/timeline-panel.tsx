"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CaptionCue } from "@/lib/captions/clip";
import type { CaptionDoc } from "@/lib/captions/ass";
import { formatDuration } from "@/lib/projects/view";
import {
  deleteSegment,
  reorder,
  setMuted,
  setVolume,
  sourceTimeAt,
  splitAt,
  timelineTimeAt,
  totalDuration,
  trim,
} from "@/lib/timeline/ops";
import {
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redoHistory,
  undoHistory,
  type TimelineHistory,
} from "@/lib/timeline/history";
import { TimelineStrip } from "./timeline-strip";
import { BrollPanel } from "./broll-panel";
import { BrollPreview } from "./broll-preview";
import { CtaPanel } from "./cta-panel";
import { CtaPreview } from "./cta-preview";
import { TransitionsPanel } from "./transitions-panel";
import { remapCaptions } from "@/lib/timeline/captions";
import { advancePlayback, segmentIndexAt } from "@/lib/timeline/playback";
import {
  DEFAULT_PX_PER_SEC,
  SNAP_THRESHOLD_PX,
  dropIndexAt,
  segmentLayout,
  snapValue,
  timelineCutTimes,
  xToTime,
  zoomBy,
} from "@/lib/timeline/strip";
import {
  AUDIO_MAX_VOLUME,
  TIME_EPSILON,
  TimelineError,
  type TimelineDoc,
  type TrimEdge,
} from "@/lib/timeline/types";
import { sourceVideoUrl } from "@/lib/transcribe/panel";

/** Debounce before the optimistic doc is written back to the server. */
const SAVE_DEBOUNCE_MS = 500;
/** One "frame" for ←/→ stepping (30 fps); no project fps is known here. */
const FRAME_STEP = 1 / 30;

/** A trim in progress: which edge of which segment, and the drag origin. */
interface TrimDrag {
  kind: "trim";
  segId: string;
  edge: TrimEdge;
  startX: number;
  baseSource: number;
  result: TimelineDoc | null;
}
/** A reorder in progress: which segment, and the live pointer x within the strip. */
interface ReorderDrag {
  kind: "reorder";
  segId: string;
  x: number;
}
type Drag = TrimDrag | ReorderDrag;

/**
 * The Phase-07 timeline strip editor. A single `<video>` plus DOM tracks (video
 * segments, captions, overlays, audio). All edits are the pure ops in
 * `lib/timeline`, held in an undo stack and debounce-saved through `PATCH
 * /api/clips/:id/timeline` (optimistic UI, durable write-behind). Every
 * pixel↔time conversion and snap comes from `lib/timeline/strip`, so this holds
 * no time arithmetic of its own (a hard Phase-07 constraint). Preview plays the
 * EDITED sequence: `space` starts the single `<video>` from the playhead and each
 * `timeupdate`/`ended` steps through `advancePlayback`, seeking over deleted ranges
 * and honouring reordered segments.
 */
export function TimelinePanel({
  clipId,
  projectId,
  initialDoc,
  captionDoc,
}: {
  clipId: number;
  projectId: number;
  initialDoc: TimelineDoc;
  captionDoc: CaptionDoc | null;
}) {
  const [history, setHistory] = useState<TimelineHistory>(() => createHistory(initialDoc));
  const [preview, setPreview] = useState<TimelineDoc | null>(null);
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [selectedId, setSelectedId] = useState<string | null>(initialDoc.segments[0]?.id ?? null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const doc = history.present;
  // What the strip renders: the in-flight drag preview, else the committed doc.
  const view = preview ?? doc;

  const videoRef = useRef<HTMLVideoElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const alive = useRef(true);
  const firstRender = useRef(true);
  const latestDoc = useRef(doc);
  const lastSaved = useRef(initialDoc);
  // Which segment (playback-order index) edited-sequence preview is currently
  // playing; `playheadRef` mirrors the playhead so a structural edit can re-seed
  // the segment without re-running effects on every frame.
  const playSegRef = useRef(0);
  const playheadRef = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Mirror the playhead into a ref so the doc-change resync effect can read the
  // latest value without depending on it (which would re-run it every frame).
  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  const total = totalDuration(view);
  const boxes = useMemo(() => segmentLayout(view, pxPerSec), [view, pxPerSec]);
  const stripWidth = Math.max(total * pxPerSec, 1);
  const captionCues: CaptionCue[] = useMemo(
    () => (captionDoc ? remapCaptions(captionDoc, view).cues : []),
    [captionDoc, view],
  );

  // --- persistence: debounced optimistic write-behind ----------------------
  const save = useCallback(
    async (target: TimelineDoc) => {
      setSaving(true);
      try {
        const response = await fetch(`/api/clips/${clipId}/timeline`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ timeline: target }),
          keepalive: true,
        });
        if (!response.ok) throw new Error(`Save failed (${response.status})`);
        lastSaved.current = target;
        if (alive.current) setError(null);
      } catch (cause) {
        if (alive.current) setError(cause instanceof Error ? cause.message : "Save failed");
      } finally {
        if (alive.current) setSaving(false);
      }
    },
    [clipId],
  );

  // Persist every doc change, debounced. Skip the first render so the fresh doc
  // (which GET deliberately does not persist) waits for a real edit.
  useEffect(() => {
    latestDoc.current = doc;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const timer = setTimeout(() => void save(doc), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [doc, save]);

  // Flush a pending edit if the editor unmounts before the debounce fires, so a
  // quick edit-then-navigate still persists (the `keepalive` fetch survives it).
  useEffect(
    () => () => {
      if (latestDoc.current !== lastSaved.current) void save(latestDoc.current);
    },
    [save],
  );

  // --- edit helpers --------------------------------------------------------
  /** Commit a new doc onto the undo stack (a no-op doc leaves history alone). */
  const commit = useCallback((next: TimelineDoc) => {
    setHistory((h) => pushHistory(h, next));
    setPreview(null);
  }, []);

  /** Run an op that may throw a {@link TimelineError}, surfacing it as a message. */
  const run = useCallback(
    (op: () => TimelineDoc) => {
      try {
        commit(op());
      } catch (cause) {
        setError(cause instanceof TimelineError ? cause.message : "Edit failed");
      }
    },
    [commit],
  );

  // --- playback / playhead -------------------------------------------------
  const seekTimeline = useCallback(
    (timelineT: number) => {
      const video = videoRef.current;
      setPlayhead(timelineT);
      playSegRef.current = segmentIndexAt(doc, timelineT);
      if (video) video.currentTime = sourceTimeAt(doc, timelineT);
    },
    [doc],
  );

  const onLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (video) video.currentTime = doc.segments[0]?.sourceIn ?? doc.bounds.in;
  }, [doc]);

  // Edited-sequence preview: while playing, each `timeupdate` steps the single
  // `<video>` through the segments in playback order, seeking over deleted ranges
  // and reordered gaps. While paused, just reflect the source clock onto the
  // playhead (native scrubbing) without yanking out of a deleted region.
  const onTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      const tl = timelineTimeAt(doc, video.currentTime);
      if (tl !== null) setPlayhead(tl);
      return;
    }
    const step = advancePlayback(doc, playSegRef.current, video.currentTime);
    playSegRef.current = step.segIndex;
    setPlayhead(step.timelineT);
    if (step.seekSource !== null) video.currentTime = step.seekSource;
    if (step.ended) {
      video.pause();
      setPlaying(false);
    }
  }, [doc]);

  // The source clock hit the end of the file mid-sequence (the last-played
  // segment sits at the tail, or the next segment is earlier in source after a
  // reorder). Advance to the queued segment and keep playing, else stop.
  const onEnded = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const step = advancePlayback(doc, playSegRef.current, video.currentTime);
    playSegRef.current = step.segIndex;
    if (step.seekSource !== null && !step.ended) {
      video.currentTime = step.seekSource;
      void video.play();
    } else {
      setPlayhead(totalDuration(doc));
      setPlaying(false);
    }
  }, [doc]);

  // Native transport (the `<video controls>` play button) can start playback
  // without going through `togglePlay`; re-seed the current segment from wherever
  // the source clock sits so `advancePlayback` steps from the right place.
  const onPlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const tl = timelineTimeAt(doc, video.currentTime);
    playSegRef.current = segmentIndexAt(doc, tl ?? playheadRef.current);
    setPlaying(true);
  }, [doc]);

  // Native transport pause (the `<video controls>` pause button) — keep the
  // B-roll overlay in step with the main player.
  const onPause = useCallback(() => setPlaying(false), []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      // (Re)start the edited sequence from the playhead, or from the top if it
      // is already parked at the end.
      const startT = playhead >= total - TIME_EPSILON ? 0 : playhead;
      playSegRef.current = segmentIndexAt(doc, startT);
      video.currentTime = sourceTimeAt(doc, startT);
      setPlayhead(startT);
      setPlaying(true);
      void video.play();
    } else {
      video.pause();
      setPlaying(false);
    }
  }, [doc, playhead, total]);

  // Re-seed the current playback segment when a structural edit (split/delete/
  // reorder/undo) changes the doc, so preview keeps stepping the right segment.
  useEffect(() => {
    playSegRef.current = segmentIndexAt(doc, playheadRef.current);
  }, [doc]);

  // Mirror the doc's audio settings onto the single player.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = doc.audio.muted;
    video.volume = Math.min(1, doc.audio.volume);
  }, [doc.audio.muted, doc.audio.volume]);

  // --- pointer geometry ----------------------------------------------------
  const stripX = useCallback((clientX: number): number => {
    const strip = stripRef.current;
    if (!strip) return 0;
    return clientX - strip.getBoundingClientRect().left;
  }, []);

  const snapTimeline = useCallback(
    (timelineT: number): number =>
      snapValue(
        timelineT,
        [...timelineCutTimes(doc), ...captionCues.map((c) => c.start), ...captionCues.map((c) => c.end)],
        SNAP_THRESHOLD_PX / pxPerSec,
      ),
    [doc, captionCues, pxPerSec],
  );

  const onRulerClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      seekTimeline(snapTimeline(xToTime(stripX(event.clientX), pxPerSec, total)));
    },
    [seekTimeline, snapTimeline, stripX, pxPerSec, total],
  );

  // Source-space snap targets for a trim: clip bounds, every OTHER segment's
  // edges, and caption cue boundaries (which are clip-relative → add bounds.in).
  const sourceSnapTargets = useCallback(
    (segId: string): number[] => {
      const edges: number[] = [doc.bounds.in, doc.bounds.out];
      for (const s of doc.segments) {
        if (s.id === segId) continue;
        edges.push(s.sourceIn, s.sourceOut);
      }
      for (const c of captionCues) edges.push(doc.bounds.in + c.start, doc.bounds.in + c.end);
      return edges;
    },
    [doc, captionCues],
  );

  const beginTrim = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, segId: string, edge: TrimEdge) => {
      const seg = doc.segments.find((s) => s.id === segId);
      if (!seg) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        kind: "trim",
        segId,
        edge,
        startX: event.clientX,
        baseSource: edge === "in" ? seg.sourceIn : seg.sourceOut,
        result: null,
      };
    },
    [doc],
  );

  const beginReorder = useCallback((event: React.PointerEvent<HTMLDivElement>, segId: string) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind: "reorder", segId, x: stripX(event.clientX) };
    setSelectedId(segId);
  }, [stripX]);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.kind === "trim") {
        const deltaSec = (event.clientX - drag.startX) / pxPerSec;
        const target = snapValue(
          drag.baseSource + deltaSec,
          sourceSnapTargets(drag.segId),
          SNAP_THRESHOLD_PX / pxPerSec,
        );
        try {
          const next = trim(doc, drag.segId, drag.edge, target);
          drag.result = next;
          setPreview(next);
        } catch {
          /* out-of-range trim target — ignore this move */
        }
      } else {
        drag.x = stripX(event.clientX);
      }
    },
    [doc, pxPerSec, sourceSnapTargets, stripX],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!drag) return;
      if (drag.kind === "trim") {
        if (drag.result) commit(drag.result);
        else setPreview(null);
      } else {
        run(() => reorder(doc, drag.segId, dropIndexAt(doc, pxPerSec, drag.x)));
      }
    },
    [commit, run, doc, pxPerSec],
  );

  // --- toolbar actions -----------------------------------------------------
  const doSplit = useCallback(() => run(() => splitAt(doc, playhead)), [run, doc, playhead]);
  const doDelete = useCallback(() => {
    if (selectedId) run(() => deleteSegment(doc, selectedId));
  }, [run, doc, selectedId]);
  const zoom = useCallback((dir: number) => setPxPerSec((p) => zoomBy(p, dir)), []);
  const frameStep = useCallback(
    (dir: number) => seekTimeline(Math.max(0, Math.min(total, playhead + dir * FRAME_STEP))),
    [seekTimeline, total, playhead],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case " ":
          event.preventDefault();
          togglePlay();
          break;
        case "s":
        case "S":
          doSplit();
          break;
        case "Delete":
        case "Backspace":
          event.preventDefault();
          doDelete();
          break;
        case "ArrowLeft":
          event.preventDefault();
          frameStep(-1);
          break;
        case "ArrowRight":
          event.preventDefault();
          frameStep(1);
          break;
      }
    },
    [togglePlay, doSplit, doDelete, frameStep],
  );

  const btn =
    "rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";

  return (
    <section
      className="flex flex-col gap-4 outline-none"
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label="Timeline editor"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Timeline
        </h2>
        <span className="font-mono text-xs tabular-nums text-zinc-400" aria-live="polite">
          {saving ? "Saving…" : formatDuration(total)}
        </span>
      </div>

      <div className="relative overflow-hidden rounded-lg bg-black">
        <video
          ref={videoRef}
          src={sourceVideoUrl(projectId)}
          controls
          preload="metadata"
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          onPlay={onPlay}
          onPause={onPause}
          onEnded={onEnded}
          className="w-full"
        />
        <BrollPreview doc={doc} playhead={playhead} playing={playing} />
        <CtaPreview doc={doc} playhead={playhead} playing={playing} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className={btn} onClick={togglePlay}>
          Play/Pause
        </button>
        <button type="button" className={btn} onClick={doSplit}>
          Split (S)
        </button>
        <button type="button" className={btn} onClick={doDelete} disabled={!selectedId || doc.segments.length <= 1}>
          Delete
        </button>
        <span className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
        <button type="button" className={btn} onClick={() => setHistory(undoHistory)} disabled={!canUndo(history)}>
          Undo
        </button>
        <button type="button" className={btn} onClick={() => setHistory(redoHistory)} disabled={!canRedo(history)}>
          Redo
        </button>
        <span className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
        <button type="button" className={btn} onClick={() => zoom(-1)} aria-label="Zoom out">
          −
        </button>
        <button type="button" className={btn} onClick={() => zoom(1)} aria-label="Zoom in">
          +
        </button>
      </div>

      <TimelineStrip
        stripRef={stripRef}
        stripWidth={stripWidth}
        boxes={boxes}
        captionCues={captionCues}
        pxPerSec={pxPerSec}
        playhead={playhead}
        total={total}
        selectedId={selectedId}
        onRulerClick={onRulerClick}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onSelect={setSelectedId}
        onReorderStart={beginReorder}
        onTrimStart={beginTrim}
      />

      {/* audio track */}
      <div className="flex items-center gap-3 text-xs text-zinc-600 dark:text-zinc-300">
        <span className="font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Audio</span>
        <button
          type="button"
          className={btn}
          onClick={() => run(() => setMuted(doc, !doc.audio.muted))}
          aria-pressed={doc.audio.muted}
        >
          {doc.audio.muted ? "Unmute" : "Mute"}
        </button>
        <input
          type="range"
          min={0}
          max={AUDIO_MAX_VOLUME}
          step={0.05}
          value={doc.audio.volume}
          onChange={(e) => run(() => setVolume(doc, Number(e.target.value)))}
          aria-label="Volume"
          className="w-40"
        />
        <span className="font-mono tabular-nums text-zinc-400">{Math.round(doc.audio.volume * 100)}%</span>
      </div>

      <TransitionsPanel doc={doc} onRun={run} />

      <BrollPanel doc={doc} projectId={projectId} playhead={playhead} onRun={run} />

      <CtaPanel doc={doc} projectId={projectId} playhead={playhead} onRun={run} />

      {error ? <p className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
    </section>
  );
}
