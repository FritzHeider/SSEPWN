"use client";

import { useCallback, useRef, useState } from "react";

import type { ProjectTranscript } from "@/lib/projects/transcript";
import {
  NO_ACTIVE_SEGMENT,
  activeSegmentIndex,
  emptyTranscriptMessage,
  formatTimestamp,
  sourceVideoUrl,
} from "@/lib/transcribe/panel";

/**
 * The source video plus its transcript, with click-to-seek.
 *
 * Thin on purpose (DEC-005): every decision it makes — which sentence is
 * active, how a timestamp reads, what to say when there are no sentences — comes
 * from `lib/transcribe/panel.ts`, where node-env vitest can test it honestly.
 */
export function TranscriptPanel({
  projectId,
  transcript,
}: {
  projectId: number;
  transcript: ProjectTranscript;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [activeIndex, setActiveIndex] = useState(NO_ACTIVE_SEGMENT);
  const { segments } = transcript;
  const emptyMessage = emptyTranscriptMessage(transcript);

  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    // Assigning currentTime is what triggers the Range request the video route
    // exists to answer. play() is deliberately not called: a click on a sentence
    // asks "show me this moment", not "start playing".
    video.currentTime = seconds;
  }, []);

  // Driven by the element's own clock rather than a timer, so the highlight
  // cannot drift away from the frame actually on screen — including while the
  // user scrubs the native controls, which no timer of ours would hear about.
  const onTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setActiveIndex(activeSegmentIndex(segments, video.currentTime));
  }, [segments]);

  return (
    <div className="flex flex-col gap-6">
      {/* No <track> yet: captions are Phase 05. Until then the transcript below
          is this video's accessible text. */}
      <video
        ref={videoRef}
        src={sourceVideoUrl(projectId)}
        controls
        preload="metadata"
        onTimeUpdate={onTimeUpdate}
        className="w-full rounded-lg bg-black"
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
