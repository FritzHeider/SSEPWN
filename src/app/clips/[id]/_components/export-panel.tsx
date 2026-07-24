"use client";

import { Clipboard, Download } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useToast } from "@/app/_components/toaster";
import type { ExportSummary } from "@/lib/events/snapshot";
import {
  PLATFORM_PRESET_LIST,
  resolvePresetSelection,
  type PlatformPresetId,
} from "@/lib/presets";
import { formatDuration } from "@/lib/projects/view";
import {
  EXPORT_QUALITIES,
  canDownloadExport,
  canRetryExport,
  exportDownloadUrl,
  exportErrorMessage,
  exportPresetDimensions,
  exportPresetLabel,
  exportQualityLabel,
  exportStatusLabel,
  formatBytes,
  isTerminalExport,
  progressBarWidth,
  shouldPollExport,
  type ExportQuality,
  type ExportRow,
} from "@/lib/export/view";

/** Polling-fallback cadence when the SSE stream is unavailable, in ms. */
const POLL_INTERVAL_MS = 1200;
/** Watchdog cadence + how long the SSE stream may go silent before we poll a
 * pending export anyway (self-heals a connected-but-stalled stream). */
const WATCHDOG_INTERVAL_MS = 2000;
const SSE_STALL_MS = 4000;

const sel =
  "rounded border border-border-subtle bg-surface-raised px-1.5 py-1 text-xs text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** The full `GET /api/exports/:id` response the hydrate path reads. */
interface ExportStatusResponse {
  export: ExportRow;
  status: string;
  progress: number;
  error: string | null;
  fileSizeBytes: number | null;
}

/** One export-history row with its live bar, metadata, download / copy / retry. */
function ExportItem({
  row,
  progress,
  sizeBytes,
  durationSec,
  onRetry,
  onCopyPath,
  busy,
}: {
  row: ExportRow;
  progress: number;
  sizeBytes: number | null;
  durationSec: number;
  onRetry: () => void;
  onCopyPath: () => void;
  busy: boolean;
}) {
  const error = exportErrorMessage(row.error);
  const { width, height } = exportPresetDimensions(row.preset);
  const iconBtn =
    "flex cursor-pointer items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1 font-medium text-text transition-colors hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

  return (
    <li
      data-testid="export-row"
      data-export-id={row.id}
      data-status={row.status}
      className="flex flex-col gap-1.5 rounded-lg border border-border-subtle p-3 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-text">{exportPresetLabel(row.preset)}</span>
        <span
          data-testid="export-status"
          className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${
            row.status === "done"
              ? "bg-success/20 text-success"
              : row.status === "failed"
                ? "bg-danger/20 text-danger"
                : "bg-surface-overlay text-text-muted"
          }`}
        >
          {exportStatusLabel(row.status)}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {canDownloadExport(row) ? (
            <>
              <button
                type="button"
                data-testid="export-copy-path"
                className={iconBtn}
                onClick={onCopyPath}
                title={row.outputPath ?? undefined}
              >
                <Clipboard className="h-3.5 w-3.5" aria-hidden />
                Copy path
              </button>
              <a
                data-testid="export-download"
                href={exportDownloadUrl(row.id)}
                className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 font-medium text-accent-contrast transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Download className="h-3.5 w-3.5" aria-hidden />
                Download
              </a>
            </>
          ) : null}
          {canRetryExport(row.status) ? (
            <button type="button" data-testid="export-retry" className={iconBtn} disabled={busy} onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono tabular-nums text-text-muted">
        <span data-testid="export-dimensions">
          {width}×{height}
        </span>
        <span>{formatDuration(durationSec)}</span>
        {row.status === "done" ? <span data-testid="export-size">{formatBytes(sizeBytes)}</span> : null}
      </div>

      {shouldPollExport(row.status) ? (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-surface-overlay"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          data-testid="export-progress"
        >
          <div
            className="h-full bg-timeline transition-[width]"
            style={{ width: progressBarWidth(row.status, progress) }}
          />
        </div>
      ) : null}

      {error ? (
        <p data-testid="export-error" className="whitespace-pre-wrap break-words text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Export panel: dialog controls + per-export progress + history, plus the clip's
 * subtitle downloads (item 26). Progress is driven LIVE by the project SSE stream
 * (`GET /api/events?projectId=`), with a `GET /api/exports/:id` polling fallback
 * when the stream errors. Terminal rows are hydrated once from the full status
 * endpoint for their output path, error, and file size (item 29); resolution comes
 * from the preset and duration from the clip window — no extra round-trips.
 */
export function ExportPanel({
  clipId,
  projectId,
  durationSec,
  hasCaptions,
  presetOverride,
  projectPreset,
  initialExports,
}: {
  clipId: number;
  projectId: number;
  durationSec: number;
  hasCaptions: boolean;
  presetOverride: PlatformPresetId | null;
  projectPreset: PlatformPresetId | null;
  initialExports: ExportRow[];
}) {
  const { toast } = useToast();
  const effective = resolvePresetSelection(presetOverride, projectPreset).preset.id;
  const [preset, setPreset] = useState<PlatformPresetId>(effective);
  const [quality, setQuality] = useState<ExportQuality>("final");
  const [rows, setRows] = useState<ExportRow[]>(initialExports);
  const [progress, setProgress] = useState<Record<number, number>>({});
  const [sizes, setSizes] = useState<Record<number, number | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alive = useRef(true);
  const hydrated = useRef<Set<number>>(new Set());
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Fetch the full status of one export (output path, error, size) once it needs it.
  const hydrate = useCallback(async (id: number) => {
    try {
      const res = await fetch(`/api/exports/${id}`, { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as ExportStatusResponse;
      if (!alive.current) return;
      setProgress((prev) => ({ ...prev, [id]: body.progress }));
      setSizes((prev) => ({ ...prev, [id]: body.fileSizeBytes }));
      setRows((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, status: body.status, outputPath: body.export.outputPath, error: body.error } : r,
        ),
      );
    } catch {
      /* transient — the next event/poll retries */
    }
  }, []);

  // Apply a batch of SSE export summaries: update progress/status, and hydrate a
  // row the first time it needs its full metadata (terminal, or newly seen).
  const applyExports = useCallback(
    (summaries: ExportSummary[]) => {
      for (const s of summaries) {
        if (s.clipId !== clipId) continue;
        setProgress((prev) => ({ ...prev, [s.id]: s.progress }));
        setRows((prev) => prev.map((r) => (r.id === s.id ? { ...r, status: s.status } : r)));
        const known = rowsRef.current.find((r) => r.id === s.id);
        const needsMeta = isTerminalExport(s.status) && !hydrated.current.has(s.id);
        if (needsMeta || (known && known.status !== s.status)) {
          hydrated.current.add(s.id);
          void hydrate(s.id);
        }
      }
    },
    [clipId, hydrate],
  );

  // Live progress via the project event stream, with a polling fallback on error.
  useEffect(() => {
    // Hydrate initial rows once so already-finished exports show their size.
    // Deferred a tick so the fetch's setState never lands synchronously in the effect.
    const seed = setTimeout(() => {
      for (const r of initialExports) void hydrate(r.id);
    }, 0);

    let source: EventSource | null = null;
    let fallback: ReturnType<typeof setInterval> | null = null;
    let lastFrame = Date.now();

    const startFallback = () => {
      if (fallback) return;
      fallback = setInterval(() => {
        for (const r of rowsRef.current) if (shouldPollExport(r.status)) void hydrate(r.id);
      }, POLL_INTERVAL_MS);
    };

    try {
      source = new EventSource(`/api/events?projectId=${projectId}`);
      source.addEventListener("snapshot", (e) => {
        lastFrame = Date.now();
        try {
          const snap = JSON.parse((e as MessageEvent).data) as { exports?: ExportSummary[] };
          if (snap.exports) applyExports(snap.exports);
        } catch {
          /* ignore malformed frame */
        }
      });
      source.addEventListener("exports", (e) => {
        lastFrame = Date.now();
        try {
          applyExports(JSON.parse((e as MessageEvent).data) as ExportSummary[]);
        } catch {
          /* ignore malformed frame */
        }
      });
      source.onerror = () => {
        source?.close();
        source = null;
        startFallback();
      };
    } catch {
      startFallback();
    }

    // Watchdog: a connected-but-silent stream (no error, no frame) still resolves
    // a pending export — poll it once the stream has been quiet past the stall window.
    const watchdog = setInterval(() => {
      if (fallback) return;
      if (Date.now() - lastFrame < SSE_STALL_MS) return;
      for (const r of rowsRef.current) if (shouldPollExport(r.status)) void hydrate(r.id);
    }, WATCHDOG_INTERVAL_MS);

    return () => {
      clearTimeout(seed);
      clearInterval(watchdog);
      source?.close();
      if (fallback) clearInterval(fallback);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialExports is the mount seed
  }, [projectId, applyExports, hydrate]);

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

  const copyPath = useCallback(
    async (path: string | null) => {
      if (!path) return;
      try {
        await navigator.clipboard.writeText(path);
        toast({ title: "Path copied", description: path, variant: "success" });
      } catch {
        toast({ title: "Could not copy path", variant: "danger" });
      }
    },
    [toast],
  );

  const captionLink =
    "flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1 font-medium text-text transition-colors hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

  return (
    <section className="flex flex-col gap-3" aria-label="Export">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold uppercase tracking-wide text-text-muted">Export</span>
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
          className="flex cursor-pointer items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 font-medium text-accent-contrast transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          disabled={busy}
          onClick={() => void startExport(preset)}
        >
          {busy ? "Queuing…" : "Export"}
        </button>
        {error ? <span className="text-danger">{error}</span> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold uppercase tracking-wide text-text-muted">Captions</span>
        {hasCaptions ? (
          <>
            <a data-testid="captions-srt" href={`/api/clips/${clipId}/captions/srt`} className={captionLink} download>
              <Download className="h-3.5 w-3.5" aria-hidden />
              SRT
            </a>
            <a data-testid="captions-vtt" href={`/api/clips/${clipId}/captions/vtt`} className={captionLink} download>
              <Download className="h-3.5 w-3.5" aria-hidden />
              VTT
            </a>
          </>
        ) : (
          <span
            className="flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1 text-text-muted opacity-60"
            title="This clip has no captions to download"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            SRT / VTT
          </span>
        )}
      </div>

      {rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <ExportItem
              key={row.id}
              row={row}
              progress={progress[row.id] ?? 0}
              sizeBytes={sizes[row.id] ?? null}
              durationSec={durationSec}
              busy={busy}
              onRetry={() => void startExport(row.preset as PlatformPresetId)}
              onCopyPath={() => void copyPath(row.outputPath)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-text-muted">No exports yet.</p>
      )}
    </section>
  );
}
