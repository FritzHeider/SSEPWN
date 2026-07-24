"use client";

import { ChevronDown, Download } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ProjectClip } from "@/lib/projects/clips";
import { clipTitle } from "@/lib/projects/clips-panel";
import {
  aggregateExportCounts,
  buildDrawerRows,
  type ExportHistoryRow,
  type LiveExport,
} from "@/lib/projects/exports-drawer";
import { resolvePlatformPreset } from "@/lib/presets";

/**
 * Project-level exports summary (item 24). There is no project-wide exports
 * endpoint, so this joins three sources: per-clip history (`GET /api/clips/:id/
 * export`, for the preset), the clip titles from the list, and the live SSE
 * `exports` overlay for status/progress. The join + tally are in
 * `lib/projects/exports-drawer.ts`; this owns the fetch and the collapsible UI.
 *
 * "Export all" points here (the workspace opens the drawer after queuing) rather
 * than the old "open a clip to track progress" notice.
 */
const STATUS_LABEL: Readonly<Record<string, string>> = {
  queued: "Queued",
  running: "Rendering",
  done: "Done",
  failed: "Failed",
};

export function ExportsDrawer({
  clips,
  liveExports,
  open,
  onOpenChange,
}: {
  clips: ProjectClip[];
  liveExports: LiveExport[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [history, setHistory] = useState<ExportHistoryRow[]>([]);
  const fetching = useRef(false);

  const clipIdsKey = clips.map((c) => c.id).join(",");
  const liveIdsKey = liveExports.map((e) => e.id).join(",");
  const historyIds = useMemo(() => new Set(history.map((h) => h.id)), [history]);
  const hasUnknownLive = liveExports.some((e) => !historyIds.has(e.id));

  // Fetch per-clip export history when the drawer is open and either a clip set
  // change or a newly-queued export (seen first via SSE) means our preset map is
  // stale. Progress itself never needs a refetch — SSE carries it.
  const loadHistory = useCallback(async () => {
    if (fetching.current || clips.length === 0) return;
    fetching.current = true;
    try {
      const lists = await Promise.all(
        clips.map(async (clip) => {
          try {
            const res = await fetch(`/api/clips/${clip.id}/export`, { cache: "no-store" });
            if (!res.ok) return [] as ExportHistoryRow[];
            const body = (await res.json()) as { exports: ExportHistoryRow[] };
            return body.exports;
          } catch {
            return [] as ExportHistoryRow[];
          }
        }),
      );
      setHistory(lists.flat());
    } finally {
      fetching.current = false;
    }
  }, [clips]);

  useEffect(() => {
    if (!open) return;
    if (history.length === 0 || hasUnknownLive) void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, clipIdsKey, liveIdsKey]);

  const rows = useMemo(() => {
    const liveMap = new Map(liveExports.map((e) => [e.id, e]));
    const titles = new Map(clips.map((c) => [c.id, clipTitle(c)]));
    return buildDrawerRows(history, liveMap, titles);
  }, [history, liveExports, clips]);

  const counts = useMemo(() => aggregateExportCounts(rows), [rows]);

  return (
    <section
      data-testid="exports-drawer"
      className="flex flex-col rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)]"
    >
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="flex items-center gap-3 rounded-lg px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <span className="text-sm font-semibold text-[var(--text)]">Exports</span>
        <span className="flex flex-wrap gap-1.5 text-xs">
          {counts.queued > 0 ? <Pill label={`${counts.queued} queued`} tone="muted" /> : null}
          {counts.rendering > 0 ? <Pill label={`${counts.rendering} rendering`} tone="timeline" /> : null}
          {counts.done > 0 ? <Pill label={`${counts.done} done`} tone="success" /> : null}
          {counts.failed > 0 ? <Pill label={`${counts.failed} failed`} tone="danger" /> : null}
          {counts.total === 0 ? <span className="text-[var(--text-muted)]">None yet</span> : null}
        </span>
        <ChevronDown
          className={`ml-auto h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>

      {open ? (
        <div className="flex flex-col gap-2 border-t border-[var(--border-subtle)] p-4">
          {rows.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">
              No exports yet. Use “Export all”, or export a clip from its card.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((row) => (
                <li
                  key={row.id}
                  data-testid="export-row"
                  data-status={row.status}
                  className="flex flex-col gap-1.5 rounded-md border border-[var(--border-subtle)] p-3"
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text)]">
                      {row.clipTitle}
                    </span>
                    <span className="shrink-0 rounded bg-[var(--surface-overlay)] px-1.5 py-0.5 text-xs text-[var(--text-muted)]">
                      {resolvePlatformPreset(row.preset).label}
                    </span>
                    <span className="shrink-0 text-xs text-[var(--text-muted)]">
                      {STATUS_LABEL[row.status] ?? row.status}
                    </span>
                    {row.downloadable ? (
                      <a
                        href={`/api/exports/${row.id}/download`}
                        download
                        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-[var(--accent)] transition-colors hover:bg-[var(--surface-overlay)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      >
                        <Download className="h-3.5 w-3.5" aria-hidden />
                        Download
                      </a>
                    ) : null}
                  </div>
                  {row.status !== "done" && row.status !== "failed" ? (
                    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-overlay)]">
                      <div className="h-full rounded-full bg-[var(--timeline)] transition-[width]" style={{ width: `${row.progress}%` }} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

function Pill({ label, tone }: { label: string; tone: "muted" | "timeline" | "success" | "danger" }) {
  const cls: Record<typeof tone, string> = {
    muted: "bg-[var(--surface-overlay)] text-[var(--text-muted)]",
    timeline: "bg-[color-mix(in_oklab,var(--timeline)_18%,transparent)] text-[var(--timeline)]",
    success: "bg-[color-mix(in_oklab,var(--success)_18%,transparent)] text-[var(--success)]",
    danger: "bg-[color-mix(in_oklab,var(--danger)_18%,transparent)] text-[var(--danger)]",
  };
  return <span className={`rounded-full px-2 py-0.5 font-medium ${cls[tone]}`}>{label}</span>;
}
