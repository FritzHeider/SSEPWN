"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { BrollPreview } from "./broll-preview";
import { CtaPreview } from "./cta-preview";
import { SfxPreview } from "./sfx-preview";
import type { CaptionCue } from "@/lib/captions/clip";
import type { CaptionStyle } from "@/lib/captions/style";
import {
  activeWordIndex,
  displayText,
  overlayLineStyle,
  overlayWordStyle,
  overlayWrapperStyle,
} from "@/lib/captions/preview";
import { centerCropTransform, cropStageTransform, type StageTransform } from "@/lib/crop/stage";
import type { PixelRect, NormalisedRect } from "@/lib/crop/overlay";
import type { TimelineDoc } from "@/lib/timeline/types";
import { sourceVideoUrl } from "@/lib/transcribe/panel";

/** Reference video height when the project's is unknown (the ASS design height). */
const FALLBACK_REFERENCE_HEIGHT = 1080;

/** The Export-preview stage description: target aspect + the source crop window. */
export interface ExportPreview {
  /** Effective preset aspect ratio (width ÷ height). */
  targetAspect: number;
  /** The active crop window in source pixels, or `null` for a center-crop hint. */
  cropRect: PixelRect | null;
  srcWidth: number;
  srcHeight: number;
}

/** The crop overlay rectangle + its drag handlers (Crop tab, source framing only). */
export interface CropOverlayProps {
  rect: NormalisedRect;
  ariaLabel: string;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
}

/**
 * The single shared player stage (item 7): one `<video>` (source = the project
 * video) with every editor overlay composited on top of it — the live caption
 * cue, the draggable crop rectangle, and the timeline B-roll/CTA/SFX previews.
 * The old per-panel `<video>` elements are gone; this is the only one, and the
 * shell routes its playback events to whichever tab governs the clock.
 *
 * Two framings (item 8): SOURCE shows the raw frame (`w-full`); EXPORT letterboxes
 * a stage to the effective preset's aspect and transforms the video so the crop
 * window fills it (a center-crop with a hint when the clip has no crop plan). The
 * caption overlay scales from whichever framing's rendered height, so it tracks
 * either view.
 */
export function PlayerStage({
  videoRef,
  projectId,
  referenceHeight,
  onLoadedMetadata,
  onTimeUpdate,
  onPlay,
  onPause,
  onEnded,
  captionStyle,
  captionCue,
  relTime,
  showCaption,
  cropOverlay,
  previewDoc,
  previewPlayhead,
  previewPlaying,
  previewMode,
  exportPreview,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  projectId: number;
  referenceHeight: number | null;
  onLoadedMetadata: () => void;
  onTimeUpdate: () => void;
  onPlay: () => void;
  onPause: () => void;
  onEnded: () => void;
  captionStyle: CaptionStyle;
  captionCue: CaptionCue | null;
  relTime: number;
  showCaption: boolean;
  cropOverlay: CropOverlayProps | null;
  previewDoc: TimelineDoc;
  previewPlayhead: number;
  previewPlaying: boolean;
  previewMode: "source" | "export";
  exportPreview: ExportPreview | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });

  const reference = referenceHeight && referenceHeight > 0 ? referenceHeight : FALLBACK_REFERENCE_HEIGHT;

  // Track the overlay host's rendered height so the caption overlay scales with
  // whichever framing (source frame or export stage) is on screen, and its width
  // for the export-mode transform math.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      if (host.clientHeight > 0) setScale(host.clientHeight / reference);
      setStageSize({ width: host.clientWidth, height: host.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [reference, previewMode]);

  const isExport = previewMode === "export" && exportPreview !== null;

  // In export mode, scale + offset the video so the crop window fills the stage.
  const transform = useMemo<StageTransform | null>(() => {
    if (!isExport || !exportPreview || stageSize.width <= 0 || stageSize.height <= 0) return null;
    const { cropRect, srcWidth, srcHeight } = exportPreview;
    return cropRect
      ? cropStageTransform(cropRect, srcWidth, srcHeight, stageSize.width, stageSize.height)
      : centerCropTransform(srcWidth, srcHeight, stageSize.width, stageSize.height);
  }, [isExport, exportPreview, stageSize]);

  const videoStyle: React.CSSProperties = transform
    ? {
        position: "absolute",
        width: `${transform.width}px`,
        height: `${transform.height}px`,
        left: `${transform.left}px`,
        top: `${transform.top}px`,
        maxWidth: "none",
      }
    : {};

  const captionOverlay =
    showCaption && captionCue ? (
      <div data-testid="caption-overlay" style={overlayWrapperStyle(captionStyle, scale)}>
        <div className="flex flex-col items-center gap-1">
          {captionCue.lines.map((cueLine, i) => (
            <div key={i} style={overlayLineStyle(captionStyle, scale)}>
              {cueLine.words.map((w, wi) => {
                const active = activeWordIndex(cueLine, relTime) === wi;
                return (
                  <span key={wi} style={overlayWordStyle(captionStyle, active, scale)}>
                    {displayText(w.text, captionStyle)}
                    {wi < cueLine.words.length - 1 ? " " : ""}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    ) : null;

  const previews = (
    <>
      <BrollPreview doc={previewDoc} playhead={previewPlayhead} playing={previewPlaying} />
      <CtaPreview doc={previewDoc} playhead={previewPlayhead} playing={previewPlaying} />
      <SfxPreview doc={previewDoc} playhead={previewPlayhead} playing={previewPlaying} />
    </>
  );

  // In export mode before the stage is measured (no transform yet), cover the
  // stage so the frame is never a zero-size box.
  const videoClass = !isExport ? "w-full" : transform ? "" : "absolute inset-0 h-full w-full object-cover";
  const video = (
    <video
      ref={videoRef}
      src={sourceVideoUrl(projectId)}
      controls={!isExport}
      preload="metadata"
      onLoadedMetadata={onLoadedMetadata}
      onTimeUpdate={onTimeUpdate}
      onPlay={onPlay}
      onPause={onPause}
      onEnded={onEnded}
      className={videoClass}
      style={videoStyle}
    />
  );

  if (isExport && exportPreview) {
    return (
      <div className="flex justify-center rounded-lg bg-black">
        <div
          ref={hostRef}
          data-testid="preview-stage"
          className="relative overflow-hidden"
          style={{ width: "100%", maxWidth: `calc(100vh * ${exportPreview.targetAspect})`, aspectRatio: String(exportPreview.targetAspect) }}
        >
          {video}
          {captionOverlay}
          {previews}
          {!exportPreview.cropRect ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
              <span className="rounded bg-black/60 px-2 py-1 text-[11px] text-white">
                No crop plan — showing a centre crop
              </span>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div ref={hostRef} className="relative overflow-hidden rounded-lg bg-black">
      {video}
      {captionOverlay}
      {cropOverlay ? (
        <div
          aria-label={cropOverlay.ariaLabel}
          onPointerDown={cropOverlay.onPointerDown}
          onPointerMove={cropOverlay.onPointerMove}
          onPointerUp={cropOverlay.onPointerUp}
          className="absolute cursor-move touch-none rounded-sm border-2 border-white/90"
          style={{
            left: `${cropOverlay.rect.left * 100}%`,
            top: `${cropOverlay.rect.top * 100}%`,
            width: `${cropOverlay.rect.width * 100}%`,
            height: `${cropOverlay.rect.height * 100}%`,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)",
          }}
        />
      ) : null}
      {previews}
    </div>
  );
}
