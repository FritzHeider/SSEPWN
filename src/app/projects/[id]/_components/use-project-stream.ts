"use client";

import { useEffect, useState } from "react";

import type { JobSummary, ProjectSnapshot } from "@/lib/events/snapshot";
import type { LiveExport } from "@/lib/projects/exports-drawer";

/**
 * Live project state from the `GET /api/events?projectId=N` SSE stream (item 23,
 * client side), replacing the old 1.5s poll loops.
 *
 * The stream emits `jobs` / `clips` / `exports` deltas plus a full `snapshot` on
 * connect. Jobs and export summaries are complete enough to drive the pipeline
 * stepper and export progress directly, so they are surfaced as state. Clip
 * events, by contrast, carry only `{id,title,inPoint,outPoint,status}` — no
 * score, no reasons — so this hook exposes `clipsRevision`, a counter the
 * consumer watches to refetch the full `GET /api/projects/:id/clips` (correctly
 * ranked, with reasons) rather than rendering the thin summary.
 *
 * `failed` flips true on a stream error so the consumer can fall back to a poll.
 */
export interface ProjectStream {
  jobs: JobSummary[];
  liveExports: LiveExport[];
  /** Bumps on every `clips` (or full `snapshot`) event — a refetch trigger. */
  clipsRevision: number;
  failed: boolean;
}

export function useProjectStream(projectId: number): ProjectStream {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [liveExports, setLiveExports] = useState<LiveExport[]>([]);
  const [clipsRevision, setClipsRevision] = useState(0);
  // Seeded true where EventSource is unavailable so the caller polls; otherwise
  // only the stream's error callback flips it true.
  const [failed, setFailed] = useState(() => typeof EventSource === "undefined");

  useEffect(() => {
    if (typeof EventSource === "undefined") return;

    const source = new EventSource(`/api/events?projectId=${projectId}`);

    const onSnapshot = (event: MessageEvent) => {
      try {
        const snap = JSON.parse(event.data) as ProjectSnapshot;
        setJobs(snap.jobs);
        setLiveExports(snap.exports);
        setClipsRevision((n) => n + 1);
      } catch {
        // A malformed frame is not worth tearing the stream down; ignore it.
      }
    };
    const onJobs = (event: MessageEvent) => {
      try {
        setJobs(JSON.parse(event.data) as JobSummary[]);
      } catch {
        /* ignore a malformed frame */
      }
    };
    const onExports = (event: MessageEvent) => {
      try {
        setLiveExports(JSON.parse(event.data) as LiveExport[]);
      } catch {
        /* ignore a malformed frame */
      }
    };
    const onClips = () => setClipsRevision((n) => n + 1);

    source.addEventListener("snapshot", onSnapshot);
    source.addEventListener("jobs", onJobs);
    source.addEventListener("exports", onExports);
    source.addEventListener("clips", onClips);
    source.onerror = () => {
      source.close();
      setFailed(true);
    };

    return () => {
      source.close();
    };
  }, [projectId]);

  return { jobs, liveExports, clipsRevision, failed };
}
