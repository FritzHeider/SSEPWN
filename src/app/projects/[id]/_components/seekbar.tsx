"use client";

import { useCallback, useRef } from "react";

import {
  NUDGE_STEP_SEC,
  clampIn,
  clampOut,
  formatTimecode,
  nudge,
  pxToSeconds,
  secondsToPercent,
} from "@/lib/projects/seekbar";

/**
 * Custom scrub bar under the project video (item 12): a track showing the
 * buffered and played positions, click/drag to seek, and draggable IN/OUT
 * handles two-way-bound to the workspace's mark-in/mark-out state (the same
 * state the clips panel's "Mark in/out from playhead" buttons drive).
 *
 * All the geometry and clamping is in `lib/projects/seekbar.ts`; this component
 * only turns pointer and keyboard events into calls on those pure functions.
 * The handles are `role="slider"` with arrow-key nudging and a timecode
 * `aria-valuetext`, so the range is markable without a mouse.
 */
export function Seekbar({
  duration,
  currentTime,
  buffered,
  markIn,
  markOut,
  onSeek,
  onMarkIn,
  onMarkOut,
}: {
  duration: number;
  currentTime: number;
  buffered: number;
  markIn: number | null;
  markOut: number | null;
  onSeek: (seconds: number) => void;
  onMarkIn: (seconds: number) => void;
  onMarkOut: (seconds: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<"in" | "out" | "seek" | null>(null);

  const ready = Number.isFinite(duration) && duration > 0;

  const secondsAt = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return 0;
      return pxToSeconds(clientX - rect.left, rect.width, duration);
    },
    [duration],
  );

  const onTrackPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!ready) return;
      dragging.current = "seek";
      trackRef.current?.setPointerCapture(event.pointerId);
      onSeek(secondsAt(event.clientX));
    },
    [ready, onSeek, secondsAt],
  );

  const onTrackPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (dragging.current !== "seek") return;
      onSeek(secondsAt(event.clientX));
    },
    [onSeek, secondsAt],
  );

  // Which handle an event belongs to comes from the button's `data-handle`, so a
  // single stable handler serves both — no per-render factory that would read a
  // ref during render.
  const handleOf = (event: { currentTarget: EventTarget | null }): "in" | "out" | null => {
    const value = (event.currentTarget as HTMLElement | null)?.dataset.handle;
    return value === "in" || value === "out" ? value : null;
  };

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!ready) return;
      const which = handleOf(event);
      if (!which) return;
      event.stopPropagation();
      dragging.current = which;
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    },
    [ready],
  );

  const onHandlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      const which = dragging.current;
      if ((which !== "in" && which !== "out") || handleOf(event) !== which) return;
      const seconds = secondsAt(event.clientX);
      if (which === "in") onMarkIn(clampIn(seconds, markOut, duration));
      else onMarkOut(clampOut(seconds, markIn, duration));
    },
    [secondsAt, onMarkIn, onMarkOut, markIn, markOut, duration],
  );

  const endDrag = useCallback(() => {
    dragging.current = null;
  }, []);

  const onHandleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const which = handleOf(event);
      if (!which) return;
      let delta = 0;
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") delta = -NUDGE_STEP_SEC;
      else if (event.key === "ArrowRight" || event.key === "ArrowUp") delta = NUDGE_STEP_SEC;
      else return;
      event.preventDefault();
      const value = which === "in" ? markIn ?? 0 : markOut ?? 0;
      const next = nudge(value, delta, duration);
      if (which === "in") onMarkIn(clampIn(next, markOut, duration));
      else onMarkOut(clampOut(next, markIn, duration));
    },
    [markIn, markOut, duration, onMarkIn, onMarkOut],
  );

  const playedPct = secondsToPercent(currentTime, duration);
  const bufferedPct = secondsToPercent(buffered, duration);
  const inPct = markIn === null ? null : secondsToPercent(markIn, duration);
  const outPct = markOut === null ? null : secondsToPercent(markOut, duration);
  const bandLeft = inPct ?? 0;
  const bandRight = outPct ?? 100;

  return (
    <div data-testid="seekbar" className="flex flex-col gap-1.5">
      <div
        ref={trackRef}
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={`relative h-6 select-none ${ready ? "cursor-pointer" : "cursor-default opacity-60"}`}
      >
        {/* Track */}
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-[var(--surface-overlay)]">
          <div className="absolute inset-y-0 left-0 bg-[color-mix(in_oklab,var(--text-muted)_40%,transparent)]" style={{ width: `${bufferedPct}%` }} />
          <div className="absolute inset-y-0 left-0 bg-[var(--timeline)]" style={{ width: `${playedPct}%` }} />
        </div>

        {/* Marked in/out band */}
        {inPct !== null || outPct !== null ? (
          <div
            aria-hidden
            className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-sm bg-[color-mix(in_oklab,var(--accent)_28%,transparent)]"
            style={{ left: `${Math.min(bandLeft, bandRight)}%`, width: `${Math.abs(bandRight - bandLeft)}%` }}
          />
        ) : null}

        {inPct !== null ? (
          <button
            type="button"
            role="slider"
            data-handle="in"
            aria-label="Clip in-point"
            aria-valuemin={0}
            aria-valuemax={ready ? Math.round(duration) : 0}
            aria-valuenow={markIn ?? 0}
            aria-valuetext={formatTimecode(markIn ?? 0)}
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={onHandleKeyDown}
            style={{ left: `${inPct}%` }}
            className="absolute top-1/2 h-5 w-3 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm border border-[var(--accent-contrast)] bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          />
        ) : null}
        {outPct !== null ? (
          <button
            type="button"
            role="slider"
            data-handle="out"
            aria-label="Clip out-point"
            aria-valuemin={0}
            aria-valuemax={ready ? Math.round(duration) : 0}
            aria-valuenow={markOut ?? 0}
            aria-valuetext={formatTimecode(markOut ?? 0)}
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={onHandleKeyDown}
            style={{ left: `${outPct}%` }}
            className="absolute top-1/2 h-5 w-3 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm border border-[var(--accent-contrast)] bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          />
        ) : null}
      </div>
    </div>
  );
}
