/**
 * Sseclone worker process (`npm run worker`) — the only place long-running
 * media work happens; API handlers just enqueue jobs and read status.
 */
import { db } from "../lib/db";
import { writeHeartbeat } from "../lib/health";
import { createJobQueue } from "../lib/jobs";
import { handlers } from "./handlers";
import { createWorker } from "./loop";

/**
 * How often the liveness heartbeat is refreshed. Well under the 10s staleness
 * threshold `/api/health` uses, so a healthy worker never trips it — including
 * WHILE a long job runs, which is the case the poll-loop beat alone misses (the
 * loop parks on `await processOne` for the whole job). A decoupled timer fires
 * during that await because handlers await subprocesses, leaving the event loop
 * free.
 */
const HEARTBEAT_INTERVAL_MS = 3000;

async function main(): Promise<void> {
  const beat = (): void => {
    try {
      writeHeartbeat();
    } catch {
      // A transient fs error just means one missed beat; the next tick retries.
    }
  };

  const worker = createWorker({
    queue: createJobQueue(db),
    db,
    handlers,
    // Immediate beat on each poll iteration, so an idle worker stays fresh and the
    // very first tick writes a heartbeat before the interval below has fired.
    heartbeat: beat,
  });

  // The interval is what keeps health honest during a long job: the poll loop is
  // blocked on the running handler, but this timer still fires.
  beat();
  const heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeatTimer);
    console.log(`[worker] ${signal} received — finishing current job, then exiting`);
    void worker.stop();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await worker.start();
  clearInterval(heartbeatTimer);
}

main().catch((error: unknown) => {
  console.error("[worker] fatal:", error);
  process.exitCode = 1;
});
