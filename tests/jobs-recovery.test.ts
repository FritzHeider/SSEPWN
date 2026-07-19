import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { jobs } from "../src/lib/db/schema";
import { createJobQueue, DEFAULT_STALE_JOB_MS } from "../src/lib/jobs";
import { createTestDb, seedProject, type TestDb } from "./helpers/db";

const open: TestDb[] = [];

function freshDb(): TestDb {
  const handle = createTestDb();
  open.push(handle);
  return handle;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

/** Backdate a job's updated_at (epoch seconds) so it looks abandoned. */
function ageJob(db: TestDb["db"], id: number, secondsAgo: number): void {
  db.run(sql`UPDATE ${jobs} SET updated_at = unixepoch() - ${secondsAgo} WHERE id = ${id}`);
}

describe("recoverStale", () => {
  it("re-queues a stale running job so it can be claimed again", () => {
    const { db } = freshDb();
    const queue = createJobQueue(db);
    const projectId = seedProject(db);

    const job = queue.enqueue("ingest", projectId, { path: "a.mp4" });
    const claimed = queue.claimNext();
    expect(claimed?.id).toBe(job.id);
    expect(queue.get(job.id)?.status).toBe("running");

    // Simulate a crash: the job stays running, untouched, for an hour.
    ageJob(db, job.id, 3600);

    const result = queue.recoverStale();
    expect(result).toEqual({ requeued: 1, failed: 0 });

    const recovered = queue.get(job.id);
    expect(recovered?.status).toBe("queued");
    expect(recovered?.payload).toEqual({ path: "a.mp4" });

    // Immediately claimable — run_at was reset to now, not left in the future.
    expect(queue.claimNext()?.id).toBe(job.id);
  });

  it("leaves a freshly-updated running job alone", () => {
    const { db } = freshDb();
    const queue = createJobQueue(db);
    const projectId = seedProject(db);

    const job = queue.enqueue("transcribe", projectId);
    queue.claimNext();
    // No ageing: a live worker keeps updated_at fresh.

    expect(queue.recoverStale()).toEqual({ requeued: 0, failed: 0 });
    expect(queue.get(job.id)?.status).toBe("running");
  });

  it("fails a stale job that has exhausted its attempt budget instead of looping", () => {
    const { db } = freshDb();
    // maxAttempts 1: a single claim already spends the whole budget.
    const queue = createJobQueue(db, { maxAttempts: 1 });
    const projectId = seedProject(db);

    const job = queue.enqueue("generate-clips", projectId);
    const claimed = queue.claimNext();
    expect(claimed?.attempts).toBe(1);
    ageJob(db, job.id, 3600);

    const result = queue.recoverStale();
    expect(result).toEqual({ requeued: 0, failed: 1 });

    const failed = queue.get(job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatch(/attempt budget exhausted/i);
    // Terminal: nothing left to claim.
    expect(queue.claimNext()).toBeNull();
  });

  it("only recovers jobs older than the given window", () => {
    const { db } = freshDb();
    const queue = createJobQueue(db);
    const projectId = seedProject(db);

    const oldJob = queue.enqueue("ingest", projectId);
    const recentJob = queue.enqueue("ingest", projectId);
    queue.claimNext(); // claims oldJob (lower id)
    queue.claimNext(); // claims recentJob
    ageJob(db, oldJob.id, 600); // 10 min old
    ageJob(db, recentJob.id, 30); // 30 s old

    // A 5-minute window catches only the 10-minute-old job.
    const result = queue.recoverStale(5 * 60 * 1000);
    expect(result).toEqual({ requeued: 1, failed: 0 });
    expect(queue.get(oldJob.id)?.status).toBe("queued");
    expect(queue.get(recentJob.id)?.status).toBe("running");
  });

  it("does nothing when there are no running jobs", () => {
    const { db } = freshDb();
    const queue = createJobQueue(db);
    seedProject(db);
    expect(queue.recoverStale(DEFAULT_STALE_JOB_MS)).toEqual({ requeued: 0, failed: 0 });
  });
});
