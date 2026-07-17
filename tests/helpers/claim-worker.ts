/**
 * Runs in a worker thread for the concurrent-claim test: opens its own
 * connection (as a real worker process would) and drains the queue, reporting
 * every job id it managed to claim.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";

import * as schema from "../../src/lib/db/schema";
import { createJobQueue } from "../../src/lib/jobs";

/** Shared barrier slots, mirrored in jobs-concurrency.test.ts. */
const READY = 0;
const GO = 1;
const FIRST_CLAIMED = 2;

interface ClaimWorkerData {
  file: string;
  workers: number;
  /** Barrier: [READY] booted, [GO] released, [FIRST_CLAIMED] took first job. */
  control: Int32Array;
}

const { file, workers, control } = workerData as ClaimWorkerData;

/** Block until `slot` reaches `target`, without spinning a core. */
function awaitCount(slot: number, target: number): void {
  for (;;) {
    const seen = Atomics.load(control, slot);
    if (seen >= target) return;
    Atomics.wait(control, slot, seen, 1000);
  }
}

const sqlite = new Database(file);
sqlite.pragma("busy_timeout = 10000");
sqlite.pragma("foreign_keys = ON");
const queue = createJobQueue(drizzle(sqlite, { schema }));

// Announce readiness only once the expensive part (module load + opening the
// database) is done, then block until every worker is equally ready. A
// wall-clock start time would instead let a slow-booting worker arrive after the
// others had drained the queue, leaving nothing to contend over.
Atomics.add(control, READY, 1);
Atomics.notify(control, READY);
awaitCount(GO, 1);

const claimed: number[] = [];

// Round one: every worker goes for its first job at the same instant. This is
// the moment a non-atomic claim double-claims, and doing it before any draining
// makes the contention structural rather than a matter of scheduling luck — one
// worker can no longer drain the queue while the others are descheduled.
const first = queue.claimNext();
if (first) claimed.push(first.id);
Atomics.add(control, FIRST_CLAIMED, 1);
Atomics.notify(control, FIRST_CLAIMED);
awaitCount(FIRST_CLAIMED, workers);

// Then race freely for whatever is left.
for (;;) {
  const job = queue.claimNext();
  if (!job) break;
  claimed.push(job.id);
}

sqlite.close();
parentPort?.postMessage(claimed);
