import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clips, projects } from "../src/lib/db/schema";
import { createTestDb, type TestDb } from "./helpers/db";

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let clipPATCH: Handler;
let testDb: TestDb;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function patch(id: string, body?: unknown, raw = false): Promise<Response> {
  return clipPATCH(
    new Request(`http://localhost/api/clips/${id}`, {
      method: "PATCH",
      body: body === undefined ? undefined : raw ? (body as string) : JSON.stringify(body),
    }),
    ctx(id),
  );
}

function seedClip(): number {
  const [project] = testDb.db.insert(projects).values({ name: "p" }).returning({ id: projects.id }).all();
  const [clip] = testDb.db
    .insert(clips)
    .values({ projectId: project.id, inPoint: 0, outPoint: 4, status: "candidate", title: "old" })
    .returning({ id: clips.id })
    .all();
  return clip.id;
}

beforeAll(async () => {
  testDb = createTestDb();
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ PATCH: clipPATCH } = (await import("../src/app/api/clips/[id]/route")) as unknown as { PATCH: Handler });
});

afterAll(() => {
  testDb.close();
  delete process.env.SSECLONE_DB_PATH;
});

beforeEach(() => {
  testDb.db.delete(clips).run();
  testDb.db.delete(projects).run();
});

describe("PATCH /api/clips/:id", () => {
  it("renames a clip and returns the updated row", async () => {
    const id = seedClip();
    const res = await patch(String(id), { title: "  New Title  " });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clip: { id: number; title: string } };
    expect(body.clip.id).toBe(id);
    // Trimmed before persisting.
    expect(body.clip.title).toBe("New Title");
  });

  it("rejects an empty or whitespace-only title", async () => {
    const id = seedClip();
    expect((await patch(String(id), { title: "" })).status).toBe(400);
    expect((await patch(String(id), { title: "   " })).status).toBe(400);
  });

  it("rejects a title longer than 120 characters", async () => {
    const id = seedClip();
    expect((await patch(String(id), { title: "x".repeat(121) })).status).toBe(400);
    expect((await patch(String(id), { title: "x".repeat(120) })).status).toBe(200);
  });

  it("400s a malformed id and 404s a missing clip", async () => {
    expect((await patch("abc", { title: "t" })).status).toBe(400);
    const missing = await patch("9999", { title: "t" });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe("not_found");
  });

  it("400s a non-JSON body", async () => {
    const id = seedClip();
    expect((await patch(String(id), "{not json", true)).status).toBe(400);
  });
});
