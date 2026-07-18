"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  centeredWindow,
  clampWindow,
  cropWindowAt,
  normaliseRect,
  type PixelRect,
} from "@/lib/crop/overlay";
import type { CropState } from "@/lib/crop/state";
import { ASPECT_RATIOS, type AspectRatio } from "@/lib/crop/types";
import { clipRelativeTime } from "@/lib/captions/preview";
import { sourceVideoUrl } from "@/lib/transcribe/panel";

/** How many times, and how far apart, "re-run auto" polls for the worker's crop. */
const POLL_TRIES = 12;
const POLL_INTERVAL_MS = 1500;

/**
 * The clip crop editor (phase-06 UI): one looping preview with the crop window
 * drawn over it, an aspect-ratio switcher, and a "re-run auto" button.
 *
 * Server truth, same discipline as the caption editor: dragging the rectangle
 * sends one keyframe to `PATCH /api/clips/:id/crop` and the response's crop
 * replaces local state; "re-run auto" enqueues a `smart-crop` job (the worker,
 * never a request handler, does the media work) and polls `GET .../crop` until the
 * new plan lands. All the geometry — sizing the window for a ratio, finding it at
 * the current time, clamping a drag into the frame — comes from the pure
 * `lib/crop/overlay` helpers, so this component only wires them to pointers and
 * the network.
 *
 * The manual keyframe the drag writes is `locked` by the API, so a later "re-run
 * auto" leaves it alone (phase-06 acceptance). We surface that with a hint rather
 * than silently no-op the button.
 */
export function CropPanel({
  clipId,
  projectId,
  inPoint,
  outPoint,
  srcWidth,
  srcHeight,
  initialCrop,
}: {
  clipId: number;
  projectId: number;
  inPoint: number;
  outPoint: number;
  srcWidth: number;
  srcHeight: number;
  initialCrop: CropState | null;
}) {
  const [crop, setCrop] = useState<CropState | null>(initialCrop);
  const [selectedAR, setSelectedAR] = useState<AspectRatio>(initialCrop?.aspectRatio ?? "9:16");
  const [relTime, setRelTime] = useState(0);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<PixelRect | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const dragStart = useRef<{ pointerX: number; pointerY: number; base: PixelRect } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Whether the persisted crop applies to the ratio currently selected. Only then
  // do we follow its keyframes; a different ratio shows a fresh centred window.
  const cropForSelected = crop && crop.aspectRatio === selectedAR ? crop : null;

  // Source space the active window is measured in: the persisted crop's own
  // dimensions when it applies, else the project's ingested size.
  const src = useMemo(
    () =>
      cropForSelected
        ? { w: cropForSelected.srcWidth, h: cropForSelected.srcHeight }
        : { w: srcWidth, h: srcHeight },
    [cropForSelected, srcWidth, srcHeight],
  );

  // The crop window (source pixels) at the current playhead: the dragged rectangle
  // while dragging, else the interpolated keyframe, else a centred default.
  const windowPx = useMemo<PixelRect | null>(() => {
    if (drag) return drag;
    if (cropForSelected) return cropWindowAt(cropForSelected.keyframes, relTime);
    if (srcWidth > 0 && srcHeight > 0) return centeredWindow(selectedAR, srcWidth, srcHeight);
    return null;
  }, [drag, cropForSelected, relTime, selectedAR, srcWidth, srcHeight]);

  const overlay = windowPx ? normaliseRect(windowPx, src.w, src.h) : null;

  const onLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (video) video.currentTime = inPoint;
  }, [inPoint]);

  const onTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    // Loop the clip window so the preview keeps cycling within [in, out].
    if (video.currentTime >= outPoint || video.currentTime < inPoint - 0.25) {
      video.currentTime = inPoint;
    }
    setRelTime(clipRelativeTime(video.currentTime, inPoint));
  }, [inPoint, outPoint]);

  const patchKeyframe = useCallback(
    async (rect: PixelRect) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(`/api/clips/${clipId}/crop`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            keyframe: { t: relTime, x: rect.x, y: rect.y, w: rect.w, h: rect.h },
            aspectRatio: selectedAR,
          }),
        });
        if (!response.ok) throw new Error(`Crop override failed (${response.status})`);
        const body = (await response.json()) as { crop: CropState };
        if (alive.current) setCrop(body.crop);
      } catch (cause) {
        if (alive.current) setError(cause instanceof Error ? cause.message : "Crop override failed");
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [clipId, relTime, selectedAR],
  );

  const rerunAuto = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const response = await fetch(`/api/clips/${clipId}/crop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aspectRatio: selectedAR }),
      });
      if (!response.ok) throw new Error(`Re-run auto failed (${response.status})`);
      // The job runs in the worker (global constraint), so the plan lands
      // asynchronously. Poll a bounded number of times, then give up — a worker
      // that is down must not spin this forever.
      for (let attempt = 0; attempt < POLL_TRIES && alive.current; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (!alive.current) return;
        const read = await fetch(`/api/clips/${clipId}/crop`, { cache: "no-store" });
        if (!read.ok) continue;
        const body = (await read.json()) as { crop: CropState | null };
        if (body.crop && body.crop.aspectRatio === selectedAR && !body.crop.locked) {
          if (alive.current) setCrop(body.crop);
          return;
        }
      }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : "Re-run auto failed");
    } finally {
      if (alive.current) setRunning(false);
    }
  }, [clipId, selectedAR]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!windowPx) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragStart.current = { pointerX: event.clientX, pointerY: event.clientY, base: windowPx };
      setDrag(windowPx);
    },
    [windowPx],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = dragStart.current;
      const container = videoRef.current;
      if (!start || !container) return;
      const box = container.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      // Pointer delta in pixels → fraction of the frame → source pixels.
      const dxPx = ((event.clientX - start.pointerX) / box.width) * src.w;
      const dyPx = ((event.clientY - start.pointerY) / box.height) * src.h;
      const { x, y } = clampWindow(
        start.base.x + dxPx,
        start.base.y + dyPx,
        start.base.w,
        start.base.h,
        src.w,
        src.h,
      );
      setDrag({ x, y, w: start.base.w, h: start.base.h });
    },
    [src.w, src.h],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = dragStart.current;
      dragStart.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      const rect = drag;
      setDrag(null);
      // Only write if the window actually moved — a click that didn't drag should
      // not lock the crop and disable auto.
      if (start && rect && (rect.x !== start.base.x || rect.y !== start.base.y)) {
        void patchKeyframe(rect);
      }
    },
    [drag, patchKeyframe],
  );

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Crop
        </h2>
        <div className="flex items-center gap-1" role="group" aria-label="Aspect ratio">
          {ASPECT_RATIOS.map((ar) => (
            <button
              key={ar}
              type="button"
              onClick={() => setSelectedAR(ar)}
              aria-pressed={selectedAR === ar}
              className={`rounded-md px-2.5 py-1 text-xs font-medium tabular-nums transition-colors ${
                selectedAR === ar
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
              }`}
            >
              {ar}
            </button>
          ))}
        </div>
      </div>

      <div className="relative overflow-hidden rounded-lg bg-black">
        <video
          ref={videoRef}
          src={sourceVideoUrl(projectId)}
          controls
          preload="metadata"
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          className="w-full"
        />
        {overlay ? (
          // The draggable crop rectangle. Its huge outward box-shadow dims
          // everything outside the window (clipped to the player by the
          // container's overflow-hidden), so the framing reads at a glance.
          <div
            aria-label={`${selectedAR} crop window — drag to reposition`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className="absolute cursor-move touch-none rounded-sm border-2 border-white/90"
            style={{
              left: `${overlay.left * 100}%`,
              top: `${overlay.top * 100}%`,
              width: `${overlay.width * 100}%`,
              height: `${overlay.height * 100}%`,
              boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)",
            }}
          />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          onClick={rerunAuto}
          disabled={running || busy}
          className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          {running ? "Re-running…" : "Re-run auto"}
        </button>
        <span className="text-zinc-500 dark:text-zinc-400">
          Drag the box to reframe at the current moment.
        </span>
        {crop?.locked ? (
          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
            Manual crop locked — re-run auto won&apos;t overwrite it
          </span>
        ) : null}
      </div>

      {error ? <p className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
    </section>
  );
}
