import { eq } from "drizzle-orm";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projects } from "../src/lib/db/schema";
import { probe } from "../src/lib/ffmpeg/exec";
import { posterTimestamp } from "../src/lib/ffmpeg/thumbnail";
import { createJobQueue, type JobQueue } from "../src/lib/jobs";
import { createIngestHandler, THUMBNAIL_WIDTH } from "../src/worker/handlers/ingest";
import { createWorker } from "../src/worker/loop";
import { createTestDb, type TestDb } from "./helpers/db";

const SHORT_SAMPLE = "fixtures/short-sample.mp4";
const NO_AUDIO = "fixtures/no-audio.mp4";
const NOT_A_VIDEO = "fixtures/not-a-video.txt";

const POLL_MS = 5;
const silentLogger = { log: () => {}, error: () => {} };

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

describe("ingest handler", () => {
  let testDb: TestDb;
  let queue: JobQueue;
  let thumbDir: string;

  beforeEach(() => {
    testDb = createTestDb();
    queue = createJobQueue(testDb.db, { backoffMs: () => 0 });
    thumbDir = mkdtempSync(path.join(tmpdir(), "sseclone-thumbs-"));
  });

  afterEach(() => {
    testDb.close();
    rmSync(thumbDir, { recursive: true, force: true });
  });

  /** A project registered exactly as the upload API leaves it: `uploaded`, no metadata. */
  function seedUploadedProject(sourceVideoPath: string | null, name = "clip.mp4"): number {
    const [row] = testDb.db
      .insert(projects)
      .values({ name, sourceVideoPath, status: "uploaded" })
      .returning({ id: projects.id })
      .all();
    return row.id;
  }

  function getProject(id: number) {
    const [row] = testDb.db.select().from(projects).where(eq(projects.id, id)).all();
    return row;
  }

  /** Runs the real worker loop against the real handler until the job settles. */
  async function runIngest(projectId: number) {
    const worker = createWorker({
      queue,
      db: testDb.db,
      handlers: { ingest: createIngestHandler({ dir: () => thumbDir, generateWaveformFn: async () => "" }) },
      pollMs: POLL_MS,
      logger: silentLogger,
    });
    void worker.start();
    const job = queue.enqueue("ingest", projectId, { path: getProject(projectId)?.sourceVideoPath });
    await waitFor(() => {
      const status = queue.get(job.id)?.status;
      return status === "done" || status === "failed";
    }, "ingest job to settle");
    await worker.stop();
    return queue.get(job.id);
  }

  // Phase-02 acceptance: worker processes an ingest job end-to-end — project
  // becomes `ready` with duration/resolution set and a thumbnail file existing.
  it("ingests short-sample.mp4 end-to-end: project ready with metadata and a poster", async () => {
    const projectId = seedUploadedProject(SHORT_SAMPLE);

    const job = await runIngest(projectId);

    expect(job?.status).toBe("done");
    const project = getProject(projectId);
    expect(project.status).toBe("ready");
    expect(project.error).toBeNull();
    expect(project.duration).toBeGreaterThan(4.5);
    expect(project.duration).toBeLessThan(5.5);
    expect(project.width).toBe(1280);
    expect(project.height).toBe(720);
    expect(project.fps).toBeGreaterThan(0);
    expect(project.hasAudio).toBe(true);
    expect(project.thumbnailPath).toBe(path.join(thumbDir, `project-${projectId}.jpg`));
    expect(existsSync(project.thumbnailPath!)).toBe(true);
  });

  // "A thumbnail file exists" is satisfied by a zero-byte file, so assert the
  // poster is a real decodable image at the requested width — the property the
  // criterion is actually reaching for.
  it("writes a poster that is a real, decodable image at the requested width", async () => {
    const projectId = seedUploadedProject(SHORT_SAMPLE);

    await runIngest(projectId);

    const thumbnailPath = getProject(projectId).thumbnailPath!;
    expect(statSync(thumbnailPath).size).toBeGreaterThan(0);
    const image = await probe(thumbnailPath);
    expect(image.width).toBe(THUMBNAIL_WIDTH);
    // 1280x720 scaled to 640 wide keeps 16:9.
    expect(image.height).toBe(360);
  });

  // Phase-02 acceptance: no-audio.mp4 ingests successfully with hasAudio=false.
  it("ingests no-audio.mp4 successfully with hasAudio=false", async () => {
    const projectId = seedUploadedProject(NO_AUDIO, "no-audio.mp4");

    const job = await runIngest(projectId);

    expect(job?.status).toBe("done");
    const project = getProject(projectId);
    expect(project.status).toBe("ready");
    expect(project.hasAudio).toBe(false);
    expect(project.width).toBe(1280);
    expect(existsSync(project.thumbnailPath!)).toBe(true);
  });

  it("marks a project failed with a human-readable error for a non-video file", async () => {
    const projectId = seedUploadedProject(NOT_A_VIDEO, "not-a-video.txt");

    const job = await runIngest(projectId);

    expect(job?.status).toBe("failed");
    const project = getProject(projectId);
    expect(project.status).toBe("failed");
    // Names the file and says what to do — not raw ffprobe stderr.
    expect(project.error).toContain("not-a-video.txt");
    expect(project.error).toMatch(/not a readable video file|no video stream/i);
    expect(project.duration).toBeNull();
    expect(project.thumbnailPath).toBeNull();
  });

  it("marks a project failed when its source file is missing from disk", async () => {
    const projectId = seedUploadedProject("fixtures/does-not-exist.mp4", "gone.mp4");

    const job = await runIngest(projectId);

    expect(job?.status).toBe("failed");
    expect(getProject(projectId).status).toBe("failed");
    expect(getProject(projectId).error).toContain("gone.mp4");
    // A missing file also fails via an ffprobe command, so it must not be
    // misreported as a corrupt one.
    expect(getProject(projectId).error).toMatch(/could not be found/i);
  });

  // Uploads are stored under a random UUID, so a message naming the file on disk
  // tells the user nothing about which upload broke. Real uploads always look
  // like this; seeding a project straight at a fixture path (as the tests above
  // do) hides the problem entirely.
  it("names the uploaded file, not its UUID storage path, in the failure message", async () => {
    const stored = path.join(thumbDir, "550e8400-e29b-41d4-a716-446655440000.mp4");
    const projectId = seedUploadedProject(stored, "My Podcast Episode.mp4");

    await runIngest(projectId);

    const error = getProject(projectId).error!;
    expect(error).toContain("My Podcast Episode.mp4");
    expect(error).not.toContain("550e8400");
  });

  it("fails a project that has no source video path at all", async () => {
    const projectId = seedUploadedProject(null);

    const job = await runIngest(projectId);

    expect(job?.status).toBe("failed");
    const project = getProject(projectId);
    expect(project.status).toBe("failed");
    expect(project.error).toContain("no source video path");
  });

  // A transient failure must not strand the project in `failed`: the queue
  // retries, and a winning attempt has to clear the error it left behind.
  it("clears a previous failure when a retried attempt succeeds", async () => {
    const projectId = seedUploadedProject(SHORT_SAMPLE);
    let calls = 0;
    const flaky = createIngestHandler({
      dir: () => thumbDir,
      generateWaveformFn: async () => "",
      probeFn: async (p) => {
        calls += 1;
        if (calls === 1) throw new Error("transient ffprobe glitch");
        return probe(p);
      },
    });
    const worker = createWorker({
      queue,
      db: testDb.db,
      handlers: { ingest: flaky },
      pollMs: POLL_MS,
      logger: silentLogger,
    });
    void worker.start();
    const job = queue.enqueue("ingest", projectId);

    await waitFor(() => queue.get(job.id)?.status === "done", "ingest to succeed on retry");
    await worker.stop();

    expect(calls).toBe(2);
    const project = getProject(projectId);
    expect(project.status).toBe("ready");
    expect(project.error).toBeNull();
    expect(project.duration).toBeGreaterThan(0);
  });

  it("reports progress as it works", async () => {
    const projectId = seedUploadedProject(SHORT_SAMPLE);
    const seen: number[] = [];
    const handler = createIngestHandler({ dir: () => thumbDir, generateWaveformFn: async () => "" });
    await handler({
      job: queue.enqueue("ingest", projectId),
      db: testDb.db,
      setProgress: (progress) => seen.push(progress),
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(Math.max(...seen)).toBeLessThanOrEqual(100);
  });
});

// Every test above injects its own handler, so none of them touch the registry
// the worker actually dispatches from. Unregistering `ingest` keeps all of them
// green while every real upload dies with "No handler registered for job type
// ingest" — so pin the wiring itself.
describe("handler registry", () => {
  it("registers the ingest handler under the type the upload API enqueues", async () => {
    const { handlers } = await import("../src/worker/handlers");
    expect(Object.keys(handlers)).toContain("ingest");
    expect(typeof handlers.ingest).toBe("function");
  });
});

describe("posterTimestamp", () => {
  // Seeking 1s into a 0.5s clip yields no frame at all, so short sources must
  // fall back to their midpoint rather than producing an empty poster.
  it("takes the midpoint of a very short source", () => {
    expect(posterTimestamp(0.5)).toBe(0.25);
    expect(posterTimestamp(2)).toBe(1);
  });

  it("takes one second into a normal source", () => {
    expect(posterTimestamp(5)).toBe(1);
    expect(posterTimestamp(5400)).toBe(1);
  });

  it("is zero for an unknown or nonsense duration", () => {
    expect(posterTimestamp(0)).toBe(0);
    expect(posterTimestamp(Number.NaN)).toBe(0);
    expect(posterTimestamp(-3)).toBe(0);
  });
});
