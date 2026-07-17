import { afterEach, describe, expect, it } from "vitest";

import { createJobQueue, defaultBackoffMs } from "../src/lib/jobs";
import { createTestDb, openTestDb, seedProject, type TestDb } from "./helpers/db";

const open: TestDb[] = [];

function freshDb(): TestDb {
  const handle = createTestDb();
  open.push(handle);
  return handle;
}

/** A clock the queue reads through `now`, so backoff needs no real sleeping. */
function clock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

describe("enqueue", () => {
  it("creates a queued job with no attempts yet and round-trips the payload", () => {
    const { db } = freshDb();
    const queue = createJobQueue(db);
    const projectId = seedProject(db);

    const job = queue.enqueue("ingest", projectId, { path: "data/uploads/a.mp4" });

    expect(job.type).toBe("ingest");
    expect(job.projectId).toBe(projectId);
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(job.progress).toBe(0);
    expect(job.error).toBeNull();
    expect(job.payload).toEqual({ path: "data/uploads/a.mp4" });
  });

  it("stores a null payload when none is given", () => {
    const { db } = freshDb();
    const queue = createJobQueue(db);
    const job = queue.enqueue("ingest", seedProject(db));
    expect(job.payload).toBeNull();
  });

  it("rejects an empty job type", () => {
    const { db } = freshDb();
    const queue = createJobQueue(db);
    const projectId = seedProject(db);
    expect(() => queue.enqueue("   ", projectId)).toThrow(/non-empty/);
  });
});

describe("claimNext", () => {
  it("claims the job, flips it to running, and counts the attempt", () => {
    const { db } = freshDb();
    const queue = createJobQueue(db);
    const enqueued = queue.enqueue("ingest", seedProject(db));

    const claimed = queue.claimNext();

    expect(claimed?.id).toBe(enqueued.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect(queue.get(enqueued.id)?.status).toBe("running");
  });

  it("returns null when the queue is empty", () => {
    const { db } = freshDb();
    expect(createJobQueue(db).claimNext()).toBeNull();
  });

  it("does not re-claim a running job", () => {
    const { db } = freshDb();
    const queue = createJobQueue(db);
    queue.enqueue("ingest", seedProject(db));

    expect(queue.claimNext()).not.toBeNull();
    expect(queue.claimNext()).toBeNull();
  });

  it("claims jobs oldest-first", () => {
    const { db } = freshDb();
    const queue = createJobQueue(db);
    const projectId = seedProject(db);
    const first = queue.enqueue("ingest", projectId);
    const second = queue.enqueue("ingest", projectId);

    expect(queue.claimNext()?.id).toBe(first.id);
    expect(queue.claimNext()?.id).toBe(second.id);
  });

  it("claims a job exactly once when two callers on separate connections claim", () => {
    // NOTE: this cannot detect a non-atomic claim — better-sqlite3 is
    // synchronous, so these two callers never interleave and a read-then-write
    // claim passes here too (verified by mutation testing). Real atomicity is
    // covered by tests/jobs-concurrency.test.ts; this only pins the
    // single-caller-wins behaviour.
    const handle = freshDb();
    const workerA = createJobQueue(handle.db);
    const enqueued = workerA.enqueue("ingest", seedProject(handle.db));

    const second = openTestDb(handle.file);
    open.push(second);
    const workerB = createJobQueue(second.db);

    const claims = [workerA.claimNext(), workerB.claimNext()].filter((j) => j !== null);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.id).toBe(enqueued.id);
    expect(workerA.get(enqueued.id)?.attempts).toBe(1);
  });
});

describe("progress and completion", () => {
  it("records progress and clamps it to 0–100", () => {
    const { db } = freshDb();
    const queue = createJobQueue(db);
    const job = queue.enqueue("ingest", seedProject(db));

    queue.updateProgress(job.id, 42);
    expect(queue.get(job.id)?.progress).toBe(42);

    queue.updateProgress(job.id, 150);
    expect(queue.get(job.id)?.progress).toBe(100);

    queue.updateProgress(job.id, -20);
    expect(queue.get(job.id)?.progress).toBe(0);
  });

  it("marks a job done at full progress", () => {
    const { db } = freshDb();
    const queue = createJobQueue(db);
    const job = queue.enqueue("ingest", seedProject(db));
    queue.claimNext();

    queue.complete(job.id);

    const done = queue.get(job.id);
    expect(done?.status).toBe("done");
    expect(done?.progress).toBe(100);
    expect(done?.error).toBeNull();
  });
});

describe("fail and retry", () => {
  it("requeues a failed job with backoff and keeps the error", () => {
    const { db } = freshDb();
    const time = clock();
    const queue = createJobQueue(db, { now: time.now, backoffMs: () => 5_000 });
    const job = queue.enqueue("ingest", seedProject(db));
    queue.claimNext();

    const failed = queue.fail(job.id, new Error("ffprobe exploded"));

    expect(failed?.status).toBe("queued");
    expect(failed?.error).toBe("ffprobe exploded");
    expect(failed?.runAt).toBe(time.now() + 5_000);
  });

  it("will not re-claim a backed-off job until its backoff elapses", () => {
    const { db } = freshDb();
    const time = clock();
    const queue = createJobQueue(db, { now: time.now, backoffMs: () => 5_000 });
    const job = queue.enqueue("ingest", seedProject(db));
    queue.claimNext();
    queue.fail(job.id, new Error("boom"));

    expect(queue.claimNext()).toBeNull(); // still inside the backoff window

    time.advance(5_000);
    const retried = queue.claimNext();
    expect(retried?.id).toBe(job.id);
    expect(retried?.attempts).toBe(2);
  });

  it("ends done with attempts=3 when a handler throws twice then succeeds", () => {
    const { db } = freshDb();
    const time = clock();
    const queue = createJobQueue(db, { now: time.now, backoffMs: () => 1_000 });
    const job = queue.enqueue("ingest", seedProject(db));

    // Attempt 1 and 2 throw; attempt 3 succeeds.
    for (const shouldThrow of [true, true, false]) {
      const claimed = queue.claimNext();
      expect(claimed?.id).toBe(job.id);
      if (shouldThrow) {
        queue.fail(job.id, new Error("transient"));
        time.advance(1_000);
      } else {
        queue.complete(job.id);
      }
    }

    const final = queue.get(job.id);
    expect(final?.status).toBe("done");
    expect(final?.attempts).toBe(3);
    expect(final?.error).toBeNull();
  });

  it("gives up after 2 retries and marks the job failed", () => {
    const { db } = freshDb();
    const time = clock();
    const queue = createJobQueue(db, { now: time.now, backoffMs: () => 1_000 });
    const job = queue.enqueue("ingest", seedProject(db));

    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(queue.claimNext()?.attempts).toBe(attempt);
      queue.fail(job.id, new Error(`attempt ${attempt} failed`));
      time.advance(1_000);
    }

    const final = queue.get(job.id);
    expect(final?.status).toBe("failed");
    expect(final?.attempts).toBe(3);
    expect(final?.error).toBe("attempt 3 failed");
    expect(queue.claimNext()).toBeNull(); // exhausted jobs are never retried
  });

  it("stringifies a non-Error failure reason", () => {
    const { db } = freshDb();
    const queue = createJobQueue(db);
    const job = queue.enqueue("ingest", seedProject(db));
    queue.claimNext();

    expect(queue.fail(job.id, "just a string")?.error).toBe("just a string");
  });

  it("returns null when failing a job that does not exist", () => {
    const { db } = freshDb();
    expect(createJobQueue(db).fail(9999, new Error("nope"))).toBeNull();
  });
});

describe("defaultBackoffMs", () => {
  it("backs off exponentially and caps at 30s", () => {
    expect(defaultBackoffMs(1)).toBe(1_000);
    expect(defaultBackoffMs(2)).toBe(2_000);
    expect(defaultBackoffMs(3)).toBe(4_000);
    expect(defaultBackoffMs(99)).toBe(30_000);
  });
});
