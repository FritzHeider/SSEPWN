import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { jobs } from "../src/lib/db/schema";
import { createJobQueue, type JobQueue } from "../src/lib/jobs";
import type { HandlerRegistry } from "../src/worker/handlers";
import { createWorker, type Worker } from "../src/worker/loop";
import { createTestDb, seedProject, type TestDb } from "./helpers/db";

const POLL_MS = 5;

const silentLogger = { log: () => {}, error: () => {} };

/** Resolves once `predicate` holds; fails the test rather than hanging forever. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("worker loop", () => {
  let testDb: TestDb;
  let queue: JobQueue;
  let projectId: number;

  beforeEach(() => {
    testDb = createTestDb();
    // No backoff delay: retry timing is the queue's contract (already tested in
    // jobs.test.ts), and real waits would only make this suite slow.
    queue = createJobQueue(testDb.db, { backoffMs: () => 0 });
    projectId = seedProject(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  function startWorker(handlers: HandlerRegistry) {
    const worker = createWorker({
      queue,
      db: testDb.db,
      handlers,
      pollMs: POLL_MS,
      logger: silentLogger,
    });
    void worker.start();
    return worker;
  }

  it("dispatches a claimed job to the handler registered for its type", async () => {
    const seen: string[] = [];
    const handlers: HandlerRegistry = {
      ingest: async ({ job }) => {
        seen.push(`ingest:${String(job.payload)}`);
      },
      transcribe: async () => {
        seen.push("transcribe");
      },
    };
    const worker = startWorker(handlers);
    const job = queue.enqueue("ingest", projectId, "video.mp4");

    await waitFor(() => queue.get(job.id)?.status === "done", "ingest job to finish");
    await worker.stop();

    expect(seen).toEqual(["ingest:video.mp4"]);
    const finished = queue.get(job.id);
    expect(finished?.status).toBe("done");
    expect(finished?.progress).toBe(100);
    expect(finished?.error).toBeNull();
  });

  it("exposes progress reporting to handlers", async () => {
    let observed: number | undefined;
    const worker = startWorker({
      ingest: async ({ job, setProgress }) => {
        setProgress(42);
        observed = queue.get(job.id)?.progress;
      },
    });
    const job = queue.enqueue("ingest", projectId);

    await waitFor(() => queue.get(job.id)?.status === "done", "job to finish");
    await worker.stop();

    expect(observed).toBe(42);
  });

  it("fails a job with a human-readable error when no handler is registered", async () => {
    const worker = createWorker({
      queue: createJobQueue(testDb.db, { backoffMs: () => 0, maxAttempts: 1 }),
      db: testDb.db,
      handlers: {},
      pollMs: POLL_MS,
      logger: silentLogger,
    });
    void worker.start();
    const job = queue.enqueue("nonexistent", projectId);

    await waitFor(() => queue.get(job.id)?.status === "failed", "job to fail");
    await worker.stop();

    expect(queue.get(job.id)?.error).toBe('No handler registered for job type "nonexistent"');
  });

  // Phase-02 acceptance: a handler that throws twice then succeeds ends `done`
  // with attempts=3 — the initial try plus the two allowed retries.
  it("retries a throwing handler and ends done with attempts=3", async () => {
    let calls = 0;
    const worker = startWorker({
      ingest: async () => {
        calls += 1;
        if (calls <= 2) throw new Error(`boom ${calls}`);
      },
    });
    const job = queue.enqueue("ingest", projectId);

    await waitFor(() => queue.get(job.id)?.status === "done", "job to succeed after retries");
    await worker.stop();

    const finished = queue.get(job.id);
    expect(calls).toBe(3);
    expect(finished?.status).toBe("done");
    expect(finished?.attempts).toBe(3);
    expect(finished?.error).toBeNull();
  });

  it("marks a job failed once retries are exhausted", async () => {
    const worker = startWorker({
      ingest: async () => {
        throw new Error("always broken");
      },
    });
    const job = queue.enqueue("ingest", projectId);

    await waitFor(() => queue.get(job.id)?.status === "failed", "job to exhaust retries");
    await worker.stop();

    const finished = queue.get(job.id);
    expect(finished?.attempts).toBe(3);
    expect(finished?.error).toBe("always broken");
  });

  it("finishes the in-flight job on shutdown and leaves queued work untouched", async () => {
    const entered = deferred();
    const release = deferred();
    let started = 0;
    const worker = startWorker({
      ingest: async () => {
        started += 1;
        entered.resolve();
        await release.promise;
      },
    });
    const first = queue.enqueue("ingest", projectId);
    const second = queue.enqueue("ingest", projectId);

    await entered.promise;
    const stopped = worker.stop(); // shutdown requested mid-job
    release.resolve();
    await stopped;

    expect(started).toBe(1);
    expect(queue.get(first.id)?.status).toBe("done");
    // The second job is left for another worker rather than being abandoned
    // half-done or claimed and dropped.
    expect(queue.get(second.id)?.status).toBe("queued");
    expect(queue.get(second.id)?.attempts).toBe(0);
  });

  // The test above only covers shutdown arriving *during* a handler. The nastier
  // window is between claimNext() and dispatch: a job is already claimed
  // (status=running, attempt spent) but not yet started, so bailing out there
  // strands it in `running` forever — no worker will ever re-claim it. Injecting
  // the stop from inside claimNext lands shutdown exactly in that window.
  it("never abandons a job claimed in the same tick shutdown is requested", async () => {
    // Indirection so `worker` can be referenced from the queue it is built with.
    const shutdown = { request: () => {} };
    const instrumented: JobQueue = {
      ...queue,
      claimNext: () => {
        const claimed = queue.claimNext();
        if (claimed) shutdown.request();
        return claimed;
      },
    };
    const worker: Worker = createWorker({
      queue: instrumented,
      db: testDb.db,
      handlers: { ingest: async () => {} },
      pollMs: POLL_MS,
      logger: silentLogger,
    });
    shutdown.request = () => void worker.stop();
    const job = queue.enqueue("ingest", projectId);

    await worker.start();

    expect(queue.get(job.id)?.status).toBe("done");
  });

  // Crash recovery: a job left `running` by a previous (crashed) worker must be
  // picked back up on the next worker's start, not stranded forever.
  it("recovers and processes a stale running job left by a crashed worker", async () => {
    const seen: number[] = [];
    // Simulate the crashed worker: claim a job (status=running) but never finish
    // it, then backdate updated_at so it looks abandoned.
    const job = queue.enqueue("ingest", projectId);
    const claimed = queue.claimNext();
    expect(claimed?.status).toBe("running");
    testDb.db.run(sql`UPDATE ${jobs} SET updated_at = unixepoch() - 3600 WHERE id = ${job.id}`);

    const worker = startWorker({
      ingest: async ({ job: j }) => {
        seen.push(j.id);
      },
    });

    await waitFor(() => queue.get(job.id)?.status === "done", "recovered job to finish");
    await worker.stop();

    expect(seen).toEqual([job.id]);
    expect(queue.get(job.id)?.status).toBe("done");
  });
});
