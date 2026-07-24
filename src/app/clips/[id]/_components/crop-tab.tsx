"use client";

import { Crop, RefreshCw } from "lucide-react";

import type { CropController } from "./use-crop";
import { ASPECT_RATIOS } from "@/lib/crop/types";

/**
 * The Crop tab (right pane): the aspect-ratio switcher, the "re-run auto" action
 * and its locked-keyframe hint, plus the Source/Export preview-mode toggle (item
 * 8). The draggable crop rectangle itself lives on the shared player; this panel
 * only drives the crop {@link CropController} and the shell's preview mode. The
 * crop overlay is always drawn in SOURCE framing so a reframe drag has the whole
 * frame to work in, so switching to Export here previews the framed result rather
 * than enabling a drag over the letterboxed stage.
 */
export function CropTab({
  crop,
  previewMode,
  onPreviewMode,
}: {
  crop: CropController;
  previewMode: "source" | "export";
  onPreviewMode: (mode: "source" | "export") => void;
}) {
  const arBtn = (pressed: boolean) =>
    `cursor-pointer rounded-md px-2.5 py-1.5 text-xs font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
      pressed ? "bg-accent text-accent-contrast" : "bg-surface-overlay text-text hover:bg-border-subtle"
    }`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1" role="group" aria-label="Aspect ratio">
          {ASPECT_RATIOS.map((ar) => (
            <button
              key={ar}
              type="button"
              onClick={() => crop.setSelectedAR(ar)}
              aria-pressed={crop.selectedAR === ar}
              className={arBtn(crop.selectedAR === ar)}
            >
              {ar}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1" role="group" aria-label="Preview framing" data-testid="preview-mode">
          <button
            type="button"
            onClick={() => onPreviewMode("source")}
            aria-pressed={previewMode === "source"}
            className={arBtn(previewMode === "source")}
          >
            Source
          </button>
          <button
            type="button"
            onClick={() => onPreviewMode("export")}
            aria-pressed={previewMode === "export"}
            className={arBtn(previewMode === "export")}
          >
            Export
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          onClick={crop.rerunAuto}
          disabled={crop.running || crop.busy}
          className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 font-medium text-text transition-colors hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${crop.running ? "motion-safe:animate-spin motion-reduce:animate-pulse" : ""}`}
            aria-hidden
          />
          {crop.running ? "Re-running…" : "Re-run auto"}
        </button>
        <span className="flex items-center gap-1 text-text-muted">
          <Crop className="h-3.5 w-3.5" aria-hidden />
          Drag the box on the player to reframe at the current moment.
        </span>
        {crop.crop?.locked ? (
          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-accent">
            Manual crop locked — re-run auto won&apos;t overwrite it
          </span>
        ) : null}
      </div>

      {crop.error ? <p className="text-sm text-danger">{crop.error}</p> : null}
    </div>
  );
}
