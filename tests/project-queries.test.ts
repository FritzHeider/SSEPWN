import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clips, exports, projects } from "../src/lib/db/schema";
import { createTestDb, type TestDb } from "./helpers/db";

// listProjects() reads the @/lib/db singleton, which resolves SSECLONE_DB_PATH at
// import time — so the env var is set and the module dynamically imported (the
// same pattern as the delete/export API tests).

type ListProjects = () => Array<{ id: number; clipCount: number; exportCount: number }>;

let listProjects: ListProjects;
let testDb: TestDb;

/** A project with `clipCount` clips, each carrying `exportsPerClip` exports. */
function seed(name: string, clipCount: number, exportsPerClip: number): number {
  const [project] = testDb.db
    .insert(projects)
    .values({ name, status: "ready" })
    .returning({ id: projects.id })
    .all();

  for (let c = 0; c < clipCount; c += 1) {
    const [clip] = testDb.db
      .insert(clips)
      .values({ projectId: project.id, inPoint: 0, outPoint: 4 })
      .returning({ id: clips.id })
      .all();
    for (let e = 0; e < exportsPerClip; e += 1) {
      testDb.db.insert(exports).values({ clipId: clip.id, preset: "tiktok" }).run();
    }
  }

  return project.id;
}

beforeAll(async () => {
  testDb = createTestDb();
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ listProjects } = (await import("../src/lib/projects/queries")) as unknown as {
    listProjects: ListProjects;
  });
});

afterAll(() => {
  testDb.close();
  delete process.env.SSECLONE_DB_PATH;
});

beforeEach(() => {
  testDb.db.delete(exports).run();
  testDb.db.delete(clips).run();
  testDb.db.delete(projects).run();
});

describe("listProjects", () => {
  it("counts clips and exports per project without cross-multiplying them", () => {
    // 3 clips × 2 exports each = the join-and-group-by trap: a naive count would
    // report 6 clips and 6 exports. The subqueries must stay exact.
    const id = seed("busy", 3, 2);

    const rows = listProjects();
    const row = rows.find((r) => r.id === id)!;
    expect(row.clipCount).toBe(3);
    expect(row.exportCount).toBe(6);
  });

  it("reports zero counts for a project with no clips", () => {
    const id = seed("empty", 0, 0);

    const row = listProjects().find((r) => r.id === id)!;
    expect(row.clipCount).toBe(0);
    expect(row.exportCount).toBe(0);
  });

  it("attributes counts to the right project", () => {
    const busy = seed("busy", 2, 1);
    const quiet = seed("quiet", 0, 0);

    const rows = listProjects();
    expect(rows.find((r) => r.id === busy)!.clipCount).toBe(2);
    expect(rows.find((r) => r.id === busy)!.exportCount).toBe(2);
    expect(rows.find((r) => r.id === quiet)!.clipCount).toBe(0);
    expect(rows.find((r) => r.id === quiet)!.exportCount).toBe(0);
  });
});
