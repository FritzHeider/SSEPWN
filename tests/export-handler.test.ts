import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assets, clipEdits, clips, exports, projects } from "../src/lib/db/schema";
import { probe } from "../src/lib/ffmpeg/exec";
import type { Job, JobsDb } from "../src/lib/jobs";
import { compileClipRender } from "../src/lib/render/export";
import { addBroll } from "../src/lib/timeline/broll";
import { buildTimelineDoc } from "../src/lib/timeline/state";
import { createExportHandler, parseExportPayload } from "../src/worker/handlers/export";
import { createTestDb, type TestDb } from "./helpers/db";

const SHORT_SAMPLE = "fixtures/short-sample.mp4"; // 5s, 1280×720
const BROLL_SAMPLE = "fixtures/broll-sample.mp4";

/** Seed a project + clip; returns their ids. `source` overrides the video path. */
function seedClip(db: JobsDb, source: string | null = SHORT_SAMPLE): { projectId: number; clipId: number } {
  const [project] = db
    .insert(projects)
    .values({ name: "p", sourceVideoPath: source, status: "ready", width: 1280, height: 720, duration: 5 })
    .returning({ id: projects.id })
    .all();
  const [clip] = db
    .insert(clips)
    .values({ projectId: project.id, inPoint: 0, outPoint: 4, status: "candidate", title: "c" })
    .returning({ id: clips.id })
    .all();
  return { projectId: project.id, clipId: clip.id };
}

/** Create a queued export row for a clip+preset; returns its id. */
function seedExport(db: JobsDb, clipId: number, preset: string): number {
  const [row] = db.insert(exports).values({ clipId, preset }).returning({ id: exports.id }).all();
  return row.id;
}

/** A minimal JobContext for the export handler: it reads only payload + id. */
function makeCtx(db: JobsDb, projectId: number, payload: unknown, progress: number[]) {
  const job: Job = {
    id: 1,
    projectId,
    type: "export",
    status: "running",
    progress: 0,
    error: null,
    payload,
    attempts: 1,
    maxAttempts: 3,
    runAt: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  return { job, db, setProgress: (p: number) => progress.push(p) };
}

describe("export handler — parseExportPayload", () => {
  it("accepts a valid payload", () => {
    expect(parseExportPayload({ exportId: 3, quality: "draft" })).toEqual({ exportId: 3, quality: "draft" });
  });

  it("defaults quality to final when omitted", () => {
    expect(parseExportPayload({ exportId: 5 })).toEqual({ exportId: 5, quality: "final" });
  });

  it("rejects a non-object, a bad exportId, and an unknown quality", () => {
    expect(() => parseExportPayload(null)).toThrow(/object/);
    expect(() => parseExportPayload({ exportId: 0 })).toThrow(/positive integer/);
    expect(() => parseExportPayload({ exportId: 2, quality: "ultra" })).toThrow(/draft\|final/);
  });
});

describe("export compiler — compileClipRender", () => {
  let testDb: TestDb;
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => {
    testDb.close();
  });

  it("maps in:main to the project source for a clip with no saved edit", () => {
    const { clipId } = seedClip(testDb.db);
    const { plan, inputPaths, captions } = compileClipRender(testDb.db, clipId);
    // Whole-source window: one segment spanning the clip's in/out points.
    expect(plan.inputs).toEqual([{ id: "in:main", role: "main", assetId: null }]);
    expect(inputPaths["in:main"]).toBe(SHORT_SAMPLE);
    expect(captions).toBeNull();
    expect(plan.duration).toBeCloseTo(4, 5);
  });

  it("resolves an asset path for a B-roll input referenced by the timeline", () => {
    const { projectId, clipId } = seedClip(testDb.db);
    const [asset] = testDb.db
      .insert(assets)
      .values({ projectId, type: "broll", kind: "video", path: BROLL_SAMPLE })
      .returning({ id: assets.id })
      .all();
    let doc = buildTimelineDoc(0, 4);
    doc = addBroll(doc, { assetId: asset.id, start: 1, end: 3, mode: "pip", pip: { x: 0.6, y: 0.1, scale: 0.3 } });
    testDb.db.insert(clipEdits).values({ clipId, state: JSON.stringify({ timeline: doc }) }).run();

    const { inputPaths } = compileClipRender(testDb.db, clipId);
    expect(inputPaths[`in:asset-${asset.id}`]).toBe(BROLL_SAMPLE);
    expect(inputPaths["in:main"]).toBe(SHORT_SAMPLE);
  });

  it("throws when the project has no source video", () => {
    const { clipId } = seedClip(testDb.db, null);
    expect(() => compileClipRender(testDb.db, clipId)).toThrow(/no source video/);
  });
});

describe("export handler — ffmpeg integration", () => {
  let testDb: TestDb;
  let dir: string;
  const prevEnv = process.env.SSECLONE_EXPORT_DIR;

  beforeEach(() => {
    testDb = createTestDb();
    dir = mkdtempSync(path.join(tmpdir(), "sseclone-exports-"));
    process.env.SSECLONE_EXPORT_DIR = dir;
  });
  afterEach(() => {
    testDb.close();
    rmSync(dir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.SSECLONE_EXPORT_DIR;
    else process.env.SSECLONE_EXPORT_DIR = prevEnv;
  });

  it("renders a clip to data/exports and marks the row done (draft, tiktok)", async () => {
    const { projectId, clipId } = seedClip(testDb.db);
    const exportId = seedExport(testDb.db, clipId, "tiktok");
    const progress: number[] = [];

    await createExportHandler()(makeCtx(testDb.db, projectId, { exportId, quality: "draft" }, progress));

    const out = path.join(dir, `${clipId}-tiktok.mp4`);
    expect(existsSync(out)).toBe(true);
    const info = await probe(out);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.hasAudio).toBe(true);
    expect(info.duration).toBeGreaterThan(4 - 0.3);
    expect(info.duration).toBeLessThan(4 + 0.3);

    const [row] = testDb.db.select().from(exports).where(eq(exports.id, exportId)).all();
    expect(row.status).toBe("done");
    expect(row.outputPath).toBe(out);
    expect(row.error).toBeNull();
    expect(row.jobId).toBe(1);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(100);
  }, 60_000);

  it("marks the row failed on a missing source, then succeeds after it is restored", async () => {
    const { projectId, clipId } = seedClip(testDb.db, "fixtures/does-not-exist.mp4");
    const exportId = seedExport(testDb.db, clipId, "tiktok");

    await expect(
      createExportHandler()(makeCtx(testDb.db, projectId, { exportId, quality: "draft" }, [])),
    ).rejects.toThrow();

    let [row] = testDb.db.select().from(exports).where(eq(exports.id, exportId)).all();
    expect(row.status).toBe("failed");
    expect(row.error).toBeTruthy();

    // Restore the source (the "retry after restoring file" acceptance path).
    testDb.db.update(projects).set({ sourceVideoPath: SHORT_SAMPLE }).where(eq(projects.id, projectId)).run();
    await createExportHandler()(makeCtx(testDb.db, projectId, { exportId, quality: "draft" }, []));

    [row] = testDb.db.select().from(exports).where(eq(exports.id, exportId)).all();
    expect(row.status).toBe("done");
    expect(row.error).toBeNull();
    expect(existsSync(path.join(dir, `${clipId}-tiktok.mp4`))).toBe(true);
  }, 60_000);
});
