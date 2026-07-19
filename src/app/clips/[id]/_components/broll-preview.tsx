"use client";

import { useEffect, useRef } from "react";

import type { BrollSlot } from "@/lib/timeline/broll";
import { activeBrollAt, assetFileUrl, brollLocalTime, pipBoxPercent } from "@/lib/timeline/broll-view";
import type { TimelineDoc } from "@/lib/timeline/types";

/** How far the overlay `<video>` may drift from the target before we re-seek.
 * Seeking every frame stutters; a quarter second keeps preview close enough. */
const SEEK_TOLERANCE = 0.25;

/**
 * One B-roll layer: a muted `<video>` positioned over the main preview. `full`
 * fills the frame (replacing the main video image; main audio keeps playing);
 * `pip` is a floating box. The element owns a single ref so the effects that
 * seek and play it are lint-clean (no dynamic ref map). Preview is an
 * approximation — `renderPlan` is the ground truth (SPEC Phase 08).
 */
function BrollLayer({ slot, playhead, playing }: { slot: BrollSlot; playhead: number; playing: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Keep the overlay roughly in sync with the timeline playhead: seek only when
  // it has drifted past the tolerance so a paused scrub still tracks while a
  // playing overlay is left to run.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const target = brollLocalTime(slot, playhead);
    if (Math.abs(video.currentTime - target) > SEEK_TOLERANCE) {
      video.currentTime = target;
    }
  }, [slot, playhead]);

  // Mirror the main transport: play while the sequence is playing, pause
  // otherwise. The overlay is muted, so this never competes with the main audio.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) void video.play().catch(() => {});
    else video.pause();
  }, [playing]);

  const box = slot.mode === "pip" ? pipBoxPercent(slot.pip) : null;
  const style = box
    ? { left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }
    : { inset: 0 };

  return (
    <video
      ref={videoRef}
      src={assetFileUrl(slot.assetId)}
      muted
      playsInline
      preload="metadata"
      data-testid="broll-preview"
      data-broll-id={slot.id}
      data-broll-mode={slot.mode}
      className={
        slot.mode === "pip"
          ? "absolute rounded-md object-cover shadow-lg ring-1 ring-white/30"
          : "absolute h-full w-full object-cover"
      }
      style={style}
    />
  );
}

/**
 * The B-roll preview overlay: every slot active at the playhead, positioned over
 * the main `<video>`. Rendered inside a `relative` frame wrapper in the timeline
 * panel; `pointer-events-none` so the underlying transport stays clickable.
 */
export function BrollPreview({
  doc,
  playhead,
  playing,
}: {
  doc: TimelineDoc;
  playhead: number;
  playing: boolean;
}) {
  const active = activeBrollAt(doc, playhead);
  if (active.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0" data-testid="broll-overlay">
      {active.map((slot) => (
        <BrollLayer key={slot.id} slot={slot} playhead={playhead} playing={playing} />
      ))}
    </div>
  );
}
