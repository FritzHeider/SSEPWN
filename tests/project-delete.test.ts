import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  assets,
  clipEdits,
  clips,
  exports,
  jobs,
  projects,
  templates,
  transcripts,
} from "../src/lib/db/schema";
import { createTestDb, type TestDb } from "./helpers/db";

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let projectDELETE: Handler;
let testDb: TestDb;
let fileDir: string;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function del(id: string): Promise<Response> {
  return projectDELETE(new Request(`http://localhost/api/projects/${id}`, { method: "DELETE" }), ctx(id));
}

/** A real file on disk under the test's throwaway dir, so unlink is observable. */
function makeFile(name: string): string {
  const p = path.join(fileDir, name);
  writeFileSync(p, "x");
  return p;
}

/**
 * Seed a project with at least one row in every table that references it, plus
 * a real file for each path column. Returns the ids and the file paths so a
 * test can assert both rows and bytes are gone (or survive).
 */
function seedProject(label: string): {
  projectId: number;
  clipId: number;
  assetId: number;
  files: string[];
} {
  const sourceVideoPath = makeFile(`${label}-source.mp4`);
  const projectThumb = makeFile(`${label}-thumb.jpg`);
  const [project] = testDb.db
    .insert(projects)
    .values({ name: `${label} project`, sourceVideoPath, thumbnailPath: projectThumb, status: "ready" })
    .returning({ id: projects.id })
    .all();

  const assetPath = makeFile(`${label}-asset.mp4`);
  const assetThumb = makeFile(`${label}-asset-thumb.jpg`);
  const [asset] = testDb.db
    .insert(assets)
    .values({ projectId: project.id, type: "broll", path: assetPath, thumbnailPath: assetThumb })
    .returning({ id: assets.id })
    .all();

  testDb.db.insert(transcripts).values({ projectId: project.id, segments: "[]" }).run();
  testDb.db.insert(jobs).values({ projectId: project.id, type: "ingest" }).run();

  const [clip] = testDb.db
    .insert(clips)
    .values({ projectId: project.id, inPoint: 0, outPoint: 4, status: "candidate" })
    .returning({ id: clips.id })
    .all();
  testDb.db.insert(clipEdits).values({ clipId: clip.id, state: "{}" }).run();

  const exportOutput = makeFile(`${label}-export.mp4`);
  testDb.db
    .insert(exports)
    .values({ clipId: clip.id, preset: "tiktok", status: "done", outputPath: exportOutput })
    .run();

  return {
    projectId: project.id,
    clipId: clip.id,
    assetId: asset.id,
    files: [sourceVideoPath, projectThumb, assetPath, assetThumb, exportOutput],
  };
}

beforeAll(async () => {
  testDb = createTestDb();
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ DELETE: projectDELETE } = (await import("../src/app/api/projects/[id]/route")) as unknown as {
    DELETE: Handler;
  });
});

afterAll(() => {
  testDb.close();
  delete process.env.SSECLONE_DB_PATH;
});

beforeEach(() => {
  fileDir = mkdtempSync(path.join(tmpdir(), "sseclone-delete-"));
  testDb.db.delete(exports).run();
  testDb.db.delete(clipEdits).run();
  testDb.db.delete(clips).run();
  testDb.db.delete(transcripts).run();
  testDb.db.delete(jobs).run();
  testDb.db.delete(templates).run();
  testDb.db.delete(assets).run();
  testDb.db.delete(projects).run();
});

afterEach(() => {
  rmSync(fileDir, { recursive: true, force: true });
});

describe("DELETE /api/projects/:id", () => {
  it("removes every related row and unlinks every file the project owned", async () => {
    const target = seedProject("target");

    const res = await del(String(target.projectId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean; id: number; rows: Record<string, number> };
    expect(body.deleted).toBe(true);
    expect(body.rows).toEqual({
      exports: 1,
      clipEdits: 1,
      clips: 1,
      transcripts: 1,
      jobs: 1,
      assets: 1,
      project: 1,
    });

    // No orphan rows in any table that referenced the project.
    expect(testDb.db.select().from(projects).all()).toHaveLength(0);
    expect(testDb.db.select().from(assets).all()).toHaveLength(0);
    expect(testDb.db.select().from(jobs).all()).toHaveLength(0);
    expect(testDb.db.select().from(transcripts).all()).toHaveLength(0);
    expect(testDb.db.select().from(clips).all()).toHaveLength(0);
    expect(testDb.db.select().from(clipEdits).all()).toHaveLength(0);
    expect(testDb.db.select().from(exports).all()).toHaveLength(0);

    // No orphan files under the project's storage.
    for (const file of target.files) {
      expect(existsSync(file)).toBe(false);
    }
  });

  it("leaves other projects' rows and files untouched", async () => {
    const target = seedProject("target");
    const keep = seedProject("keep");

    await del(String(target.projectId));

    // The surviving project keeps every row...
    expect(testDb.db.select().from(projects).all()).toHaveLength(1);
    expect(testDb.db.select().from(clips).where(eq(clips.projectId, keep.projectId)).all()).toHaveLength(1);
    expect(testDb.db.select().from(assets).where(eq(assets.projectId, keep.projectId)).all()).toHaveLength(1);
    expect(testDb.db.select().from(jobs).where(eq(jobs.projectId, keep.projectId)).all()).toHaveLength(1);
    // ...and every file.
    for (const file of keep.files) {
      expect(existsSync(file)).toBe(true);
    }
  });

  it("nulls a template watermark that points at a deleted asset instead of tripping the FK", async () => {
    const target = seedProject("target");
    const [tpl] = testDb.db
      .insert(templates)
      .values({
        name: "with watermark",
        captionPreset: "bold-pop",
        captionStyle: "{}",
        aspectRatio: "9:16",
        brandPrimary: "#ffffff",
        brandSecondary: "#000000",
        watermarkAssetId: target.assetId,
      })
      .returning({ id: templates.id })
      .all();

    const res = await del(String(target.projectId));
    expect(res.status).toBe(200);

    // The template survives (it is global) but no longer references the gone asset.
    const row = testDb.db.select().from(templates).where(eq(templates.id, tpl.id)).get();
    expect(row).toBeDefined();
    expect(row?.watermarkAssetId).toBeNull();
  });

  it("404s a project that does not exist", async () => {
    const res = await del("99999");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("400s a malformed id", async () => {
    const res = await del("abc");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_id");
  });
});
