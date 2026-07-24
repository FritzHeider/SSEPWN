"use client";

import { Download, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";

import { ClipCard } from "./clip-card";
import { ClipCardSkeletons } from "./skeletons";
import { useToast } from "@/app/_components/toaster";
import type { ProjectClip } from "@/lib/projects/clips";
import { clipsEmptyMessage, manualRangeError } from "@/lib/projects/clips-panel";
import { maxClipScore } from "@/lib/projects/score-bar";
import { formatDuration } from "@/lib/projects/view";
import { DEFAULT_PLATFORM_PRESET, PLATFORM_PRESET_LIST, type PlatformPresetId } from "@/lib/presets";

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * The clips panel: ranked cards over the shared player. Clip list state and the
 * SSE-driven refetch live in the workspace; this panel owns the per-clip
 * mutations (manual add, rename, export) and batch selection, mutating the
 * shared list through `setClips` so a change shows immediately, with SSE
 * reconciling order afterward.
 *
 * Deletes (single and batch) go through the workspace's undoable-delete flow;
 * `onReasonClick` links a card's reason chip into the transcript; "Export all"
 * and batch export both point at the exports drawer via `onOpenExports`.
 */
export function ClipsPanel({
  projectId,
  duration,
  generationComplete,
  clips,
  setClips,
  loading,
  markIn,
  markOut,
  setMarkIn,
  setMarkOut,
  getCurrentTime,
  regenerating,
  onRegenerate,
  onPreview,
  onReasonClick,
  onDelete,
  onDeleteMany,
  onOpenExports,
  thumbVersion,
}: {
  projectId: number;
  duration: number | null;
  generationComplete: boolean;
  clips: ProjectClip[];
  setClips: (updater: (current: ProjectClip[]) => ProjectClip[]) => void;
  /** True while generate-clips is in flight and there are no clips yet. */
  loading: boolean;
  markIn: number | null;
  markOut: number | null;
  setMarkIn: (seconds: number | null) => void;
  setMarkOut: (seconds: number | null) => void;
  getCurrentTime: () => number;
  regenerating: boolean;
  onRegenerate: () => void;
  onPreview: (inPoint: number, outPoint: number) => void;
  onReasonClick: (clip: ProjectClip) => void;
  onDelete: (clip: ProjectClip) => void;
  onDeleteMany: (clips: ProjectClip[]) => void;
  onOpenExports: () => void;
  thumbVersion: number;
}) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkPreset, setBulkPreset] = useState<PlatformPresetId>(DEFAULT_PLATFORM_PRESET);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const maxScore = maxClipScore(clips);
  const rangeError = manualRangeError(markIn, markOut, duration);
  const emptyMessage = clipsEmptyMessage(clips, generationComplete);
  const selectedClips = clips.filter((clip) => selected.has(clip.id));
  const allSelected = clips.length > 0 && selected.size === clips.length;

  const toggleSelect = useCallback((id: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((current) => (current.size === clips.length ? new Set() : new Set(clips.map((c) => c.id))));
  }, [clips]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const addClip = useCallback(async () => {
    if (manualRangeError(markIn, markOut, duration) !== null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/clips`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ inPoint: markIn, outPoint: markOut }),
      });
      if (!response.ok) throw new Error(`Add failed (${response.status})`);
      const body = (await response.json()) as { clip: ProjectClip };
      setClips((current) => [...current, body.clip]);
      setMarkIn(null);
      setMarkOut(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Add failed");
    } finally {
      setBusy(false);
    }
  }, [markIn, markOut, duration, projectId, setClips, setMarkIn, setMarkOut]);

  const rename = useCallback(
    async (id: number, title: string): Promise<boolean> => {
      try {
        const response = await fetch(`/api/clips/${id}`, {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ title }),
        });
        if (!response.ok) throw new Error(String(response.status));
        // The PATCH returns a raw DB row (reasons as JSON text); merge only the
        // title so the parsed `reasons: string[]` already in state survives.
        const body = (await response.json()) as { clip: { title: string | null } };
        setClips((current) => current.map((c) => (c.id === id ? { ...c, title: body.clip.title } : c)));
        return true;
      } catch {
        toast({ title: "Rename failed", variant: "danger" });
        return false;
      }
    },
    [setClips, toast],
  );

  const queueExports = useCallback(
    async (targets: ProjectClip[], preset?: PlatformPresetId): Promise<{ queued: number; failed: number }> => {
      let queued = 0;
      let failed = 0;
      await Promise.all(
        targets.map(async (clip) => {
          try {
            const response = await fetch(`/api/clips/${clip.id}/export`, {
              method: "POST",
              headers: JSON_HEADERS,
              body: JSON.stringify(preset ? { preset } : {}),
            });
            if (response.ok) queued += 1;
            else failed += 1;
          } catch {
            failed += 1;
          }
        }),
      );
      return { queued, failed };
    },
    [],
  );

  const exportAll = useCallback(async () => {
    setExporting(true);
    setNotice(null);
    const { queued, failed } = await queueExports(clips);
    setExporting(false);
    onOpenExports();
    setNotice(`Queued ${queued} export${queued === 1 ? "" : "s"}${failed > 0 ? ` (${failed} failed)` : ""}. Track them under Exports below.`);
  }, [clips, queueExports, onOpenExports]);

  const exportSelected = useCallback(async () => {
    const targets = selectedClips;
    const { queued, failed } = await queueExports(targets, bulkPreset);
    clearSelection();
    onOpenExports();
    toast({
      title: `Queued ${queued} export${queued === 1 ? "" : "s"}`,
      description: failed > 0 ? `${failed} failed to queue.` : undefined,
      variant: failed > 0 ? "danger" : "success",
    });
  }, [selectedClips, bulkPreset, queueExports, clearSelection, onOpenExports, toast]);

  const deleteSelected = useCallback(() => {
    onDeleteMany(selectedClips);
    clearSelection();
  }, [selectedClips, onDeleteMany, clearSelection]);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Clips</h2>
        <div className="flex items-center gap-2">
          {clips.length > 0 ? (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--text-muted)]">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
              />
              Select all
            </label>
          ) : null}
          <button
            type="button"
            data-testid="export-all"
            onClick={exportAll}
            disabled={exporting || busy || clips.length === 0}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--border-subtle)] px-3 text-xs font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-overlay)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            {exporting ? "Queuing…" : "Export all"}
          </button>
          <button
            type="button"
            onClick={onRegenerate}
            disabled={regenerating || busy}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--border-subtle)] px-3 text-xs font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-overlay)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${regenerating ? "animate-spin" : ""}`} aria-hidden />
            {regenerating ? "Regenerating…" : "Regenerate"}
          </button>
        </div>
      </div>

      {notice ? (
        <p data-testid="export-all-notice" role="status" className="text-sm text-[var(--success)]">
          {notice}
        </p>
      ) : null}

      {selected.size > 0 ? (
        <div
          data-testid="bulk-bar"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--accent)] bg-[color-mix(in_oklab,var(--accent)_10%,transparent)] p-2.5"
        >
          <span className="text-sm font-medium text-[var(--text)]">{selected.size} selected</span>
          <select
            value={bulkPreset}
            onChange={(event) => setBulkPreset(event.target.value as PlatformPresetId)}
            aria-label="Export preset"
            className="ml-auto h-9 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-2 text-xs text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            {PLATFORM_PRESET_LIST.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={exportSelected}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--accent-contrast)] transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            Export {selected.size}
          </button>
          <button
            type="button"
            onClick={deleteSelected}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--border-subtle)] px-3 text-xs font-medium text-[var(--danger)] transition-colors hover:bg-[color-mix(in_oklab,var(--danger)_14%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            Delete {selected.size}
          </button>
        </div>
      ) : null}

      {/* Manual "add clip from selection": marks come from the seekbar handles or
          the buttons below, both bound to the shared mark-in/out state. */}
      <div className="flex flex-col gap-2 rounded-lg border border-[var(--border-subtle)] p-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setMarkIn(getCurrentTime())}
            className="rounded-md bg-[var(--surface-overlay)] px-2.5 py-1 font-medium text-[var(--text)] transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            Mark in
          </button>
          <button
            type="button"
            onClick={() => setMarkOut(getCurrentTime())}
            className="rounded-md bg-[var(--surface-overlay)] px-2.5 py-1 font-medium text-[var(--text)] transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            Mark out
          </button>
          <span className="font-mono tabular-nums text-[var(--text-muted)]">
            {markIn === null ? "—" : formatDuration(markIn)} → {markOut === null ? "—" : formatDuration(markOut)}
          </span>
          <button
            type="button"
            onClick={addClip}
            disabled={rangeError !== null || busy}
            className="ml-auto rounded-md bg-[var(--accent)] px-2.5 py-1 font-medium text-[var(--accent-contrast)] transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            Add clip
          </button>
        </div>
        {rangeError !== null && (markIn !== null || markOut !== null) ? (
          <p className="text-xs text-[var(--text-muted)]">{rangeError}</p>
        ) : null}
      </div>

      {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}

      {clips.length === 0 && loading ? (
        <ClipCardSkeletons />
      ) : emptyMessage ? (
        <p data-testid="clips-empty" className="rounded-lg border border-[var(--border-subtle)] p-6 text-sm text-[var(--text-muted)]">
          {emptyMessage}
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {clips.map((clip, index) => (
            <li key={clip.id}>
              <ClipCard
                clip={clip}
                rank={index + 1}
                maxScore={maxScore}
                thumbVersion={thumbVersion}
                selected={selected.has(clip.id)}
                onToggleSelect={toggleSelect}
                onPreview={onPreview}
                onRename={rename}
                onDelete={onDelete}
                onReasonClick={onReasonClick}
                disabled={busy}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
