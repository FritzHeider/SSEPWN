"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ClipsPanel } from "./clips-panel";
import { ExportsDrawer } from "./exports-drawer";
import { PipelineStepper } from "./pipeline-stepper";
import { Seekbar } from "./seekbar";
import { PosterSkeleton } from "./skeletons";
import { TranscriptRail } from "./transcript-rail";
import { useProjectStream } from "./use-project-stream";
import { useUndoableDelete } from "./use-undoable-delete";
import { useToast } from "@/app/_components/toaster";
import { derivePipeline, type PipelineStep } from "@/lib/pipeline";
import type { ProjectClip } from "@/lib/projects/clips";
import { clipTitle, shouldPausePreview } from "@/lib/projects/clips-panel";
import { firstSegmentInRange } from "@/lib/projects/transcript-search";
import type { ProjectTranscript } from "@/lib/projects/transcript";
import {
  NO_ACTIVE_SEGMENT,
  activeSegmentIndex,
  captionsDisabledMessage,
  emptyTranscriptMessage,
  sourceVideoUrl,
} from "@/lib/transcribe/panel";

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * The project page's interactive half. Owns the shared <video>, the clip list
 * (kept live off the SSE stream), and the mark-in/out state the seekbar handles
 * and the clips panel's Mark buttons both drive. At xl+ it lays out two columns:
 * a sticky player + clips on the left, a scrolling transcript rail on the right;
 * below xl it stacks in the original order.
 */
export function ProjectWorkspace({
  projectId,
  duration,
  hasAudio,
  projectStatus,
  transcribed,
  initialGenerationComplete,
  initialSteps,
  transcript,
  initialClips,
}: {
  projectId: number;
  duration: number | null;
  hasAudio: boolean | null;
  projectStatus: string;
  transcribed: boolean;
  initialGenerationComplete: boolean;
  initialSteps: PipelineStep[];
  transcript: ProjectTranscript;
  initialClips: ProjectClip[];
}) {
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewOut = useRef<number | null>(null);
  const { segments } = transcript;

  const [clips, setClips] = useState<ProjectClip[]>(initialClips);
  const [markIn, setMarkIn] = useState<number | null>(null);
  const [markOut, setMarkOut] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(NO_ACTIVE_SEGMENT);
  const [currentTime, setCurrentTime] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [videoReady, setVideoReady] = useState(false);
  const [flash, setFlash] = useState({ index: -1, nonce: 0 });
  const [exportsOpen, setExportsOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const regenPrevGenIds = useRef<Set<number>>(new Set());
  const regenStartRevision = useRef(0);

  const stream = useProjectStream(projectId);
  const { removeOne, removeMany, getPendingIds } = useUndoableDelete<ProjectClip>({
    setList: setClips,
    deleteUrl: (id) => `/api/clips/${id}`,
    toast,
  });

  // ── Live clip list: refetch the full (ranked, reasons-carrying) list whenever
  // the SSE `clips` event fires, dropping rows whose delete is mid-undo. ────────
  useEffect(() => {
    if (stream.clipsRevision === 0) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/clips`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { clips: ProjectClip[] };
        if (!alive) return;
        const pending = getPendingIds();
        setClips(pending.size ? body.clips.filter((c) => !pending.has(c.id)) : body.clips);
      } catch {
        /* a dropped refetch retries on the next event */
      }
    })();
    return () => {
      alive = false;
    };
  }, [stream.clipsRevision, projectId, getPendingIds]);

  // ── Pipeline: derive live from SSE jobs once the stream has delivered, else the
  // server-rendered initial steps (no flash on first paint). ───────────────────
  const steps: PipelineStep[] =
    stream.clipsRevision === 0
      ? initialSteps
      : derivePipeline({
          jobs: stream.jobs.map((j) => ({ type: j.type, status: j.status, error: j.error })),
          projectStatus,
          hasAudio,
          transcribed,
          clipCount: clips.length,
        });

  const generationComplete =
    initialGenerationComplete || stream.jobs.some((j) => j.type === "generate-clips" && j.status === "done");

  const transcribeStep = steps.find((s) => s.key === "transcribe");
  const generateStep = steps.find((s) => s.key === "generate-clips");
  const transcribing = (transcribeStep?.status === "running" || transcribeStep?.status === "queued") && segments.length === 0;
  const clipsLoading = (generateStep?.status === "running" || generateStep?.status === "queued") && clips.length === 0;

  // A poster job finishing bumps this so cards retry a previously-404 thumbnail.
  const thumbVersion = stream.jobs.filter((j) => j.type === "clip-thumbnail" && j.status === "done").length;

  // ── Regenerate: clear the spinner when the new generate-clips job goes terminal
  // OR the clip set changes (the spec's two signals) — the latter also covers the
  // edge where the stream had not delivered jobs yet at click time.
  useEffect(() => {
    if (!regenerating) return;
    const fresh = stream.jobs.find((j) => j.type === "generate-clips" && !regenPrevGenIds.current.has(j.id));
    const jobTerminal = fresh && (fresh.status === "done" || fresh.status === "failed");
    const clipsChanged = stream.clipsRevision > regenStartRevision.current;
    if (jobTerminal || clipsChanged) setRegenerating(false);
  }, [stream.jobs, stream.clipsRevision, regenerating]);

  const regenerate = useCallback(async () => {
    regenPrevGenIds.current = new Set(
      stream.jobs.filter((j) => j.type === "generate-clips").map((j) => j.id),
    );
    regenStartRevision.current = stream.clipsRevision;
    setRegenerating(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/regenerate-clips`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setRegenerating(false);
      toast({ title: "Could not start regeneration", variant: "danger" });
    }
  }, [stream.jobs, stream.clipsRevision, projectId, toast]);

  // ── Player wiring ────────────────────────────────────────────────────────────
  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    previewOut.current = null;
    video.currentTime = seconds;
    setCurrentTime(seconds);
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
    setCurrentTime(video.currentTime);
    setActiveIndex(activeSegmentIndex(segments, video.currentTime));
  }, [segments]);

  const onProgress = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.buffered.length === 0) return;
    setBuffered(video.buffered.end(video.buffered.length - 1));
  }, []);

  // ── Cross-panel actions ──────────────────────────────────────────────────────
  const onReasonClick = useCallback(
    (clip: ProjectClip) => {
      const index = firstSegmentInRange(segments, clip.inPoint, clip.outPoint);
      setFlash((f) => ({ index, nonce: f.nonce + 1 }));
    },
    [segments],
  );

  const createClipFromRange = useCallback(
    async (start: number, end: number) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/clips`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ inPoint: start, outPoint: end }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { clip: ProjectClip };
        setClips((current) => [...current, body.clip]);
        toast({ title: "Clip created from selection", variant: "success" });
      } catch {
        toast({ title: "Could not create clip", variant: "danger" });
      }
    },
    [projectId, toast],
  );

  const deleteClip = useCallback(
    (clip: ProjectClip) => {
      removeOne(clips, clip, { title: `Deleted ${clipTitle(clip)}` });
    },
    [removeOne, clips],
  );

  const deleteClips = useCallback(
    (items: ProjectClip[]) => {
      if (items.length === 0) return;
      removeMany(clips, items, {
        title: `Deleted ${items.length} clip${items.length === 1 ? "" : "s"}`,
      });
    },
    [removeMany, clips],
  );

  const durationSafe = duration ?? 0;
  const captionsDisabled = captionsDisabledMessage(hasAudio);
  const emptyMessage = emptyTranscriptMessage(transcript);

  return (
    <div className="flex flex-col gap-8">
      <PipelineStepper steps={steps} projectId={projectId} />

      {captionsDisabled ? (
        <p
          data-testid="captions-disabled"
          role="status"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300"
        >
          {captionsDisabled}
        </p>
      ) : null}

      <div className="flex flex-col gap-8 xl:grid xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
        {/* Left column: sticky player + clips */}
        <div className="flex flex-col gap-8">
          <div className="flex flex-col gap-2 xl:sticky xl:top-14 xl:z-10">
            <div className="relative overflow-hidden rounded-lg bg-black">
              <video
                ref={videoRef}
                src={sourceVideoUrl(projectId)}
                controls
                preload="metadata"
                onTimeUpdate={onTimeUpdate}
                onProgress={onProgress}
                onLoadedMetadata={() => setVideoReady(true)}
                className="w-full"
              />
              {!videoReady ? <PosterSkeleton /> : null}
            </div>
            <Seekbar
              duration={durationSafe}
              currentTime={currentTime}
              buffered={buffered}
              markIn={markIn}
              markOut={markOut}
              onSeek={seekTo}
              onMarkIn={setMarkIn}
              onMarkOut={setMarkOut}
            />
          </div>

          <ClipsPanel
            projectId={projectId}
            duration={duration}
            generationComplete={generationComplete}
            clips={clips}
            setClips={setClips}
            loading={clipsLoading}
            markIn={markIn}
            markOut={markOut}
            setMarkIn={setMarkIn}
            setMarkOut={setMarkOut}
            getCurrentTime={getCurrentTime}
            regenerating={regenerating}
            onRegenerate={regenerate}
            onPreview={previewRange}
            onReasonClick={onReasonClick}
            onDelete={deleteClip}
            onDeleteMany={deleteClips}
            onOpenExports={() => setExportsOpen(true)}
            thumbVersion={thumbVersion}
          />

          <ExportsDrawer
            clips={clips}
            liveExports={stream.liveExports}
            open={exportsOpen}
            onOpenChange={setExportsOpen}
          />
        </div>

        {/* Right column: transcript rail (own scroll at xl) */}
        <div className="xl:sticky xl:top-14 xl:max-h-[calc(100vh-4.5rem)] xl:overflow-y-auto">
          <TranscriptRail
            segments={segments}
            activeIndex={activeIndex}
            emptyMessage={emptyMessage}
            skeleton={Boolean(transcribing)}
            flashIndex={flash.index}
            flashNonce={flash.nonce}
            onSeek={seekTo}
            onCreateClip={createClipFromRange}
          />
        </div>
      </div>
    </div>
  );
}
