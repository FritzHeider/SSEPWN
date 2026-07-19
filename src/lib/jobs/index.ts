import { eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "../db/schema";
import { jobs } from "../db/schema";

export type JobsDb = BetterSQLite3Database<typeof schema>;

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: number;
  projectId: number;
  type: string;
  status: JobStatus;
  /** 0–100. */
  progress: number;
  error: string | null;
  /** Parsed from the payload JSON column; null when no payload was given. */
  payload: unknown;
  /** Includes the current attempt while the job is running. */
  attempts: number;
  maxAttempts: number;
  /** Epoch milliseconds — earliest time this job may be claimed. */
  runAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface JobQueueOptions {
  /** Epoch milliseconds. Injectable so retry backoff is testable without sleeps. */
  now?: () => number;
  /** Delay before retrying a job that has already failed `attempt` times. */
  backoffMs?: (attempt: number) => number;
  /** Total attempts allowed per job (initial try + retries). */
  maxAttempts?: number;
}

/** Exponential: 1s after the first failure, 2s after the second, capped at 30s. */
export function defaultBackoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30_000);
}

/** Shape returned by the raw claim statement (SQLite column names). */
interface JobRow {
  id: number;
  project_id: number;
  type: string;
  status: string;
  progress: number;
  error: string | null;
  payload: string | null;
  attempts: number;
  max_attempts: number;
  run_at: number;
  created_at: number;
  updated_at: number;
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    status: row.status as JobStatus,
    progress: row.progress,
    error: row.error,
    payload: row.payload === null ? null : (JSON.parse(row.payload) as unknown),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: row.run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface JobQueue {
  enqueue(type: string, projectId: number, payload?: unknown): Job;
  claimNext(): Job | null;
  updateProgress(id: number, progress: number): void;
  complete(id: number): void;
  fail(id: number, error: unknown): Job | null;
  /**
   * Re-queue jobs a crashed worker left `running`. See the implementation for
   * the staleness rule and attempt-budget handling.
   */
  recoverStale(staleAfterMs?: number): { requeued: number; failed: number };
  get(id: number): Job | null;
  /** Every job for a project, oldest first. */
  listByProject(projectId: number): Job[];
}

/** Default staleness window before a `running` job is treated as abandoned. */
export const DEFAULT_STALE_JOB_MS = 5 * 60 * 1000;

/**
 * SQLite-backed job queue (SPEC.md § Tech stack — no Redis, no external
 * services). The drizzle instance is passed in rather than imported so that
 * importing this module has no side effects: `src/lib/db/index.ts` opens the
 * database file at import time.
 */
export function createJobQueue(db: JobsDb, options: JobQueueOptions = {}): JobQueue {
  const now = options.now ?? (() => Date.now());
  const backoffMs = options.backoffMs ?? defaultBackoffMs;
  const maxAttempts = options.maxAttempts ?? 3;

  function get(id: number): Job | null {
    const rows = db.all<JobRow>(sql`SELECT * FROM ${jobs} WHERE ${jobs.id} = ${id}`);
    return rows.length > 0 ? rowToJob(rows[0]) : null;
  }

  return {
    enqueue(type, projectId, payload) {
      if (type.trim() === "") {
        throw new Error("Job type must be a non-empty string");
      }

      const [inserted] = db
        .insert(jobs)
        .values({
          projectId,
          type,
          status: "queued",
          payload: payload === undefined ? null : JSON.stringify(payload),
          maxAttempts,
          runAt: now(),
        })
        .returning({ id: jobs.id })
        .all();

      const job = get(inserted.id);
      if (!job) {
        throw new Error(`Enqueued job ${inserted.id} disappeared`);
      }
      return job;
    },

    /**
     * Atomically claim the oldest due job. This is deliberately ONE statement:
     * SQLite serialises it under the write lock, so two workers in separate
     * processes can never claim the same job. A read-then-write claim would
     * pass an in-process test (better-sqlite3 is synchronous) yet still race
     * between real worker processes.
     */
    claimNext() {
      const rows = db.all<JobRow>(sql`
        UPDATE ${jobs}
        SET status = 'running',
            attempts = attempts + 1,
            updated_at = unixepoch()
        WHERE id = (
          SELECT id FROM ${jobs}
          WHERE status = 'queued' AND run_at <= ${now()}
          ORDER BY run_at ASC, id ASC
          LIMIT 1
        )
        RETURNING *
      `);
      return rows.length > 0 ? rowToJob(rows[0]) : null;
    },

    updateProgress(id, progress) {
      const clamped = Math.max(0, Math.min(100, Math.round(progress)));
      db.update(jobs)
        .set({ progress: clamped, updatedAt: sql`(unixepoch())` })
        .where(eq(jobs.id, id))
        .run();
    },

    complete(id) {
      db.update(jobs)
        .set({
          status: "done",
          progress: 100,
          error: null,
          updatedAt: sql`(unixepoch())`,
        })
        .where(eq(jobs.id, id))
        .run();
    },

    /**
     * Record a failed attempt. Requeues with backoff while attempts remain,
     * otherwise marks the job `failed`. Returns the job's new state, or null
     * if no such job exists.
     */
    fail(id, error) {
      const message = error instanceof Error ? error.message : String(error);

      return db.transaction((tx): Job | null => {
        const rows = tx.all<JobRow>(sql`SELECT * FROM ${jobs} WHERE ${jobs.id} = ${id}`);
        if (rows.length === 0) return null;
        const job = rowToJob(rows[0]);

        const exhausted = job.attempts >= job.maxAttempts;
        tx.update(jobs)
          .set(
            exhausted
              ? { status: "failed", error: message, updatedAt: sql`(unixepoch())` }
              : {
                  status: "queued",
                  error: message,
                  runAt: now() + backoffMs(job.attempts),
                  updatedAt: sql`(unixepoch())`,
                },
          )
          .where(eq(jobs.id, id))
          .run();

        const updated = tx.all<JobRow>(sql`SELECT * FROM ${jobs} WHERE ${jobs.id} = ${id}`);
        return rowToJob(updated[0]);
      });
    },

    /**
     * Recover jobs a crashed worker left stuck in `running`. Nothing else clears
     * that state: a process that dies mid-handler never calls `fail`, so without
     * this the job would sit `running` forever and the pipeline would stall.
     *
     * A job is stale when its `updated_at` (bumped by every claim and progress
     * update, so a live worker keeps it fresh) is older than `staleAfterMs`.
     * Stale jobs with attempts left are re-queued for immediate reclaim; jobs
     * that have already spent their attempt budget are marked `failed` instead,
     * so a job that hard-crashes the worker can't loop forever. Call once on
     * worker start, before the poll loop. Returns how many took each path.
     *
     * NOTE: `updated_at` is epoch SECONDS (schema), while `run_at`/`now()` are
     * epoch MILLISECONDS — hence the divide-by-1000 for the cutoff.
     */
    recoverStale(staleAfterMs = DEFAULT_STALE_JOB_MS) {
      const cutoffSeconds = Math.floor((now() - staleAfterMs) / 1000);
      const nowMs = now();

      const failedRows = db.all<JobRow>(sql`
        UPDATE ${jobs}
        SET status = 'failed',
            error = 'Worker exited while this job was running; attempt budget exhausted',
            updated_at = unixepoch()
        WHERE status = 'running' AND updated_at < ${cutoffSeconds} AND attempts >= max_attempts
        RETURNING *
      `);

      const requeuedRows = db.all<JobRow>(sql`
        UPDATE ${jobs}
        SET status = 'queued',
            run_at = ${nowMs},
            updated_at = unixepoch()
        WHERE status = 'running' AND updated_at < ${cutoffSeconds} AND attempts < max_attempts
        RETURNING *
      `);

      return { requeued: requeuedRows.length, failed: failedRows.length };
    },

    get,

    listByProject(projectId) {
      const rows = db.all<JobRow>(sql`
        SELECT * FROM ${jobs}
        WHERE ${jobs.projectId} = ${projectId}
        ORDER BY ${jobs.id} ASC
      `);
      return rows.map(rowToJob);
    },
  };
}
