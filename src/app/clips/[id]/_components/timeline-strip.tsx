"use client";

import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";

import type { CaptionCue } from "@/lib/captions/clip";
import { formatDuration } from "@/lib/projects/view";
import { timeToX, type SegmentBox } from "@/lib/timeline/strip";
import type { TrimEdge } from "@/lib/timeline/types";

/**
 * The scrollable timeline strip: a ruler, the video-segment track (with trim
 * handles), the caption track, an overlay placeholder, and the playhead — every
 * track the same pixel width so the playhead lines up across them. Purely
 * presentational: all geometry and handlers come from {@link TimelinePanel},
 * which owns the doc, history, and pointer state.
 */
export function TimelineStrip({
  stripRef,
  stripWidth,
  boxes,
  captionCues,
  pxPerSec,
  playhead,
  total,
  selectedId,
  onRulerClick,
  onPointerMove,
  onPointerUp,
  onSelect,
  onReorderStart,
  onTrimStart,
}: {
  stripRef: RefObject<HTMLDivElement | null>;
  stripWidth: number;
  boxes: SegmentBox[];
  captionCues: CaptionCue[];
  pxPerSec: number;
  playhead: number;
  total: number;
  selectedId: string | null;
  onRulerClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSelect: (segId: string) => void;
  onReorderStart: (event: ReactPointerEvent<HTMLDivElement>, segId: string) => void;
  onTrimStart: (event: ReactPointerEvent<HTMLDivElement>, segId: string, edge: TrimEdge) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
      <div ref={stripRef} className="relative" style={{ width: stripWidth, minWidth: "100%" }}>
        <div
          onClick={onRulerClick}
          className="relative h-6 cursor-pointer border-b border-zinc-200 dark:border-zinc-800"
          aria-label="Seek bar"
        />

        <div
          className="relative h-16 border-b border-zinc-200 dark:border-zinc-800"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {boxes.map((box) => (
            <div
              key={box.id}
              onPointerDown={(e) => onReorderStart(e, box.id)}
              onClick={() => onSelect(box.id)}
              className={`absolute top-1 bottom-1 flex touch-none flex-col justify-center overflow-hidden rounded-md border px-2 text-[10px] tabular-nums ${
                selectedId === box.id
                  ? "border-blue-500 bg-blue-100 dark:border-blue-400 dark:bg-blue-950"
                  : "border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900"
              }`}
              style={{ left: box.leftPx, width: box.widthPx }}
            >
              <span className="pointer-events-none truncate font-medium text-zinc-700 dark:text-zinc-200">
                {box.id}
              </span>
              <span className="pointer-events-none truncate text-zinc-400">
                {formatDuration(box.sourceIn)}–{formatDuration(box.sourceOut)}
              </span>
              <div
                onPointerDown={(e) => onTrimStart(e, box.id, "in")}
                className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize touch-none bg-blue-500/70 hover:bg-blue-500"
                aria-label={`Trim ${box.id} start`}
              />
              <div
                onPointerDown={(e) => onTrimStart(e, box.id, "out")}
                className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize touch-none bg-blue-500/70 hover:bg-blue-500"
                aria-label={`Trim ${box.id} end`}
              />
            </div>
          ))}
        </div>

        <div className="relative h-8 border-b border-zinc-200 dark:border-zinc-800">
          {captionCues.map((cue, i) => (
            <div
              key={i}
              className="absolute top-1 bottom-1 overflow-hidden rounded bg-emerald-100 px-1 text-[10px] leading-6 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
              style={{ left: timeToX(cue.start, pxPerSec), width: Math.max(2, (cue.end - cue.start) * pxPerSec) }}
              title={cue.lines.map((l) => l.text).join(" ")}
            >
              <span className="truncate">{cue.lines.map((l) => l.text).join(" ")}</span>
            </div>
          ))}
        </div>

        <div className="relative flex h-6 items-center px-2 text-[10px] uppercase tracking-wide text-zinc-300 dark:text-zinc-600">
          Overlays · Phase 08
        </div>

        <div
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-red-500"
          style={{ left: timeToX(Math.min(playhead, total), pxPerSec) }}
        />
      </div>
    </div>
  );
}
