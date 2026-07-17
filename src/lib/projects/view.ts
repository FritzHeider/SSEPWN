/**
 * Pure presentation logic for the project list.
 *
 * Deliberately free of React and of Node builtins: this is the part of the page
 * that makes decisions, so it is the part worth testing (DEC-005). The
 * components that consume it stay thin enough to read at a glance.
 */

/** The subset of a project row the list actually renders. */
export interface ProjectView {
  id: number;
  name: string;
  status: string;
  error: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  thumbnailPath: string | null;
}

/** Visual weight of a badge; maps to colour in the component, not here. */
export type BadgeTone = "neutral" | "progress" | "success" | "danger";

export interface StatusBadge {
  label: string;
  tone: BadgeTone;
  /** Human-readable failure reason, shown only when there is one. */
  detail: string | null;
  /** True while the project is still expected to change on its own. */
  pending: boolean;
}

/** Placeholder for a value that does not exist yet — not zero, not unknown. */
export const EMPTY = "—";

const BADGES: Readonly<Record<string, { label: string; tone: BadgeTone; pending: boolean }>> = {
  created: { label: "Created", tone: "neutral", pending: true },
  uploaded: { label: "Processing", tone: "progress", pending: true },
  ready: { label: "Ready", tone: "success", pending: false },
  failed: { label: "Failed", tone: "danger", pending: false },
};

/**
 * Badge for a project's status.
 *
 * `uploaded` reads as "Processing" because that is what it means to a user: the
 * bytes have landed and the ingest job is queued or running. An unrecognised
 * status renders as itself rather than throwing — phases 03-10 add statuses, and
 * an unknown one must not blank the whole list.
 */
export function statusBadge(project: Pick<ProjectView, "status" | "error">): StatusBadge {
  const known = BADGES[project.status];
  const detail = project.error?.trim() ? project.error.trim() : null;

  if (!known) {
    return { label: project.status || "Unknown", tone: "neutral", detail, pending: false };
  }
  return { ...known, detail };
}

/**
 * `h:mm:ss` past an hour, `m:ss` below it.
 *
 * Null until the ingest handler has probed the source, which is the entire
 * window between upload and ready — so the null case is normal, not an edge
 * case, and must not render as "NaN" or a misleading "0:00".
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return EMPTY;
  }

  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/** `1280×720`, or EMPTY until probed. Both dimensions or neither. */
export function formatResolution(
  width: number | null | undefined,
  height: number | null | undefined,
): string {
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) return EMPTY;
  return `${width}×${height}`;
}

/**
 * Whether to render the poster at all.
 *
 * Driven by the row, not by hope: `GET /api/projects/:id/thumbnail` 404s cleanly
 * while a project is mid-ingest (DEC-004), so asking for a poster that the DB
 * says does not exist would knowingly request a broken image on every poll.
 */
export function shouldShowThumbnail(project: Pick<ProjectView, "status" | "thumbnailPath">): boolean {
  return project.status === "ready" && Boolean(project.thumbnailPath);
}

/** The poster URL for a project. Ids come from the DB, never from user input. */
export function thumbnailUrl(projectId: number): string {
  return `/api/projects/${projectId}/thumbnail`;
}

/**
 * Whether the list should keep polling: true while any project is still expected
 * to change. An all-settled list has nothing to refresh for, and phase-11's
 * dashboard will want the same signal.
 */
export function hasPendingWork(projects: ReadonlyArray<Pick<ProjectView, "status" | "error">>): boolean {
  return projects.some((project) => statusBadge(project).pending);
}
