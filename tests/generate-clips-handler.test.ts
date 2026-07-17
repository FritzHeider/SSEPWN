import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clips, projects, transcripts } from "../src/lib/db/schema";
import { audioEnergy, sceneChanges } from "../src/lib/highlights/extractors";
import { createJobQueue, type JobQueue } from "../src/lib/jobs";
import type { TranscriptSegment } from "../src/lib/transcribe/types";
import {
  autoTitle,
  createGenerateClipsHandler,
  parseClipConfig,
  TITLE_MAX,
} from "../src/worker/handlers/generate-clips";
import { createTestDb, type TestDb } from "./helpers/db";

const LONG_SAMPLE = "fixtures/long-sample.mp4";
const LONG_TRANSCRIPT = "tests/samples/transcripts/long-sample.json";

/** The canned transcript the fake transcriber would have written for the fixture. */
function longSegments(): TranscriptSegment[] {
  return JSON.parse(readFileSync(LONG_TRANSCRIPT, "utf8")) as TranscriptSegment[];
}

/** Flat energy → same peak everywhere, so text signals decide ranking (energy is relative). */
function flatEnergy(seconds = 90): number[] {
  return Array.from({ length: seconds }, () => 1);
}

describe("generate-clips handler", () => {
  let testDb: TestDb;
  let queue: JobQueue;

  beforeEach(() => {
    testDb = createTestDb();
    queue = createJobQueue(testDb.db, { backoffMs: () => 0 });
  });

  afterEach(() => {
    testDb.close();
  });

  /** A transcribed, ready project with the fixture transcript already stored. */
  function seedTranscribedProject(
    segments: TranscriptSegment[] = longSegments(),
    values: Partial<typeof projects.$inferInsert> = {},
  ): number {
    const [row] = testDb.db
      .insert(projects)
      .values({
        name: "long-sample.mp4",
        sourceVideoPath: LONG_SAMPLE,
        status: "ready",
        duration: 90,
        hasAudio: true,
        transcribed: true,
        ...values,
      })
      .returning({ id: projects.id })
      .all();
    testDb.db
      .insert(transcripts)
      .values({ projectId: row.id, segments: JSON.stringify(segments) })
      .run();
    return row.id;
  }

  /**
   * Run the handler once against `projectId` with an optional config payload,
   * using injected (deterministic) signals unless told to use the real ones.
   */
  async function run(
    projectId: number,
    payload?: unknown,
    signals?: {
      energy?: (path: string) => Promise<number[]>;
      scenes?: (path: string) => Promise<number[]>;
    },
  ) {
    const handler = createGenerateClipsHandler({
      audioEnergyFn: signals?.energy ?? (async () => flatEnergy()),
      sceneChangesFn: signals?.scenes ?? (async () => []),
    });
    const enqueued = queue.enqueue("generate-clips", projectId, payload);
    const job = queue.claimNext();
    if (!job || job.id !== enqueued.id) throw new Error("failed to claim generate-clips job");
    await handler({ job, db: testDb.db, setProgress: () => {} });
    return testDb.db.select().from(clips).where(eq(clips.projectId, projectId)).all();
  }

  it("writes ranked candidate clips with score, reasons, and an auto title", async () => {
    const id = seedTranscribedProject();
    // Minimum-length window so several ≥15 s clips fit the 90 s fixture (a real
    // source is minutes long; the fixture is not).
    const rows = await run(id, { windowLen: 15, count: 5 });

    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      const len = row.outPoint - row.inPoint;
      expect(len).toBeGreaterThanOrEqual(15);
      expect(len).toBeLessThanOrEqual(90);
      expect(row.status).toBe("candidate");
      expect(row.score).not.toBeNull();
      const reasons = JSON.parse(row.reasons ?? "[]") as string[];
      expect(reasons.length).toBeGreaterThanOrEqual(1);
      expect(row.title?.length).toBeGreaterThan(0);
    }

    // Rows are inserted in rank order (best score first) — assert descending.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].score ?? 0).toBeGreaterThanOrEqual(rows[i].score ?? 0);
    }
  });

  it("yields ≥3 clips end-to-end on the real fixture video (energy + scenes via ffmpeg)", async () => {
    // The phase-04 acceptance criterion: fake transcript + fixture video through
    // the real extractors. This is the only test that touches ffmpeg here.
    const id = seedTranscribedProject();
    const rows = await run(
      id,
      { windowLen: 15, count: 5 },
      { energy: audioEnergy, scenes: sceneChanges },
    );

    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      const len = row.outPoint - row.inPoint;
      expect(len).toBeGreaterThanOrEqual(15);
      expect(len).toBeLessThanOrEqual(90);
      const reasons = JSON.parse(row.reasons ?? "[]") as string[];
      expect(reasons.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("is deterministic: same inputs produce identical clips", async () => {
    const a = await run(seedTranscribedProject(), { windowLen: 20 });
    const b = await run(seedTranscribedProject(), { windowLen: 20 });
    const shape = (rows: typeof a) =>
      rows.map((r) => [r.inPoint, r.outPoint, r.score, r.title, r.reasons]);
    expect(shape(a)).toEqual(shape(b));
  });

  it("regenerates: a custom hook-phrase list changes which clip ranks first", async () => {
    // Proves config is live (the regenerate acceptance criterion at handler level).
    // Default hooks favour the "Here's the secret …" openings; swapping to a hook
    // that only matches the retention passage (~47 s) must reorder the ranking.
    const id = seedTranscribedProject();

    const withDefaults = await run(id, { windowLen: 20 });
    const topDefault = withDefaults[0];

    const withRetention = await run(id, { windowLen: 20, hookPhrases: ["retention"] });
    const topRetention = withRetention[0];

    expect(topRetention.inPoint).not.toBe(topDefault.inPoint);
    // The retention sentence ("…the second thing is retention…") spans ~45–49.8 s;
    // the newly-promoted top clip must contain it.
    expect(topRetention.inPoint).toBeLessThanOrEqual(47.294);
    expect(topRetention.outPoint).toBeGreaterThanOrEqual(48.07);
  });

  it("uses the project's stored clip_config as the base for a run", async () => {
    // A saved hook list must apply to a plain (payload-less) run, exactly as the
    // one-off payload did in the test above — this is what "stored per project"
    // buys. windowLen 20 mirrors the payload variant so the two are comparable.
    const withDefaults = await run(
      seedTranscribedProject(longSegments(), { clipConfig: JSON.stringify({ windowLen: 20 }) }),
      undefined,
    );
    const withStoredRetention = await run(
      seedTranscribedProject(longSegments(), {
        clipConfig: JSON.stringify({ windowLen: 20, hookPhrases: ["retention"] }),
      }),
      undefined,
    );

    expect(withStoredRetention[0].inPoint).not.toBe(withDefaults[0].inPoint);
    expect(withStoredRetention[0].inPoint).toBeLessThanOrEqual(47.294);
    expect(withStoredRetention[0].outPoint).toBeGreaterThanOrEqual(48.07);
  });

  it("lets a job payload override the project's stored config for a single run", async () => {
    // Stored config says windowLen 20; the payload overrides it to 30. The
    // override wins per-run without mutating what the project saved.
    const id = seedTranscribedProject(longSegments(), {
      clipConfig: JSON.stringify({ windowLen: 20, count: 5 }),
    });
    const rows = await run(id, { windowLen: 30 });
    // At windowLen 30 the 90 s fixture fits ~2 clips (3*30+2*5 > 90); at 20 it
    // fits more. Seeing ≤2 proves the payload's 30 won over the stored 20.
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("replaces candidate clips on regenerate but leaves manual clips untouched", async () => {
    const id = seedTranscribedProject();
    testDb.db
      .insert(clips)
      .values({ projectId: id, inPoint: 5, outPoint: 12, status: "manual", title: "mine" })
      .run();

    await run(id, { windowLen: 20 });
    await run(id, { windowLen: 20 });

    const manual = testDb.db.select().from(clips).where(eq(clips.status, "manual")).all();
    expect(manual).toHaveLength(1);
    expect(manual[0].title).toBe("mine");
  });

  it("skips cleanly when the project has no transcript", async () => {
    const [row] = testDb.db
      .insert(projects)
      .values({ name: "silent.mp4", sourceVideoPath: LONG_SAMPLE, status: "ready", hasAudio: false })
      .returning({ id: projects.id })
      .all();
    const rows = await run(row.id, { windowLen: 20 });
    expect(rows).toHaveLength(0);
  });

  it("parseClipConfig keeps only well-typed fields from an untrusted payload", () => {
    expect(parseClipConfig(null)).toEqual({});
    expect(parseClipConfig({ minLen: "20", count: 7, hookPhrases: ["a", "", 3] })).toEqual({
      count: 7,
      hookPhrases: ["a"],
    });
    expect(parseClipConfig({ weights: { hook: 5, bogus: 1, energy: "x" } })).toEqual({
      weights: { hook: 5 },
    });
  });

  it("autoTitle names the first hook sentence, trimmed to 60 chars", () => {
    const segments = longSegments();
    const clip = { start: 12, end: 32, score: 0, signals: {}, reasons: ["hook phrase"] } as never;
    const title = autoTitle(clip, segments, ["the secret"]);
    expect(title.startsWith("Here's the secret")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
  });
});
