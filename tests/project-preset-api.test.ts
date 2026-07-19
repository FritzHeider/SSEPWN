import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { projects } from "../src/lib/db/schema";
import { PLATFORM_PRESETS } from "../src/lib/presets";
import { createTestDb, type TestDb } from "./helpers/db";

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let GET: Handler;
let PUT: Handler;
let testDb: TestDb;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function get(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/projects/${id}/preset`), ctx(id));
}

function put(id: string, body: unknown, raw = false): Promise<Response> {
  return PUT(
    new Request(`http://localhost/api/projects/${id}/preset`, {
      method: "PUT",
      body: raw ? (body as string) : JSON.stringify(body),
    }),
    ctx(id),
  );
}

function seed(): number {
  const [row] = testDb.db
    .insert(projects)
    .values({ name: "preset project" })
    .returning({ id: projects.id })
    .all();
  return row.id;
}

interface PresetBody {
  projectId: number;
  platformPreset: string | null;
  effective: { id: string };
}

beforeAll(async () => {
  testDb = createTestDb();
  process.env.SSECLONE_DB_PATH = testDb.file;
  ({ GET, PUT } = (await import("../src/app/api/projects/[id]/preset/route")) as unknown as {
    GET: Handler;
    PUT: Handler;
  });
});

afterEach(() => {
  testDb.db.delete(projects).run();
});

afterAll(() => {
  testDb.close();
});

describe("GET /api/projects/:id/preset", () => {
  it("returns null + the product default for a project that never set one", async () => {
    const id = seed();
    const res = await get(String(id));
    const body = (await res.json()) as PresetBody;
    expect(res.status).toBe(200);
    expect(body.platformPreset).toBeNull();
    expect(body.effective.id).toBe(PLATFORM_PRESETS.tiktok.id);
  });

  it("returns 404 for a missing project", async () => {
    const res = await get("9999");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });

  it.each(["abc", "0", "-1", ""])("returns 400 invalid_id for %j", async (raw) => {
    const res = await get(raw);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_id");
  });
});

describe("PUT /api/projects/:id/preset", () => {
  it("persists a known preset and round-trips through GET", async () => {
    const id = seed();
    const put1 = (await (await put(String(id), { platformPreset: "youtube-shorts" })).json()) as PresetBody;
    expect(put1.platformPreset).toBe("youtube-shorts");
    expect(put1.effective.id).toBe("youtube-shorts");

    // Landed in the column.
    const stored = testDb.db
      .select({ platformPreset: projects.platformPreset })
      .from(projects)
      .where(eq(projects.id, id))
      .get();
    expect(stored?.platformPreset).toBe("youtube-shorts");

    const got = (await (await get(String(id))).json()) as PresetBody;
    expect(got.platformPreset).toBe("youtube-shorts");
  });

  it("clears the default to null when given null, reverting to the product default", async () => {
    const id = seed();
    await put(String(id), { platformPreset: "square" });
    const body = (await (await put(String(id), { platformPreset: null })).json()) as PresetBody;
    expect(body.platformPreset).toBeNull();
    expect(body.effective.id).toBe(PLATFORM_PRESETS.tiktok.id);
    const stored = testDb.db
      .select({ platformPreset: projects.platformPreset })
      .from(projects)
      .where(eq(projects.id, id))
      .get();
    expect(stored?.platformPreset).toBeNull();
  });

  it("rejects an unknown preset id without touching the column", async () => {
    const id = seed();
    await put(String(id), { platformPreset: "square" });
    const res = await put(String(id), { platformPreset: "myspace" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_preset");
    // Prior value survives the rejected write.
    const stored = testDb.db
      .select({ platformPreset: projects.platformPreset })
      .from(projects)
      .where(eq(projects.id, id))
      .get();
    expect(stored?.platformPreset).toBe("square");
  });

  it("returns 400 for a non-JSON body", async () => {
    const id = seed();
    const res = await put(String(id), "not json{", true);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });

  it("returns 404 when updating a missing project", async () => {
    const res = await put("8888", { platformPreset: "square" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });
});
