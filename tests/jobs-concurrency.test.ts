import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { createJobQueue } from "../src/lib/jobs";
import { createTestDb, seedProject, type TestDb } from "./helpers/db";

const WORKER_PATH = fileURLToPath(new URL("./helpers/claim-worker.ts", import.meta.url));
const WORKERS = 4;
const JOB_COUNT = 300;

/**
 * Shared barrier slots, mirrored in helpers/claim-worker.ts. Slot 2
 * (FIRST_CLAIMED) is used only between the workers themselves.
 */
const READY = 0;
const GO = 1;
const SLOTS = 3;

let handle: TestDb | undefined;

afterEach(() => {
  handle?.close();
  handle = undefined;
});

function runClaimWorker(file: string, control: Int32Array): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { file, control, workers: WORKERS },
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

    // Release every worker at the same instant, but only once all of them have
    // actually booted — see helpers/claim-worker.ts.
    const control = new Int32Array(new SharedArrayBuffer(SLOTS * Int32Array.BYTES_PER_ELEMENT));
    const pending = Array.from({ length: WORKERS }, () => runClaimWorker(handle!.file, control));

    while (Atomics.load(control, READY) < WORKERS) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    Atomics.store(control, GO, 1);
    Atomics.notify(control, GO);

    const results = await Promise.all(pending);

    const allClaims = results.flat();
    const unique = new Set(allClaims);

    // The invariant: no id claimed twice, and nothing left behind.
    expect(allClaims.length - unique.size).toBe(0); // zero double-claims
    expect(unique.size).toBe(JOB_COUNT);
    expect([...unique].sort((a, b) => a - b)).toEqual(enqueuedIds);

    // Every job ran exactly one attempt — a double-claim would show up here too.
    const attempts = enqueuedIds.map((id) => queue.get(id)?.attempts);
    expect(attempts.every((a) => a === 1)).toBe(true);

    // Contention actually happened, so the invariants above were really tested:
    // every worker raced for its first job at the same instant and won one, which
    // the barrier in claim-worker.ts makes structural rather than a matter of
    // scheduling luck (a descheduled worker used to claim nothing at all).
    expect(results.filter((r) => r.length > 0).length).toBe(WORKERS);
  },
);
