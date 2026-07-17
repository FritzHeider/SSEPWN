/**
 * Sseclone worker process (`npm run worker`) — the only place long-running
 * media work happens; API handlers just enqueue jobs and read status.
 */
import { db } from "../lib/db";
import { createJobQueue } from "../lib/jobs";
import { handlers } from "./handlers";
import { createWorker } from "./loop";

async function main(): Promise<void> {
  const worker = createWorker({ queue: createJobQueue(db), db, handlers });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received — finishing current job, then exiting`);
    void worker.stop();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await worker.start();
}

main().catch((error: unknown) => {
  console.error("[worker] fatal:", error);
  process.exitCode = 1;
});
