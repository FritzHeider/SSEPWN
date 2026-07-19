/**
 * Pure presentation logic for the export panel (Phase 10, DEC-005 pattern).
 *
 * React-free and Node-free, like `projects/clips-panel.ts`: the decisions an
 * export row makes — how its status reads, whether the poller should keep
 * asking, how wide the progress bar is, when Download and Retry are allowed —
 * live here where node-env vitest can test them honestly, and the JSX that
 * consumes them stays thin. The API is the authority on the lifecycle; this only
 * renders what a row already says.
 */

import { resolvePlatformPreset } from "@/lib/presets";

/** The `exports.status` lifecycle the worker drives (schema.ts). */
export const EXPORT_STATUSES = ["queued", "running", "done", "failed"] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/** Encode quality knob carried in the export job payload, not on the row. */
export const EXPORT_QUALITIES = ["final", "draft"] as const;
export type ExportQuality = (typeof EXPORT_QUALITIES)[number];

/**
 * The shape the UI consumes for one export, mirroring the `exports` table row
 * the history and status APIs return. Kept as a local interface (not the drizzle
 * `$inferSelect`) so this stays a pure, DB-free module.
 */
export interface ExportRow {
  id: number;
  clipId: number;
  preset: string;
  outputPath: string | null;
  status: string;
  jobId: number | null;
  error: string | null;
  createdAt: number;
}

/** Terminal statuses: the worker will not touch the row again. */
export function isTerminalExport(status: string): boolean {
  return status === "done" || status === "failed";
}

/**
 * Whether the progress poller should keep asking `GET /api/exports/:id`.
 *
 * Poll while the row is not terminal — including an unrecognised status, so a
 * schema the client has not caught up to still resolves rather than spinning
 * forever is the *caller's* bounded-tries job; here "not done, not failed" means
 * "still worth a look".
 */
export function shouldPollExport(status: string): boolean {
  return !isTerminalExport(status);
}

/** Human label for a status, never blank (unknown → the raw value or "Unknown"). */
export function exportStatusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Rendering…";
    case "done":
      return "Ready";
    case "failed":
      return "Failed";
    default:
      return status.trim() || "Unknown";
  }
}

/** A progress value clamped to an integer in [0, 100]; non-finite → 0. */
export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * The width the progress bar should render, as a `%` string.
 *
 * A `done` row pins to 100% even if the terminal tick lost the race with the
 * status write (mirrors the API's own `done → 100` pin); otherwise it reflects
 * the clamped live progress.
 */
export function progressBarWidth(status: string, progress: number): string {
  const pct = status === "done" ? 100 : clampProgress(progress);
  return `${pct}%`;
}

/** Download is offered only for a finished render that actually wrote a file. */
export function canDownloadExport(row: Pick<ExportRow, "status" | "outputPath">): boolean {
  return row.status === "done" && typeof row.outputPath === "string" && row.outputPath.length > 0;
}

/** Retry is offered only for a terminal failure (re-POSTs the export). */
export function canRetryExport(status: string): boolean {
  return status === "failed";
}

/** The download endpoint for an export id. */
export function exportDownloadUrl(id: number): string {
  return `/api/exports/${id}/download`;
}

/** A preset id's display label, tolerating an unknown id (falls back to product default). */
export function exportPresetLabel(presetId: string): string {
  return resolvePlatformPreset(presetId).label;
}

/** A quality's display label. */
export function exportQualityLabel(quality: string): string {
  switch (quality) {
    case "draft":
      return "Draft (fast)";
    case "final":
      return "Final";
    default:
      return quality.trim() || "Final";
  }
}

/**
 * A readable failure message from a row's stored error, or `null` when there is
 * nothing to show. ffmpeg failures land here as a stderr tail that can run to
 * many lines; the UI wants the gist, so this trims and caps the length while
 * keeping the message intact enough to act on.
 */
export function exportErrorMessage(error: string | null | undefined, max = 400): string | null {
  if (typeof error !== "string") return null;
  const trimmed = error.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}
