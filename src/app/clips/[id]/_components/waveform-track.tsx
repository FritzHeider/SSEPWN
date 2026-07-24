"use client";

import { useEffect, useState } from "react";

import { waveformSlice } from "@/lib/timeline/waveform";

/**
 * The timeline's audio-waveform track (item 14 UI). Renders the project's
 * waveform PNG as a background, stretched so the clip's `[inPoint, outPoint]`
 * window fills the strip's pixel width (all the maths in the pure `waveformSlice`
 * helper). The waveform route 404s cleanly for a project with no audio or an
 * older project without one, so the track probes the image once and hides itself
 * on error — no empty row, no broken image.
 */
export function WaveformTrack({
  projectId,
  inPoint,
  outPoint,
  durationSec,
  stripWidthPx,
}: {
  projectId: number;
  inPoint: number;
  outPoint: number;
  durationSec: number | null;
  stripWidthPx: number;
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const url = `/api/projects/${projectId}/waveform`;

  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.onload = () => {
      if (alive) setAvailable(true);
    };
    img.onerror = () => {
      if (alive) setAvailable(false);
    };
    img.src = url;
    return () => {
      alive = false;
    };
  }, [url]);

  if (available === false || !durationSec || durationSec <= 0) return null;

  const slice = waveformSlice(inPoint, outPoint, durationSec, stripWidthPx);
  if (slice.backgroundWidthPx <= 0) return null;

  return (
    <div
      data-testid="waveform-track"
      aria-hidden
      className="h-8 rounded bg-surface-raised"
      style={{
        width: stripWidthPx,
        minWidth: "100%",
        backgroundImage: available ? `url(${url})` : undefined,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${slice.backgroundWidthPx}px 100%`,
        backgroundPositionX: `${slice.offsetPx}px`,
        // Tint the transparent waveform toward the timeline blue.
        filter: "opacity(0.7) sepia(1) saturate(4) hue-rotate(190deg)",
      }}
    />
  );
}
