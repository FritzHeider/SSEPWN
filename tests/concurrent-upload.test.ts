import { eq } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clips, projects } from "../src/lib/db/schema";
import { createJobQueue } from "../src/lib/jobs";
import { createClipThumbnailHandler } from "../src/worker/handlers/clip-thumbnail";
import { createGenerateClipsHandler } from "../src/worker/handlers/generate-clips";
import { createIngestHandler } from "../src/worker/handlers/ingest";
import { createTranscribeHandler } from "../src/worker/handlers/transcribe";
import { createWorker } from "../src/worker/loop";
import { createTestDb, openTestDb, type TestDb } from "./helpers/db";

/**
 * Hardening (phase-11): three uploads arriving at once must each run their own
 * ingest → transcribe → generate-clips chain to completion, with nothing
 * double-claimed, stalled, or left `failed`. Two worker loops drain the same
 * database file in parallel so the test exercises real contention rather than a
 * single serial drain.
 *
 * The three fixtures are deliberately heterogeneous: a long file with audio (real
 * highlight clips), a short file with audio (whole-video clip, < min length), and
 * a no-audio file (transcription skipped, clips cut by scene/energy only). All
 * three land in `ready` with at least one clip — "processes all successfully".
 */

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const UPLOADS = [
  { name: "long-sample.mp4", transcribed: true },
  { name: "short-sample.mp4", transcribed: true },
  { name: "no-audio.mp4", transcribed: false },
] as const;

const POLL_MS = 5;
const silentLogger = { log: () => {}, error: () => {} };

type PostHandler = (request: Request) => Promise<Response>;

let POST: PostHandler;
let testDb: TestDb;
let routeDb: TestDb;
let uploadsDir: string;
let thumbDir: string;

function uploadRequest(name: string): Request {
  const contents = readFileSync(path.join(FIXTURES, name));
  const bytes = new Uint8Array(new ArrayBuffer(contents.byteLength));
  bytes.set(contents);
  const form = new FormData();
  form.append("file", new File([bytes], name, { type: "video/mp4" }));
  return new Request("http://localhost/api/projects", { method: "POST", body: form });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

beforeAll(async () => {
  testDb = createTestDb();
  uploadsDir = mkdtempSync(path.join(tmpdir(), "sseclone-concurrent-uploads-"));
  thumbDir = mkdtempSync(path.join(tmpdir(), "sseclone-concurrent-thumbs-"));
  process.env.SSECLONE_DB_PATH = testDb.file;
  process.env.SSECLONE_UPLOAD_DIR = uploadsDir;
  ({ POST } = (await import("../src/app/api/projects/route")) as { POST: PostHandler });
  routeDb = openTestDb(testDb.file);
});

afterAll(() => {
  routeDb.close();
  testDb.close();
  rmSync(uploadsDir, { recursive: true, force: true });
  rmSync(thumbDir, { recursive: true, force: true });
});

/** A worker wired with the real pipeline handlers, draining `routeDb`. */
function pipelineWorker() {
  const queue = createJobQueue(routeDb.db, { backoffMs: () => 0 });
  return createWorker({
    queue,
    db: routeDb.db,
    handlers: {
      ingest: createIngestHandler({ dir: () => thumbDir, generateWaveformFn: async () => "" }),
      transcribe: createTranscribeHandler(),
      "generate-clips": createGenerateClipsHandler(),
      // generate-clips now queues a poster job per clip; stub the ffmpeg
      // extraction so the drain completes without real thumbnail work.
      "clip-thumbnail": createClipThumbnailHandler({ generateThumbnailFn: async (_s, d) => d }),
    },
    pollMs: POLL_MS,
    logger: silentLogger,
  });
}

describe("concurrent upload of 3 fixtures", () => {
  it(
    "processes every upload through the full pipeline with two contending workers",
    { timeout: 120_000 },
    async () => {
      // Fire all three uploads at once — the route must survive concurrent writes.
      const responses = await Promise.all(UPLOADS.map((u) => POST(uploadRequest(u.name))));
      for (const response of responses) expect(response.status).toBe(201);

      const created = await Promise.all(
        responses.map(async (r) => (await r.json()) as { project: { id: number } }),
      );
      const ids = created.map((c) => c.project.id);
      // Three distinct projects, not one row clobbered by a racing insert.
      expect(new Set(ids).size).toBe(3);

      // Two workers drain the same file concurrently.
      const workers = [pipelineWorker(), pipelineWorker()];
      workers.forEach((w) => void w.start());

      try {
        const drainQueue = createJobQueue(routeDb.db);
        await waitFor(() => {
          // Done only when every chain has fully drained: each project must own a
          // completed generate-clips job (the last link) and hold no work still
          // queued or running. Project status flips to `ready` back at ingest, so
          // status alone would race ahead of the clips this test asserts on.
          return ids.every((id) => {
            const jobs = drainQueue.listByProject(id);
            const pending = jobs.some((j) => j.status === "queued" || j.status === "running");
            const clipsDone = jobs.some(
              (j) => j.type === "generate-clips" && (j.status === "done" || j.status === "failed"),
            );
            return !pending && clipsDone;
          });
        }, "all three pipelines to drain");
      } finally {
        await Promise.all(workers.map((w) => w.stop()));
      }

      // No upload was left failed, and each has at least one clip.
      for (const upload of UPLOADS) {
        const id = ids[UPLOADS.indexOf(upload)];
        const [project] = routeDb.db.select().from(projects).where(eq(projects.id, id)).all();
        expect(project.status, `${upload.name} status`).toBe("ready");
        expect(project.transcribed, `${upload.name} transcribed`).toBe(upload.transcribed);

        const clipRows = routeDb.db.select().from(clips).where(eq(clips.projectId, id)).all();
        expect(clipRows.length, `${upload.name} clip count`).toBeGreaterThan(0);
      }

      // Nothing left double-claimed or wedged: the queue holds no failed jobs.
      const queue = createJobQueue(routeDb.db);
      for (const id of ids) {
        const failed = queue.listByProject(id).filter((job) => job.status === "failed");
        expect(failed, `failed jobs for project ${id}`).toHaveLength(0);
      }
    },
  );
});
