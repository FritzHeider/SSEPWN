import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clips, projects, transcripts } from "../src/lib/db/schema";
import { probe } from "../src/lib/ffmpeg/exec";
import { createJobQueue, type Job, type JobQueue } from "../src/lib/jobs";
import type { Transcriber, TranscriptSegment } from "../src/lib/transcribe/types";
import { handlers } from "../src/worker/handlers";
import { createIngestHandler } from "../src/worker/handlers/ingest";
import { createTranscribeHandler, NO_AUDIO_NOTE } from "../src/worker/handlers/transcribe";
import { createWorker } from "../src/worker/loop";
import { createTestDb, type TestDb } from "./helpers/db";

const LONG_SAMPLE = "fixtures/long-sample.mp4";
const SHORT_SAMPLE = "fixtures/short-sample.mp4";
const NO_AUDIO = "fixtures/no-audio.mp4";
const NOT_A_VIDEO = "fixtures/not-a-video.txt";

const POLL_MS = 5;
const silentLogger = { log: () => {}, error: () => {} };

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

describe("transcribe handler", () => {
  let testDb: TestDb;
  let queue: JobQueue;

  beforeEach(() => {
    testDb = createTestDb();
    queue = createJobQueue(testDb.db, { backoffMs: () => 0 });
  });

  afterEach(() => {
    testDb.close();
  });

  /** A project exactly as a successful ingest leaves it: `ready`, metadata written. */
  function seedReadyProject(
    overrides: Partial<{ sourceVideoPath: string | null; hasAudio: boolean | null; name: string }> = {},
  ): number {
    const [row] = testDb.db
      .insert(projects)
      .values({
        name: overrides.name ?? "clip.mp4",
        sourceVideoPath: "sourceVideoPath" in overrides ? overrides.sourceVideoPath : LONG_SAMPLE,
        status: "ready",
        duration: 90,
        width: 1280,
        height: 720,
        fps: 30,
        hasAudio: "hasAudio" in overrides ? overrides.hasAudio : true,
      })
      .returning({ id: projects.id })
      .all();
    return row.id;
  }

  function getProject(id: number) {
    const [row] = testDb.db.select().from(projects).where(eq(projects.id, id)).all();
    return row;
  }

  function transcriptRows(projectId: number) {
    return testDb.db.select().from(transcripts).where(eq(transcripts.projectId, projectId)).all();
  }

  /** Run the handler directly against a real queued job, as the worker would. */
  async function run(handler: ReturnType<typeof createTranscribeHandler>, projectId: number) {
    const job: Job = queue.enqueue("transcribe", projectId);
    await handler({ job, db: testDb.db, setProgress: (p) => queue.updateProgress(job.id, p) });
  }

  it("writes transcript rows AND flips the transcribed flag", async () => {
    // H3: two separate writes. Asserting only one of them passes a handler that
    // stores a transcript nothing downstream knows exists, or flips a flag that
    // promises a transcript that was never written.
    const id = seedReadyProject();
    await run(createTranscribeHandler(), id);

    const rows = transcriptRows(id);
    expect(rows).toHaveLength(1);
    expect(getProject(id).transcribed).toBe(true);
  });

  it("uses the TRANSCRIBER factory rather than a hardcoded implementation", async () => {
    // H4: the injected-transcriber tests below are blind to the default being
    // dropped. This exercises the no-option path, which must reach the factory —
    // fake under the ambient NODE_ENV=test — and come back with fixture content.
    expect(process.env.NODE_ENV).toBe("test"); // load-bearing: the default depends on it
    const id = seedReadyProject();
    await run(createTranscribeHandler(), id);

    const segments = JSON.parse(transcriptRows(id)[0].segments) as TranscriptSegment[];
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.some((s) => /here's the secret/i.test(s.text))).toBe(true);
  });

  it("stores segments as JSON that round-trips with word timings intact", async () => {
    // H6: a column holding "[object Object]" satisfies "a row exists".
    let produced: TranscriptSegment[] = [];
    const spy: Transcriber = {
      async transcribe(audioPath) {
        produced = [
          { text: "Hi.", start: 0, end: 1, words: [{ word: "Hi.", start: 0, end: 1 }] },
        ];
        expect(audioPath).toBe(LONG_SAMPLE);
        return produced;
      },
    };
    const id = seedReadyProject();
    await run(createTranscribeHandler({ createTranscriberFn: () => spy }), id);

    expect(JSON.parse(transcriptRows(id)[0].segments)).toEqual(produced);
  });

  it("keeps each project's transcript to its own project", async () => {
    // H5: with one project, a handler that ignores job.projectId passes. The two
    // fixtures must differ in CONTENT, not just in id.
    const longId = seedReadyProject({ sourceVideoPath: LONG_SAMPLE, name: "long.mp4" });
    const shortId = seedReadyProject({ sourceVideoPath: SHORT_SAMPLE, name: "short.mp4" });

    const handler = createTranscribeHandler();
    await run(handler, longId);
    await run(handler, shortId);

    const longText = JSON.parse(transcriptRows(longId)[0].segments) as TranscriptSegment[];
    const shortText = JSON.parse(transcriptRows(shortId)[0].segments) as TranscriptSegment[];
    expect(shortText[0].text).toMatch(/short test clip/i);
    expect(longText[0].text).not.toBe(shortText[0].text);
    expect(longText.length).toBeGreaterThan(shortText.length);
  });

  it("replaces the transcript on a retry instead of stacking a second one", async () => {
    // H9: the queue retries a failed attempt, so the handler runs twice for real.
    const id = seedReadyProject();
    const handler = createTranscribeHandler();
    await run(handler, id);
    await run(handler, id);

    expect(transcriptRows(id)).toHaveLength(1);
  });

  it("leaves the project's own status alone", async () => {
    // H10: transcription is additive; it must not seize the status column.
    const id = seedReadyProject();
    await run(createTranscribeHandler(), id);

    expect(getProject(id).status).toBe("ready");
    expect(getProject(id).error).toBeNull();
  });

  describe("a project with no audio", () => {
    it("skips cleanly with a status note instead of failing", async () => {
      // H1: the phase criterion names all four of these; a handler that resolves
      // without writing the note passes a job-status-only assertion.
      const id = seedReadyProject({ sourceVideoPath: NO_AUDIO, hasAudio: false });
      await run(createTranscribeHandler(), id);

      const project = getProject(id);
      expect(project.status).toBe("ready");
      expect(project.error).toBeNull();
      expect(project.statusNote).toBe(NO_AUDIO_NOTE);
      expect(project.transcribed).toBe(false);
      expect(transcriptRows(id)).toHaveLength(0);
    });

    it("never invokes the transcriber", async () => {
      let called = false;
      const spy: Transcriber = {
        async transcribe() {
          called = true;
          return [];
        },
      };
      const id = seedReadyProject({ sourceVideoPath: NO_AUDIO, hasAudio: false });
      await run(createTranscribeHandler({ createTranscriberFn: () => spy }), id);

      expect(called).toBe(false);
    });
  });

  it("rejects when audio is unknown rather than assuming there is none", async () => {
    // H7: null is "not probed yet". Treating it as false would silently drop
    // captions from a video that has perfectly good audio, and leave a note
    // asserting something nothing measured.
    const id = seedReadyProject({ hasAudio: null });
    const handler = createTranscribeHandler();

    await expect(run(handler, id)).rejects.toThrow(/no probe metadata/i);
    const project = getProject(id);
    expect(project.statusNote).toBeNull();
    expect(project.transcribed).toBe(false);
  });

  it("rejects when the project has no source video", async () => {
    const id = seedReadyProject({ sourceVideoPath: null });
    await expect(run(createTranscribeHandler(), id)).rejects.toThrow(/no source video/i);
  });

  it("rethrows a transcriber failure so the queue can retry it", async () => {
    const failing: Transcriber = {
      async transcribe() {
        throw new Error("whisper.cpp binary not found at $WHISPER_BIN");
      },
    };
    const id = seedReadyProject();
    await expect(
      run(createTranscribeHandler({ createTranscriberFn: () => failing }), id),
    ).rejects.toThrow(/WHISPER_BIN/);
    expect(getProject(id).transcribed).toBe(false);
  });
});

describe("ingest → transcribe pipeline", () => {
  let testDb: TestDb;
  let queue: JobQueue;
  let thumbDir: string;

  beforeEach(() => {
    testDb = createTestDb();
    queue = createJobQueue(testDb.db, { backoffMs: () => 0 });
    thumbDir = mkdtempSync(path.join(tmpdir(), "sseclone-transcribe-"));
  });

  afterEach(() => {
    testDb.close();
    rmSync(thumbDir, { recursive: true, force: true });
  });

  function seedUploadedProject(sourceVideoPath: string, name: string): number {
    const [row] = testDb.db
      .insert(projects)
      .values({ name, sourceVideoPath, status: "uploaded" })
      .returning({ id: projects.id })
      .all();
    return row.id;
  }

  /** The real registry, with ingest's poster frame redirected into a temp dir. */
  function startWorker() {
    const worker = createWorker({
      queue,
      db: testDb.db,
      handlers: { ...handlers, ingest: createIngestHandler({ dir: () => thumbDir }) },
      pollMs: POLL_MS,
      logger: silentLogger,
    });
    void worker.start();
    return worker;
  }

  function jobsOfType(projectId: number, type: string) {
    return queue.listByProject(projectId).filter((job) => job.type === type);
  }

  it("ingests long-sample.mp4 then transcribes it with word timings inside the video", async () => {
    // The phase-03 acceptance criterion, end to end through the real worker:
    // upload-shaped row in, transcript rows out, TRANSCRIBER unset (=> fake).
    const id = seedUploadedProject(LONG_SAMPLE, "long-sample.mp4");
    const worker = startWorker();
    queue.enqueue("ingest", id);

    await waitFor(() => {
      const [project] = testDb.db.select().from(projects).where(eq(projects.id, id)).all();
      return project.transcribed === true;
    }, "project to be transcribed");
    await worker.stop();

    const [transcribeJob] = jobsOfType(id, "transcribe");
    expect(transcribeJob?.status).toBe("done");

    const rows = testDb.db.select().from(transcripts).where(eq(transcripts.projectId, id)).all();
    expect(rows).toHaveLength(1);
    const segments = JSON.parse(rows[0].segments) as TranscriptSegment[];
    expect(segments.length).toBeGreaterThanOrEqual(15);

    // Bound the timings by the REAL probed duration, not a hardcoded 90: a
    // literal would keep passing if the fixture generator ever changed length.
    const { duration } = await probe(LONG_SAMPLE);
    const words = segments.flatMap((segment) => segment.words);
    expect(words.length).toBeGreaterThan(0);

    let previousEnd = 0;
    for (const word of words) {
      expect(word.start).toBeGreaterThanOrEqual(previousEnd);
      expect(word.end).toBeGreaterThanOrEqual(word.start);
      expect(word.start).toBeGreaterThanOrEqual(0);
      expect(word.end).toBeLessThanOrEqual(duration);
      previousEnd = word.start;
    }
  });

  it("carries a no-audio project through the pipeline without failing it", async () => {
    // H1 again, but through the real worker: the phase says the PIPELINE must not
    // fail, which only the dispatch path can prove.
    const id = seedUploadedProject(NO_AUDIO, "no-audio.mp4");
    const worker = startWorker();
    queue.enqueue("ingest", id);

    // The no-audio branch now hands off to generate-clips (edge-state clipping),
    // so the chain runs one job further than transcribe.
    await waitFor(
      () => jobsOfType(id, "generate-clips")[0]?.status === "done",
      "clip generation to finish",
    );
    await worker.stop();

    const [project] = testDb.db.select().from(projects).where(eq(projects.id, id)).all();
    expect(project.status).toBe("ready");
    expect(project.statusNote).toBe(NO_AUDIO_NOTE);
    expect(project.transcribed).toBe(false);
    expect(queue.listByProject(id).every((job) => job.status === "done")).toBe(true);

    // Phase-11 edge state: a no-audio project still gets at least one clip. The
    // 5 s fixture is shorter than one clip, so it becomes a single whole-video clip.
    const clipRows = testDb.db.select().from(clips).where(eq(clips.projectId, id)).all();
    expect(clipRows.length).toBeGreaterThanOrEqual(1);
  });

  it("does not enqueue transcribe when ingest fails", async () => {
    // H2: enqueueing outside the try (or before the metadata write) queues work
    // against a project that has no metadata, which then fails for an unrelated
    // reason and buries the real error under a second one.
    const id = seedUploadedProject(NOT_A_VIDEO, "not-a-video.txt");
    const worker = startWorker();
    queue.enqueue("ingest", id);

    await waitFor(() => jobsOfType(id, "ingest")[0]?.status === "failed", "ingest to fail");
    await worker.stop();

    expect(jobsOfType(id, "transcribe")).toHaveLength(0);
  });
});
