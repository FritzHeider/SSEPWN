"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  PLATFORM_PRESET_LIST,
  resolvePresetSelection,
  type PlatformPresetId,
} from "@/lib/presets";
import {
  EXPORT_QUALITIES,
  canDownloadExport,
  canRetryExport,
  exportDownloadUrl,
  exportErrorMessage,
  exportPresetLabel,
  exportQualityLabel,
  exportStatusLabel,
  progressBarWidth,
  shouldPollExport,
  type ExportQuality,
  type ExportRow,
} from "@/lib/export/view";

/** How often the panel polls a live export's status, in ms. */
const POLL_INTERVAL_MS = 1200;

const btn =
  "rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";
const sel =
  "rounded border border-zinc-300 bg-transparent px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-950";

/** The `GET /api/exports/:id` shape the poller reads. */
interface ExportStatusResponse {
  export: ExportRow;
  status: string;
  progress: number;
  error: string | null;
}

/** One row in the export history, with its live bar / download / retry affordances. */
function ExportItem({
  row,
  progress,
  onRetry,
  busy,
}: {
  row: ExportRow;
  progress: number;
  onRetry: () => void;
  busy: boolean;
}) {
  const error = exportErrorMessage(row.error);
  return (
    <li
      data-testid="export-row"
      data-export-id={row.id}
      data-status={row.status}
      className="flex flex-col gap-1.5 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-zinc-800 dark:text-zinc-100">
          {exportPresetLabel(row.preset)}
        </span>
        <span
          data-testid="export-status"
          className={`rounded px-1.5 py-0.5 font-mono uppercase text-[10px] ${
            row.status === "done"
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
              : row.status === "failed"
                ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
                : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400"
          }`}
        >
          {exportStatusLabel(row.status)}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {canDownloadExport(row) ? (
            <a
              data-testid="export-download"
              href={exportDownloadUrl(row.id)}
              className="rounded-md bg-blue-600 px-2.5 py-1 font-medium text-white hover:bg-blue-500"
            >
              Download
            </a>
          ) : null}
          {canRetryExport(row.status) ? (
            <button
              type="button"
              data-testid="export-retry"
              className={btn}
              disabled={busy}
              onClick={onRetry}
            >
              Retry
            </button>
          ) : null}
        </span>
      </div>

      {shouldPollExport(row.status) ? (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          data-testid="export-progress"
        >
          <div
            className="h-full bg-blue-600 transition-[width] dark:bg-blue-500"
            style={{ width: progressBarWidth(row.status, progress) }}
          />
        </div>
      ) : null}

      {error ? (
        <p data-testid="export-error" className="whitespace-pre-wrap break-words text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Export panel (Phase 10): dialog controls + per-export progress + history.
 *
 * Choose a platform preset (defaults to the clip's effective preset, same
 * resolution rules as the rest of the editor) and a quality (final / draft
 * quick-preview), then Export POSTs `/api/clips/:id/export`, which queues the
 * render job — no media work happens in the request (global constraint). The
 * panel keeps a live history: each non-terminal row is polled against
 * `GET /api/exports/:id` for status + progress until it finishes, then offers a
 * Download link (streams the file) or, on failure, a readable error and a Retry
 * that re-queues the same preset.
 */
export function ExportPanel({
  clipId,
  presetOverride,
  projectPreset,
  initialExports,
}: {
  clipId: number;
  presetOverride: PlatformPresetId | null;
  projectPreset: PlatformPresetId | null;
  initialExports: ExportRow[];
}) {
  const effective = resolvePresetSelection(presetOverride, projectPreset).preset.id;
  const [preset, setPreset] = useState<PlatformPresetId>(effective);
  const [quality, setQuality] = useState<ExportQuality>("final");
  const [rows, setRows] = useState<ExportRow[]>(initialExports);
  const [progress, setProgress] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Poll every live (non-terminal) export until it settles. A single interval
  // sweeps all active rows; it stops itself once none remain so a finished panel
  // makes no network noise.
  const active = rows.some((row) => shouldPollExport(row.status));
  useEffect(() => {
    if (!active) return;
    const tick = async () => {
      const pending = rows.filter((row) => shouldPollExport(row.status));
      await Promise.all(
        pending.map(async (row) => {
          try {
            const res = await fetch(`/api/exports/${row.id}`, { cache: "no-store" });
            if (!res.ok) return;
            const body = (await res.json()) as ExportStatusResponse;
            if (!alive.current) return;
            setProgress((prev) => ({ ...prev, [row.id]: body.progress }));
            setRows((prev) =>
              prev.map((r) =>
                r.id === row.id
                  ? { ...r, status: body.status, outputPath: body.export.outputPath, error: body.error }
                  : r,
              ),
            );
          } catch {
            /* transient network error — the next tick retries */
          }
        }),
      );
    };
    const handle = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => clearInterval(handle);
    // `rows` intentionally omitted: the interval reads the latest via the closure
    // re-created whenever `active` flips, and we do not want to reset the timer on
    // every progress update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const startExport = useCallback(
    async (withPreset: PlatformPresetId) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/clips/${clipId}/export`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ preset: withPreset, quality }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          if (alive.current) setError(body?.error ?? `Export failed (${res.status})`);
          return;
        }
        const body = (await res.json()) as { export: ExportRow };
        if (alive.current) setRows((prev) => [body.export, ...prev]);
      } catch {
        if (alive.current) setError("Network error");
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [clipId, quality],
  );

  return (
    <section className="flex flex-col gap-3" aria-label="Export">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Export
        </span>
        <select
          className={sel}
          data-testid="export-preset"
          aria-label="Export preset"
          value={preset}
          disabled={busy}
          onChange={(e) => setPreset(e.target.value as PlatformPresetId)}
        >
          {PLATFORM_PRESET_LIST.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <select
          className={sel}
          data-testid="export-quality"
          aria-label="Export quality"
          value={quality}
          disabled={busy}
          onChange={(e) => setQuality(e.target.value as ExportQuality)}
        >
          {EXPORT_QUALITIES.map((q) => (
            <option key={q} value={q}>
              {exportQualityLabel(q)}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="export-start"
          className="rounded-md bg-blue-600 px-2.5 py-1 font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy}
          onClick={() => void startExport(preset)}
        >
          {busy ? "Queuing…" : "Export"}
        </button>
        {error ? <span className="text-red-600 dark:text-red-400">{error}</span> : null}
      </div>

      {rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <ExportItem
              key={row.id}
              row={row}
              progress={progress[row.id] ?? 0}
              busy={busy}
              onRetry={() => void startExport(row.preset as PlatformPresetId)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">No exports yet.</p>
      )}
    </section>
  );
}
