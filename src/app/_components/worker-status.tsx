"use client";

import { useEffect, useState } from "react";

const POLL_INTERVAL_MS = 10_000;

const WORKER_HINT =
  "The background worker processes uploads and exports. Start it with: npm run worker";

type WorkerState = "online" | "offline" | "unknown";

export type WorkerHealth = { status: WorkerState; lastSeenMs: number | null };

type HealthResponse = { worker?: "online" | "offline"; lastSeenMs?: number | null };

/**
 * Polls `GET /api/health` every 10s and degrades gracefully: any error, 404
 * (route not built yet), or non-online payload is treated as offline rather
 * than crashing. Call once (app-shell) and share the result with the indicator
 * and the banner so there is a single poller.
 */
export function useWorkerHealth(): WorkerHealth {
  const [health, setHealth] = useState<WorkerHealth>({ status: "unknown", lastSeenMs: null });

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as HealthResponse;
        if (cancelled) return;
        setHealth({
          status: body.worker === "online" ? "online" : "offline",
          lastSeenMs: body.lastSeenMs ?? null,
        });
      } catch {
        if (!cancelled) setHealth({ status: "offline", lastSeenMs: null });
      }
    };

    void check();
    const timer = setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return health;
}

/** Small dot + label for the top bar. Amber until a poll confirms `online`. */
export function WorkerStatus({ health }: { health: WorkerHealth }) {
  const online = health.status === "online";
  return (
    <span
      title={WORKER_HINT}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]"
    >
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: online ? "var(--success)" : "#F59E0B" }}
      />
      {online ? "Worker" : "Worker offline"}
    </span>
  );
}

/**
 * Full-width amber banner shown under the top bar while the worker is offline.
 * Dismissible for the session; a later poll that goes offline again re-shows it.
 */
export function WorkerOfflineBanner({ health }: { health: WorkerHealth }) {
  const [dismissed, setDismissed] = useState(false);
  const [prevStatus, setPrevStatus] = useState(health.status);

  // Re-arm the banner whenever the worker recovers, so a fresh outage re-shows.
  // Adjusting state during render (not in an effect) is React's pattern for
  // "reset a value when a prop changes".
  if (health.status !== prevStatus) {
    setPrevStatus(health.status);
    if (health.status === "online") setDismissed(false);
  }

  if (health.status !== "offline" || dismissed) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-300"
    >
      <span className="flex-1">
        The background worker is offline — uploads and exports will wait until it
        starts. Run <code className="font-mono">npm run worker</code>.
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded px-2 py-0.5 text-xs font-medium hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        Dismiss
      </button>
    </div>
  );
}
