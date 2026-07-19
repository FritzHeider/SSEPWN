"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ProjectClip } from "@/lib/projects/clips";
import {
  clipDurationLabel,
  clipRangeLabel,
  clipScoreLabel,
  clipTitle,
  clipsEmptyMessage,
  manualRangeError,
} from "@/lib/projects/clips-panel";
import { formatDuration } from "@/lib/projects/view";

/** How many times, and how far apart, regenerate polls for the worker's output. */
const POLL_TRIES = 12;
const POLL_INTERVAL_MS = 1500;

/**
 * The clips panel: ranked cards over a shared player.
 *
 * Presentation-only decisions (how a range reads, when Add is allowed) come from
 * `lib/projects/clips-panel.ts`; this component owns the network + local list so
 * a mutation shows immediately without a full page reload. Every mutation
 * re-reads `GET /clips` rather than patching the array in place, so the card
 * order always matches the server's ranking (`listClips`) — the one authority on
 * "best first" that the API and the server render already share.
 *
 * `onPreview` and `getCurrentTime` are the only ties to the video element, which
 * the parent workspace owns: clicking a card asks the player to run the range,
 * and Mark in/out read the live playhead. The panel never touches the <video>.
 */
export function ClipsPanel({
  projectId,
  duration,
  initialClips,
  onPreview,
  getCurrentTime,
}: {
  projectId: number;
  duration: number | null;
  initialClips: ProjectClip[];
  onPreview: (inPoint: number, outPoint: number) => void;
  getCurrentTime: () => number;
}) {
  const [clips, setClips] = useState<ProjectClip[]>(initialClips);
  const [markIn, setMarkIn] = useState<number | null>(null);
  const [markOut, setMarkOut] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Guards the async poll and any late fetch from setting state after unmount.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/clips`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load clips (${response.status})`);
    const body = (await response.json()) as { clips: ProjectClip[] };
    if (alive.current) setClips(body.clips);
  }, [projectId]);

  const addClip = useCallback(async () => {
    if (manualRangeError(markIn, markOut, duration) !== null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/clips`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inPoint: markIn, outPoint: markOut }),
      });
      if (!response.ok) throw new Error(`Add failed (${response.status})`);
      await refresh();
      if (alive.current) {
        setMarkIn(null);
        setMarkOut(null);
      }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : "Add failed");
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [markIn, markOut, duration, projectId, refresh]);

  const deleteClip = useCallback(
    async (id: number) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(`/api/clips/${id}`, { method: "DELETE" });
        if (!response.ok) throw new Error(`Delete failed (${response.status})`);
        await refresh();
      } catch (cause) {
        if (alive.current) setError(cause instanceof Error ? cause.message : "Delete failed");
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [refresh],
  );

  const regenerate = useCallback(async () => {
    setRegenerating(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/regenerate-clips`, { method: "POST" });
      if (!response.ok) throw new Error(`Regenerate failed (${response.status})`);
      // The job runs in the worker, not here (global constraint), so the new
      // clips land asynchronously. Poll a bounded number of times, then stop —
      // a worker that is down must not spin this forever.
      for (let attempt = 0; attempt < POLL_TRIES && alive.current; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (!alive.current) return;
        await refresh();
      }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : "Regenerate failed");
    } finally {
      if (alive.current) setRegenerating(false);
    }
  }, [projectId, refresh]);

  // Batch "export all clips": queue one export job per clip (the worker renders
  // them sequentially). Each POST uses the clip's own effective preset and final
  // quality; per-clip progress and downloads live on each clip's editor page.
  const exportAll = useCallback(async () => {
    setExporting(true);
    setError(null);
    setNotice(null);
    try {
      let queued = 0;
      let failed = 0;
      for (const clip of clips) {
        try {
          const response = await fetch(`/api/clips/${clip.id}/export`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          if (response.ok) queued += 1;
          else failed += 1;
        } catch {
          failed += 1;
        }
      }
      if (!alive.current) return;
      setNotice(
        `Queued ${queued} export${queued === 1 ? "" : "s"}` +
          (failed > 0 ? ` (${failed} failed to queue)` : "") +
          ". Open a clip to track progress and download.",
      );
    } finally {
      if (alive.current) setExporting(false);
    }
  }, [clips]);

  const rangeError = manualRangeError(markIn, markOut, duration);
  const emptyMessage = clipsEmptyMessage(clips);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Clips
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="export-all"
            onClick={exportAll}
            disabled={exporting || busy || clips.length === 0}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            {exporting ? "Queuing…" : "Export all"}
          </button>
          <button
            type="button"
            onClick={regenerate}
            disabled={regenerating || busy}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            {regenerating ? "Regenerating…" : "Regenerate"}
          </button>
        </div>
      </div>

      {notice ? (
        <p data-testid="export-all-notice" className="text-sm text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      ) : null}

      {/* Manual "add clip from current selection": mark the range off the live
          playhead, then commit it. */}
      <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setMarkIn(getCurrentTime())}
            className="rounded-md bg-zinc-100 px-2.5 py-1 font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
          >
            Mark in
          </button>
          <button
            type="button"
            onClick={() => setMarkOut(getCurrentTime())}
            className="rounded-md bg-zinc-100 px-2.5 py-1 font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
          >
            Mark out
          </button>
          <span className="font-mono tabular-nums text-zinc-500 dark:text-zinc-400">
            {markIn === null ? "—" : formatDuration(markIn)} → {markOut === null ? "—" : formatDuration(markOut)}
          </span>
          <button
            type="button"
            onClick={addClip}
            disabled={rangeError !== null || busy}
            className="ml-auto rounded-md bg-blue-600 px-2.5 py-1 font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add clip
          </button>
        </div>
        {rangeError !== null && (markIn !== null || markOut !== null) ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{rangeError}</p>
        ) : null}
      </div>

      {error ? <p className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}

      {emptyMessage ? (
        <p className="rounded-lg border border-zinc-200 p-6 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          {emptyMessage}
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {clips.map((clip, index) => {
            const score = clipScoreLabel(clip);
            return (
              <li key={clip.id}>
                <div className="flex items-start gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                  <button
                    type="button"
                    onClick={() => onPreview(clip.inPoint, clip.outPoint)}
                    className="flex flex-1 flex-col gap-1.5 text-left"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-xs tabular-nums text-zinc-400 dark:text-zinc-500">
                        #{index + 1}
                      </span>
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {clipTitle(clip)}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono tabular-nums dark:bg-zinc-800">
                        {score === null ? "Manual" : `score ${score}`}
                      </span>
                      <span className="font-mono tabular-nums">{clipDurationLabel(clip)}</span>
                      <span className="font-mono tabular-nums">{clipRangeLabel(clip)}</span>
                    </div>
                    {clip.reasons.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {clip.reasons.map((reason, r) => (
                          <span
                            key={r}
                            className="rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-800 dark:bg-blue-950/50 dark:text-blue-300"
                          >
                            {reason}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </button>
                  <Link
                    href={`/clips/${clip.id}`}
                    aria-label={`Edit captions for ${clipTitle(clip)}`}
                    className="shrink-0 rounded-md px-2 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                  >
                    Captions
                  </Link>
                  <button
                    type="button"
                    onClick={() => deleteClip(clip.id)}
                    disabled={busy}
                    aria-label={`Delete ${clipTitle(clip)}`}
                    className="shrink-0 rounded-md px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
