/**
 * Pure aggregation for the project-level exports drawer (item 24).
 *
 * There is no project-wide exports endpoint — export history is per clip
 * (`GET /api/clips/:id/export`, which carries the preset) — so the drawer joins
 * three sources client-side: the per-clip history rows (identity + preset +
 * download availability), the clip titles from the clips list, and the live
 * status/progress from the SSE `exports` event. That join and the queued/
 * rendering/done/failed tally are the testable decisions and live here; the
 * drawer component only fetches and renders.
 */

/** A history row as `GET /api/clips/:id/export` returns it (subset we use). */
export interface ExportHistoryRow {
  id: number;
  clipId: number;
  preset: string;
  status: string;
  outputPath: string | null;
}

/** The live overlay from the SSE `exports` event (`ExportSummary`). */
export interface LiveExport {
  id: number;
  clipId: number;
  status: string;
  progress: number;
}

/** One row the drawer renders: history identity, overlaid live status/progress,
 * the owning clip's title, and whether a finished file is downloadable. */
export interface DrawerExport {
  id: number;
  clipId: number;
  clipTitle: string;
  preset: string;
  status: string;
  progress: number;
  downloadable: boolean;
}

/** The status buckets shown as counts at the top of the drawer. `running`
 * renders as "Rendering"; anything unrecognised is ignored in the tally but
 * still listed as a row. */
export interface ExportCounts {
  queued: number;
  rendering: number;
  done: number;
  failed: number;
  total: number;
}

/** Progress a status implies on its own, before any live overlay: a done export
 * is 100 even if its render job row is gone. */
function baseProgress(status: string): number {
  return status === "done" ? 100 : 0;
}

/**
 * Merge history rows with the live SSE overlay and clip titles into the drawer's
 * row model, newest first (descending id). The live event wins for `status` and
 * `progress` when it carries the export (the worker is actively rendering it);
 * otherwise the history row's own status stands. A missing clip title falls back
 * to "Clip N" so a row is never blank.
 */
export function buildDrawerRows(
  history: readonly ExportHistoryRow[],
  live: ReadonlyMap<number, LiveExport>,
  clipTitles: ReadonlyMap<number, string>,
): DrawerExport[] {
  return history
    .map((row): DrawerExport => {
      const overlay = live.get(row.id);
      const status = overlay?.status ?? row.status;
      const progress = overlay ? overlay.progress : baseProgress(status);
      const title = clipTitles.get(row.clipId)?.trim();
      return {
        id: row.id,
        clipId: row.clipId,
        clipTitle: title && title.length > 0 ? title : `Clip ${row.clipId}`,
        preset: row.preset,
        status,
        progress: status === "done" ? 100 : progress,
        downloadable: status === "done",
      };
    })
    .sort((a, b) => b.id - a.id);
}

/** Tally the drawer rows by status for the summary counts. */
export function aggregateExportCounts(rows: readonly { status: string }[]): ExportCounts {
  const counts: ExportCounts = { queued: 0, rendering: 0, done: 0, failed: 0, total: rows.length };
  for (const row of rows) {
    if (row.status === "queued") counts.queued += 1;
    else if (row.status === "running") counts.rendering += 1;
    else if (row.status === "done") counts.done += 1;
    else if (row.status === "failed") counts.failed += 1;
  }
  return counts;
}
