"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

/**
 * Retry the failed pipeline step for a project (Phase-11: resumable
 * "retry from failed step"). Thin glue over `POST /api/projects/:id/retry` — all
 * the decision-making (which step failed, what to requeue) lives server-side in
 * `retryPipeline`, so this only fires the request and refreshes the server-
 * rendered page to pick up the new job state.
 */
export function RetryPipelineButton({
  projectId,
  stepLabel,
}: {
  projectId: number;
  /** The failed step's name, shown so the user knows what will re-run. */
  stepLabel: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retry = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/retry`, { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Retry failed (${response.status})`);
        return;
      }
      // The server committed a fresh job; re-render the page from the DB so the
      // stepper drops out of its failed state and the poller can track progress.
      router.refresh();
    } catch {
      setError("Retry failed — is the server still running?");
    } finally {
      setBusy(false);
    }
  }, [projectId, router]);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={retry}
        disabled={busy}
        data-testid="retry-pipeline"
        className="self-start rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-400"
      >
        {busy ? "Retrying…" : `Retry ${stepLabel}`}
      </button>
      {error ? <p className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
