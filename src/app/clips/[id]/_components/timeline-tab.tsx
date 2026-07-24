"use client";

import { Volume2, VolumeX } from "lucide-react";

import { BrollPanel } from "./broll-panel";
import { CtaPanel } from "./cta-panel";
import { SfxPanel } from "./sfx-panel";
import { TransitionsPanel } from "./transitions-panel";
import type { TimelineController } from "./use-timeline";
import { AUDIO_MAX_VOLUME } from "@/lib/timeline/types";

/**
 * The Timeline tab (right pane): the clip's audio controls plus the Phase-08
 * overlay/transition/SFX sub-editors. The strip, transport, and playhead live in
 * the left pane; this tab hosts the per-track editors, all driven through the
 * shared {@link TimelineController} (`doc`, `playhead`, and its error-catching
 * `run` committer) so every edit lands on the one timeline document.
 */
export function TimelineTab({
  timeline,
  projectId,
}: {
  timeline: TimelineController;
  projectId: number;
}) {
  const { doc, playhead, run } = timeline;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-wrap items-center gap-3 text-xs" aria-label="Audio">
        <span className="font-semibold uppercase tracking-wide text-text-muted">Audio</span>
        <button
          type="button"
          onClick={timeline.toggleMute}
          aria-pressed={doc.audio.muted}
          className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 font-medium text-text transition-colors hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {doc.audio.muted ? <VolumeX className="h-4 w-4" aria-hidden /> : <Volume2 className="h-4 w-4" aria-hidden />}
          {doc.audio.muted ? "Unmute" : "Mute"}
        </button>
        <input
          type="range"
          min={0}
          max={AUDIO_MAX_VOLUME}
          step={0.05}
          value={doc.audio.volume}
          onChange={(e) => timeline.changeVolume(Number(e.target.value))}
          aria-label="Volume"
          className="w-40 cursor-pointer accent-accent"
        />
        <span className="font-mono tabular-nums text-text-muted">{Math.round(doc.audio.volume * 100)}%</span>
      </section>

      <TransitionsPanel doc={doc} onRun={run} />
      <BrollPanel doc={doc} projectId={projectId} playhead={playhead} onRun={run} />
      <CtaPanel doc={doc} projectId={projectId} playhead={playhead} onRun={run} />
      <SfxPanel doc={doc} projectId={projectId} playhead={playhead} onRun={run} />

      {timeline.error ? <p className="text-sm text-danger">{timeline.error}</p> : null}
    </div>
  );
}
