/**
 * Pure snapshot + diff logic for the SSE stream `GET /api/events` (phase-BE
 * task 2). The route reads the DB on a timer, builds one of these plain-object
 * snapshots, and asks the functions here what changed since the previous tick.
 * No DB, no timers, no Response — so the "what changed" decision is unit-testable
 * and the route stays a thin transport shell.
 *
 * Two modes share one contract:
 *  - a PROJECT snapshot (`?projectId=N`) carries the project's jobs, clip set and
 *    exports; changes emit `jobs` / `clips` / `exports` events;
 *  - a HOME snapshot (no projectId) carries the project summaries for the
 *    dashboard list; changes emit a `projects` event.
 *
 * The initial `snapshot` event the route sends on connect carries EVERY section
 * (empty arrays included) so a client has a complete baseline, and each later
 * delta event reuses the identical per-section shape — one code path seeds and
 * swaps.
 */

/** One job row as the stream reports it (a subset of the queue's `Job`). */
export interface JobSummary {
  id: number;
  type: string;
  status: string;
  attempts: number;
  error: string | null;
  progress: number;
  updatedAt: number;
}

/** A clip's identity + the fields that make the set "change" and warrant a refetch. */
export interface ClipSummary {
  id: number;
  title: string | null;
  inPoint: number;
  outPoint: number;
  status: string;
}

/** One export's live status + progress (progress resolved the same way
 * `GET /api/exports/:id` resolves it). */
export interface ExportSummary {
  id: number;
  clipId: number;
  status: string;
  progress: number;
}

/** One dashboard card's summary for the home-list stream. */
export interface ProjectSummary {
  id: number;
  name: string;
  status: string;
  clipCount: number;
  exportCount: number;
}

/** A single project's live state. */
export interface ProjectSnapshot {
  jobs: JobSummary[];
  clips: ClipSummary[];
  exports: ExportSummary[];
}

/** The home dashboard's live state. */
export interface HomeSnapshot {
  projects: ProjectSummary[];
}

/** An event to write to the stream: SSE `event:` name + JSON `data:` payload. */
export interface SseFrame {
  event: string;
  data: unknown;
}

/** Structural equality via canonical JSON. Both sides are plain objects built
 * here in a fixed field order, so stringify is a sound, cheap deep-compare. */
function differs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * Frames to emit for a project stream. With `prev === null` (first tick) every
 * section is emitted; otherwise only the sections whose rows changed.
 */
export function diffProjectSnapshot(
  prev: ProjectSnapshot | null,
  next: ProjectSnapshot,
): SseFrame[] {
  const frames: SseFrame[] = [];
  if (prev === null || differs(prev.jobs, next.jobs)) frames.push({ event: "jobs", data: next.jobs });
  if (prev === null || differs(prev.clips, next.clips)) frames.push({ event: "clips", data: next.clips });
  if (prev === null || differs(prev.exports, next.exports)) {
    frames.push({ event: "exports", data: next.exports });
  }
  return frames;
}

/** Frames to emit for the home stream: a `projects` event when the list changed. */
export function diffHomeSnapshot(prev: HomeSnapshot | null, next: HomeSnapshot): SseFrame[] {
  if (prev === null || differs(prev.projects, next.projects)) {
    return [{ event: "projects", data: next.projects }];
  }
  return [];
}

/**
 * Serialize a frame as an SSE block: `event: <name>\ndata: <json>\n\n`. Data is
 * single-line JSON so it never needs multi-line `data:` folding.
 */
export function formatSseFrame(frame: SseFrame): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

/** The initial full-baseline frame sent on connect (event `snapshot`). */
export function snapshotFrame(snapshot: ProjectSnapshot | HomeSnapshot): SseFrame {
  return { event: "snapshot", data: snapshot };
}
