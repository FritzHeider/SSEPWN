"use client";

import {
  Keyboard,
  Magnet,
  Maximize2,
  Pause,
  Play,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

/**
 * The player transport + timeline toolbar (left pane, item 6). Play/pause the
 * shared player, split at the playhead, delete the selected segment, undo/redo,
 * zoom the strip and fit it to width, and toggle snapping (item 16) — plus a
 * keyboard-help button (item 11). Split and Delete keep their exact accessible
 * names ("Split (S)", "Delete") so the acceptance e2e still finds them.
 */
export function TransportBar({
  playing,
  canDelete,
  canUndo,
  canRedo,
  snapEnabled,
  onTogglePlay,
  onSplit,
  onDelete,
  onUndo,
  onRedo,
  onZoomOut,
  onZoomIn,
  onFit,
  onToggleSnap,
  onShowHelp,
}: {
  playing: boolean;
  canDelete: boolean;
  canUndo: boolean;
  canRedo: boolean;
  snapEnabled: boolean;
  onTogglePlay: () => void;
  onSplit: () => void;
  onDelete: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
  onToggleSnap: () => void;
  onShowHelp: () => void;
}) {
  const btn =
    "flex min-h-11 cursor-pointer items-center gap-1.5 rounded-md border border-border-subtle px-3 py-2 text-xs font-medium text-text transition-colors hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
  const icon =
    "flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md border border-border-subtle p-2 text-text transition-colors hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
  const divider = "mx-1 h-5 w-px bg-border-subtle";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button type="button" className={btn} onClick={onTogglePlay}>
        {playing ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
        {playing ? "Pause" : "Play"}
      </button>
      <button type="button" className={btn} onClick={onSplit}>
        <Scissors className="h-4 w-4" aria-hidden />
        Split (S)
      </button>
      <button type="button" className={btn} onClick={onDelete} disabled={!canDelete}>
        <Trash2 className="h-4 w-4" aria-hidden />
        Delete
      </button>

      <span className={divider} />

      <button type="button" className={icon} onClick={onUndo} disabled={!canUndo} aria-label="Undo">
        <Undo2 className="h-4 w-4" aria-hidden />
      </button>
      <button type="button" className={icon} onClick={onRedo} disabled={!canRedo} aria-label="Redo">
        <Redo2 className="h-4 w-4" aria-hidden />
      </button>

      <span className={divider} />

      <button type="button" className={icon} onClick={onZoomOut} aria-label="Zoom out">
        <ZoomOut className="h-4 w-4" aria-hidden />
      </button>
      <button type="button" className={icon} onClick={onZoomIn} aria-label="Zoom in">
        <ZoomIn className="h-4 w-4" aria-hidden />
      </button>
      <button type="button" className={icon} onClick={onFit} aria-label="Fit timeline to width">
        <Maximize2 className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        data-testid="snap-toggle"
        className={`${icon} ${snapEnabled ? "bg-surface-overlay text-accent" : ""}`}
        onClick={onToggleSnap}
        aria-pressed={snapEnabled}
        aria-label="Snap to edges"
      >
        <Magnet className="h-4 w-4" aria-hidden />
      </button>

      <span className={divider} />

      <button
        type="button"
        className={icon}
        onClick={onShowHelp}
        aria-label="Keyboard shortcuts"
        aria-haspopup="dialog"
      >
        <Keyboard className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
