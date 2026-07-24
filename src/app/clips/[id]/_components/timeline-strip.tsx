"use client";

import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";

import { WaveformTrack } from "./waveform-track";
import type { CaptionCue } from "@/lib/captions/clip";
import { formatDuration } from "@/lib/projects/view";
import { timeToX, type SegmentBox } from "@/lib/timeline/strip";
import type { TrimEdge } from "@/lib/timeline/types";

/**
 * The scrollable timeline strip: a ruler, the video-segment track (with trim
 * handles), a caption track, the project waveform track (item 14), and the
 * playhead — every track the same pixel width so the playhead lines up across
 * them. When a trim drag snaps to a target the strip draws an accent guide line
 * at that x (item 16). Purely presentational: all geometry and handlers come from
 * the shared timeline controller.
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
  snapGuideX,
  projectId,
  inPoint,
  outPoint,
  durationSec,
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
  snapGuideX: number | null;
  projectId: number;
  inPoint: number;
  outPoint: number;
  durationSec: number | null;
  onRulerClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSelect: (segId: string) => void;
  onReorderStart: (event: ReactPointerEvent<HTMLDivElement>, segId: string) => void;
  onTrimStart: (event: ReactPointerEvent<HTMLDivElement>, segId: string, edge: TrimEdge) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface-raised">
      <div ref={stripRef} className="relative" style={{ width: stripWidth, minWidth: "100%" }}>
        <div
          onClick={onRulerClick}
          className="relative h-6 cursor-pointer border-b border-border-subtle"
          aria-label="Seek bar"
        />

        <div
          className="relative h-16 border-b border-border-subtle"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {boxes.map((box) => (
            <div
              key={box.id}
              data-testid="timeline-segment"
              data-segment-id={box.id}
              onPointerDown={(e) => onReorderStart(e, box.id)}
              onClick={() => onSelect(box.id)}
              className={`absolute top-1 bottom-1 flex cursor-grab touch-none flex-col justify-center overflow-hidden rounded-md border px-2 text-[10px] tabular-nums active:cursor-grabbing ${
                selectedId === box.id
                  ? "border-accent bg-accent/15"
                  : "border-border-subtle bg-surface-overlay"
              }`}
              style={{ left: box.leftPx, width: box.widthPx }}
            >
              <span className="pointer-events-none truncate font-medium text-text">{box.id}</span>
              <span className="pointer-events-none truncate text-text-muted">
                {formatDuration(box.sourceIn)}–{formatDuration(box.sourceOut)}
              </span>
              <div
                onPointerDown={(e) => onTrimStart(e, box.id, "in")}
                className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize touch-none bg-timeline/70 hover:bg-timeline"
                aria-label={`Trim ${box.id} start`}
              />
              <div
                onPointerDown={(e) => onTrimStart(e, box.id, "out")}
                className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize touch-none bg-timeline/70 hover:bg-timeline"
                aria-label={`Trim ${box.id} end`}
              />
            </div>
          ))}
        </div>

        <div className="relative h-8 border-b border-border-subtle">
          {captionCues.map((cue, i) => (
            <div
              key={i}
              className="absolute top-1 bottom-1 overflow-hidden rounded bg-success/20 px-1 text-[10px] leading-6 text-success"
              style={{ left: timeToX(cue.start, pxPerSec), width: Math.max(2, (cue.end - cue.start) * pxPerSec) }}
              title={cue.lines.map((l) => l.text).join(" ")}
            >
              <span className="truncate">{cue.lines.map((l) => l.text).join(" ")}</span>
            </div>
          ))}
        </div>

        <div className="p-1">
          <WaveformTrack
            projectId={projectId}
            inPoint={inPoint}
            outPoint={outPoint}
            durationSec={durationSec}
            stripWidthPx={stripWidth}
          />
        </div>

        {snapGuideX !== null ? (
          <div
            data-testid="snap-guide"
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-accent"
            style={{ left: snapGuideX }}
          />
        ) : null}

        <div
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-timeline"
          style={{ left: timeToX(Math.min(playhead, total), pxPerSec) }}
        />
      </div>
    </div>
  );
}
