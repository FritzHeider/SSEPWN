import type { Job, JobQueue, JobsDb } from "../lib/jobs";
import type { HandlerRegistry } from "./handlers";

export interface WorkerLogger {
  log(message: string): void;
  error(message: string): void;
}

export interface WorkerOptions {
  queue: JobQueue;
  db: JobsDb;
  handlers: HandlerRegistry;
  /** Idle poll interval; SPEC/phase-02 requires 500 ms in production. */
  pollMs?: number;
  /**
   * A `running` job untouched for longer than this on startup is assumed to be
   * from a crashed worker and recovered. Defaults to the queue's own default.
   */
  staleJobMs?: number;
  /**
   * Called once at the top of every poll iteration (phase-BE task 1): the worker
   * uses it to refresh its heartbeat file so `/api/health` can tell it is alive.
   * Injected rather than done here so the loop stays free of fs concerns and
   * tests need not touch disk. Its failures are swallowed by the caller.
   */
  heartbeat?: () => void;
  logger?: WorkerLogger;
}

export interface Worker {
  /** Resolves when the loop has stopped. Calling twice returns the same run. */
  start(): Promise<void>;
  /** Requests shutdown and resolves once the in-flight job has finished. */
  stop(): Promise<void>;
}

interface Sleeper {
  sleep(ms: number): Promise<void>;
  wake(): void;
}

/** A sleep that shutdown can cut short, so SIGINT doesn't wait out a poll. */
function createSleeper(): Sleeper {
  let wake: (() => void) | null = null;
  return {
    sleep(ms) {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, ms);
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
      });
    },
    wake() {
      wake?.();
    },
  };
}

/**
 * Polls the job queue and dispatches each claimed job to its handler.
 *
 * Claiming one job at a time is what makes running several workers safe: the
 * queue's claim is a single atomic UPDATE, so no two workers get the same job.
 */
export function createWorker(options: WorkerOptions): Worker {
  const { queue, db, handlers, pollMs = 500, staleJobMs, heartbeat } = options;
  const logger: WorkerLogger = options.logger ?? {
    log: (message) => console.log(message),
    error: (message) => console.error(message),
  };

  const sleeper = createSleeper();
  let stopping = false;
  let running: Promise<void> | null = null;

  async function processOne(job: Job): Promise<void> {
    const handler = handlers[job.type];
    if (!handler) {
      const error = new Error(`No handler registered for job type "${job.type}"`);
      queue.fail(job.id, error);
      logger.error(`[worker] job ${job.id}: ${error.message}`);
      return;
    }

    try {
      await handler({ job, db, setProgress: (progress) => queue.updateProgress(job.id, progress) });
      queue.complete(job.id);
      logger.log(`[worker] job ${job.id} (${job.type}) done`);
    } catch (error) {
      const after = queue.fail(job.id, error);
      const reason = error instanceof Error ? error.message : String(error);
      const outcome =
        after?.status === "failed"
          ? `failed permanently after ${after.attempts} attempts`
          : "will retry";
      logger.error(`[worker] job ${job.id} (${job.type}) ${outcome}: ${reason}`);
    }
  }

  async function loop(): Promise<void> {
    // Before polling, reclaim anything a previous worker left `running` when it
    // crashed — otherwise those jobs are lost and the pipeline stalls.
    const recovered = queue.recoverStale(staleJobMs);
    if (recovered.requeued > 0 || recovered.failed > 0) {
      logger.log(
        `[worker] recovered ${recovered.requeued} stale job(s); failed ${recovered.failed} past their attempt budget`,
      );
    }
    logger.log(`[worker] polling every ${pollMs}ms`);
    while (!stopping) {
      // Refresh the liveness heartbeat every iteration, before doing any work.
      heartbeat?.();
      const job = queue.claimNext();
      if (!job) {
        await sleeper.sleep(pollMs);
        continue;
      }
      // Deliberately not guarded by `stopping`: a claimed job is always run to
      // completion, which is what makes shutdown graceful rather than abandoning
      // a running job as `running` forever.
      await processOne(job);
    }
    logger.log("[worker] stopped");
  }

  return {
    start() {
      running ??= loop();
      return running;
    },
    async stop() {
      stopping = true;
      sleeper.wake();
      await running;
    },
  };
}
