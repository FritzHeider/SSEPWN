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

interface ClaimWorkerData {
  file: string;
  /** Epoch ms barrier — all workers spin until this instant, then contend. */
  startAt: number;
}

const { file, startAt } = workerData as ClaimWorkerData;

const sqlite = new Database(file);
sqlite.pragma("busy_timeout = 10000");
sqlite.pragma("foreign_keys = ON");
const queue = createJobQueue(drizzle(sqlite, { schema }));

while (Date.now() < startAt) {
  // Spin (not sleep) so every worker leaves the barrier at the same instant.
}

const claimed: number[] = [];
for (;;) {
  const job = queue.claimNext();
  if (!job) break;
  claimed.push(job.id);
}

sqlite.close();
parentPort?.postMessage(claimed);
