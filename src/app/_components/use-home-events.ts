"use client";

import { useEffect, useState } from "react";

/**
 * Subscribe the dashboard list to the `GET /api/events` SSE stream (item 23,
 * client side). The stream emits a `snapshot` on connect and a `projects` event
 * whenever any project's summary changes; both are change *signals* — the home
 * summaries omit the duration/poster/error a row renders — so this hook just
 * calls `onChange` and lets the panel refetch the full `GET /api/projects`.
 *
 * Returns `failed`: true once the stream errors, so the caller can fall back to
 * its old interval poll while work is still pending. `onChange` must be stable
 * (wrap in `useCallback`) — the effect re-subscribes if it changes.
 */
export function useHomeEvents(onChange: () => void): { failed: boolean } {
  // Seeded true where EventSource is unavailable (non-browser/legacy) so the
  // caller polls; otherwise it only flips true from the stream's error callback.
  const [failed, setFailed] = useState(() => typeof EventSource === "undefined");

  useEffect(() => {
    if (typeof EventSource === "undefined") return;

    const source = new EventSource("/api/events");
    const handle = () => onChange();
    source.addEventListener("snapshot", handle);
    source.addEventListener("projects", handle);
    source.onerror = () => {
      // One connection attempt failed. Close it (the browser would otherwise
      // retry on the server's `retry:` hint) and hand off to interval polling,
      // which is simpler to reason about than a half-open stream.
      source.close();
      setFailed(true);
    };

    return () => {
      source.close();
    };
  }, [onChange]);

  return { failed };
}
