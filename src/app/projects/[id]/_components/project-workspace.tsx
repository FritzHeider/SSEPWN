"use client";

import { useCallback, useRef, useState } from "react";

import { ClipsPanel } from "./clips-panel";
import type { ProjectClip } from "@/lib/projects/clips";
import { shouldPausePreview } from "@/lib/projects/clips-panel";
import type { ProjectTranscript } from "@/lib/projects/transcript";
import {
  NO_ACTIVE_SEGMENT,
  activeSegmentIndex,
  captionsDisabledMessage,
  emptyTranscriptMessage,
  formatTimestamp,
  sourceVideoUrl,
} from "@/lib/transcribe/panel";

/**
 * The project page's interactive half: one <video> shared by the transcript and
 * the clips panel.
 *
 * The video lives here, not inside either panel, because both need it and the
 * spec's clip preview is "in the player" — the same element the transcript seeks
 * (DEC-005 keeps the decisions in pure libs; this component only wires them to
 * the element). A transcript click seeks without playing ("show me this
 * moment"); a clip click seeks AND plays, then pauses itself at the out-point
 * via the element's own `timeupdate` clock, so the pause cannot drift from the
 * frame on screen.
 */
export function ProjectWorkspace({
  projectId,
  duration,
  hasAudio,
  generationComplete,
  transcript,
  initialClips,
}: {
  projectId: number;
  duration: number | null;
  /** null until the ingest probe runs; false disables captions with a reason. */
  hasAudio: boolean | null;
  /** True once generate-clips has finished — drives the zero-highlight offer. */
  generationComplete: boolean;
  transcript: ProjectTranscript;
  initialClips: ProjectClip[];
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Out-point a running preview should stop at, or null when free-playing. A ref
  // so the timeupdate handler reads the latest target without re-binding.
  const previewOut = useRef<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(NO_ACTIVE_SEGMENT);
  const { segments } = transcript;
  const emptyMessage = emptyTranscriptMessage(transcript);
  const captionsDisabled = captionsDisabledMessage(hasAudio);

  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    // A transcript click is "show me this moment", not "play": clear any preview
    // target and set the time, which is what triggers the video route's Range
    // request. The element stays paused if it already was.
    previewOut.current = null;
    video.currentTime = seconds;
  }, []);

  const previewRange = useCallback((inPoint: number, outPoint: number) => {
    const video = videoRef.current;
    if (!video) return;
    previewOut.current = outPoint;
    video.currentTime = inPoint;
    void video.play();
  }, []);

  const getCurrentTime = useCallback(() => videoRef.current?.currentTime ?? 0, []);

  const onTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const target = previewOut.current;
    if (target !== null && shouldPausePreview(video.currentTime, target)) {
      video.pause();
      previewOut.current = null;
    }
    setActiveIndex(activeSegmentIndex(segments, video.currentTime));
  }, [segments]);

  return (
    <div className="flex flex-col gap-8">
      {captionsDisabled ? (
        <p
          data-testid="captions-disabled"
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {captionsDisabled}
        </p>
      ) : null}

      <video
        ref={videoRef}
        src={sourceVideoUrl(projectId)}
        controls
        preload="metadata"
        onTimeUpdate={onTimeUpdate}
        className="w-full rounded-lg bg-black"
      />

      <ClipsPanel
        projectId={projectId}
        duration={duration}
        generationComplete={generationComplete}
        initialClips={initialClips}
        onPreview={previewRange}
        getCurrentTime={getCurrentTime}
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Transcript
        </h2>

        {emptyMessage ? (
          <p className="rounded-lg border border-zinc-200 p-6 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            {emptyMessage}
          </p>
        ) : (
          <ol className="flex flex-col gap-1">
            {segments.map((segment, index) => (
              <li key={`${segment.start}-${index}`}>
                <button
                  type="button"
                  onClick={() => seekTo(segment.start)}
                  aria-current={index === activeIndex ? "true" : undefined}
                  className={`flex w-full gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                    index === activeIndex
                      ? "bg-blue-50 text-zinc-900 dark:bg-blue-950/50 dark:text-zinc-100"
                      : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
                  }`}
                >
                  <span className="shrink-0 pt-0.5 font-mono text-xs tabular-nums text-zinc-400 dark:text-zinc-500">
                    {formatTimestamp(segment.start)}
                  </span>
                  <span>{segment.text}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
