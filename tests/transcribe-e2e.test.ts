import { eq } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { jobs, projects, transcripts } from "../src/lib/db/schema";
import type { Job } from "../src/lib/jobs";
import { createJobQueue } from "../src/lib/jobs";
import type { TranscriptSegment } from "../src/lib/transcribe/types";
import { createGenerateClipsHandler } from "../src/worker/handlers/generate-clips";
import { createIngestHandler } from "../src/worker/handlers/ingest";
import { createTranscribeHandler } from "../src/worker/handlers/transcribe";
import { createTestDb, openTestDb, type TestDb } from "./helpers/db";

/**
 * The pipeline as it actually runs, from an HTTP upload to transcript rows.
 *
 * Every other transcribe test seeds `sourceVideoPath: "fixtures/long-sample.mp4"`
 * directly — and that is exactly how a real bug hid behind 14 green tests: the
 * upload route stores the file as `data/uploads/<uuid>.mp4`, so a FakeTranscriber
 * keyed off the path's basename could never resolve a fixture outside the tests.
 * This test earns its slowness by traversing the rename that those tests skip.
 */

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const UUID_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$/;

type PostHandler = (request: Request) => Promise<Response>;

let POST: PostHandler;
let testDb: TestDb;
let routeDb: TestDb;
let uploadsDir: string;
let thumbDir: string;

function uploadRequest(name: string, fields: Record<string, string> = {}): Request {
  const contents = readFileSync(path.join(FIXTURES, name));
  const bytes = new Uint8Array(new ArrayBuffer(contents.byteLength));
  bytes.set(contents);

  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("file", new File([bytes], name, { type: "video/mp4" }));
  return new Request("http://localhost/api/projects", { method: "POST", body: form });
}

beforeAll(async () => {
  testDb = createTestDb();
  uploadsDir = mkdtempSync(path.join(tmpdir(), "sseclone-e2e-uploads-"));
  thumbDir = mkdtempSync(path.join(tmpdir(), "sseclone-e2e-thumbs-"));
  process.env.SSECLONE_DB_PATH = testDb.file;
  process.env.SSECLONE_UPLOAD_DIR = uploadsDir;
  ({ POST } = (await import("../src/app/api/projects/route")) as { POST: PostHandler });
  // The route holds its own connection to the same file; read through a second
  // one so the assertions see committed rows rather than the route's handle.
  routeDb = openTestDb(testDb.file);
});

afterAll(() => {
  routeDb.close();
  testDb.close();
  rmSync(uploadsDir, { recursive: true, force: true });
  rmSync(thumbDir, { recursive: true, force: true });
});

/** Drain the queue exactly as the worker does, with the REAL handler defaults. */
async function runQueuedJobs(): Promise<void> {
  const queue = createJobQueue(routeDb.db, { backoffMs: () => 0 });
  // No injected transcriber: the point is that the TRANSCRIBER default path —
  // fake under NODE_ENV=test, via createTranscriber() — works end to end. An
  // injected fake here would test the wiring of the test, not of the product.
  const registry: Record<string, (ctx: { job: Job; db: typeof routeDb.db; setProgress: (n: number) => void }) => Promise<void>> = {
    ingest: createIngestHandler({ dir: () => thumbDir }),
    transcribe: createTranscribeHandler(),
    // Phase-04 extends the pipeline: transcribe hands off to generate-clips.
    // Drained with the real ffmpeg extractors so the full chain is exercised.
    "generate-clips": createGenerateClipsHandler(),
  };

  for (let job = queue.claimNext(); job; job = queue.claimNext()) {
    const claimed = job;
    try {
      await registry[claimed.type]({
        job: claimed,
        db: routeDb.db,
        setProgress: (progress) => queue.updateProgress(claimed.id, progress),
      });
      queue.complete(claimed.id);
    } catch (error) {
      queue.fail(claimed.id, (error as Error).message);
      throw error;
    }
  }
}

function projectRow(id: number) {
  const [row] = routeDb.db.select().from(projects).where(eq(projects.id, id)).all();
  return row;
}

describe("upload → ingest → transcribe (TRANSCRIBER default, real upload rename)", () => {
  it("writes transcript rows for a file uploaded under its own name", async () => {
    const response = await POST(uploadRequest("long-sample.mp4"));
    expect(response.status).toBe(201);
    const { project } = (await response.json()) as { project: { id: number; sourceVideoPath: string } };

    // The premise of the whole test: the stored file is a UUID, so nothing about
    // the media's identity survives in its path. If this ever stops being true,
    // the test below would pass for the wrong reason.
    expect(path.basename(project.sourceVideoPath)).toMatch(UUID_FILENAME);
    expect(path.basename(project.sourceVideoPath)).not.toContain("long-sample");

    await runQueuedJobs();

    const rows = routeDb.db.select().from(transcripts).where(eq(transcripts.projectId, project.id)).all();
    expect(rows).toHaveLength(1);

    const segments = JSON.parse(rows[0].segments) as TranscriptSegment[];
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0].text).toContain("six months");

    // Rows and flag are separate writes; either alone would pass half of this.
    const stored = projectRow(project.id);
    expect(stored.transcribed).toBe(true);
    expect(stored.status).toBe("ready");
    expect(stored.statusNote).toBeNull();

    // The acceptance criterion, measured against the probed duration rather than
    // a literal 90: word timings monotonic and inside the real video.
    const words = segments.flatMap((segment) => segment.words);
    expect(words.length).toBeGreaterThan(0);
    for (const [i, word] of words.entries()) {
      expect(word.end).toBeGreaterThanOrEqual(word.start);
      if (i > 0) expect(word.start).toBeGreaterThanOrEqual(words[i - 1].start);
    }
    expect(words[0].start).toBeGreaterThanOrEqual(0);
    expect(words[words.length - 1].end).toBeLessThanOrEqual(stored.duration ?? 0);

    const queued = routeDb.db.select().from(jobs).where(eq(jobs.projectId, project.id)).all();
    // The full phase-04 pipeline: ingest → transcribe → generate-clips.
    expect(queued.map((job) => job.type)).toEqual(["ingest", "transcribe", "generate-clips"]);
    expect(queued.every((job) => job.status === "done")).toBe(true);
  }, 60_000);

  it("fails loudly, not silently, when a renamed project has no matching fixture", async () => {
    // The known cost of keying off project.name (DEC-009): rename the project and
    // the fake cannot find a fixture. That must surface as a failed job naming the
    // problem — never as a project quietly marked transcribed with no captions.
    const response = await POST(uploadRequest("long-sample.mp4", { name: "My Podcast" }));
    const { project } = (await response.json()) as { project: { id: number; name: string } };
    expect(project.name).toBe("My Podcast");

    await expect(runQueuedJobs()).rejects.toThrow(/No fake transcript for "My Podcast"/);

    const stored = projectRow(project.id);
    expect(stored.transcribed).toBe(false);
    expect(routeDb.db.select().from(transcripts).where(eq(transcripts.projectId, project.id)).all()).toHaveLength(0);
  }, 60_000);
});
