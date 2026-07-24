/**
 * Worker liveness: a heartbeat file the worker touches every poll iteration, and
 * the pure staleness decision `GET /api/health` renders from it.
 *
 * The worker (`npm run worker`) and the Next server are separate OS processes, so
 * the server cannot see the worker directly — it infers liveness from a small
 * durable file the worker keeps fresh. `deriveHealth` is the only decision here
 * and is pure (timestamp in, verdict out) so it is unit-testable without a clock
 * or a filesystem; the read/write helpers are thin wrappers around it.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A heartbeat older than this reads as `offline`. 10s is ~20 idle poll ticks
 * (the loop polls every 500ms), so a healthy idle worker never trips it while a
 * dead one is noticed within a couple of poll intervals.
 */
export const HEARTBEAT_STALE_MS = 10_000;

/** Where the worker writes its heartbeat; env-overridable for tests/CI. */
export function heartbeatPath(): string {
  return process.env.SSECLONE_HEARTBEAT_PATH ?? path.join("data", "worker.heartbeat");
}

/** The heartbeat payload: which process, and when it last ticked (epoch ms). */
export interface Heartbeat {
  pid: number;
  at: number;
}

/**
 * Write the heartbeat file. Called on every worker poll iteration; a whole-file
 * overwrite is atomic enough for a single writer and keeps the mechanism to one
 * `writeFileSync`. `at` is epoch MILLISECONDS to match `Date.now()` on the read
 * side.
 */
export function writeHeartbeat(pid: number = process.pid, now: number = Date.now(), file: string = heartbeatPath()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const beat: Heartbeat = { pid, at: now };
  writeFileSync(file, JSON.stringify(beat));
}

/**
 * The epoch-ms timestamp of the last heartbeat, or `null` when there is none.
 *
 * Prefers the `at` field inside the file (written by `writeHeartbeat`), falling
 * back to the file's mtime if the contents are unreadable/corrupt, and to `null`
 * only when the file is absent — so a missing worker never throws, it just reads
 * as "never seen".
 */
export function readHeartbeatAt(file: string = heartbeatPath()): number | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Heartbeat>;
    if (typeof parsed.at === "number" && Number.isFinite(parsed.at)) return parsed.at;
  } catch {
    // Unreadable or not JSON — fall through to the mtime.
  }
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

export type WorkerHealth = "online" | "offline";

export interface HealthResult {
  worker: WorkerHealth;
  /** Epoch-ms timestamp of the last heartbeat, or null when never seen. */
  lastSeenMs: number | null;
}

/**
 * Decide worker health from the last-heartbeat timestamp. Pure: no clock, no fs.
 * `null` (no heartbeat file) is `offline`; otherwise `online` while the heartbeat
 * is within `staleMs` of `nowMs`. A future timestamp (clock skew) counts as
 * online rather than offline.
 */
export function deriveHealth(
  lastSeenAtMs: number | null,
  nowMs: number,
  staleMs: number = HEARTBEAT_STALE_MS,
): HealthResult {
  if (lastSeenAtMs === null) return { worker: "offline", lastSeenMs: null };
  const online = nowMs - lastSeenAtMs <= staleMs;
  return { worker: online ? "online" : "offline", lastSeenMs: lastSeenAtMs };
}
