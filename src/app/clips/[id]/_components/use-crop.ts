"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import {
  centeredWindow,
  clampWindow,
  cropWindowAt,
  normaliseRect,
  type PixelRect,
} from "@/lib/crop/overlay";
import type { CropState } from "@/lib/crop/state";
import type { AspectRatio } from "@/lib/crop/types";

/** How many times, and how far apart, "re-run auto" polls for the worker's crop. */
const POLL_TRIES = 12;
const POLL_INTERVAL_MS = 1500;

/**
 * The crop editor's state + server sync, extracted from the old `CropPanel` so the
 * single shared `<video>` (owned by `EditorShell`) hosts the draggable crop
 * rectangle. All the geometry still comes from the pure `lib/crop/overlay`
 * helpers, dragging still PATCHes one keyframe (which the API `locks`), and
 * "re-run auto" still enqueues a `smart-crop` job and polls — only the `<video>`
 * ELEMENT moved up. `relTime` (the shared clip clock) is passed in so the overlay
 * tracks the playhead; `dragging` lets the shell hide the caption overlay while a
 * reframe drag is in progress.
 */
export function useCrop({
  videoRef,
  clipId,
  srcWidth,
  srcHeight,
  initialCrop,
  relTime,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  clipId: number;
  srcWidth: number;
  srcHeight: number;
  initialCrop: CropState | null;
  relTime: number;
}) {
  const [crop, setCrop] = useState<CropState | null>(initialCrop);
  const [selectedAR, setSelectedAR] = useState<AspectRatio>(initialCrop?.aspectRatio ?? "9:16");
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<PixelRect | null>(null);

  const dragStart = useRef<{ pointerX: number; pointerY: number; base: PixelRect } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const cropForSelected = crop && crop.aspectRatio === selectedAR ? crop : null;

  const src = useMemo(
    () =>
      cropForSelected
        ? { w: cropForSelected.srcWidth, h: cropForSelected.srcHeight }
        : { w: srcWidth, h: srcHeight },
    [cropForSelected, srcWidth, srcHeight],
  );

  const windowPx = useMemo<PixelRect | null>(() => {
    if (drag) return drag;
    if (cropForSelected) return cropWindowAt(cropForSelected.keyframes, relTime);
    if (srcWidth > 0 && srcHeight > 0) return centeredWindow(selectedAR, srcWidth, srcHeight);
    return null;
  }, [drag, cropForSelected, relTime, selectedAR, srcWidth, srcHeight]);

  const overlay = windowPx ? normaliseRect(windowPx, src.w, src.h) : null;

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
    [src.w, src.h, videoRef],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = dragStart.current;
      dragStart.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const rect = drag;
      setDrag(null);
      if (start && rect && (rect.x !== start.base.x || rect.y !== start.base.y)) {
        void patchKeyframe(rect);
      }
    },
    [drag, patchKeyframe],
  );

  return {
    crop,
    selectedAR,
    setSelectedAR,
    overlay,
    windowPx,
    srcSpace: src,
    hasCropForSelected: cropForSelected !== null,
    dragging: drag !== null,
    busy,
    running,
    error,
    rerunAuto,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}

export type CropController = ReturnType<typeof useCrop>;
