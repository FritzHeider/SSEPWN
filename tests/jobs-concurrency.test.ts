import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { createJobQueue } from "../src/lib/jobs";
import { createTestDb, seedProject, type TestDb } from "./helpers/db";

const WORKER_PATH = fileURLToPath(new URL("./helpers/claim-worker.ts", import.meta.url));
const WORKERS = 4;
const JOB_COUNT = 300;

let handle: TestDb | undefined;

afterEach(() => {
  handle?.close();
  handle = undefined;
});

function runClaimWorker(file: string, startAt: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { file, startAt },
      // The worker imports the TypeScript job queue directly.
      execArgv: ["--import", "tsx"],
    });
    let claimed: number[] = [];
    worker.on("message", (ids: number[]) => {
      claimed = ids;
    });
    worker.on("error", reject);
    worker.on("exit", (code) =>
      code === 0 ? resolve(claimed) : reject(new Error(`claim worker exited with ${code}`)),
    );
  });
}

/**
 * The in-process "two callers" test cannot fail: better-sqlite3 is synchronous,
 * so a read-then-write claim would pass it while still double-claiming between
 * real workers. This spins genuinely parallel workers against one database file
 * to test the property the phase actually requires.
 */
it(
  "claims every job exactly once when real parallel workers contend",
  { timeout: 60_000 },
  async () => {
    handle = createTestDb();
    const queue = createJobQueue(handle.db);
    const projectId = seedProject(handle.db);
    const enqueuedIds = Array.from(
      { length: JOB_COUNT },
      (_, i) => queue.enqueue("ingest", projectId, { i }).id,
    );

    // Give every worker time to boot, then release them all at once.
    const startAt = Date.now() + 2_000;
    const results = await Promise.all(
      Array.from({ length: WORKERS }, () => runClaimWorker(handle!.file, startAt)),
    );

    const allClaims = results.flat();
    const unique = new Set(allClaims);

    // The invariant: no id claimed twice, and nothing left behind.
    expect(allClaims.length - unique.size).toBe(0); // zero double-claims
    expect(unique.size).toBe(JOB_COUNT);
    expect([...unique].sort((a, b) => a - b)).toEqual(enqueuedIds);

    // Every job ran exactly one attempt — a double-claim would show up here too.
    const attempts = enqueuedIds.map((id) => queue.get(id)?.attempts);
    expect(attempts.every((a) => a === 1)).toBe(true);

    // Contention actually happened: no single worker drained the whole queue.
    expect(results.filter((r) => r.length > 0).length).toBeGreaterThan(1);
  },
);
