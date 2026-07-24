"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { CaptionCue } from "@/lib/captions/clip";
import type { CaptionDoc } from "@/lib/captions/ass";
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
import { remapCaptions } from "@/lib/timeline/captions";
import { advancePlayback, segmentIndexAt } from "@/lib/timeline/playback";
import {
  DEFAULT_PX_PER_SEC,
  SNAP_THRESHOLD_PX,
  clampPxPerSec,
  dropIndexAt,
  segmentLayout,
  snapValue,
  timelineCutTimes,
  timeToX,
  xToTime,
  zoomBy,
  type SegmentBox,
} from "@/lib/timeline/strip";
import {
  TIME_EPSILON,
  TimelineError,
  type TimelineDoc,
  type TrimEdge,
} from "@/lib/timeline/types";

/** Debounce before the optimistic doc is written back to the server. */
const SAVE_DEBOUNCE_MS = 500;
/** One "frame" for ←/→ stepping (30 fps); no project fps is known here. */
const FRAME_STEP = 1 / 30;

interface TrimDrag {
  kind: "trim";
  segId: string;
  edge: TrimEdge;
  startX: number;
  baseSource: number;
  result: TimelineDoc | null;
}
interface ReorderDrag {
  kind: "reorder";
  segId: string;
  x: number;
}
type Drag = TrimDrag | ReorderDrag;

/**
 * The timeline editor's state + behaviour, extracted from the old `TimelinePanel`
 * so the single shared `<video>` (owned by `EditorShell`) can drive it. All the
 * pure `lib/timeline` ops, the undo history, the debounced write-behind, and the
 * `advancePlayback` segment stepping are unchanged — only the `<video>` ELEMENT
 * moved up. The hook exposes the player-event handlers (`handleTimeUpdate`,
 * `handleEnded`, …) for the shell to route to WHEN the Timeline tab governs
 * playback, plus the strip geometry and edit actions the panels render.
 *
 * `snapEnabled` gates snapping (item 16): when off, the snap threshold collapses
 * to zero so drags move freely; when a drag lands on a target, `snapGuideX`
 * carries the strip-x of that target so the strip can draw an accent guide line.
 */
export function useTimeline({
  videoRef,
  clipId,
  initialDoc,
  captionDoc,
  snapEnabled,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  clipId: number;
  initialDoc: TimelineDoc;
  captionDoc: CaptionDoc | null;
  snapEnabled: boolean;
}) {
  const [history, setHistory] = useState<TimelineHistory>(() => createHistory(initialDoc));
  const [preview, setPreview] = useState<TimelineDoc | null>(null);
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [selectedId, setSelectedId] = useState<string | null>(initialDoc.segments[0]?.id ?? null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [snapGuideX, setSnapGuideX] = useState<number | null>(null);

  const doc = history.present;
  const view = preview ?? doc;

  const stripRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const alive = useRef(true);
  const firstRender = useRef(true);
  const latestDoc = useRef(doc);
  const lastSaved = useRef(initialDoc);
  const playSegRef = useRef(0);
  const playheadRef = useRef(0);
  const snapEnabledRef = useRef(snapEnabled);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);
  useEffect(() => {
    snapEnabledRef.current = snapEnabled;
  }, [snapEnabled]);

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

  useEffect(() => {
    latestDoc.current = doc;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const timer = setTimeout(() => void save(doc), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [doc, save]);

  useEffect(
    () => () => {
      if (latestDoc.current !== lastSaved.current) void save(latestDoc.current);
    },
    [save],
  );

  // --- edit helpers --------------------------------------------------------
  const commit = useCallback((next: TimelineDoc) => {
    setHistory((h) => pushHistory(h, next));
    setPreview(null);
  }, []);

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
    [doc, videoRef],
  );

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (video) video.currentTime = doc.segments[0]?.sourceIn ?? doc.bounds.in;
  }, [doc, videoRef]);

  const handleTimeUpdate = useCallback(() => {
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
  }, [doc, videoRef]);

  const handleEnded = useCallback(() => {
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
  }, [doc, videoRef]);

  const handlePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const tl = timelineTimeAt(doc, video.currentTime);
    playSegRef.current = segmentIndexAt(doc, tl ?? playheadRef.current);
    setPlaying(true);
  }, [doc, videoRef]);

  const handlePause = useCallback(() => setPlaying(false), []);

  const stop = useCallback(() => {
    const video = videoRef.current;
    if (video && !video.paused) video.pause();
    setPlaying(false);
  }, [videoRef]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
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
  }, [doc, playhead, total, videoRef]);

  // Re-seed the current playback segment after a structural edit.
  useEffect(() => {
    playSegRef.current = segmentIndexAt(doc, playheadRef.current);
  }, [doc]);

  // Mirror the doc's audio settings onto the single player.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = doc.audio.muted;
    video.volume = Math.min(1, doc.audio.volume);
  }, [doc.audio.muted, doc.audio.volume, videoRef]);

  // --- pointer geometry ----------------------------------------------------
  const stripX = useCallback((clientX: number): number => {
    const strip = stripRef.current;
    if (!strip) return 0;
    return clientX - strip.getBoundingClientRect().left;
  }, []);

  const snapThreshold = useCallback(
    () => (snapEnabledRef.current ? SNAP_THRESHOLD_PX / pxPerSec : 0),
    [pxPerSec],
  );

  const timelineSnapTargets = useCallback(
    (): number[] => [
      ...timelineCutTimes(doc),
      ...captionCues.map((c) => c.start),
      ...captionCues.map((c) => c.end),
    ],
    [doc, captionCues],
  );

  const snapTimeline = useCallback(
    (timelineT: number): number => snapValue(timelineT, timelineSnapTargets(), snapThreshold()),
    [timelineSnapTargets, snapThreshold],
  );

  const onRulerClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      seekTimeline(snapTimeline(xToTime(stripX(event.clientX), pxPerSec, total)));
    },
    [seekTimeline, snapTimeline, stripX, pxPerSec, total],
  );

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

  const beginReorder = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, segId: string) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { kind: "reorder", segId, x: stripX(event.clientX) };
      setSelectedId(segId);
    },
    [stripX],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.kind === "trim") {
        const deltaSec = (event.clientX - drag.startX) / pxPerSec;
        const raw = drag.baseSource + deltaSec;
        const target = snapValue(raw, sourceSnapTargets(drag.segId), snapThreshold());
        // Surface the snap guide (source-space target → timeline-space x) when the
        // drag actually locked onto a target.
        if (snapEnabledRef.current && target !== raw) {
          const tl = timelineTimeAt(doc, target);
          setSnapGuideX(tl === null ? null : timeToX(tl, pxPerSec));
        } else {
          setSnapGuideX(null);
        }
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
    [doc, pxPerSec, sourceSnapTargets, snapThreshold, stripX],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      setSnapGuideX(null);
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
  const fitToWidth = useCallback(() => {
    const strip = stripRef.current;
    const width = strip?.clientWidth ?? 0;
    if (width > 0 && total > 0) setPxPerSec(clampPxPerSec(width / total));
  }, [total]);
  const frameStep = useCallback(
    (dir: number) => seekTimeline(Math.max(0, Math.min(total, playhead + dir * FRAME_STEP))),
    [seekTimeline, total, playhead],
  );
  const undo = useCallback(() => setHistory(undoHistory), []);
  const redo = useCallback(() => setHistory(redoHistory), []);
  const toggleMute = useCallback(() => run(() => setMuted(doc, !doc.audio.muted)), [run, doc]);
  const changeVolume = useCallback((v: number) => run(() => setVolume(doc, v)), [run, doc]);

  // Set the selected segment's in/out edge to the current playhead (I/O keys).
  const trimSelectedToPlayhead = useCallback(
    (edge: TrimEdge) => {
      if (!selectedId) return;
      run(() => trim(doc, selectedId, edge, sourceTimeAt(doc, playhead)));
    },
    [run, doc, selectedId, playhead],
  );

  return {
    // state
    doc,
    view,
    playhead,
    playing,
    selectedId,
    setSelectedId,
    pxPerSec,
    total,
    boxes,
    stripWidth,
    captionCues,
    snapGuideX,
    error,
    saving,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    // refs
    stripRef,
    // player-event handlers (routed by the shell when the Timeline tab governs)
    handleLoadedMetadata,
    handleTimeUpdate,
    handleEnded,
    handlePlay,
    handlePause,
    // actions
    seekTimeline,
    togglePlay,
    stop,
    doSplit,
    doDelete,
    zoom,
    fitToWidth,
    frameStep,
    trimSelectedToPlayhead,
    undo,
    redo,
    toggleMute,
    changeVolume,
    run,
    // strip pointer handlers
    onRulerClick,
    onPointerMove,
    onPointerUp,
    beginTrim,
    beginReorder,
  };
}

export type TimelineController = ReturnType<typeof useTimeline>;
export type { SegmentBox };
