import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clips, jobs, projects } from "../src/lib/db/schema";
import { createTestDb, type TestDb } from "./helpers/db";

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let pipelineGET: Handler;
let testDb: TestDb;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function get(id: string) {
  return pipelineGET(new Request(`http://localhost/api/projects/${id}/pipeline`), ctx(id));
}

function seedProject(values: Partial<typeof projects.$inferInsert> = {}): number {
  const [row] = testDb.db
    .insert(projects)
    .values({ name: "p", status: "uploaded", ...values })
    .returning({ id: projects.id })
    .all();
  return row.id;
}

beforeAll(async () => {
  testDb = createTestDb();
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ GET: pipelineGET } = (await import("../src/app/api/projects/[id]/pipeline/route")) as unknown as {
    GET: Handler;
  });
});

afterAll(() => {
  testDb.close();
  delete process.env.SSECLONE_DB_PATH;
});

beforeEach(() => {
  testDb.db.delete(jobs).run();
  testDb.db.delete(clips).run();
  testDb.db.delete(projects).run();
});

describe("GET /api/projects/:id/pipeline", () => {
  it("400s a malformed id and 404s a missing project", async () => {
    expect((await get("abc")).status).toBe(400);
    expect((await get("9999")).status).toBe(404);
  });

  it("derives the three steps from the jobs and project rows", async () => {
    const id = seedProject({ status: "ready", hasAudio: true, transcribed: true });
    testDb.db.insert(jobs).values({ projectId: id, type: "ingest", status: "done" }).run();
    testDb.db.insert(jobs).values({ projectId: id, type: "transcribe", status: "done" }).run();
    testDb.db.insert(jobs).values({ projectId: id, type: "generate-clips", status: "running" }).run();

    const res = await get(String(id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projectId: number; steps: { key: string; status: string }[] };
    expect(body.projectId).toBe(id);
    expect(body.steps.map((s) => [s.key, s.status])).toEqual([
      ["ingest", "done"],
      ["transcribe", "done"],
      ["generate-clips", "running"],
    ]);
  });

  it("marks transcribe skipped for a no-audio project", async () => {
    const id = seedProject({ status: "ready", hasAudio: false });
    testDb.db.insert(jobs).values({ projectId: id, type: "ingest", status: "done" }).run();

    const body = (await (await get(String(id))).json()) as { steps: { key: string; status: string }[] };
    expect(body.steps.find((s) => s.key === "transcribe")?.status).toBe("skipped");
  });
});
